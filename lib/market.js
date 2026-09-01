/**
 * 行情数据模块（零依赖，仅用 Node 内置模块）
 * 提供：腾讯行情 K 线（日/周/月）+ 实时 qt、分时、K线校准
 * 供 server.js / daily-report.js / monitor.js 复用。
 */
'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');

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
async function fetchTencentKline(period, limit, code) {
  const tc = tencentCode(code);
  const p = { day: 'day', week: 'week', month: 'month' }[period] || 'day';
  const u = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tc},${p},,,${limit},qfq`;
  const { text } = await httpGet(u);
  const json = JSON.parse(text);
  const node = json && json.data && json.data[tc];
  if (!node) throw new Error('腾讯K线返回结构异常: ' + tc);
  const key = 'qfq' + p;
  const arr = node[key] || node[p] || [];
  const klines = arr.map((r) => ({
    date: r[0], open: parseFloat(r[1]), close: parseFloat(r[2]),
    high: parseFloat(r[3]), low: parseFloat(r[4]), volume: parseFloat(r[5]) || 0,
  }));
  let quote = null;
  if (node.qt && Array.isArray(node.qt[tc])) quote = parseTencentQuote(node.qt[tc]);
  return { klines, quote };
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

module.exports = { httpGet, httpPostJson, httpPostForm, fetchTencentKline, fetchMinute, parseTencentQuote, calibrateKlines, fetchFundFlow, fetchMarketBreadth, fetchNewsSentiment, fetchIndexKline, fetchHhxgSnapshot, fetchUs10y, fetchCn10y, fetchSox, tencentCode, CODE, SZ_CODE, NAME };
