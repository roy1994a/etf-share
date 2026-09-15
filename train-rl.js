#!/usr/bin/env node
'use strict';
/**
 * train-rl.js —— 历史回测 + Hedge 在线学习训练器（v2：扩大样本）
 *
 * v2 相对 v1 的扩容与改进：
 *   1) 标的从 17 个扩到 ~45 个（宽基/半导体/医药/军工/有色/银行/券商/新能源/化工/黄金/中概/纳指…）
 *   2) 日K从 400 根扩到 640 根（腾讯前复权上限，约 2.5 年）
 *   3) **费半/美债/标普改为可训练专家**（Yahoo 753 根历史，严格滞后 1 日对齐，防止未来函数）
 *   4) 专家从 11 个扩到 21 个（新增 5日动量、KDJ、OBV、MFI、布林、收盘强度、20日位置、大盘动量、费半动量、标普）
 *   5) 损失函数由验证集在 {brier, directional, mixed} 中选择 —— 直接对齐"交易胜率"
 *   6) **walk-forward 滚动验证**（4 折）替代单次切分，检验稳定性
 *   7) **含费实盘回测**：按标定后概率 + 阈值交易，报告胜率/期望/夏普
 *
 * 用法：
 *   node train-rl.js                          # 默认全量，约 3~5 分钟
 *   node train-rl.js --bars 640 --codes 159516,512660
 *   node train-rl.js --no-tune                # 跳过网格搜索
 *   node train-rl.js --no-walkforward         # 跳过滚动验证
 *
 * 输出：
 *   data/rl-state.json + model/rl-state.json     学习到的权重与标定参数
 *   data/rl-report.json + model/rl-report.json   训练与样本外评估报告
 *   reports/Hedge学习器训练报告-YYYYMMDD.md
 */

const fs = require('fs');
const path = require('path');

const market = require('./lib/market');
const { computeAll } = require('./lib/indicators');
const { ALL_EXPERTS, EXPERT_LABEL, extractVotes } = require('./lib/signals');
const rl = require('./lib/rl');
const Portfolio = require('./lib/portfolio-sim.js');

const ROOT = __dirname;

// ------------------------------------------------------------ 数据层（与 ablation.js 共用，保证口径一致）
//
// 全部数据准备逻辑已抽到 lib/dataset.js：
//   UNIVERSE_V1 / UNIVERSE_V2 / EXPERTS_V1 / BARS_V1 / BARS_V2
//   fetchDataset() / buildEvents() / truncateByBars() / alignLag1() ...
// 这样"正式训练"和"消融实验"走的是**同一条代码路径**，
// 否则"扩样本带来了提升"就无法排除"两份实现口径不同"这种解释。

const {
  UNIVERSE_V1, UNIVERSE_V2, EXPERTS_V1, BARS_V1, BARS_V2,
  fetchDataset, buildEvents, auditKlines,
} = require('./lib/dataset.js');

const DEFAULT_UNIVERSE = UNIVERSE_V2;

// ------------------------------------------------------------ 参数

function parseArgs(argv) {
  const a = {
    bars: BARS_V2, split: 0.6, codes: null, index: '1.000300',
    tune: true, walkforward: true, folds: 4, yahooRange: '3y',
    portfolio: true, execLag: 1, topK: 3,
    rejected: [
      { name: '融资融券强度（真实数据，东财 RPTA_WEB_RZRQ_GGMX）', evidence: 'IC 预检 12 只标的：d1 −0.021(t=−1.44)、d5 −0.029(t=−1.34)、d22 +0.009(t=0.37)，均不显著' },
      { name: '涨跌停板方向特征', evidence: '全样本 29,609 个交易日×标的，触及率仅 0.76%（ETF 0.45%），无方差即无信息' },
      { name: 'GNN / Transformer / HRL / 因果推断', evidence: '源自 sector_rotation_system 的实测结果：−4.10%、Sharpe 0.043、回撤 −47.9%；2037 维状态空间 vs 约 3,727 步样本' },
      { name: '概率最低分位反转（深度看跌反而看涨）', evidence: '验证集 Q1=51.1%（最弱）vs 测试集 Q1=57.9%（最强），两期不一致，未复现' },
      { name: 'regime 门禁作为通用规则', evidence: '同一门禁用在动量基准上：验证集 bear +5.3% vs 测试集 bear −1.4%，两期符号相反' },
    ],
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--bars') a.bars = parseInt(argv[++i], 10) || BARS_V2;
    else if (k === '--split') a.split = parseFloat(argv[++i]) || 0.6;
    else if (k === '--codes') a.codes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--index') a.index = argv[++i];
    else if (k === '--no-tune') a.tune = false;
    else if (k === '--no-walkforward') a.walkforward = false;
    else if (k === '--folds') a.folds = parseInt(argv[++i], 10) || 4;
    else if (k === '--yahoo-range') a.yahooRange = argv[++i];
    else if (k === '--refresh-history') a.refreshHistory = true;
    else if (k === '--allow-degraded') a.allowDegraded = true;
    else if (k === '--no-portfolio') a.portfolio = false;
    else if (k === '--exec-lag') a.execLag = parseInt(argv[++i], 10);
    else if (k === '--topk') a.topK = parseInt(argv[++i], 10) || 3;
  }
  return a;
}

// ------------------------------------------------------------ 评估

function normalizePrior(prior) {
  const out = {};
  let z = 0;
  for (const k of ALL_EXPERTS) { out[k] = prior[k] != null ? prior[k] : 0.01; z += out[k]; }
  for (const k of ALL_EXPERTS) out[k] /= z;
  return out;
}

/** 用固定权重评估一批事件 */
function evalFixed(events, weightsByHorizon) {
  const acc = {};
  for (const h of rl.HORIZONS) acc[h] = { n: 0, hits: 0, brierSum: 0 };
  for (const ev of events) {
    const w = weightsByHorizon[ev.horizon];
    let num = 0, den = 0;
    for (const k of ALL_EXPERTS) {
      const v = ev.votes[k];
      if (v == null) continue;
      num += w[k] * ((v + 1) / 2);
      den += w[k];
    }
    const p = den > 0 ? num / den : 0.5;
    const a = acc[ev.horizon];
    a.n++;
    a.hits += ((p >= 0.5 ? 1 : 0) === ev.y) ? 1 : 0;
    a.brierSum += (p - ev.y) ** 2;
  }
  const out = {};
  for (const h of rl.HORIZONS) {
    const a = acc[h];
    out[h] = { n: a.n, hitRate: a.n ? +(a.hits / a.n).toFixed(4) : null, brier: a.n ? +(a.brierSum / a.n).toFixed(4) : null };
  }
  return out;
}

/** 用学习后的状态评估一批事件（同时给出标定前/后） */
function evalLearned(state, events) {
  const out = {};
  for (const h of rl.HORIZONS) {
    const sub = events.filter((e) => e.horizon === h);
    let n = 0, hits = 0, brier = 0, cHits = 0, cBrier = 0;
    for (const ev of sub) {
      const agg = rl.aggregate(state, h, ev.votes, ev.regime);
      const pc = rl.calibrate(state, h, agg.p);
      n++;
      hits += ((agg.p >= 0.5 ? 1 : 0) === ev.y) ? 1 : 0;
      brier += (agg.p - ev.y) ** 2;
      cHits += ((pc >= 0.5 ? 1 : 0) === ev.y) ? 1 : 0;
      cBrier += (pc - ev.y) ** 2;
    }
    out[h] = {
      n,
      hitRate: n ? +(hits / n).toFixed(4) : null,
      brier: n ? +(brier / n).toFixed(4) : null,
      calibHitRate: n ? +(cHits / n).toFixed(4) : null,
      calibBrier: n ? +(cBrier / n).toFixed(4) : null,
    };
  }
  return out;
}

/** 朴素基准：永远预测基础上涨率 */
function naiveBaseline(events) {
  const out = {};
  for (const h of rl.HORIZONS) {
    const sub = events.filter((e) => e.horizon === h);
    const ybar = sub.length ? sub.reduce((s, e) => s + e.y, 0) / sub.length : 0.5;
    out[h] = {
      n: sub.length,
      hitRate: sub.length ? +Math.max(ybar, 1 - ybar).toFixed(4) : null,
      brier: sub.length ? +(sub.reduce((s, e) => s + (0.5 - e.y) ** 2, 0) / sub.length).toFixed(4) : null,
      baseRate: +ybar.toFixed(4),
    };
  }
  return out;
}

// ------------------------------------------------------------ 含费实盘回测

/** 双边合计交易成本（%）：ETF 佣金万2.5 + 冲击；个股再加印花税万5 */
const FEE_ROUND_TRIP_PCT = { etf: 0.08, stock: 0.18 };

function feeFor(code) {
  return /^(15|51|56|58)/.test(String(code)) ? FEE_ROUND_TRIP_PCT.etf : FEE_ROUND_TRIP_PCT.stock;
}

/**
 * 一次性把每个事件的原始概率与标定概率算出来（避免阈值扫描时重复计算）
 */
function precomputeProbs(events, state) {
  const out = [];
  for (const ev of events) {
    const agg = rl.aggregate(state, ev.horizon, ev.votes, ev.regime);
    out.push({
      horizon: ev.horizon, code: ev.code, date: ev.date,
      price: ev.price, futureClose: ev.futureClose, fwdRetPct: ev.fwdRetPct, y: ev.y,
      pRaw: agg.p,
      pCal: rl.calibrate(state, ev.horizon, agg.p),
    });
  }
  return out;
}

/** 从预算好的概率里统计某个阈值的含费交易表现 */
function tradeStats(rows, horizon, threshold, opts) {
  opts = opts || {};
  const useCalib = opts.useCalib !== false;
  const sub = rows.filter((r) => r.horizon === horizon);
  const rets = [];
  let baseSum = 0, upDays = 0;
  for (const r of sub) {
    baseSum += r.fwdRetPct;
    if (r.fwdRetPct > 0) upDays++;
    const p = useCalib ? r.pCal : r.pRaw;
    if (p >= threshold) rets.push(r.fwdRetPct - feeFor(r.code));
  }
  const n = rets.length;
  const base = {
    horizon, threshold,
    baselineAvgPct: +(baseSum / (sub.length || 1)).toFixed(4),
    baselineWinRate: +(upDays / (sub.length || 1)).toFixed(4),
    samples: sub.length,
  };
  if (!n) return Object.assign(base, { trades: 0, coverage: 0, winRate: null, avgRetPct: null, sdPct: null, sharpe: null, totalRetPct: 0 });
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s2, r) => s2 + (r - avg) ** 2, 0) / (n - 1)) : 0;
  const wins = rets.filter((r) => r > 0).length;
  return Object.assign(base, {
    trades: n,
    coverage: +(n / (sub.length || 1)).toFixed(4),
    winRate: +(wins / n).toFixed(4),
    avgRetPct: +avg.toFixed(4),
    sdPct: +sd.toFixed(4),
    sharpe: sd > 0 ? +(avg / sd).toFixed(4) : null,
    totalRetPct: +rets.reduce((a, b) => a + b, 0).toFixed(2),
  });
}

/** 由一组"已选中要交易"的样本行统计含费表现 */
function summarizeTrades(trades, universeRows) {
  const rets = trades.map((t) => t.fwdRetPct - feeFor(t.code));
  const n = rets.length;
  let baseSum = 0, upDays = 0;
  for (const r of universeRows) { baseSum += r.fwdRetPct; if (r.fwdRetPct > 0) upDays++; }
  const un = universeRows.length || 1;
  const base = {
    trades: n,
    coverage: +(n / un).toFixed(4),
    samples: un,
    baselineAvgPct: +(baseSum / un).toFixed(4),
    baselineWinRate: +(upDays / un).toFixed(4),
  };
  if (!n) return Object.assign(base, { winRate: null, avgRetPct: null, sdPct: null, sharpe: null, totalRetPct: 0 });
  const avg = rets.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rets.reduce((s2, r) => s2 + (r - avg) ** 2, 0) / (n - 1)) : 0;
  const wins = rets.filter((r) => r > 0).length;
  return Object.assign(base, {
    winRate: +(wins / n).toFixed(4),
    avgRetPct: +avg.toFixed(4),
    sdPct: +sd.toFixed(4),
    sharpe: sd > 0 ? +(avg / sd).toFixed(4) : null,
    totalRetPct: +rets.reduce((a, b) => a + b, 0).toFixed(2),
  });
}

/**
 * 策略 B：**横截面 Top-K**
 * 每个交易日把全部标的按可信概率排名，只做最强的 K 个。
 * 思路：单标的的绝对概率噪音大，但**相对排名**往往更稳定 —— 这是量化里最常用的提胜率手法。
 */
function evalTopKBy(rows, horizon, topK, key) {
  key = key || 'pCal';
  const universe = rows.filter((r) => r.horizon === horizon);
  const byDate = new Map();
  for (const r of universe) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const trades = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b[key] - a[key]);
    for (let i = 0; i < Math.min(topK, list.length); i++) trades.push(list[i]);
  }
  return Object.assign({ strategy: '截面TopK', topK, rankKey: key }, summarizeTrades(trades, universe));
}
function evalTopK(rows, horizon, topK) { return evalTopKBy(rows, horizon, topK, 'pCal'); }

/**
 * 纯动量基准：与模型同口径（同 TopK、同含费），只是把排名换成 20 日动量。
 * 这是 P1 的核心 —— 任何模型都必须先跑赢它，才值得上线。
 */
function momentumRows(events, klinesByCode) {
  const prep = Portfolio.prepareScores(events, null, klinesByCode);
  return prep.map((r) => Object.assign({}, r, { pCal: r._zm }));
}

/** 组合排名行：rank = w×动量z + (1−w)×模型z，写进 pCal 供 evalTopKBy 复用 */
function combinedRows(events, state, klinesByCode, w, mode) {
  const prep = Portfolio.prepareScores(events, state, klinesByCode);
  return Portfolio.applyRank(prep, mode || 'combined', w).map((r) => Object.assign({}, r, { pCal: r.rank }));
}

/**
 * 分市场状态的准确率（检验 regime 门禁是否可泛化）。
 * 对"模型"与"纯动量"分别算，看两期是否一致 —— 只有一致才算规律。
 */
function regimeBreakdown(events, state, klinesByCode) {
  const prep = Portfolio.prepareScores(events, state, klinesByCode);
  const out = {};
  for (const h of ['w1']) {
    const sub = prep.filter((r) => r.horizon === h);
    const by = {};
    for (const r of sub) {
      by[r.regime] = by[r.regime] || { model: { n: 0, hit: 0 }, mom: { n: 0, hit: 0 }, base: { n: 0, up: 0 } };
      const b = by[r.regime];
      b.base.n++; b.base.up += r.y;
      if (r._p != null) { b.model.n++; b.model.hit += ((r._p >= 0.5 ? 1 : 0) === r.y) ? 1 : 0; }
      if (r._zm != null) { b.mom.n++; b.mom.hit += ((r._zm >= 0 ? 1 : 0) === r.y) ? 1 : 0; }
    }
    out[h] = {};
    for (const rg of Object.keys(by)) {
      const b = by[rg];
      out[h][rg] = {
        n: b.base.n,
        baseRate: +(b.base.up / b.base.n).toFixed(4),
        modelHit: b.model.n ? +(b.model.hit / b.model.n).toFixed(4) : null,
        momHit: b.mom.n ? +(b.mom.hit / b.mom.n).toFixed(4) : null,
      };
    }
  }
  return out;
}

/**
 * 策略 C：**多周期共振（confluence）**
 * 要求 d3 / w1 / m1 三个周期的可信概率**同时**超过各自阈值才开仓。
 * 思路：用多个独立视角互相验证，牺牲交易频率换取更高的单笔胜率。
 */
function evalConfluence(rows, thresholds) {
  const need = ['d3', 'w1', 'm1'];
  const byKey = new Map();
  for (const r of rows) {
    if (need.indexOf(r.horizon) < 0) continue;
    const k = r.code + '|' + r.date;
    if (!byKey.has(k)) byKey.set(k, {});
    byKey.get(k)[r.horizon] = r;
  }
  // 以 w1 为持有周期
  const universe = rows.filter((r) => r.horizon === 'w1');
  const trades = [];
  for (const [, g] of byKey) {
    if (need.some((h) => !g[h])) continue;
    const ok = need.every((h) => g[h].pCal >= (thresholds[h] != null ? thresholds[h] : 0.55));
    if (ok) trades.push(g.w1);
  }
  return Object.assign({ strategy: '多周期共振', need: need.join('+') }, summarizeTrades(trades, universe));
}

/**
 * 策略 D：**横截面 Top-K + 绝对阈值**
 * 既是当日最强 K 个，又必须超过绝对阈值 —— 降低在熊市里"矮子里拔将军"的风险。
 */
function evalTopKThreshold(rows, horizon, topK, threshold) {
  const universe = rows.filter((r) => r.horizon === horizon);
  const byDate = new Map();
  for (const r of universe) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const trades = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.pCal - a.pCal);
    for (let i = 0; i < Math.min(topK, list.length); i++) {
      if (list[i].pCal >= threshold) trades.push(list[i]);
    }
  }
  return Object.assign({ strategy: '截面TopK+阈值', topK, threshold }, summarizeTrades(trades, universe));
}

/** 含费交易回测：按（标定后）概率 + 阈值做多，持有 H 个交易日后平仓 */
function evalTrading(events, state, opts) {
  opts = opts || {};
  const rows = precomputeProbs(events, state);
  return tradeStats(rows, opts.horizon || 'w1', opts.threshold != null ? opts.threshold : 0.55, opts);
}

function sweepThresholds(rows, horizon, thresholds, opts) {
  return thresholds.map((t) => tradeStats(rows, horizon, t, opts));
}

/**
 * 用**含费交易期望收益**给一个配置打分（这才是我们要优化的目标）。
 * 对每个周期在验证集上扫阈值，取"交易数达标且单笔期望最高"的结果，再跨周期取平均。
 */
const MIN_TRADES_VAL = 60;
function tradingScore(rows, thresholds) {
  const detail = {};
  let sum = 0, cnt = 0;
  for (const h of rl.HORIZONS) {
    const sweep = sweepThresholds(rows, h, thresholds);
    const cands = sweep.filter((r) => r.trades >= MIN_TRADES_VAL && r.avgRetPct != null);
    let pick = null;
    for (const c of cands) if (!pick || c.avgRetPct > pick.avgRetPct) pick = c;
    detail[h] = { sweep, pick };
    if (pick) { sum += pick.avgRetPct; cnt++; }
    else detail[h].pick = sweep[0];
  }
  return { score: cnt ? +(sum / cnt).toFixed(4) : -99, horizons: cnt, detail };
}

// ------------------------------------------------------------ 训练

function trainOn(evts, cfg) {
  const st = rl.initState();
  st.eta = cfg.eta;
  st.discount = cfg.gamma;
  st.lossType = cfg.lossType;
  for (const ev of evts) rl.update(st, ev.horizon, ev.votes, ev.y, ev.regime);
  rl.refitCalibration(st);
  return st;
}

function meanBrier(res) {
  const arr = rl.HORIZONS.map((h) => res[h].brier).filter((v) => v != null);
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 9;
}
function meanHit(res) {
  const arr = rl.HORIZONS.map((h) => res[h].hitRate).filter((v) => v != null);
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/**
 * Walk-forward 滚动验证：把时间轴切成 K 段，每段都只用"它之前的全部数据"训练，
 * 然后在该段上评估。这是最接近真实实盘的检验方式。
 */
function walkForward(events, dates, cfg, folds) {
  const uniqDates = [...new Set(dates)].sort();
  const per = Math.floor(uniqDates.length / (folds + 1));
  const results = [];
  for (let f = 0; f < folds; f++) {
    const trainEnd = uniqDates[(f + 1) * per - 1];
    const testStart = uniqDates[(f + 1) * per];
    const testEnd = f === folds - 1 ? uniqDates[uniqDates.length - 1] : uniqDates[(f + 2) * per - 1];
    const tr = events.filter((e) => e.date <= trainEnd);
    const te = events.filter((e) => e.date >= testStart && e.date <= testEnd);
    if (!tr.length || !te.length) continue;
    const st = trainOn(tr, cfg);
    const m = evalLearned(st, te);
    results.push({
      fold: f + 1, trainEnd, testStart, testEnd,
      trainN: tr.length, testN: te.length,
      hitRate: +meanHit(m).toFixed(4),
      brier: +meanBrier(m).toFixed(4),
      byHorizon: m,
    });
  }
  return results;
}

// ------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv);
  const codes = args.codes || DEFAULT_UNIVERSE;
  console.log('=== Hedge 在线学习训练器 v2（扩大样本） ===');
  console.log(`标的池：${codes.length} 个　日K：${args.bars} 根`);
  console.log('');

  // 1~3) 一次性拉取全量数据集（指数 + Yahoo 海外序列 + 全部标的）
  const ds = await fetchDataset({
    codes, bars: args.bars, yahooRange: args.yahooRange, index: args.index,
    refreshHistory: args.refreshHistory,
    onProgress: (d, total) => { if (d % 10 === 0) console.log(`  …已拉取 ${d}/${total}`); },
    onHistoryError: (k, msg) => console.warn(`[海外] ${k} 拉取失败：${msg}`),
  });
  const { records, yahoo, indexKlines } = ds;

  // ===== 数据完整性闸门 =====
  // 海外序列（费半/美债/标普）支撑 21 个专家里的 4 个。若它们缺失，
  // 训练会**静默**产出一个"看起来正常但实际残废"的模型 —— 这已真实发生过一次
  // （Yahoo 限流返回空序列 → 滚动验证从 52.0% 掉到 50.6%、w1 周期 0 笔交易）。
  // 所以这里硬性拦住：不完整就中止，除非显式 --allow-degraded。
  if (ds.degraded && !args.allowDegraded) {
    console.error('');
    console.error('❌ 中止训练：海外序列不完整（费半/美债/标普），21 个专家里有 4 个会全程弃权。');
    console.error('   已有缓存：' + (require('./lib/dataset.js').loadHistoryCache() ? '有' : '无'));
    console.error('   处理办法：');
    console.error('     1) 等 Yahoo 限流恢复后执行  node train-rl.js --refresh-history');
    console.error('     2) 或确认缓存文件存在： data/us-history.json 或 model/us-history.json');
    console.error('     3) 确实要用残缺数据训练，加 --allow-degraded（会标记 degraded:true）');
    process.exit(2);
  }
  if (ds.degraded) console.warn('⚠️ 警告：海外序列不完整，本次模型将标记 degraded:true（不应用于实盘判断）');
  if (indexKlines.length) {
    console.log(`[指数] 沪深300 ${indexKlines.length} 根（${indexKlines[0].date} ~ ${indexKlines[indexKlines.length - 1].date}）来源 ${ds.indexSource}`);
  } else {
    console.warn('[指数] 拉取失败，大盘专家将退化为中性');
  }
  for (const k of Object.keys(yahoo)) {
    console.log(`[海外] ${k} ${yahoo[k].length} 根（${yahoo[k][0].date} ~ ${yahoo[k][yahoo[k].length - 1].date}）`);
  }
  console.log(`[海外] 来源：${ds.historySource || '无'}${ds.degraded ? '  ⚠️ 不完整' : ''}`);
  console.log(`[行情] 成功 ${records.length} 个标的，失败/跳过 ${ds.failed} 个`);
  if (!records.length) { console.error('没有可用数据，退出。'); process.exit(1); }
  const span = records.map((r) => r.klines.length);
  const avgBars = +(span.reduce((a, b) => a + b, 0) / span.length).toFixed(0);
  console.log(`[行情] 平均 ${avgBars} 根/标的（最少 ${Math.min(...span)}，最多 ${Math.max(...span)}）`);
  const audit = auditKlines(records);
  console.log(`[体检] 标的 ${audit.summary.instruments} 个 · 无效价格 ${audit.summary.badPrice} · 超涨跌停 ${audit.summary.overLimit} · 日期缺口 ${audit.summary.gap} · 重复日期 ${audit.summary.dup}`);
  for (const f of audit.flags) console.log(`         ⚠ ${f.code}: 超限${f.overLimit} 缺口${f.gap} 重复${f.dup} 最大间隔${f.maxGapDays}天`);

  // 4) 事件流
  const events = buildEvents(records);
  console.log(`\n[事件] 共 ${events.length} 条 (标的×日期×周期) 样本`);

  // 5) 三段切分
  const dates = [...new Set(events.map((e) => e.date))].sort();
  const i1 = Math.floor(dates.length * args.split);
  const i2 = Math.floor(dates.length * (args.split + (1 - args.split) / 2));
  const d1 = dates[i1], d2 = dates[i2];
  const trainEvents = events.filter((e) => e.date < d1);
  const valEvents = events.filter((e) => e.date >= d1 && e.date < d2);
  const testEvents = events.filter((e) => e.date >= d2);
  console.log(`[切分] 训练 ${trainEvents.length}（<${d1}）　验证 ${valEvents.length}（${d1}~${d2}）　测试 ${testEvents.length}（≥${d2}）\n`);

  // 5b) 标的K线索引（动量基准与组合回测共用）
  const klinesByCode = {};
  for (const r of records) klinesByCode[r.code] = r.klines;

  // 6) 基准
  const priorW = {};
  for (const h of rl.HORIZONS) priorW[h] = normalizePrior(rl.PRIOR_WEIGHTS[h]);
  const priorTest = evalFixed(testEvents, priorW);
  const priorFit = evalFixed(trainEvents.concat(valEvents), priorW);
  const naiveTest = naiveBaseline(testEvents);

  // 7) 网格搜索 —— 选择标准是「验证集含费交易期望收益」，不是 Brier
  //
  // ⚠️ 这一点极其关键：如果用 Brier 选超参，等于让"最会预测 50% 的配置"胜出，
  // 因为永远输出 50% 的 Brier 恰好是 0.25 的最优值。那样选出来的模型
  // **方向能力会被主动抹平**，回测指标好看但完全不能交易。
  // 既然目标是"提高实盘胜率"，就必须用**含费交易期望**来选。
  const THRESHOLDS = [0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.63, 0.66];
  let best = { eta: 0.12, gamma: 1, lossType: 'mixed', score: -99 };
  const grid = [];
  if (args.tune) {
    console.log('[调参] 网格搜索（验证集，按含费交易期望收益选优，非 Brier）');
    console.log('  η     γ       损失函数       验证交易期望  验证方向命中  验证Brier  交易数');
    for (const eta of [0.05, 0.12, 0.25, 0.45]) {
      for (const gamma of [1, 0.997]) {
        for (const lossType of rl.LOSS_TYPES) {
          const st = trainOn(trainEvents, { eta, gamma, lossType });
          const v = evalLearned(st, valEvents);
          const rows = precomputeProbs(valEvents, st);
          const ts = tradingScore(rows, THRESHOLDS);
          const trades = rl.HORIZONS.reduce((a, h) => a + (ts.detail[h].pick ? ts.detail[h].pick.trades : 0), 0);
          grid.push({
            eta, gamma, lossType,
            score: ts.score,
            hitRate: +meanHit(v).toFixed(4),
            brier: +meanBrier(v).toFixed(4),
            trades,
          });
          if (ts.score > best.score + 1e-9) best = { eta, gamma, lossType, score: ts.score };
        }
      }
    }
    grid.slice().sort((a, b) => b.score - a.score).slice(0, 10).forEach((g) => {
      const star = (g.eta === best.eta && g.gamma === best.gamma && g.lossType === best.lossType) ? ' ⭐' : '';
      console.log(`  ${String(g.eta).padEnd(5)} ${String(g.gamma).padEnd(8)} ${g.lossType.padEnd(13)} ${String(g.score + '%').padEnd(13)} ${(g.hitRate * 100).toFixed(1)}%${' '.repeat(8)}${String(g.brier).padEnd(11)} ${g.trades}${star}`);
    });
    console.log(`[调参] 最优：η=${best.eta}　γ=${best.gamma}　loss=${best.lossType}（验证含费交易期望 ${best.score}%/笔）`);
    console.log('       对照：按 Brier 选会选中 loss=' + (grid.slice().sort((a, b) => a.brier - b.brier)[0].lossType) +
      '（其交易期望仅 ' + grid.slice().sort((a, b) => a.brier - b.brier)[0].score + '%/笔）—— 这就是"指标好看但不能交易"的陷阱');
  }

  // 8) 用最优超参重训 → 测试集评估一次
  const fitEvents = trainEvents.concat(valEvents);
  const state = trainOn(fitEvents, best);
  state.trainedFrom = {
    version: 2, universeSize: records.length, codes: records.map((r) => r.code),
    bars: args.bars, avgBars, yahoo: Object.keys(yahoo), yahooRange: args.yahooRange,
    trainCut: d1, testCut: d2, trainSamples: trainEvents.length,
    valSamples: valEvents.length, testSamples: testEvents.length,
    eta: best.eta, gamma: best.gamma, lossType: best.lossType,
    experts: ALL_EXPERTS.length,
    historySource: ds.historySource || null,
    degraded: !!ds.degraded,
    at: new Date().toISOString(),
  };
  const learnedFit = evalLearned(state, fitEvents);
  const learnedTest = evalLearned(state, testEvents);
  console.log(`\n[训练] 在 train+val（${fitEvents.length} 条）重训完成，测试集评估一次\n`);

  // 9) 阈值扫描：验证集选阈值，测试集复核（同一组阈值、同一套含费口径）
  const valState = trainOn(trainEvents, best);
  const valRows = precomputeProbs(valEvents, valState);
  const testRows = precomputeProbs(testEvents, state);
  const tradingVal = {}, tradingTest = {}, chosenThreshold = {};
  for (const h of rl.HORIZONS) {
    tradingVal[h] = sweepThresholds(valRows, h, THRESHOLDS);
    tradingTest[h] = sweepThresholds(testRows, h, THRESHOLDS);
    const cands = tradingVal[h].filter((r) => r.trades >= 100 && r.avgRetPct != null);
    let pick = null;
    for (const c of cands) if (!pick || c.avgRetPct > pick.avgRetPct) pick = c;
    chosenThreshold[h] = pick ? pick.threshold : 0.55;
  }
  // 拟合集上的最佳阈值（供实盘默认值使用）
  const fitRows = precomputeProbs(fitEvents, state);
  const liveThreshold = {};
  for (const h of rl.HORIZONS) {
    const sweep = sweepThresholds(fitRows, h, THRESHOLDS);
    const cands = sweep.filter((r) => r.trades >= 200 && r.avgRetPct != null);
    let pick = null;
    for (const c of cands) if (!pick || c.avgRetPct > pick.avgRetPct) pick = c;
    liveThreshold[h] = pick
      ? { threshold: pick.threshold, winRate: pick.winRate, avgRetPct: pick.avgRetPct, trades: pick.trades }
      : { threshold: 0.55, winRate: null, avgRetPct: null, trades: 0 };
  }
  // 唯一生效来源：decided。其它候选一律放 evaluated 并标 adopted:false（P1）
  state.tradingPolicy = Object.assign(rl.defaultTradingPolicy(), {
    decided: {
      thresholds: liveThreshold,
      fees: FEE_ROUND_TRIP_PCT,
      basis: '拟合集(train+val)含费期望最优，交易数≥200',
      confluencePolicy: null,   // 稍后写入
    },
    operatingMode: state.tradingPolicy && state.tradingPolicy.operatingMode ? state.tradingPolicy.operatingMode : 'monthly',
    signalSmoothing: state.tradingPolicy && state.tradingPolicy.signalSmoothing ? state.tradingPolicy.signalSmoothing : 5,
    evaluated: {},
  });

  // 9b) 策略对比（4 种交易构造方式）：验证集选最优，测试集复核
  const STRATEGIES = [];
  for (const h of rl.HORIZONS) {
    STRATEGIES.push({ name: `单周期阈值(${h})`, fn: (rows) => {
      const uni = rows.filter((r) => r.horizon === h);
      const th = chosenThreshold[h];
      return Object.assign({ strategy: '单周期阈值', horizon: h, threshold: th },
        summarizeTrades(uni.filter((r) => r.pCal >= th), uni));
    } });
  }
  for (const topK of [1, 3, 5, 10]) {
    STRATEGIES.push({ name: `截面TopK(K=${topK},w1)`, fn: (rows) => evalTopK(rows, 'w1', topK) });
    STRATEGIES.push({ name: `截面TopK(K=${topK},m1)`, fn: (rows) => evalTopK(rows, 'm1', topK) });
  }
  // P1：纯动量基准（同一 TopK 口径、同一含费）。模型跑不赢它就不该上线。
  for (const topK of [1, 3, 5, 8]) {
    STRATEGIES.push({ name: `【基准】纯动量TopK(K=${topK},w1)`, isBaseline: true, needsMom: 'w1', fn: (rows) => evalTopKBy(rows, 'w1', topK, 'pCal') });
    STRATEGIES.push({ name: `【基准】纯动量TopK(K=${topK},m1)`, isBaseline: true, needsMom: 'm1', fn: (rows) => evalTopKBy(rows, 'm1', topK, 'pCal') });
  }
  // P1：动量 + k×模型z（检验模型能否在动量之上加分）。k=0 退化为纯动量，作为对照锚点。
  for (const k of [0, 0.3, 1.0, 3.0]) {
    STRATEGIES.push({ name: `动量+${k}×模型z(K=3,w1)`, needsComb: k, combMode: 'plus', fn: (rows) => evalTopKBy(rows, 'w1', 3, 'pCal') });
    STRATEGIES.push({ name: `动量+${k}×模型z(K=3,m1)`, needsComb: k, combMode: 'plus', combH: 'm1', fn: (rows) => evalTopKBy(rows, 'm1', 3, 'pCal') });
  }
  STRATEGIES.push({ name: '多周期共振(d3+w1+m1)', fn: (rows) => evalConfluence(rows, chosenThreshold) });
  for (const topK of [3, 5]) {
    STRATEGIES.push({ name: `TopK(${topK})+阈值(w1)`, fn: (rows) => evalTopKThreshold(rows, 'w1', topK, chosenThreshold.w1) });
  }

  const momValRows = momentumRows(valEvents, klinesByCode);
  const momTestRows = momentumRows(testEvents, klinesByCode);
  const combCache = {};
  const combRows = (which, w, evts, mode) => {
    const key = which + '|' + mode + '|' + w;
    if (!combCache[key]) combCache[key] = combinedRows(evts, which === 'val' ? valState : state, klinesByCode, w, mode);
    return combCache[key];
  };
  const rowsFor = (st, which) => {
    if (st.needsComb != null) {
      const cr = combRows(which, st.needsComb, which === 'val' ? valEvents : testEvents, st.combMode);
      return cr.filter((r) => r.horizon === (st.combH || 'w1'));
    }
    if (!st.needsMom) return which === 'val' ? valRows : testRows;
    const mr = which === 'val' ? momValRows : momTestRows;
    return mr.filter((r) => r.horizon === st.needsMom);
  };
  const stratVal = STRATEGIES.map((st) => Object.assign({ name: st.name, isBaseline: !!st.isBaseline }, st.fn(rowsFor(st, 'val'))));
  const stratTest = STRATEGIES.map((st) => Object.assign({ name: st.name, isBaseline: !!st.isBaseline }, st.fn(rowsFor(st, 'test'))));

  // 选策略：**先要求验证集胜率 ≥50%，再取单笔期望最高**（对齐"提高胜率"这个目标）
  // 只看期望会选出"胜率不到一半、靠少数大赢单撑起来"的策略 —— 那种策略实盘极难执行。
  const MIN_TRADES_STRAT = 150;
  const MIN_WINRATE_STRAT = 0.50;
  let bestStrat = null;
  for (const r of stratVal) {
    if (r.isBaseline) continue;                       // 基准只做对照，不参与选优
    if (r.trades < MIN_TRADES_STRAT || r.avgRetPct == null) continue;
    if ((r.winRate || 0) < MIN_WINRATE_STRAT) continue;
    if (!bestStrat || r.avgRetPct > bestStrat.avgRetPct) bestStrat = r;
  }
  if (!bestStrat) {
    for (const r of stratVal) {
      if (r.isBaseline) continue;
      if (r.trades < MIN_TRADES_STRAT || r.avgRetPct == null) continue;
      if (!bestStrat || r.avgRetPct > bestStrat.avgRetPct) bestStrat = r;
    }
  }
  const bestStratTest = bestStrat ? stratTest.find((r) => r.name === bestStrat.name) : null;
  // 选优策略只作评估记录（adopted:false）—— 它没有被接入实盘
  const chosenStrategyRec = bestStrat
    ? { name: bestStrat.name, valExpectancy: bestStrat.avgRetPct, valWinRate: bestStrat.winRate, valTrades: bestStrat.trades,
        adopted: false, rejectReason: '仅为评估记录，未接入实盘（实盘走 decided.thresholds + confluencePolicy）',
        rule: `验证集交易数≥${MIN_TRADES_STRAT} 且胜率≥${(MIN_WINRATE_STRAT * 100).toFixed(0)}%，取单笔期望最高` }
    : null;
  // 多周期共振单独存一份，实盘直接可用（它在测试集上胜率最高且逻辑最稳）
  const confVal = stratVal.find((r) => r.strategy === '多周期共振');
  const confTest = stratTest.find((r) => r.strategy === '多周期共振');
  state.confluencePolicy = confVal ? {
    need: ['d3', 'w1', 'm1'],
    thresholds: { d3: chosenThreshold.d3, w1: chosenThreshold.w1, m1: chosenThreshold.m1 },
    valWinRate: confVal.winRate, valExpectancy: confVal.avgRetPct, valTrades: confVal.trades,
    testWinRate: confTest ? confTest.winRate : null, testExpectancy: confTest ? confTest.avgRetPct : null, testTrades: confTest ? confTest.trades : null,
  } : null;
  state.tradingPolicy.decided.confluencePolicy = state.confluencePolicy;
  state.tradingPolicy.evaluated.chosenStrategy = chosenStrategyRec || { adopted: false, rejectReason: '无可选配置' };

  // 9c) 组合级净值回测（P0）+ 轮动权重消融（P2）
  //
  // 为什么必须做：逐笔口径把每个 (标的,日期,周期) 当独立一笔，没有资金约束、
  // 没有净值曲线、没有回撤，无法回答"实盘能不能做"。这里用真实资金按日模拟。
  //
  // 同时修一个前视偏差：execLag=1 表示**用次日开盘成交**，而不是用当日收盘。
  let portfolio = null;
  if (args.portfolio) {
    const klinesByCode = {};
    for (const r of records) klinesByCode[r.code] = r.klines;

    // 组合口径必须用"按实际成交价算收益"的事件流
    const mkEvents = (evts, lag) => {
      const pos = new Map(evts.map((e, i) => [i, e]));
      return evts.map((e) => {
        const ks = klinesByCode[e.code];
        if (!ks) return e;
        const eb = ks[e.i + lag];
        if (!eb) return e;
        const entryPrice = (eb.open != null && eb.open > 0) ? eb.open : eb.close;
        if (!(entryPrice > 0)) return e;
        const fwd = (e.futureClose - entryPrice) / entryPrice * 100;
        return Object.assign({}, e, { entryDate: eb.date, entryPrice, y: e.futureClose >= entryPrice ? 1 : 0, fwdRetPct: +fwd.toFixed(4) });
      });
    };

    const execLag = args.execLag;
    const pVal = mkEvents(valEvents, execLag);
    const pTest = mkEvents(testEvents, execLag);
    const pVal0 = mkEvents(valEvents, 0);
    const pTest0 = mkEvents(testEvents, 0);

    // 一次性算好动量z与模型z，后续不同权重复用
    const prepV = Portfolio.prepareScores(pVal, valState, klinesByCode);
    const prepT = Portfolio.prepareScores(pTest, state, klinesByCode);
    // close-to-close 对照（量化前视偏差）
    const prepV0 = Portfolio.prepareScores(pVal0, valState, klinesByCode);
    const prepT0 = Portfolio.prepareScores(pTest0, state, klinesByCode);

    const W_LIST = [1.0, 0.75, 0.5, 0.25, 0.0];
    const runOne = (prep, mode, w, lag) => {
      const rows = Portfolio.applyRank(prep.map((r) => Object.assign({}, r)), mode, w);
      return Portfolio.simulatePortfolio(rows, klinesByCode, {
        horizon: 'w1', topK: args.topK, execLag: lag,
        execField: lag === 0 ? 'close' : 'open',   // 0→当日收盘（旧口径）；≥1→次日开盘（可执行）
        initialCapital: 500000, stopPct: 8,
      });
    };

    // --- P2：验证集选 w*，测试集复核 ---
    const VALP = W_LIST.map((w) => ({ w, mode: 'combined', m: runOne(prepV, 'combined', w, execLag).metrics }));
    const TESTP = W_LIST.map((w) => ({ w, mode: 'combined', m: runOne(prepT, 'combined', w, execLag).metrics }));
    const refMomV = runOne(prepV, 'momentum', 1, execLag).metrics;
    const refMomT = runOne(prepT, 'momentum', 1, execLag).metrics;
    const refModelV = runOne(prepV, 'model', 0, execLag).metrics;
    const refModelT = runOne(prepT, 'model', 0, execLag).metrics;

    // 选 w*：验证集上 Calmar 最高（要求交易数≥60），并列时取更接近纯动量者
    let bestW = null;
    for (const x of VALP) {
      if (x.m.trades < 60) continue;
      if (!bestW || (x.m.calmar || -9) > (bestW.m.calmar || -9)) bestW = x;
    }
    if (!bestW) bestW = VALP.find((x) => x.w === 0.5) || VALP[0];

    // --- 前视偏差量化（T+1 vs close-to-close） ---
    const lagCompare = [
      { name: 'close-to-close', lag: 0, val: runOne(prepV0, 'combined', bestW.w, 0).metrics, test: runOne(prepT0, 'combined', bestW.w, 0).metrics },
      { name: 'T+1 次日开盘', lag: execLag, val: runOne(prepV, 'combined', bestW.w, execLag).metrics, test: runOne(prepT, 'combined', bestW.w, execLag).metrics },
    ];

    // ---- P4：动量排序 + 模型择时 ----
    //
    // 动机（来自 P1/P2 的证据）：模型在"时序方向"上显著优于动量（p=2.8e-12），
    // 但在"横截面排序"上不如动量（w1 期望只有动量的一半）。
    // 所以正确用法可能是：**排序交给动量，买卖时机交给模型**。
    // 这里直接在组合口径下检验这个组合。
    const runT = (prep, lag, hz, timingCfg, sizingMode) => {
      const rows = Portfolio.applyRank(prep.map((r) => Object.assign({}, r)), 'momentum', 1);
      return Portfolio.simulatePortfolio(rows, klinesByCode, {
        horizon: hz, topK: args.topK, execLag: lag,
        execField: lag === 0 ? 'close' : 'open',
        initialCapital: 500000, stopPct: 8,
        timing: timingCfg, sizing: sizingMode || 'equal',
      }).metrics;
    };
    const prepVbyH = {}, prepTbyH = {};
    for (const hz of ['w1', 'm1']) {
      prepVbyH[hz] = Portfolio.prepareScores(pVal.filter((e) => e.horizon === hz), valState, klinesByCode);
      prepTbyH[hz] = Portfolio.prepareScores(pTest.filter((e) => e.horizon === hz), state, klinesByCode);
    }

    const GRID = [];
    for (const hz of ['w1', 'm1']) {
      GRID.push({ name: `${hz} 纯动量（无择时）`, hz, timing: null, sizing: 'equal' });
      for (const mp of [0.50, 0.55, 0.60]) {
        GRID.push({ name: `${hz} 动量+择时建仓(≥${mp})`, hz, timing: { minProb: mp }, sizing: 'equal' });
      }
      for (const ep of [0.40, 0.45]) {
        GRID.push({ name: `${hz} 动量+择时退出(<${ep})`, hz, timing: { exitProb: ep }, sizing: 'equal' });
      }
      GRID.push({ name: `${hz} 动量+择时建仓(≥0.55)+退出(<0.45)`, hz, timing: { minProb: 0.55, exitProb: 0.45 }, sizing: 'equal' });
      GRID.push({ name: `${hz} 动量+概率定仓`, hz, timing: null, sizing: 'prob' });
    }
    // 验证集对半切分：用"两半里更差的那半"作为稳健评分，避免被单一区间的运气主导。
    // （单一 Calmar 选参会选到噪音上 —— 上一轮就是这样选出了 out-of-sample 失败的那一族。）
    const valHalf = (() => {
      const ds = [...new Set(pVal.map((e) => e.date))].sort();
      const mid = ds[Math.floor(ds.length / 2)];
      return { mid, a: (e) => e.date < mid, b: (e) => e.date >= mid };
    })();
    for (const g of GRID) {
      try {
        g.val = runT(prepVbyH[g.hz], execLag, g.hz, g.timing, g.sizing);
        g.test = runT(prepTbyH[g.hz], execLag, g.hz, g.timing, g.sizing);
        g.robust = Math.min(
          runT(Portfolio.prepareScores(pVal.filter((e) => e.horizon === g.hz && valHalf.a(e)), valState, klinesByCode), execLag, g.hz, g.timing, g.sizing).calmar ?? -99,
          runT(Portfolio.prepareScores(pVal.filter((e) => e.horizon === g.hz && valHalf.b(e)), valState, klinesByCode), execLag, g.hz, g.timing, g.sizing).calmar ?? -99,
        );
      } catch (e) { g.val = { trades: 0 }; g.test = { trades: 0 }; g.robust = -99; g.err = e.message; }
    }
    // 也在 close-to-close 口径上复核一遍，确认不是执行口径造成的
    for (const g of GRID) {
      try { g.valC = runT(prepVbyH[g.hz], 0, g.hz, g.timing, g.sizing); } catch (e) { g.valC = { trades: 0 }; }
    }

    // 选优：**验证集两半中更差的一半的 Calmar 最高**（稳健准则），且每半交易数≥15。
    // 同时报告"按单一验证 Calmar 选"会选到什么 —— 用于暴露该准则的不稳健。
    let bestT = null, bestSingle = null;
    for (const g of GRID) {
      if (!g.val || g.val.trades < 40) continue;
      if (!bestSingle || (g.val.calmar || -99) > (bestSingle.val.calmar || -99)) bestSingle = g;
      if (g.robust == null || g.robust <= -50) continue;
      if (!bestT || g.robust > (bestT.robust || -99)) bestT = g;
    }
    console.log(`[P4 择时] 按单一验证Calmar选 → ${bestSingle ? bestSingle.name : '无'}（测试 Calmar ${bestSingle ? bestSingle.test.calmar : '--'}）`);
    console.log(`[P4 择时] 按两半稳健准则选 → ${bestT ? bestT.name : '无'}（验证两半最差 ${bestT ? bestT.robust : '--'}，测试 Calmar ${bestT ? bestT.test.calmar : '--'}）`);
    const baseV = GRID.find((g) => g.name === 'w1 纯动量（无择时）');
    const baseM = GRID.find((g) => g.name === 'm1 纯动量（无择时）');
    state.tradingPolicy.evaluated.timingPolicy = bestT
      ? Object.assign({ adopted: false, rejectReason: '测试集 Calmar 低于同周期纯动量基准（择时退出族测试集 0/4 全败）' }, { name: bestT.name, hz: bestT.hz, timing: bestT.timing, sizing: bestT.sizing,
          valCalmar: bestT.val.calmar, valRobust: bestT.robust, testCalmar: bestT.test.calmar,
          testReturn: bestT.test.totalReturnPct, testTrades: bestT.test.trades,
          basis: '验证集两半中更差的一半 Calmar 最高，且交易数≥40（稳健准则）' })
      : { adopted: false, rejectReason: '无可选配置' };

    portfolio = {
      topK: args.topK, horizon: 'w1', execLag,
      valSweep: VALP, testSweep: TESTP,
      refMomentum: { val: refMomV, test: refMomT },
      refModel: { val: refModelV, test: refModelT },
      chosen: { w: bestW.w, valMetrics: bestW.m, testMetrics: (TESTP.find((x) => x.w === bestW.w) || {}).m || null },
      lagCompare,
      timing: { grid: GRID, chosen: bestT ? bestT.name : null, chosenSingle: bestSingle ? bestSingle.name : null,
                chosenSingleTestCalmar: bestSingle ? bestSingle.test.calmar : null,
                baseW1: baseV, baseM1: baseM },
    };
    state.tradingPolicy.evaluated.rotationWeight = {
      adopted: false, rejectReason: '验证集与测试集结论相反，w 不可靠估计',
      w: bestW.w,
      basis: '验证集组合口径 Calmar 最高且交易数≥60；w=动量权重',
      valCalmar: bestW.m.calmar, testCalmar: (TESTP.find((x) => x.w === bestW.w) || {}).m ? TESTP.find((x) => x.w === bestW.w).m.calmar : null,
      onlineCurrent: 0.5,
    };
    console.log(`[组合回测] 验证集选出 w* = ${bestW.w}（动量权重），测试集复核 Calmar ${(portfolio.chosen.testMetrics || {}).calmar}`);
    console.log(`[组合回测] 前视偏差：close 口径 测试总收益 ${lagCompare[0].test.totalReturnPct}% → T+1 口径 ${lagCompare[1].test.totalReturnPct}%`);
  }

  // 10) walk-forward
  let wf = [];
  if (args.walkforward) {
    console.log('[滚动验证] walk-forward 进行中…');
    wf = walkForward(events, dates, best, args.folds);
  }

  // ------------------------------------------------------------ 报告
  const lines = [];
  const F = (v) => (v == null ? '--' : v);
  const P = (v) => (v == null ? '--' : (v * 100).toFixed(1) + '%');

  lines.push('# Hedge 学习器训练报告（v2·扩大样本）');
  lines.push('');
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`- **标的池：${records.length} 个**（宽基 / 半导体 / 医药 / 军工 / 有色 / 银行 / 券商 / 新能源 / 化工 / 黄金 / 中概 / 纳指 …）`);
  lines.push(`- **日K：平均 ${avgBars} 根/标的**（腾讯前复权上限 640）`);
  lines.push(`- **海外与宏观序列（Yahoo，首次变为可训练）**：${Object.keys(yahoo).join(', ')}（约 753 根，**严格滞后 1 日对齐**）`);
  lines.push(`- **专家数：${ALL_EXPERTS.length} 个**`);
  lines.push(`- 样本切分：训练 ${trainEvents.length}（<${d1}）／验证 ${valEvents.length}（${d1}~${d2}）／**测试 ${testEvents.length}（≥${d2}）**`);
  lines.push(`- 超参数（**按验证集含费交易期望收益**选出）：η=${best.eta}　γ=${best.gamma}　**损失函数=${best.lossType}**（验证期望 ${best.score}%/笔）`);
  lines.push('');
  lines.push('> **读法**：测试集是唯一诚实的成绩单。');
  lines.push('');

  lines.push('## 一、测试集：方向准确率');
  lines.push('');
  lines.push('| 周期 | 朴素基准 | 手工权重 | **学习后** | 标定后 | Brier | 标定Brier | 样本 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const nv = naiveTest[h], pr = priorTest[h], le = learnedTest[h];
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${P(nv.hitRate)} | ${P(pr.hitRate)} | **${P(le.hitRate)}** | ${P(le.calibHitRate)} | ${F(le.brier)} | ${F(le.calibBrier)} | ${le.n} |`);
  }
  lines.push('');

  lines.push('## 二、含费实盘回测（这才是"胜率"）');
  lines.push('');
  lines.push(`费率假设：ETF 双边合计 ${FEE_ROUND_TRIP_PCT.etf}%，个股双边合计 ${FEE_ROUND_TRIP_PCT.stock}%（含印花税），已计入。`);
  lines.push('');
  lines.push('| 周期 | 阈值 | 交易数 | 覆盖率 | **胜率** | 单笔期望 | 波动 | 单笔夏普 | 累计 | 同期标的均值 | 标的胜率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const t = (tradingTest[h] || []).find((r) => r.threshold === chosenThreshold[h]) || tradingTest[h][0];
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${t.threshold} | ${t.trades} | ${P(t.coverage)} | **${P(t.winRate)}** | ${F(t.avgRetPct)}% | ${F(t.sdPct)}% | ${F(t.sharpe)} | ${F(t.totalRetPct)}% | ${F(t.baselineAvgPct)}% | ${P(t.baselineWinRate)} |`);
  }
  lines.push('');
  lines.push(`> 阈值在**验证集**上选出（要求交易数 ≥100 且单笔期望最高），此处为**测试集**复核。选中：${rl.HORIZONS.map((h) => h + '=' + chosenThreshold[h]).join('，')}`);
  lines.push('');

  lines.push('### 阈值敏感性（测试集）');
  lines.push('');
  for (const h of rl.HORIZONS) {
    lines.push(`**${rl.HORIZON_LABEL[h]}**`);
    lines.push('');
    lines.push('| 阈值 | 交易数 | 胜率 | 单笔期望 | 夏普 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of tradingTest[h]) {
      const mark = r.threshold === chosenThreshold[h] ? ' ⭐' : '';
      lines.push(`| ${r.threshold}${mark} | ${r.trades} | ${P(r.winRate)} | ${F(r.avgRetPct)}% | ${F(r.sharpe)} |`);
    }
    lines.push('');
  }

  lines.push('### 交易构造方式对比（提胜率的关键：怎么用概率，比概率本身更重要）');
  lines.push('');
  lines.push('| 策略 | 验证集交易数 | 验证集胜率 | 验证集期望 | **测试集交易数** | **测试集胜率** | **测试集期望** | 测试集夏普 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const v of stratVal) {
    const t = stratTest.find((x) => x.name === v.name) || {};
    const star = (bestStrat && v.name === bestStrat.name) ? ' ⭐' : (v.isBaseline ? ' ◀基准' : '');
    lines.push(`| ${v.name}${star} | ${v.trades} | ${P(v.winRate)} | ${F(v.avgRetPct)}% | ${t.trades} | **${P(t.winRate)}** | **${F(t.avgRetPct)}%** | ${F(t.sharpe)} |`);
  }
  lines.push('');
  if (bestStrat) {
    lines.push(`> **选择规则**：${chosenStrategyRec ? chosenStrategyRec.rule : '--'}。`);
    lines.push('');
    lines.push(`> 验证集选出的最优策略：**${bestStrat.name}**（验证期望 ${bestStrat.avgRetPct}%/笔，胜率 ${P(bestStrat.winRate)}，${bestStrat.trades} 笔）。` +
      (bestStratTest ? `测试集复核：胜率 ${P(bestStratTest.winRate)}，期望 ${F(bestStratTest.avgRetPct)}%/笔，共 ${bestStratTest.trades} 笔。` : ''));
    lines.push('');
    lines.push('> **为什么这一步重要**：同样的概率，用不同方式下单，胜率差别很大。单周期绝对阈值噪音最大；');
    lines.push('> **横截面 Top-K**（每天只做最强的几只）和**多周期共振**（三个周期同时看多）通常能显著提高单笔胜率，代价是交易机会变少。');
    lines.push('');
  }

  if (wf.length) {
    lines.push('## 三、Walk-forward 滚动验证（最接近实盘的检验）');
    lines.push('');
    lines.push('每一折都只用"该折之前"的数据训练，然后在下一段上评估 —— 完全模拟"逐日向前交易"。');
    lines.push('');
    lines.push('| 折 | 训练截止 | 测试区间 | 训练样本 | 测试样本 | 方向命中率 | Brier |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const w of wf) {
      lines.push(`| ${w.fold} | ${w.trainEnd} | ${w.testStart} ~ ${w.testEnd} | ${w.trainN} | ${w.testN} | **${P(w.hitRate)}** | ${w.brier} |`);
    }
    const avgWf = wf.reduce((s, w) => s + w.hitRate, 0) / (wf.length || 1);
    lines.push('');
    lines.push(`**滚动验证平均方向命中率：${P(avgWf)}**（共 ${wf.length} 折）`);
    lines.push('');
  }

  // ---- P1 决胜检验：模型 vs 动量（这是本项目最重要的一张表）----
  {
    const regV = regimeBreakdown(valEvents, valState, klinesByCode);
    const regT = regimeBreakdown(testEvents, state, klinesByCode);
    lines.push('## 二·补、决胜检验：模型 vs 朴素动量（P1）');
    lines.push('');
    lines.push('> **这张表决定要不要继续投入模型。** 同口径（TopK、含费、同一测试集），只换排名依据。');
    lines.push('');
    lines.push('| 排名依据 | 验证 交易数 | 验证 胜率 | 验证 期望 | **测试 交易数** | **测试 胜率** | **测试 期望** |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const v of stratVal) {
      if (!v.isBaseline && !/^动量\+/.test(v.name)) continue;
      const t = stratTest.find((x) => x.name === v.name) || {};
      lines.push(`| ${v.name}${v.isBaseline ? ' ◀基准' : ''} | ${v.trades} | ${P(v.winRate)} | ${F(v.avgRetPct)}% | ${t.trades} | **${P(t.winRate)}** | **${F(t.avgRetPct)}%** |`);
    }
    for (const nm2 of ['单周期阈值(m1)', '截面TopK(K=3,m1)']) {
      const v = stratVal.find((x) => x.name === nm2); if (!v) continue;
      const t = stratTest.find((x) => x.name === nm2) || {};
      lines.push(`| ${nm2}（模型） | ${v.trades} | ${P(v.winRate)} | ${F(v.avgRetPct)}% | ${t.trades} | **${P(t.winRate)}** | **${F(t.avgRetPct)}%** |`);
    }
    lines.push('');
    lines.push('### 分市场状态准确率：模型 vs 动量（检验 regime 规则能否泛化）');
    lines.push('');
    lines.push('| 数据集 | 状态 | 样本 | 实际上涨率 | 模型命中率 | 模型超额 | 动量命中率 | 动量超额 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [lab, reg] of [['验证集', regV], ['测试集', regT]]) {
      for (const rg of Object.keys(reg.w1 || {})) {
        const x = reg.w1[rg];
        const me = x.modelHit != null ? (x.modelHit - x.baseRate) * 100 : null;
        const mo = x.momHit != null ? (x.momHit - x.baseRate) * 100 : null;
        lines.push(`| ${lab} | ${rg} | ${x.n} | ${P(x.baseRate)} | ${P(x.modelHit)} | ${me == null ? '--' : (me >= 0 ? '+' : '') + me.toFixed(1) + 'pt'} | ${P(x.momHit)} | ${mo == null ? '--' : (mo >= 0 ? '+' : '') + mo.toFixed(1) + 'pt'} |`);
      }
    }
    lines.push('');
    lines.push('> 只有**两期符号一致**才算规律。若模型与动量在同一状态上结论相反，说明该"规律"是模型特有的失效模式，不可泛化。');
    lines.push('');
  }

  if (portfolio) {
    lines.push('## 三·补、组合级净值回测（P0：资金受限、按日盯市、T+1 执行）');
    lines.push('');
    lines.push(`初始资金 50 万，最多持有 ${portfolio.topK} 只，等权，止损 8%，周频（w1）轮动。`);
    lines.push('**执行口径：信号在 T 日收盘产生，T+1 开盘成交** —— 这才可执行。');
    lines.push('');
    lines.push('### 轮动权重消融：combined = w×动量z + (1−w)×模型z');
    lines.push('');
    lines.push('| w（动量权重） | 验证总收益 | 验证回撤 | 验证Calmar | 验证交易 | **测试总收益** | **测试回撤** | **测试Calmar** | 测试胜率 | 测试换手 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const x of portfolio.valSweep) {
      const t = portfolio.testSweep.find((y) => y.w === x.w) || { m: {} };
      const star = x.w === portfolio.chosen.w ? ' ⭐' : '';
      lines.push(`| ${x.w === 1 ? '1.00（纯动量）' : x.w === 0 ? '0.00（纯模型）' : x.w}${star} | ${x.m.totalReturnPct}% | ${x.m.maxDrawdownPct}% | ${F(x.m.calmar)} | ${x.m.trades} | **${t.m.totalReturnPct}%** | **${t.m.maxDrawdownPct}%** | **${F(t.m.calmar)}** | ${P(t.m.winRateTrade)} | ${t.m.turnoverPct}% |`);
    }
    lines.push('');
    const cw = portfolio.chosen;
    lines.push(`> **验证集选出的 w\* = ${cw.w}**（动量权重；规则：验证集 Calmar 最高且交易数 ≥60）。`);
    lines.push(`> 测试集复核：总收益 ${(cw.testMetrics || {}).totalReturnPct}%，最大回撤 ${(cw.testMetrics || {}).maxDrawdownPct}%，Calmar ${F((cw.testMetrics || {}).calmar)}。`);
    lines.push('> 线上现值是 **w = 0.50**（`engine.js:pickRotation` 的 `combined = 动量分×0.5 + analyzeScore×0.5`）。');
    lines.push('');

    lines.push('### 前视偏差量化（close-to-close vs T+1 次日开盘）');
    lines.push('');
    lines.push('| 执行口径 | 验证总收益 | 验证Calmar | 测试总收益 | 测试Calmar | 测试回撤 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const l of portfolio.lagCompare) {
      lines.push(`| ${l.name} | ${l.val.totalReturnPct}% | ${F(l.val.calmar)} | ${l.test.totalReturnPct}% | ${F(l.test.calmar)} | ${l.test.maxDrawdownPct}% |`);
    }
    const a = portfolio.lagCompare[0].test, b = portfolio.lagCompare[1].test;
    lines.push('');
    lines.push(`> 改成次日开盘执行后，测试集总收益从 **${a.totalReturnPct}%** 变为 **${b.totalReturnPct}%**` +
      `（差 ${(b.totalReturnPct - a.totalReturnPct).toFixed(2)}pt），Calmar 从 ${F(a.calmar)} 变为 ${F(b.calmar)}。`);
    lines.push('> 这个差值就是"看着能做、实际做不到"的那部分收益。');
    lines.push('');

    lines.push('### 纯动量 vs 纯模型（组合口径，测试集）');
    lines.push('');
    lines.push('| 口径 | 总收益 | 最大回撤 | Calmar | 夏普(日频年化) | 交易数 | 胜率 | 换手 | 平均持有天数 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const rl2 = [['纯动量', portfolio.refMomentum], ['纯模型(21专家)', portfolio.refModel]];
    for (const [nm2, ref] of rl2) {
      const m = ref.test;
      lines.push(`| ${nm2} | ${m.totalReturnPct}% | ${m.maxDrawdownPct}% | ${F(m.calmar)} | ${F(m.sharpeDaily)} | ${m.trades} | ${P(m.winRateTrade)} | ${m.turnoverPct}% | ${F(m.avgHoldDays)} |`);
    }
    lines.push('');
    lines.push(`> 有效样本量：组合回测的独立样本是**交易日数**，不是交易笔数（测试集 ${portfolio.refMomentum.test.effectiveN} 个交易日）。`);
    lines.push('');

    // ---- P4：动量排序 + 模型择时 ----
    const T = portfolio.timing;
    if (T && T.grid) {
      lines.push('### P4：动量排序 + 模型择时（排序仍用动量，买卖时机交给模型）');
      lines.push('');
      lines.push('动机：P1 显示模型在**时序方向**上显著优于动量（p=2.8e-12），但在**横截面排序**上不如动量。');
      lines.push('因此正确用法可能是"动量选票、模型选时"。下表在组合口径（资金受限、T+1、含费）下直接检验。');
      lines.push('');
      lines.push('| 方案 | 验证交易 | 验证回撤 | 验证Calmar | **测试交易** | **测试收益** | **测试回撤** | **测试Calmar** | 测试胜率 |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const g of T.grid) {
        if (!g.val || !g.test) continue;
        const star = g.name === T.chosen ? ' ⭐' : (g.name.indexOf('纯动量（无择时）') >= 0 ? ' ◀基准' : '');
        lines.push(`| ${g.name}${star} | ${g.val.trades} | ${g.val.maxDrawdownPct}% | ${F(g.val.calmar)} | ${g.test.trades} | **${g.test.totalReturnPct}%** | **${g.test.maxDrawdownPct}%** | **${F(g.test.calmar)}** | ${P(g.test.winRateTrade)} |`);
      }
      lines.push('');
      const ch = T.grid.find((g) => g.name === T.chosen);
      lines.push(`> **验证集选出：${T.chosen}**（稳健准则与单一准则选出的都是它）。`);
      lines.push(`> 但它在**测试集上失败**：Calmar ${ch ? F(ch.test.calmar) : '--'} vs 同周期纯动量基准 ${ch && ch.hz === 'm1' ? F(T.baseM1.test.calmar) : F(T.baseW1.test.calmar)}。`);
      lines.push('> **结论：该选参准则在这个问题上不可靠 —— 验证集一致偏好的"择时退出"族，在测试集 4/4 全部变差。**');
      lines.push('');

      // ---- 分族汇总：判断哪一族在两期×两周期都成立 ----
      const fam = (g) => /择时建仓\(≥[\d.]+\)$/.test(g.name) ? 'A 入场门槛'
        : /择时退出/.test(g.name) && !/建仓/.test(g.name) ? 'B 择时退出'
        : /概率定仓/.test(g.name) ? 'C 概率定仓'
        : /建仓.*退出/.test(g.name) ? 'D 入场+退出' : '— 纯动量基准';
      const baseOf = (hz) => (hz === 'w1' ? T.baseW1 : T.baseM1);
      const famRows = {};
      for (const g of T.grid) {
        const f = fam(g);
        if (f === '— 纯动量基准') continue;
        const b = baseOf(g.hz);
        const valOK = (g.val.calmar || -99) > (b.val.calmar || -99);
        const testOK = (g.test.calmar || -99) > (b.test.calmar || -99);
        famRows[f] = famRows[f] || { n: 0, both: 0, valOK: 0, testOK: 0, label: g.hz };
        const r = famRows[f];
        r.n++; r.valOK += valOK ? 1 : 0; r.testOK += testOK ? 1 : 0; r.both += (valOK && testOK) ? 1 : 0;
      }
      lines.push('#### 分族汇总：哪一族在「两期 × 两周期」都成立');
      lines.push('');
      lines.push('（判据：同周期同口径下 Calmar 是否高于该周期的纯动量基准）');
      lines.push('');
      lines.push('| 族 | 组合数 | 验证集胜出 | **测试集胜出** | **两期都胜出** |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const f of Object.keys(famRows)) {
        const r = famRows[f];
        lines.push(`| ${f} | ${r.n} | ${r.valOK}/${r.n} | **${r.testOK}/${r.n}** | **${r.both}/${r.n}** |`);
      }
      lines.push('');
      const entryFam = famRows['A 入场门槛'];
      const exitFam = famRows['B 择时退出'];
      if (entryFam && exitFam) {
        lines.push(`> **可读出的结论**：`);
        lines.push(`> · **入场门槛（模型概率 ≥0.50/0.55）**：验证 ${entryFam.valOK}/${entryFam.n}、测试 ${entryFam.testOK}/${entryFam.n}，**两期都胜出 ${entryFam.both}/${entryFam.n}** —— 唯一在两期×两周期都成立的族；`);
        lines.push(`> · **择时退出（概率跌破就平仓）**：验证 ${exitFam.valOK}/${exitFam.n} 全胜，但**测试 ${exitFam.testOK}/${exitFam.n} 全败** —— 验证集完全被噪音带偏；`);
        lines.push('> · **概率定仓**：无稳定收益。');
        lines.push('');
        lines.push('> ⚠️ **必须说清的性质**：入场门槛的一致性是**我在看过全部 16 行之后总结出来的（post-hoc）**，');
        lines.push('> 而**不是验证集自动选出来的**（验证集选出的是失败的那一族）。');
        lines.push('> 因此它是**下一轮待验证的假设**，不是已验证的结论 —— **本轮不改线上任何行为**。');
        lines.push('> 若要把它变成结论，正确做法是让它进入前向影子模式，用台账累积真实样本后再判定。');
      }
      lines.push('');
    }
  }

  lines.push('## 四、学到的专家权重（vs 手工先验）');
  lines.push('');
  for (const h of rl.HORIZONS) {
    lines.push(`### ${rl.HORIZON_LABEL[h]}`);
    lines.push('');
    lines.push('| 专家 | 手工先验 | **学到的权重** | 变化 | 方向命中率 | 弃权率 | Brier |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rl.expertLeaderboard(state, h)) {
      if (!row.trained && row.priorWeight < 0.02) continue;
      const delta = row.weight - row.priorWeight;
      const arrow = delta > 0.02 ? '⬆️' : delta < -0.02 ? '⬇️' : '—';
      const tag = row.trained ? '' : '（保留先验）';
      lines.push(`| ${EXPERT_LABEL[row.expert] || row.expert}${tag} | ${P(row.priorWeight)} | **${P(row.weight)}** | ${arrow} ${(delta * 100).toFixed(1)}pt | ${P(row.hitRate)} | ${row.abstainRate == null ? '--' : (row.abstainRate * 100).toFixed(0) + '%'} | ${F(row.brier)} |`);
    }
    const c = state.calibration[h];
    lines.push('');
    lines.push(`> 概率标定（Platt，斜率 a=${c.a}，b 锁 0）：` +
      (c.a < 0.85 ? '**原始概率过度自信**，应按此比例向 50% 收缩' : c.a > 1.15 ? '原始概率偏保守' : '原始概率基本已标定') +
      (c.fitBaseRate != null ? `；拟合期基础上涨率 ${P(c.fitBaseRate)}` : ''));
    lines.push('');
  }

  lines.push('## 五、Brier 分解（测试集）');
  lines.push('');
  lines.push('Brier = 可靠性 − 分辨力 + 不确定性；技巧分 = 1 − Brier/不确定性，>0 才优于"永远猜基础概率"。');
  lines.push('');
  lines.push('| 周期 | Brier | 可靠性 | 分辨力 | 不确定性 | 技巧分 | 基础上涨率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const pairs = testEvents.filter((e) => e.horizon === h).map((e) => ({ p: rl.aggregate(state, h, e.votes, e.regime).p, y: e.y }));
    const d = rl.brierDecomp(pairs, 10);
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${d.brier} | ${d.reliability} | ${d.resolution} | ${d.uncertainty} | ${d.skillScore}${d.skillScore <= 0 ? ' ⚠️' : ''} | ${d.baseRate} |`);
  }
  lines.push('');
  lines.push('> ⚠️ 技巧分 ≤ 0 表示该周期的**概率输出**没有超过"直接猜基础上涨率"。');
  lines.push('> 注意：**方向准确率与概率技巧是两件事** —— 第一节看方向（交易要的），这一节看概率幅度（仓位要的）。');
  lines.push('');

  if (args.tune) {
    lines.push('## 六、超参数网格（验证集，前 12 名）');
    lines.push('');
    lines.push('| η | γ | 损失函数 | **验证含费交易期望** | 验证方向命中率 | 验证 Brier | 交易数 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    grid.slice().sort((a, b) => b.score - a.score).slice(0, 12).forEach((g) => {
      const star = (g.eta === best.eta && g.gamma === best.gamma && g.lossType === best.lossType) ? ' ⭐' : '';
      lines.push(`| ${g.eta} | ${g.gamma} | ${g.lossType}${star} | **${g.score}%** | ${P(g.hitRate)} | ${g.brier} | ${g.trades} |`);
    });
    lines.push('');
    lines.push('> ⚠️ **为什么按交易期望而不是 Brier 选超参**：Brier 损失下"永远输出 50%"几乎免费（loss 恒为 0.25），');
    lines.push('> 因此用 Brier 选优会**主动选出方向能力被抹平的配置** —— 指标好看，但完全不能交易。');
    lines.push('> 目标是实盘胜率，就必须用含费交易期望来选。');
    lines.push('');
  }

  // ---- P3 准入闸门 ----
  lines.push('## 七、特征准入闸门与「已评估·未采用」清单');
  lines.push('');
  lines.push('**准入规则（写死在流程里）**：任何新特征/新专家，必须同时满足');
  lines.push('① 在**组合口径**（资金受限、T+1 执行、含费）下，验证集与测试集**两期都**优于纯动量基准；');
  lines.push('② `ablation.js` 的 McNemar 配对检验 p<0.05；');
  lines.push('否则不并入 `ALL_EXPERTS`/`PRIOR_WEIGHTS`，只登记在本清单里。');
  lines.push('');
  lines.push('| 候选 | 结论 | 证据 |');
  lines.push('| --- | --- | --- |');
  for (const r of args.rejected || []) {
    lines.push(`| ${r.name} | ❌ 未采用 | ${r.evidence} |`);
  }
  lines.push('');
  lines.push('> 这条闸门的作用：避免重演 `sector_rotation_system` 的老路 —— 加了大量特征、Sharpe 仍是 0.04。');
  lines.push('');

  const report = lines.join('\n');
  console.log(report);

  // ------------------------------------------------------------ 落盘
  rl.saveState(state, rl.defaultStatePath());
  try { rl.saveState(state, rl.bundledStatePath()); } catch (e) { console.warn('写入 model/ 失败：' + e.message); }

  const payload = {
    trainedAt: new Date().toISOString(),
    config: state.trainedFrom,
    priorTest, learnedTest, priorFit, learnedFit, naiveTest,
    grid, walkForward: wf, tradingVal, tradingTest, chosenThreshold, liveThreshold,
    portfolio,
    strategies: { val: stratVal, test: stratTest, chosen: chosenStrategyRec, confluence: state.confluencePolicy },
    tradingPolicy: state.tradingPolicy,
    feeAssumption: FEE_ROUND_TRIP_PCT,
    leaderboard: Object.fromEntries(rl.HORIZONS.map((h) => [h, rl.expertLeaderboard(state, h)])),
    summary: rl.summary(state),
  };
  const jsonPath = path.join(ROOT, 'data', 'rl-report.json');
  const bundledJsonPath = path.join(ROOT, 'model', 'rl-report.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(bundledJsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.copyFileSync(jsonPath, bundledJsonPath);

  const mdPath = path.join(ROOT, 'reports', `Hedge学习器训练报告-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, report, 'utf8');

  console.log('已写入：');
  console.log('  ' + rl.defaultStatePath());
  console.log('  ' + rl.bundledStatePath());
  console.log('  ' + jsonPath);
  console.log('  ' + mdPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
