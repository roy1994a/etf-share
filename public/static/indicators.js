/**
 * 技术指标计算库（纯函数，无依赖）
 * 输入统一为 K 线数组：[{date, open, close, high, low, volume, amount}]
 * 输出为与输入等长的数组（头部不足窗口的以 null 填充）
 */
(function (global) {
  'use strict';

  // 简单移动平均
  function MA(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  // 指数移动平均
  function EMA(values, n) {
    const out = new Array(values.length).fill(null);
    if (!values.length) return out;
    const k = 2 / (n + 1);
    out[0] = values[0];
    for (let i = 1; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }

  // 标准差（滚动，基于 MA 窗口）
  function STD(values, n) {
    const out = new Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
      const slice = values.slice(i - n + 1, i + 1);
      const mean = slice.reduce((a, b) => a + b, 0) / n;
      const variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
      out[i] = Math.sqrt(variance);
    }
    return out;
  }

  // MACD(12,26,9)：返回 { dif, dea, macd }
  function MACD(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const emaFast = EMA(closes, fast);
    const emaSlow = EMA(closes, slow);
    const dif = closes.map((_, i) => emaFast[i] - emaSlow[i]);
    const dea = EMA(dif, signal);
    const macd = dif.map((d, i) => 2 * (d - dea[i]));
    return { dif, dea, macd };
  }

  // RSI（Wilder 平滑）
  function RSI(closes, n) {
    n = n || 14;
    const out = new Array(closes.length).fill(null);
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i < closes.length; i++) {
      const chg = closes[i] - closes[i - 1];
      const gain = Math.max(chg, 0);
      const loss = Math.max(-chg, 0);
      if (i <= n) {
        avgGain += gain; avgLoss += loss;
        if (i === n) {
          avgGain /= n; avgLoss /= n;
          out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * (n - 1) + gain) / n;
        avgLoss = (avgLoss * (n - 1) + loss) / n;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  // KDJ(9,3,3)
  function KDJ(highs, lows, closes, n) {
    n = n || 9;
    const K = [], D = [], J = [];
    let prevK = 50, prevD = 50;
    for (let i = 0; i < closes.length; i++) {
      let hh = -Infinity, ll = Infinity;
      const start = Math.max(0, i - n + 1);
      for (let t = start; t <= i; t++) { hh = Math.max(hh, highs[t]); ll = Math.min(ll, lows[t]); }
      const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
      const kk = prevK * 2 / 3 + rsv / 3;
      const dd = prevD * 2 / 3 + kk / 3;
      const jj = 3 * kk - 2 * dd;
      K.push(kk); D.push(dd); J.push(jj);
      prevK = kk; prevD = dd;
    }
    return { k: K, d: D, j: J };
  }

  // BOLL(20,2)
  function BOLL(closes, n, k) {
    n = n || 20; k = k || 2;
    const mid = MA(closes, n);
    const std = STD(closes, n);
    const upper = closes.map((_, i) => (mid[i] == null ? null : mid[i] + k * std[i]));
    const lower = closes.map((_, i) => (mid[i] == null ? null : mid[i] - k * std[i]));
    return { mid, upper, lower };
  }

  // ATR(14) —— 平均真实波幅
  function ATR(highs, lows, closes, n) {
    n = n || 14;
    const out = new Array(closes.length).fill(null);
    if (!closes.length) return out;
    const trs = [highs[0] - lows[0]];
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += trs[i];
    out[n - 1] = sum / n;
    for (let i = n; i < closes.length; i++) out[i] = (out[i - 1] * (n - 1) + trs[i]) / n;
    return out;
  }

  // MFI(14) —— 资金流量指标（用成交额近似的资金面）
  function MFI(highs, lows, closes, volumes, amounts, n) {
    n = n || 14;
    const out = new Array(closes.length).fill(null);
    if (!closes.length) return out;
    const typical = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
    const rawFlow = typical.map((t, i) => t * (amounts && amounts[i] ? amounts[i] : (volumes[i] || 0)));
    for (let i = 1; i < closes.length; i++) {
      const start = Math.max(1, i - n + 1);
      let pos = 0, neg = 0;
      for (let t = start; t <= i; t++) {
        const f = rawFlow[t];
        if (typical[t] > typical[t - 1]) pos += f; else neg += f;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }

  // 计算全部指标
  function computeAll(klines) {
    const closes = klines.map((k) => k.close);
    const highs = klines.map((k) => k.high);
    const lows = klines.map((k) => k.low);
    const volumes = klines.map((k) => k.volume || 0);
    const amounts = klines.map((k) => k.amount || 0);

    const ma5 = MA(closes, 5);
    const ma10 = MA(closes, 10);
    const ma20 = MA(closes, 20);
    const ma60 = MA(closes, 60);
    const volMa5 = MA(volumes, 5);
    const volMa10 = MA(volumes, 10);
    const { dif, dea, macd } = MACD(closes, 12, 26, 9);
    const rsi6 = RSI(closes, 6);
    const rsi12 = RSI(closes, 12);
    const rsi24 = RSI(closes, 24);
    const { k, d, j } = KDJ(highs, lows, closes, 9);
    const { mid, upper, lower } = BOLL(closes, 20, 2);
    const atr = ATR(highs, lows, closes, 14);
    const mfi = MFI(highs, lows, closes, volumes, amounts, 14);

    return { closes, highs, lows, volumes, ma5, ma10, ma20, ma60, volMa5, volMa10, dif, dea, macd, rsi6, rsi12, rsi24, k, d, j, bollMid: mid, bollUpper: upper, bollLower: lower, atr, mfi };
  }

  const api = { MA, EMA, STD, MACD, RSI, KDJ, BOLL, ATR, MFI, computeAll };
  global.Indicators = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
