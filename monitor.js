/**
 * 半导体设备ETF(159516) 实时盯盘助手（零依赖，仅用 Node 内置模块）
 *
 * 功能：交易时段内定时轮询行情 → 复用 indicators.js / engine.js 策略引擎评分 →
 *       在「适当的时候」生成文字交易策略，并通过可插拔通道推送（微信/钉钉/短信网关/控制台）。
 *
 * 用法：
 *   node monitor.js             # 常驻盯盘（按 notify.config.json 的 channel 推送）
 *   node monitor.js --once      # 单次评估，打印当前策略与将触发的事件（不推送、不写状态）
 *   node monitor.js --dry-run   # 常驻但只打印到控制台，不实际推送
 *
 * 触发时机（“适当的时候”）：
 *   1. 开盘提醒       —— 每个交易日首次进入 9:30 后的交易时段
 *   2. 盘中快照       —— 每 reportIntervalMin 分钟输出一次常规策略
 *   3. 评分异动       —— 综合评分跨越关键阈值（36/48/60/72，对应状态切换）立即提醒
 *   4. 调仓提醒       —— 目标仓位偏离 ≥ 半份资金（0.5 份）时给出买卖指令
 *   5. 风控预警       —— 持仓价格触及止损价 / 止盈价（高优先级）
 *   6. 收盘复盘       —— 15:00 收盘后生成当日复盘 + 明日预案（仅一次）
 *
 * 免责声明：本工具仅供学习研究，不构成任何投资建议。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Indicators = require('./public/static/indicators.js');
const Engine = require('./public/static/engine.js');
const { fetchTencentKline, calibrateKlines, httpGet, httpPostJson, httpPostForm, fetchFundFlow, fetchMarketBreadth, fetchNewsSentiment, fetchIndexKline, fetchHhxgSnapshot, fetchUs10y, fetchCn10y, fetchSox, NAME, CODE } = require('./lib/market.js');
const { loadAccount: loadRotationAccount, saveAccount: saveRotationAccount, syncRotation, totalValue } = require('./lib/rotation-account.js');

// ---------- 常量 ----------
const CONFIG_FILE = path.join(__dirname, 'notify.config.json');
const MONITOR_STATE_FILE = path.join(__dirname, 'data', 'monitor-state.json');
const ACCOUNT_FILE = path.join(__dirname, 'data', 'account.json');
const PID_FILE = path.join(__dirname, 'data', 'monitor.pid');
const LIMIT = 260;
const STATUS_NAMES = ['强势看空', '偏空', '中性震荡', '偏多', '强势做多'];

// 写入 PID 文件（供 server 判断是否已在运行），退出时清理
function writePidFile() {
  try { fs.writeFileSync(PID_FILE, String(process.pid)); } catch (e) {}
}
function removePidFile() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
}

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const DRY_RUN = args.includes('--dry-run');

// ---------- 工具 ----------
function fmt(n, d) { return (n == null || isNaN(n)) ? '--' : (+n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
function fmtPrice(n) { return n == null ? '--' : (+n).toFixed(3); }
function signed(n, d) { if (n == null) return '--'; return (n > 0 ? '+' : '') + (+n).toFixed(d === undefined ? 2 : d); }
function hhmm(d) { return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
function mmdd(d) { return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function log(msg) { console.log(`[${hhmm(new Date())}] ${msg}`); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

// ---------- 配置 ----------
function defaultConfig() {
  return {
    channel: 'console',        // console | serverchan | pushplus | wecom | dingtalk | generic
    pollIntervalSec: 60,       // 盘中轮询间隔（秒）
    reportIntervalMin: 30,     // 盘中常规策略快照间隔（分钟）
    risk: 1,                   // 0保守 1平衡 2激进
    stopPct: 5, takePct: 8, lots: 10, maxPosition: 100,
    thresholds: [36, 48, 60, 72],
    crossCooldownMin: 15,      // 评分异动提醒的最小间隔（分钟），防止在阈值附近反复触发
    holidays: [],              // 非交易日（YYYY-MM-DD），如 "2026-10-01"
    etfPool: [                 // 轮动池（ETF + 科技板块股票）
      { code: '159516', name: '半导体设备', type: 'etf' },
      { code: '512010', name: '医药', type: 'etf' },
      { code: '512400', name: '有色', type: 'etf' },
      { code: '688981', name: '中芯国际', type: 'stock' },
      { code: '688012', name: '中微公司', type: 'stock' },
      { code: '002371', name: '北方华创', type: 'stock' },
      { code: '603501', name: '韦尔股份', type: 'stock' },
      { code: '688256', name: '寒武纪', type: 'stock' },
      { code: '688041', name: '海光信息', type: 'stock' },
      { code: '603986', name: '兆易创新', type: 'stock' },
      { code: '688008', name: '澜起科技', type: 'stock' },
    ],
    notify: {
      serverchan: { sendkey: '' },                       // Server酱 SendKey（微信服务号推送）
      pushplus: { token: '' },                           // PushPlus token
      wecom: { webhook: '' },                            // 企业微信群机器人 webhook
      wecomapp: { corpid: '', secret: '', agentid: 0, touser: '' }, // 企业微信自建应用消息
      dingtalk: { webhook: '' },                         // 钉钉群机器人 webhook
      generic: { url: '', headers: {}, bodyTemplate: '' }, // 通用 HTTP 网关（可对接短信网关等）
    },
  };
}
function loadConfig() {
  const def = defaultConfig();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(def, user, { notify: Object.assign(def.notify, user.notify || {}) });
    }
  } catch (e) { console.error('[config] 读取失败，使用默认配置:', e.message); }
  // 环境变量覆盖（公共部署时用，密钥不进代码库）
  if (process.env.CHANNEL) def.channel = process.env.CHANNEL;
  if (process.env.SENDKEY) def.notify.serverchan.sendkey = process.env.SENDKEY;
  if (process.env.WECOM_WEBHOOK) def.notify.wecom.webhook = process.env.WECOM_WEBHOOK;
  if (process.env.ETF_POOL) { try { def.etfPool = JSON.parse(process.env.ETF_POOL); } catch (e) {} }
  return def;
}
function engineSettings(cfg) { return { risk: cfg.risk, stopPct: cfg.stopPct, takePct: cfg.takePct, lots: cfg.lots, maxPosition: cfg.maxPosition }; }

// ---------- 账户 / 盯盘状态 ----------
function loadAccount() {
  try {
    if (fs.existsSync(ACCOUNT_FILE)) return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
  } catch (e) { console.error('[account] 读取失败:', e.message); }
  return { name: NAME, code: CODE, totalCapital: 500000, cash: 500000, shares: 0, avgCost: 0, realizedPnl: 0, trades: [], reviews: [] };
}
function defaultMonitorState() {
  return {
    date: '', openSent: false, closeSent: false,
    lastScore: null, lastBand: null, lastRegularAt: 0, lastCrossAt: 0,
    stopAlerted: false, takeAlerted: false, lastActionKey: '', lastTopCode: null,
  };
}
function loadMonitorState() {
  try {
    if (fs.existsSync(MONITOR_STATE_FILE)) return Object.assign(defaultMonitorState(), JSON.parse(fs.readFileSync(MONITOR_STATE_FILE, 'utf8')));
  } catch (e) { /* ignore */ }
  return defaultMonitorState();
}
function saveMonitorState(s) {
  try { fs.writeFileSync(MONITOR_STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { console.error('[state] 保存失败:', e.message); }
}

// ---------- 交易日 / 交易时段 ----------
function isWeekend(d) { const w = d.getDay(); return w === 0 || w === 6; }
function isHoliday(dateStr, holidays) { return (holidays || []).indexOf(dateStr) >= 0; }
function isTradingDay(d, holidays) { return !isWeekend(d) && !isHoliday(d.toISOString().slice(0, 10), holidays); }
function minuteOf(d) { return d.getHours() * 60 + d.getMinutes(); }
// 9:30-11:30, 13:00-15:00（含收盘竞价）
function isInSession(d) { const m = minuteOf(d); return (m >= 570 && m <= 690) || (m >= 780 && m <= 900); }
function sessionPhase(d) {
  const m = minuteOf(d);
  if (m < 570) return 'pre';
  if (m <= 690) return 'am';
  if (m < 780) return 'lunch';
  if (m <= 900) return 'pm';
  return 'post';
}

// ---------- 评分档位 ----------
function bandOf(score) { if (score >= 72) return 4; if (score >= 60) return 3; if (score >= 48) return 2; if (score >= 36) return 1; return 0; }

// ---------- 文字策略消息 ----------
function strategyLine(ins) {
  if (ins.side === 'buy') return `买入 ${fmt(ins.deltaShares, 0)} 份（分 3 批）`;
  if (ins.side === 'sell') return `卖出 ${fmt(Math.abs(ins.deltaShares), 0)} 份（逢高减仓）`;
  return '持股不动 / 观望，等待信号';
}

// 精简状态/动作，用于推送标题（让微信通知栏直接看到结论，无需点开）
function compactStatus(a) { return `${a.status}${a.score}分`; }
function shortAction(ins) {
  if (ins.side === 'buy') return `买${fmt(ins.deltaShares, 0)}份`;
  if (ins.side === 'sell') return `卖${fmt(Math.abs(ins.deltaShares), 0)}份`;
  return '持有';
}
function dimsSummary(a) {
  const f = a.fund || {}, br = a.breadth, hxg = a.hhxg, mk = a.market || {};
  const parts = [];
  if (f.latest) parts.push(`资金:主力${f.streakDays > 0 ? '流入' + f.streakDays + '日' : f.streakDays < 0 ? '流出' + (-f.streakDays) + '日' : '持平'}`);
  else parts.push('资金:--');
  if (hxg && hxg.sentimentIndex != null) parts.push(`情绪:赚钱效应${hxg.sentimentIndex}`);
  else if (br && br.total) parts.push(`情绪:涨${br.up}/跌${br.down}`);
  else parts.push('情绪:--');
  if (hxg) parts.push(`半导体:${hxg.semiInStrong ? '在风口' : '非风口'}`);
  if (mk && mk.index && mk.index.ma60) parts.push(`大盘:${mk.bearMarket ? '熊市' : '多头'}`);
  return parts.join(' · ');
}

function buildMessage(kind, ctx) {
  const a = ctx.analysis, ins = ctx.instruction, acc = ctx.account, q = ctx.quote || {};
  const time = ctx.time, price = a.price;
  const chg = q.pctChange != null ? signed(q.pctChange, 2) + '%' : '--';
  const pos = `当前 ${ins.currentPct}% → 目标 ${ins.targetPct}%`;
  const act = shortAction(ins);
  const risk = `止损 ${fmtPrice(ins.stopLoss)} · 止盈 ${fmtPrice(ins.takeProfit)}`;
  const dims = dimsSummary(a);
  // 正文第一行即明确买卖操作
  const body = `【操作】${strategyLine(ins)}\n评分 ${a.score}/100 ${a.status} · 现价 ${fmtPrice(price)}（${chg}）\n${dims}\n${pos}\n${risk}`;

  switch (kind) {
    case 'open':
      return { title: `ETF开盘 ${compactStatus(a)} 现${fmtPrice(price)} ${act}`, text: `【开盘策略】${mmdd(ctx.now)}\n${body}` };
    case 'regular':
      return { title: `ETF盘中 ${compactStatus(a)} 现${fmtPrice(price)} ${act}`, text: `【盘中策略】${time}\n${body}` };
    case 'cross':
      return { title: `ETF评分异动 ${compactStatus(a)} 现${fmtPrice(price)} ${act}`, text: `⚠ 评分 ${ctx.prevScore} → ${a.score}，状态切换为「${a.status}」\n${time}\n${body}` };
    case 'rebalance':
      return { title: `ETF调仓 ${act} 目标${a.targetPct}%`, text: `【操作】${strategyLine(ins)}\n${pos}${ins.side === 'buy' ? `\n${ins.buyZone}` : ins.side === 'sell' ? `\n${ins.sellZone}` : ''}\n${dims}\n${risk}` };
    case 'stop':
      return { title: `ETF止损 现${fmtPrice(price)} 止损${fmtPrice(ins.stopLoss)}`, text: `⚠⚠ 价格 ${fmtPrice(price)} 已触及止损价 ${fmtPrice(ins.stopLoss)}\n【操作】立即卖出全部 ${fmt(acc.shares, 0)} 份，禁止死扛。`, priority: 'high' };
    case 'take':
      return { title: `ETF止盈 现${fmtPrice(price)} 止盈${fmtPrice(ins.takeProfit)}`, text: `价格 ${fmtPrice(price)} 已触及止盈价 ${fmtPrice(ins.takeProfit)}\n【操作】逢高分批止盈（卖出 ${fmt(acc.shares, 0)} 份）。`, priority: 'high' };
    case 'close':
      return { title: `ETF收盘 ${compactStatus(a)} ${act}`, text: `【收盘复盘】\n${body}\n\n${Engine.generateReview(a, ins, acc, q, ctx.klines)}` };
    default:
      return { title: `ETF盯盘 ${compactStatus(a)} 现${fmtPrice(price)} ${act}`, text: body };
  }
}

// ---------- 企业微信自建应用 access_token ----------
let wecomTokenCache = null; // { token, expiresAt }
async function getWecomToken(corpid, secret) {
  if (wecomTokenCache && Date.now() < wecomTokenCache.expiresAt - 60000) return wecomTokenCache.token;
  const u = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`;
  const r = await httpGet(u);
  const j = safeParse(r.text);
  if (!j || j.errcode !== 0) throw new Error('获取企业微信 access_token 失败: ' + (j ? (j.errcode + ' ' + j.errmsg) : r.text));
  wecomTokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in || 7200) * 1000 };
  return wecomTokenCache.token;
}

// ---------- 推送通道 ----------
async function sendVia(cfg, title, text) {
  const ch = cfg.channel;
  const n = cfg.notify || {};
  if (ch === 'console' || DRY_RUN) { log('📤 [推送] ' + title + '\n' + text); return; }
  if (ch === 'serverchan') {
    if (!n.serverchan || !n.serverchan.sendkey) throw new Error('缺少 serverchan.sendkey');
    return httpPostForm(`https://sctapi.ftqq.com/${n.serverchan.sendkey}.send`, { title: title.slice(0, 32), desp: text });
  }
  if (ch === 'pushplus') {
    if (!n.pushplus || !n.pushplus.token) throw new Error('缺少 pushplus.token');
    return httpPostJson('http://www.pushplus.plus/send', { token: n.pushplus.token, title, content: text, template: 'txt' });
  }
  if (ch === 'wecom') {
    if (!n.wecom || !n.wecom.webhook) throw new Error('缺少 wecom.webhook');
    const r = await httpPostJson(n.wecom.webhook, { msgtype: 'text', text: { content: title + '\n' + text } });
    const j = safeParse(r.text);
    if (j && j.errcode !== 0) throw new Error('企业微信返回 errcode=' + j.errcode + ' ' + (j.errmsg || ''));
    return r;
  }
  if (ch === 'wecomapp') {
    const w = n.wecomapp || {};
    if (!w.corpid || !w.secret || !w.agentid) throw new Error('缺少 wecomapp.corpid/secret/agentid');
    const body = { touser: w.touser || '@all', msgtype: 'text', agentid: w.agentid, text: { content: title + '\n' + text } };
    const send = async (token) => httpPostJson(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, body);
    let token = await getWecomToken(w.corpid, w.secret);
    let r = await send(token);
    let j = safeParse(r.text);
    if (j && (j.errcode === 40014 || j.errcode === 42001)) { // token 失效 → 强制刷新重试一次
      wecomTokenCache = null;
      token = await getWecomToken(w.corpid, w.secret);
      r = await send(token);
      j = safeParse(r.text);
    }
    if (j && j.errcode !== 0) throw new Error('企业微信应用返回 errcode=' + j.errcode + ' ' + (j.errmsg || '') + (j.invaliduser ? ' invaliduser=' + j.invaliduser : ''));
    return r;
  }
  if (ch === 'dingtalk') {
    if (!n.dingtalk || !n.dingtalk.webhook) throw new Error('缺少 dingtalk.webhook');
    const r = await httpPostJson(n.dingtalk.webhook, { msgtype: 'text', text: { content: title + '\n' + text } });
    const j = safeParse(r.text);
    if (j && j.errcode !== 0) throw new Error('钉钉返回 errcode=' + j.errcode + ' ' + (j.errmsg || ''));
    return r;
  }
  if (ch === 'generic') {
    const g = n.generic || {};
    if (!g.url) throw new Error('缺少 generic.url');
    let body;
    if (g.bodyTemplate) {
      body = JSON.parse(g.bodyTemplate.replace(/\{title\}/g, title).replace(/\{text\}/g, text));
    } else {
      body = { title, text };
    }
    return httpPostJson(g.url, body, g.headers || {});
  }
  throw new Error('未知渠道: ' + ch);
}

// ---------- 事件检测 ----------
function detectEvents(a, ins, account, ms, now, cfg) {
  const events = [];
  const dateStr = now.toISOString().slice(0, 10);
  const inSession = isInSession(now);

  // 跨日重置
  if (ms.date !== dateStr) {
    Object.assign(ms, defaultMonitorState());
    ms.date = dateStr;
  }

  // 1) 记录评分档位（始终记录；跨档才在盘中推送）
  const band = bandOf(a.score);
  if (ms.lastBand == null) {
    ms.lastBand = band; ms.lastScore = a.score;
  } else if (band !== ms.lastBand) {
    const prevBand = ms.lastBand, prevScore = ms.lastScore;
    ms.lastBand = band; ms.lastScore = a.score;
    const cooldownOk = Date.now() - (ms.lastCrossAt || 0) >= cfg.crossCooldownMin * 60000;
    if (inSession && cooldownOk) {
      events.push({ kind: 'cross', prevBand, prevScore });
      ms.lastCrossAt = Date.now();
    }
  } else {
    ms.lastScore = a.score;
  }

  // 2) 风控（持仓时，盘中触及止损/止盈）
  if (account.shares > 0 && inSession) {
    if (a.price <= ins.stopLoss && !ms.stopAlerted) { events.push({ kind: 'stop' }); ms.stopAlerted = true; }
    else if (a.price >= ins.takeProfit && !ms.takeAlerted) { events.push({ kind: 'take' }); ms.takeAlerted = true; }
  }

  // 3) 开盘（每个交易日首次进入交易时段）
  if (inSession && !ms.openSent) {
    ms.openSent = true;
    ms.lastRegularAt = Date.now();
    events.push({ kind: 'open' });
  }

  // 4) 盘中常规快照（评分异动/风控已推送时不重复）
  const snapDue = Date.now() - ms.lastRegularAt >= cfg.reportIntervalMin * 60000;
  if (inSession && snapDue && !events.some((e) => e.kind === 'cross' || e.kind === 'stop' || e.kind === 'take')) {
    ms.lastRegularAt = Date.now();
    events.push({ kind: 'regular' });
  }

  // 5) 调仓（盘中，偏离 ≥ 0.5 份资金）
  if (inSession && ins.side !== 'hold' && Math.abs(ins.deltaLots) >= 0.5) {
    const key = ins.side + ':' + ins.targetPct + ':' + Math.round(ins.deltaLots);
    if (ms.lastActionKey !== key) {
      events.push({ kind: 'rebalance' });
      ms.lastActionKey = key;
    }
  }

  // 6) 收盘复盘（15:00 收盘后，每个交易日一次）
  if (sessionPhase(now) === 'post' && !ms.closeSent) {
    ms.closeSent = true;
    events.push({ kind: 'close' });
  }

  // 去重/优先级：开盘与评分异动已含当日计划；止损止盈为最高优先级
  const hasPlan = events.some((e) => e.kind === 'open' || e.kind === 'cross');
  const hasRisk = events.some((e) => e.kind === 'stop' || e.kind === 'take');
  if (hasPlan || hasRisk) {
    return events.filter((e) => e.kind !== 'rebalance' && e.kind !== 'regular');
  }
  return events;
}

// ---------- 资金面/消息面缓存（30 分钟，失败用上次成功数据兜底） ----------
const extrasCache = {};
async function getFundFlow() {
  if (extrasCache.fund && Date.now() - extrasCache.fund.t < 1800000) return extrasCache.fund.v;
  try {
    const v = await fetchFundFlow(10);
    extrasCache.fund = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.fund) return extrasCache.fund.v;
    throw e;
  }
}
async function getNews() {
  if (extrasCache.news && Date.now() - extrasCache.news.t < 1800000) return extrasCache.news.v;
  try {
    const v = await fetchNewsSentiment('半导体设备', 20);
    extrasCache.news = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.news) return extrasCache.news.v;
    throw e;
  }
}
// 沪深300 MA60（大盘趋势过滤）
async function getIndex() {
  if (extrasCache.idx && Date.now() - extrasCache.idx.t < 1800000) return extrasCache.idx.v;
  try {
    const kl = await fetchIndexKline('1.000300', 80);
    const closes = kl.map((k) => k.close);
    let ma60 = null;
    if (closes.length >= 60) { let s = 0; for (let i = closes.length - 60; i < closes.length; i++) s += closes[i]; ma60 = s / 60; }
    const v = { price: closes[closes.length - 1], ma60 };
    extrasCache.idx = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.idx) return extrasCache.idx.v;
    throw e;
  }
}
// hhxg.top 快照（情绪+消息+行业资金）
async function getHhxg() {
  if (extrasCache.hhxg && Date.now() - extrasCache.hhxg.t < 900000) return extrasCache.hhxg.v;
  try {
    const v = await fetchHhxgSnapshot();
    extrasCache.hhxg = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.hhxg) return extrasCache.hhxg.v;
    throw e;
  }
}
// 美债10Y（宏观，30分钟缓存）
async function getUs10y() {
  if (extrasCache.us10y && Date.now() - extrasCache.us10y.t < 1800000) return extrasCache.us10y.v;
  try {
    const v = await fetchUs10y();
    extrasCache.us10y = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.us10y) return extrasCache.us10y.v;
    throw e;
  }
}
async function getCn10y() {
  if (extrasCache.cn10y && Date.now() - extrasCache.cn10y.t < 1800000) return extrasCache.cn10y.v;
  try {
    const v = await fetchCn10y();
    extrasCache.cn10y = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.cn10y) return extrasCache.cn10y.v;
    throw e;
  }
}
async function getSox() {
  if (extrasCache.sox && Date.now() - extrasCache.sox.t < 1800000) return extrasCache.sox.v;
  try {
    const v = await fetchSox();
    extrasCache.sox = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.sox) return extrasCache.sox.v;
    throw e;
  }
}
// 科技相对强度：科创50 vs 沪深300 近20日超额收益
async function getRelStrength() {
  if (extrasCache.rel && Date.now() - extrasCache.rel.t < 1800000) return extrasCache.rel.v;
  try {
    const [kc, hs] = await Promise.all([fetchIndexKline('1.000688', 30), fetchIndexKline('1.000300', 30)]);
    const kc0 = kc[kc.length - 1].close, kc20 = kc[kc.length - 21].close;
    const hs0 = hs[hs.length - 1].close, hs20 = hs[hs.length - 21].close;
    const v = ((kc0 / kc20 - 1) - (hs0 / hs20 - 1)) * 100;
    extrasCache.rel = { t: Date.now(), v };
    return v;
  } catch (e) {
    if (extrasCache.rel !== undefined) return extrasCache.rel.v;
    throw e;
  }
}

// ---------- 单次评估 ----------
async function evaluate(cfg, account, ms, now) {
  const { klines: raw, quote } = await fetchTencentKline('day', LIMIT);
  const klines = calibrateKlines(raw, quote, 'day');
  const ind = Indicators.computeAll(klines);

  // 资金面 / 情绪面 / 消息面 / 大盘趋势（任一失败静默降级，不影响主流程）
  const [fundR, brR, newsR, idxR, hxgR] = await Promise.allSettled([getFundFlow(), fetchMarketBreadth(), getNews(), getIndex(), getHhxg()]);
  const extras = {
    fundFlow: fundR.status === 'fulfilled' ? fundR.value : null,
    breadth: brR.status === 'fulfilled' ? brR.value : null,
    news: newsR.status === 'fulfilled' ? newsR.value : null,
    index: idxR.status === 'fulfilled' ? idxR.value : null,
    hhxg: hxgR.status === 'fulfilled' ? hxgR.value : null,
  };

  const settings = engineSettings(cfg);
  const analysis = Engine.analyze(klines, ind, quote, settings, extras);
  const instruction = Engine.generateInstruction(analysis, account, settings);
  const events = detectEvents(analysis, instruction, account, ms, now, cfg);
  return { analysis, instruction, quote, klines, events };
}

// ---------- 多 ETF 动量轮动 ----------
// 每次评估前从 notify.config.json 重载轮动池（支持 GUI 在线增删）
function reloadPool(cfg) {
  try {
    const f = path.join(__dirname, 'notify.config.json');
    if (fs.existsSync(f)) {
      const c = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (c.etfPool && c.etfPool.length) cfg.etfPool = c.etfPool;
    }
  } catch (e) {}
  return cfg.etfPool;
}

async function evaluateRotation(cfg) {
  const pool = reloadPool(cfg) || cfg.etfPool || [{ code: '159516', name: '半导体设备' }];
  const settings = engineSettings(cfg);

  // 1) 全局数据（大盘/情绪/宏观/科技板块）
  const [idxR, hxgR, usR, cnR, soxR, relR] = await Promise.allSettled([getIndex(), getHhxg(), getUs10y(), getCn10y(), getSox(), getRelStrength()]);
  const index = idxR.status === 'fulfilled' ? idxR.value : null;
  const hhxg = hxgR.status === 'fulfilled' ? hxgR.value : null;
  const us10y = usR.status === 'fulfilled' ? usR.value : null;
  const cn10y = cnR.status === 'fulfilled' ? cnR.value : null;
  const sox = soxR.status === 'fulfilled' ? soxR.value : null;
  const relStrength = relR.status === 'fulfilled' ? relR.value : null;
  const sharedExtras = { macro: { us10y, cn10y }, hhxg, index, sox, relStrength };
  const market = {
    bearMarket: !!(index && index.ma60 && index.price < index.ma60),
    sentimentIndex: hhxg ? hhxg.sentimentIndex : null,
    sentimentLabel: hhxg ? hhxg.sentimentLabel : '',
    us10y: us10y ? us10y.price : null,
    cn10y: cn10y ? cn10y.price : null,
    soxChg: sox ? sox.chgPct : null,
    relStrength,
  };

  // 2) 池内各标的：动量分 + 综合评分（技术面+宏观+情绪，宏观纳入排行）
  const results = await Promise.all(pool.map(async (e) => {
    try {
      const { klines: raw, quote } = await fetchTencentKline('day', 260, e.code);
      const klines = calibrateKlines(raw, quote, 'day');
      const rotation = Engine.computeRotation(klines);
      let analyzeScore = null;
      try {
        analyzeScore = Engine.analyze(klines, Indicators.computeAll(klines), quote, settings, sharedExtras).score;
      } catch (err) { /* 综合分失败则仅用动量分 */ }
      return { code: e.code, name: e.name, klines, quote, rotation, analyzeScore };
    } catch (err) {
      return { code: e.code, name: e.name, klines: [], quote: null, rotation: null, error: err.message };
    }
  }));

  const rotation = Engine.pickRotation(results, market);
  return { pool: results, market, rotation, index, hhxg, us10y, cn10y, sox, relStrength };
}

function buildRotationMessage(rotation, market, cfg, kind, time, extra) {
  const r = rotation;
  const stopPct = (cfg && cfg.stopPct) || 5, takePct = (cfg && cfg.takePct) || 8;
  const rank = r.sorted.map((x, i) => `${i + 1}.${x.name}${signed(x.rotation.mom20, 1)}%(${x.combined != null ? x.combined : (x.rotation ? x.rotation.score : 0)})`).join(' ');
  const gate = `大盘:${market.bearMarket ? '熊市' : '多头'} · 情绪:${market.sentimentIndex != null ? market.sentimentIndex : '--'} · 美债10Y:${market.us10y != null ? fmtPrice(market.us10y) + '%' : '--'}${market.soxChg != null ? ' · 费半:' + signed(market.soxChg, 1) + '%' : ''}${market.relStrength != null ? ' · 科技超额:' + signed(market.relStrength, 1) + '%' : ''}`;
  const stopTake = r.pick ? `\n止损 ${fmtPrice(r.pick.rotation.price * (1 - stopPct / 100))} · 止盈 ${fmtPrice(r.pick.rotation.price * (1 + takePct / 100))}` : '';
  const tradeLine = (extra && extra.tradeSummary) ? `\n成交: ${extra.tradeSummary}` : '';
  if (kind === 'close') {
    return {
      title: `ETF轮动收盘 ${r.action}${r.pick ? ' ' + r.pick.name : ''}`,
      text: `【收盘轮动复盘】\n${r.action}${r.pick ? ' ' + r.pick.name + 'ETF' : ''}（${r.reason}）\n排行: ${rank}\n目标仓位 ${r.targetPct}% · ${gate}`,
    };
  }
  if (kind === 'rotate') {
    const prevName = extra && extra.prevName ? extra.prevName : '现金';
    return {
      title: `ETF轮动切换 ${r.pick ? r.pick.name : '空仓'}`,
      text: `【ETF轮动】切换: ${prevName} → ${r.pick ? r.pick.name : '空仓'}\n${r.action}${r.pick ? ' ' + r.pick.name + 'ETF' : ''}（${r.reason}）\n目标仓位 ${r.targetPct}%\n排行: ${rank}${stopTake}${tradeLine}\n${gate}`,
    };
  }
  const head = r.pick
    ? `【ETF轮动】${r.action} ${r.pick.name}ETF（${r.reason}）\n目标仓位 ${r.targetPct}%`
    : `【ETF轮动】${r.action}（${r.reason}）`;
  return {
    title: r.pick ? `${r.pick.name}ETF ${r.pick.rotation.score}分 目标${r.targetPct}%` : `ETF空仓 目标0%`,
    text: `${head}\n排行: ${rank}${stopTake}${tradeLine}\n${gate}`,
  };
}

function detectRotationEvents(rotation, ms, now, cfg) {
  const events = [];
  const dateStr = now.toISOString().slice(0, 10);
  const inSession = isInSession(now);
  if (ms.date !== dateStr) { Object.assign(ms, defaultMonitorState()); ms.date = dateStr; }

  const topCode = rotation.pick ? rotation.pick.code : 'CASH';
  if (ms.lastTopCode !== null && ms.lastTopCode !== topCode && inSession) {
    events.push({ kind: 'rotate', topCode, prevCode: ms.lastTopCode });
  }
  ms.lastTopCode = topCode;

  if (inSession && !ms.openSent) { ms.openSent = true; ms.lastRegularAt = Date.now(); events.push({ kind: 'open' }); }
  const snapDue = Date.now() - ms.lastRegularAt >= cfg.reportIntervalMin * 60000;
  if (inSession && snapDue && !events.length) { ms.lastRegularAt = Date.now(); events.push({ kind: 'regular' }); }
  if (sessionPhase(now) === 'post' && !ms.closeSent) { ms.closeSent = true; events.push({ kind: 'close' }); }
  return events;
}

// ---------- 主流程 ----------
async function main() {
  if (!ONCE) {
    writePidFile();
    process.on('exit', removePidFile);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  }
  const cfg = loadConfig();
  const pool = (cfg.etfPool || []).map((e) => e.name + '(' + e.code + ')').join('、');
  console.log('==============================================');
  console.log('  多ETF动量轮动 实时盯盘助手');
  console.log('  轮动池: ' + pool);
  console.log('  渠道: ' + cfg.channel + (DRY_RUN ? '（dry-run，仅打印）' : '') + '  轮询: ' + cfg.pollIntervalSec + 's  快照: ' + cfg.reportIntervalMin + 'min');
  console.log('  触发: 开盘 / 盘中快照 / 轮动切换 / 收盘复盘');
  console.log('==============================================');

  if (ONCE) {
    const now = new Date();
    const r = await evaluateRotation(cfg);
    console.log('\n--- 轮动单次评估（--once，不推送、不写状态）---');
    console.log('时间: ' + now.toLocaleString('zh-CN') + '  阶段: ' + sessionPhase(now));
    for (const x of r.pool) {
      if (x.rotation) console.log(`  ${x.name}(${x.code}): 轮动分 ${x.rotation.score} · 20日 ${signed(x.rotation.mom20, 2)}% · 60日 ${signed(x.rotation.mom60, 2)}%`);
      else console.log(`  ${x.name}(${x.code}): 数据获取失败 ${x.error || ''}`);
    }
    const m = buildRotationMessage(r.rotation, r.market, cfg, 'regular', hhmm(now));
    console.log('\n' + m.title + '\n' + m.text);
    return;
  }

  // 常驻循环
  const run = async () => {
    const now = new Date();
    if (!isTradingDay(now, cfg.holidays)) { log('非交易日（周末/节假日），等待…'); return scheduleNext(600000); }
    const phase = sessionPhase(now);
    try {
      const ms = loadMonitorState();
      // 今日已收盘并完成复盘 → 静默等待次日，避免夜间空转请求
      if (phase === 'post' && ms.closeSent) return scheduleNext(600000);
      const r = await evaluateRotation(cfg);
      const events = detectRotationEvents(r.rotation, ms, now, cfg);
      saveMonitorState(ms);

      // 自动交易：开盘/轮动切换/盘中快照时，把账户同步到轮动目标（卖旧买新）
      let tradeSummary = '';
      if (events.some((e) => e.kind === 'open' || e.kind === 'rotate' || e.kind === 'regular')) {
        const account = loadRotationAccount();
        const trades = syncRotation(account, r.rotation, r.pool);
        saveRotationAccount(account);
        if (trades.length) {
          tradeSummary = trades.map((t) => (t.side === 'buy' ? '买入' : '卖出') + t.name + t.shares + '份@' + fmtPrice(t.price)).join('；');
          log('成交: ' + tradeSummary);
        }
      }

      for (const e of events) {
        const prevName = e.prevCode === 'CASH' ? '现金' : ((r.pool.find((p) => p.code === e.prevCode) || {}).name || e.prevCode);
        const m = buildRotationMessage(r.rotation, r.market, cfg, e.kind, hhmm(now), { prevName, tradeSummary });
        try { await sendVia(cfg, m.title, m.text); } catch (err) { log('❌ 推送失败: ' + err.message); }
      }
      if (isInSession(now) && !events.length) {
        const t = r.rotation.top;
        log(`盯盘中… ${t ? t.name + ' ' + t.rotation.score + '分' : '空仓'} · 排行 ${r.rotation.sorted.map((x) => x.name + signed(x.rotation.mom20, 1) + '%').join('>')}（无新信号）`);
      }
    } catch (e) {
      log('⚠ 轮询出错: ' + e.message);
    }
    // 交易时段内高频轮询；时段外低频（5 分钟），以便在 9:30 / 15:00 附近及时触发
    scheduleNext(isInSession(now) ? cfg.pollIntervalSec * 1000 : 300000);
  };
  const scheduleNext = (delay) => setTimeout(run, delay);

  run();
}

if (require.main === module) {
  main().catch((e) => { console.error('启动失败:', e.message); process.exit(1); });
} else {
  // 供测试/复用
  module.exports = { detectEvents, buildMessage, evaluateRotation, buildRotationMessage, detectRotationEvents, bandOf, isInSession, sessionPhase, isTradingDay, isWeekend, isHoliday, loadConfig, loadAccount, loadMonitorState, defaultMonitorState, engineSettings, fmt, fmtPrice, signed };
}
