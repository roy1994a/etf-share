'use strict';
/**
 * 专家信号提取（Expert Panel）
 *
 * 把「预测模型」拆成一组可独立评估、可独立打分的"专家"。
 * 每个专家在给定 K 线位置 i 上，只输出一个 [-1, +1] 的方向票：
 *   +1 = 强烈看涨，-1 = 强烈看跌，0 = 中性
 *
 * 拆开的目的：这样才能知道"到底是谁在贡献准确率、谁在拖后腿"，
 * 才能用 Hedge / 指数权重（EXP 加权）算法在线学习每个专家的可信度。
 *
 * 可分两类：
 *   A. 历史可训练专家（仅用 K 线即可复现，可回测 250+ 天）
 *      mom / trend / rsiRev / macdDir / volS / indexS / rel
 *   B. 仅实盘可用专家（依赖当日外部数据，无历史序列，保留先验权重）
 *      soxS（费半）/ senti（情绪）/ fund（主力资金）/ macroS（宏观利率）
 */

const { clamp } = require('./indicators');

/** A 类：历史可回测专家 */
const TRAINABLE_EXPERTS = ['mom', 'trend', 'rsiRev', 'macdDir', 'volS', 'indexS', 'rel'];
/** B 类：仅实盘可用专家 */
const LIVE_EXPERTS = ['soxS', 'senti', 'fund', 'macroS'];
const ALL_EXPERTS = TRAINABLE_EXPERTS.concat(LIVE_EXPERTS);

const EXPERT_LABEL = {
  mom: '动量（20/60日）',
  trend: '趋势（均线结构）',
  rsiRev: 'RSI 超买超卖反转',
  macdDir: 'MACD 动能方向',
  volS: '量价配合',
  indexS: '大盘环境（沪深300 vs MA60）',
  rel: '相对强度（超额收益）',
  soxS: '费城半导体指数',
  senti: '市场情绪（赚钱效应）',
  fund: '主力资金流向',
  macroS: '宏观利率（美债/中债）',
};

function lastVal(arr, upto) {
  if (!arr) return null;
  const end = upto == null ? arr.length - 1 : Math.min(upto, arr.length - 1);
  for (let i = end; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

/**
 * 在 K 线位置 i 上提取所有专家的投票
 * @param {Array} klines 日K数组（前复权）
 * @param {Object} ind    computeAll 的结果
 * @param {Number} i      当前 bar 索引
 * @param {Object} ctx    { indexCloses, indexMa60, indexMa20 } —— 大盘序列（可选，按日期对齐）
 * @returns {Object} { mom: -1..1, trend: ..., ... }
 */
function extractVotes(klines, ind, i, ctx) {
  ctx = ctx || {};
  const v = {};
  const k = klines[i];
  if (!k) return v;
  const price = k.close;

  // ---- mom：20 日动量，除以 8% 归一 ----
  const c20 = i >= 20 ? klines[i - 20].close : null;
  const c60 = i >= 60 ? klines[i - 60].close : null;
  const mom20 = c20 ? (price - c20) / c20 * 100 : 0;
  const mom60 = c60 ? (price - c60) / c60 * 100 : 0;
  v.mom = clamp(mom20 / 8 + mom60 / 24, -1, 1);

  // ---- trend：均线结构 ----
  const m5 = lastVal(ind.ma5, i), m10 = lastVal(ind.ma10, i), m20 = lastVal(ind.ma20, i), m60 = lastVal(ind.ma60, i);
  let t = 0, tn = 0;
  if (m20 != null) { t += price > m20 ? 1 : -1; tn++; }
  if (m60 != null) { t += price > m60 ? 1 : -1; tn++; }
  if (m5 != null && m20 != null) { t += m5 > m20 ? 1 : -1; tn++; }
  if (m5 != null && m10 != null && m20 != null) {
    if (m5 > m10 && m10 > m20) t += 1.5;
    else if (m5 < m10 && m10 < m20) t -= 1.5;
    tn += 1.5;
  }
  v.trend = tn ? clamp(t / tn, -1, 1) : 0;

  // ---- rsiRev：RSI 超买超卖（反转逻辑）----
  const r6 = lastVal(ind.rsi6, i);
  let rv = 0;
  if (r6 != null) {
    if (r6 < 20) rv = 1;
    else if (r6 < 35) rv = 0.6;
    else if (r6 > 80) rv = -1;
    else if (r6 > 65) rv = -0.6;
  }
  v.rsiRev = rv;

  // ---- macdDir：MACD 动能 ----
  const dif = lastVal(ind.dif, i), dea = lastVal(ind.dea, i), macd = lastVal(ind.macd, i);
  let md = 0;
  if (dif != null && dea != null) md += dif > dea ? 1 : -1;
  if (macd != null) md += macd > 0 ? 1 : -1;
  v.macdDir = clamp(md / 2, -1, 1);

  // ---- volS：量价配合 ----
  const vol = k.volume || 0;
  const vma5 = lastVal(ind.volMa5, i);
  const prevClose = i > 0 ? klines[i - 1].close : price;
  const pct = prevClose ? (price - prevClose) / prevClose * 100 : 0;
  const vr = vma5 ? vol / vma5 : 1;
  if (vr > 1.3 && Math.abs(pct) > 0.5) v.volS = clamp(pct > 0 ? Math.min(vr / 2, 1.2) : -Math.min(vr / 2, 1.2), -1, 1);
  else if (vr > 1.3) v.volS = pct > 0 ? 0.3 : -0.3;
  else if (vr < 0.7) v.volS = pct > 0 ? 0.15 : -0.15;
  else v.volS = 0;

  // ---- indexS：大盘环境 ----
  const idx = ctx.indexAligned ? ctx.indexAligned[i] : null;
  const idxMa60 = ctx.indexMa60Aligned ? ctx.indexMa60Aligned[i] : null;
  v.indexS = (idx != null && idxMa60 != null) ? (idx >= idxMa60 ? 1 : -1) : 0;

  // ---- rel：20 日相对强度（超额收益）----
  if (idx != null && ctx.indexAligned && i >= 20 && ctx.indexAligned[i - 20] != null) {
    const stockRet = c20 ? (price - c20) / c20 * 100 : 0;
    const idxRet = (idx - ctx.indexAligned[i - 20]) / ctx.indexAligned[i - 20] * 100;
    v.rel = clamp((stockRet - idxRet) / 6, -1, 1);
  } else v.rel = 0;

  return v;
}

/** 把某专家的连续票 [-1,1] 转成 P(up) ∈ [0,1]（Hedge 的预测分布） */
function voteToProb(x) { return clamp((x + 1) / 2, 0, 1); }

/** 专家面板汇总：把投票对象转成每一维度可读的表格数据 */
function summarizeVotes(votes) {
  return ALL_EXPERTS.filter((k) => votes[k] !== undefined).map((k) => ({
    expert: k, label: EXPERT_LABEL[k] || k, vote: votes[k],
    dir: votes[k] > 0.15 ? '看涨' : votes[k] < -0.15 ? '看跌' : '中性',
  }));
}

module.exports = { TRAINABLE_EXPERTS, LIVE_EXPERTS, ALL_EXPERTS, EXPERT_LABEL, extractVotes, voteToProb, summarizeVotes };
