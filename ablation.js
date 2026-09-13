#!/usr/bin/env node
'use strict';
/**
 * ablation.js —— 消融实验（Ablation Study）
 *
 * ================== 为什么必须做这件事 ==================
 * 上一版报告说"扩样本把 1 月周期准确率从 46.4% 提到 54.5%"，
 * 但那个对比**不成立**：v1 与 v2 的测试集不是同一段时期
 * （v1 测试集 ≥2026-06-04，v2 ≥2026-03-24），差异可能来自行情本身，
 * 而不是来自扩样本。
 *
 * 本脚本解决这个问题：把扩样本拆成三个可独立开关的维度，
 * 在**完全相同的测试集**上做**配对比较**，并给出显著性检验。
 *
 *   A  v1 基线      17 标的 / 400 根 / 11 专家
 *   B  +更多标的    47 标的 / 400 根 / 11 专家
 *   C  +更长历史    17 标的 / 640 根 / 11 专家
 *   D  +更多专家    17 标的 / 400 根 / 21 专家
 *   E  v2 全量      47 标的 / 640 根 / 21 专家
 *
 * 关键设计：
 *   1) **所有配置共用同一个测试集**（v1 的 17 个标的，最后 20% 的交易日），
 *      所以差异只可能来自"训练侧"，不会来自"考卷不同"。
 *   2) 超参数对全部配置**完全一致**（η/γ/损失函数取正式训练的结果），
 *      消融的是数据与特征，不是调参。
 *   3) 用 **McNemar 配对检验**给出 p 值 —— 只有配对样本才能这样算，
 *      这是"提升是不是噪音"的判据，而不是"数字变大了"。
 *
 * 用法：node ablation.js [--bars 640] [--split 0.8] [--no-fetch]
 */

const fs = require('fs');
const path = require('path');

const {
  UNIVERSE_V1, UNIVERSE_V2, EXPERTS_V1, BARS_V1, BARS_V2,
  fetchDataset, buildEvents, truncateByBars,
} = require('./lib/dataset.js');
const { ALL_EXPERTS } = require('./lib/signals.js');
const rl = require('./lib/rl.js');

const ROOT = __dirname;

// ------------------------------------------------------------ 统计工具

/** Lanczos lgamma */
function lgamma(x) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/** 双侧精确二项检验（p=0.5）：用于 McNemar 的 b/c 不一致对 */
function binomTwoSidedP(b, c) {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let cum = 0;
  for (let i = 0; i <= k; i++) cum += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, 2 * cum);
}

// ------------------------------------------------------------ 评估

/** 在给定测试事件上评估一个已训练状态：方向命中 + 概率指标 */
function evaluate(state, testEvents, thresholds) {
  const byHorizon = {};
  const perEvent = [];   // 用于配对检验：{ horizon, code, date, hit }
  for (const ev of testEvents) {
    const agg = rl.aggregate(state, ev.horizon, ev.votes, ev.regime);
    const pCal = rl.calibrate(state, ev.horizon, agg.p);
    const hit = ((pCal >= 0.5 ? 1 : 0) === ev.y);
    byHorizon[ev.horizon] = byHorizon[ev.horizon] || { n: 0, hits: 0, brierSum: 0, cBrierSum: 0 };
    const b = byHorizon[ev.horizon];
    b.n++;
    b.hits += hit ? 1 : 0;
    b.brierSum += (agg.p - ev.y) ** 2;
    b.cBrierSum += (pCal - ev.y) ** 2;
    perEvent.push({ horizon: ev.horizon, code: ev.code, date: ev.date, hit, pCal, y: ev.y, fwdRetPct: ev.fwdRetPct });
  }
  let n = 0, hits = 0, brierSum = 0, cBrierSum = 0;
  for (const h of Object.keys(byHorizon)) {
    const b = byHorizon[h];
    b.hitRate = +(b.hits / b.n).toFixed(4);
    b.brier = +(b.brierSum / b.n).toFixed(4);
    b.calibBrier = +(b.cBrierSum / b.n).toFixed(4);
    delete b.brierSum; delete b.cBrierSum;
    n += b.n; hits += b.hits; brierSum += b.brier * b.n; cBrierSum += b.calibBrier * b.n;
  }
  // 「不做任何筛选」的基准：同一测试窗口里全部买入并持有
  // 没有这一行，58% 的胜率就无法解读 —— 可能只说明这段行情本身在涨。
  const allRets = perEvent.map((r) => r.fwdRetPct - feeOf(r.code));
  const allWins = allRets.filter((x) => x > 0).length;
  const allIn = {
    trades: allRets.length,
    winRate: allRets.length ? +(allWins / allRets.length).toFixed(4) : null,
    avgRetPct: allRets.length ? +(allRets.reduce((a, b) => a + b, 0) / allRets.length).toFixed(4) : null,
  };

  // 含费交易（固定阈值口径，保证各配置可比）
  const trading = {};
  for (const th of (thresholds || [0.55, 0.60, 0.65])) {
    const rets = [];
    const uni = [];
    for (const r of perEvent) {
      uni.push(r);
      if (r.pCal >= th) rets.push(r.fwdRetPct - feeOf(r.code));
    }
    const wins = rets.filter((x) => x > 0).length;
    trading[th] = {
      trades: rets.length,
      coverage: +(rets.length / (uni.length || 1)).toFixed(4),
      winRate: rets.length ? +(wins / rets.length).toFixed(4) : null,
      avgRetPct: rets.length ? +(rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(4) : null,
    };
  }
  return {
    n, hitRate: +(hits / n).toFixed(4), brier: +(brierSum / n).toFixed(4), calibBrier: +(cBrierSum / n).toFixed(4),
    byHorizon, trading, allIn, perEvent,
  };
}

const FEE = { etf: 0.08, stock: 0.18 };
function feeOf(code) { return /^(15|51|56|58)/.test(String(code)) ? FEE.etf : FEE.stock; }

/** McNemar 配对检验：配置 B 相对基线 A 的提升是否显著 */
function mcnemar(basePer, cfgPer) {
  const key = (r) => `${r.code}|${r.date}|${r.horizon}`;
  const bmap = new Map();
  for (const r of basePer) bmap.set(key(r), r);
  let b = 0, c = 0, both = 0, neither = 0;
  for (const r of cfgPer) {
    const x = bmap.get(key(r));
    if (!x) continue;
    if (!x.hit && r.hit) b++;          // 基线错、新配置对
    else if (x.hit && !r.hit) c++;     // 基线对、新配置错
    else if (x.hit && r.hit) both++;
    else neither++;
  }
  return { b, c, both, neither, delta: b - c, p: binomTwoSidedP(b, c), total: b + c };
}

// ------------------------------------------------------------ 主流程

function parseArgs(argv) {
  const a = { bars: BARS_V2, split: 0.8, fetch: true, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--bars') a.bars = parseInt(argv[++i], 10) || BARS_V2;
    else if (k === '--split') a.split = parseFloat(argv[++i]) || 0.8;
    else if (k === '--no-fetch') a.fetch = false;
    else if (k === '--out') a.out = argv[++i];
  }
  return a;
}

const CACHE = path.join(ROOT, 'data', 'ablation-dataset.json');

async function main() {
  const args = parseArgs(process.argv);
  console.log('=== 消融实验：在完全相同的测试集上，检验扩样本到底有没有用 ===\n');

  // 1) 数据（可缓存，避免反复拉网络）
  let ds;
  if (!args.fetch && fs.existsSync(CACHE)) {
    console.log('[数据] 使用缓存 ' + CACHE);
    const raw = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    // 缓存只存 klines 与 yahoo，上下文重新计算（保证代码口径是最新的）
    const { buildRecord } = require('./lib/dataset.js');
    const indexKlines = raw.indexKlines || [];
    const records = raw.records.map((r) => buildRecord(r.code, r.klines, indexKlines, raw.yahoo));
    ds = { records, yahoo: raw.yahoo, indexKlines, indexSource: 'cache', failed: 0, requested: raw.records.length };
  } else {
    ds = await fetchDataset({ codes: UNIVERSE_V2, bars: args.bars, yahooRange: '3y', onProgress: (d, t) => { if (d % 10 === 0) console.log(`  …已拉取 ${d}/${t}`); } });
    try {
      fs.mkdirSync(path.dirname(CACHE), { recursive: true });
      fs.writeFileSync(CACHE, JSON.stringify({ records: ds.records.map((r) => ({ code: r.code, klines: r.klines })), yahoo: ds.yahoo, indexKlines: ds.indexKlines, at: new Date().toISOString() }));
      console.log('[数据] 已缓存到 ' + CACHE);
    } catch (e) { /* 缓存失败不影响实验 */ }
  }
  const records = ds.records;
  console.log(`[数据] ${records.length} 个标的，海外序列 ${Object.keys(ds.yahoo).join('/')}\n`);

  // 2) 全量事件（21 专家）
  const fullEvents = buildEvents(records, null);
  console.log(`[事件] 全量 ${fullEvents.length} 条`);

  // 3) 公共测试窗口：全量日期序列的最后 (1-split)
  const allDates = [...new Set(fullEvents.map((e) => e.date))].sort();
  const cutIdx = Math.floor(allDates.length * args.split);
  const cutDate = allDates[cutIdx];
  const lastDate = allDates[allDates.length - 1];
  console.log(`[测试窗口] ${cutDate} ~ ${lastDate}（全量日期序列的后 ${((1 - args.split) * 100).toFixed(0)}%）\n`);

  // 4) 关键：所有配置共用同一个测试集 —— v1 的 17 个标的
  const commonTest = fullEvents.filter((e) => UNIVERSE_V1.indexOf(e.code) >= 0 && e.date >= cutDate);
  console.log(`[公共测试集] v1 的 17 个标的 × ${cutDate} 之后 = ${commonTest.length} 条样本`);
  console.log('             （所有配置都在这一份考卷上作答，差异只可能来自训练侧）\n');

  // 5) 超参数：全部配置一致（取正式训练的结果），消融的是数据不是调参
  const trained = rl.loadStateWithFallback();
  const cfg = { eta: trained.eta || 0.05, gamma: trained.discount != null ? trained.discount : 1, lossType: trained.lossType || 'mixed' };
  console.log(`[超参数] 全部配置统一：η=${cfg.eta}　γ=${cfg.gamma}　loss=${cfg.lossType}\n`);

  // 6) 五个配置
  const CONFIGS = [
    { key: 'A', name: 'v1 基线', codes: UNIVERSE_V1, bars: BARS_V1, experts: EXPERTS_V1 },
    { key: 'B', name: '+更多标的', codes: UNIVERSE_V2, bars: BARS_V1, experts: EXPERTS_V1 },
    { key: 'C', name: '+更长历史', codes: UNIVERSE_V1, bars: BARS_V2, experts: EXPERTS_V1 },
    { key: 'D', name: '+更多专家', codes: UNIVERSE_V1, bars: BARS_V1, experts: ALL_EXPERTS },
    { key: 'E', name: 'v2 全量', codes: UNIVERSE_V2, bars: BARS_V2, experts: ALL_EXPERTS },
  ];

  const results = {};
  for (const c of CONFIGS) {
    // 训练侧：只保留该配置的标的，并按 bars 截断历史
    let ev = fullEvents.filter((e) => c.codes.indexOf(e.code) >= 0);
    const recs = records.filter((r) => c.codes.indexOf(r.code) >= 0);
    if (c.bars < BARS_V2) ev = truncateByBars(ev, recs, c.bars);
    // 专家侧：掩码到该配置的特征集
    if (c.experts.length !== ALL_EXPERTS.length) {
      const set = new Set(c.experts);
      ev = ev.map((e) => {
        const v = {};
        for (const k of Object.keys(e.votes)) if (set.has(k)) v[k] = e.votes[k];
        return Object.assign({}, e, { votes: v });
      });
    }
    const train = ev.filter((e) => e.date < cutDate);
    const st = rl.initState({ experts: c.experts });
    st.eta = cfg.eta; st.discount = cfg.gamma; st.lossType = cfg.lossType;
    for (const e of train) rl.update(st, e.horizon, e.votes, e.y, e.regime);
    rl.refitCalibration(st);

    const res = evaluate(st, commonTest, [0.55, 0.60, 0.65]);
    const trainCodes = new Set(train.map((e) => e.code));
    results[c.key] = {
      key: c.key, name: c.name,
      codes: c.codes.length, bars: c.bars, experts: c.experts.length,
      trainSamples: train.length,
      trainInstruments: trainCodes.size,
      ...res,
    };
    console.log(`[${c.key}] ${c.name.padEnd(10)} ${String(c.codes.length).padStart(2)} 标的 / ${c.bars} 根 / ${String(c.experts.length).padStart(2)} 专家 → 训练 ${String(train.length).padStart(6)} 条　方向命中率 ${(res.hitRate * 100).toFixed(2)}%　Brier ${res.brier}`);
  }

  // 7) 配对显著性检验（相对基线 A）
  console.log('\n=== McNemar 配对检验（相对 A 基线，同一测试集逐样本配对）===');
  const pairs = {};
  for (const c of CONFIGS.slice(1)) {
    const m = mcnemar(results.A.perEvent, results[c.key].perEvent);
    pairs[c.key] = m;
    const verdict = m.p < 0.01 ? '**极显著**' : m.p < 0.05 ? '**显著**' : m.p < 0.10 ? '边际显著' : '不显著（不能排除噪音）';
    console.log(`  ${c.key} ${c.name.padEnd(10)} 新增对 ${String(m.b).padStart(5)}　丢失 ${String(m.c).padStart(5)}　净增 ${String(m.delta).padStart(5)}　p = ${m.p.toExponential(3)}  → ${verdict.replace(/\*\*/g, '')}`);
  }

  // 8) 报告
  const lines = [];
  const P = (v) => (v == null ? '--' : (v * 100).toFixed(2) + '%');
  lines.push('# 消融实验报告：扩样本到底有没有提升预测能力');
  lines.push('');
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push('');
  lines.push('## 为什么做这个实验');
  lines.push('');
  lines.push('上一版报告说"扩样本把 1 月周期准确率从 46.4% 提到 54.5%"，**但这个对比不成立**：');
  lines.push('v1 与 v2 的测试集不是同一段时期（v1 测试集 ≥2026-06-04，v2 ≥2026-03-24），');
  lines.push('差异完全可能来自行情本身，而不是来自扩样本。');
  lines.push('');
  lines.push('本实验把扩样本拆成三个**可独立开关**的维度，在**完全相同的测试集**上做配对比较。');
  lines.push('');
  lines.push('| 配置 | 标的 | 日K | 专家 | 检验的维度 |');
  lines.push('| --- | --- | --- | --- | --- |');
  lines.push('| **A** | 17 | 400 | 11 | v1 基线（对照） |');
  lines.push('| **B** | 47 | 400 | 11 | **+更多标的** |');
  lines.push('| **C** | 17 | 640 | 11 | **+更长历史** |');
  lines.push('| **D** | 17 | 400 | 21 | **+更多专家** |');
  lines.push('| **E** | 47 | 640 | 21 | v2 全量（三者叠加） |');
  lines.push('');
  lines.push(`**公共测试集**：v1 的 17 个标的 × ${cutDate} ~ ${lastDate}，共 **${commonTest.length} 条样本**。`);
  lines.push('所有配置都在这一份考卷上作答，差异只可能来自训练侧。');
  lines.push('');
  lines.push(`**超参数统一**：η=${cfg.eta}，γ=${cfg.gamma}，损失函数=${cfg.lossType}（消融数据与特征，不消融调参）。`);;
  lines.push('');

  lines.push('## 一、同一测试集上的方向准确率');
  lines.push('');
  lines.push('| 配置 | 训练样本 | 方向命中率 | **相对 A 净增** | Brier | 标定Brier |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of CONFIGS) {
    const r = results[c.key];
    const d = c.key === 'A' ? '—' : ((r.hitRate - results.A.hitRate) * 100).toFixed(2) + 'pt';
    lines.push(`| ${c.key} ${c.name} | ${r.trainSamples.toLocaleString()} | **${P(r.hitRate)}** | ${d} | ${r.brier} | ${r.calibBrier} |`);
  }
  lines.push('');

  lines.push('## 二、分周期准确率');
  lines.push('');
  lines.push('| 配置 | 未来1天 | 未来3天 | 未来1周 | 未来1月 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const c of CONFIGS) {
    const b = results[c.key].byHorizon;
    lines.push(`| ${c.key} ${c.name} | ${b.d1 ? P(b.d1.hitRate) : '--'} | ${b.d3 ? P(b.d3.hitRate) : '--'} | ${b.w1 ? P(b.w1.hitRate) : '--'} | ${b.m1 ? P(b.m1.hitRate) : '--'} |`);
  }
  lines.push('');

  lines.push('## 三、配对显著性检验（McNemar）');
  lines.push('');
  lines.push('同一测试集上逐样本配对：**新增对** = A 错而该配置对；**丢失** = A 对而该配置错。');
  lines.push('只有配对样本才能这样算 —— 这是"提升是不是噪音"的判据，而不是"数字变大了"。');
  lines.push('');
  lines.push('| 配置 | 新增对 | 丢失 | 净增 | p 值 | 结论 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of CONFIGS.slice(1)) {
    const m = pairs[c.key];
    const verdict = m.p < 0.01 ? '**极显著**' : m.p < 0.05 ? '**显著**' : m.p < 0.10 ? '边际显著' : '不显著（不能排除噪音）';
    lines.push(`| ${c.key} ${c.name} | ${m.b} | ${m.c} | ${m.delta > 0 ? '+' : ''}${m.delta} | ${m.p.toExponential(3)} | ${verdict} |`);
  }
  lines.push('');

  lines.push('## 四、含费实盘胜率（固定阈值口径，保证各配置可比）');
  lines.push('');
  lines.push('| 配置 | 阈值0.55 交易数 | 阈值0.55 胜率 | 阈值0.55 期望 | 阈值0.60 交易数 | 阈值0.60 胜率 | 阈值0.65 交易数 | 阈值0.65 胜率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  const ai = results.A.allIn;
  lines.push(`| **基准：不筛选，全部买入** | ${ai.trades} | **${P(ai.winRate)}** | ${ai.avgRetPct}% | — | — | — | — |`);
  for (const c of CONFIGS) {
    const t = results[c.key].trading;
    lines.push(`| ${c.key} ${c.name} | ${t[0.55].trades} | **${P(t[0.55].winRate)}** | ${t[0.55].avgRetPct}% | ${t[0.60].trades} | ${P(t[0.60].winRate)} | ${t[0.65].trades} | ${P(t[0.65].winRate)} |`);
  }
  lines.push('');
  lines.push(`> **必须先看基准行**：这段测试窗口（${cutDate} ~ ${lastDate}）里，**不做任何筛选、全部买入并持有**的胜率是 ${P(ai.winRate)}、单笔 ${ai.avgRetPct}%。`);
  lines.push(`> 所以"胜率 58~60%"本身**不能说明模型有用** —— 它只说明这段行情偏强。`);
  lines.push(`> 真正有意义的是**各配置相对基准的差**，而不是绝对值。`);
  lines.push('');

  const report = lines.join('\n');
  console.log('\n' + report);

  const jsonPath = args.out || path.join(ROOT, 'data', 'ablation-report.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify({
    at: new Date().toISOString(),
    commonTest: { codes: UNIVERSE_V1, from: cutDate, to: lastDate, samples: commonTest.length },
    hyperparams: cfg,
    configs: CONFIGS.map((c) => c.key),
    allInBaseline: results.A.allIn,
    results: Object.fromEntries(CONFIGS.map((c) => [c.key, Object.assign({}, results[c.key], { perEvent: undefined })])),
    mcnemar: pairs,
  }, null, 2), 'utf8');
  const mdPath = path.join(ROOT, 'reports', `消融实验-扩样本是否有效-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`);
  fs.writeFileSync(mdPath, report, 'utf8');
  console.log('已写入：\n  ' + jsonPath + '\n  ' + mdPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
