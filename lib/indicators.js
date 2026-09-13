'use strict';
/**
 * 技术指标计算（Node 侧）
 * 与 public/static/engine.js 前端算法保持一致，用于：
 *   1) 历史回测训练（train-rl.js）
 *   2) 研究台账的自动结算与复算（lib/research-ledger.js）
 * 零依赖，仅使用内置模块。
 */

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function num(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }

/** 简单移动平均，返回与前缀等长的数组（不足期用 null 填充） */
function SMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) continue;
    sum += v;
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** 指数移动平均 */
function EMA(arr, n) {
  const out = new Array(arr.length).fill(null);
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v == null) { out[i] = prev; continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI（Wilder 平滑），period 默认 14 */
function RSI(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** MACD，返回 {dif, dea, macd}（macd 为柱 = 2*(dif-dea)，与国内软件口径一致） */
function MACD(closes, fast, slow, signal) {
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const ef = EMA(closes, fast), es = EMA(closes, slow);
  const dif = closes.map((_, i) => (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);
  const clean = dif.map((v) => (v == null ? 0 : v));
  const deaRaw = EMA(clean, signal);
  const dea = dif.map((v, i) => (v == null ? null : deaRaw[i]));
  const macd = dif.map((v, i) => (v == null || dea[i] == null) ? null : 2 * (v - dea[i]));
  return { dif, dea, macd };
}

/** KDJ，返回 {k, d, j} */
function KDJ(klines, n, m1, m2) {
  n = n || 9; m1 = m1 || 3; m2 = m2 || 3;
  const k = new Array(klines.length).fill(null);
  const d = new Array(klines.length).fill(null);
  const j = new Array(klines.length).fill(null);
  let pk = 50, pd = 50;
  for (let i = 0; i < klines.length; i++) {
    if (i < n - 1) continue;
    const win = klines.slice(i - n + 1, i + 1);
    const hh = Math.max(...win.map((x) => x.high));
    const ll = Math.min(...win.map((x) => x.low));
    const rsv = hh === ll ? 50 : (klines[i].close - ll) / (hh - ll) * 100;
    pk = (m1 - 1) / m1 * pk + 1 / m1 * rsv;
    pd = (m2 - 1) / m2 * pd + 1 / m2 * pk;
    k[i] = pk; d[i] = pd; j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}

/** ATR（Wilder），period 默认 14 */
function ATR(klines, period) {
  period = period || 14;
  const out = new Array(klines.length).fill(null);
  if (klines.length < 2) return out;
  const tr = [null];
  for (let i = 1; i < klines.length; i++) {
    const h = klines[i].high, l = klines[i].low, pc = klines[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let prev = null;
  for (let i = 1; i < klines.length; i++) {
    if (i === period) {
      let s = 0;
      for (let t = 1; t <= period; t++) s += tr[t];
      prev = s / period;
      out[i] = prev;
    } else if (i > period) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
  }
  return out;
}

/** MFI 资金流量指标，period 默认 14 */
function MFI(klines, period) {
  period = period || 14;
  const out = new Array(klines.length).fill(null);
  const tp = klines.map((k) => (k.high + k.low + k.close) / 3);
  const mf = klines.map((k, i) => tp[i] * (k.volume || 0));
  for (let i = period; i < klines.length; i++) {
    let pos = 0, neg = 0;
    for (let t = i - period + 1; t <= i; t++) {
      if (tp[t] > tp[t - 1]) pos += mf[t];
      else if (tp[t] < tp[t - 1]) neg += mf[t];
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** 布林带 */
function BOLL(closes, n, k) {
  n = n || 20; k = k || 2;
  const mid = SMA(closes, n);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    if (mid[i] == null) continue;
    let s = 0;
    for (let t = i - n + 1; t <= i; t++) s += (closes[t] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { mid, upper, lower };
}

/**
 * 一次性计算全套指标
 * @param {Array} klines [{date,open,close,high,low,volume}]
 */
function computeAll(klines) {
  const closes = klines.map((k) => k.close);
  const volumes = klines.map((k) => k.volume || 0);
  const boll = BOLL(closes, 20, 2);
  const macd = MACD(closes);
  const kdj = KDJ(klines);
  return {
    closes, volumes,
    ma5: SMA(closes, 5), ma10: SMA(closes, 10), ma20: SMA(closes, 20), ma60: SMA(closes, 60),
    volMa5: SMA(volumes, 5), volMa20: SMA(volumes, 20),
    rsi6: RSI(closes, 6), rsi12: RSI(closes, 12), rsi24: RSI(closes, 24),
    dif: macd.dif, dea: macd.dea, macd: macd.macd,
    k: kdj.k, d: kdj.d, j: kdj.j,
    mfi: MFI(klines, 14),
    bollMid: boll.mid, bollUpper: boll.upper, bollLower: boll.lower,
    atr: ATR(klines, 14),
  };
}

module.exports = { clamp, num, SMA, EMA, RSI, MACD, KDJ, ATR, MFI, BOLL, computeAll };
