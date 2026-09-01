/**
 * 每日交易策略报告生成器（零依赖，仅用 Node 内置模块）
 *
 * 用法：
 *   node daily-report.js                 # 生成并打印当日报告，同时保存到 data/reports/
 *   node daily-report.js --print-only    # 只打印，不保存
 *   node daily-report.js --period week   # 用周K生成报告（默认 day）
 *
 * 数据源：腾讯行情（前复权日K + 实时 qt），复用本项目 indicators.js / engine.js 的策略引擎。
 * 免责声明：本报告仅供学习研究，不构成任何投资建议。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Indicators = require('./public/static/indicators.js');
const Engine = require('./public/static/engine.js');
const { fetchTencentKline, calibrateKlines, fetchFundFlow, fetchMarketBreadth, fetchNewsSentiment, fetchIndexKline, fetchHhxgSnapshot, fetchUs10y, fetchCn10y, fetchSox } = require('./lib/market.js');

// ---------- 配置 ----------
const CODE = '159516';
const NAME = '半导体设备ETF国泰';
const STATE_FILE = path.join(__dirname, 'data', 'account.json');
const REPORT_DIR = path.join(__dirname, 'data', 'reports');
const LIMIT = 260;

// ---------- 命令行参数 ----------
const args = process.argv.slice(2);
const PERIOD = args.includes('--period') && args[args.indexOf('--period') + 1] ? args[args.indexOf('--period') + 1] : 'day';
const PRINT_ONLY = args.includes('--print-only');

// ---------- 格式化工具 ----------
function fmt(n, d) { return (n == null || isNaN(n)) ? '--' : (+n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
function fmtPrice(n) { return n == null ? '--' : (+n).toFixed(3); }
function signed(n, d) { if (n == null) return '--'; return (n > 0 ? '+' : '') + (+n).toFixed(d === undefined ? 2 : d); }
function signedFmt(n, d) { if (n == null) return '--'; return (n > 0 ? '+' : (n < 0 ? '-' : '')) + fmt(Math.abs(n), d); }

// ---------- 账户 ----------
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) { console.error('[state] 读取失败:', e.message); }
  return { name: NAME, code: CODE, totalCapital: 500000, cash: 500000, shares: 0, avgCost: 0, realizedPnl: 0, trades: [], reviews: [] };
}

// ---------- 报告生成 ----------
function renderReport(analysis, instruction, state, quote, klines, period, rotation, prediction) {
  const L = [];
  const line = (s) => L.push(s || '');
  const hr = (c) => line(c.repeat(58));

  const q = quote || {};
  const now = new Date();
  const reportDate = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString('zh-CN', { weekday: 'long' });
  const quoteTime = (q.time && q.time.length >= 12) ? (q.time.slice(0, 4) + '-' + q.time.slice(4, 6) + '-' + q.time.slice(6, 8) + ' ' + q.time.slice(8, 10) + ':' + q.time.slice(10, 12)) : '--';

  hr('═');
  line(`  ${state.name}(${CODE}) 每日交易策略报告`);
  hr('═');
  line(`  报告日期：${reportDate}（${weekday}）    周期：${period === 'week' ? '周K' : '日K'}`);
  line(`  行情时间：${quoteTime}    数据源：腾讯行情（前复权）`);
  line(`  风险偏好：平衡    止损 ${Engine.DEFAULT_SETTINGS.stopPct}% / 止盈 ${Engine.DEFAULT_SETTINGS.takePct}% / 资金分 ${Engine.DEFAULT_SETTINGS.lots} 份`);
  line('');

  // 零、ETF轮动决策
  if (rotation && rotation.sorted && rotation.sorted.length) {
    line('【ETF轮动决策】');
    line('  ──────────────────────────────────────────');
    line(`   决策          ${rotation.action}${rotation.pick ? '：' + rotation.pick.name + 'ETF' : ''}（${rotation.reason}）`);
    line(`   目标仓位      ${rotation.targetPct}%`);
    line(`   轮动排行      ` + rotation.sorted.map((x, i) => `${i + 1}.${x.name} ${fmt(x.rotation.mom20, 1)}%(${x.rotation.score}分)`).join('  '));
    line('');
  }

  // 一、今日行情
  line('一、今日行情');
  line('  ──────────────────────────────────────────');
  line(`   最新价       ${fmtPrice(q.price)}`);
  line(`   涨跌         ${q.change != null ? signed(q.change, 3) : '--'}（${q.pctChange != null ? signed(q.pctChange, 2) + '%' : '--'}）`);
  line(`   今开 / 昨收   ${fmtPrice(q.open)} / ${fmtPrice(q.prevClose)}`);
  line(`   最高 / 最低   ${fmtPrice(q.high)} / ${fmtPrice(q.low)}`);
  line(`   振幅          ${q.amplitude != null ? fmt(q.amplitude, 2) + '%' : '--'}`);
  line(`   换手率        ${q.turnover != null ? fmt(q.turnover, 2) + '%' : '--'}`);
  line(`   成交额        ${q.amount != null ? fmt(q.amount / 10000, 2) + ' 亿元' : '--'}`);
  line('');

  // 二、综合评分
  line('二、综合评分与状态');
  line('  ──────────────────────────────────────────');
  line(`   综合评分      ${analysis.score} / 100  →  ${analysis.status}`);
  line(`   目标仓位      ${analysis.targetPct}%`);
  const v = analysis.indicators;
  line(`   ATR 波动率    ${fmt(v.atrPct, 2)}%${v.atrPct > 3.5 ? '（高波动，注意风险）' : v.atrPct > 2.5 ? '（波动偏大）' : v.atrPct > 2 ? '（波动适中）' : '（波动较小）'}`);
  line('');

  // 二点五、前瞻预测
  if (prediction && prediction.summary) {
    const p = prediction;
    const name = { d1: '未来1天', d3: '未来3天', w1: '未来1周', m1: '未来1月' };
    const arrow = (dir) => (dir === '看涨' ? '↑' : dir === '看跌' ? '↓' : '→');
    line('【前瞻预测】');
    line('  ──────────────────────────────────────────');
    for (const k of ['d1', 'd3', 'w1', 'm1']) {
      const x = p[k];
      line(`   ${name[k]}      ${arrow(x.dir)}${x.dir}  上涨概率 ${x.upProb}% / 下跌 ${x.downProb}%  预期区间 ±${x.rangePct}%（${fmtPrice(x.priceLow)} ~ ${fmtPrice(x.priceHigh)}）`);
    }
    line(`   综合判断    未来1周${p.summary.dir}（上涨概率 ${p.summary.upProb}%）`);
    line(`   关键依据    ${p.summary.keySignals.join('、')}`);
    line('');
  }

  // 三、技术指标速览
  line('三、技术指标速览');
  line('  ──────────────────────────────────────────');
  line(`   均线   MA5=${fmtPrice(v.ma5)}  MA10=${fmtPrice(v.ma10)}  MA20=${fmtPrice(v.ma20)}  MA60=${fmtPrice(v.ma60)}`);
  line(`   MACD   DIF=${v.dif == null ? '--' : (+v.dif).toFixed(4)}  DEA=${v.dea == null ? '--' : (+v.dea).toFixed(4)}  柱=${v.macd == null ? '--' : (+v.macd).toFixed(4)}`);
  line(`   RSI    RSI6=${fmt(v.rsi6, 1)}  RSI12=${fmt(v.rsi12, 1)}  RSI24=${fmt(v.rsi24, 1)}`);
  line(`   KDJ    K=${fmt(v.k, 1)}  D=${fmt(v.d, 1)}  J=${fmt(v.j, 1)}`);
  line(`   BOLL   上=${fmtPrice(v.bollUpper)}  中=${fmtPrice(v.bollMid)}  下=${fmtPrice(v.bollLower)}`);
  line(`   资金    MFI=${fmt(v.mfi, 1)}  量比(5日)=${fmt(v.vRatio, 2)}  近20日高/低=${fmtPrice(v.h20)}/${fmtPrice(v.l20)}`);
  line('');

  // 四、资金面 / 情绪面 / 消息面 / 大盘
  const f = analysis.fund || {}, br = analysis.breadth, news = analysis.news, hxg = analysis.hhxg, mk = analysis.market || {};
  line('四、资金 / 情绪 / 消息 / 大盘');
  line('  ──────────────────────────────────────────');
  if (f.latest) {
    const fl = f.latest;
    line(`   主力资金    主力净占比 ${fmt(fl.mainNetInflowPct, 2)}%，${f.streakDays > 0 ? '连续净流入 ' + f.streakDays + ' 日' : f.streakDays < 0 ? '连续净流出 ' + (-f.streakDays) + ' 日' : '当日持平'}；5日累计 ${f.sum5 >= 0 ? '+' : ''}${fmt(f.sum5 / 1e8, 2)} 亿`);
  } else {
    line('   主力资金    --（数据不可用）');
  }
  if (hxg && hxg.sentimentIndex != null) {
    line(`   市场情绪    赚钱效应 ${fmt(hxg.sentimentIndex, 1)}（${hxg.sentimentLabel}），涨停 ${hxg.limitUp} / 跌停 ${hxg.limitDown}；半导体${hxg.semiInStrong ? '在' : '不在'}行业资金风口`);
  } else if (br && br.total) {
    line(`   市场情绪    上涨 ${br.up} / 下跌 ${br.down}（比 ${fmt(br.ratio, 2)}），涨停 ${br.limitUp} / 跌停 ${br.limitDown}`);
  } else {
    line('   市场情绪    --（数据不可用）');
  }
  if (hxg && hxg.newsCount) {
    line(`   消息面      净情感 ${hxg.newsScore >= 0 ? '+' : ''}${fmt(hxg.newsScore, 1)}（${hxg.newsPos}正/${hxg.newsNeg}负）`);
  } else if (news && news.available) {
    line(`   消息面      净情感 ${news.score >= 0 ? '+' : ''}${fmt(news.score, 1)}（${news.pos}正/${news.neg}负）${news.samples && news.samples.length ? '；例：' + news.samples[0] : ''}`);
  } else {
    line('   消息面      --（数据不可用）');
  }
  if (mk && mk.index && mk.index.ma60) {
    line(`   大盘趋势    沪深300 ${fmt(mk.index.price, 1)} ${mk.bearMarket ? '<' : '≥'} MA60 ${fmt(mk.index.ma60, 1)}（${mk.bearMarket ? '熊市环境，降仓' : '多头环境'}）；20日动量 ${fmt(mk.mom20, 2)}%`);
  }
  // 宏观 + 科技板块
  const macro = analysis.macro || {};
  if (macro.us10y && macro.us10y.price != null) {
    line(`   宏观利率    美债10Y ${fmt(macro.us10y.price, 3)}%${macro.us10y.chg20bp != null ? `（近月 ${signed(macro.us10y.chg20bp, 0)}bp）` : ''}${macro.us10y.high52 != null ? ` · 52周高 ${fmt(macro.us10y.high52, 3)}%` : ''}${macro.cn10y ? `；中债10Y ${fmt(macro.cn10y.price, 3)}%` : ''}`);
  }
  const sox = analysis.sox, rel = analysis.relStrength;
  if (sox || rel != null) {
    line(`   科技板块    ${sox && sox.chgPct != null ? '费半SOX ' + signed(sox.chgPct, 2) + '%（隔夜）' : '费半 --'}${rel != null ? ' · 科创50相对沪深300 20日超额 ' + signed(rel, 2) + '%' : ''}`);
  }
  line('');

  // 五、多空信号明细
  line('五、多空信号明细');
  line('  ──────────────────────────────────────────');
  const sigDir = (d) => d === 'bull' ? '多头' : d === 'bear' ? '空头' : '中性';
  const sigSign = (w) => w > 0 ? '+' + w : String(w);
  for (const s of analysis.signals) {
    const tag = s.dir === 'bull' ? '◆' : s.dir === 'bear' ? '◇' : '·';
    line(`   ${tag} [${sigDir(s.dir)}] ${s.name}：${s.text}（${sigSign(s.weight)}）`);
  }
  line('');

  // 六、账户状态
  const price = analysis.price;
  const shares = state.shares || 0;
  const marketValue = shares * price;
  const totalAsset = state.cash + marketValue;
  const totalPnl = totalAsset - state.totalCapital;
  const unreal = marketValue - (state.avgCost || 0) * shares;
  line('六、账户状态');
  line('  ──────────────────────────────────────────');
  line(`   总资产        ${fmt(totalAsset, 0)} 元（本金 ${fmt(state.totalCapital, 0)}，总盈亏 ${signedFmt(totalPnl, 0)} 元 / ${signed(state.totalCapital ? totalPnl / state.totalCapital * 100 : 0, 2)}%）`);
  line(`   可用现金      ${fmt(state.cash, 0)} 元`);
  line(`   持仓          ${fmt(shares, 0)} 份 @ ${fmtPrice(state.avgCost || 0)}，市值 ${fmt(marketValue, 0)} 元`);
  line(`   浮动盈亏      ${signedFmt(unreal, 0)} 元    已实现盈亏 ${signedFmt(state.realizedPnl, 0)} 元`);
  line('');

  // 七、仓位管理
  line('七、仓位管理');
  line('  ──────────────────────────────────────────');
  line(`   当前仓位      ${instruction.currentPct}%`);
  line(`   目标仓位      ${instruction.targetPct}%`);
  line(`   需调整        ${signedFmt(instruction.deltaShares, 0)} 份（约 ${fmt(Math.abs(instruction.deltaValue), 0)} 元，约 ${signed(instruction.deltaLots, 1)} 份资金）`);
  line('');

  // 八、今日可执行指令
  line('八、今日可执行指令');
  line('  ──────────────────────────────────────────');
  line(`   操作建议：${instruction.action}${instruction.side === 'buy' ? '（做多）' : instruction.side === 'sell' ? '（减仓）' : '（观望）'}`);
  if (instruction.side === 'buy') {
    line(`   目标仓位 ${instruction.targetPct}%，需加仓 ${fmt(instruction.deltaShares, 0)} 份（约 ${fmt(instruction.deltaValue, 0)} 元），建议分 3 批执行：`);
    for (const t of instruction.tranches) {
      line(`     第${t.step}批：${fmt(t.shares, 0)} 份（约 ${fmt(t.amount, 0)} 元）—— ${t.note}`);
    }
    line(`   ${instruction.buyZone}`);
  } else if (instruction.side === 'sell') {
    line(`   目标仓位 ${instruction.targetPct}%，需减仓 ${fmt(Math.abs(instruction.deltaShares), 0)} 份（约 ${fmt(Math.abs(instruction.deltaValue), 0)} 元）。`);
    line(`   ${instruction.sellZone}`);
  } else {
    line(`   当前仓位与目标仓位基本一致，持股不动，等待下一个信号（突破/回踩确认）再行动。`);
  }
  line(`   风控：止损价 ${fmtPrice(instruction.stopLoss)}（-${Engine.DEFAULT_SETTINGS.stopPct}%）· 止盈价 ${fmtPrice(instruction.takeProfit)}（+${Engine.DEFAULT_SETTINGS.takePct}%）。跌破止损无条件执行。`);
  line('');

  // 九、明日预案
  line('九、明日预案');
  line('  ──────────────────────────────────────────');
  if (analysis.score >= 60) line('   若评分维持 60 以上，维持多头思路，回踩 MA10/MA20 附近可低吸。');
  else if (analysis.score <= 40) line('   若评分维持 40 以下，控制仓位，反弹至压力位减仓。');
  else line('   若评分在 48~60 之间，观望为主，等待方向选择。');
  line(`   风控锚点：止损 ${fmtPrice(instruction.stopLoss)}，止盈 ${fmtPrice(instruction.takeProfit)}。`);
  line('');

  hr('═');
  line('  免责声明：本报告由模拟系统自动生成，仅供学习研究，不构成任何投资建议。');
  hr('═');

  return L.join('\n');
}

// ---------- 主流程 ----------
(async function main() {
  try {
    const { klines: rawKlines, quote } = await fetchTencentKline(PERIOD, LIMIT);
    if (!rawKlines.length) throw new Error('未获取到 K 线数据');
    const klines = calibrateKlines(rawKlines, quote, PERIOD);
    const state = loadState();
    const ind = Indicators.computeAll(klines);

    // 资金面 / 情绪面 / 消息面 / 大盘趋势 / 宏观 / 科技板块（任一失败静默降级）
    const [fundR, brR, newsR, idxR, hxgR, usR, cnR, soxR, relR] = await Promise.allSettled([
      fetchFundFlow(10), fetchMarketBreadth(), fetchNewsSentiment('半导体设备', 20),
      fetchIndexKline('1.000300', 80).then((kl) => {
        const closes = kl.map((k) => k.close);
        let ma60 = null;
        if (closes.length >= 60) { let s = 0; for (let i = closes.length - 60; i < closes.length; i++) s += closes[i]; ma60 = s / 60; }
        return { price: closes[closes.length - 1], ma60 };
      }),
      fetchHhxgSnapshot(),
      fetchUs10y(),
      fetchCn10y(),
      fetchSox(),
      Promise.all([fetchIndexKline('1.000688', 30), fetchIndexKline('1.000300', 30)]).then(([kc, hs]) => {
        const kc0 = kc[kc.length - 1].close, kc20 = kc[kc.length - 21].close;
        const hs0 = hs[hs.length - 1].close, hs20 = hs[hs.length - 21].close;
        return ((kc0 / kc20 - 1) - (hs0 / hs20 - 1)) * 100;
      }),
    ]);
    const extras = {
      fundFlow: fundR.status === 'fulfilled' ? fundR.value : null,
      breadth: brR.status === 'fulfilled' ? brR.value : null,
      news: newsR.status === 'fulfilled' ? newsR.value : null,
      index: idxR.status === 'fulfilled' ? idxR.value : null,
      hhxg: hxgR.status === 'fulfilled' ? hxgR.value : null,
      macro: { us10y: usR.status === 'fulfilled' ? usR.value : null, cn10y: cnR.status === 'fulfilled' ? cnR.value : null },
      sox: soxR.status === 'fulfilled' ? soxR.value : null,
      relStrength: relR.status === 'fulfilled' ? relR.value : null,
    };

    const analysis = Engine.analyze(klines, ind, quote, Engine.DEFAULT_SETTINGS, extras);
    const instruction = Engine.generateInstruction(analysis, state, Engine.DEFAULT_SETTINGS);

    // 多ETF轮动：并行抓取轮动池并打分
    const pool = [
      { code: '159516', name: '半导体设备' },
      { code: '512010', name: '医药' },
      { code: '512400', name: '有色' },
    ];
    const poolResults = await Promise.all(pool.map(async (e) => {
      try {
        const r = await fetchTencentKline('day', 260, e.code);
        const k = calibrateKlines(r.klines, r.quote, 'day');
        return { code: e.code, name: e.name, rotation: Engine.computeRotation(k) };
      } catch (err) { return { code: e.code, name: e.name, rotation: null }; }
    }));
    const bearMarket = !!(extras.index && extras.index.ma60 && extras.index.price < extras.index.ma60);
    const rotation = Engine.pickRotation(poolResults, { bearMarket, sentimentIndex: extras.hhxg ? extras.hhxg.sentimentIndex : null });

    // 前瞻预测（1天/3天/1周/1月）
    const prediction = Engine.predict(klines, analysis, extras);

    const report = renderReport(analysis, instruction, state, quote, klines, PERIOD, rotation, prediction);
    console.log(report);

    if (!PRINT_ONLY) {
      if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
      const dateStr = new Date().toISOString().slice(0, 10);
      const file = path.join(REPORT_DIR, `report-${dateStr}.md`);
      fs.writeFileSync(file, report);
      console.log(`\n[已保存] ${file}`);
    }
  } catch (e) {
    console.error('生成报告失败：', e.message);
    process.exitCode = 1;
  }
})();
