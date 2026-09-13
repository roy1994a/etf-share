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

const market = require('./market');
const { computeAll } = require('./indicators');
const { extractVotes } = require('./signals');
const rl = require('./rl');

// ------------------------------------------------------------ 标的池定义

/** v2 全量池：宽基与风格 */
const BROAD = ['510300', '510500', '588000', '159915', '512100', '510880'];
/** 半导体与科技 */
const TECH = ['159516', '512480', '512760', '588200', '515000', '512720', '159819',
  '688981', '688012', '002371', '688256', '688041', '603986', '688008', '688783', '300475', '002156'];
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

/**
 * 拉取全量数据集（一次拉满 640 根 + 全部海外序列）
 * @param {Object} opts { codes, bars, yahooRange, index, onProgress }
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

  const yahoo = {};
  for (const [key, sym] of [['sox', '^SOX'], ['us10y', '^TNX'], ['spx', '^GSPC']]) {
    try {
      yahoo[key] = await fetchYahooSeries(sym, yahooRange);
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) { /* 缺该序列则由 signals 退化为中性 */ }
  }

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
  return { records, yahoo, indexKlines, indexSource, failed, requested: codes.length };
}

// ------------------------------------------------------------ 事件流

/**
 * 生成事件流：每个 (标的, 日期, 周期) 一条
 * @param {Array} records  fetchDataset 的输出
 * @param {Array} experts  参与投票的专家（默认全部 21 个）
 */
function buildEvents(records, experts) {
  const exp = experts || null;
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
      for (const h of rl.HORIZONS) {
        const j = i + rl.HORIZON_DAYS[h];
        if (j >= klines.length) continue;
        const fc = klines[j].close;
        events.push({
          date: klines[i].date, code, i, horizon: h, votes, regime, price,
          futureClose: fc,
          y: fc >= price ? 1 : 0,
          fwdRetPct: +((fc - price) / price * 100).toFixed(4),
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

module.exports = {
  UNIVERSE_V1, UNIVERSE_V2, EXPERTS_V1, BARS_V1, BARS_V2,
  BROAD, TECH, SECTOR, EXTRA,
  fetchYahooSeries, alignLag1, deriveSeries, buildIndexContext, buildRecord,
  fetchDataset, buildEvents, truncateByBars,
};
