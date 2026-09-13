'use strict';
/**
 * lib/live-predict.js —— 实盘预测（把学到的东西真正用起来）
 *
 * 这是「诚实性说明」里两个 🔴 高优先级下一步的落地：
 *   ① 把 Platt 标定后的概率接进预测  → 用户看到的不再是过度自信的原始概率
 *   ② 把 Hedge 学到的专家权重接进预测 → 不再用手工拍的权重
 *
 * 设计要点：
 *   - 与训练完全同源：专家提取用 lib/signals.js，聚合用 lib/rl.js，
 *     保证"回测出来的成绩"和"实盘用的东西"是同一个函数。
 *   - 同时输出 raw（原始）与 calibrated（可信）两个概率，绝不隐藏打折这件事。
 *   - 输出"是否达到交易阈值"，直接对齐含费回测选出的阈值 —— 让建议可执行。
 *
 * 零依赖，仅使用内置模块 + lib/。
 */

const rl = require('./rl');
const { extractVotes, EXPERT_LABEL, ALL_EXPERTS } = require('./signals');
const { computeAll } = require('./indicators');

/**
 * 构造与 train-rl.js 完全一致的 ctx（含海外序列的滞后对齐）
 * @param {Array} klines 标的日K
 * @param {Object} ext   外部数据：
 *        { indexKlines, soxSeries, us10ySeries, spxSeries }
 */
function buildLiveContext(klines, ext) {
  ext = ext || {};
  const ctx = {};

  // ---- 大盘：同日对齐 ----
  const idxK = ext.indexKlines || [];
  const n = klines.length;
  const indexAligned = new Array(n).fill(null);
  const indexMa60Aligned = new Array(n).fill(null);
  const indexAtrPctAligned = new Array(n).fill(null);
  if (idxK.length) {
    const ind = computeAll(idxK);
    const byDate = new Map();
    for (let i = 0; i < idxK.length; i++) byDate.set(idxK[i].date, { close: idxK[i].close, ma60: ind.ma60[i], atr: ind.atr[i] });
    for (let i = 0; i < n; i++) {
      let rec = byDate.get(klines[i].date);
      for (let back = 1; back <= 5 && !rec; back++) {
        const dd = klines[i - back] && klines[i - back].date;
        if (dd) rec = byDate.get(dd);
      }
      if (!rec) continue;
      indexAligned[i] = rec.close;
      indexMa60Aligned[i] = rec.ma60;
      indexAtrPctAligned[i] = (rec.atr != null && rec.close) ? rec.atr / rec.close * 100 : null;
    }
  }
  ctx.indexAligned = indexAligned;
  ctx.indexMa60Aligned = indexMa60Aligned;
  ctx.indexAtrPctAligned = indexAtrPctAligned;

  // ---- 海外/宏观：严格滞后 1 日 ----
  const lag = (series) => {
    const out = new Array(n).fill(null);
    if (!series || !series.length) return out;
    const dates = series.map((x) => x.date);
    const closes = series.map((x) => x.close);
    for (let i = 0; i < n; i++) {
      const d = klines[i].date;
      let lo = 0, hi = dates.length - 1, pos = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] < d) { pos = mid; lo = mid + 1; } else hi = mid - 1;
      }
      out[i] = pos >= 0 ? closes[pos] : null;
    }
    return out;
  };
  const derive = (aligned, momDays) => {
    const len = aligned.length;
    const chg = new Array(len).fill(null);
    const mom = new Array(len).fill(null);
    for (let i = 1; i < len; i++) {
      if (aligned[i] != null && aligned[i - 1] != null && aligned[i - 1] !== 0) {
        chg[i] = (aligned[i] - aligned[i - 1]) / aligned[i - 1] * 100;
      }
    }
    for (let i = 0; i < len; i++) {
      const j = i - (momDays || 20);
      if (aligned[i] != null && j >= 0 && aligned[j] != null && aligned[j] !== 0) {
        mom[i] = (aligned[i] - aligned[j]) / aligned[j] * 100;
      }
    }
    return { chg, mom };
  };
  const soxD = derive(lag(ext.soxSeries), 20);
  const tnxD = derive(lag(ext.us10ySeries), 20);
  const spxD = derive(lag(ext.spxSeries), 20);
  ctx.soxChgAligned = soxD.chg; ctx.soxMomAligned = soxD.mom;
  ctx.us10yChgAligned = tnxD.chg;
  ctx.spxChgAligned = spxD.chg;
  ctx._lag1 = true;   // 标记：已做滞后处理
  return ctx;
}

/**
 * 实盘预测主函数
 * @param {Array}  klines  标的日K（含最新一根）
 * @param {Object} ext     { indexKlines, soxSeries, us10ySeries, spxSeries }
 * @param {Object} state   rl 学习状态（rl.loadStateWithFallback()）
 * @param {Object} opts    { veto: {...} } 额外覆盖票（如实盘的 fund / senti）
 * @returns {Object} 各周期的原始概率 / 标定概率 / 是否达到交易阈值 / 专家贡献
 */
function predictLive(klines, ext, state, opts) {
  opts = opts || {};
  state = state || rl.initState();
  if (!klines || klines.length < 61) {
    return { ok: false, error: 'K线不足（需 ≥61 根）', horizons: {} };
  }
  const ind = computeAll(klines);
  const ctx = buildLiveContext(klines, ext);
  const i = klines.length - 1;

  const votes = extractVotes(klines, ind, i, ctx);

  // 仅实盘可用的专家（有当日数据时投票；否则保持睡觉）
  const liveVotes = opts.liveVotes || {};
  for (const k of ['fund', 'senti']) {
    if (liveVotes[k] != null) votes[k] = liveVotes[k];
  }

  const regime = rl.regimeOf({
    indexPrice: ctx.indexAligned[i],
    indexMa60: ctx.indexMa60Aligned[i],
    atrPct: ctx.indexAtpctSafe != null ? ctx.indexAtpctSafe
      : (ctx.indexAtrPctAligned[i] != null ? ctx.indexAtrPctAligned[i] : (ind.atr[i] ? ind.atr[i] / klines[i].close * 100 : null)),
  });

  const price = klines[i].close;
  const atr = ind.atr[i];
  const atrPct = atr && price ? atr / price * 100 : 0;
  const range = { d1: atrPct, d3: atrPct * 1.7, w1: atrPct * 2.6, m1: atrPct * 4.6 };

  const thresholds = (state.tradingPolicy && state.tradingPolicy.thresholds) || {};
  const horizons = {};
  for (const h of rl.HORIZONS) {
    const agg = rl.aggregate(state, h, votes, regime);
    const pRaw = agg.p;
    const pCal = rl.calibrate(state, h, pRaw);
    const upProb = Math.round(pCal * 100);
    const upProbRaw = Math.round(pRaw * 100);
    // 方向：用**标定后**的概率，且阈值与标定尺度一致
    const dir = upProb >= 55 ? '看涨' : upProb <= 45 ? '看跌' : '震荡';
    const expChg = +((pCal - 0.5) * 2 * range[h]).toFixed(2);
    const th = thresholds[h] ? thresholds[h].threshold : 0.55;
    const sig = pCal >= th ? 'buy' : (pCal <= 1 - th ? 'avoid' : 'neutral');
    horizons[h] = {
      label: rl.HORIZON_LABEL[h],
      dir, upProb, upProbRaw,
      probShift: upProb - upProbRaw,
      downProb: 100 - upProb,
      expectedChg: expChg,
      expectedPrice: +(price * (1 + expChg / 100)).toFixed(3),
      rangePct: +range[h].toFixed(1),
      priceLow: +(price * (1 - range[h] / 100)).toFixed(3),
      priceHigh: +(price * (1 + range[h] / 100)).toFixed(3),
      signal: sig,
      threshold: th,
      thresholdWinRate: thresholds[h] ? thresholds[h].winRate : null,
      thresholdExpRet: thresholds[h] ? thresholds[h].avgRetPct : null,
    };
  }

  // 专家贡献榜（谁在推动这个结论）
  const w = rl.effectiveWeights(state, 'w1', regime);
  const contributions = ALL_EXPERTS
    .filter((k) => votes[k] != null)
    .map((k) => ({
      expert: k, label: EXPERT_LABEL[k] || k,
      vote: +votes[k].toFixed(3),
      weight: +w[k].toFixed(4),
      contribution: +((w[k] * ((votes[k] + 1) / 2 - 0.5)) * 100).toFixed(3),
      trained: (state.horizons.w1.stats[k] || {}).n > 0,
    }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // 多周期共振信号（回测里胜率最高的下单方式）
  let confluence = null;
  const cp = state.confluencePolicy;
  if (cp && cp.need) {
    const met = cp.need.map((h) => ({
      horizon: h, label: rl.HORIZON_LABEL[h],
      upProb: horizons[h].upProb,
      threshold: +(((cp.thresholds && cp.thresholds[h]) || 0.55)).toFixed(2),
      pass: horizons[h].upProb / 100 >= ((cp.thresholds && cp.thresholds[h]) || 0.55),
    }));
    confluence = {
      need: cp.need, met, allPass: met.every((x) => x.pass),
      thresholds: Object.fromEntries(Object.keys(cp.thresholds || {}).map((k) => [k, +cp.thresholds[k].toFixed(2)])),
      backtest: { valWinRate: cp.valWinRate, valTrades: cp.valTrades, testWinRate: cp.testWinRate, testTrades: cp.testTrades, testExpectancy: cp.testExpectancy },
    };
  }

  const trained = state.trainedFrom || null;
  return {
    ok: true,
    confluence,
    price,
    atrPct: +atrPct.toFixed(2),
    regime,
    horizons,
    votes,
    contributions,
    summary: {
      dir: horizons.w1.dir,
      upProb: horizons.w1.upProb,
      upProbRaw: horizons.w1.upProbRaw,
      signal: horizons.w1.signal,
      threshold: horizons.w1.threshold,
      regime,
    },
    model: {
      trainedAt: state.updatedAt,
      lossType: state.lossType,
      eta: state.eta,
      universeSize: trained ? trained.universeSize : null,
      samples: trained ? (trained.trainSamples + trained.valSamples + trained.testSamples) : null,
      experts: ALL_EXPERTS.length,
      calibrated: !!(state.calibration && state.calibration.w1 && state.calibration.w1.fitted),
      tradingPolicy: state.tradingPolicy || null,
    },
  };
}

/**
 * 把实盘（标定后）预测覆盖到 Engine.predict 的输出上。
 * 保留原始手工模型结果到 *_rawModel 字段，**绝不隐藏"打折"这件事**。
 */
function applyLiveToPrediction(prediction, live) {
  if (!live || !live.ok || !prediction) return prediction;
  for (const h of rl.HORIZONS) {
    const lh = live.horizons[h];
    if (!lh || !prediction[h]) continue;
    prediction[h].dirRaw = prediction[h].dir;
    prediction[h].upProbRawModel = prediction[h].upProb;      // 手工模型的原始概率（对照）
    prediction[h].upProbRawLearned = lh.upProbRaw;            // 学习器的原始概率（标定前）
    prediction[h].dir = lh.dir;
    prediction[h].upProb = lh.upProb;
    prediction[h].downProb = lh.downProb;
    prediction[h].expectedChg = lh.expectedChg;
    prediction[h].expectedPrice = lh.expectedPrice;
    prediction[h].signal = lh.signal;
    prediction[h].threshold = lh.threshold;
    prediction[h].thresholdWinRate = lh.thresholdWinRate;
    prediction[h].calibrated = true;
  }
  prediction.live = live;
  prediction.summary = Object.assign({}, prediction.summary, {
    dir: live.summary.dir, upProb: live.summary.upProb, upProbRaw: live.summary.upProbRaw,
    calibrated: true, regime: live.regime, signal: live.summary.signal, threshold: live.summary.threshold,
  });
  return prediction;
}

/**
 * 一步到位：给定 K 线与外部数据，返回 { prediction, live }
 * @param {Object} Engine public/static/engine.js
 * @param {Object} Indicators public/static/indicators.js
 */
function predictWithEngine(Engine, Indicators, klines, quote, extras, state, hist, liveVotes) {
  const analysis = Engine.analyze(klines, Indicators.computeAll(klines), quote, Engine.DEFAULT_SETTINGS, extras || {});
  const prediction = Engine.predict(klines, analysis, extras || {});
  let live = null;
  try {
    live = predictLive(klines, hist || {}, state || rl.initState(), { liveVotes: liveVotes || {} });
    applyLiveToPrediction(prediction, live);
  } catch (e) {
    live = { ok: false, error: e.message };
  }
  return { analysis, prediction, live };
}

module.exports = { predictLive, buildLiveContext, applyLiveToPrediction, predictWithEngine };
