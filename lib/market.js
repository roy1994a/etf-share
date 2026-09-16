/**
 * 行情数据模块（零依赖，仅用 Node 内置模块）
 * 提供：腾讯行情 K 线（日/周/月）+ 实时 qt、分时、K线校准
 * 供 server.js / daily-report.js / monitor.js 复用。
 */
'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const CODE = '159516';
const SZ_CODE = 'sz' + CODE;
const NAME = '半导体设备ETF国泰';

// 网络请求（含 gzip 解压与 UA）
function httpGet(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const mod = urlStr.startsWith('https') ? https : http;
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (urlStr.startsWith('https') ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'User-Agent': UA, 'Referer': 'https://gu.qq.com/', 'Accept-Encoding': 'gzip, deflate' },
        opts.headers || {}
      ),
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
    if (opts.body) req.write(opts.body);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// POST JSON（用于推送通道）
function httpPostJson(urlStr, json, headers = {}) {
  const body = JSON.stringify(json);
  return httpGet(urlStr, {
    method: 'POST',
    body,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers),
  });
}

// POST 表单（用于 Server酱）
function httpPostForm(urlStr, params, headers = {}) {
  const body = Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  return httpGet(urlStr, {
    method: 'POST',
    body,
    headers: Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }, headers),
  });
}

// 代码 → 腾讯市场前缀（6/5/9=沪市：沪股/沪ETF/沪B；0/1/3=深市：深股/深ETF/创业板）
function tencentCode(code) {
  code = String(code || CODE);
  const c0 = code[0];
  return (c0 === '6' || c0 === '5' || c0 === '9' ? 'sh' : 'sz') + code;
}

// 腾讯 K 线（含实时 qt）；code 可省略（默认 159516）
// ---------------- 限流：同一 host 的最小请求间隔 ----------------
// 事故背景：腾讯对本机返回 WAF 501（web.ifzq.gtimg.cn 被拦），
// 起因是本次会话内训练/消融/探测累计上千次请求。此后所有取数都走节流。
const _hostLast = {};
const HOST_MIN_GAP_MS = { 'web.ifzq.gtimg.cn': 320, 'money.finance.sina.com.cn': 320, default: 120 };
async function throttle(urlStr) {
  let host = 'default';
  try { host = new URL(urlStr).host; } catch (e) { /* ignore */ }
  const gap = HOST_MIN_GAP_MS[host] || HOST_MIN_GAP_MS.default;
  const last = _hostLast[host] || 0;
  const wait = gap - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _hostLast[host] = Date.now();
}

// ---------------- 数据源健康登记 ----------------
// 每个取数函数都登记成功/失败，供 /api/health 与 GUI 展示。
// 目的：让"静默降级"变成"可见降级"。
const _health = {};
function healthRecord(name, ok, ms, err, note) {
  const h = _health[name] || (_health[name] = { name, ok: 0, fail: 0, lastOkAt: null, lastFailAt: null, lastErr: null, lastMs: null, note: null, consecutiveFail: 0 });
  if (ok) { h.ok++; h.lastOkAt = new Date().toISOString(); h.lastMs = ms; h.consecutiveFail = 0; }
  else { h.fail++; h.lastFailAt = new Date().toISOString(); h.lastErr = String(err || '').slice(0, 200); h.consecutiveFail++; }
  if (note !== undefined) h.note = note;
}
function healthSnapshot() {
  const out = {};
  for (const k of Object.keys(_health)) {
    const h = _health[k];
    out[k] = Object.assign({}, h, {
      total: h.ok + h.fail,
      successRate: (h.ok + h.fail) ? +(h.ok / (h.ok + h.fail)).toFixed(3) : null,
      status: h.consecutiveFail === 0 && h.ok > 0 ? 'ok' : (h.consecutiveFail >= 3 ? 'down' : (h.ok > 0 ? 'degraded' : 'unknown')),
    });
  }
  return out;
}

/** 腾讯 K 线：主源（前复权）
 *  ⚠️ 该路径已被腾讯 WAF 拦截，保留为首选以便恢复后自动回到前复权口径 */
async function fetchTencentKlineQfq(tc, p, limit) {
  const u = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},${p},,,${limit},qfq`;
  const t0 = Date.now();
  try {
    await throttle(u);
    const { text } = await httpGet(u);
    const json = JSON.parse(text);
    const node = json && json.data && json.data[tc];
    if (!node) throw new Error('腾讯K线返回结构异常: ' + tc);
    const arr = node['qfq' + p] || node[p] || [];
    if (!arr.length) throw new Error('腾讯K线为空: ' + tc);
    healthRecord('kline:tencent-qfq', true, Date.now() - t0, null, '前复权（首选）');
    const klines = arr.map((r) => ({
      date: r[0], open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) || 0,
    }));
    let quote = null;
    if (node.qt && Array.isArray(node.qt[tc])) quote = parseTencentQuote(node.qt[tc]);
    return { klines, quote, source: 'tencent-qfq', adjusted: true };
  } catch (e) {
    healthRecord('kline:tencent-qfq', false, Date.now() - t0, errText(e), '前复权（首选）');
    throw e;
  }
}

/** 腾讯 K 线：备用路径（**不复权**，但当前可用且含当日） */
async function fetchTencentKlineNoAdj(tc, p, limit) {
  const u = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${tc},${p},,,${limit}`;
  const t0 = Date.now();
  try {
    await throttle(u);
    const { text } = await httpGet(u);
    const json = JSON.parse(text);
    const node = json && json.data && json.data[tc];
    const arr = (node && (node[p] || node['qfq' + p])) || [];
    if (!arr.length) throw new Error('腾讯K线(备用)为空: ' + tc);
    healthRecord('kline:tencent-noadj', true, Date.now() - t0, null, '不复权（备用1）');
    const klines = arr.map((r) => ({
      date: r[0], open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) || 0,
    }));
    let quote = null;
    if (node.qt && Array.isArray(node.qt[tc])) quote = parseTencentQuote(node.qt[tc]);
    return { klines, quote, source: 'tencent-noadj', adjusted: false };
  } catch (e) {
    healthRecord('kline:tencent-noadj', false, Date.now() - t0, errText(e), '不复权（备用1）');
    throw e;
  }
}

/** 新浪 K 线（备用2，**不复权**，T-1 收盘） */
async function fetchSinaKline(code, limit) {
  const cs = String(code);
  // 已带 sh/sz 前缀的（指数）直接用；否则按首位判断市场
  const sym = /^(sh|sz)\d{6}$/.test(cs) ? cs
    : (((cs[0] === '6' || cs[0] === '5' || cs[0] === '9') ? 'sh' : 'sz') + cs);
  const u = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=${Math.min(1023, limit)}`;
  const t0 = Date.now();
  try {
    await throttle(u);
    const { text } = await httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' } });
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || !arr.length) throw new Error('新浪K线为空: ' + code);
    healthRecord('kline:sina', true, Date.now() - t0, null, '不复权（备用2，T-1）');
    const klines = arr.map((r) => ({
      date: r.day, open: parseFloat(r.open), close: parseFloat(r.close),
      high: parseFloat(r.high), low: parseFloat(r.low), volume: parseFloat(r.volume) || 0,
    }));
    return { klines, quote: null, source: 'sina', adjusted: false };
  } catch (e) {
    healthRecord('kline:sina', false, Date.now() - t0, errText(e), '不复权（备用2，T-1）');
    throw e;
  }
}

/**
 * 腾讯 K 线（对外主入口）
 * 回退链：腾讯前复权 → 腾讯不复权 → 新浪不复权
 * 返回值新增 source / adjusted / degraded，让调用方知道数据质量。
 */
async function fetchTencentKline(period, limit, code) {
  const tc = tencentCode(code);
  const p = { day: 'day', week: 'week', month: 'month' }[period] || 'day';
  const errs = [];
  try {
    const r = await fetchTencentKlineQfq(tc, p, limit);
    return Object.assign(r, { degraded: false });
  } catch (e) { errs.push('qfq:' + errText(e)); }
  try {
    const r = await fetchTencentKlineNoAdj(tc, p, limit);
    return Object.assign(r, { degraded: true, degradedReason: '主源(前复权)不可用，已回退不复权：' + errs[0] });
  } catch (e) { errs.push('noadj:' + errText(e)); }
  try {
    const r = await fetchSinaKline(code, limit);
    return Object.assign(r, { degraded: true, degradedReason: '腾讯两个路径均不可用，已回退新浪：' + errs.join(' | ') });
  } catch (e) { errs.push('sina:' + errText(e)); }
  throw new Error('所有K线数据源均不可用：' + errs.join(' | '));
}

// 解析腾讯 qt 数组 → 干净对象
function parseTencentQuote(q) {
  const num = (i) => { const v = q[i]; if (v == null || v === '') return null; const n = parseFloat(v); return isNaN(n) ? null : n; };
  return {
    name: q[1] || NAME, code: q[2] || CODE, price: num(3), prevClose: num(4), open: num(5),
    volume: num(6), time: q[30] || '', change: num(31), pctChange: num(32),
    high: num(33), low: num(34), amount: num(37), turnover: num(38), amplitude: num(43),
  };
}

// 分时
async function fetchMinute() {
  const u = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${SZ_CODE}`;
  const { text } = await httpGet(u);
  const json = JSON.parse(text);
  const node = json && json.data && json.data[SZ_CODE];
  const arr = (node && node.data && node.data.data) || [];
  const points = arr.map((s) => {
    const p = s.split(' ');
    return { time: p[0], price: parseFloat(p[1]), cumVol: parseFloat(p[2]) || 0, cumAmount: parseFloat(p[3]) || 0 };
  });
  let prevClose = null;
  if (node && node.qt && Array.isArray(node.qt[SZ_CODE])) prevClose = node.qt[SZ_CODE][4] ? parseFloat(node.qt[SZ_CODE][4]) : null;
  return { points, prevClose };
}

// 用实时价校准当日 K 线（与前端 app.js 逻辑一致）
function calibrateKlines(klines, quote, period) {
  const arr = klines.slice();
  const lastK = arr[arr.length - 1];
  if (quote && quote.price != null && period === 'day') {
    const t = quote.time || '';
    const qDate = t.length >= 8 ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) : null;
    if (qDate && lastK.date === qDate) {
      lastK.open = quote.open != null ? quote.open : lastK.open;
      lastK.close = quote.price;
      lastK.high = quote.high != null ? quote.high : lastK.high;
      lastK.low = quote.low != null ? quote.low : lastK.low;
      lastK.volume = quote.volume != null ? quote.volume : lastK.volume;
    } else if (qDate && lastK.date < qDate) {
      arr.push({ date: qDate, open: quote.open != null ? quote.open : quote.price, close: quote.price, high: quote.high != null ? quote.high : quote.price, low: quote.low != null ? quote.low : quote.price, volume: quote.volume || 0 });
    } else {
      lastK.close = quote.price;
    }
  }
  return arr;
}

// 带重试的请求（东财接口偶发断连）
async function withRetry(fn, retries, delayMs) {
  retries = retries || 2; delayMs = delayMs || 600;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; if (i < retries) await new Promise((r) => setTimeout(r, delayMs)); }
  }
  throw lastErr;
}
const EM_HEADERS = { headers: { Referer: 'https://data.eastmoney.com/' } };

// 主力资金流向（东财，日K；今日数据收盘后更新）
async function fetchFundFlow(limit) {
  limit = limit || 10;
  const u = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=${limit}&klt=101&secid=0.${CODE}&secid2=0.${CODE}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;
  const { text } = await withRetry(() => httpGet(u, EM_HEADERS));
  const json = JSON.parse(text);
  const d = json && json.data;
  if (!d || !d.klines) throw new Error('资金流向返回结构异常');
  return d.klines.map((s) => {
    const a = s.split(',');
    return {
      date: a[0],
      mainNetInflow: +a[1] || 0,        // 主力净流入（元）
      smallNetInflow: +a[2] || 0,
      midNetInflow: +a[3] || 0,
      bigNetInflow: +a[4] || 0,
      superBigNetInflow: +a[5] || 0,    // 超大单净流入
      mainNetInflowPct: +a[6] || 0,     // 主力净流入占比（%）
      bigPct: +a[9] || 0,
      superBigPct: +a[10] || 0,
      close: +a[11] || 0,
      pctChange: +a[12] || 0,
    };
  });
}

// 市场情绪：涨跌家数（东财涨跌分布，实时）
async function fetchMarketBreadth() {
  const u = 'https://push2ex.eastmoney.com/getTopicZDFenBu?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt';
  const { text } = await withRetry(() => httpGet(u, EM_HEADERS));
  const json = JSON.parse(text);
  const fenbu = json && json.data && json.data.fenbu;
  if (!fenbu || !fenbu.length) throw new Error('涨跌分布返回结构异常');
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0;
  for (const item of fenbu) {
    const k = Object.keys(item)[0];
    const v = item[k];
    const n = parseInt(k, 10);
    if (n > 0) up += v;
    else if (n < 0) down += v;
    else flat += v;
    if (n >= 10) limitUp += v;   // 涨停及以上
    if (n <= -10) limitDown += v; // 跌停及以下
  }
  const total = up + down + flat;
  return { up, down, flat, limitUp, limitDown, total, upRatio: total ? up / total * 100 : 50, ratio: down ? up / down : (up ? 99 : 1) };
}

// 消息面：新闻标题关键词情感打分（东财搜索，JSONP；失败返回 null）
const NEWS_POS = ['国产替代', '突破', '扩产', '涨价', '中标', '订单', '利好', '政策支持', '大基金', '受益', '景气度', '放量', '业绩预增', '回暖', '获批', '量产', '需求旺盛', '订单饱满', '增持', '回购', '创新高', '供不应求', '提价', '投产', '景气', '增长'];
const NEWS_NEG = ['制裁', '出口限制', '裁员', '降价', '库存高企', '业绩下滑', '减持', '解禁', '监管', '风险', '利空', '暴雷', '亏损', '下滑', '下调', '退市', '立案', '处罚', '跌停', '需求疲软', '过剩', '诉讼', '危机', '暴跌'];
function countHits(text, words) { let n = 0; for (const w of words) if (text.indexOf(w) >= 0) n++; return n; }
async function fetchNewsSentiment(keyword, limit) {
  keyword = keyword || '半导体设备';
  limit = limit || 20;
  const param = JSON.stringify({
    uid: '', keyword, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: limit, preTag: '', postTag: '' } },
  });
  const u = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(param)}`;
  const { text } = await withRetry(() => httpGet(u, EM_HEADERS));
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('新闻搜索返回异常');
  const json = JSON.parse(m[0]);
  const list = (json && json.result && json.result.cmsArticleWebOld) || [];
  if (!list.length) return null;

  const now = Date.now();
  let score = 0, pos = 0, neg = 0;
  const samples = [];
  for (const it of list) {
    const title = it.title || '';
    const full = title + (it.content ? ' ' + it.content.slice(0, 120) : '');
    const p = countHits(full, NEWS_POS);
    const n = countHits(full, NEWS_NEG);
    const s = p - n;
    if (s === 0) continue;
    // 时间衰减：半衰期 36 小时
    const t = it.date ? new Date(it.date.replace(' ', 'T') + (it.date.length <= 10 ? 'T00:00:00' : '')).getTime() : now;
    const hoursAgo = Math.max(0, (now - t) / 3600000);
    const w = Math.pow(0.5, hoursAgo / 36);
    score += s * w;
    if (s > 0) pos++; else neg++;
    if (samples.length < 5) samples.push((s > 0 ? '[+]' : '[-]') + title.slice(0, 40));
  }
  return { score: +score.toFixed(1), pos, neg, count: list.length, samples, available: true };
}

// 指数日K（东财，用于大盘趋势过滤；如沪深300 secid=1.000300）
async function fetchIndexKline(secid, limit) {
  limit = limit || 80;
  const u = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const { text } = await withRetry(() => httpGet(u, EM_HEADERS));
  const json = JSON.parse(text);
  const d = json && json.data;
  if (!d || !d.klines) throw new Error('指数K线返回异常');
  return d.klines.map((s) => {
    const a = s.split(',');
    return { date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4], volume: +a[5] || 0 };
  });
}

// 指数日K（腾讯备用源；东财接口偶发不可达/被网络策略拦截时使用）
// 腾讯指数代码与东财 secid 的对应关系
const INDEX_TENCENT_TC = {
  '1.000300': 'sh000300', '1.000001': 'sh000001', '1.000688': 'sh000688',
  '0.399001': 'sz399001', '0.399006': 'sz399006', '1.000905': 'sh000905',
};

async function fetchIndexKlineTencent(tc, limit) {
  limit = limit || 80;
  const u = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},day,,,${limit},qfq`;
  const { text } = await withRetry(() => httpGet(u));
  const json = JSON.parse(text);
  const node = json && json.data && json.data[tc];
  if (!node) throw new Error('腾讯指数K线返回结构异常: ' + tc);
  const arr = node.qfqday || node.day || [];
  return arr.map((r) => ({ date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], volume: +r[5] || 0 }));
}

/**
 * 指数日K（自动选源）：**东财 → 腾讯 → 新浪**（三级回退）
 * 背景：东财 push2his 常年 socket hang up；腾讯 web.ifzq 于 2026-09-16 被 WAF 拦截。
 * 新浪的 sh000300/sh000001/sh000688 等指数K线可用（T-1），作为最后兜底。
 * 返回 { klines, source, degraded, note? }
 */
async function fetchIndexKlineAuto(secid, limit) {
  limit = limit || 80;
  const tc = INDEX_TENCENT_TC[secid];
  const errs = [];
  try {
    const klines = await fetchIndexKline(secid, limit);
    return { klines, source: 'eastmoney', degraded: false };
  } catch (e) { errs.push('东财:' + errText(e)); }
  if (tc) {
    try {
      const klines = await fetchIndexKlineTencent(tc, limit);
      return { klines, source: 'tencent:' + tc, degraded: false, note: '东财不可达，已回退腾讯' };
    } catch (e) { errs.push('腾讯:' + errText(e)); }
    try {
      const sr = await fetchSinaKline(tc, limit);   // 注意：返回的是对象，需取 .klines
      return { klines: sr.klines, source: 'sina:' + tc, degraded: true, note: '东财与腾讯均不可用，已回退新浪(T-1)：' + errs.join(' | ') };
    } catch (e) { errs.push('新浪:' + errText(e)); }
  }
  throw new Error('所有指数数据源均不可用：' + errs.join(' | '));
}

// hhxg.top 日报快照：情绪面（赚钱效应/涨停跌停）+ 资金面（行业资金）+ 消息面（新闻摘要）
async function fetchHhxgSnapshot() {
  const u = 'https://hhxg.top/static/data/assistant/skill_snapshot.json';
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'hhxg-skill/1.0' } }));
  const j = JSON.parse(text);
  const m = j.market || {};
  const sectors = j.sectors || [];
  const strong = [];
  for (const grp of sectors) for (const s of (grp.strong || [])) strong.push(s.name);
  // 用同一套正负词表对新闻标题打分
  const titles = [...(j.focus_news || []), ...(j.macro_news || [])].map((n) => n.title || '');
  let newsScore = 0, newsPos = 0, newsNeg = 0;
  for (const t of titles) {
    const p = countHits(t, NEWS_POS), n = countHits(t, NEWS_NEG);
    if (p - n === 0) continue;
    newsScore += p - n; if (p - n > 0) newsPos++; else newsNeg++;
  }
  return {
    date: j.date,
    sentimentIndex: m.sentiment_index != null ? m.sentiment_index : null,
    sentimentLabel: m.sentiment_label || '',
    limitUp: m.limit_up != null ? m.limit_up : null,
    limitDown: m.limit_down != null ? m.limit_down : null,
    total: m.total || 0,
    strongSectors: strong,
    semiInStrong: strong.some((n) => n.indexOf('半导体') >= 0),
    hotThemes: (j.hot_themes || []).map((t) => t.name),
    newsScore, newsPos, newsNeg, newsCount: titles.length,
    aiSummary: j.ai_summary || null,
  };
}

// 美债10年期收益率（Yahoo ^TNX，全球定价之锚，对 A股科技/成长股估值压制显著）
async function fetchUs10y() {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=3mo';
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }));
  const j = JSON.parse(text);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('美债收益率返回异常');
  const meta = res.meta || {};
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : (closes.length ? closes[closes.length - 1] : null);
  const chg20 = closes.length > 20 ? (closes[closes.length - 1] - closes[closes.length - 21]) * 100 : null;   // 20交易日变化(bp)
  const chg60 = closes.length > 60 ? (closes[closes.length - 1] - closes[closes.length - 61]) * 100 : null;   // 60交易日变化(bp)
  return {
    price, chg20bp: chg20, chg60bp: chg60,
    high52: meta.fiftyTwoWeekHigh != null ? meta.fiftyTwoWeekHigh : null,
    low52: meta.fiftyTwoWeekLow != null ? meta.fiftyTwoWeekLow : null,
    date: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
  };
}

// 费城半导体指数 SOX（Yahoo；隔夜联动 A股半导体板块）
async function fetchSox() {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/%5ESOX?interval=1d&range=1mo';
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }));
  const j = JSON.parse(text);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('SOX返回异常');
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close || []).filter((c) => c != null);
  if (closes.length < 2) throw new Error('SOX数据不足');
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const chgPct = prev ? (price / prev - 1) * 100 : null;
  const chg20Pct = closes.length > 21 ? (price / closes[closes.length - 21] - 1) * 100 : null;
  return { price, chgPct, chg20Pct };
}

// 中国10年期国债收益率（中国货币网，JSON；方向比水平更关键）
async function fetchCn10y() {
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86400000); // 该接口仅提供近一个月历史
  const d = (x) => x.toISOString().slice(0, 10);
  const u = `https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/ClsYldCurvHis?lang=CN&reference=1,2,3&bondType=CYCC000&startDate=${d(start)}&endDate=${d(end)}&termId=1&pageNum=1&pageSize=60`;
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.chinamoney.com.cn/ags/ws/index.html' } }));
  const j = JSON.parse(text);
  const records = j.records || j.result || [];
  const vals = records
    .filter((r) => parseFloat(r.yearTermStr) === 10)
    .map((r) => ({ date: String(r.newDateValueCN || '').slice(0, 10), yield: parseFloat(r.maturityYieldStr) }))
    .filter((v) => !isNaN(v.yield));
  if (!vals.length) throw new Error('中债10Y数据为空');
  const price = vals[vals.length - 1].yield;
  const chg20 = vals.length > 1 ? (vals[vals.length - 1].yield - vals[0].yield) * 100 : null; // 近一个月变化(bp)
  return { price, chg20bp: chg20, date: vals[vals.length - 1].date };
}

// ---------- ETF 折溢价监控 ----------
// 基金净值（T-1，天天基金）。商品期货ETF 的实时 IOPV 无免费接口，用「T-1净值 × 期货篮子涨跌」估算盘中净值。
async function fetchFundNav(code) {
  const u = `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?FCODES=${code}&pageIndex=1&pageSize=1&plat=Android&deviceid=1&product=EFund&version=6.2.8&appType=ttjj`;
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }));
  const j = JSON.parse(text);
  const d = j && j.Datas && j.Datas[0];
  if (!d || !d.NAV) throw new Error('基金净值返回异常: ' + code);
  return { code, name: d.SHORTNAME, nav: parseFloat(d.NAV), navDate: d.PDATE };
}

// 郑商所能源化工期货主连（新浪返回 GBK，此处只取数字字段，无需解码中文）
const CHEM_SYMBOLS = [
  { sym: 'nf_TA0', name: 'PTA' }, { sym: 'nf_MA0', name: '甲醇' },
  { sym: 'nf_FG0', name: '玻璃' }, { sym: 'nf_SA0', name: '纯碱' },
  { sym: 'nf_PF0', name: '短纤' }, { sym: 'nf_SH0', name: '烧碱' },
  { sym: 'nf_PX0', name: '对二甲苯' },
];
async function fetchChemFutures() {
  const u = 'https://hq.sinajs.cn/list=' + CHEM_SYMBOLS.map((x) => x.sym).join(',');
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' } }));
  const out = [];
  for (const { sym, name } of CHEM_SYMBOLS) {
    const m = text.match(new RegExp('hq_str_' + sym + '="([^"]*)"'));
    if (!m) continue;
    const f = m[1].split(',');
    const last = parseFloat(f[8]);        // 最新价
    const prevSettle = parseFloat(f[10]); // 昨结算
    if (!isFinite(last) || !isFinite(prevSettle) || !prevSettle) continue;
    out.push({ name, last, prevSettle, chgPct: (last / prevSettle - 1) * 100 });
  }
  if (!out.length) throw new Error('化工品期货数据为空');
  const avgChgPct = out.reduce((a, b) => a + b.chgPct, 0) / out.length;
  return { items: out, avgChgPct };
}

// 估算盘中净值与折溢价率（%）。正数=溢价，负数=折价。
function estimatePremium(price, prevNav, basketChgPct) {
  const estNav = prevNav * (1 + basketChgPct / 100);
  return { estNav, premiumPct: (price / estNav - 1) * 100 };
}

// ---------------------------------------------------------------- Yahoo 历史序列（供学习器训练与实盘预测）

/** 拉 Yahoo 日线收盘序列 → [{date:'YYYY-MM-DD', close}] */
async function fetchYahooHistory(symbol, range) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range || '3y'}&interval=1d`;
  const { text } = await withRetry(() => httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }));
  const j = JSON.parse(text);
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('Yahoo 返回异常：' + symbol);
  const ts = res.timestamp || [];
  const closes = (res.indicators && res.indicators.quote && res.indicators.quote[0].close) || [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    out.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return out;
}

/**
 * 实盘预测所需的全局历史数据（带缓存）。
 * 返回 { indexKlines, soxSeries, us10ySeries, spxSeries }
 * 这三条海外序列是"费半/美债/标普"三个专家从"仅实盘"升级为"可训练"的关键。
 */
let _globalHistCache = null;
// ---------------------------------------------------------------- 海外隔夜数据的多源回退
//
// 背景（真实事故）：Yahoo 会限流（返回 HTML/429）。一旦限流，
// 费半/美债/标普三个数据源同时失效 → 21 个专家里 4 个全程弃权，
// 预测质量静默下降。这已经发生两次（一次在训练、一次在实盘）。
//
// 回退链：Yahoo（全历史） → 磁盘缓存（全历史） → 新浪（当日隔夜值，补齐最新一根）
// 新浪美股代码：费半 gb_$sox、标普 gb_inx、纳指 gb_ixic、道指 gb_dji

const SINA_US = { sox: 'gb_$sox', spx: 'gb_inx', ndx: 'gb_ixic', dji: 'gb_dji' };

/** 新浪美股/期货实时报价（GBK，但数字是 ASCII，可直接解析） */
async function fetchSinaUSQuote(sym) {
  const u = 'https://hq.sinajs.cn/list=' + sym;
  const { text } = await httpGet(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.sina.com.cn' } });
  const m = text.match(/"([^"]*)"/);
  if (!m) return null;
  const f = m[1].split(',');
  const price = parseFloat(f[1]);
  const chgPct = parseFloat(f[2]);
  const t = (f[3] || '').trim();               // 北京时间，如 2026-09-16 05:16:01
  if (!isFinite(price)) return null;
  // 北京时间凌晨对应的**美股交易日**是前一天（美股 9/15 收盘 ≈ 北京 9/16 05:16）
  let usDate = t.slice(0, 10);
  const hh = parseInt(t.slice(11, 13), 10);
  if (isFinite(hh) && hh < 8 && usDate) {
    const d = new Date(usDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    usDate = d.toISOString().slice(0, 10);
  }
  while (usDate) {                              // 回退到最近的工作日
    const dow = new Date(usDate + 'T00:00:00Z').getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    const d = new Date(usDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
    usDate = d.toISOString().slice(0, 10);
  }
  return { symbol: sym, price, chgPct: isFinite(chgPct) ? chgPct : null, beijingTime: t, usDate };
}

/** 海外历史序列的磁盘缓存（与 lib/dataset.js 共用同一份文件） */
function loadUsHistoryCache() {
  const cands = [
    path.join(__dirname, '..', 'data', 'us-history.json'),
    path.join(__dirname, '..', 'model', 'us-history.json'),
  ];
  for (const f of cands) {
    try { if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); if (j && j.sox && j.sox.length) return j; } } catch (e) { /* next */ }
  }
  return null;
}

/** 把最新一根隔夜 bar 并入历史序列（同日则覆盖，更新则追加） */
function topUpSeries(series, latest) {
  if (!latest || !latest.usDate || !(latest.price > 0)) return series || [];
  const out = (series || []).slice();
  const last = out[out.length - 1];
  if (!last || last.date < latest.usDate) out.push({ date: latest.usDate, close: latest.price });
  else if (last.date === latest.usDate) out[out.length - 1] = { date: latest.usDate, close: latest.price };
  return out;
}

async function fetchGlobalHistory(opts) {
  opts = opts || {};
  const ttl = opts.ttlMs != null ? opts.ttlMs : 30 * 60 * 1000;
  if (_globalHistCache && Date.now() - _globalHistCache.t < ttl) return _globalHistCache.v;
  const bars = opts.bars || 640;

  const [idx, soxR, tnxR, spxR, sinaSox, sinaSpx] = await Promise.allSettled([
    fetchIndexKlineAuto('1.000300', bars),
    fetchYahooHistory('^SOX', opts.range || '3y'),
    fetchYahooHistory('^TNX', opts.range || '3y'),
    fetchYahooHistory('^GSPC', opts.range || '3y'),
    fetchSinaUSQuote(SINA_US.sox),
    fetchSinaUSQuote(SINA_US.spx),
  ]);

  const cache = loadUsHistoryCache();
  const sources = {};
  const pick = (yahooRes, cacheKey) => {
    if (yahooRes.status === 'fulfilled' && yahooRes.value && yahooRes.value.length > 200) { sources[cacheKey] = 'yahoo'; return yahooRes.value; }
    if (cache && cache[cacheKey] && cache[cacheKey].length > 200) { sources[cacheKey] = 'cache@' + (cache.at || '?').slice(0, 10); return cache[cacheKey]; }
    return [];
  };
  let soxSeries = pick(soxR, 'sox');
  let us10ySeries = pick(tnxR, 'us10y');   // 注意：新浪无美债源，只能靠 Yahoo 或缓存
  let spxSeries = pick(spxR, 'spx');

  const sinaSoxV = sinaSox.status === 'fulfilled' ? sinaSox.value : null;
  const sinaSpxV = sinaSpx.status === 'fulfilled' ? sinaSpx.value : null;
  if (sinaSoxV) { soxSeries = topUpSeries(soxSeries, sinaSoxV); sources.sox += '+sina(' + sinaSoxV.usDate + ')'; }
  if (sinaSpxV) { spxSeries = topUpSeries(spxSeries, sinaSpxV); sources.spx += '+sina(' + sinaSpxV.usDate + ')'; }

  const v = {
    indexKlines: idx.status === 'fulfilled' ? idx.value.klines : [],
    indexSource: idx.status === 'fulfilled' ? idx.value.source : null,
    soxSeries, us10ySeries, spxSeries,
    sources,
    // us10y 没有实时源：若只能靠缓存，明确标注其陈旧程度
    us10yStaleDays: (() => {
      if (sources.us10y === 'yahoo' || !us10ySeries.length) return 0;
      const last = us10ySeries[us10ySeries.length - 1].date;
      return Math.max(0, Math.round((Date.now() - new Date(last + 'T00:00:00Z').getTime()) / 86400000));
    })(),
    fetchedAt: new Date().toISOString(),
  };
  _globalHistCache = { t: Date.now(), v };
  return v;
}

// 把任意 reject/throw 值归一成一句可读的失败原因。
// 背景：2026-09-16 公网探针里「指数:东财」连续失败 2 次但 lastErr 为空串，
// 原因是这里只读了 e.message；而 Node 的网络错误常常只带 code（ECONNRESET/ETIMEDOUT），
// 甚至可能是被 reject 的非 Error 值（undefined/字符串）。空原因会让健康面板无法定位问题。
function errText(e) {
  if (e == null) return '未知错误（空 reject）';
  if (typeof e === 'string') return e || '未知错误（空字符串）';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code && !String(e.message || '').includes(e.code)) parts.push(e.code);
  if (e.errno && e.errno !== e.code) parts.push('errno=' + e.errno);
  if (!parts.length) {
    try { parts.push(String(e)); } catch (_) { /* ignore */ }
  }
  const s = parts.filter(Boolean).join(' ');
  return s || ('未知错误（' + Object.prototype.toString.call(e) + '）');
}

// 给"还没有自登记"的取数函数统一包一层健康登记（有自登记的 kline 系列不重复包）
function wrapHealth(name, fn) {
  return async function wrapped() {
    const t0 = Date.now();
    try {
      const r = await fn.apply(null, arguments);
      healthRecord(name, true, Date.now() - t0);
      return r;
    } catch (e) {
      healthRecord(name, false, Date.now() - t0, errText(e));
      throw e;
    }
  };
}

module.exports = { errText, httpGet, httpPostJson, httpPostForm, fetchTencentKline, fetchMinute: wrapHealth('分时', fetchMinute), parseTencentQuote, calibrateKlines, fetchFundFlow: wrapHealth('主力资金流', fetchFundFlow), fetchMarketBreadth: wrapHealth('市场宽度', fetchMarketBreadth), fetchNewsSentiment: wrapHealth('新闻情感', fetchNewsSentiment), fetchIndexKline: wrapHealth('指数:东财', fetchIndexKline), fetchIndexKlineTencent: wrapHealth('指数:腾讯', fetchIndexKlineTencent), fetchIndexKlineAuto: wrapHealth('指数:自动选源', fetchIndexKlineAuto), INDEX_TENCENT_TC, fetchYahooHistory: wrapHealth('海外:Yahoo历史', fetchYahooHistory), fetchGlobalHistory, fetchSinaUSQuote: wrapHealth('海外:新浪实时', fetchSinaUSQuote), loadUsHistoryCache, topUpSeries, SINA_US, fetchSinaKline, fetchTencentKlineQfq, fetchTencentKlineNoAdj, healthSnapshot, healthRecord, throttle, fetchHhxgSnapshot: wrapHealth('情绪:hhxg', fetchHhxgSnapshot), fetchUs10y: wrapHealth('美债10Y(Yahoo)', fetchUs10y), fetchCn10y: wrapHealth('中债10Y', fetchCn10y), fetchSox: wrapHealth('费半(Yahoo)', fetchSox), fetchFundNav: wrapHealth('基金净值', fetchFundNav), fetchChemFutures: wrapHealth('化工期货篮子', fetchChemFutures), estimatePremium, tencentCode, CODE, SZ_CODE, NAME };
