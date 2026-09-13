#!/usr/bin/env node
'use strict';
/**
 * train-rl.js —— 历史回测 + Hedge 在线学习训练器
 *
 * 用途：把"手工拍的"专家权重，换成"用真实历史数据在线学出来的"权重，
 *      并且给出**样本外（out-of-sample）**准确率 —— 这是判断"到底靠不靠谱"的唯一硬标准。
 *
 * 用法：
 *   node train-rl.js                        # 默认 400 根日K，70% 训练 / 30% 样本外
 *   node train-rl.js --bars 500 --split 0.7
 *   node train-rl.js --codes 159516,512660  # 指定标的
 *
 * 输出：
 *   data/rl-state.json   学习到的权重 + 标定参数（供 server.js / GUI / 预测使用）
 *   data/rl-report.json  训练与样本外评估报告（JSON）
 *
 * 零依赖，仅使用内置模块 + lib/。
 */

const fs = require('fs');
const path = require('path');

const market = require('./lib/market');
const { computeAll } = require('./lib/indicators');
const { ALL_EXPERTS, TRAINABLE_EXPERTS, EXPERT_LABEL, extractVotes } = require('./lib/signals');
const rl = require('./lib/rl');

const ROOT = __dirname;

// ------------------------------------------------------------ 参数

function parseArgs(argv) {
  const a = { bars: 400, split: 0.6, codes: null, index: '1.000300', tune: true };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--bars') a.bars = parseInt(argv[++i], 10) || 400;
    else if (k === '--split') a.split = parseFloat(argv[++i]) || 0.6;
    else if (k === '--codes') a.codes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--index') a.index = argv[++i];
    else if (k === '--no-tune') a.tune = false;
  }
  return a;
}

function loadPoolCodes() {
  const p = path.join(ROOT, 'notify.config.json');
  const codes = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    for (const it of (cfg.etfPool || [])) if (it && it.code) codes.push(String(it.code));
    for (const it of (cfg.entryWatch || [])) if (it && it.code) codes.push(String(it.code));
  } catch (e) { /* 忽略 */ }
  // 本会话咨询过的、但不在轮动池里的标的
  const extra = ['159981', '002156', '002470', '512400', '159918'];
  for (const c of extra) if (!codes.includes(c)) codes.push(c);
  return codes;
}

// ------------------------------------------------------------ 数据准备

/** 把指数序列按日期对齐到个股 K 线 */
function buildContext(stockKlines, indexKlines) {
  const byDate = new Map();
  for (const k of indexKlines) byDate.set(k.date, k);
  const idxInd = computeAll(indexKlines);
  const idxByDate = new Map();
  for (let i = 0; i < indexKlines.length; i++) {
    idxByDate.set(indexKlines[i].date, { close: indexKlines[i].close, ma60: idxInd.ma60[i], atr: idxInd.atr[i] });
  }
  const indexAligned = new Array(stockKlines.length).fill(null);
  const indexMa60Aligned = new Array(stockKlines.length).fill(null);
  const indexAtrPctAligned = new Array(stockKlines.length).fill(null);
  for (let i = 0; i < stockKlines.length; i++) {
    const d = stockKlines[i].date;
    let rec = idxByDate.get(d);
    if (!rec) {
      // 容忍停牌/缺日：向前找最近一个交易日
      for (let back = 1; back <= 5 && !rec; back++) {
        const dd = stockKlines[i - back] && stockKlines[i - back].date;
        if (dd) rec = idxByDate.get(dd);
      }
    }
    if (!rec) continue;
    indexAligned[i] = rec.close;
    indexMa60Aligned[i] = rec.ma60;
    indexAtrPctAligned[i] = (rec.atr != null && rec.close) ? rec.atr / rec.close * 100 : null;
  }
  return { indexAligned, indexMa60Aligned, indexAtrPctAligned, byDate };
}

/**
 * 生成事件流：每个 (标的, 日期, 周期) 一条
 * 事件 = { date, code, i, horizon, votes, y, regime, price }
 */
function buildEvents(records) {
  const events = [];
  for (const rec of records) {
    const { code, klines, ind, ctx } = rec;
    const maxH = Math.max(...rl.HORIZONS.map((h) => rl.HORIZON_DAYS[h]));
    for (let i = 60; i < klines.length; i++) {
      const votes = extractVotes(klines, ind, i, ctx);
      if (!votes || Object.keys(votes).length === 0) continue;
      const price = klines[i].close;
      const regime = rl.regimeOf({
        indexPrice: ctx.indexAligned[i],
        indexMa60: ctx.indexMa60Aligned[i],
        atrPct: ctx.indexAtrPctAligned[i] != null ? ctx.indexAtrPctAligned[i] : (ind.atr[i] ? ind.atr[i] / price * 100 : null),
      });
      for (const h of rl.HORIZONS) {
        const j = i + rl.HORIZON_DAYS[h];
        if (j >= klines.length) continue;
        const y = klines[j].close > price ? 1 : (klines[j].close < price ? 0 : (klines[j].close >= price ? 1 : 0));
        events.push({ date: klines[i].date, code, i, horizon: h, votes, y, regime, price, futureClose: klines[j].close });
      }
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.code < b.code ? -1 : 1)));
  return events;
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

/** 用学习后的状态评估一批事件（同时给出标定前后的结果） */
function evalLearned(state, events) {
  const acc = {};
  for (const h of rl.HORIZONS) acc[h] = { n: 0, hits: 0, brierSum: 0, cHits: 0, cBrierSum: 0 };
  for (const ev of events) {
    const agg = rl.aggregate(state, ev.horizon, ev.votes, ev.regime);
    const pc = rl.calibrate(state, ev.horizon, agg.p);
    const a = acc[ev.horizon];
    a.n++;
    a.hits += ((agg.p >= 0.5 ? 1 : 0) === ev.y) ? 1 : 0;
    a.brierSum += (agg.p - ev.y) ** 2;
    a.cHits += ((pc >= 0.5 ? 1 : 0) === ev.y) ? 1 : 0;
    a.cBrierSum += (pc - ev.y) ** 2;
  }
  const out = {};
  for (const h of rl.HORIZONS) {
    const a = acc[h];
    out[h] = {
      n: a.n,
      hitRate: a.n ? +(a.hits / a.n).toFixed(4) : null,
      brier: a.n ? +(a.brierSum / a.n).toFixed(4) : null,
      calibHitRate: a.n ? +(a.cHits / a.n).toFixed(4) : null,
      calibBrier: a.n ? +(a.cBrierSum / a.n).toFixed(4) : null,
    };
  }
  return out;
}

// ------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv);
  const codes = args.codes || loadPoolCodes();
  console.log('=== Hedge 在线学习训练器 ===');
  console.log(`标的（${codes.length}）：${codes.join(', ')}`);
  console.log(`日K根数：${args.bars}　训练/样本外切分：${(args.split * 100).toFixed(0)}% / ${((1 - args.split) * 100).toFixed(0)}%`);
  console.log('');

  // 1) 拉指数（自动选源：东财 → 腾讯备用）
  let indexKlines = [];
  try {
    const r = await market.fetchIndexKlineAuto(args.index, args.bars);
    indexKlines = r.klines;
    console.log(`[指数] 沪深300 取得 ${indexKlines.length} 根日K（${indexKlines[0].date} ~ ${indexKlines[indexKlines.length - 1].date}）来源 ${r.source}${r.note ? '（' + r.note + '）' : ''}`);
  } catch (e) {
    console.warn('[指数] 拉取失败，大盘相关专家将退化为中性：' + e.message);
  }

  // 2) 逐个标的拉K线
  const records = [];
  for (const code of codes) {
    try {
      const { klines } = await market.fetchTencentKline('day', args.bars, code);
      if (!klines || klines.length < 90) { console.warn(`[跳过] ${code} 日K不足（${klines ? klines.length : 0}）`); continue; }
      const ind = computeAll(klines);
      const ctx = buildContext(klines, indexKlines);
      records.push({ code, klines, ind, ctx });
      console.log(`[行情] ${code} ${klines.length} 根（${klines[0].date} ~ ${klines[klines.length - 1].date}）`);
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      console.warn(`[跳过] ${code} 拉取失败：${e.message}`);
    }
  }
  if (!records.length) { console.error('没有可用数据，退出。'); process.exit(1); }

  // 3) 事件流
  const events = buildEvents(records);
  console.log(`\n[事件] 共生成 ${events.length} 条 (标的×日期×周期) 样本`);

  // 4) 严格按日期做三段切分（避免未来函数与调参泄漏）
  //    train 60%  —— 学习权重
  //    val   20%  —— 选超参数（η / 遗忘因子 γ）
  //    test  20%  —— 只在最后看一次，作为"唯一可信的成绩单"
  const dates = [...new Set(events.map((e) => e.date))].sort();
  const i1 = Math.floor(dates.length * args.split);
  const i2 = Math.floor(dates.length * (args.split + (1 - args.split) / 2));
  const d1 = dates[i1], d2 = dates[i2];
  const trainEvents = events.filter((e) => e.date < d1);
  const valEvents = events.filter((e) => e.date >= d1 && e.date < d2);
  const testEvents = events.filter((e) => e.date >= d2);
  console.log(`[切分] 训练 ${trainEvents.length} 条（<${d1}）　验证 ${valEvents.length} 条（${d1}~${d2}）　测试 ${testEvents.length} 条（≥${d2}）`);

  // 5) 基准一：原始手工权重
  const priorW = {};
  for (const h of rl.HORIZONS) priorW[h] = normalizePrior(rl.PRIOR_WEIGHTS[h]);
  const priorTest = evalFixed(testEvents, priorW);
  const priorVal = evalFixed(valEvents, priorW);

  // 5b) 基准二：永远 50%（朴素基准 —— 打不过它说明模型没有信息量）
  const naive = (evts) => {
    const out = {};
    for (const h of rl.HORIZONS) {
      const sub = evts.filter((e) => e.horizon === h);
      const ybar = sub.length ? sub.reduce((s, e) => s + e.y, 0) / sub.length : 0.5;
      out[h] = { n: sub.length, hitRate: +(Math.max(ybar, 1 - ybar)).toFixed(4), brier: +(sub.reduce((s, e) => s + (0.5 - e.y) ** 2, 0) / (sub.length || 1)).toFixed(4) };
    }
    return out;
  };
  const naiveTest = naive(testEvents);

  // 6) 超参数搜索（在验证集上选，测试集完全不参与）
  const trainOn = (evts, eta, gamma) => {
    const st = rl.initState();
    st.eta = eta; st.discount = gamma;
    for (const ev of evts) rl.update(st, ev.horizon, ev.votes, ev.y, ev.regime);
    rl.refitCalibration(st);
    return st;
  };
  const meanBrier = (res) => {
    const arr = rl.HORIZONS.map((h) => res[h].brier).filter((v) => v != null);
    return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 9;
  };

  let best = null;
  let valReport = [];
  if (args.tune) {
    console.log('\n[调参] 网格搜索（在验证集上按平均 Brier 选优）');
    console.log('  η      γ        验证集平均Brier  验证集平均命中率');
    for (const eta of [0.03, 0.08, 0.15, 0.3]) {
      for (const gamma of [1, 0.999, 0.995, 0.99]) {
        const st = trainOn(trainEvents, eta, gamma);
        const v = evalLearned(st, valEvents);
        const mb = meanBrier(v);
        const mh = rl.HORIZONS.map((h) => v[h].hitRate).filter((x) => x != null);
        const mhv = mh.reduce((a, b) => a + b, 0) / (mh.length || 1);
        valReport.push({ eta, gamma, brier: +mb.toFixed(4), hitRate: +mhv.toFixed(4) });
        console.log(`  ${String(eta).padEnd(5)}  ${String(gamma).padEnd(7)}  ${mb.toFixed(4).padEnd(15)}  ${(mhv * 100).toFixed(1)}%`);
        if (!best || mb < best.brier - 1e-9) best = { eta, gamma, brier: mb };
      }
    }
    console.log(`[调参] 最优：η = ${best.eta}，γ = ${best.gamma}（验证集平均 Brier ${best.brier.toFixed(4)}）`);
  } else {
    best = { eta: rl.DEFAULT_ETA, gamma: 1 };
  }

  // 7) 用最优超参在 train+val 上重训，然后在 test 上评估（只此一次）
  const fitEvents = trainEvents.concat(valEvents);
  const state = trainOn(fitEvents, best.eta, best.gamma);
  state.trainedFrom = {
    codes, bars: args.bars, split: args.split,
    trainCut: d1, testCut: d2,
    trainSamples: trainEvents.length, valSamples: valEvents.length, testSamples: testEvents.length,
    eta: best.eta, gamma: best.gamma,
    index: args.index, at: new Date().toISOString(),
  };
  console.log(`\n[训练] 在 train+val（${fitEvents.length} 条）上完成重训，测试集评估一次\n`);

  // 7) 评估：拟合集（train+val，偏乐观）与测试集（唯一可信）
  const learnedFit = evalLearned(state, fitEvents);
  const learnedTest = evalLearned(state, testEvents);
  const priorFit = evalFixed(fitEvents, priorW);
  const priorTest2 = evalFixed(testEvents, priorW);

  // 8) 报告
  const lines = [];
  lines.push('# Hedge 学习器训练报告');
  lines.push('');
  lines.push(`- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push(`- 标的（${records.length}）：${records.map((r) => r.code).join(', ')}`);
  lines.push(`- 样本切分（严格按日期）：训练 ${trainEvents.length}（<${d1}）／验证 ${valEvents.length}（${d1}~${d2}）／**测试 ${testEvents.length}（≥${d2}）**`);
  lines.push(`- 超参数：学习率 η = ${state.eta}，遗忘因子 γ = ${state.discount}（在验证集上选出，测试集未参与）`);
  lines.push(`- 权重下限 = ${state.floor}，分层收缩强度 K = ${rl.SHRINK_K}`);
  lines.push('');
  lines.push('> **读法**：测试集是唯一诚实的成绩单。验证集用于选超参数，训练集用于学权重，两者都会偏乐观。');
  lines.push('');

  const fmt = (v) => v == null ? '--' : v;
  lines.push('## 一、测试集表现（唯一有说服力的指标）');
  lines.push('');
  lines.push('| 周期 | 朴素基准(永远猜多数类) | 手工权重 命中率 | 手工权重 Brier | **学习后 命中率** | **学习后 Brier** | 标定后 Brier | 样本 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const nv = naiveTest[h], p = priorTest2[h], l = learnedTest[h];
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${(nv.hitRate * 100).toFixed(1)}% / ${nv.brier} | ${p.hitRate == null ? '--' : (p.hitRate * 100).toFixed(1) + '%'} | ${fmt(p.brier)} | **${l.hitRate == null ? '--' : (l.hitRate * 100).toFixed(1) + '%'}** | **${fmt(l.brier)}** | ${fmt(l.calibBrier)} | ${l.n} |`);
  }
  lines.push('');
  lines.push('## 二、拟合集表现（train+val，参考，必然偏乐观）');
  lines.push('');
  lines.push('| 周期 | 手工权重 命中率 | 学习后 命中率 | 学习后 Brier | 样本 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const p = priorFit[h], l = learnedFit[h];
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${p.hitRate == null ? '--' : (p.hitRate * 100).toFixed(1) + '%'} | ${l.hitRate == null ? '--' : (l.hitRate * 100).toFixed(1) + '%'} | ${fmt(l.brier)} | ${l.n} |`);
  }
  lines.push('');
  lines.push('## 二·补、超参数网格（验证集，按平均 Brier）');
  lines.push('');
  lines.push('| η | γ（遗忘因子） | 验证集平均 Brier | 验证集平均命中率 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of valReport) {
    const star = (r.eta === best.eta && r.gamma === best.gamma) ? ' ⭐' : '';
    lines.push(`| ${r.eta} | ${r.gamma} | ${r.brier}${star} | ${(r.hitRate * 100).toFixed(1)}% |`);
  }
  lines.push('');

  lines.push('## 三、学到的专家权重（vs 手工先验）');
  lines.push('');
  for (const h of rl.HORIZONS) {
    lines.push(`### ${rl.HORIZON_LABEL[h]}`);
    lines.push('');
    lines.push('| 专家 | 手工先验 | **学到的权重** | 变化 | 方向命中率 | 弃权率 | Brier | 样本 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rl.expertLeaderboard(state, h)) {
      const delta = row.weight - row.priorWeight;
      const arrow = delta > 0.02 ? '⬆️' : delta < -0.02 ? '⬇️' : '—';
      if (!row.trained && row.priorWeight < 0.02) continue; // 隐藏完全无样本的占位专家
      const tag = row.trained ? '' : '（无历史数据·保留先验）';
      lines.push(`| ${EXPERT_LABEL[row.expert] || row.expert}${tag} | ${(row.priorWeight * 100).toFixed(1)}% | **${(row.weight * 100).toFixed(1)}%** | ${arrow} ${(delta * 100).toFixed(1)}pt | ${row.hitRate == null ? '--' : (row.hitRate * 100).toFixed(1) + '%'} | ${row.abstainRate == null ? '--' : (row.abstainRate * 100).toFixed(0) + '%'} | ${row.brier == null ? '--' : row.brier} | ${row.n} |`);
    }
    const c = state.calibration[h];
    lines.push('');
    lines.push(`> 概率标定（Platt）：**a = ${c.a}**，b = ${c.b}（默认只拟合斜率，b 锁 0）${c.fitted ? '' : '（样本不足，未启用）'}。` +
      (c.a < 0.85 ? ` **a < 1 说明原始概率过度自信**，应按此比例向 50% 收缩；` : c.a > 1.15 ? ' a > 1 说明原始概率过于保守；' : ' a ≈ 1 说明原始概率基本已标定；') +
      (c.fitBaseRate != null ? `拟合期基础上涨率 ${(c.fitBaseRate * 100).toFixed(1)}%。` : ''));
    lines.push('');
  }

  lines.push('## 四、Brier 分解（测试集）');
  lines.push('');
  lines.push('Brier = 可靠性 − 分辨力 + 不确定性。**可靠性**衡量"说70%是不是真70%"，越低越好；**分辨力**衡量"能不能把涨和跌分开"，越高越好；**技巧分 = 1 − Brier/不确定性**，>0 才说明比"永远猜基础概率"强。');
  lines.push('');
  lines.push('| 周期 | Brier | 可靠性 | 分辨力 | 不确定性 | 技巧分 | 基础上涨率 | 样本 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const h of rl.HORIZONS) {
    const pairs = testEvents.filter((e) => e.horizon === h).map((e) => {
      const agg = rl.aggregate(state, h, e.votes, e.regime);
      return { p: agg.p, y: e.y };
    });
    const d = rl.brierDecomp(pairs, 10);
    const flag = d.skillScore != null && d.skillScore <= 0 ? ' ⚠️' : '';
    lines.push(`| ${rl.HORIZON_LABEL[h]} | ${d.brier} | ${d.reliability} | ${d.resolution} | ${d.uncertainty} | ${d.skillScore}${flag} | ${d.baseRate} | ${d.n} |`);
  }
  lines.push('');
  lines.push('> ⚠️ 标记的技巧分 ≤ 0，意味着**该周期上模型的概率输出没有超过"直接猜基础上涨率"**。这不是失败，而是必须如实报告的边界。');
  lines.push('');

  const report = lines.join('\n');
  console.log(report);

  // 9) 落盘：本地可写状态 + 随包发布的学习结果（model/ 会提交 git，供公开部署只读使用）
  rl.saveState(state, rl.defaultStatePath());
  try { rl.saveState(state, rl.bundledStatePath()); } catch (e) { console.warn('写入 model/ 失败：' + e.message); }
  const jsonPath = path.join(ROOT, 'data', 'rl-report.json');
  const bundledJsonPath = path.join(ROOT, 'model', 'rl-report.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(bundledJsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({
    trainedAt: new Date().toISOString(),
    config: state.trainedFrom,
    priorTest: priorTest2, learnedTest, priorFit, learnedFit, naiveTest, valReport,
    leaderboard: Object.fromEntries(rl.HORIZONS.map((h) => [h, rl.expertLeaderboard(state, h)])),
    summary: rl.summary(state),
  }, null, 2), 'utf8');
  fs.copyFileSync(jsonPath, bundledJsonPath);

  const mdPath = path.join(ROOT, 'reports', `Hedge学习器训练报告-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`);
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(mdPath, report, 'utf8');

  console.log('已写入：');
  console.log('  ' + rl.defaultStatePath());
  console.log('  ' + jsonPath);
  console.log('  ' + mdPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
