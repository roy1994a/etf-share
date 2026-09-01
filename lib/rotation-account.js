/**
 * 多 ETF 轮动账户：多持仓（每只 ETF 独立成本/份额/盈亏）+ 轮动自动交易
 * 复用 data/account.json，新增 positions 字段；兼容旧单持仓字段（159516 仍同步到 shares/avgCost 供 GUI 显示）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNT_FILE = path.join(__dirname, '..', 'data', 'account.json');
const COMMISSION_RATE = 0.00025; // 佣金 万2.5，最低5元
const STAMP_DUTY = 0.0005;       // 印花税（仅股票卖出，2023-08 起减半）
const fee = (amount) => Math.max(5, amount * COMMISSION_RATE);
const isStock = (code) => ['6', '0', '3'].includes(String(code || '')[0]);
const sellCost = (amount, code) => fee(amount) + (isStock(code) ? amount * STAMP_DUTY : 0);

function defaultAccount() {
  return {
    name: '半导体设备ETF国泰',
    code: '159516',
    totalCapital: 500000,
    cash: 500000,
    shares: 0,
    avgCost: 0,
    realizedPnl: 0,
    positions: {}, // { code: { code, name, shares, avgCost } }
    trades: [],
    reviews: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function loadAccount() {
  try {
    if (fs.existsSync(ACCOUNT_FILE)) {
      const s = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8'));
      s.positions = s.positions || {};
      return Object.assign(defaultAccount(), s);
    }
  } catch (e) { console.error('[account] 读取失败:', e.message); }
  return defaultAccount();
}

function saveAccount(s) {
  try {
    if (!fs.existsSync(path.dirname(ACCOUNT_FILE))) fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });
    s.updatedAt = new Date().toISOString();
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(s, null, 2));
  } catch (e) { console.error('[account] 保存失败:', e.message); }
}

// 当前总资产 = 现金 + 各持仓市值（按 pool 里的最新价）
function totalValue(account, pool) {
  let mv = 0;
  for (const [code, pos] of Object.entries(account.positions || {})) {
    const p = (pool || []).find((x) => x.code === code);
    const price = p && p.rotation ? p.rotation.price : 0;
    mv += pos.shares * price;
  }
  return account.cash + mv;
}

function pushTrade(account, t) {
  account.trades.push(t);
  if (account.trades.length > 500) account.trades = account.trades.slice(-500);
}

// 卖出某持仓全部
function sellPosition(account, code, name, price) {
  const pos = account.positions[code];
  if (!pos || pos.shares <= 0) return null;
  const qty = pos.shares;
  const amount = +(qty * price).toFixed(2);
  const f = sellCost(amount, code);
  const proceeds = amount - f;
  const costBasis = pos.avgCost * qty;
  account.cash = +(account.cash + proceeds).toFixed(2);
  account.realizedPnl = +(account.realizedPnl + (proceeds - costBasis)).toFixed(2);
  delete account.positions[code];
  if (code === '159516') { account.shares = 0; account.avgCost = 0; }
  const t = { time: new Date().toISOString(), side: 'sell', code, name, price: +price.toFixed(4), shares: qty, amount: +amount.toFixed(2), fee: +f.toFixed(2), note: `卖出 ${name} ${qty} 份 @ ${price}` };
  pushTrade(account, t);
  return t;
}

// 买入某代码（按目标金额，100 份整数倍）
function buyTo(account, code, name, price, targetValue) {
  if (targetValue <= 0) return null;
  const qty = Math.floor(targetValue / price / 100) * 100;
  if (qty < 100) return null;
  const amount = +(qty * price).toFixed(2);
  const f = fee(amount);
  if (amount + f > account.cash + 1e-6) return null;
  const pos = account.positions[code] || { code, name, shares: 0, avgCost: 0 };
  const newShares = pos.shares + qty;
  const totalCost = pos.avgCost * pos.shares + amount + f;
  pos.shares = newShares;
  pos.avgCost = +(totalCost / newShares).toFixed(4);
  account.positions[code] = pos;
  account.cash = +(account.cash - amount - f).toFixed(2);
  if (code === '159516') { account.shares = pos.shares; account.avgCost = pos.avgCost; }
  const t = { time: new Date().toISOString(), side: 'buy', code, name, price: +price.toFixed(4), shares: qty, amount: +amount.toFixed(2), fee: +f.toFixed(2), note: `买入 ${name} ${qty} 份 @ ${price}` };
  pushTrade(account, t);
  return t;
}

// 卖出一部分（减仓）
function sellShares(account, code, name, price, qty) {
  const pos = account.positions[code];
  if (!pos || qty <= 0) return null;
  qty = Math.floor(qty / 100) * 100;
  if (qty > pos.shares) qty = pos.shares;
  if (qty < 100) return null;
  const amount = +(qty * price).toFixed(2);
  const f = sellCost(amount, code);
  const proceeds = amount - f;
  const costBasis = pos.avgCost * qty;
  account.cash = +(account.cash + proceeds).toFixed(2);
  account.realizedPnl = +(account.realizedPnl + (proceeds - costBasis)).toFixed(2);
  pos.shares -= qty;
  if (pos.shares === 0) { delete account.positions[code]; if (code === '159516') { account.shares = 0; account.avgCost = 0; } }
  else { account.positions[code] = pos; if (code === '159516') { account.shares = pos.shares; account.avgCost = pos.avgCost; } }
  const t = { time: new Date().toISOString(), side: 'sell', code, name, price: +price.toFixed(4), shares: qty, amount: +amount.toFixed(2), fee: +f.toFixed(2), note: `卖出 ${name} ${qty} 份 @ ${price}` };
  pushTrade(account, t);
  return t;
}

// 同步账户到轮动目标：卖出非目标持仓，调整目标持仓到 targetPct
function syncRotation(account, rotation, pool) {
  const target = rotation.pick;
  const targetPct = rotation.targetPct;
  const priceOf = (code) => { const p = (pool || []).find((x) => x.code === code); return p && p.rotation ? p.rotation.price : null; };
  const totalAsset = totalValue(account, pool);
  const targetValue = target ? totalAsset * targetPct / 100 : 0;
  const trades = [];

  // 1) 卖出所有非目标持仓（空仓时全部卖出）
  for (const code of Object.keys(account.positions || {})) {
    if (target && code === target.code) continue;
    const price = priceOf(code);
    if (price == null) continue;
    const name = (account.positions[code] || {}).name || code;
    const t = sellPosition(account, code, name, price);
    if (t) trades.push(t);
  }

  // 2) 调整目标持仓到目标金额
  if (target) {
    const price = priceOf(target.code);
    if (price != null) {
      const cur = account.positions[target.code];
      const curValue = cur ? cur.shares * price : 0;
      const diff = targetValue - curValue;
      if (diff >= price * 100) {
        const t = buyTo(account, target.code, target.name, price, diff);
        if (t) trades.push(t);
      } else if (diff <= -price * 100 && cur) {
        const t = sellShares(account, target.code, target.name, price, Math.abs(diff) / price);
        if (t) trades.push(t);
      }
    }
  }

  return trades;
}

module.exports = { loadAccount, saveAccount, defaultAccount, totalValue, syncRotation, fee };
