'use strict';
/**
 * lib/rl.js —— 在线学习（Hedge / 指数加权 EXP 算法）+ 概率标定
 *
 * ============================ 诚实的定位 ============================
 * 这里做的**不是**深度强化学习（没有环境可交互、没有百万次采样、没有梯度反传）。
 * 它做的是强化学习家族里最适合本场景的一支：
 *
 *   上下文多臂老虎机（Contextual Bandit） + Hedge / Exponentiated Gradient
 *
 * 在这个框架里：
 *   臂(arm)      = 每个信号专家（动量/趋势/RSI/MACD/量价/大盘/相对强度/费半/情绪/资金/宏观）
 *   动作(action) = 给每个专家的方向票分配权重
 *   上下文(context) = 市场状态（牛市/熊市 × 低波动/高波动，共4档）
 *   奖励(reward)  = -(Brier 损失)，即预测概率越接近真实结果奖励越高
 *
 * Hedge 算法有可证明的遗憾界：R_T ≤ sqrt(T·lnN / 2)
 * 意思是：长期看，这套加权预测的累计损失不会比"事后最优的那个固定专家"差太多。
 * 这正是"越用越准"的数学依据 —— 前提是**必须真的把结果记下来并回灌**。
 * ===================================================================
 *
 * 零依赖，仅使用内置模块。
 */

const fs = require('fs');
const path = require('path');
const { clamp } = require('./indicators');
const { ALL_EXPERTS, voteToProb } = require('./signals');

/** HORIZONS = 参与机器学习的周期（回测可覆盖） */
const HORIZONS = ['d1', 'd3', 'w1', 'm1'];
/** HORIZON_DAYS 额外含 m6/q1，仅供研究台账结算使用（超出回测窗口，不参与训练） */
const HORIZON_DAYS = { d1: 1, d3: 3, w1: 5, m1: 22, m6: 120, q1: 60 };
const HORIZON_LABEL = { d1: '未来1天', d3: '未来3天', w1: '未来1周', m1: '未来1月', q1: '未来3个月', m6: '未来6个月' };

/**
 * 先验权重 = 手工设定的起点。
 * 设计要点：不从零学起，而是从一个合理的起点出发，让数据去修正它。
 * 没被手工选中的专家给一个 0.01 的探索底仓，一旦被证明有效，
 * 指数更新会自动把权重涨上来。
 */
const PRIOR_WEIGHTS = {
  // 短线：重短期动量、量价、收盘强度、隔夜费半/标普
  d1: {
    mom5: 0.15, volS: 0.14, rsiRev: 0.12, closePos: 0.08, soxS: 0.10, indexS: 0.08,
    idxMom: 0.06, spxS: 0.06, kdj: 0.05, mom: 0.05, senti: 0.05, boll: 0.04,
    macdDir: 0.02, obv: 0.01, mfi: 0.01, trend: 0.01, rangePos: 0.01, rel: 0.01,
    soxMom: 0.01, us10y: 0.01, fund: 0.01,
  },
  // 3日：动量 + 趋势 + 量价 + 隔夜
  d3: {
    mom: 0.16, trend: 0.13, volS: 0.12, macdDir: 0.09, soxS: 0.08, indexS: 0.08,
    mom5: 0.06, kdj: 0.05, rel: 0.05, obv: 0.04, soxMom: 0.04, idxMom: 0.04,
    closePos: 0.02, mfi: 0.02, spxS: 0.02, boll: 0.01, rsiRev: 0.01, rangePos: 0.01,
    us10y: 0.01, fund: 0.01, senti: 0.01,
  },
  // 1周：趋势 + 能量潮 + 资金流量 + 费半动量 + 宏观
  w1: {
    trend: 0.17, mom: 0.13, obv: 0.08, us10y: 0.09, indexS: 0.08, rel: 0.08,
    fund: 0.08, soxMom: 0.07, mfi: 0.06, idxMom: 0.06, senti: 0.03, volS: 0.03,
    macdDir: 0.02, kdj: 0.01, mom5: 0.01, soxS: 0.01, spxS: 0.01, boll: 0.01,
    rsiRev: 0.01, closePos: 0.01, rangePos: 0.01,
  },
  // 1月：趋势 + 大盘动量 + 宏观利率 + 相对强度
  m1: {
    trend: 0.17, idxMom: 0.12, us10y: 0.10, rel: 0.10, fund: 0.10, mom: 0.08,
    indexS: 0.08, obv: 0.06, mfi: 0.05, soxMom: 0.05, macdDir: 0.02, senti: 0.01,
    mom5: 0.01, volS: 0.01, kdj: 0.01, soxS: 0.01, spxS: 0.01, boll: 0.01,
    rsiRev: 0.01, closePos: 0.01, rangePos: 0.01,
  },
};

/**
 * 损失函数类型（三种，由验证集选择）：
 *
 *  'brier'       —— 概率均方误差 (p-y)²。优点是能校准概率，
 *                   **缺点是"弃权"（输出 50%）几乎免费**：一个 53% 命中的专家
 *                   loss≈0.47，而永远输出 50% 的专家 loss 恒为 0.25。
 *                   结果所有专家都会退化成"闭嘴"，模型方向能力被抹平。
 *  'directional' —— 方向 0-1 损失。直接优化"猜对涨跌"，
 *                   弃权会被当成"猜涨"，成本与普通预测一样，不再有免费午餐。
 *                   缺点是不含概率幅度信息。
 *  'mixed'       —— 0.5×方向损失 + 0.5×Brier。兼顾方向与校准。
 *
 * 为什么必须做这个选择：**Brier 最优 ≠ 方向最优 ≠ 交易胜率最优**。
 * 实盘要的是"方向和胜率"，所以这里让验证集来选，而不是拍脑袋。
 */
const LOSS_TYPES = ['brier', 'directional', 'mixed'];

function expertLoss(p, y, lossType) {
  const brier = (p - y) * (p - y);
  if (lossType === 'brier') return brier;
  const wrong = ((p >= 0.5 ? 1 : 0) === y) ? 0 : 1;
  if (lossType === 'directional') return wrong;
  return 0.5 * wrong + 0.5 * brier;
}

const DEFAULT_ETA = 0.35;      // 学习率
const WEIGHT_FLOOR = 0.012;    // 权重下限（防止专家被永久判死）
const SHRINK_K = 15;           // 分层收缩强度：regime 样本 < 15 时主要听全局

// ------------------------------------------------------------------ 状态

function initHorizon(prior, experts) {
  const exp = experts || ALL_EXPERTS;
  const weights = {};
  const stats = {};
  let z = 0;
  for (const k of exp) {
    const w0 = (prior && prior[k] != null) ? prior[k] : 0.01;
    weights[k] = w0;
    z += w0;
    stats[k] = { n: 0, hits: 0, lossSum: 0, brierSum: 0 };
  }
  for (const k of exp) weights[k] /= z;
  return { weights, prior: Object.assign({}, weights), stats, n: 0 };
}

/** 当前生效的专家集合（消融实验用 activeExperts 收窄） */
function activeExpertsOf(state) {
  return (state && state.activeExperts && state.activeExperts.length) ? state.activeExperts : ALL_EXPERTS;
}

function initState(opts) {
  opts = opts || {};
  const experts = (opts.experts && opts.experts.length) ? opts.experts.slice() : ALL_EXPERTS.slice();
  const horizons = {};
  for (const h of HORIZONS) horizons[h] = initHorizon(PRIOR_WEIGHTS[h], experts);
  return {
    version: 1,
    activeExperts: experts,
    eta: DEFAULT_ETA,
    lossType: 'mixed',    // 'brier' | 'directional' | 'mixed'（由验证集选择）
    discount: 1,          // 遗忘因子 γ（1 = 不遗忘；<1 表示越久远的损失影响越小）
    floor: WEIGHT_FLOOR,
    rounds: 0,
    updatedAt: null,
    horizons,
    regimes: {},          // regimes[regime][horizon] = { weights, n }
    calibration: {},      // calibration[horizon] = { a, b, n }
    calibPairs: {},       // calibration[horizon] = [{p, y}] （保留最近 800 条）
    history: [],          // 最近训练轮次摘要
    trainedFrom: null,    // 训练数据来源描述
    // 实盘策略：**唯一生效来源**是 tradingPolicy.decided；
    // 其它候选一律放 evaluated 并标注 adopted:false，避免"5 套冲突策略同处一室"。
    tradingPolicy: defaultTradingPolicy(),
  };
}

/**
 * 交易策略的规范结构
 *   decided        —— 唯一生效的策略（live-predict 只读这里）
 *   evaluated      —— 评估过的候选，全部 adopted:false（记录证据，不生效）
 *   operatingMode  —— 'monthly' | 'weekly' | 'daily'（操作频率）
 *   signalSmoothing—— 概率平滑窗口（1=不平滑；默认 5，实测保留 94% 超额、日翻转 −63%）
 */
function defaultTradingPolicy() {
  return {
    decided: null,
    evaluated: {},
    operatingMode: 'monthly',
    signalSmoothing: 5,
  };
}

/**
 * 把历史的扁平 tradingPolicy（thresholds/timingPolicy/rotationWeight/... 混在一起）
 * 迁移到 { decided, evaluated } 结构。幂等：已是新结构则原样返回。
 */
function migrateTradingPolicy(tp, wholeState) {
  const st = wholeState || {};
  if (tp && typeof tp === 'object' && (tp.decided !== undefined || tp.evaluated !== undefined)) {
    const out = Object.assign(defaultTradingPolicy(), tp);
    // 老结构里 confluencePolicy/chosenStrategy 在顶层，这里一并收编
    if (st.confluencePolicy && !out.decided.confluencePolicy) out.decided.confluencePolicy = st.confluencePolicy;
    if (st.chosenStrategy && !out.evaluated.chosenStrategy) {
      out.evaluated.chosenStrategy = Object.assign({ adopted: false, rejectReason: '仅为评估记录，未接入实盘' }, st.chosenStrategy);
    }
    return out;
  }
  if (!tp || typeof tp !== 'object') tp = {};
  const out = defaultTradingPolicy();
  // decided = 所有**实际生效**的输入
  out.decided = {
    thresholds: tp.thresholds || {},
    fees: tp.fees || null,
    basis: tp.basis || '',
    confluencePolicy: tp.confluencePolicy || st.confluencePolicy || null,
  };
  // evaluated = 评估过但**未采纳**的候选（保留证据，明确 adopted:false）
  const ev = {};
  if (tp.timingPolicy) ev.timingPolicy = Object.assign({ adopted: false, rejectReason: '测试集 Calmar 低于同周期纯动量基准（择时退出族测试集 0/4 全败）' }, tp.timingPolicy);
  if (tp.rotationWeight) ev.rotationWeight = Object.assign({ adopted: false, rejectReason: '验证集与测试集结论相反，w 不可靠估计' }, tp.rotationWeight);
  if (st.chosenStrategy) ev.chosenStrategy = Object.assign({ adopted: false, rejectReason: '仅为评估记录，未接入实盘' }, st.chosenStrategy);
  out.evaluated = ev;
  return out;
}

function blankState() { return initState(); }

function loadState(file) {
  try {
    if (!fs.existsSync(file)) return initState();
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!s || !s.horizons) return initState();
    // 向前兼容：补齐缺失字段
    for (const h of HORIZONS) {
      if (!s.horizons[h]) s.horizons[h] = initHorizon(PRIOR_WEIGHTS[h]);
      if (!s.horizons[h].stats) s.horizons[h].stats = {};
      for (const k of ALL_EXPERTS) {
        if (s.horizons[h].weights[k] == null) s.horizons[h].weights[k] = 0.01;
        if (!s.horizons[h].stats[k]) s.horizons[h].stats[k] = { n: 0, hits: 0, lossSum: 0, brierSum: 0 };
      }
    }
    if (!s.regimes) s.regimes = {};
    if (!s.calibration) s.calibration = {};
    if (!s.calibPairs) s.calibPairs = {};
    if (!s.history) s.history = [];
    if (!s.activeExperts || !s.activeExperts.length) s.activeExperts = ALL_EXPERTS.slice();
    s.tradingPolicy = migrateTradingPolicy(s.tradingPolicy, s);
    if (!s.lossType) s.lossType = 'mixed';
    return s;
  } catch (e) {
    return initState();
  }
}

function saveState(s, file) {
  s.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
  return s;
}

function defaultStatePath() {
  return process.env.RL_STATE_PATH || path.join(__dirname, '..', 'data', 'rl-state.json');
}

/** 随镜像发布的学习结果（可提交到 git，公开部署时作为只读回退） */
function bundledStatePath() {
  return process.env.RL_BUNDLED_PATH || path.join(__dirname, '..', 'model', 'rl-state.json');
}

/** 先读本地可写状态，没有则回退到随包发布的学习结果 */
function loadStateWithFallback() {
  const p = defaultStatePath();
  if (fs.existsSync(p)) return loadState(p);
  const b = bundledStatePath();
  if (fs.existsSync(b)) return loadState(b);
  return initState();
}

// ------------------------------------------------------------------ 市场状态（上下文）

/**
 * 判定市场状态（4档上下文）
 * @param {Object} ctx { indexPrice, indexMa60, atrPct }
 */
function regimeOf(ctx) {
  ctx = ctx || {};
  const trend = (ctx.indexPrice != null && ctx.indexMa60 != null)
    ? (ctx.indexPrice >= ctx.indexMa60 ? 'bull' : 'bear') : 'bull';
  const vol = ctx.atrPct == null ? 'lowvol' : (ctx.atrPct >= 2.5 ? 'highvol' : 'lowvol');
  return trend + '-' + vol;
}

/** 分层收缩：样本少时靠全局权重，样本多时用自己的 */
function effectiveWeights(state, horizon, regime) {
  const exp = activeExpertsOf(state);
  const g = state.horizons[horizon].weights;
  const r = state.regimes[regime] && state.regimes[regime][horizon];
  if (!r || !r.n) {
    const cp = {};
    let cz = 0;
    for (const k of exp) { cp[k] = g[k] || 0; cz += cp[k]; }
    for (const k of exp) cp[k] = cz ? cp[k] / cz : 1 / exp.length;
    return cp;
  }
  const lam = r.n / (r.n + SHRINK_K);
  const out = {};
  let z = 0;
  for (const k of exp) {
    const wg = g[k] || 0;
    const wr = r.weights[k] != null ? r.weights[k] : wg;
    out[k] = lam * wr + (1 - lam) * wg;
    z += out[k];
  }
  for (const k of exp) out[k] = z ? out[k] / z : 1 / exp.length;
  return out;
}

// ------------------------------------------------------------------ 聚合预测

/**
 * 用当前权重把专家票聚合成一个概率
 * @returns {Object} { p, weights, contributions, experts }
 */
function aggregate(state, horizon, votes, regime) {
  const exp = activeExpertsOf(state);
  const w = effectiveWeights(state, horizon, regime);
  let num = 0, den = 0;
  const contributions = {};
  for (const k of exp) {
    const v = votes[k];
    if (v == null) continue;
    const p = voteToProb(v);
    num += w[k] * p;
    den += w[k];
    contributions[k] = { vote: v, weight: w[k], prob: p, contrib: w[k] * p };
  }
  const p = den > 0 ? num / den : 0.5;
  return { p, weights: w, contributions, horizon, regime };
}

// ------------------------------------------------------------------ Hedge 在线更新

/**
 * 单步 Hedge 更新（对"下注专家池"归一化，睡觉专家质量严格不变）
 *
 * ⚠️ 两个曾经踩过的坑，这里一次性解决：
 *
 *  坑1「睡觉专家白拿权重」：某专家当天没数据(v == null)，它没下注就不该有损失。
 *       若对它乘以 1，则别人亏钱时它的**相对**权重会被推高 ——
 *       曾导致费半/情绪/资金/宏观四个无历史数据的专家吃掉 90% 权重。
 *       解法：睡觉专家权重原封不动，只在下注专家池内部归一化。
 *
 *  坑2「归一化挤占睡觉专家质量」：若把全体权重一起除以 z，只要下注专家触发权重
 *       下限(floor)使 z>1，睡觉专家的质量每轮都被稀释一点，几千轮后归零。
 *       解法：把下注池归一化到**它更新前的总质量**，睡觉专家不参与归一化。
 *
 * @returns {Object} 新的权重向量（求和恒为 1）
 */
function hedgeStep(weights, votes, y, eta, gamma, floor, lossType, experts) {
  const pool = experts || ALL_EXPERTS;
  const active = pool.filter((k) => votes[k] != null);
  let activeOld = 0;
  for (const k of active) activeOld += weights[k] || 0;

  const raw = {};
  let activeNew = 0;
  for (const k of active) {
    const p = voteToProb(votes[k]);
    const loss = expertLoss(p, y, lossType || 'brier');   // ∈ [0,1]
    raw[k] = (weights[k] || 0) * gamma * Math.exp(-eta * loss);
    activeNew += raw[k];
  }

  const scale = activeNew > 0 ? activeOld / activeNew : 0;
  let fsum = 0;
  const floored = {};
  for (const k of active) { floored[k] = Math.max(raw[k] * scale, floor); fsum += floored[k]; }
  const renorm = fsum > 0 ? activeOld / fsum : 0;

  const out = {};
  for (const k of pool) {
    out[k] = (votes[k] == null) ? (weights[k] || 0) : floored[k] * renorm;
  }
  return out;
}

/**
 * 一轮 Hedge / 指数权重更新
 * @param {Object} state
 * @param {String} horizon  'd1'|'d3'|'w1'|'m1'
 * @param {Object} votes    { mom: 0.4, trend: -1, ... }
 * @param {Number} y        真实结果：1=上涨, 0=下跌（用 Brier 损失，二值）
 * @param {String} regime   市场状态
 */
function update(state, horizon, votes, y, regime) {
  const H = state.horizons[horizon];
  const eta = state.eta || DEFAULT_ETA;
  const floor = state.floor || WEIGHT_FLOOR;
  const gamma = state.discount != null ? state.discount : 1;   // 遗忘因子（应对市场非平稳）

  const lossType = state.lossType || 'brier';
  const exp = activeExpertsOf(state);

  // 0) 统计（只统计真正下注的专家）
  for (const k of exp) {
    const v = votes[k];
    if (v == null) continue;
    const p = voteToProb(v);
    const st = H.stats[k];
    st.n++;
    st.lossSum += expertLoss(p, y, lossType);
    st.brierSum += (p - y) * (p - y);                  // Brier 始终单独记录，便于比较
    st.hits += ((p >= 0.5 ? 1 : 0) === y) ? 1 : 0;
    if (v === 0) st.abstain = (st.abstain || 0) + 1;   // 弃权（输出 50%）
  }

  // 1) 全局权重
  H.weights = hedgeStep(H.weights, votes, y, eta, gamma, floor, lossType, exp);
  H.n++;

  // 2) 上下文（regime）权重表 —— 同样的睡觉专家处理
  if (regime) {
    if (!state.regimes[regime]) state.regimes[regime] = {};
    if (!state.regimes[regime][horizon]) state.regimes[regime][horizon] = { weights: Object.assign({}, H.weights), n: 0 };
    const R = state.regimes[regime][horizon];
    R.weights = hedgeStep(R.weights, votes, y, eta, gamma, floor, lossType, exp);
    R.n++;
  }

  // 4) 标定样本
  const agg = aggregate(state, horizon, votes, regime);
  if (!state.calibPairs[horizon]) state.calibPairs[horizon] = [];
  state.calibPairs[horizon].push({ p: +agg.p.toFixed(4), y });
  if (state.calibPairs[horizon].length > 800) state.calibPairs[horizon].shift();

  state.rounds++;
  return { p: agg.p, weights: H.weights };
}

// ------------------------------------------------------------------ 概率标定（Platt Scaling）

function logit(p) { p = clamp(p, 1e-6, 1 - 1e-6); return Math.log(p / (1 - p)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

/**
 * 逻辑回归（Platt）标定：p_cal = sigmoid(a·logit(p) + b)
 * 目的：让"系统说 70%"真的对应约 70% 的实际发生频率。
 *   a > 1 → 模型过于保守；a < 1 → 模型过度自信（需要把概率往 50% 收缩）
 *
 * ⚠️ 重要设计选择：**默认只拟合斜率 a，把截距 b 固定为 0**。
 * 原因：金融市场的基础涨跌率（base rate）不平稳。若允许自由拟合截距，
 * b 会把"训练期恰好偏多/偏空"这件事学进去，到了样本外就会**整体平移概率，
 * 甚至把"看跌"翻成"看涨"**——这是极危险的。只拟合斜率可以做到
 * "有信号就保留方向、信号弱就往 50% 收缩"，而不会改变方向。
 * 需要在报告里看基础率时，单独输出 fitBaseRate 字段。
 */
function fitPlatt(pairs, opts) {
  opts = opts || {};
  const iters = opts.iters || 800;
  const lr = opts.lr || 0.35;
  const fitIntercept = !!opts.fitIntercept;
  let a = 1, b = 0;
  if (!pairs || pairs.length < 20) {
    return { a, b, n: (pairs || []).length, fitted: false, fitIntercept, fitBaseRate: null };
  }
  const ybar = pairs.reduce((s, r) => s + r.y, 0) / pairs.length;
  for (let it = 0; it < iters; it++) {
    let ga = 0, gb = 0;
    for (const { p, y } of pairs) {
      const x = logit(p);
      const e = sigmoid(a * x + b) - y;
      ga += e * x;
      gb += e;
    }
    ga /= pairs.length; gb /= pairs.length;
    // a 向 1 轻微收缩（防止极端斜率）；b 向 0 收缩（默认不拟合）
    a -= lr * (ga + 0.02 * (a - 1));
    if (fitIntercept) b -= lr * (gb + 0.05 * b);
    a = clamp(a, 0.10, 5); b = clamp(b, -1, 1);
  }
  return {
    a: +a.toFixed(4), b: +(fitIntercept ? b : 0).toFixed(4),
    n: pairs.length, fitted: true, fitIntercept, fitBaseRate: +ybar.toFixed(4),
  };
}

/** 应用标定 */
function calibrate(state, horizon, p) {
  const c = state.calibration && state.calibration[horizon];
  if (!c || !c.fitted) return p;
  return clamp(sigmoid(c.a * logit(p) + c.b), 0.01, 0.99);
}

/** 对所有周期重跑标定拟合 */
function refitCalibration(state) {
  state.calibration = state.calibration || {};
  for (const h of HORIZONS) {
    const pairs = (state.calibPairs && state.calibPairs[h]) || [];
    state.calibration[h] = fitPlatt(pairs);
  }
  return state.calibration;
}

// ------------------------------------------------------------------ 评估指标

/** Brier 分解：Brier = reliability - resolution + uncertainty（Murphy 分解） */
function brierDecomp(pairs, nBins) {
  nBins = nBins || 10;
  const n = (pairs || []).length;
  if (!n) return { n: 0, brier: null, reliability: null, resolution: null, uncertainty: null, hitRate: null };
  const bins = Array.from({ length: nBins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  let brier = 0, hits = 0, ybar = 0;
  for (const { p, y } of pairs) {
    brier += (p - y) ** 2;
    hits += ((p >= 0.5 ? 1 : 0) === y) ? 1 : 0;
    ybar += y;
    const bi = Math.min(nBins - 1, Math.max(0, Math.floor(p * nBins)));
    bins[bi].n++; bins[bi].sumP += p; bins[bi].sumY += y;
  }
  brier /= n; hits /= n; ybar /= n;
  let rel = 0, res = 0;
  for (const bn of bins) {
    if (!bn.n) continue;
    const pk = bn.sumP / bn.n, ok = bn.sumY / bn.n;
    rel += (bn.n / n) * (pk - ok) ** 2;
    res += (bn.n / n) * (ok - ybar) ** 2;
  }
  const unc = ybar * (1 - ybar);
  return {
    n, hitRate: +hits.toFixed(4),
    brier: +brier.toFixed(4),
    reliability: +rel.toFixed(4),
    resolution: +res.toFixed(4),
    uncertainty: +unc.toFixed(4),
    baseRate: +ybar.toFixed(4),
    skillScore: unc > 0 ? +(1 - brier / unc).toFixed(4) : null,
  };
}

/** 专家排行榜：按周期给出每个专家的样本数/命中率/Brier */
function expertLeaderboard(state, horizon) {
  const st = state.horizons[horizon].stats;
  const rows = activeExpertsOf(state).map((k) => {
    const s = st[k] || { n: 0, hits: 0, brierSum: 0, abstain: 0 };
    return {
      expert: k,
      n: s.n,
      abstain: s.abstain || 0,
      abstainRate: s.n ? +((s.abstain || 0) / s.n).toFixed(4) : null,
      hitRate: s.n ? +(s.hits / s.n).toFixed(4) : null,
      brier: s.n ? +(s.brierSum / s.n).toFixed(4) : null,
      weight: +(state.horizons[horizon].weights[k] || 0).toFixed(4),
      priorWeight: +(state.horizons[horizon].prior[k] || 0).toFixed(4),
      trained: s.n > 0,
    };
  });
  // 排序：先按"有样本"优先，再按 Brier 升序
  rows.sort((x, y2) => {
    if (x.trained !== y2.trained) return x.trained ? -1 : 1;
    return (x.brier == null ? 9 : x.brier) - (y2.brier == null ? 9 : y2.brier);
  });
  return rows;
}

/** 全局摘要 */
function summary(state) {
  const out = { rounds: state.rounds, updatedAt: state.updatedAt, trainedFrom: state.trainedFrom, horizons: {} };
  for (const h of HORIZONS) {
    const pairs = (state.calibPairs && state.calibPairs[h]) || [];
    const m = brierDecomp(pairs, 10);
    const w = state.horizons[h].weights;
    const top = Object.keys(w).sort((a, b) => w[b] - w[a]).slice(0, 4)
      .map((k) => ({ expert: k, weight: +w[k].toFixed(3) }));
    out.horizons[h] = {
      label: HORIZON_LABEL[h],
      n: m.n,
      hitRate: m.hitRate,
      brier: m.brier,
      skillScore: m.skillScore,
      reliability: m.reliability,
      resolution: m.resolution,
      uncertainty: m.uncertainty,
      topExperts: top,
      calibration: (state.calibration && state.calibration[h]) || null,
    };
  }
  return out;
}

module.exports = {
  HORIZONS, HORIZON_DAYS, HORIZON_LABEL, PRIOR_WEIGHTS, ALL_EXPERTS, LOSS_TYPES, expertLoss,
  DEFAULT_ETA, WEIGHT_FLOOR, SHRINK_K,
  initState, blankState, loadState, saveState, defaultStatePath, bundledStatePath, loadStateWithFallback,
  defaultTradingPolicy, migrateTradingPolicy,
  regimeOf, effectiveWeights, aggregate, update, activeExpertsOf,
  fitPlatt, calibrate, refitCalibration, logit, sigmoid,
  brierDecomp, expertLeaderboard, summary,
};
