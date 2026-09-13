'use strict';
/**
 * lib/auto-ledger.js —— 每次模型输出都自动入账（"每日期望值自动入账"）
 *
 * 解决什么问题：以前台账靠人工回填（只有用户咨询过的标的才有记录），
 * 样本极少、且只覆盖"被问到的"标的 → 无法评价模型在**全池**上的真实水平。
 *
 * 现在：每个交易日对轮动池里每个标的，把模型当日的预测（4 个周期）
 * 自动写一条台账，到期自动结算。这样：
 *   - 样本量从"几次咨询"变成"标的数 × 交易日数"
 *   - 覆盖全池，不再有选择性偏差（只记问过的、只记记得住的）
 *   - 可以按"模型 / 人工覆写 / 证据等级"分层统计准确率
 *
 * 幂等：同一个 (标的, 日期) 只写一条，重复运行不会污染。
 */

const fs = require('fs');
const path = require('path');

const market = require('./market');
const L = require('./research-ledger');
const rl = require('./rl');
const livePredict = require('./live-predict');

const ROOT = path.join(__dirname, '..');

/** 默认监控池（与 server.js 的 loadPool 同源） */
function poolCodes() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'notify.config.json'), 'utf8'));
    const out = [];
    for (const it of (cfg.etfPool || [])) if (it && it.code) out.push({ code: String(it.code), name: it.name || String(it.code) });
    if (out.length) return out;
  } catch (e) { /* 用默认池 */ }
  return ['159516', '512010', '512400', '512660', '688981', '688012', '002371',
    '688256', '688041', '603986', '688008', '688783', '300475']
    .map((c) => ({ code: c, name: c }));
}

function todayStr(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

/** 是否已有该 (code, date) 的自动条目 */
function hasEntry(db, code, date) {
  return db.entries.some((e) => e.code === code && e.anchorDate === date && (e.tags || []).indexOf('自动入账') >= 0);
}

/**
 * 为一个标的构造自动台账条目
 */
async function buildEntry(code, name, klines, hist, state, opts) {
  const last = klines[klines.length - 1];
  const live = livePredict.predictLive(klines, {
    indexKlines: hist.indexKlines,
    soxSeries: hist.soxSeries,
    us10ySeries: hist.us10ySeries,
    spxSeries: hist.spxSeries,
  }, state, { liveVotes: opts.liveVotes || {} });
  if (!live || !live.ok) return null;

  const H = live.horizons;
  const predictions = [];
  for (const h of rl.HORIZONS) {
    predictions.push({
      horizon: h,
      dir: H[h].dir,
      upProb: H[h].upProb,
      rangePct: H[h].rangePct,
      expectedChg: H[h].expectedChg,
      priceLow: H[h].priceLow,
      priceHigh: H[h].priceHigh,
      source: 'live-model',
    });
  }

  // 依据分级：模型用到什么数据，就标注什么等级
  const evidence = [
    { grade: 'A', type: 'data', source: '腾讯财经日K（前复权）', claim: `锚定 ${last.date} 收盘 ${last.close}` },
    { grade: 'B', type: 'derived', source: 'lib/indicators', claim: `MA/RSI/MACD/KDJ/ATR/OBV/MFI/布林（ATR ${live.atrPct}%）` },
    { grade: 'D', type: 'model', source: 'Hedge 学习器（21 专家加权）', claim: `regime=${live.regime}，专家权重由 ${state.trainedFrom ? state.trainedFrom.universeSize : '?'} 个标的样本外验证得出` },
  ];
  if (hist.soxSeries && hist.soxSeries.length) evidence.push({ grade: 'A', type: 'data', source: 'Yahoo ^SOX（滞后1日）', claim: '费城半导体指数隔夜与20日动量' });
  if (hist.us10ySeries && hist.us10ySeries.length) evidence.push({ grade: 'A', type: 'data', source: 'Yahoo ^TNX（滞后1日）', claim: '美债10年收益率变化' });
  if (hist.indexKlines && hist.indexKlines.length) evidence.push({ grade: 'A', type: 'data', source: '沪深300日K', claim: '大盘趋势与动量' });
  evidence.push({ grade: 'E', type: 'narrative', source: '自动生成', claim: '本条为模型自动快照，不含人工判断' });

  const w1 = H.w1;
  const topContrib = (live.contributions || []).slice(0, 4)
    .map((c) => `${c.label}(${c.contribution > 0 ? '+' : ''}${c.contribution})`).join('、');

  return {
    askedAt: new Date().toISOString(),
    code, name,
    kind: /^(15|51|56|58)/.test(code) ? 'etf' : 'stock',
    question: '【自动入账】每日模型预测快照（全池覆盖，消除选择性偏差）',
    verdict: `${w1.dir}（未来1周可信上涨概率 ${w1.upProb}%，原始 ${w1.upProbRaw}%）。` +
      `信号 ${w1.signal}（阈值 ${w1.threshold}）。市场状态 ${live.regime}。主要贡献：${topContrib}`,
    stance: w1.dir === '看涨' ? 'bullish' : w1.dir === '看跌' ? 'bearish' : 'neutral',
    confidence: Math.round(Math.abs(w1.upProb - 50) / 50 * 100) / 100,
    horizon: 'w1',
    anchorDate: last.date,
    anchorPrice: last.close,
    predictions,
    keyLevels: {
      stopLoss: +(last.close * (1 - 0.08)).toFixed(3),
      note: `置信区间 d1 ${H.d1.priceLow}~${H.d1.priceHigh}；w1 ${H.w1.priceLow}~${H.w1.priceHigh}`,
    },
    plan: '自动快照，无操作建议。仅用于评价模型在全池上的真实水平。',
    evidence,
    claims: (live.contributions || []).slice(0, 6).map((c) => ({ expert: c.expert, vote: c.vote, weight: c.weight, contribution: c.contribution })),
    tags: ['自动入账', '模型快照'],
  };
}

/**
 * 批量自动入账
 * @param {Object} opts { codes, date, limit, dryRun }
 */
async function autolog(opts) {
  opts = opts || {};
  const db = L.loadLedger();
  const state = rl.loadStateWithFallback();
  const list = (opts.codes ? opts.codes.map((c) => ({ code: c, name: c })) : poolCodes()).slice(0, opts.limit || 999);
  const hist = await market.fetchGlobalHistory({ bars: 640 });

  let added = 0, skipped = 0, failed = 0;
  const results = [];
  for (const { code, name } of list) {
    try {
      const { klines } = await market.fetchTencentKline('day', 640, code);
      if (!klines || klines.length < 61) { failed++; continue; }
      const anchor = klines[klines.length - 1].date;
      if (hasEntry(db, code, anchor)) { skipped++; continue; }
      const e = await buildEntry(code, name, klines, hist, state, opts);
      if (!e) { failed++; continue; }
      L.addEntry(db, e);
      added++;
      results.push({ code, name, anchorDate: e.anchorDate, dir: e.stance, upProb: e.predictions[2].upProb });
      if (!opts.dryRun) await new Promise((r) => setTimeout(r, 50));
    } catch (err) {
      failed++;
    }
  }
  if (!opts.dryRun) L.saveLedger(db);
  return { added, skipped, failed, total: list.length, results, dryRun: !!opts.dryRun };
}

/**
 * 把当日外部数据转成 fund / senti 两个「仅实盘可用」专家的投票。
 * 与训练时的口径保持一致：资金面看主力净占比，情绪面看赚钱效应。
 */
function liveVotesFromExtras(extras) {
  const v = {};
  extras = extras || {};
  const ff = extras.fundFlow;
  if (ff && ff.length) {
    const mp = (ff[ff.length - 1] || {}).mainNetInflowPct || 0;
    if (mp > 5) v.fund = 1;
    else if (mp > 0) v.fund = 0.6;
    else if (mp > -5) v.fund = -0.6;
    else v.fund = -1;
  }
  const hx = extras.hhxg;
  if (hx && hx.sentimentIndex != null) {
    const s = hx.sentimentIndex;
    if (s >= 85) v.senti = -0.8;
    else if (s >= 65) v.senti = 0.8;
    else if (s >= 45) v.senti = 0;
    else if (s >= 25) v.senti = -0.5;
    else v.senti = 0.8;
  }
  return v;
}

module.exports = { autolog, poolCodes, todayStr, hasEntry, buildEntry, liveVotesFromExtras };
