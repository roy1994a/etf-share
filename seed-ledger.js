#!/usr/bin/env node
'use strict';
/**
 * seed-ledger.js —— 把本次会话里**咨询过的每一个标的与结论**回填进研究台账
 *
 * 设计原则：
 *   1) 忠实还原当时说出口的话（结论、概率、关键位、操作计划），不做任何事后美化
 *   2) 锚定价一律**从真实行情拉取**，不用记忆里的数字
 *   3) 每条结论都强制标注证据等级（A硬数据 / B量化衍生 / C二手新闻 / D模型推断 / E主观叙事）
 *   4) 对"人工覆写系统模型"的案例（金正大），同时记录两套预测，日后可对比谁更准
 *
 * 用法：
 *   node seed-ledger.js            # 幂等：已存在的 id 会跳过
 *   node seed-ledger.js --force    # 先清空台账再重建
 */

const fs = require('fs');
const path = require('path');

const market = require('./lib/market');
const L = require('./lib/research-ledger');
const { HORIZON_DAYS } = require('./lib/rl');

const ROOT = __dirname;
const FORCE = process.argv.includes('--force');

// ------------------------------------------------------------ 工具

/** 拉真实日K，返回 { klines, closeOn(date) } */
async function fetchK(code, bars) {
  const { klines, quote } = await market.fetchTencentKline('day', bars || 260, code);
  return {
    klines,
    quote,
    closeOn(date) {
      const exact = klines.find((k) => k.date === date);
      if (exact) return exact.close;
      let best = null;
      for (const k of klines) if (k.date <= date) best = k;
      return best ? best.close : null;
    },
    dateOn(date) {
      const exact = klines.find((k) => k.date === date);
      if (exact) return date;
      let best = null;
      for (const k of klines) if (k.date <= date) best = k.date;
      return best;
    },
  };
}

/** 由锚定价与区间百分比生成价格带（与 engine.js 口径一致） */
function band(anchor, rangePct, dir, upProb) {
  const expected = dir === '看涨' ? rangePct * 0.4 : dir === '看跌' ? -rangePct * 0.4 : 0;
  return {
    upProb,
    rangePct,
    expectedChg: +(expected).toFixed(2),
    priceLow: +(anchor * (1 - rangePct / 100)).toFixed(3),
    priceHigh: +(anchor * (1 + rangePct / 100)).toFixed(3),
  };
}

function pred(anchor, horizon, dir, upProb, rangePct, source) {
  return Object.assign({ horizon, dir, source: source || 'model' }, band(anchor, rangePct, dir, upProb));
}

// ------------------------------------------------------------ 主流程

async function main() {
  const ledgerPath = L.defaultLedgerPath();
  let db = FORCE ? L.blankLedger() : L.loadLedger(ledgerPath);
  const existing = new Set(db.entries.map((e) => e.id));
  console.log(`台账：${ledgerPath}（现有 ${db.entries.length} 条）`);

  const codes = ['159516', '159981', '512660', '512400', '688783', '002470', '002156', '159918'];
  const data = {};
  for (const c of codes) {
    try {
      data[c] = await fetchK(c, 320);
      console.log(`[行情] ${c} ${data[c].klines.length} 根，最新 ${data[c].klines[data[c].klines.length - 1].date} 收 ${data[c].klines[data[c].klines.length - 1].close}`);
      await new Promise((r) => setTimeout(r, 120));
    } catch (e) {
      console.warn(`[跳过] ${c}：${e.message}`);
    }
  }

  const add = (id, e) => {
    if (existing.has(id)) { console.log(`[跳过] ${id} 已存在`); return; }
    L.addEntry(db, Object.assign({ id }, e));
    existing.add(id);
    console.log(`[新增] ${id} ${e.name}`);
  };

  const g = (code, date) => (data[code] ? data[code].closeOn(date) : null);
  const gd = (code, date) => (data[code] ? data[code].dateOn(date) : date);

  // =========================================================== 2026-09-10 批次
  const D0910 = '2026-09-10';

  // --- 159516 半导体设备ETF ---
  {
    const c = '159516', d = gd(c, D0910), a = g(c, D0910);
    add(`20260910-${c}-01`, {
      code: c, name: '半导体设备ETF国泰', kind: 'etf',
      askedAt: D0910 + 'T15:30:00+08:00',
      question: '半导体设备ETF(159516) 与 能源化工ETF 走势与拐点判断',
      verdict: '偏空（两个月概率加权目标 0.63，约 -5.4%）。空头排列 + 负动量 + 缩量，评分 9/100（轮动池最低档），拐点未到。',
      stance: 'bearish', confidence: 0.62, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 41, 5.0),
        pred(a, 'd3', '看跌', 22, 8.5),
        pred(a, 'w1', '看跌', 27, 13.1),
        pred(a, 'm1', '看跌', 29, 23.1),
      ],
      keyLevels: { support: [0.605, 0.580], resistance: [0.667, 0.677, 0.7078], stopLoss: 0.5980, note: 'MA5 0.6668 / MA10 0.6772 / MA20 0.7078 / MA60 0.7618' },
      plan: '不建仓。拐点候选窗口 11月下旬~12月中旬；观察是否能重新站上 MA20。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K（前复权）', claim: `2026-09-10 收盘 ${a}，近60日 -14.6%` },
        { grade: 'B', type: 'derived', source: '自算指标', claim: '空头排列（MA5<MA10<MA20<MA60），RSI6 约 32，ATR 0.0278' },
        { grade: 'A', type: 'data', source: '东方财富主力资金流', claim: '主力资金中性，无连续净流入' },
        { grade: 'C', type: 'news', source: 'web_search 行业新闻', claim: '半导体设备国产化推进、存储涨价周期' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 9/100，1月上涨概率 29%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '6月暴涨168%后的估值与筹码消化尚未结束' },
      ],
      tags: ['报告', '轮动池'],
    });
  }

  // --- 159981 能源化工ETF ---
  {
    const c = '159981', d = gd(c, D0910), a = g(c, D0910);
    add(`20260910-${c}-01`, {
      code: c, name: '能源化工ETF建信', kind: 'etf',
      askedAt: D0910 + 'T15:30:00+08:00',
      question: '半导体设备ETF(159516) 与 能源化工ETF 走势与拐点判断',
      verdict: '偏多（两个月概率加权目标 1.83，约 +3.5%）。全池最强，但短期已过热，等回踩 + 折价确认再介入。',
      stance: 'bullish', confidence: 0.60, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 51, 2.3),
        pred(a, 'd3', '看涨', 80, 4.0),
        pred(a, 'w1', '看涨', 68, 6.1),
        pred(a, 'm1', '看涨', 63, 10.8),
      ],
      keyLevels: { support: [1.7016, 1.6291], resistance: [1.813, 1.879], note: 'MA5 1.7422 / MA10 1.7016 / MA20 1.6291' },
      plan: '等回踩 MA10 附近、且折价/平价为负时建仓；短期不追高。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `2026-09-10 收盘 ${a}，多头排列` },
        { grade: 'A', type: 'data', source: '天天基金 FundMNFInfo', claim: '净值连涨（真实收益，非情绪炒作）' },
        { grade: 'B', type: 'derived', source: '自算指标', claim: 'MA5>MA10>MA20 完美多头排列，量比显著放大' },
        { grade: 'C', type: 'news', source: 'web_search 化工新闻', claim: '化工品全面涨价（供给收缩 + 成本推动）' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 60/100，1月上涨概率 63%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '反内卷 + 韩国乙烯退出是中期主线' },
      ],
      tags: ['报告', '持仓相关'],
    });
  }

  // --- 512660 军工ETF ---
  {
    const c = '512660', d = gd(c, D0910), a = g(c, D0910);
    add(`20260910-${c}-01`, {
      code: c, name: '军工ETF国泰', kind: 'etf',
      askedAt: D0910 + 'T15:30:00+08:00',
      question: '军工ETF(512660) 与 有色ETF(512400) 未来两个月走势与拐点',
      verdict: '偏多（两个月概率加权目标 1.26，约 +6.5%）。拐点已过，但 RSI 82.3 极端超买，等回调买点而非追高。',
      stance: 'bullish', confidence: 0.58, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '看跌', 39, 2.2),
        pred(a, 'd3', '看涨', 70, 3.7),
        pred(a, 'w1', '震荡', 60, 5.7),
        pred(a, 'm1', '震荡', 58, 10.0),
      ],
      keyLevels: { support: [1.1368, 1.1604], resistance: [1.495], note: 'MA5 1.168 / MA10 1.155 / MA20 1.137 / MA60 1.160' },
      plan: '不追高。回调至 MA20（约 1.137）附近分批建仓；本轮作为科技主线之外的第二配置。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `2026-09-10 收盘 ${a}` },
        { grade: 'B', type: 'derived', source: '自算指标', claim: 'RSI 82.3 极端超买；短均线多头、站上 MA60、放量' },
        { grade: 'C', type: 'news', source: 'web_search 军工新闻', claim: '十五五规划、地缘冲突催化，主题催化最明确' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 58/100（中性震荡）' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '阅兵后订单落地预期' },
      ],
      tags: ['报告', '轮动池'],
    });
  }

  // --- 512400 有色金属ETF ---
  {
    const c = '512400', d = gd(c, D0910), a = g(c, D0910);
    add(`20260910-${c}-01`, {
      code: c, name: '有色金属ETF南方', kind: 'etf',
      askedAt: D0910 + 'T15:30:00+08:00',
      question: '军工ETF(512660) 与 有色ETF(512400) 未来两个月走势与拐点',
      verdict: '中性偏多（两个月概率加权目标 1.90，约 +3.9%）。高位缩量待变盘（量比 0.60），方向由 FOMC 决定，拐点未到。',
      stance: 'neutral', confidence: 0.50, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 51, 3.2),
        pred(a, 'd3', '震荡', 41, 5.4),
        pred(a, 'w1', '震荡', 43, 8.3),
        pred(a, 'm1', '震荡', 42, 14.7),
      ],
      keyLevels: { support: [1.559], resistance: [1.950, 2.097], note: '箱体 1.78~1.95' },
      plan: '箱体震荡对待，先看 9 月 FOMC 结果再决定方向；若转鸽则弹性大于军工。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `2026-09-10 收盘 ${a}，量比仅 0.60（极度缩量）` },
        { grade: 'B', type: 'derived', source: '自算指标', claim: '跌破 MA10/MA20，正动量但趋势转弱' },
        { grade: 'C', type: 'news', source: 'web_search 有色新闻', claim: '工业金属强、贵金属弱，内部分化严重' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 31/100（强势看空），1月上涨概率 42%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: 'FOMC 是唯一的关键变量' },
      ],
      tags: ['报告', '轮动池'],
    });
  }

  // --- 688783 西安奕材-U ---
  {
    const c = '688783', d = gd(c, D0910), a = g(c, D0910);
    add(`20260910-${c}-01`, {
      code: c, name: '西安奕材-U', kind: 'stock',
      askedAt: D0910 + 'T15:30:00+08:00',
      question: '西安奕材(688783) 10月解禁专题：何时入场布局合适？（当时已亏 46000，总仓位 30W，已空仓）',
      verdict: '回避（不买入）。10/28 解禁 28.3686 亿股（占总股本 70.26%、流通盘 1055%），流通盘膨胀 11.5 倍属估值体系重构。主拐点窗口 2026-11-20 ~ 12-15（概率 40%）。',
      stance: 'avoid', confidence: 0.72, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 44, 7.7),
        pred(a, 'd3', '看跌', 18, 13.1),
        pred(a, 'w1', '看跌', 23, 20.0),
        pred(a, 'm1', '看跌', 28, 35.4),
      ],
      keyLevels: { support: [24.02], resistance: [30.09, 37.58], note: '7/28 解禁当日 -19.98%，3日 -32.3%，底 24.02' },
      plan: '解禁前不碰。解禁落地后观察 90 日减持节奏；12 月指数调仓（科创50/中证500）被动买盘是主要机会。',
      evidence: [
        { grade: 'A', type: 'data', source: '东方财富 RPT_LIFT_STAGE 限售解禁', claim: '2026-10-28 解禁 28.3686 亿股 / 70 名股东 / 占总股本 70.26% / 为流通盘 1054.99% / 市值约 749~763 亿元' },
        { grade: 'A', type: 'data', source: '东方财富 F10 股东研究 + 股本结构', claim: '总股本 40.378 亿股，流通 2.689 亿股（6.66%）；股东户数 46,201（6/30）较 4/20 +18.5%' },
        { grade: 'A', type: 'data', source: '2026 年中报', claim: '营收 15.89 亿（+22%），净利 -2.89 亿；Q2 毛利率 5.64% vs Q1 2.58%；每股净资产 3.008' },
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: '7/28 解禁当日 -19.98%，3 日 -32.3%，随后反弹 +57.5%（本股自身的历史模板）' },
        { grade: 'B', type: 'derived', source: '自算指标', claim: `PS(TTM) 36.3×、PB 8.78×（按 2026-09-10 收盘 ${a}）；空头排列，RSI 约 23` },
        { grade: 'C', type: 'news', source: 'web_search', claim: '科创板未盈利企业控股股东锁定期 36 个月，故 10/28 解禁主体全部为纯财务投资者' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 15/100，1月上涨概率 28%；轮动模型仓位 0%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '主拐点落在 11月下旬~12月中（解禁消化 + 指数纳入被动买盘）' },
      ],
      tags: ['报告', '解禁', '轮动池'],
    });
  }

  // --- 159918 勘误 ---
  add('20260910-159918-01', {
    code: '159918', name: '159918 代码勘误', kind: 'correction',
    askedAt: D0910 + 'T15:30:00+08:00',
    question: '159918 是不是能源化工ETF？',
    verdict: '❌ 勘误：159918 **不是**能源化工ETF，而是**中创400ETF嘉实**，日成交额仅约 101 万元，基本不可交易。正确的能源化工ETF是 **159981 能源化工ETF建信**。',
    stance: 'avoid', confidence: 0.95, horizon: 'd1',
    scorable: false,
    anchorDate: gd('159918', D0910), anchorPrice: g('159918', D0910),
    predictions: [],
    evidence: [
      { grade: 'A', type: 'data', source: '腾讯财经行情 + K线', claim: '159918 名称为中创400ETF嘉实，日均成交约 101 万元' },
    ],
    lessons: '教训：**代码必须先核验名称再分析**。"159xxx 都是能源化工"是错误的一厢情愿。已修复 /api/kline 与 /api/minute 返回硬编码名称的 bug（此前所有代码都返回 NAME），并把标的名称校验加入常规流程。',
    tags: ['勘误', '流程改进'],
  });

  // =========================================================== 2026-09-11 批次
  const D0911 = '2026-09-11';

  // --- 002470 金正大（人工覆写系统模型）---
  {
    const c = '002470', d = gd(c, D0911), a = g(c, D0911);
    add(`20260911-${c}-01`, {
      code: c, name: '金正大', kind: 'stock',
      askedAt: D0911 + 'T18:00:00+08:00',
      question: '金正大(002470) 这支股票现在可以建仓吗？',
      verdict: '❌ 不可建仓，评级回避。9/9 缩量一字板 → 9/10 放量炸板（682 万股 = 3.1 倍均量，-9.7%）→ 9/11 续跌，教科书级主力派发；Q2 单季巨亏 5.08 亿；担保余额占净资产 54.77%；PB 4.76。',
      stance: 'avoid', confidence: 0.80, horizon: 'w1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        // 人工覆写（最终结论）
        pred(a, 'd1', '看跌', 30, 6.5, 'human-override'),
        pred(a, 'd3', '看跌', 28, 11.1, 'human-override'),
        pred(a, 'w1', '看跌', 28, 17.0, 'human-override'),
        // 系统模型原样输出（对照，用于日后比较"人工覆写 vs 模型"谁更准）
        pred(a, 'd3', '看涨', 70, 11.1, 'model'),
        pred(a, 'w1', '看涨', 69, 17.0, 'model'),
        pred(a, 'm1', '看涨', 63, 30.1, 'model'),
      ],
      keyLevels: { support: [2.16, 2.25], resistance: [2.51, 2.78], note: '概率加权目标 2.21（-6.4%）' },
      plan: '不建仓。除非出现：①放量收复 2.51 并站稳 ②Q3 亏损大幅收窄 ③担保问题有实质解决。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `9/9 一字板 2.78（量 107 万）→ 9/10 开 2.78 收 2.51（-9.7%，量 682 万 = 3.1× 均量）→ 9/11 收 ${a}` },
        { grade: 'A', type: 'data', source: '2026 年中报', claim: '营收 59.53 亿（+24%），净利 -4.97 亿（-534%）；Q2 单季 -5.08 亿（磷石膏处置费 4.13 亿 + 减值）' },
        { grade: 'A', type: 'data', source: '公司公告', claim: '担保余额占净资产 54.77%；每股净资产 0.4967' },
        { grade: 'B', type: 'derived', source: '自算指标', claim: `PB 4.76（按 ${a} / 每股净资产 0.4967）；炸板派发形态` },
        { grade: 'C', type: 'news', source: '公开历史', claim: '2022 年百亿财务造假、2021 年 *ST、大股东破产风险' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 58/100，但 predict() 输出看涨 69~70%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '系统预测存在"滞后陷阱"，盘口结构剧变必须人工覆盖' },
      ],
      lessons: '关键方法论收获：**模型擅长"顺势"，不擅长"识别转折"**。遇到一字板炸板这类盘口结构剧变，必须由人工判断覆盖模型输出。这一条已写入系统改进清单。',
      tags: ['个股', '人工覆写系统', '对照实验'],
    });
  }

  // --- 002156 通富微电 ---
  {
    const c = '002156', d = gd(c, D0911), a = g(c, D0911);
    add(`20260911-${c}-01`, {
      code: c, name: '通富微电', kind: 'stock',
      askedAt: D0911 + 'T20:00:00+08:00',
      question: '6 个月内布局什么板块回本概率最大？半导体设备/军工/能源化工/有色，还是个股西安奕材、通富微电？',
      verdict: '不选个股。通富微电基本面很强（2026H1 营收 160.41 亿 +23.03%，净利 17.17 亿 +316.77%，AI 封测/AMD 逻辑），但技术面空头排列、RSI 39.3、PB 5.23，波动远大于 ETF。6 个月回本目标下，应选 ETF 而非个股。',
      stance: 'avoid', confidence: 0.62, horizon: 'm1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 45, 4.4),
        pred(a, 'd3', '看跌', 38, 7.5),
        pred(a, 'w1', '看跌', 35, 11.5),
        pred(a, 'm1', '看跌', 32, 20.3),
      ],
      keyLevels: { support: [52.0], resistance: [64.0, 84.7], note: '距 120 日高 84.7 为 -31.5%' },
      plan: '不建仓。若坚持要买科技弹性，用 159516 ETF 替代，个股波动率约 ETF 的 1.8 倍。',
      evidence: [
        { grade: 'A', type: 'data', source: '2026 年中报', claim: '营收 160.41 亿 +23.03%，净利 17.17 亿 +316.77%，Q2 单季净利 13.88 亿，境外营收超百亿' },
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `2026-09-11 收盘 ${a}，距 120 日高 84.7 为 -31.5%` },
        { grade: 'B', type: 'derived', source: '自算指标', claim: '空头排列，RSI12 39.3，ATR 4.42%（波动率约为 ETF 的 1.8 倍）；BPS 11.098 → PB 5.23' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 12/100，1月预期 -10.8%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '回本目标下应降低波动、提高胜率，个股不符合' },
      ],
      tags: ['个股', '回本方案'],
    });
  }

  // =========================================================== 2026-09-13 明日判断（锚定 9/11 收盘）
  const D0913 = '2026-09-13';

  {
    const c = '159516', d = gd(c, D0911), a = g(c, D0911);
    add(`20260913-${c}-02`, {
      code: c, name: '半导体设备ETF国泰', kind: 'etf',
      askedAt: D0913 + 'T11:20:00+08:00',
      question: '判断明日（周一 9/14）半导体设备等走势；为何美联储加息概率变大反而美股会涨；A股能持续吗；能源化工明日前景如何',
      verdict: '高开震荡、冲高回落。区间 0.638~0.672。费半 +1.81% 只够支撑一个高开，美债 4.975% 逼近 5% + FOMC(9/16-17) 避险压制持续性。**明确不建议追高**，等 9/18 FOMC 落地。',
      stance: 'neutral', confidence: 0.48, horizon: 'd1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 45, 2.6),
      ],
      keyLevels: { support: [0.640, 0.630, 0.605], resistance: [0.667, 0.677], note: 'MA5 0.667 是反弹生死线' },
      plan: '不加仓。仓位维持 0~15%。等 9/18 FOMC 落地后重新评估。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `9/11 收盘 ${a}，日K连二黑` },
        { grade: 'A', type: 'data', source: 'Yahoo Finance ^SOX', claim: '费城半导体指数 11824，9/11 +1.81%' },
        { grade: 'A', type: 'data', source: 'Yahoo Finance ^TNX', claim: '美债 10Y 4.975%，20日 +33.4bp，逼近 52 周高 4.985' },
        { grade: 'B', type: 'derived', source: '自算指标', claim: `MA5 ${(0.650 * 1.026).toFixed(3)} 附近为压力；ATR 0.0278` },
        { grade: 'C', type: 'news', source: 'web_search 财经新闻', claim: '美国 8 月 CPI 同比 +3.4% 符合预期、环比 +0.4% 反弹、核心 CPI 环比超预期；瑞银转鹰"9月12月各加25bp"' },
        { grade: 'C', type: 'news', source: 'web_search', claim: '"美国10年期公债殖利率逼近5% 威胁AI融资热潮"、"美长债收益率飙升 纳指100面临估值重压"' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '空头排列，系统评分处于低位' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '"美股涨不等于A股半导体能涨"——美债逼近5%对高PS成长股是即时估值压制' },
      ],
      lessons: '该结论**以 C+D+E 级依据为主**（周末只能靠新闻），是本次台账中证据等级最弱的一类。明日收盘后必须回看，验证"高开冲高回落"是否成立。',
      tags: ['明日判断', '证据偏弱'],
    });
  }

  {
    const c = '159981', d = gd(c, D0911), a = g(c, D0911);
    add(`20260913-${c}-02`, {
      code: c, name: '能源化工ETF建信', kind: 'etf',
      askedAt: D0913 + 'T11:20:00+08:00',
      question: '能源化工明日前景如何？',
      verdict: '偏空。区间 1.720~1.770。新增关键利空：**伊朗与海湾六国下周会晤 → 油价应声走低**，直接削弱化工成本推动逻辑；叠加周五化工品篮子由正转负（-0.59%）、甲醇面临压力、放量长上影。',
      stance: 'bearish', confidence: 0.52, horizon: 'd1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '看跌', 35, 2.9),
      ],
      keyLevels: { support: [1.7422, 1.736, 1.7016], resistance: [1.813], note: 'MA5 1.7422 是短线生死线' },
      plan: '有持仓者：反弹至 1.775~1.785 减仓/平仓；跌破 1.736 减半；跌破 1.700 止损。无持仓者不参与。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `9/11 收盘 ${a}（-0.57%），换手 45.51%，成交 16.12 亿，量 905 万手 = 2.06×20日均量，长上影 3.07%` },
        { grade: 'A', type: 'data', source: '新浪期货 PTA/甲醇/玻璃/纯碱/短纤/烧碱/PX', claim: '化工品期货篮子收盘 -0.59%（烧碱 -2.27%、甲醇 -1.24%、PX -0.65%）' },
        { grade: 'A', type: 'data', source: '天天基金净值 + 篮子估算', claim: '折溢价约 -0.39%（折价，无溢价风险）' },
        { grade: 'C', type: 'news', source: 'web_search', claim: '"伊朗与海湾六国下周会晤 油价应声走低"——霍尔木兹风险溢价回落' },
        { grade: 'C', type: 'news', source: 'web_search', claim: '"PTA、塑料价格维持高位震荡 甲醇或面临一定压力"（9/12）' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 58/100（偏多），1月预期 +2.88%——**与本次人工判断方向相反**' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '放量长上影 + 油价转弱 = 短期动能衰竭' },
      ],
      lessons: '本条再次出现"人工判断与系统模型方向相反"（模型偏多、人工偏空）。这是第二个对照样本，与金正大一起构成"人工覆写是否有效"的检验集。',
      tags: ['明日判断', '人工覆写系统', '对照实验'],
    });
  }

  {
    const c = '512660', d = gd(c, D0911), a = g(c, D0911);
    add(`20260913-${c}-02`, {
      code: c, name: '军工ETF国泰', kind: 'etf',
      askedAt: D0913 + 'T11:20:00+08:00',
      question: '判断明日半导体设备等走势（含军工）',
      verdict: '高位震荡。RSI 85.3 极度超买，**不追**。等回调至 MA20（约 1.137）再考虑。',
      stance: 'neutral', confidence: 0.50, horizon: 'd1',
      anchorDate: d, anchorPrice: a,
      predictions: [
        pred(a, 'd1', '震荡', 48, 2.0),
      ],
      keyLevels: { support: [1.168, 1.137], resistance: [1.495], note: 'MA5 1.168 / MA20 1.137' },
      plan: '不追高。若回调至 1.137 附近且缩量，可分批建仓（作为 159516 之外的第二配置）。',
      evidence: [
        { grade: 'A', type: 'data', source: '腾讯财经日K', claim: `9/11 收盘 ${a}` },
        { grade: 'B', type: 'derived', source: '自算指标', claim: 'RSI 85.3 极度超买，ATR 0.0229' },
        { grade: 'D', type: 'model', source: '本系统 predict()', claim: '综合评分 62/100（偏多），1月预期 +1.66%' },
        { grade: 'E', type: 'narrative', source: '本人判断', claim: '超买后大概率以时间换空间，而非直接转跌' },
      ],
      tags: ['明日判断'],
    });
  }

  // =========================================================== 组合方案（6 个月回本）
  add('20260913-PORTFOLIO-01', {
    code: 'PORTFOLIO', name: '6个月回本组合方案', kind: 'portfolio',
    klineCode: '159516',   // 组合以主力标的 159516 作为结算代理（占比 55%）
    askedAt: D0913 + 'T10:00:00+08:00',
    question: '目前空仓，总仓位 49W，已亏 12W（回本需 +24.49%），未来 6 个月布局什么板块回本概率最大？只想做一两个票或 ETF。',
    verdict: '方案：159516 半导体设备ETF 55% + 512660 军工ETF 25% + 现金 20%。分批建仓：现在 25% → 10/20~11/15 加到 60% → 11/17~12/15 加到 80%。最佳加仓窗口 10/28（西安奕材解禁）至 11 月中。止损 8%。\n诚实概率：完全回本 35% ／ 回本一半 40% ／ 继续亏损 25%。',
    stance: 'neutral', confidence: 0.45, horizon: 'm6',
    anchorDate: '2026-09-11', anchorPrice: null,
    predictions: [
      { horizon: 'm6', dir: '看涨', source: 'model', upProb: 40, rangePct: 30.5, expectedChg: 12.2, priceLow: null, priceHigh: null, note: '以组合口径：需要 +24.49% 才回本，给 40% 上涨概率' },
    ],
    keyLevels: { stopLossPct: 8 },
    plan: '① 现在先建 25% 仓位（159516 为主）；② 10/20~11/15 加到 60%；③ 11/17~12/15 加到 80%；④ 全程止损 8%，不加杠杆；⑤ 只在 159516 与 512660 之间分配，不碰个股。',
    evidence: [
      { grade: 'A', type: 'data', source: '腾讯财经日K（各标的）', claim: '159516 距 120 日高 +62.0% 空间；512660 距高 +28.1%；两者 ATR 分别为 0.0278 / 0.0229' },
      { grade: 'A', type: 'data', source: '东方财富解禁日历', claim: '10/28 西安奕材解禁是未来 6 个月科技板块最大的单一事件风险' },
      { grade: 'B', type: 'derived', source: '组合回本测算', claim: '49 万亏 12 万 → 需 +24.49%；按 159516 弹性估算需约 +45% 标的涨幅（80% 仓位口径）' },
      { grade: 'D', type: 'model', source: '本系统 predict()', claim: '159516 当前仍为空头排列，系统评分低位；模型不支持"立刻满仓"' },
      { grade: 'E', type: 'narrative', source: '本人判断', claim: '最佳加仓窗口在 10/28 解禁落地至 11 月中（利空出尽 + 指数调仓）' },
    ],
    lessons: '本方案的核心风险：**回本所需 +24.49% 接近标的 6 个月的 1.2 倍 ATR 区间上限**，属于"需要行情配合"的目标，不是"努力就能做到"的目标。已如实告知概率分布而非只给乐观路径。',
    tags: ['组合方案', '回本', '重要'],
  });

  // =========================================================== 宏观问答（不可打分，纯留痕）
  add('20260913-MACRO-01', {
    code: 'MACRO', name: '宏观问答：加息为何美股涨 / A股能否持续', kind: 'question',
    askedAt: D0913 + 'T11:20:00+08:00',
    question: '为何美联储加息概率变大反而美股会涨？A股能持续吗？',
    verdict: '四点解释：①加息的"原因"（经济强+通胀）比"动作"更重要；②从"加不加"到"加几次"，**不确定性被消除**；③这是**通胀交易**而非宽松交易（美股金银齐涨是特征）；④盈利改善暂时压过估值压缩。\n⚠️ 但**美债 4.975% 逼近 5% 是分水岭**——估值压缩阶段即将到来，对 A 股高 PS 半导体设备是直接压制。"美股涨 ≠ A 股半导体能涨"。\nA 股判断：9/11 沪指 -1.18% 连二黑、超 4800 只下跌，**短期难以持续反弹**，震荡磨底至 9/18 FOMC 落地。',
    stance: 'neutral', confidence: 0.55, horizon: 'w1',
    scorable: false,
    anchorDate: D0911,
    predictions: [],
    evidence: [
      { grade: 'A', type: 'data', source: 'Yahoo Finance', claim: '美债 10Y 4.975%（52周高 4.985）；费半 11824 +1.81%；中债 10Y 1.6897%' },
      { grade: 'A', type: 'data', source: '腾讯财经指数行情', claim: '9/11 沪指 -1.18%，科创50 -1.01%，超 4800 只个股下跌，放量走"V"' },
      { grade: 'C', type: 'news', source: 'web_search', claim: '"美国8月CPI同比+3.4%、环比+0.4%"、"从加不加息到加几次 美联储加息预期急剧升温"、"美股、金银齐涨"' },
      { grade: 'C', type: 'news', source: 'web_search', claim: '"美长债收益率飙升 纳指100面临估值重压"、"A股重回年内低位，机构建议大胆布局"' },
      { grade: 'E', type: 'narrative', source: '本人推理', claim: '加息初期的"盈利改善 > 估值压缩"正在向"估值压缩主导"切换' },
    ],
    lessons: '本条是**纯观点**，无法用单一价格结算，因此标记为不可打分。它的价值在于留痕：如果后续美债破 5% 后成长股真的杀估值，说明这条推理成立；如果没有，说明推理错误。**不应把不可证伪的观点当成结论使用。**',
    tags: ['宏观', '不可打分'],
  });

  // ------------------------------------------------------------ 落盘
  L.saveLedger(db, ledgerPath);
  const st = L.stats(db);
  console.log('\n=== 台账已建立 ===');
  console.log(`条目 ${st.totalEntries}：已结算 ${st.resolvedEntries}／部分 ${st.partialEntries}／待结算 ${st.openEntries}／记录类 ${st.recordEntries}／不可结算 ${st.unresolvableEntries}`);
  console.log(`可判定预测 ${st.scoredOutcomes} 个`);
  if (st.scoredOutcomes) console.log(`方向命中率 ${(st.hitRate * 100).toFixed(1)}%，Brier ${st.brier}，奖励 ${st.reward}`);
  console.log('\n下一步：node ledger.js resolve   # 拉真实行情结算所有到期预测');
}

main().catch((e) => { console.error(e); process.exit(1); });
