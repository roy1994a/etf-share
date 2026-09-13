'use strict';
/**
 * lib/research-ledger.js —— 研究台账（Research Ledger）
 *
 * 解决的问题：AI 给出结论后，没有记录、没有结算、没有复盘，
 * 于是"永远显得很有道理"，但**无法回答"你到底准不准"**。
 *
 * 台账做三件事：
 *   1) 留痕：把每一次咨询的标的、结论、关键位、概率、依据**全部结构化落盘**
 *   2) 结算：到了对应周期，自动拉真实行情，逐条判定命中/未命中
 *   3) 复盘：统计命中率、Brier 分数、按证据等级分层准确率，回灌给 RL 学习器
 *
 * 证据分级（回答"你的结论靠谱吗"的核心）：
 *   A 硬数据 / B 量化衍生 / C 二手转述 / D 模型推断 / E 主观叙事
 *
 * 零依赖，仅使用内置模块。
 */

const fs = require('fs');
const path = require('path');

const { HORIZONS, HORIZON_DAYS, HORIZON_LABEL } = require('./rl');

const DEAD_ZONE_PCT = 0.3;   // |涨跌幅| < 0.3% 视为"震荡"，方向不计命中

// ------------------------------------------------------------ 证据分级

const EVIDENCE_GRADES = {
  A: { grade: 'A', label: 'A级·硬数据', reliability: 'high', trust: 0.90,
       desc: '交易所/官方披露或行情原始数据（K线、财报、解禁、基金净值、资金流明细）——可复算、可核验、可追溯原始出处' },
  B: { grade: 'B', label: 'B级·量化衍生', reliability: 'medium-high', trust: 0.75,
       desc: '由A级数据按公开公式计算（MA/RSI/ATR/MACD/折溢价/动量）——公式确定，但依赖参数与窗口选择' },
  C: { grade: 'C', label: 'C级·二手转述', reliability: 'medium', trust: 0.50,
       desc: '新闻/券商研报/媒体观点（web_search 得到）——无法核验原始出处，可能滞后、带立场、有选择性报道' },
  D: { grade: 'D', label: 'D级·模型推断', reliability: 'low', trust: 0.35,
       desc: '本系统规则模型输出的评分与概率——**未经标定**，历史准确率仍在积累中' },
  E: { grade: 'E', label: 'E级·主观叙事', reliability: 'very-low', trust: 0.20,
       desc: '我的经验判断、类比与情景推演——最弱，仅供讨论，不应作为交易依据' },
};

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'E'];

/**
 * 依据证据结构给出**置信度上限**。
 *
 * 机制意义：如果一条结论主要靠新闻和模型推断支撑，
 * 那么无论我"感觉"多有把握，系统都会把置信度封顶，防止过度自信。
 *
 * 算法：按每条依据的 trust 取平均（A0.90 / B0.75 / C0.50 / D0.35 / E0.20），
 * 再映射到 [0.35, 0.90]：ceiling = 0.25 + 0.65 × 平均可信度。
 * 这样"一条结论里数据越多、新闻越少"，允许的置信度就越高。
 */
function confidenceCeiling(evidence) {
  const list = evidence || [];
  if (!list.length) return { ceiling: 0.40, avgTrust: 0, reason: '无任何标注依据' };
  let sum = 0;
  const counts = {};
  for (const e of list) {
    const g = e.grade || 'E';
    counts[g] = (counts[g] || 0) + 1;
    sum += (EVIDENCE_GRADES[g] || EVIDENCE_GRADES.E).trust;
  }
  const avgTrust = sum / list.length;
  const ceiling = Math.max(0.35, Math.min(0.90, 0.25 + 0.65 * avgTrust));
  const n = list.length;
  const hard = (counts.A || 0) / n;
  const soft = ((counts.C || 0) + (counts.D || 0) + (counts.E || 0)) / n;
  let reason = `平均依据可信度 ${(avgTrust * 100).toFixed(0)}%（A${counts.A || 0} B${counts.B || 0} C${counts.C || 0} D${counts.D || 0} E${counts.E || 0}）`;
  if (soft >= 0.6) reason += `；其中 C/D/E 类占 ${(soft * 100).toFixed(0)}%，属"二手信息 + 未验证推断"为主`;
  else if (hard >= 0.5) reason += '；硬数据(A级)占多数，支撑较扎实';
  return { ceiling: +ceiling.toFixed(3), avgTrust: +avgTrust.toFixed(3), reason };
}

function evidenceMix(evidence) {
  const counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const e of (evidence || [])) counts[e.grade || 'E']++;
  const n = (evidence || []).length;
  const pct = {};
  for (const g of GRADE_ORDER) pct[g] = n ? +(counts[g] / n * 100).toFixed(0) : 0;
  return { counts, pct, total: n };
}

// ------------------------------------------------------------ 存取

function defaultLedgerPath() {
  return process.env.LEDGER_PATH || path.join(__dirname, '..', 'data', 'research-ledger.json');
}

/** 随镜像发布的「脱敏」台账（不含个人资金信息），公开部署时作为只读回退 */
function publicLedgerPath() {
  return process.env.LEDGER_PUBLIC_PATH || path.join(__dirname, '..', 'model', 'research-ledger.json');
}

/**
 * 脱敏：只替换**与个人仓位/资金绑定**的表述，公开市场数据（成交量、成交额、
 * 解禁股数等）一律保留 —— 那些是研究依据，不是隐私。
 */
const REDACTIONS = [
  [/已亏了?\s*[\d.]+\s*[Ww万]?元?/g, '已产生浮亏'],
  [/亏了\s*[\d.]+\s*[Ww万]元?/g, '产生了浮亏'],
  [/总仓位\s*[\d.]+\s*[Ww万]元?/g, '总仓位【已脱敏】'],
  [/回本需\s*\+?[\d.]+%/g, '回本所需涨幅【已脱敏】'],
  [/[\d.]+\s*入[了]?\s*[\d.]+\s*[Ww万]元?/g, '【个人持仓金额已脱敏】'],
  [/[\d.]+\s*[Ww]\s*元?的?仓位/g, '【个人仓位已脱敏】'],
];

function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

function sanitizeLedger(db) {
  const copy = JSON.parse(JSON.stringify(db));
  copy.sanitized = true;
  copy.sanitizedAt = new Date().toISOString();
  copy.note = (copy.note || '') + '（公开发布版：个人资金信息已脱敏；方向、概率、依据、结算结果完整保留）';
  for (const e of (copy.entries || [])) {
    e.question = redact(e.question);
    e.verdict = redact(e.verdict);
    e.plan = redact(e.plan);
    e.lessons = redact(e.lessons);
    if (e.tags) e.tags = e.tags.filter((t) => t !== '持仓相关');
  }
  return copy;
}

function blankLedger() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    note: '研究台账：每次咨询的结论留痕 + 到期自动结算 + 反馈给 RL 学习器',
    entries: [],
  };
}

function loadLedger(file) {
  const candidates = file ? [file] : [defaultLedgerPath(), publicLedgerPath()];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const db = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!db || !Array.isArray(db.entries)) continue;
      db._source = f;
      return db;
    } catch (e) { /* 试下一个 */ }
  }
  return blankLedger();
}

function saveLedger(db, file) {
  file = file || defaultLedgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
  return db;
}

function nextId(db, date, code) {
  const d = (date || new Date().toISOString()).slice(0, 10).replace(/-/g, '');
  const base = `${d}-${code}`;
  let n = 1;
  const used = new Set(db.entries.map((e) => e.id));
  while (used.has(`${base}-${String(n).padStart(2, '0')}`)) n++;
  return `${base}-${String(n).padStart(2, '0')}`;
}

// ------------------------------------------------------------ 写入

/**
 * 新增一条研究结论
 * @param {Object} db
 * @param {Object} e  { code, name, question, stance, confidence, verdict, horizon,
 *                      askedAt, anchorDate, anchorPrice, predictions, keyLevels,
 *                      plan, evidence, claims, tags }
 */
function addEntry(db, e) {
  const askedAt = e.askedAt || new Date().toISOString();
  const entry = {
    id: e.id || nextId(db, askedAt, e.code || 'Q'),
    askedAt,
    code: e.code || null,
    name: e.name || e.code || '（无标的）',
    kind: e.kind || (e.code ? (/^(15|51|56|58)/.test(e.code) ? 'etf' : 'stock') : 'question'),
    question: e.question || '',
    stance: e.stance || 'neutral',        // bullish | neutral | bearish | avoid | watch
    confidence: e.confidence != null ? e.confidence : null,
    verdict: e.verdict || '',
    horizon: e.horizon || 'w1',
    anchorDate: e.anchorDate || askedAt.slice(0, 10),
    anchorPrice: e.anchorPrice != null ? e.anchorPrice : null,
    predictions: e.predictions || [],
    keyLevels: e.keyLevels || {},
    plan: e.plan || '',
    evidence: e.evidence || [],
    claims: e.claims || [],
    tags: e.tags || [],
    outcomes: [],
    scores: {},
    status: 'open',
    resolvedAt: null,
    lessons: e.lessons || '',
  };
  // 诚实性护栏：置信度不得超过证据能支撑的上限
  const cap = confidenceCeiling(entry.evidence);
  entry.confidenceCeiling = cap.ceiling;
  entry.ceilingReason = cap.reason;
  entry.evidenceMix = evidenceMix(entry.evidence);
  // 只有"可打分的预测性结论"才做过度自信检查；勘误/纯记录不计
  const predictive = entry.scorable !== false && entry.kind !== 'correction' && entry.predictions.length > 0;
  entry.overconfidence = predictive && entry.confidence != null && entry.confidence > cap.ceiling + 1e-9;
  if (entry.overconfidence) entry.confidenceRaw = entry.confidence;
  db.entries.push(entry);
  return entry;
}

function findEntry(db, idOrCode) {
  return db.entries.find((e) => e.id === idOrCode)
    || db.entries.find((e) => e.code === idOrCode && e.status !== 'resolved')
    || db.entries.find((e) => e.code === idOrCode);
}

// ------------------------------------------------------------ 结算

/** 在 K 线数组中找到某日期的索引（找不到则取第一个 >= 该日期的 bar） */
function findBarIndex(klines, date) {
  const i = klines.findIndex((k) => k.date === date);
  if (i >= 0) return i;
  const j = klines.findIndex((k) => k.date > date);
  return j >= 0 ? j : -1;
}

/**
 * 结算一条预测
 * @param {Array} klines 日K（含 anchorDate 之后的 bar）
 * @param {Number} anchorIdx
 * @param {Object} pred  { horizon, dir, upProb, priceLow, priceHigh }
 */
function scorePrediction(klines, anchorIdx, pred, anchorPrice) {
  const days = HORIZON_DAYS[pred.horizon];
  if (!days || anchorIdx < 0) return null;
  const endIdx = anchorIdx + days;
  if (endIdx >= klines.length) return { pending: true, horizon: pred.horizon, needBars: endIdx - klines.length + 1 };
  const end = klines[endIdx];
  const win = klines.slice(anchorIdx + 1, endIdx + 1);
  if (!win.length) return { pending: true, horizon: pred.horizon };
  const actualPct = (end.close - anchorPrice) / anchorPrice * 100;
  const y = actualPct > 0 ? 1 : 0;

  // 方向命中（带死区）
  const actualDir = actualPct > DEAD_ZONE_PCT ? '看涨' : actualPct < -DEAD_ZONE_PCT ? '看跌' : '震荡';
  const dirHit = pred.dir === actualDir;

  // Brier / 奖励
  const p = pred.upProb != null ? pred.upProb / 100 : 0.5;
  const brier = (p - y) ** 2;
  const reward = +(1 - 2 * brier).toFixed(4);      // ∈ [-1, 1]

  // 区间命中（两种口径）
  const hi = Math.max(...win.map((x) => x.high));
  const lo = Math.min(...win.map((x) => x.low));
  const hasRange = pred.priceLow != null && pred.priceHigh != null;
  const rangeHitClose = hasRange ? (end.close >= pred.priceLow && end.close <= pred.priceHigh) : null;
  const rangeHitPath = hasRange ? (hi <= pred.priceHigh && lo >= pred.priceLow) : null;
  const rangeWidthPct = hasRange ? +((pred.priceHigh - pred.priceLow) / anchorPrice * 100).toFixed(2) : null;
  const moveAbsPct = +((hi - lo) / anchorPrice * 100).toFixed(2);

  return {
    horizon: pred.horizon,
    horizonLabel: HORIZON_LABEL[pred.horizon] || pred.horizon,
    source: pred.source || 'model',
    fromDate: klines[anchorIdx].date,
    toDate: end.date,
    anchorPrice,
    endClose: end.close,
    actualPct: +actualPct.toFixed(2),
    actualDir,
    predictedDir: pred.dir,
    predictedRange: hasRange ? [pred.priceLow, pred.priceHigh] : null,
    rangeWidthPct,
    moveAbsPct,
    dirHit,
    brier: +brier.toFixed(4),
    reward,
    upProb: pred.upProb,
    rangeHitClose,
    rangeHitPath,
    pathHigh: hi,
    pathLow: lo,
  };
}

/**
 * 结算一整条台账
 * @param {Object} entry
 * @param {Array} klines 日K（必须覆盖 anchorDate 之后足够长的时间）
 */
function resolveEntry(entry, klines) {
  // 勘误/纯记录类条目不参与打分（没有预测可结算）
  if (entry.scorable === false || entry.kind === 'correction') {
    entry.status = 'record';
    return entry;
  }
  if (!entry.predictions || !entry.predictions.length) {
    entry.status = 'unresolvable';
    return entry;
  }
  const anchorPrice = entry.anchorPrice != null
    ? entry.anchorPrice
    : (klines.find((k) => k.date === entry.anchorDate) || {}).close;
  if (anchorPrice == null) { entry.status = 'unresolvable'; return entry; }

  const anchorIdx = findBarIndex(klines, entry.anchorDate);
  entry.outcomes = [];
  let pendingCount = 0;
  for (const pred of entry.predictions) {
    const o = scorePrediction(klines, anchorIdx, pred, anchorPrice);
    if (!o) continue;
    if (o.pending) { pendingCount++; entry.outcomes.push(o); continue; }
    entry.outcomes.push(o);
  }
  const done = entry.outcomes.filter((o) => !o.pending);
  entry.scores = aggregateScores(done);
  entry.status = done.length === 0 ? 'open' : (pendingCount > 0 ? 'partial' : 'resolved');
  if (entry.status === 'resolved') entry.resolvedAt = new Date().toISOString();
  return entry;
}

function aggregateScores(outcomes) {
  const done = (outcomes || []).filter((o) => !o.pending);
  if (!done.length) return { n: 0 };
  const hits = done.filter((o) => o.dirHit).length;
  const brier = done.reduce((s, o) => s + o.brier, 0) / done.length;
  const reward = done.reduce((s, o) => s + o.reward, 0) / done.length;
  const rangeHits = done.filter((o) => o.rangeHitClose === true).length;
  const byHorizon = {};
  for (const o of done) {
    byHorizon[o.horizon] = byHorizon[o.horizon] || { n: 0, hits: 0, brierSum: 0 };
    byHorizon[o.horizon].n++;
    byHorizon[o.horizon].hits += o.dirHit ? 1 : 0;
    byHorizon[o.horizon].brierSum += o.brier;
  }
  for (const h of Object.keys(byHorizon)) {
    const b = byHorizon[h];
    b.hitRate = +(b.hits / b.n).toFixed(3);
    b.brier = +(b.brierSum / b.n).toFixed(4);
    delete b.brierSum;
  }
  return {
    n: done.length,
    hits,
    hitRate: +(hits / done.length).toFixed(4),
    brier: +brier.toFixed(4),
    reward: +reward.toFixed(4),
    rangeHitRate: +(rangeHits / done.length).toFixed(4),
    byHorizon,
  };
}

// ------------------------------------------------------------ 统计

function stats(db) {
  const entries = db.entries || [];
  const withScores = entries.filter((e) => e.scores && e.scores.n > 0);
  const allOutcomes = [];
  for (const e of withScores) for (const o of e.outcomes) if (!o.pending) allOutcomes.push({ ...o, code: e.code, name: e.name });

  const overall = aggregateScores(allOutcomes);

  // 按证据等级分层（取决于该条目主要依据的等级）
  const byGrade = {};
  for (const e of withScores) {
    const mix = e.evidenceMix || evidenceMix(e.evidence);
    let dom = 'E';
    for (const g of GRADE_ORDER) if (mix.counts[g] > 0) { dom = g; break; }
    byGrade[dom] = byGrade[dom] || { n: 0, hits: 0, brierSum: 0, entries: 0 };
    byGrade[dom].entries++;
    for (const o of e.outcomes) {
      if (o.pending) continue;
      byGrade[dom].n++;
      byGrade[dom].hits += o.dirHit ? 1 : 0;
      byGrade[dom].brierSum += o.brier;
    }
  }
  for (const g of Object.keys(byGrade)) {
    const b = byGrade[g];
    b.hitRate = b.n ? +(b.hits / b.n).toFixed(4) : null;
    b.brier = b.n ? +(b.brierSum / b.n).toFixed(4) : null;
    delete b.brierSum;
  }

  // 按周期
  const byHorizon = {};
  for (const o of allOutcomes) {
    byHorizon[o.horizon] = byHorizon[o.horizon] || { n: 0, hits: 0, brierSum: 0 };
    byHorizon[o.horizon].n++;
    byHorizon[o.horizon].hits += o.dirHit ? 1 : 0;
    byHorizon[o.horizon].brierSum += o.brier;
  }
  for (const h of Object.keys(byHorizon)) {
    const b = byHorizon[h];
    b.label = HORIZON_LABEL[h] || h;
    b.hitRate = +(b.hits / b.n).toFixed(4);
    b.brier = +(b.brierSum / b.n).toFixed(4);
    delete b.brierSum;
  }

  // 按立场
  const byStance = {};
  for (const e of withScores) {
    const s = e.stance || 'neutral';
    byStance[s] = byStance[s] || { n: 0, hits: 0, entries: 0 };
    byStance[s].entries++;
    for (const o of e.outcomes) {
      if (o.pending) continue;
      byStance[s].n++; byStance[s].hits += o.dirHit ? 1 : 0;
    }
  }
  for (const s of Object.keys(byStance)) {
    const b = byStance[s];
    b.hitRate = b.n ? +(b.hits / b.n).toFixed(4) : null;
  }

  // 过度自信统计
  const over = entries.filter((e) => e.overconfidence).length;

  return {
    totalEntries: entries.length,
    openEntries: entries.filter((e) => e.status === 'open').length,
    partialEntries: entries.filter((e) => e.status === 'partial').length,
    resolvedEntries: entries.filter((e) => e.status === 'resolved').length,
    recordEntries: entries.filter((e) => e.status === 'record').length,
    unresolvableEntries: entries.filter((e) => e.status === 'unresolvable').length,
    scoredOutcomes: overall.n,
    hitRate: overall.hitRate,
    brier: overall.brier,
    reward: overall.reward,
    rangeHitRate: overall.rangeHitRate,
    byHorizon,
    byGrade,
    byStance,
    overconfidenceCount: over,
    baselineNote: '沪深300/标的自身上涨概率约50%；方向命中率>55%才算有边际，Brier<0.25才优于"永远猜50%"',
  };
}

// ------------------------------------------------------------ 报告

function buildLedgerReport(db, opts) {
  opts = opts || {};
  // 报告默认脱敏（报告会进 git / 分享）；完整原始文本保留在 data/research-ledger.json
  const doRedact = opts.redact !== false;
  const R = doRedact ? redact : (x) => x;
  const st = stats(db);
  const L = [];
  L.push('# 研究台账与准确率追踪报告');
  L.push('');
  L.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  L.push('');
  L.push('## 一、总览');
  L.push('');
  L.push(`- 台账条目：**${st.totalEntries}** 条（已结算 ${st.resolvedEntries}，部分结算 ${st.partialEntries}，待结算 ${st.openEntries}）`);
  L.push(`- 已判定预测：**${st.scoredOutcomes}** 个`);
  if (st.scoredOutcomes) {
    L.push(`- **方向命中率：${(st.hitRate * 100).toFixed(1)}%**`);
    L.push(`- **Brier 分数：${st.brier}**（0.25 = 与"永远猜50%"持平，越低越好）`);
    L.push(`- 平均奖励：${st.reward}（∈[-1,1]）`);
    L.push(`- 价格区间命中率：${(st.rangeHitRate * 100).toFixed(1)}%`);
  } else {
    L.push('- 尚无到期可判定的预测（周/月周期需要时间兑现）');
  }
  L.push('');
  L.push(`> 基准说明：${st.baselineNote}`);
  L.push('');

  if (Object.keys(st.byHorizon).length) {
    L.push('## 二、分周期准确率');
    L.push('');
    L.push('| 周期 | 样本 | 方向命中率 | Brier |');
    L.push('| --- | --- | --- | --- |');
    for (const h of HORIZONS) {
      const b = st.byHorizon[h];
      if (!b) continue;
      L.push(`| ${b.label} | ${b.n} | ${(b.hitRate * 100).toFixed(1)}% | ${b.brier} |`);
    }
    L.push('');
  }

  if (Object.keys(st.byGrade).length) {
    L.push('## 三、按主要证据等级分层（这张表最有价值）');
    L.push('');
    L.push('| 主要依据等级 | 条目 | 样本 | 方向命中率 | Brier |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const g of GRADE_ORDER) {
      const b = st.byGrade[g];
      if (!b) continue;
      L.push(`| ${EVIDENCE_GRADES[g].label} | ${b.entries} | ${b.n} | ${b.hitRate == null ? '--' : (b.hitRate * 100).toFixed(1) + '%'} | ${b.brier == null ? '--' : b.brier} |`);
    }
    L.push('');
    L.push('它回答的问题是：**靠新闻(C级)得出的结论，是不是比靠数据(A/B级)得出的结论更不准？** 这张表用真实结果说话。');
    L.push('');
  }

  L.push('## 四、逐条明细');
  L.push('');
  for (const e of (db.entries || [])) {
    const mix = e.evidenceMix || evidenceMix(e.evidence);
    L.push(`### ${e.name}${e.code ? '（' + e.code + '）' : ''} · ${e.anchorDate}`);
    L.push('');
    L.push(`- **问题**：${R(e.question)}`);
    L.push(`- **当时结论**：${R(e.verdict)}`);
    L.push(`- **立场**：${e.stance}　**置信度**：${e.confidence == null ? '--' : (e.confidence * 100).toFixed(0) + '%'}` +
      (e.overconfidence ? `　⚠️ **超出证据上限**（证据只支持 ≤${(e.confidenceCeiling * 100).toFixed(0)}%，理由：${e.ceilingReason}）` : ''));
    L.push(`- **证据结构**：A${mix.counts.A} B${mix.counts.B} C${mix.counts.C} D${mix.counts.D} E${mix.counts.E}`);
    if (e.anchorPrice != null) L.push(`- **锚定价**：${e.anchorPrice}`);
    if (e.keyLevels && (e.keyLevels.stopLoss != null || e.keyLevels.takeProfit != null)) {
      L.push(`- **关键位**：止损 ${e.keyLevels.stopLoss != null ? e.keyLevels.stopLoss : '--'} / 止盈 ${e.keyLevels.takeProfit != null ? e.keyLevels.takeProfit : '--'}`);
    }
    if (e.plan) L.push(`- **操作计划**：${R(e.plan)}`);
    if (e.scores && e.scores.n) {
      L.push(`- **结算**：${e.scores.hits}/${e.scores.n} 命中（${(e.scores.hitRate * 100).toFixed(0)}%），Brier ${e.scores.brier}，奖励 ${e.scores.reward}`);
      L.push('');
      L.push('  | 周期 | 预测 | 实际 | 实际涨跌 | 命中 | 区间命中 |');
      L.push('  | --- | --- | --- | --- | --- | --- |');
      for (const o of e.outcomes) {
        if (o.pending) { L.push(`  | ${HORIZON_LABEL[o.horizon] || o.horizon} | -- | -- | -- | 待兑现 | -- |`); continue; }
        L.push(`  | ${o.horizonLabel} | ${o.predictedDir}(${o.upProb}%) | ${o.actualDir} | ${o.actualPct > 0 ? '+' : ''}${o.actualPct}% | ${o.dirHit ? '✅' : '❌'} | ${o.rangeHitClose ? '✅' : '❌'} |`);
      }
    } else {
      L.push('- **结算**：待到期');
    }
    if (e.lessons) L.push(`- **复盘教训**：${R(e.lessons)}`);
    L.push('');
  }

  L.push('## 五、这份台账怎么让系统变准');
  L.push('');
  L.push('1. **每一次结论都不可撤销地留痕**（含当时的置信度与依据等级），杜绝事后自我美化。');
  L.push('2. **到期自动结算**，把"方向命中/Brier/区间命中"算成数字，回灌给 `lib/rl.js` 的 Hedge 学习器。');
  L.push('3. **Hedge 更新规则**：某个专家在某个周期上错得越多，它的权重按 `exp(-η·loss)` 指数衰减；对的专家权重自动上升。');
  L.push('4. **概率再标定（Platt）**：让"系统说70%"真的对应约70%的实际频率，消除系统性过度自信。');
  L.push('5. **证据等级护栏**：主要靠新闻与主观判断得出的结论，置信度被强制封顶，从制度上抑制"言之凿凿却不靠谱"。');
  L.push('');
  return L.join('\n');
}

module.exports = {
  EVIDENCE_GRADES, GRADE_ORDER, DEAD_ZONE_PCT,
  confidenceCeiling, evidenceMix, redact, sanitizeLedger,
  defaultLedgerPath, publicLedgerPath, blankLedger, loadLedger, saveLedger, nextId,
  addEntry, findEntry, findBarIndex, scorePrediction, resolveEntry, aggregateScores,
  stats, buildLedgerReport,
};
