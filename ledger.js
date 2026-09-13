#!/usr/bin/env node
'use strict';
/**
 * ledger.js —— 研究台账命令行工具
 *
 * 用法：
 *   node ledger.js list [--code 159516] [--status open]   列出条目
 *   node ledger.js stats                                  准确率总览（含证据分级分层）
 *   node ledger.js resolve [--all]                        拉真实行情结算到期预测
 *   node ledger.js report [--out 路径]                     生成 Markdown 报告
 *   node ledger.js feedback                               把已结算结果回灌给 RL 学习器
 *   node ledger.js show <id|code>                         查看单条明细
 *
 * 零依赖，仅使用内置模块 + lib/。
 */

const fs = require('fs');
const path = require('path');

const market = require('./lib/market');
const L = require('./lib/research-ledger');
const rl = require('./lib/rl');
const AutoLedger = require('./lib/auto-ledger');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const cmd = argv[0] || 'stats';

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
}
function has(name) { return argv.includes('--' + name); }

const ledgerPath = L.defaultLedgerPath();

// ------------------------------------------------------------ 结算

async function resolveAll(db, onlyCode) {
  const targets = db.entries.filter((e) => e.predictions && e.predictions.length
    && (!onlyCode || e.code === onlyCode)
    && e.status !== 'record');
  const byCode = {};
  for (const e of targets) {
    const kc = e.klineCode || e.code;
    if (!kc || !/^\d{6}$/.test(kc)) continue;   // 组合/宏观等无行情代码，跳过
    byCode[kc] = byCode[kc] || [];
    byCode[kc].push(e);
  }
  const codes = Object.keys(byCode);
  console.log(`需要结算 ${targets.length} 条，涉及 ${codes.length} 个标的`);
  const klinesCache = {};
  for (const c of codes) {
    try {
      const { klines } = await market.fetchTencentKline('day', 400, c);
      klinesCache[c] = klines;
      console.log(`  [行情] ${c} ${klines.length} 根（最新 ${klines[klines.length - 1].date}）`);
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      console.warn(`  [跳过] ${c}：${err.message}`);
    }
  }
  let done = 0, pending = 0;
  for (const e of targets) {
    const k = klinesCache[e.klineCode || e.code];
    if (!k) continue;
    L.resolveEntry(e, k);
    const n = e.scores && e.scores.n ? e.scores.n : 0;
    done += n;
    const p = e.outcomes.filter((o) => o.pending).length;
    pending += p;
    console.log(`  ${e.id} ${e.name} → ${e.status}（可判定 ${n}，待兑现 ${p}）`);
  }
  console.log(`\n结算完成：可判定预测 ${done} 个，仍待兑现 ${pending} 个`);
  return db;
}

// ------------------------------------------------------------ 反馈给 RL

/**
 * 把台账里已结算的预测回灌给 Hedge 学习器。
 *
 * ⚠️ 关键设计：专家投票**无法从事后重建**（当时的 MA/RSI/量比等状态需要历史K线），
 * 所以这里不做"重放"，而是把**台账的真实结果**作为一个独立的高置信度数据源，
 * 用来更新"哪一类依据更可信"——即按证据等级维护一张可靠性表。
 * 这张表会写进 rl-state 的 ledgerFeedback 字段，供预测时对置信度做缩放。
 */
function feedback(db) {
  const p = rl.defaultStatePath();
  const state = rl.loadState(p);
  const byGrade = {};
  for (const e of db.entries) {
    if (!e.scores || !e.scores.n) continue;
    const mix = e.evidenceMix || L.evidenceMix(e.evidence);
    let dom = 'E';
    for (const g of L.GRADE_ORDER) if (mix.counts[g] > 0) { dom = g; break; }
    byGrade[dom] = byGrade[dom] || { n: 0, hits: 0, brierSum: 0 };
    for (const o of e.outcomes) {
      if (o.pending) continue;
      byGrade[dom].n++;
      byGrade[dom].hits += o.dirHit ? 1 : 0;
      byGrade[dom].brierSum += o.brier;
    }
  }
  const table = {};
  for (const g of Object.keys(byGrade)) {
    const b = byGrade[g];
    table[g] = {
      n: b.n,
      hitRate: +(b.hits / b.n).toFixed(4),
      brier: +(b.brierSum / b.n).toFixed(4),
      // 贝叶斯收缩后的可靠性（向 0.5 收缩，n 越小越保守）
      reliability: +(((b.hits + 5) / (b.n + 10))).toFixed(4),
    };
  }
  state.ledgerFeedback = {
    updatedAt: new Date().toISOString(),
    scoredOutcomes: Object.values(byGrade).reduce((s, b) => s + b.n, 0),
    byGrade: table,
  };
  rl.saveState(state, p);
  console.log('已回灌给 RL 学习器 → ' + p);
  console.log(JSON.stringify(state.ledgerFeedback, null, 2));
  if (!Object.keys(table).length) {
    console.log('\n提示：目前还没有到期的可判定预测（周/月周期需要时间兑现）。');
    console.log('      这正是"台账"存在的意义 —— 在拿到真实结果之前，任何准确率说法都是空话。');
  }
}

// ------------------------------------------------------------ 输出

function showStats(db) {
  const st = L.stats(db);
  console.log('\n=== 研究台账 · 准确率总览 ===\n');
  console.log(`条目总数 ${st.totalEntries}：已结算 ${st.resolvedEntries} ／ 部分结算 ${st.partialEntries} ／ 待结算 ${st.openEntries} ／ 记录类 ${st.recordEntries} ／ 不可结算 ${st.unresolvableEntries}`);
  console.log(`可判定预测 ${st.scoredOutcomes} 个`);
  if (st.scoredOutcomes) {
    console.log(`\n方向命中率：${(st.hitRate * 100).toFixed(1)}%`);
    console.log(`Brier 分数 ：${st.brier}   （0.25 = 与"永远猜50%"持平，越低越好）`);
    console.log(`平均奖励   ：${st.reward}   （∈[-1,1]）`);
    console.log(`区间命中率 ：${(st.rangeHitRate * 100).toFixed(1)}%`);
  } else {
    console.log('\n⚠️ 尚无到期可判定的预测。');
  }
  if (Object.keys(st.byHorizon).length) {
    console.log('\n-- 分周期 --');
    for (const h of rl.HORIZONS) {
      const b = st.byHorizon[h];
      if (!b) continue;
      console.log(`  ${b.label.padEnd(8)} n=${String(b.n).padStart(3)}  命中率 ${(b.hitRate * 100).toFixed(1)}%  Brier ${b.brier}`);
    }
  }
  if (Object.keys(st.byGrade).length) {
    console.log('\n-- 按主要证据等级（这是最有价值的一张表）--');
    for (const g of L.GRADE_ORDER) {
      const b = st.byGrade[g];
      if (!b) continue;
      console.log(`  ${L.EVIDENCE_GRADES[g].label.padEnd(16)} 条目${String(b.entries).padStart(3)}  n=${String(b.n).padStart(3)}  命中率 ${b.hitRate == null ? '--' : (b.hitRate * 100).toFixed(1) + '%'}  Brier ${b.brier == null ? '--' : b.brier}`);
    }
  }
  if (Object.keys(st.bySource || {}).length) {
    console.log('\n-- 按预测来源（模型 vs 人工覆写）--');
    for (const k of Object.keys(st.bySource)) {
      const b = st.bySource[k];
      const tag = k === 'human-override' ? '人工覆写' : k === 'live-model' ? '模型自动' : k;
      console.log(`  ${tag.padEnd(12)} n=${String(b.n).padStart(4)}  命中率 ${(b.hitRate * 100).toFixed(1)}%  Brier ${b.brier}  方向调整后均收益 ${b.avgSignedRetPct}%`);
    }
  }
  if (Object.keys(st.byStance).length) {
    console.log('\n-- 按立场 --');
    for (const s of Object.keys(st.byStance)) {
      const b = st.byStance[s];
      console.log(`  ${s.padEnd(10)} 条目${String(b.entries).padStart(3)}  n=${String(b.n).padStart(3)}  命中率 ${b.hitRate == null ? '--' : (b.hitRate * 100).toFixed(1) + '%'}`);
    }
  }
  if (st.overconfidenceCount) {
    console.log(`\n⚠️ 有 ${st.overconfidenceCount} 条结论的置信度**超过了证据能支撑的上限**（已在台账中标注）。`);
  }
  console.log(`\n基准说明：${st.baselineNote}`);
  console.log('');
}

function showList(db) {
  const code = flag('code');
  const status = flag('status');
  const rows = db.entries.filter((e) => (!code || e.code === code) && (!status || e.status === status));
  console.log(`\n${'ID'.padEnd(28)} ${'名称'.padEnd(22)} ${'立场'.padEnd(9)} ${'状态'.padEnd(10)} 结算`);
  console.log('-'.repeat(96));
  for (const e of rows) {
    const sc = e.scores && e.scores.n ? `${e.scores.hits}/${e.scores.n} (${(e.scores.hitRate * 100).toFixed(0)}%)` : '--';
    const name = (e.name || '').slice(0, 20);
    console.log(`${e.id.padEnd(28)} ${name.padEnd(22)} ${(e.stance || '').padEnd(9)} ${(e.status || '').padEnd(10)} ${sc}${e.overconfidence ? '  ⚠️过度自信' : ''}`);
  }
  console.log(`\n共 ${rows.length} 条\n`);
}

function showEntry(db, key) {
  const e = L.findEntry(db, key);
  if (!e) { console.error('未找到：' + key); process.exit(1); }
  const mix = e.evidenceMix || L.evidenceMix(e.evidence);
  console.log(`\n=== ${e.name}${e.code ? '（' + e.code + '）' : ''} · ${e.id} ===\n`);
  console.log(`问题  ：${e.question}`);
  console.log(`结论  ：${e.verdict}`);
  console.log(`立场  ：${e.stance}　置信度：${e.confidence == null ? '--' : (e.confidence * 100).toFixed(0) + '%'}` +
    (e.overconfidence ? `　⚠️ 超出证据上限 ${(e.confidenceCeiling * 100).toFixed(0)}%（${e.ceilingReason}）` : ''));
  console.log(`锚定  ：${e.anchorDate} @ ${e.anchorPrice}`);
  console.log(`证据  ：A${mix.counts.A} B${mix.counts.B} C${mix.counts.C} D${mix.counts.D} E${mix.counts.E}`);
  if (e.evidence && e.evidence.length) {
    console.log('\n依据明细：');
    for (const ev of e.evidence) console.log(`  [${ev.grade}] ${ev.source}：${ev.claim}`);
  }
  if (e.plan) console.log(`\n操作计划：${e.plan}`);
  if (e.scores && e.scores.n) {
    console.log(`\n结算：${e.scores.hits}/${e.scores.n} 命中（${(e.scores.hitRate * 100).toFixed(0)}%），Brier ${e.scores.brier}，奖励 ${e.scores.reward}`);
    for (const o of e.outcomes) {
      if (o.pending) { console.log(`  ${(o.horizonLabel || o.horizon).padEnd(8)} 待兑现（还差 ${o.needBars} 根K线）`); continue; }
      console.log(`  ${o.horizonLabel.padEnd(8)} 预测 ${o.predictedDir}(${o.upProb}%) [${o.source}] → 实际 ${o.actualDir} ${o.actualPct > 0 ? '+' : ''}${o.actualPct}%  方向${o.dirHit ? '✅' : '❌'} 区间${o.rangeHitClose ? '✅' : '❌'}`);
    }
  } else {
    console.log('\n结算：待到期');
  }
  if (e.lessons) console.log(`\n复盘教训：${e.lessons}`);
  console.log('');
}

// ------------------------------------------------------------ main

(async () => {
  let db = L.loadLedger(ledgerPath);
  if (!db.entries.length) {
    console.log('台账为空。请先执行：node seed-ledger.js');
    return;
  }

  if (cmd === 'list') { showList(db); return; }
  if (cmd === 'show') { showEntry(db, argv[1]); return; }
  if (cmd === 'stats') { showStats(db); return; }

  if (cmd === 'resolve') {
    db = await resolveAll(db, flag('code'));
    L.saveLedger(db, ledgerPath);
    showStats(db);
    return;
  }

  if (cmd === 'feedback') { feedback(db); return; }

  if (cmd === 'autolog') {
    console.log('开始自动入账（全池每日模型快照）…');
    const r = await AutoLedger.autolog({
      codes: flag('codes') ? flag('codes').split(',') : null,
      limit: flag('limit') ? parseInt(flag('limit'), 10) : null,
      dryRun: has('dry-run'),
    });
    console.log(`\n新增 ${r.added} 条，跳过（已存在）${r.skipped} 条，失败 ${r.failed} 条，共 ${r.total} 个标的`);
    if (r.dryRun) console.log('（--dry-run：未写入）');
    for (const x of r.results.slice(0, 20)) console.log(`  ${x.code} ${x.name} ${x.anchorDate} ${x.dir} 1周上涨概率 ${x.upProb}%`);
    db = L.loadLedger(ledgerPath);
    showStats(db);
    return;
  }

  if (cmd === 'compare') {
    // 人工覆写 vs 模型：同一批样本的直接对比
    const withBoth = db.entries.filter((e) => {
      const srcs = new Set((e.predictions || []).map((p) => p.source || 'model'));
      return srcs.size > 1;
    });
    console.log('\n=== 人工覆写 vs 模型：对照实验 ===\n');
    console.log(`同时记录了两种来源的条目：${withBoth.length} 条\n`);
    const agg = {};
    for (const e of withBoth) {
      console.log(`【${e.name}（${e.code}）】${e.anchorDate}`);
      const byH = {};
      for (const o of (e.outcomes || [])) {
        if (o.pending) continue;
        const src = o.source || 'model';
        byH[o.horizon] = byH[o.horizon] || {};
        byH[o.horizon][src] = o;
      }
      for (const h of Object.keys(byH)) {
        const parts = Object.keys(byH[h]).map((src) => {
          const o = byH[h][src];
          const tag = src === 'human-override' ? '人工' : '模型';
          agg[src] = agg[src] || { n: 0, hits: 0 };
          agg[src].n++; agg[src].hits += o.dirHit ? 1 : 0;
          return `${tag}: ${o.predictedDir}(${o.upProb}%) vs 实际 ${o.actualPct}% ${o.dirHit ? '✅' : '❌'}`;
        });
        console.log(`  ${h}: ${parts.join('　｜　')}`);
      }
      console.log('');
    }
    if (Object.keys(agg).length) {
      console.log('-- 汇总 --');
      for (const k of Object.keys(agg)) {
        const tag = k === 'human-override' ? '人工覆写' : '模型';
        console.log(`  ${tag.padEnd(10)} n=${agg[k].n}  命中率 ${(agg[k].hits / agg[k].n * 100).toFixed(1)}%`);
      }
    } else {
      console.log('（尚无到期的对照样本；已有 ' + withBoth.length + ' 条对照条目在等待结算）');
    }
    console.log('');
    return;
  }

  if (cmd === 'export') {
    // 导出脱敏台账到 model/，随 git 发布，供公开站点只读展示
    const out = flag('out') || L.publicLedgerPath();
    const clean = L.sanitizeLedger(db);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(clean, null, 2), 'utf8');
    const removed = (db.entries || []).filter((e) => {
      const c = clean.entries.find((x) => x.id === e.id);
      return c && (c.question !== e.question || c.verdict !== e.verdict);
    }).length;
    console.log('已导出脱敏台账 → ' + out);
    console.log(`条目 ${clean.entries.length} 条，其中 ${removed} 条含个人资金信息的文本已脱敏`);
    return;
  }

  if (cmd === 'report') {
    const out = flag('out') || path.join(ROOT, 'reports', `研究台账与准确率追踪报告-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`);
    const md = L.buildLedgerReport(db);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md, 'utf8');
    console.log('已写入：' + out);
    console.log(`（${md.split('\n').length} 行，${md.length} 字符）`);
    return;
  }

  console.log(`未知命令：${cmd}`);
  console.log('可用：list / show <id> / stats / resolve [--code X] / feedback / report / export / autolog / compare');
})();
