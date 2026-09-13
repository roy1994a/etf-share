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
  fetchDataset, buildEvents,
} = require('./lib/dataset.js');

const DEFAULT_UNIVERSE = UNIVERSE_V2;

// ------------------------------------------------------------ 参数

function parseArgs(argv) {
  const a = {
    bars: BARS_V2, split: 0.6, codes: null, index: '1.000300',
    tune: true, walkforward: true, folds: 4, yahooRange: '3y',
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
function evalTopK(rows, horizon, topK) {
  const universe = rows.filter((r) => r.horizon === horizon);
  const byDate = new Map();
  for (const r of universe) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const trades = [];
  for (const list of byDate.values()) {
    list.sort((a, b) => b.pCal - a.pCal);
    for (let i = 0; i < Math.min(topK, list.length); i++) trades.push(list[i]);
  }
  return Object.assign({ strategy: '截面TopK', topK }, summarizeTrades(trades, universe));
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
    onProgress: (d, total) => { if (d % 10 === 0) console.log(`  …已拉取 ${d}/${total}`); },
  });
  const { records, yahoo, indexKlines } = ds;
  if (indexKlines.length) {
    console.log(`[指数] 沪深300 ${indexKlines.length} 根（${indexKlines[0].date} ~ ${indexKlines[indexKlines.length - 1].date}）来源 ${ds.indexSource}`);
  } else {
    console.warn('[指数] 拉取失败，大盘专家将退化为中性');
  }
  for (const k of Object.keys(yahoo)) {
    console.log(`[海外] ${k} ${yahoo[k].length} 根（${yahoo[k][0].date} ~ ${yahoo[k][yahoo[k].length - 1].date}）`);
  }
  console.log(`[行情] 成功 ${records.length} 个标的，失败/跳过 ${ds.failed} 个`);
  if (!records.length) { console.error('没有可用数据，退出。'); process.exit(1); }
  const span = records.map((r) => r.klines.length);
  const avgBars = +(span.reduce((a, b) => a + b, 0) / span.length).toFixed(0);
  console.log(`[行情] 平均 ${avgBars} 根/标的（最少 ${Math.min(...span)}，最多 ${Math.max(...span)}）`);

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
    experts: ALL_EXPERTS.length, at: new Date().toISOString(),
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
  state.tradingPolicy = { thresholds: liveThreshold, fees: FEE_ROUND_TRIP_PCT, basis: '拟合集(train+val)含费期望最优，交易数≥200' };

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
  STRATEGIES.push({ name: '多周期共振(d3+w1+m1)', fn: (rows) => evalConfluence(rows, chosenThreshold) });
  for (const topK of [3, 5]) {
    STRATEGIES.push({ name: `TopK(${topK})+阈值(w1)`, fn: (rows) => evalTopKThreshold(rows, 'w1', topK, chosenThreshold.w1) });
  }

  const stratVal = STRATEGIES.map((st) => Object.assign({ name: st.name }, st.fn(valRows)));
  const stratTest = STRATEGIES.map((st) => Object.assign({ name: st.name }, st.fn(testRows)));

  // 选策略：**先要求验证集胜率 ≥50%，再取单笔期望最高**（对齐"提高胜率"这个目标）
  // 只看期望会选出"胜率不到一半、靠少数大赢单撑起来"的策略 —— 那种策略实盘极难执行。
  const MIN_TRADES_STRAT = 150;
  const MIN_WINRATE_STRAT = 0.50;
  let bestStrat = null;
  for (const r of stratVal) {
    if (r.trades < MIN_TRADES_STRAT || r.avgRetPct == null) continue;
    if ((r.winRate || 0) < MIN_WINRATE_STRAT) continue;
    if (!bestStrat || r.avgRetPct > bestStrat.avgRetPct) bestStrat = r;
  }
  if (!bestStrat) {
    for (const r of stratVal) {
      if (r.trades < MIN_TRADES_STRAT || r.avgRetPct == null) continue;
      if (!bestStrat || r.avgRetPct > bestStrat.avgRetPct) bestStrat = r;
    }
  }
  const bestStratTest = bestStrat ? stratTest.find((r) => r.name === bestStrat.name) : null;
  state.chosenStrategy = bestStrat
    ? { name: bestStrat.name, valExpectancy: bestStrat.avgRetPct, valWinRate: bestStrat.winRate, valTrades: bestStrat.trades,
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
    const star = (bestStrat && v.name === bestStrat.name) ? ' ⭐' : '';
    lines.push(`| ${v.name}${star} | ${v.trades} | ${P(v.winRate)} | ${F(v.avgRetPct)}% | ${t.trades} | **${P(t.winRate)}** | **${F(t.avgRetPct)}%** | ${F(t.sharpe)} |`);
  }
  lines.push('');
  if (bestStrat) {
    lines.push(`> **选择规则**：${state.chosenStrategy ? state.chosenStrategy.rule : '--'}。`);
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
    strategies: { val: stratVal, test: stratTest, chosen: state.chosenStrategy, confluence: state.confluencePolicy },
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
