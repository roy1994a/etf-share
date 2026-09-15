/**
 * 半导体设备ETF(159516) 智能交易模拟系统 —— 后端服务
 * 零依赖（仅使用 Node 内置模块）
 * 功能：
 *   1) 行情代理：实时行情 / 日K·周K / 分时（腾讯行情，UTF-8 JSON）
 *   2) 模拟账户：持仓、现金、成本、交易记录持久化
 *   3) 每日复盘：复盘记录持久化
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { fetchUs10y, fetchCn10y, fetchSox, fetchFundFlow, fetchMarketBreadth, fetchHhxgSnapshot, fetchIndexKline, calibrateKlines, fetchGlobalHistory } = require('./lib/market.js'); // 宏观/科技/资金/情绪数据
const Indicators = require('./public/static/indicators.js');
const RL = require('./lib/rl.js');
const LivePredict = require('./lib/live-predict.js');
const Engine = require('./public/static/engine.js');

const PORT = process.env.PORT || 8899;
const HOST = process.env.HOST || '0.0.0.0'; // 公共部署监听所有网卡；本地可用 HOST=127.0.0.1
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'account.json');
const MONITOR_PID_FILE = path.join(DATA_DIR, 'monitor.pid');

const CODE = '159516';
const SZ_CODE = 'sz' + CODE; // 深圳市场
const NAME = '半导体设备ETF国泰';
const READ_ONLY = process.env.READ_ONLY === 'true'; // 公共只读模式：禁交易/重置/盯盘

// ---------- 模拟账户 ----------
function defaultState() {
  return {
    name: NAME,
    code: CODE,
    totalCapital: 500000, // 总资金（可调整）
    cash: 500000,         // 可用现金
    shares: 0,            // 持仓份额（159516，兼容旧界面）
    avgCost: 0,           // 持仓成本价（159516）
    realizedPnl: 0,       // 已实现盈亏（元）
    positions: {},        // 多 ETF 持仓：{ code: { code, name, shares, avgCost } }
    trades: [],           // 交易记录
    reviews: [],          // 每日复盘记录
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return Object.assign(defaultState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (e) { console.error('[state] load error:', e.message); }
  return defaultState();
}
function saveState(s) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    s.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('[state] save error:', e.message); }
}

// ---------- 网络请求（含 gzip 解压与 UA） ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
function httpGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https') ? https : http;
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (urlStr.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ 'User-Agent': UA, 'Referer': 'https://gu.qq.com/', 'Accept-Encoding': 'gzip, deflate' }, opts.headers || {}),
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
        } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

// ---------- 行情：腾讯 K 线（含实时 qt） ----------
function marketCode(code) {
  code = String(code || CODE);
  const c0 = code[0];
  return (c0 === '6' || c0 === '5' || c0 === '9' ? 'sh' : 'sz') + code;
}
async function fetchTencentKline(period, limit, code) {
  const tc = marketCode(code);
  const p = { day: 'day', week: 'week', month: 'month' }[period] || 'day';
  const u = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},${p},,,${limit},qfq`;
  const { text } = await httpGet(u);
  const json = JSON.parse(text);
  const node = json && json.data && json.data[tc];
  if (!node) throw new Error('腾讯K线返回结构异常: ' + tc);
  const key = 'qfq' + p;
  const arr = node[key] || node[p] || [];
  // 每根 K： [date, open, close, high, low, volume]
  const klines = arr.map((r) => ({
    date: r[0],
    open: parseFloat(r[1]),
    close: parseFloat(r[2]),
    high: parseFloat(r[3]),
    low: parseFloat(r[4]),
    volume: parseFloat(r[5]) || 0,
  }));
  // 实时行情（qt 为 {sz159516: [...]} 嵌套结构）
  let quote = null;
  if (node.qt && Array.isArray(node.qt[tc])) quote = parseTencentQuote(node.qt[tc]);
  return { klines, quote };
}

// 解析腾讯 qt 数组 → 干净对象
function parseTencentQuote(q) {
  const num = (i) => { const v = q[i]; if (v == null || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
  return {
    name: q[1] || NAME,
    code: q[2] || CODE,
    price: num(3),        // 最新价
    prevClose: num(4),    // 昨收
    open: num(5),         // 今开
    volume: num(6),       // 成交量（手）
    time: q[30] || '',    // 时间 yyyyMMddHHmmss
    change: num(31),      // 涨跌额
    pctChange: num(32),   // 涨跌幅 %
    high: num(33),        // 最高
    low: num(34),         // 最低
    amount: num(37),      // 成交额（万元）
    turnover: num(38),    // 换手率 %
    amplitude: num(43),   // 振幅 %
  };
}

// ---------- 行情：分时 ----------
async function fetchMinute(code) {
  const tc = marketCode(code);
  const u = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tc}`;
  const { text } = await httpGet(u);
  const json = JSON.parse(text);
  const node = json && json.data && json.data[tc];
  const arr = (node && node.data && node.data.data) || [];
  // 每项 "HHMM price cumVol cumAmount"
  const points = arr.map((s) => {
    const p = s.split(' ');
    return {
      time: p[0],
      price: parseFloat(p[1]),
      cumVol: parseFloat(p[2]) || 0,
      cumAmount: parseFloat(p[3]) || 0,
    };
  });
  let prevClose = null;
  let name = null;
  if (node && node.qt && Array.isArray(node.qt[tc])) {
    prevClose = node.qt[tc][4] ? parseFloat(node.qt[tc][4]) : null;
    name = node.qt[tc][1] || null;
  }
  return { points, prevClose, name };
}

// ---------- 行情：东方财富日K（备用，含涨跌幅/成交额/换手） ----------
async function fetchEastmoneyDaily(limit) {
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.${CODE}&ut=fa5fd1943c7b386f172d6893dbfba10b&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&end=20500101&lmt=${limit}`;
  const { text } = await httpGet(u);
  const json = JSON.parse(text);
  const d = json && json.data;
  if (!d || !d.klines) throw new Error('东财K线返回结构异常');
  const klines = d.klines.map((s) => {
    const a = s.split(',');
    return {
      date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4],
      volume: +a[5] || 0, amount: +a[6] || 0, amplitude: +a[7] || 0,
      pctChange: +a[8] || 0, change: +a[9] || 0, turnover: +a[10] || 0,
    };
  });
  return { klines, quote: null };
}

// ---------- 简单内存缓存 ----------
const cache = new Map();
const predictCache = new Map();
const actionCache = new Map();   // /api/action 池级行动卡（5 分钟）
const searchCache = new Map(); // 搜索缓存（5分钟，加速重复搜索）
let globalExtrasCache = { t: 0, v: null }; // 预测用全局数据缓存（10分钟）
// ------------------------------------------------------------------ RL 学习状态（带 mtime 失效，训练完无需重启即可生效）
let _rlCache = { mtime: 0, state: null, path: null };
function getRlState() {
  const cands = [RL.defaultStatePath(), RL.bundledStatePath()];
  for (const f of cands) {
    try {
      if (!fs.existsSync(f)) continue;
      const mt = fs.statSync(f).mtimeMs;
      if (_rlCache.path === f && _rlCache.mtime === mt && _rlCache.state) return _rlCache.state;
      const st = RL.loadState(f);
      _rlCache = { mtime: mt, state: st, path: f };
      return st;
    } catch (e) { /* 试下一个 */ }
  }
  return RL.initState();
}

/** 把当日外部数据转成 fund / senti 两个专家的投票票值（仅实盘可用） */
function buildLiveVotes(extras) { // 已迁移到 lib/auto-ledger.js 的 liveVotesFromExtras，此处保留兼容
  const v = {};
  const ff = extras && extras.fundFlow;
  if (ff && ff.length) {
    const lp = ff[ff.length - 1];
    const mp = lp.mainNetInflowPct || 0;
    if (mp > 5) v.fund = 1;
    else if (mp > 0) v.fund = 0.6;
    else if (mp > -5) v.fund = -0.6;
    else v.fund = -1;
  }
  const hx = extras && extras.hhxg;
  if (hx && hx.sentimentIndex != null) {
    const s = hx.sentimentIndex;
    if (s >= 85) v.senti = -0.8;
    else if (s >= 65) v.senti = 0.8;
    else if (s >= 45) v.senti = 0;
    else if (s >= 25) v.senti = -0.5;
    else v.senti = 0.8;
  }
  return v;
}

async function getGlobalExtras() {
  if (globalExtrasCache.v && Date.now() - globalExtrasCache.t < 600000) return globalExtrasCache.v;
  const [fundR, brR, hxgR, idxR, usR, cnR, soxR, relR] = await Promise.allSettled([
    fetchFundFlow(10), fetchMarketBreadth(), fetchHhxgSnapshot(), fetchIndexKline('1.000300', 80),
    fetchUs10y(), fetchCn10y(), fetchSox(),
    Promise.all([fetchIndexKline('1.000688', 30), fetchIndexKline('1.000300', 30)]).then(([kc, hs]) => {
      const kc0 = kc[kc.length - 1].close, kc20 = kc[kc.length - 21].close;
      const hs0 = hs[hs.length - 1].close, hs20 = hs[hs.length - 21].close;
      return ((kc0 / kc20 - 1) - (hs0 / hs20 - 1)) * 100;
    }),
  ]);
  const idx = idxR.status === 'fulfilled' ? idxR.value : null;
  const v = {
    fundFlow: fundR.status === 'fulfilled' ? fundR.value : null,
    breadth: brR.status === 'fulfilled' ? brR.value : null,
    hhxg: hxgR.status === 'fulfilled' ? hxgR.value : null,
    index: idx,
    macro: { us10y: usR.status === 'fulfilled' ? usR.value : null, cn10y: cnR.status === 'fulfilled' ? cnR.value : null },
    sox: soxR.status === 'fulfilled' ? soxR.value : null,
    relStrength: relR.status === 'fulfilled' ? relR.value : null,
  };
  globalExtrasCache = { t: Date.now(), v };
  return v;
}
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = fn().then((r) => { cache.set(key, { t: Date.now(), v: r }); return r; })
    .catch((e) => { cache.delete(key); throw e; });
  return v;
}

// ---------- 工具 ----------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

// ---------- 交易执行 ----------
// 佣金：ETF 免印花税，仅收佣金（万2.5，最低5元）
const COMMISSION_RATE = 0.00025;
function fee(amount) { return Math.max(5, amount * COMMISSION_RATE); }

function currentPriceOf(state) {
  // 有成交价用成交价；否则用最新行情（由调用方传入 price）
  return state;
}

function executeTrade(state, side, price, qty, code, name) {
  code = code || CODE;
  name = name || (code === CODE ? NAME : code);
  // qty 为份额（100 的整数倍）
  if (qty <= 0) throw new Error('数量必须大于0');
  if (qty % 100 !== 0) throw new Error('买卖需为 100 份的整数倍');
  const amount = +(qty * price).toFixed(2);
  const isStock = ['6', '0', '3'].includes(String(code)[0]);
  // 股票卖出收印花税 0.05%，ETF 免
  const f = fee(amount) + (side === 'sell' && isStock ? amount * 0.0005 : 0);
  const pos = state.positions[code] || { code, name, shares: 0, avgCost: 0 };

  if (side === 'buy') {
    if (amount + f > state.cash + 1e-6) throw new Error('可用资金不足');
    const newShares = pos.shares + qty;
    const totalCost = pos.avgCost * pos.shares + amount + f;
    pos.shares = newShares;
    pos.avgCost = +(totalCost / newShares).toFixed(4);
    state.positions[code] = pos;
    state.cash = +(state.cash - amount - f).toFixed(2);
  } else if (side === 'sell') {
    if (qty > pos.shares) throw new Error('可卖份额不足');
    const proceeds = amount - f;
    const costBasis = pos.avgCost * qty;
    state.cash = +(state.cash + proceeds).toFixed(2);
    state.realizedPnl = +(state.realizedPnl + (proceeds - costBasis)).toFixed(2);
    pos.shares -= qty;
    if (pos.shares === 0) delete state.positions[code];
    else state.positions[code] = pos;
  } else {
    throw new Error('未知方向');
  }

  // 兼容旧界面：159516 同步到 shares/avgCost
  if (code === CODE) {
    const p159516 = state.positions[CODE] || { shares: 0, avgCost: 0 };
    state.shares = p159516.shares;
    state.avgCost = p159516.avgCost;
  }

  state.trades.push({
    time: new Date().toISOString(),
    side, code, name, price: +price.toFixed(4), shares: qty,
    amount: +amount.toFixed(2), fee: +f.toFixed(2),
    note: side === 'buy' ? `买入 ${name} ${qty} 份 @ ${price}` : `卖出 ${name} ${qty} 份 @ ${price}`,
  });
  saveState(state);
  return state;
}

// ---------- 盯盘进程管理（打开网页时启动，替代开机自启） ----------
function isMonitorRunning() {
  try {
    if (!fs.existsSync(MONITOR_PID_FILE)) return false;
    const pid = parseInt(fs.readFileSync(MONITOR_PID_FILE, 'utf8'), 10);
    if (!pid) return false;
    process.kill(pid, 0); // 抛异常表示进程不存在
    return true;
  } catch (e) { return false; }
}
function spawnMonitor() {
  if (isMonitorRunning()) return { running: true, started: false };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
  const logFd = fs.openSync(path.join(DATA_DIR, 'monitor.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'monitor.js')], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  return { running: true, started: true, pid: child.pid };
}

// 本机局域网 IP（手机/其它设备访问用）
function getLanIp() {
  try {
    const os = require('os');
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const iface of ifs[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch (e) {}
  return null;
}

// 轮动池（ETF + 科技板块股票，与 monitor 一致；从 notify.config.json 读取）
function loadPool() {
  try {
    const f = path.join(__dirname, 'notify.config.json');
    if (fs.existsSync(f)) {
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cfg.etfPool && cfg.etfPool.length) return cfg.etfPool;
    }
  } catch (e) {}
  return [
    { code: '159516', name: '半导体设备', type: 'etf' },
    { code: '512010', name: '医药', type: 'etf' },
    { code: '512400', name: '有色', type: 'etf' },
    { code: '512660', name: '军工', type: 'etf' },
    { code: '688981', name: '中芯国际', type: 'stock' },
    { code: '688012', name: '中微公司', type: 'stock' },
    { code: '002371', name: '北方华创', type: 'stock' },
    { code: '688256', name: '寒武纪', type: 'stock' },
    { code: '688041', name: '海光信息', type: 'stock' },
    { code: '603986', name: '兆易创新', type: 'stock' },
    { code: '688008', name: '澜起科技', type: 'stock' },
    { code: '688783', name: '西安奕材-U', type: 'stock' },
    { code: '300475', name: '香农芯创', type: 'stock' },
  ];
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  const q = u.query;

  try {
    // 静态文件
    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/static/')) {
      const fp = path.join(PUBLIC_DIR, p.slice(1));
      const ext = path.extname(fp).toLowerCase();
      const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      return serveFile(res, fp, mime);
    }

    // 行情接口（支持 ?code=XXX 查询任意 ETF，默认 159516）
    if (p === '/api/quote') {
      const code = q.code || CODE;
      const period = q.period || 'day';
      const limit = parseInt(q.limit || '5', 10);
      const r = await cached('quote_' + code + '_' + period + '_' + limit, 15000, () => fetchTencentKline(period, limit, code));
      const quote = r.quote || (r.klines.length ? {
        name: NAME, code, price: r.klines[r.klines.length - 1].close,
        prevClose: r.klines.length > 1 ? r.klines[r.klines.length - 2].close : null,
        open: r.klines[r.klines.length - 1].open, high: r.klines[r.klines.length - 1].high,
        low: r.klines[r.klines.length - 1].low, volume: r.klines[r.klines.length - 1].volume,
        time: '', change: null, pctChange: null, amount: null, turnover: null, amplitude: null,
      } : null);
      return sendJSON(res, 200, { ok: true, code, name: quote ? quote.name : NAME, quote });
    }

    if (p === '/api/kline') {
      const code = q.code || CODE;
      const period = q.period || 'day';
      const limit = Math.min(parseInt(q.limit || '250', 10), 1000);
      try {
        const r = await cached('kline_' + code + '_' + period + '_' + limit, 60000, () => fetchTencentKline(period, limit, code));
        const kname = (r.quote && r.quote.name) || (code === CODE ? NAME : code);
        return sendJSON(res, 200, { ok: true, code, name: kname, period, klines: r.klines, quote: r.quote });
      } catch (e) {
        if (period === 'day' && code === CODE) {
          const r = await cached('em_daily_' + limit, 60000, () => fetchEastmoneyDaily(limit));
          return sendJSON(res, 200, { ok: true, code: CODE, name: NAME, period, klines: r.klines, quote: null, source: 'eastmoney' });
        }
        throw e;
      }
    }

    if (p === '/api/minute') {
      const code = q.code || CODE;
      const r = await cached('minute_' + code, 15000, () => fetchMinute(code));
      return sendJSON(res, 200, { ok: true, code, ...r, name: r.name || (code === CODE ? NAME : code) });
    }

    // 搜索接口（东财建议，过滤基金/ETF）
    if (p === '/api/search') {
      const kw = (q.q || '').trim();
      if (!kw) return sendJSON(res, 200, { ok: true, results: [] });
      const sk = 's_' + kw;
      const sh = searchCache.get(sk);
      if (sh && Date.now() - sh.t < 300000) return sendJSON(res, 200, sh.v);
      try {
        const searchOne = async (word) => {
          const r = await httpGet(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(word)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12`, { headers: { Referer: 'https://quote.eastmoney.com/' } });
          const j = JSON.parse(r.text);
          const data = (j && j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
          return data.filter((x) => /^\d{6}$/.test(x.Code) && x.Classify !== 'HK').map((x) => ({ code: x.Code, name: x.Name }));
        };
        // 6位代码或已含 ETF/基金 → 直接搜；否则补 "ETF" 后缀命中基金（最多两次搜索）
        const words = /^\d{6}$/.test(kw) || /ETF|基金/.test(kw) ? [kw] : [kw, kw + 'ETF'];
        let results = [];
        for (const w of words) { try { results = results.concat(await searchOne(w)); } catch (e) {} }
        const seen = new Set();
        results = results.filter((x) => { if (seen.has(x.code)) return false; seen.add(x.code); return true; }).slice(0, 12);
        const out = { ok: true, results };
        searchCache.set(sk, { t: Date.now(), v: out });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, 200, { ok: true, results: [], error: e.message });
      }
    }

    // 宏观 + 科技板块数据（美债10Y / 中债10Y / 费半SOX）
    if (p === '/api/macro') {
      const [us, cn, sox] = await Promise.allSettled([fetchUs10y(), fetchCn10y(), fetchSox()]);
      return sendJSON(res, 200, {
        ok: true,
        us10y: us.status === 'fulfilled' ? us.value : null,
        cn10y: cn.status === 'fulfilled' ? cn.value : null,
        sox: sox.status === 'fulfilled' ? sox.value : null,
      });
    }

    // 前瞻预测：1天/3天/1周/1月（综合技术+资金+情绪+消息+宏观+科技板块）
    if (p === '/api/predict') {
      const code = q.code || CODE;
      const ck = 'predict_' + code;
      const hit = predictCache.get(ck);
      if (hit && Date.now() - hit.t < 300000) return sendJSON(res, 200, hit.v);
      try {
        const { klines: raw, quote } = await fetchTencentKline('day', 260, code);
        const klines = calibrateKlines(raw, quote, 'day');
        const extras = await getGlobalExtras(); // 全局数据走 10 分钟缓存
        const analysis = Engine.analyze(klines, Indicators.computeAll(klines), quote, Engine.DEFAULT_SETTINGS, extras);
        const prediction = Engine.predict(klines, analysis, extras);

        // ---- 接入「学到的权重 + 标定后的概率」的实盘预测 ----
        let live = null;
        try {
          const state = getRlState();
          const hist = await fetchGlobalHistory({ bars: 640 });
          live = LivePredict.predictLive(klines, {
            indexKlines: hist.indexKlines,
            soxSeries: hist.soxSeries,
            us10ySeries: hist.us10ySeries,
            spxSeries: hist.spxSeries,
          }, state, { liveVotes: buildLiveVotes(extras) });
          // 用标定后的方向与概率覆盖手工结果，原始值保留在 *_rawModel 字段
          // （绝不隐藏"打折"这件事）。合并逻辑集中在 lib/live-predict.js，避免多处实现不一致。
          LivePredict.applyLiveToPrediction(prediction, live);
        } catch (e) {
          live = { ok: false, error: e.message };
        }

        const out = { ok: true, code, name: quote ? quote.name : code, price: analysis.price, score: analysis.score, status: analysis.status, prediction, live };
        predictCache.set(ck, { t: Date.now(), v: out });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 池级「今日行动卡」：把前瞻指引合成一个可直接执行的结论
    //
    // 为什么需要：/api/predict 是单标的的，用户要看全池 13 只要逐个点开 ——
    // 那是数据不是指引。这里给出"今天动不动 / 动哪只 / 下次何时看"。
    if (p === '/api/action') {
      const hit = actionCache.get('action');
      if (hit && Date.now() - hit.t < 300000) return sendJSON(res, 200, hit.v);
      try {
        const state = getRlState();
        const tp = state.tradingPolicy || {};
        const decided = tp.decided || tp;
        const smooth = q.smooth != null ? parseInt(q.smooth, 10) : (tp.signalSmoothing || 1);
        const mode = q.mode || tp.operatingMode || 'monthly';
        const pool = loadPool();
        const extras = await getGlobalExtras();
        const hist = await fetchGlobalHistory({ bars: 640 });
        const liveVotes = buildLiveVotes(extras);
        const account = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'account.json'), 'utf8')); } catch (e) { return { positions: {}, cash: 0 }; } })();
        const positions = account.positions || {};
        const th = decided.thresholds || {};
        const conf = decided.confluencePolicy || state.confluencePolicy || null;

        // 并发拉全池 K 线并预测（与 monitor.js 的 pool.map 同一模式）
        const rows = (await Promise.all(pool.map(async (e) => {
          try {
            const { klines: raw, quote } = await fetchTencentKline('day', 320, e.code);
            const klines = calibrateKlines(raw, quote, 'day');
            if (!klines || klines.length < 61) return null;
            const live = LivePredict.predictLive(klines, {
              indexKlines: hist.indexKlines, soxSeries: hist.soxSeries,
              us10ySeries: hist.us10ySeries, spxSeries: hist.spxSeries,
            }, state, { liveVotes, smooth });
            if (!live.ok) return null;
            const closes = klines.map((k) => k.close);
            const n = closes.length;
            const mom20 = n > 20 ? (closes[n - 1] / closes[n - 21] - 1) * 100 : null;
            return {
              code: e.code, name: e.name || e.code, price: live.price,
              mom20: mom20 == null ? null : +mom20.toFixed(2),
              pW1: live.horizons.w1.upProb, pM1: live.horizons.m1.upProb, pD3: live.horizons.d3.upProb,
              w1Signal: live.horizons.w1.signal, m1Signal: live.horizons.m1.signal,
              gatePass: conf && conf.need ? conf.need.every((h) => live.horizons[h].upProb / 100 >= ((conf.thresholds && conf.thresholds[h]) || 0.55)) : null,
              regime: live.regime,
              positions: positions[e.code] ? { shares: positions[e.code].shares, avgCost: positions[e.code].avgCost } : null,
            };
          } catch (err) { return null; }
        }))).filter(Boolean);

        // 动量排名
        const ranked = rows.slice().filter((r) => r.mom20 != null).sort((a, b) => b.mom20 - a.mom20);
        ranked.forEach((r, i) => { r.momRank = i + 1; });

        // 门禁检查
        const idx = extras && extras.index;
        const bear = !!(idx && idx.ma60 && idx.price < idx.ma60);
        const checks = [
          { item: '大盘（沪深300 vs MA60）', pass: !bear, detail: bear ? '熊市 → 建议观望' : '多头' },
          { item: '情绪（赚钱效应）', pass: !(extras && extras.hhxg && extras.hhxg.sentimentIndex >= 85), detail: extras && extras.hhxg && extras.hhxg.sentimentIndex != null ? String(extras.hhxg.sentimentIndex) : '--' },
          { item: '美债10Y', pass: !(extras && extras.macro && extras.macro.us10y && extras.macro.us10y.price > 4.5), detail: extras && extras.macro && extras.macro.us10y && extras.macro.us10y.price != null ? extras.macro.us10y.price + '%' : '--' },
        ];

        const held = rows.filter((r) => r.positions);
        const gateCand = ranked.filter((r) => r.gatePass);
        let verdict = '观望', reason = '';
        if (bear && held.length) { verdict = '减仓'; reason = '大盘转熊，按纪律降低仓位'; }
        else if (bear) { verdict = '观望'; reason = '大盘熊市（沪深300<MA60）'; }
        else if (!gateCand.length) { verdict = '观望'; reason = '无标的通过「多周期共振 + 入场门槛」'; }
        else if (held.length) { verdict = '持有'; reason = `${held.map((h) => h.name).join('、')} 仍满足条件`; }
        else { verdict = '建仓'; reason = `候选：${gateCand.slice(0, 3).map((c) => c.name).join('、')}`; }

        // 下次复查日
        const nowD = new Date();
        const nextReview = (() => {
          const d = new Date(nowD.getTime());
          if (mode === 'monthly') { d.setMonth(d.getMonth() + 1, 1); while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1); }
          else if (mode === 'weekly') { d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); }
          else d.setDate(d.getDate() + 1);
          const pp = (x) => String(x).padStart(2, '0');
          return `${d.getFullYear()}-${pp(d.getMonth() + 1)}-${pp(d.getDate())}`;
        })();

        const out = {
          ok: true,
          asOf: new Date().toISOString(),
          operatingMode: mode, smoothWindow: smooth, nextReviewDate: nextReview,
          verdict, reason,
          evidenceLevel: '入场门槛为 post-hoc 观察，未经前向验证（见 node ledger.js gate）',
          checks,
          positions: held.map((h) => ({ code: h.code, name: h.name, shares: h.positions.shares, avgCost: h.positions.avgCost, price: h.price, pnlPct: +(((h.price - h.positions.avgCost) / h.positions.avgCost) * 100).toFixed(2) })),
          candidates: ranked.map((r) => ({ code: r.code, name: r.name, mom20: r.mom20, momRank: r.momRank, pW1: r.pW1, pM1: r.pM1, gatePass: r.gatePass, w1Signal: r.w1Signal, held: !!r.positions })),
          thresholds: { d3: (conf && conf.thresholds && conf.thresholds.d3) || null, w1: th.w1 ? th.w1.threshold : null, m1: th.m1 ? th.m1.threshold : null },
        };
        actionCache.set('action', { t: Date.now(), v: out });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 研究台账：结论留痕 + 到期结算 + 准确率（回答"你到底准不准"）
    if (p === '/api/ledger') {
      try {
        const Ledger = require('./lib/research-ledger.js');
        const db = Ledger.loadLedger();
        const st = Ledger.stats(db);
        const code = q.code;
        let entries = db.entries || [];
        if (code) entries = entries.filter((e) => e.code === code);
        // 列表瘦身：不带完整 klines，只带结论与结算
        const slim = entries.map((e) => ({
          id: e.id, code: e.code, name: e.name, kind: e.kind,
          askedAt: e.askedAt, anchorDate: e.anchorDate, anchorPrice: e.anchorPrice,
          question: e.question, verdict: e.verdict, stance: e.stance,
          confidence: e.confidence, confidenceCeiling: e.confidenceCeiling,
          ceilingReason: e.ceilingReason, overconfidence: !!e.overconfidence,
          evidenceMix: e.evidenceMix, evidence: e.evidence,
          keyLevels: e.keyLevels, plan: e.plan, tags: e.tags,
          status: e.status, scores: e.scores,
          outcomes: (e.outcomes || []).map((o) => ({
            horizon: o.horizon, horizonLabel: o.horizonLabel, source: o.source,
            predictedDir: o.predictedDir, upProb: o.upProb, actualDir: o.actualDir,
            actualPct: o.actualPct, dirHit: o.dirHit, rangeHitClose: o.rangeHitClose,
            brier: o.brier, reward: o.reward, pending: !!o.pending,
            fromDate: o.fromDate, toDate: o.toDate,
          })),
          lessons: e.lessons,
        }));
        return sendJSON(res, 200, { ok: true, stats: st, entries: slim, grades: Ledger.EVIDENCE_GRADES });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 学到的专家权重 + 概率标定 + 样本外成绩单
    if (p === '/api/rl') {
      try {
        const rl = require('./lib/rl.js');
        const EXP = require('./lib/signals.js');
        const state = rl.loadStateWithFallback();
        const horizons = {};
        for (const h of rl.HORIZONS) {
          horizons[h] = {
            label: rl.HORIZON_LABEL[h],
            calibration: state.calibration ? state.calibration[h] : null,
            leaderboard: rl.expertLeaderboard(state, h).map((r) => Object.assign({}, r, {
              label: EXP.EXPERT_LABEL[r.expert] || r.expert,
            })),
          };
        }
        let report = null;
        for (const cand of [path.join(__dirname, 'data', 'rl-report.json'), path.join(__dirname, 'model', 'rl-report.json')]) {
          try { report = JSON.parse(fs.readFileSync(cand, 'utf8')); break; } catch (e2) { /* 试下一个 */ }
        }
        return sendJSON(res, 200, {
          ok: true,
          meta: {
            eta: state.eta, discount: state.discount, floor: state.floor,
            rounds: state.rounds, updatedAt: state.updatedAt, trainedFrom: state.trainedFrom,
            ledgerFeedback: state.ledgerFeedback || null,
            tradingPolicy: state.tradingPolicy || null,
          },
          horizons,
          report,
        });
      } catch (e) {
        return sendJSON(res, 500, { ok: false, error: e.message });
      }
    }

    // 轮动池管理：GET 获取；POST 增删（写回 notify.config.json）
    if (p === '/api/pool') {
      const cfgFile = path.join(__dirname, 'notify.config.json');
      if (req.method === 'POST') {
        const body = await readBody(req);
        let pool = loadPool();
        if (body.action === 'add' && body.code) {
          const code = String(body.code);
          if (!pool.some((x) => x.code === code)) {
            const c0 = code[0];
            pool.push({ code, name: body.name || code, type: (c0 === '5' || c0 === '1') ? 'etf' : 'stock' });
          }
        } else if (body.action === 'remove' && body.code) {
          pool = pool.filter((x) => x.code !== body.code);
        }
        try {
          const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
          cfg.etfPool = pool;
          fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
        } catch (e) { return sendJSON(res, 500, { ok: false, error: '保存失败: ' + e.message }); }
        return sendJSON(res, 200, { ok: true, pool });
      }
      return sendJSON(res, 200, { ok: true, pool: loadPool() });
    }

    // 账户接口
    if (p === '/api/state') {
      return sendJSON(res, 200, { ok: true, state: loadState(), readOnly: READ_ONLY, pool: loadPool(), lanIp: getLanIp() });
    }
    if (p === '/api/trade' && req.method === 'POST') {
      if (READ_ONLY) return sendJSON(res, 403, { ok: false, error: '当前为只读模式，禁止交易' });
      const body = await readBody(req);
      const state = loadState();
      const code = body.code || CODE;
      const name = body.name || (code === CODE ? NAME : code);
      // 用最新价作为成交价（若未指定限价）
      let price = parseFloat(body.price);
      if (!price || price <= 0) {
        const r = await cached('quote_for_trade_' + code, 15000, () => fetchTencentKline('day', 2, code));
        price = r.quote ? r.quote.price : (r.klines.length ? r.klines[r.klines.length - 1].close : null);
      }
      if (!price || price <= 0) return sendJSON(res, 400, { ok: false, error: '无法获取成交价格，请重试' });

      let qty = parseInt(body.shares, 10);
      if (!qty && body.amount) {
        if (body.side === 'buy') qty = Math.floor(parseFloat(body.amount) / price / 100) * 100;
      }
      if (!qty || qty <= 0) return sendJSON(res, 400, { ok: false, error: '请填写数量（份）或买入金额' });

      try {
        executeTrade(state, body.side, price, qty, code, name);
        return sendJSON(res, 200, { ok: true, state, price });
      } catch (e) {
        return sendJSON(res, 400, { ok: false, error: e.message });
      }
    }
    if (p === '/api/reset' && req.method === 'POST') {
      if (READ_ONLY) return sendJSON(res, 403, { ok: false, error: '当前为只读模式，禁止重置' });
      const body = await readBody(req);
      const capital = parseFloat(body.capital);
      const ns = defaultState();
      if (capital && capital > 0) { ns.totalCapital = capital; ns.cash = capital; }
      saveState(ns);
      return sendJSON(res, 200, { ok: true, state: ns });
    }

    // 盯盘进程：打开网页时启动（只读模式禁用）
    if (p === '/api/monitor/start' && req.method === 'POST') {
      if (READ_ONLY) return sendJSON(res, 200, { ok: true, running: false, started: false, disabled: true });
      const r = spawnMonitor();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (p === '/api/monitor/status') {
      return sendJSON(res, 200, { ok: true, running: isMonitorRunning() });
    }

    // 复盘接口
    if (p === '/api/review' && req.method === 'POST') {
      if (READ_ONLY) return sendJSON(res, 403, { ok: false, error: '当前为只读模式，禁止保存复盘' });
      const body = await readBody(req);
      const state = loadState();
      const review = {
        date: body.date || new Date().toISOString().slice(0, 10),
        time: new Date().toISOString(),
        content: body.content || '',
        auto: !!body.auto,
        snapshot: body.snapshot || null,
      };
      state.reviews.push(review);
      // 最多保留 500 条
      if (state.reviews.length > 500) state.reviews = state.reviews.slice(-500);
      saveState(state);
      return sendJSON(res, 200, { ok: true, state, review });
    }
    if (p === '/api/reviews') {
      const state = loadState();
      return sendJSON(res, 200, { ok: true, reviews: state.reviews });
    }

    return sendJSON(res, 404, { ok: false, error: 'not found: ' + p });
  } catch (e) {
    console.error('[server] error on', p, e.message);
    return sendJSON(res, 500, { ok: false, error: e.message || 'server error' });
  }
});

function serveFile(res, fp, mime) {
  try {
    const data = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  半导体设备ETF(159516) 智能交易模拟系统');
  console.log('  已启动： http://' + HOST + ':' + PORT);
  console.log('==============================================');
});
