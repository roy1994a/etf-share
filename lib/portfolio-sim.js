'use strict';
/**
 * lib/portfolio-sim.js —— 组合级净值回测（资金受限、按日盯市、可算回撤）
 *
 * ================== 为什么需要它 ==================
 * train-rl.js 原有的 evalTrading/tradeStats 把每个 (标的,日期,周期) 当成
 * **独立一笔交易**，只统计 `fwdRetPct - fee` 的均值与标准差。它没有资金约束、
 * 没有净值曲线、没有最大回撤、没有换手率 —— 因此无法回答三个关键问题：
 *   1) 实盘（资金有限、同时最多持有几只）到底能不能做？
 *   2) 最大回撤是多少？能不能承受？
 *   3) 换手率带来的成本侵蚀有多大？
 *
 * 本模块补齐这三件事，并且修掉一个**前视偏差**：
 *   dataset.buildEvents 用 klines[i].close 同时作为决策价与成交价（信号由
 *   含该收盘价的窗口算出）。这里默认 execLag=1，即**用次日的 open 成交**。
 *   这会（也应该）让所有数字下降 —— 那才是可执行的收益。
 *
 * 零依赖，仅使用内置模块。
 */

const rl = require('./rl');

// 双边交易成本（%）：与 train-rl.js 保持一致
const FEE_ROUND_TRIP_PCT = { etf: 0.08, stock: 0.18 };
const MIN_COMMISSION = 5;         // 单笔最低佣金（元），小仓位时影响显著

function feeFor(code) {
  return /^(15|51|56|58)/.test(String(code)) ? FEE_ROUND_TRIP_PCT.etf : FEE_ROUND_TRIP_PCT.stock;
}

/** 单笔实际成本（元）：按成交额算比例费，但不低于最低佣金 */
function costOf(amount, code) {
  const pct = feeFor(code);
  return Math.max(Math.abs(amount) * pct / 100, MIN_COMMISSION);
}

/** 把事件流转成 { date: [rows] }，并按日期排序 */
function indexByDate(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.date)) by.set(r.date, []);
    by.get(r.date).push(r);
  }
  return by;
}

/** 取某标的某日的 K 线（用 date→bar 的 Map 加速） */
function buildBarIndex(klinesByCode) {
  const idx = {};
  for (const code of Object.keys(klinesByCode || {})) {
    const m = new Map();
    const ks = klinesByCode[code];
    for (let i = 0; i < ks.length; i++) m.set(ks[i].date, { bar: ks[i], i });
    idx[code] = m;
  }
  return idx;
}

/**
 * 组合级净值回测
 *
 * @param {Array}  rows         事件流（需含 date/code/horizon/rank 字段）
 *                              每个元素形如 { date, code, horizon, rank, price }
 * @param {Object} klinesByCode { code: [{date,open,close,high,low,volume}] }
 * @param {Object} opts
 *   rankBy        : 'momentum' | 'model' | 'combined'  —— 由调用方预先算好 rank 分
 *   horizon       : 'd1'|'d3'|'w1'|'m1'
 *   topK          : 每日最多建仓数（默认 3）
 *   execLag       : 成交滞后天数（默认 1 = 次日 open）
 *   initialCapital: 初始资金（默认 500000）
 *   positionPct   : 单标的目标仓位占净值比（默认 = 1/topK）
 *   stopPct       : 止损（默认 8，null 关闭）
 *   takePct       : 止盈（默认 null 关闭）
 *   drawdownBrake : { warnPct, brakePct, reduceTo } 组合回撤刹车（可选）
 *   excludeCodes  : 排除的标的
 */
function simulatePortfolio(rows, klinesByCode, opts) {
  opts = opts || {};
  const horizon = opts.horizon || 'w1';
  const holdDays = rl.HORIZON_DAYS[horizon] || 5;
  const topK = opts.topK || 3;
  const execLag = opts.execLag == null ? 1 : opts.execLag;
  // 成交价字段：execLag=0 时用当日**收盘**（对应旧的 close-to-close 口径，
  // 用于量化"看着能做、实际做不到"的那部分）；execLag≥1 时用**次日开盘**（可执行）。
  const execField = opts.execField || (execLag === 0 ? 'close' : 'open');
  const initialCapital = opts.initialCapital || 500000;
  const positionPct = opts.positionPct != null ? opts.positionPct : 1 / topK;
  const stopPct = opts.stopPct == null ? 8 : opts.stopPct;
  const takePct = opts.takePct == null ? null : opts.takePct;
  const brake = opts.drawdownBrake || null;
  const exclude = new Set(opts.excludeCodes || []);
  // ---- 模型择时（P4）：横截面排序交给动量，买卖时机交给模型 ----
  //   timing.minProb  : 建仓门槛，模型可信概率低于它就放弃该标的
  //   timing.exitProb : 持仓期间模型概率跌破它就平仓（择时退出）
  const timing = opts.timing || null;
  const sizing = opts.sizing || 'equal';   // 'equal' | 'prob'（按模型概率缩放仓位）

  const barIdx = buildBarIndex(klinesByCode);
  const sub = rows.filter((r) => r.horizon === horizon && !exclude.has(r.code) && r.rank != null);
  // 概率查表：code|date -> 模型可信概率（用于择时退出，需要"当日"的概率）
  const probMap = new Map();
  for (const r of rows) {
    if (r.horizon !== horizon || r._p == null) continue;
    probMap.set(r.code + '|' + r.date, r._p);
  }
  const probOn = (code, date) => {
    const v = probMap.get(code + '|' + date);
    return v == null ? null : v;
  };
  const byDate = indexByDate(sub);
  const dates = [...byDate.keys()].sort();
  if (!dates.length) {
    return { equity: [], metrics: emptyMetrics(), trades: [], dates: [] };
  }

  // 交易日轴：用所有标的的并集日期（保证退出检查不被某标的停牌影响）
  const allDates = new Set();
  for (const code of Object.keys(klinesByCode || {})) {
    for (const k of klinesByCode[code]) if (k.date >= dates[0]) allDates.add(k.date);
  }
  const axis = [...allDates].sort();
  if (axis.length < 2) return { equity: [], metrics: emptyMetrics(), trades: [], dates: [] };

  let cash = initialCapital;
  const positions = [];   // {code, shares, entryPrice, entryDate, entryIdx, cost, holdBars}
  const trades = [];
  const equity = [];
  let nav = initialCapital;
  let peak = initialCapital;
  let maxDD = 0;
  let turnover = 0;
  let exposureSum = 0;
  const brakeState = { active: false };

  const priceOn = (code, date, field) => {
    const m = barIdx[code];
    if (!m) return null;
    const rec = m.get(date);
    if (!rec) return null;
    const v = rec.bar[field];
    return v != null && v > 0 ? v : null;
  };

  for (let di = 0; di < axis.length; di++) {
    const date = axis[di];

    // ---------- 1) 退出（止损优先于止盈，保守） ----------
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const p = positions[pi];
      const bar = barIdx[p.code] && barIdx[p.code].get(date);
      if (!bar) continue;
      const low = bar.bar.low, high = bar.bar.high, close = bar.bar.close;
      let exitPrice = null, reason = null;

      if (stopPct != null) {
        const stopPrice = p.entryPrice * (1 - stopPct / 100);
        if (low != null && low <= stopPrice) { exitPrice = Math.min(stopPrice, bar.bar.open != null ? bar.bar.open : stopPrice); reason = 'stop'; }
      }
      if (exitPrice == null && takePct != null) {
        const takePrice = p.entryPrice * (1 + takePct / 100);
        if (high != null && high >= takePrice) { exitPrice = Math.max(takePrice, bar.bar.open != null ? bar.bar.open : takePrice); reason = 'take'; }
      }
      // 择时退出：模型可信概率跌破阈值 → 当日收盘平仓（在止损之后、到期之前判定）
      if (exitPrice == null && timing && timing.exitProb != null) {
        const pc = probOn(p.code, date);
        if (pc != null && pc < timing.exitProb) { exitPrice = close; reason = 'timing-exit'; }
      }
      // 到期：从成交日算起满 holdDays 个交易日，在当日收盘平仓
      if (exitPrice == null && (di - p.entryIdx) >= holdDays) { exitPrice = close; reason = 'expire'; }
      if (exitPrice == null) continue;

      const amount = exitPrice * p.shares;
      const cost = costOf(amount, p.code);
      cash += amount - cost;
      turnover += amount;
      trades.push({
        code: p.code, entryDate: p.entryDate, entryPrice: p.entryPrice,
        exitDate: date, exitPrice, shares: p.shares, reason,
        holdBars: di - p.entryIdx,
        retPct: +(((exitPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(4),
        pnl: +((exitPrice - p.entryPrice) * p.shares - cost - p.entryCost).toFixed(2),
      });
      positions.splice(pi, 1);
    }

    // ---------- 2) 组合回撤刹车 ----------
    if (brake && peak > 0) {
      const dd = (peak - nav) / peak * 100;
      if (!brakeState.active && dd >= (brake.brakePct || 18)) {
        brakeState.active = true;
        const reduceTo = brake.reduceTo != null ? brake.reduceTo : 0.5;
        for (let pi = positions.length - 1; pi >= 0; pi--) {
          const p = positions[pi];
          const px = priceOn(p.code, date, 'close');
          if (!px) continue;
          const sellShares = Math.round(p.shares * (1 - reduceTo));
          if (sellShares <= 0) continue;
          const amount = px * sellShares;
          const cost = costOf(amount, p.code);
          cash += amount - cost;
          turnover += amount;
          p.shares -= sellShares;
          trades.push({ code: p.code, entryDate: p.entryDate, entryPrice: p.entryPrice, exitDate: date,
            exitPrice: px, shares: sellShares, reason: 'dd-brake',
            retPct: +(((px - p.entryPrice) / p.entryPrice) * 100).toFixed(4), pnl: 0 });
          if (p.shares <= 0) positions.splice(pi, 1);
        }
      } else if (brakeState.active && dd < (brake.warnPct || 15) * 0.5) {
        brakeState.active = false;
      }
    }

    // ---------- 3) 入场（用 execLag 天后的价格成交） ----------
    const slots = topK - positions.length;
    if (slots > 0 && !(brake && brakeState.active)) {
      const execDate = axis[Math.min(di + execLag, axis.length - 1)];
      let cands = (byDate.get(date) || [])
        .filter((r) => !positions.some((p) => p.code === r.code))
        .sort((a, b) => b.rank - a.rank);
      // 择时门槛：模型不看好就不建仓（排序仍由动量决定）
      if (timing && timing.minProb != null) {
        cands = cands.filter((r) => r._p != null && r._p >= timing.minProb);
      }
      cands = cands.slice(0, slots);

      // 概率定仓：模型越有信心，仓位越大（归一化后不超过 positionPct 的 1.5 倍）
      const weightOf = (r) => {
        if (sizing !== 'prob' || r._p == null) return 1;
        return Math.max(0.2, Math.min(1.5, 1 + (r._p - 0.5) * 4));
      };
      const wSum = cands.reduce((a, r) => a + weightOf(r), 0);

      for (const c of cands) {
        const bar = barIdx[c.code] && barIdx[c.code].get(execDate);
        if (!bar) continue;
        let px = bar.bar[execField];
        if (execField === 'open' && !(px > 0)) px = bar.bar.close;
        if (!(px > 0)) continue;
        const share = sizing === 'prob' && wSum > 0 ? weightOf(c) / wSum * cands.length : 1;
        const budget = Math.min(cash, nav * positionPct * share);
        if (budget < px * 100) continue;            // 连 1 手都买不起
        const shares = Math.floor(budget / px / 100) * 100;
        if (shares <= 0) continue;
        const amount = shares * px;
        const cost = costOf(amount, c.code);
        if (amount + cost > cash) continue;
        cash -= amount + cost;
        turnover += amount;
        positions.push({ code: c.code, shares, entryPrice: px, entryDate: execDate, entryCost: cost, entryIdx: di });
      }
    }

    // ---------- 4) 盯市 ----------
    let mv = 0;
    for (const p of positions) {
      const px = priceOn(p.code, date, 'close') || p.entryPrice;
      mv += px * p.shares;
    }
    nav = cash + mv;
    if (nav > peak) peak = nav;
    const ddPct = peak > 0 ? (peak - nav) / peak * 100 : 0;
    if (ddPct > maxDD) maxDD = ddPct;
    exposureSum += (nav > 0 ? mv / nav : 0);
    equity.push({ date, nav: +nav.toFixed(2), cash: +cash.toFixed(2), marketValue: +mv.toFixed(2), positions: positions.length, drawdownPct: +ddPct.toFixed(3) });
  }

  // ---------- 指标 ----------
  const last = equity[equity.length - 1];
  const totalRet = (last.nav / initialCapital - 1) * 100;
  const years = Math.max(1e-9, equity.length / 244);
  const annual = (Math.pow(1 + totalRet / 100, 1 / years) - 1) * 100;
  const dailyRets = [];
  for (let i = 1; i < equity.length; i++) dailyRets.push(equity[i].nav / equity[i - 1].nav - 1);
  const mu = dailyRets.length ? dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length : 0;
  const sd = dailyRets.length > 1 ? Math.sqrt(dailyRets.reduce((s, r) => s + (r - mu) ** 2, 0) / (dailyRets.length - 1)) : 0;
  const wins = trades.filter((t) => t.pnl > 0).length;

  return {
    equity,
    dates: axis,
    trades,
    metrics: {
      horizon, topK, execLag, execField,
      initialCapital,
      finalNav: +last.nav.toFixed(2),
      totalReturnPct: +totalRet.toFixed(2),
      annualReturnPct: +annual.toFixed(2),
      maxDrawdownPct: +maxDD.toFixed(2),
      calmar: maxDD > 0 ? +((annual) / maxDD).toFixed(3) : null,
      sharpeDaily: sd > 0 ? +((mu / sd) * Math.sqrt(244)).toFixed(3) : null,
      trades: trades.length,
      winRateTrade: trades.length ? +(wins / trades.length).toFixed(4) : null,
      avgHoldDays: trades.length ? +(trades.reduce((s, t) => s + (t.holdBars || 0), 0) / trades.length).toFixed(1) : null,
      turnoverPct: +(turnover / initialCapital * 100).toFixed(1),
      exposurePct: +(exposureSum / Math.max(1, equity.length) * 100).toFixed(2),
      tradingDays: equity.length,
      // 有效样本量提示：组合回测的独立样本是「交易日数」，不是「交易笔数」
      effectiveN: equity.length,
      avgTradeRetByReason: reasonStats(trades),
      timingMinProb: timing ? timing.minProb : null,
      timingExitProb: timing ? timing.exitProb : null,
      sizing,
    },
  };
}

function reasonStats(trades) {
  const out = {};
  for (const t of trades) {
    out[t.reason] = out[t.reason] || { n: 0, sum: 0 };
    out[t.reason].n++; out[t.reason].sum += t.retPct;
  }
  for (const k of Object.keys(out)) out[k] = { n: out[k].n, avgRetPct: +(out[k].sum / out[k].n).toFixed(3) };
  return out;
}

function emptyMetrics() {
  return { trades: 0, totalReturnPct: 0, annualReturnPct: 0, maxDrawdownPct: 0, calmar: null, sharpeDaily: null, winRateTrade: null, effectiveN: 0 };
}

/**
 * 一次性算好每个事件的两个横截面 z 分（动量、模型），供不同权重复用。
 * 避免在权重扫描时重复聚合 21 个专家。
 *
 * @param {Array}  events        原始事件流（含 votes/regime/horizon/date/code）
 * @param {Object} state         rl 学习状态
 * @param {Object} klinesByCode  { code: klines }，用于算 mom20（决策时可见，无未来函数）
 */
function prepareScores(events, state, klinesByCode) {
  // 建 date→index 索引，避免 O(n²)
  const idxOf = {};
  for (const code of Object.keys(klinesByCode || {})) {
    const m = new Map();
    const ks = klinesByCode[code];
    for (let i = 0; i < ks.length; i++) m.set(ks[i].date, i);
    idxOf[code] = { m, ks };
  }

  const rows = events.map((e) => {
    const p = state ? rl.calibrate(state, e.horizon, rl.aggregate(state, e.horizon, e.votes, e.regime).p) : null;
    let mom = null;
    const rec = idxOf[e.code];
    if (rec && rec.m.has(e.date)) {
      const i = rec.m.get(e.date);
      if (i >= 20) mom = (rec.ks[i].close / rec.ks[i - 20].close - 1) * 100;
    }
    return Object.assign({}, e, { _p: p, _mom: mom });
  });

  const z = (v, arr) => {
    if (v == null || !arr.length) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
    return sd > 0 ? (v - m) / sd : 0;
  };

  const groups = new Map();
  for (const r of rows) {
    const k = r.horizon + '|' + r.date;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [, g] of groups) {
    const ms = g.map((x) => x._mom).filter((x) => x != null);
    const ps = g.map((x) => x._p).filter((x) => x != null);
    for (const r of g) {
      r._zm = r._mom != null ? z(r._mom, ms) : null;
      r._zp = r._p != null ? z(r._p, ps) : null;
    }
  }
  return rows;
}

/**
 * 按指定口径给行打上 rank（就地修改并返回）。
 * mode:
 *   'momentum' → 纯动量 z
 *   'model'    → 纯模型 z
 *   'combined' → w×动量z + (1−w)×模型z   （w=动量权重，1=纯动量、0=纯模型）
 *   'plus'     → 动量z + k×模型z          （k=模型相对动量的倍数；k=0 即纯动量）
 */
function applyRank(rows, mode, v) {
  for (const r of rows) {
    if (mode === 'momentum') r.rank = r._zm;
    else if (mode === 'model') r.rank = r._zp;
    else if (mode === 'plus') {
      const k = v == null ? 1 : v;
      if (r._zm == null && r._zp == null) r.rank = null;
      else r.rank = (r._zm != null ? r._zm : 0) + k * (r._zp != null ? r._zp : 0);
    } else {
      const W = v == null ? 0.5 : v;
      if (r._zm == null && r._zp == null) r.rank = null;
      else r.rank = (r._zm != null ? W * r._zm : 0) + (r._zp != null ? (1 - W) * r._zp : 0);
    }
  }
  return rows;
}

module.exports = { simulatePortfolio, prepareScores, applyRank, FEE_ROUND_TRIP_PCT, MIN_COMMISSION, feeFor, costOf };
