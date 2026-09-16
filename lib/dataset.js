'use strict';
/**
 * lib/dataset.js —— 训练/回测共用数据层
 *
 * 抽出来的唯一目的：让 train-rl.js（正式训练）和 ablation.js（消融实验）
 * **走完全同一条代码路径**。否则"扩样本带来了提升"这个结论就无法排除
 * "两份实现的口径差异"这种解释 —— 那是自欺欺人。
 *
 * 零依赖，仅使用内置模块 + lib/。
 */

const fs = require('fs');
const path = require('path');
const market = require('./market');
const { computeAll } = require('./indicators');
const { extractVotes } = require('./signals');
const rl = require('./rl');

// ------------------------------------------------------------ 标的池定义

/** v2 全量池：宽基与风格 */
const BROAD = ['510300', '510500', '588000', '159915', '512100', '510880'];
/** 半导体与科技 */
const TECH = ['159516', '512480', '512760', '588200', '515000', '512720', '159819',
  '688981', '688012', '002371', '688256', '688041', '603986', '688008', '688783', '300475', '002156',
  '688432', '000977'];
/** 行业 */
const SECTOR = ['512010', '512170', '512400', '512660', '512800', '512880', '512690',
  '515030', '515790', '159611', '512200', '516950', '512980', '159869', '159981',
  '518880', '513050', '513100', '159941', '512070', '516110', '159825'];
/** 本会话咨询过的个股/杂项 */
const EXTRA = ['002470', '159918'];

const UNIVERSE_V2 = BROAD.concat(TECH, SECTOR, EXTRA);

/** v1 原始池（17 个）—— 消融实验的对照组必须与当时完全一致 */
const UNIVERSE_V1 = [
  '159516', '512010', '512400', '512660', '688981', '688012', '002371', '688256',
  '688041', '603986', '688008', '688783', '300475', '159981', '002156', '002470', '159918',
];

/** v1 的 11 个专家 —— 消融实验的对照组特征集 */
const EXPERTS_V1 = ['mom', 'trend', 'rsiRev', 'macdDir', 'volS', 'indexS', 'rel', 'soxS', 'senti', 'fund', 'macroS'];

const BARS_V1 = 400;
const BARS_V2 = 640;

// ------------------------------------------------------------ Yahoo 序列

async function fetchYahooSeries(symbol, range) {
  return market.fetchYahooHistory(symbol, range || '3y');
}

/**
 * 把海外序列按「日期严格小于 A股交易日」对齐。
 * ⚠️ 防未来函数的关键：A股 T 日收盘决策时，美股 T 日收盘发生在之后。
 */
function alignLag1(stockKlines, series) {
  const out = new Array(stockKlines.length).fill(null);
  if (!series || !series.length) return out;
  const dates = series.map((x) => x.date);
  const closes = series.map((x) => x.close);
  for (let i = 0; i < stockKlines.length; i++) {
    const d = stockKlines[i].date;
    let lo = 0, hi = dates.length - 1, pos = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < d) { pos = mid; lo = mid + 1; } else hi = mid - 1;
    }
    out[i] = pos >= 0 ? closes[pos] : null;
  }
  return out;
}

/** 由对齐后的收盘序列派生：当日涨跌%、N 日动量% */
function deriveSeries(aligned, momDays) {
  const n = aligned.length;
  const chg = new Array(n).fill(null);
  const mom = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    if (aligned[i] != null && aligned[i - 1] != null && aligned[i - 1] !== 0) {
      chg[i] = (aligned[i] - aligned[i - 1]) / aligned[i - 1] * 100;
    }
  }
  for (let i = 0; i < n; i++) {
    const j = i - (momDays || 20);
    if (aligned[i] != null && j >= 0 && aligned[j] != null && aligned[j] !== 0) {
      mom[i] = (aligned[i] - aligned[j]) / aligned[j] * 100;
    }
  }
  return { chg, mom };
}

// ------------------------------------------------------------ 上下文

/** 把指数序列按日期对齐到个股 K 线（A股同交易日，可同日对齐） */
function buildIndexContext(stockKlines, indexKlines) {
  const n = stockKlines.length;
  const indexAligned = new Array(n).fill(null);
  const indexMa60Aligned = new Array(n).fill(null);
  const indexAtrPctAligned = new Array(n).fill(null);
  if (!indexKlines || !indexKlines.length) return { indexAligned, indexMa60Aligned, indexAtrPctAligned };
  const ind = computeAll(indexKlines);
  const byDate = new Map();
  for (let i = 0; i < indexKlines.length; i++) {
    byDate.set(indexKlines[i].date, { close: indexKlines[i].close, ma60: ind.ma60[i], atr: ind.atr[i] });
  }
  for (let i = 0; i < n; i++) {
    let rec = byDate.get(stockKlines[i].date);
    for (let back = 1; back <= 5 && !rec; back++) {
      const dd = stockKlines[i - back] && stockKlines[i - back].date;
      if (dd) rec = byDate.get(dd);
    }
    if (!rec) continue;
    indexAligned[i] = rec.close;
    indexMa60Aligned[i] = rec.ma60;
    indexAtrPctAligned[i] = (rec.atr != null && rec.close) ? rec.atr / rec.close * 100 : null;
  }
  return { indexAligned, indexMa60Aligned, indexAtrPctAligned };
}

/** 组装单个标的的完整运行上下文 */
function buildRecord(code, klines, indexKlines, yahoo) {
  const ind = computeAll(klines);
  const idx = buildIndexContext(klines, indexKlines);
  const soxD = deriveSeries(alignLag1(klines, yahoo.sox), 20);
  const tnxD = deriveSeries(alignLag1(klines, yahoo.us10y), 20);
  const spxD = deriveSeries(alignLag1(klines, yahoo.spx), 20);
  return {
    code, klines, ind,
    ctx: {
      indexAligned: idx.indexAligned,
      indexMa60Aligned: idx.indexMa60Aligned,
      indexAtrPctAligned: idx.indexAtrPctAligned,
      soxChgAligned: soxD.chg, soxMomAligned: soxD.mom,
      us10yChgAligned: tnxD.chg, spxChgAligned: spxD.chg,
    },
  };
}

// ------------------------------------------------------------ 拉取

// ---------------------------------------------------------------- 海外序列的磁盘缓存
//
// 为什么必须有：Yahoo 会限流（实测训练多次后返回 429/403），一旦限流，
// fetchDataset 会**静默**拿到空序列 —— 21 个专家里有 4 个（费半/费半动量/美债/标普）
// 将全程弃权，训练出一个"看起来正常但实际残废"的模型。
// 这种事已经真实发生过一次，所以：
//   1) 海外序列落盘缓存，训练默认读缓存（可复现、不受限流影响）
//   2) 缓存与实时都拿不到时，**大声报错**并标记 degraded，不再静默继续
const HISTORY_CACHE_PATHS = [
  path.join(__dirname, '..', 'data', 'us-history.json'),
  path.join(__dirname, '..', 'model', 'us-history.json'),
];

function loadHistoryCache() {
  for (const f of HISTORY_CACHE_PATHS) {
    try {
      if (!fs.existsSync(f)) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.sox && j.sox.length) return j;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

function saveHistoryCache(yahoo) {
  const payload = Object.assign({ at: new Date().toISOString() }, yahoo);
  for (const f of HISTORY_CACHE_PATHS) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(payload), 'utf8');
    } catch (e) { /* 缓存写失败不影响训练 */ }
  }
}

/** 海外序列是否完整（4 个专家都依赖它） */
function historyComplete(yahoo) {
  return !!(yahoo && yahoo.sox && yahoo.sox.length > 200
    && yahoo.us10y && yahoo.us10y.length > 200
    && yahoo.spx && yahoo.spx.length > 200);
}

/**
 * 拉取全量数据集（一次拉满 640 根 + 全部海外序列）
 * @param {Object} opts { codes, bars, yahooRange, index, onProgress, refreshHistory }
 */
async function fetchDataset(opts) {
  opts = opts || {};
  const codes = opts.codes || UNIVERSE_V2;
  const bars = opts.bars || BARS_V2;
  const yahooRange = opts.yahooRange || '3y';

  let indexKlines = [];
  let indexSource = null;
  try {
    const r = await market.fetchIndexKlineAuto(opts.index || '1.000300', bars);
    indexKlines = r.klines;
    indexSource = r.source;
  } catch (e) { /* 大盘专家退化为中性 */ }

  // 海外序列：默认优先用磁盘缓存（可复现、不怕限流）；--refresh-history 时才强拉
  let yahoo = {};
  let historySource = null;
  const cached = loadHistoryCache();
  if (cached && !opts.refreshHistory) {
    yahoo = { sox: cached.sox, us10y: cached.us10y, spx: cached.spx };
    historySource = 'cache@' + (cached.at || '?');
  } else {
    for (const [key, sym] of [['sox', '^SOX'], ['us10y', '^TNX'], ['spx', '^GSPC']]) {
      try {
        yahoo[key] = await fetchYahooSeries(sym, yahooRange);
        await new Promise((r) => setTimeout(r, 400));
      } catch (e) {
        if (opts.onHistoryError) opts.onHistoryError(key, e.message);
      }
    }
    if (historyComplete(yahoo)) { saveHistoryCache(yahoo); historySource = 'live'; }
    else if (cached) {
      // 实时拉取不完整 → 回退缓存（并保留已有的部分）
      yahoo = { sox: yahoo.sox || cached.sox, us10y: yahoo.us10y || cached.us10y, spx: yahoo.spx || cached.spx };
      historySource = 'cache-fallback@' + (cached.at || '?');
    }
  }
  const degraded = !historyComplete(yahoo);

  const records = [];
  let failed = 0, done = 0;
  for (const code of codes) {
    try {
      const { klines } = await market.fetchTencentKline('day', bars, code);
      if (!klines || klines.length < 90) { failed++; continue; }
      records.push(buildRecord(code, klines, indexKlines, yahoo));
      done++;
      if (opts.onProgress) opts.onProgress(done, codes.length, code);
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) { failed++; }
  }
  return { records, yahoo, indexKlines, indexSource, failed, requested: codes.length, historySource, degraded };
}

// ------------------------------------------------------------ 事件流

/**
 * 生成事件流：每个 (标的, 日期, 周期) 一条
 * @param {Array} records  fetchDataset 的输出
 * @param {Array} experts  参与投票的专家（默认全部 21 个）
 */
function buildEvents(records, experts, opts) {
  opts = opts || {};
  const exp = experts || null;
  const execLag = opts.execLag || 0;   // 0 = 当日收盘成交（旧口径）；1 = 次日开盘成交（实盘口径）
  const events = [];
  for (const rec of records) {
    const { code, klines, ind, ctx } = rec;
    for (let i = 60; i < klines.length - 1; i++) {
      let votes = extractVotes(klines, ind, i, ctx);
      if (!votes || Object.keys(votes).length === 0) continue;
      if (exp) {
        const filtered = {};
        for (const k of exp) if (votes[k] != null) filtered[k] = votes[k];
        votes = filtered;
      }
      const price = klines[i].close;
      if (!(price > 0)) continue;
      const regime = rl.regimeOf({
        indexPrice: ctx.indexAligned[i],
        indexMa60: ctx.indexMa60Aligned[i],
        atrPct: (ctx.indexAtrPctAligned[i] != null)
          ? ctx.indexAtrPctAligned[i]
          : (ind.atr[i] ? ind.atr[i] / price * 100 : null),
      });
      // 实盘成交价：execLag=1 时用次日 open（买不到则退化为次日 close）
      let entryDate = klines[i].date, entryPrice = price;
      if (execLag > 0 && i + execLag < klines.length) {
        const eb = klines[i + execLag];
        entryDate = eb.date;
        entryPrice = (eb.open != null && eb.open > 0) ? eb.open : eb.close;
      }
      if (!(entryPrice > 0)) continue;
      for (const h of rl.HORIZONS) {
        const j = i + rl.HORIZON_DAYS[h];
        if (j >= klines.length) continue;
        const fc = klines[j].close;
        // fwdRetPct 始终以「实际成交价」为基准，这样才是可执行收益
        const fwd = (fc - entryPrice) / entryPrice * 100;
        events.push({
          date: klines[i].date, code, i, horizon: h, votes, regime, price,
          entryDate, entryPrice,
          futureClose: fc,
          y: fc >= entryPrice ? 1 : 0,
          fwdRetPct: +fwd.toFixed(4),
        });
      }
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.code < b.code ? -1 : 1)));
  return events;
}

/** 按"保留最近 N 根日K"截断事件（模拟历史长度更短的数据集） */
function truncateByBars(events, records, keepBars) {
  const firstDate = {};
  for (const r of records) {
    const n = r.klines.length;
    const startIdx = Math.max(0, n - keepBars);
    firstDate[r.code] = r.klines[startIdx].date;
  }
  return events.filter((e) => !firstDate[e.code] || e.date >= firstDate[e.code]);
}

/**
 * 数据体检：借鉴 sector_rotation_system 的 _validate_data_quality，
 * 但只报告不阻断 —— 训练前先知道数据里有多少脏东西。
 */
/**
 * 停牌缺口扫描：拿真实交易日历比对，数「相邻两根K线之间少了几个交易日」。
 * 与假期无关（春节/国庆在日历里本来就不是交易日），因此比「自然日间隔>N天」可靠。
 * 返回 { segments:[{from,to,missing}], maxMissing, total }
 * 供 auditKlines（训练前体检）与 server.js（实盘行动卡）共用同一套判定。
 */
function suspensionGaps(klines, cal, minMissing) {
  const min = minMissing == null ? 3 : minMissing;
  const segments = [];
  if (!Array.isArray(klines) || klines.length < 2 || !Array.isArray(cal) || !cal.length) {
    return { segments, maxMissing: 0, total: 0 };
  }
  const idx = new Map();
  for (let i = 0; i < cal.length; i++) idx.set(cal[i], i);
  const dates = cal.slice().sort();
  const posOf = (d) => {
    if (idx.has(d)) return idx.get(d);
    let lo = 0, hi = dates.length - 1, a = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { a = m; lo = m + 1; } else hi = m - 1; }
    return a;
  };
  let maxMissing = 0, total = 0;
  for (let i = 1; i < klines.length; i++) {
    const a = posOf(klines[i - 1].date), b = posOf(klines[i].date);
    if (a < 0 || b < 0 || b <= a) continue;
    const missing = b - a - 1;
    if (missing >= min) {
      segments.push({ from: klines[i - 1].date, to: klines[i].date, missing });
      total += missing;
      if (missing > maxMissing) maxMissing = missing;
    }
  }
  return { segments, maxMissing, total };
}

function auditKlines(records, refDates) {
  // 涨跌停规则：科创板/创业板股票及其跟踪 ETF 为 20%，其余 10%。
  // （588xxx 科创ETF、159915 创业板ETF 等跟随 20% 规则；这是常见误判点）
  const limitOf = (code) => {
    const c = String(code);
    if (/^(688|300)/.test(c)) return 20;              // 科创板 / 创业板 股票
    if (/^588/.test(c)) return 20;                     // 科创板 ETF
    if (/^(159915|159952|159949|159948)$/.test(c)) return 20;  // 创业板 ETF
    return 10;
  };
  // 停牌检测：早期实现只按「相邻K线间隔 > 20 个自然日」判断，这会漏掉 10 个交易日左右的停牌。
  // 实例：有研硅(688432) 2026-08-31~09-11 停牌，8/28 -> 9/14 间隔 17 个自然日，
  // 低于 20 天线因而**静默通过**审计；但模型会把这两天当成相邻交易日，
  // 所有动量/波动率/regime 指标全部失真。
  // 正确做法：拿真实交易日历（沪深300指数K线）比对，数「中间少了几个交易日」，与假期无关。
  const cal = Array.isArray(refDates) && refDates.length ? refDates.slice().sort() : null;
  const rows = [];
  let totalBadPrice = 0, totalLimit = 0, totalGap = 0, totalDup = 0, totalSuspend = 0;
  for (const r of records) {
    const ks = r.klines || [];
    let badPrice = 0, overLimit = 0, gap = 0, dup = 0, maxGap = 0;
    const L = limitOf(r.code);
    for (let i = 0; i < ks.length; i++) {
      const k = ks[i];
      if (!(k.close > 0) || !(k.high > 0) || !(k.low > 0)) badPrice++;
      if (i > 0) {
        const pc = ks[i - 1].close;
        if (ks[i].date <= ks[i - 1].date) dup++;
        if (pc > 0) {
          const pct = Math.abs((k.close - pc) / pc * 100);
          if (pct > L + 0.5) overLimit++;
        }
        const d1 = new Date(ks[i - 1].date + 'T00:00:00Z').getTime();
        const d2 = new Date(k.date + 'T00:00:00Z').getTime();
        const days = Math.round((d2 - d1) / 86400000);
        if (days > 20) { gap++; if (days > maxGap) maxGap = days; }
      }
    }
    const sg = suspensionGaps(ks, cal);
    totalBadPrice += badPrice; totalLimit += overLimit; totalGap += gap; totalDup += dup; totalSuspend += sg.segments.length;
    rows.push({ code: r.code, bars: ks.length, first: ks[0] ? ks[0].date : null, last: ks.length ? ks[ks.length - 1].date : null,
      badPrice, overLimit, gap, maxGapDays: maxGap, dup,
      suspend: sg.segments.length, maxMissingDays: sg.maxMissing, suspendSegments: sg.segments });
  }
  return {
    rows,
    summary: { instruments: rows.length, badPrice: totalBadPrice, overLimit: totalLimit, gap: totalGap, dup: totalDup, suspend: totalSuspend },
    flags: rows.filter((x) => x.badPrice || x.overLimit || x.gap || x.dup || x.suspend),
    suspendFlags: rows.filter((x) => x.suspend),
  };
}

module.exports = {
  UNIVERSE_V1, UNIVERSE_V2, EXPERTS_V1, BARS_V1, BARS_V2,
  auditKlines, suspensionGaps,
  BROAD, TECH, SECTOR, EXTRA,
  fetchYahooSeries, alignLag1, deriveSeries, buildIndexContext, buildRecord,
  fetchDataset, buildEvents, truncateByBars,
  loadHistoryCache, saveHistoryCache, historyComplete, HISTORY_CACHE_PATHS,
};
