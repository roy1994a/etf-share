'use strict';
/**
 * 专家信号提取（Expert Panel）
 *
 * 把「预测模型」拆成一组可独立评估、可独立打分的"专家"。
 * 每个专家在给定 K 线位置 i 上，只输出一个 [-1, +1] 的方向票：
 *   +1 = 强烈看涨，-1 = 强烈看跌，0 = 中性（弃权）
 *
 * 拆开的目的：这样才能知道"到底是谁在贡献准确率、谁在拖后腿"，
 * 才能用 Hedge / 指数权重（EXP 加权）算法在线学习每个专家的可信度。
 *
 * ── 专家清单（21 个）────────────────────────────────────────────
 * A. 标的自身·K线可训练（12）
 *    mom / mom5 / trend / rsiRev / macdDir / kdj / volS / obv / mfi / boll / closePos / rangePos
 * B. 大盘环境·可训练（3）
 *    indexS / idxMom / rel
 * C. 海外与宏观·可训练（4，需 Yahoo 历史序列，严格滞后一日对齐）
 *    soxS / soxMom / us10y / spxS
 * D. 仅实盘可用（2，依赖当日外部数据，无历史序列，保留先验权重）
 *    fund / senti
 *
 * ⚠️ 关于 C 类的滞后对齐（防未来函数）：A股在 T 日收盘时决策，
 * 美股 T 日收盘发生在 A股 T 日收盘**之后**，因此 T 日决策只能用
 * 最新一个「日期 < T」的美股收盘。train-rl.js 的 alignSeriesLag1 负责这件事。
 * 若不这样处理，回测准确率会被凭空抬高 —— 这是最隐蔽也最致命的偏差。
 */

const { clamp } = require('./indicators');

/** A 类：标的自身 K 线可训练专家 */
const SELF_EXPERTS = ['mom', 'mom5', 'trend', 'rsiRev', 'macdDir', 'kdj', 'volS', 'obv', 'mfi', 'boll', 'closePos', 'rangePos'];
/** B 类：大盘环境可训练专家 */
const INDEX_EXPERTS = ['indexS', 'idxMom', 'rel'];
/** C 类：海外/宏观可训练专家（需外部历史序列） */
const GLOBAL_EXPERTS = ['soxS', 'soxMom', 'us10y', 'spxS'];
/** D 类：仅实盘可用（无历史序列） */
const LIVE_EXPERTS = ['fund', 'senti'];

const TRAINABLE_EXPERTS = SELF_EXPERTS.concat(INDEX_EXPERTS, GLOBAL_EXPERTS);
const ALL_EXPERTS = TRAINABLE_EXPERTS.concat(LIVE_EXPERTS);

const EXPERT_LABEL = {
  mom: '动量（20/60日）',
  mom5: '短期动量（5日）',
  trend: '趋势（均线结构）',
  rsiRev: 'RSI 超买超卖反转',
  macdDir: 'MACD 动能方向',
  kdj: 'KDJ 交叉与极值',
  volS: '量价配合',
  obv: 'OBV 能量潮斜率',
  mfi: 'MFI 资金流量',
  boll: '布林带位置反转',
  closePos: '收盘强度（日内位置）',
  rangePos: '20日高低点位置',
  indexS: '大盘环境（沪深300 vs MA60）',
  idxMom: '大盘动量（沪深300 20日）',
  rel: '相对强度（超额收益）',
  soxS: '费城半导体指数（隔夜）',
  soxMom: '费半动量（20日）',
  us10y: '美债10Y 变化（宏观利率）',
  spxS: '标普500（隔夜）',
  fund: '主力资金流向',
  senti: '市场情绪（赚钱效应）',
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
 * @param {Object} ctx    {
 *                          indexAligned, indexMa60Aligned,          // 大盘（与 klines 同日期对齐）
 *                          soxChgAligned, soxMomAligned,            // 费半（已滞后1日对齐）
 *                          us10yChgAligned, spxChgAligned           // 美债/标普（已滞后1日对齐）
 *                        }
 * @returns {Object} { mom: -1..1, ... }
 */
function extractVotes(klines, ind, i, ctx) {
  ctx = ctx || {};
  const v = {};
  const k = klines[i];
  if (!k) return v;
  const price = k.close;

  // ---------- A. 标的自身 ----------

  // mom：20/60 日动量
  const c5 = i >= 5 ? klines[i - 5].close : null;
  const c20 = i >= 20 ? klines[i - 20].close : null;
  const c60 = i >= 60 ? klines[i - 60].close : null;
  const mom20 = c20 ? (price - c20) / c20 * 100 : 0;
  const mom60 = c60 ? (price - c60) / c60 * 100 : 0;
  v.mom = clamp(mom20 / 8 + mom60 / 24, -1, 1);

  // mom5：5 日动量（短线）
  v.mom5 = c5 ? clamp((price - c5) / c5 * 100 / 4, -1, 1) : 0;

  // trend：均线结构
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

  // rsiRev：RSI6 超买超卖（反转逻辑）
  const r6 = lastVal(ind.rsi6, i);
  let rv = 0;
  if (r6 != null) {
    if (r6 < 20) rv = 1;
    else if (r6 < 35) rv = 0.6;
    else if (r6 > 80) rv = -1;
    else if (r6 > 65) rv = -0.6;
  }
  v.rsiRev = rv;

  // macdDir：MACD 动能
  const dif = lastVal(ind.dif, i), dea = lastVal(ind.dea, i), macd = lastVal(ind.macd, i);
  let md = 0;
  if (dif != null && dea != null) md += dif > dea ? 1 : -1;
  if (macd != null) md += macd > 0 ? 1 : -1;
  v.macdDir = clamp(md / 2, -1, 1);

  // kdj：KDJ 金叉/死叉 + J 值极值
  const kk = lastVal(ind.k, i), dd = lastVal(ind.d, i), jj = lastVal(ind.j, i);
  const kPrev = i > 0 ? ind.k[i - 1] : null, dPrev = i > 0 ? ind.d[i - 1] : null;
  let kv = 0;
  if (kk != null && dd != null) {
    if (kPrev != null && dPrev != null && kk > dd && kPrev <= dPrev) kv = 1;
    else if (kPrev != null && dPrev != null && kk < dd && kPrev >= dPrev) kv = -1;
    else kv = kk > dd ? 0.3 : -0.3;
  }
  if (jj != null) {
    if (jj < 10) kv = Math.max(kv, 0.8);
    else if (jj > 90) kv = Math.min(kv, -0.8);
  }
  v.kdj = clamp(kv, -1, 1);

  // volS：量价配合
  const vol = k.volume || 0;
  const vma5 = lastVal(ind.volMa5, i);
  const prevClose = i > 0 ? klines[i - 1].close : price;
  const pct = prevClose ? (price - prevClose) / prevClose * 100 : 0;
  const vr = vma5 ? vol / vma5 : 1;
  if (vr > 1.3 && Math.abs(pct) > 0.5) v.volS = clamp(pct > 0 ? Math.min(vr / 2, 1.2) : -Math.min(vr / 2, 1.2), -1, 1);
  else if (vr > 1.3) v.volS = pct > 0 ? 0.3 : -0.3;
  else if (vr < 0.7) v.volS = pct > 0 ? 0.15 : -0.15;
  else v.volS = 0;

  // obv：OBV 10日斜率
  const os = lastVal(ind.obvSlope10, i);
  v.obv = os == null ? 0 : clamp(os * 3, -1, 1);

  // mfi：资金流量指标
  const mfi = lastVal(ind.mfi, i);
  v.mfi = mfi == null ? 0 : (mfi > 80 ? -0.8 : mfi > 60 ? 0.5 : mfi < 20 ? 0.8 : mfi < 40 ? -0.5 : 0);

  // boll：布林带位置（反转逻辑）
  const bu = lastVal(ind.bollUpper, i), bl = lastVal(ind.bollLower, i);
  if (bu != null && bl != null && bu > bl) {
    const pos = (price - bl) / (bu - bl);
    v.boll = clamp((0.5 - pos) * 2, -1, 1);
  } else v.boll = 0;

  // closePos：收盘在当日区间中的位置（收盘强度）
  const rng = k.high - k.low;
  v.closePos = rng > 0 ? clamp(((k.close - k.low) / rng - 0.5) * 2, -1, 1) : 0;

  // rangePos：距 20 日高低点的位置（均值回复）
  if (i >= 20) {
    let h20 = -Infinity, l20 = Infinity;
    for (let t = i - 19; t <= i; t++) { if (klines[t].high > h20) h20 = klines[t].high; if (klines[t].low < l20) l20 = klines[t].low; }
    v.rangePos = h20 > l20 ? clamp(((price - l20) / (h20 - l20) - 0.5) * 1.6, -1, 1) : 0;
  } else v.rangePos = 0;

  // ---------- B. 大盘环境 ----------
  const idx = ctx.indexAligned ? ctx.indexAligned[i] : null;
  const idxMa60 = ctx.indexMa60Aligned ? ctx.indexMa60Aligned[i] : null;
  v.indexS = (idx != null && idxMa60 != null) ? (idx >= idxMa60 ? 1 : -1) : 0;

  if (idx != null && ctx.indexAligned && i >= 20 && ctx.indexAligned[i - 20] != null) {
    const idxRet20 = (idx - ctx.indexAligned[i - 20]) / ctx.indexAligned[i - 20] * 100;
    v.idxMom = clamp(idxRet20 / 8, -1, 1);
    const stockRet = c20 ? (price - c20) / c20 * 100 : 0;
    v.rel = clamp((stockRet - idxRet20) / 6, -1, 1);
  } else { v.idxMom = 0; v.rel = 0; }

  // ---------- C. 海外与宏观（已滞后 1 日对齐） ----------
  const pick = (arr) => (arr && arr[i] != null ? arr[i] : null);

  const soxChg = pick(ctx.soxChgAligned);
  v.soxS = soxChg == null ? 0 : clamp(soxChg / 2, -1, 1);          // 隔夜涨跌 ±2% 归一

  const soxMom = pick(ctx.soxMomAligned);
  v.soxMom = soxMom == null ? 0 : clamp(soxMom / 10, -1, 1);        // 20日动量 ±10% 归一

  const u10 = pick(ctx.us10yChgAligned);
  v.us10y = u10 == null ? 0 : clamp(-u10 / 30, -1, 1);             // 利率上行 30bp → -1（利空成长）

  const spxChg = pick(ctx.spxChgAligned);
  v.spxS = spxChg == null ? 0 : clamp(spxChg / 1.5, -1, 1);         // 标普 ±1.5% 归一

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

module.exports = {
  SELF_EXPERTS, INDEX_EXPERTS, GLOBAL_EXPERTS, LIVE_EXPERTS,
  TRAINABLE_EXPERTS, ALL_EXPERTS, EXPERT_LABEL,
  extractVotes, voteToProb, summarizeVotes,
};
