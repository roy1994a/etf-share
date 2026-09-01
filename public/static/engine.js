/**
 * 策略引擎：综合评分 + 仓位管理 + 可执行指令 + 每日复盘
 */
(function (global) {
  'use strict';

  const DEFAULT_SETTINGS = {
    risk: 1,           // 0=保守 1=平衡 2=激进
    stopPct: 5,        // 止损百分比
    takePct: 8,        // 止盈百分比
    lots: 10,          // 资金分份数
    maxPosition: 100,  // 最大仓位 %
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
  function lastN(arr, n) { return arr && arr.length >= n ? arr[arr.length - n] : null; }
  function lastVal(arr) { if (!arr) return null; for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; }
  function r2(v, d) { return v == null ? '--' : (+v).toFixed(d === undefined ? 2 : d); }

  // 主分析：综合评分
  function analyze(klines, ind, quote, settings, extras) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    extras = extras || {};
    const n = klines.length;
    const i = n - 1;
    const price = quote && quote.price != null ? quote.price : ind.closes[i];
    const prevClose = quote && quote.prevClose != null ? quote.prevClose : (n > 1 ? ind.closes[i - 1] : price);
    const pct = prevClose ? (price - prevClose) / prevClose * 100 : 0;

    const signals = [];
    let score = 50; // 基准 50 分

    function addSignal(name, dir, text, weight) {
      signals.push({ name, dir, text, weight });
      score += weight;
    }

    // ---- 1. 趋势（权重合计约 ±18）----
    const m5 = lastVal(ind.ma5), m10 = lastVal(ind.ma10), m20 = lastVal(ind.ma20), m60 = lastVal(ind.ma60);
    addSignal('价格 vs MA5', price > m5 ? 'bull' : 'bear', `现价 ${r2(price, 3)} ${price > m5 ? '>' : '<'} MA5 ${r2(m5, 3)}`, price > m5 ? 2 : -2);
    addSignal('价格 vs MA10', price > m10 ? 'bull' : 'bear', `现价 ${price > m10 ? '>' : '<'} MA10 ${r2(m10, 3)}`, price > m10 ? 2 : -2);
    addSignal('价格 vs MA20', price > m20 ? 'bull' : 'bear', `现价 ${price > m20 ? '>' : '<'} MA20 ${r2(m20, 3)}`, price > m20 ? 3 : -3);
    addSignal('价格 vs MA60', price > m60 ? 'bull' : 'bear', `现价 ${price > m60 ? '>' : '<'} MA60 ${r2(m60, 3)}`, price > m60 ? 3 : -3);
    addSignal('短中期均线', m5 > m20 ? 'bull' : 'bear', `MA5 ${m5 > m20 ? '>' : '<'} MA20`, m5 > m20 ? 2 : -2);
    addSignal('中长均线', m10 > m20 ? 'bull' : 'bear', `MA10 ${m10 > m20 ? '>' : '<'} MA20`, m10 > m20 ? 2 : -2);
    addSignal('多空排列', m5 > m10 && m10 > m20 ? 'bull' : (m5 < m10 && m10 < m20 ? 'bear' : 'neutral'), m5 > m10 && m10 > m20 ? '多头排列（强势）' : (m5 < m10 && m10 < m20 ? '空头排列（弱势）' : '均线纠缠'), m5 > m10 && m10 > m20 ? 2 : (m5 < m10 && m10 < m20 ? -2 : 0));

    // ---- 2. 动量 MACD（约 ±12）----
    const dif = lastVal(ind.dif), dea = lastVal(ind.dea), macd = lastVal(ind.macd);
    const macdPrev = lastN(ind.macd, 2), macdPrev2 = lastN(ind.macd, 3);
    addSignal('MACD 快慢线', dif > dea ? 'bull' : 'bear', `DIF ${r2(dif, 4)} ${dif > dea ? '>' : '<'} DEA ${r2(dea, 4)}`, dif > dea ? 3 : -3);
    addSignal('MACD 柱', macd > 0 ? 'bull' : 'bear', `红柱 ${r2(macd, 4)}（${macd > 0 ? '多头动能' : '空头动能'}）`, macd > 0 ? 3 : -3);
    if (macdPrev != null && macdPrev2 != null) {
      const inc = macd > macdPrev && macdPrev > macdPrev2;
      const dec = macd < macdPrev && macdPrev < macdPrev2;
      addSignal('MACD 动能变化', inc ? 'bull' : (dec ? 'bear' : 'neutral'), inc ? '柱体连续放大' : (dec ? '柱体连续缩小' : '柱体走平'), inc ? 2 : (dec ? -2 : 0));
    }
    addSignal('DIF 多空区', dif > 0 ? 'bull' : 'bear', `DIF 位于${dif > 0 ? '零轴上方' : '零轴下方'}`, dif > 0 ? 2 : -2);

    // ---- 3. 超买超卖 RSI / KDJ（约 ±14）----
    const r6 = lastVal(ind.rsi6), r12 = lastVal(ind.rsi12), r24 = lastVal(ind.rsi24);
    const kk = lastVal(ind.k), dd = lastVal(ind.d), jj = lastVal(ind.j);
    const kPrev = lastN(ind.k, 2), dPrev = lastN(ind.d, 2);
    function rsiScore(r) { return r == null ? 0 : (r < 20 ? 3 : r < 35 ? 2 : r > 80 ? -3 : r > 65 ? -2 : 0); }
    addSignal('RSI6 超买超卖', r6 < 35 ? 'bull' : (r6 > 65 ? 'bear' : 'neutral'), `RSI6=${r2(r6)}${r6 < 20 ? '（严重超卖）' : r6 < 35 ? '（超卖区）' : r6 > 80 ? '（严重超买）' : r6 > 65 ? '（超买区）' : '（中性）'}`, rsiScore(r6));
    addSignal('RSI12 状态', r12 < 35 ? 'bull' : (r12 > 65 ? 'bear' : 'neutral'), `RSI12=${r2(r12)}`, rsiScore(r12) > 0 ? 1 : (rsiScore(r12) < 0 ? -1 : 0));
    // KDJ 金叉/死叉
    if (kPrev != null && dPrev != null) {
      const golden = kk > dd && kPrev <= dPrev;
      const dead = kk < dd && kPrev >= dPrev;
      addSignal('KDJ 交叉', golden ? 'bull' : (dead ? 'bear' : 'neutral'), golden ? 'KDJ 金叉（短线转强）' : (dead ? 'KDJ 死叉（短线转弱）' : (kk > dd ? 'K 在 D 上方' : 'K 在 D 下方')), golden ? 3 : (dead ? -3 : (kk > dd ? 1 : -1)));
    }
    addSignal('KDJ J 值', jj < 10 ? 'bull' : (jj > 90 ? 'bear' : 'neutral'), `J=${r2(jj)}${jj < 10 ? '（超卖）' : jj > 90 ? '（超买）' : ''}`, jj < 10 ? 3 : (jj > 90 ? -3 : 0));

    // ---- 4. 量价关系（约 ±8）----
    const vol = ind.volumes[i] || 0;
    const vma5 = lastVal(ind.volMa5) || 1;
    const vRatio = vol / vma5;
    const up = pct > 0;
    if (vRatio > 1.3 && Math.abs(pct) > 0.5) {
      addSignal('量价配合', up ? 'bull' : 'bear', `${up ? '放量上涨' : '放量下跌'}（量比 ${r2(vRatio)}）`, up ? 4 : -4);
    } else if (vRatio > 1.3) {
      addSignal('放量', 'neutral', `放量但涨跌有限（量比 ${r2(vRatio)}）`, up ? 1 : -1);
    } else if (vRatio < 0.7) {
      addSignal('缩量', 'neutral', `缩量（量比 ${r2(vRatio)}）`, up ? 1 : -1);
    } else {
      addSignal('量能', 'neutral', `量比 ${r2(vRatio)}（正常）`, 0);
    }
    // 量比 vs 昨日
    const volPrev = lastN(ind.volumes, 2);
    if (volPrev) {
      const ratio2 = vol / (volPrev || 1);
      if (ratio2 > 1.2 && up) addSignal('量能放大', 'bull', `较昨日放量 ${r2(ratio2)} 倍且上涨`, 2);
      else if (ratio2 > 1.2 && !up) addSignal('量能放大', 'bear', `较昨日放量 ${r2(ratio2)} 倍但下跌`, -2);
    }

    // ---- 5. 资金面 MFI（约 ±6）----
    const mfi = lastVal(ind.mfi);
    addSignal('资金流量 MFI', mfi > 60 ? 'bull' : (mfi < 40 ? 'bear' : 'neutral'), `MFI=${r2(mfi)}${mfi > 80 ? '（资金强流入）' : mfi > 60 ? '（资金偏流入）' : mfi < 20 ? '（资金强流出）' : mfi < 40 ? '（资金偏流出）' : '（中性）'}`, mfi > 80 ? 3 : mfi > 60 ? 2 : mfi < 20 ? -3 : mfi < 40 ? -2 : 0);

    // ---- 6. 位置/布林（约 ±6）----
    const bu = lastVal(ind.bollUpper), bl = lastVal(ind.bollLower), bm = lastVal(ind.bollMid);
    if (bu != null && bl != null) {
      if (price > bu) addSignal('布林位置', 'bear', `价格突破布林上轨（超买）`, -2);
      else if (price < bl) addSignal('布林位置', 'bull', `价格跌破布林下轨（超卖）`, 2);
      else {
        const pos = (price - bl) / (bu - bl);
        addSignal('布林位置', 'neutral', `位于布林带 ${(pos * 100).toFixed(0)}% 分位`, pos > 0.8 ? -1 : pos < 0.2 ? 1 : 0);
      }
    }
    // 距离近期高低点
    const window20 = klines.slice(-20);
    const h20 = Math.max(...window20.map((x) => x.high));
    const l20 = Math.min(...window20.map((x) => x.low));
    const distHigh = (price - h20) / h20 * 100;
    const distLow = (price - l20) / l20 * 100;
    addSignal('近20日位置', distHigh > -2 ? 'bear' : (distLow < 3 ? 'bull' : 'neutral'), `距20日高 ${r2(distHigh)}%、距20日低 ${r2(distLow)}%`, distHigh > -2 ? -2 : distLow < 3 ? 2 : 0);

    // ---- ATR 波动率（风险提示，不计分）----
    const atr = lastVal(ind.atr);
    const atrPct = atr && price ? atr / price * 100 : 0;

    // ---- 7. 主力资金方向（资金面，约 ±20）----
    const ff = extras.fundFlow || [];
    let streakDays = 0;
    if (ff.length) {
      const latest = ff[ff.length - 1];
      const mp = latest.mainNetInflowPct || 0;
      if (mp > 5) addSignal('主力净流入占比', 'bull', `主力净占比 ${r2(mp, 2)}%（强流入）`, 5);
      else if (mp > 0) addSignal('主力净流入占比', 'bull', `主力净占比 ${r2(mp, 2)}%（流入）`, 3);
      else if (mp > -5) addSignal('主力净流入占比', 'bear', `主力净占比 ${r2(mp, 2)}%（流出）`, -2);
      else addSignal('主力净流入占比', 'bear', `主力净占比 ${r2(mp, 2)}%（强流出）`, -5);

      // 连续净流入/流出天数
      for (let k = ff.length - 1; k >= 0; k--) {
        const v = ff[k].mainNetInflow;
        if (v === 0) break;
        if (streakDays === 0) streakDays = v > 0 ? 1 : -1;
        else if ((v > 0) === (streakDays > 0)) streakDays += v > 0 ? 1 : -1;
        else break;
      }
      if (streakDays >= 5) addSignal('主力连续流入', 'bull', `主力连续净流入 ${streakDays} 日`, 6);
      else if (streakDays >= 3) addSignal('主力连续流入', 'bull', `主力连续净流入 ${streakDays} 日`, 4);
      else if (streakDays <= -5) addSignal('主力连续流出', 'bear', `主力连续净流出 ${-streakDays} 日`, -6);
      else if (streakDays <= -3) addSignal('主力连续流出', 'bear', `主力连续净流出 ${-streakDays} 日`, -5);

      // 超大单方向
      const sb = latest.superBigNetInflow || 0;
      if (sb > 0) addSignal('超大单净流入', 'bull', `超大单净流入 ${r2(sb / 1e8, 2)} 亿`, 3);
      else addSignal('超大单净流入', 'bear', `超大单净流出 ${r2(Math.abs(sb) / 1e8, 2)} 亿`, -2);

      // 5日累计
      const sum5 = ff.slice(-5).reduce((s, x) => s + x.mainNetInflow, 0);
      if (sum5 > 0) addSignal('5日主力净流入', 'bull', `5日主力累计净流入 ${r2(sum5 / 1e8, 2)} 亿`, 3);
      else addSignal('5日主力净流入', 'bear', `5日主力累计净流出 ${r2(Math.abs(sum5) / 1e8, 2)} 亿`, -3);
    }

    // ---- 8. 市场情绪面（hhxg 赚钱效应优先，涨跌家数兜底；约 ±8）----
    const hxg = extras.hhxg || null;
    const br = extras.breadth || null;
    if (hxg && hxg.sentimentIndex != null) {
      const si = hxg.sentimentIndex;
      const lu = hxg.limitUp || 0, ld = hxg.limitDown || 0;
      if (si >= 85) addSignal('赚钱效应', 'bear', `赚钱效应 ${r2(si, 1)}（过热，涨停${lu}/跌停${ld}，不追高）`, -3);
      else if (si >= 65) addSignal('赚钱效应', 'bull', `赚钱效应 ${r2(si, 1)}（强，涨停${lu}/跌停${ld}）`, 4);
      else if (si >= 45) addSignal('赚钱效应', 'neutral', `赚钱效应 ${r2(si, 1)}（中性，涨停${lu}/跌停${ld}）`, 0);
      else if (si >= 25) addSignal('赚钱效应', 'bear', `赚钱效应 ${r2(si, 1)}（偏弱）`, -2);
      else addSignal('赚钱效应', 'bull', `赚钱效应 ${r2(si, 1)}（冰点，超跌反弹机会）`, 2);
    } else if (br && br.total) {
      const ratio = br.ratio;
      if (ratio > 2) addSignal('涨跌家数比', 'bull', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}，普涨）`, 6);
      else if (ratio >= 1.5) addSignal('涨跌家数比', 'bull', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}）`, 3);
      else if (ratio >= 1) addSignal('涨跌家数比', 'neutral', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}，平衡）`, 1);
      else if (ratio >= 0.67) addSignal('涨跌家数比', 'bear', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}）`, -2);
      else if (ratio >= 0.5) addSignal('涨跌家数比', 'bear', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}，偏弱）`, -3);
      else addSignal('涨跌家数比', 'bear', `上涨 ${br.up} / 下跌 ${br.down}（比 ${r2(ratio, 2)}，普跌）`, -6);
    }

    // ---- 9. 消息面 + 行业资金（hhxg 优先，新闻搜索兜底；约 ±9）----
    if (hxg && hxg.newsCount) {
      const ns = hxg.newsScore;
      if (ns >= 3) addSignal('消息面', 'bull', `新闻净情感 ${r2(ns, 1)}（偏正面，${hxg.newsPos}正/${hxg.newsNeg}负）`, 5);
      else if (ns >= 1) addSignal('消息面', 'bull', `新闻净情感 ${r2(ns, 1)}（略偏正面）`, 3);
      else if (ns >= 0) addSignal('消息面', 'neutral', `新闻净情感 ${r2(ns, 1)}（中性）`, 0);
      else addSignal('消息面', 'bear', `新闻净情感 ${r2(ns, 1)}（偏负面，${hxg.newsPos}正/${hxg.newsNeg}负）`, -3);
      if (hxg.semiInStrong) addSignal('行业资金', 'bull', '半导体在行业资金强流入名单', 4);
      else addSignal('行业资金', 'bear', '半导体不在行业资金强流入名单', -2);
    } else {
      const news = extras.news || null;
      if (news && news.available) {
        const ns = news.score;
        if (ns >= 3) addSignal('消息面情感', 'bull', `新闻净情感 ${r2(ns, 1)}（偏正面，${news.pos}正/${news.neg}负）`, 5);
        else if (ns >= 1) addSignal('消息面情感', 'bull', `新闻净情感 ${r2(ns, 1)}（略偏正面）`, 3);
        else if (ns >= 0) addSignal('消息面情感', 'neutral', `新闻净情感 ${r2(ns, 1)}（中性）`, 0);
        else addSignal('消息面情感', 'bear', `新闻净情感 ${r2(ns, 1)}（偏负面，${news.pos}正/${news.neg}负）`, -3);
      }
    }

    // ---- 10. 大盘趋势过滤（沪深300 vs MA60）----
    const idx = extras.index || null;
    let bearMarket = false;
    if (idx && idx.ma60) {
      const above = idx.price >= idx.ma60;
      bearMarket = !above;
      if (above) addSignal('大盘趋势', 'bull', `沪深300 ${r2(idx.price, 1)} ≥ MA60 ${r2(idx.ma60, 1)}（多头环境）`, 3);
      else addSignal('大盘趋势', 'bear', `沪深300 ${r2(idx.price, 1)} < MA60 ${r2(idx.ma60, 1)}（熊市环境，降仓）`, -6);
    }

    // ---- 11. 绝对动量（20日，双动量逻辑）----
    const mom20 = n > 20 ? (ind.closes[i] / ind.closes[i - 20] - 1) * 100 : 0;
    if (n > 20) {
      if (mom20 > 0) addSignal('20日动量', 'bull', `20日涨幅 ${r2(mom20, 2)}%（正动量）`, 3);
      else addSignal('20日动量', 'bear', `20日涨幅 ${r2(mom20, 2)}%（负动量，不做多）`, -5);
    }

    // ---- 12. 宏观面：美债/中债10Y 收益率（利率压制高久期成长股）----
    const macro = extras.macro || null;
    const us10y = macro ? macro.us10y : null;
    if (us10y && us10y.price != null) {
      const u10 = us10y.price;
      if (u10 > 4.5) addSignal('美债10Y水平', 'bear', `美债10Y ${r2(u10, 2)}%（高位，压制成长估值）`, -5);
      else if (u10 > 4.2) addSignal('美债10Y水平', 'bear', `美债10Y ${r2(u10, 2)}%（偏高）`, -3);
      else if (u10 < 4.0) addSignal('美债10Y水平', 'bull', `美债10Y ${r2(u10, 2)}%（低位，利好成长）`, 3);
      else addSignal('美债10Y水平', 'neutral', `美债10Y ${r2(u10, 2)}%（中性）`, 0);
      if (us10y.chg20bp != null) {
        if (us10y.chg20bp > 30) addSignal('美债10Y趋势', 'bear', `20日上行 ${r2(us10y.chg20bp, 0)}bp（利率急升，科技承压）`, -4);
        else if (us10y.chg20bp < -30) addSignal('美债10Y趋势', 'bull', `20日下行 ${r2(us10y.chg20bp, 0)}bp（利率回落，利好成长）`, 3);
      }
      if (us10y.high52 != null && u10 >= us10y.high52 * 0.995) {
        addSignal('美债52周新高', 'bear', `美债10Y ${r2(u10, 2)}% 逼近52周高位 ${r2(us10y.high52, 2)}%`, -3);
      }
    }
    const cn10y = macro ? macro.cn10y : null;
    if (cn10y && cn10y.chg20bp != null) {
      if (cn10y.chg20bp > 20) addSignal('中债10Y趋势', 'bear', `中债10Y 近月上行 ${r2(cn10y.chg20bp, 0)}bp（流动性收紧，利空成长）`, -3);
      else if (cn10y.chg20bp < -20) addSignal('中债10Y趋势', 'bull', `中债10Y 近月下行 ${r2(cn10y.chg20bp, 0)}bp（利率下行，利好成长）`, 2);
    }

    // ---- 13. 科技板块：费半SOX联动 + 相对强度 ----
    const sox = extras.sox || null;
    if (sox && sox.chgPct != null) {
      if (sox.chgPct > 2) addSignal('费半SOX联动', 'bull', `费半隔夜 +${r2(sox.chgPct, 2)}%（利多半导体）`, 3);
      else if (sox.chgPct < -2) addSignal('费半SOX联动', 'bear', `费半隔夜 ${r2(sox.chgPct, 2)}%（利空半导体）`, -3);
    }
    const rel = extras.relStrength;
    if (rel != null) {
      if (rel > 3) addSignal('科技相对强度', 'bull', `科创50近20日超额 ${r2(rel, 2)}%（强于大盘）`, 3);
      else if (rel < -3) addSignal('科技相对强度', 'bear', `科创50近20日超额 ${r2(rel, 2)}%（弱于大盘）`, -3);
    }

    score = Math.round(clamp(score, 0, 100));

    // 市场状态判断
    let status, color;
    if (score >= 72) { status = '强势做多'; color = '#d92b2b'; }
    else if (score >= 60) { status = '偏多'; color = '#e86a3a'; }
    else if (score >= 48) { status = '中性震荡'; color = '#b8860b'; }
    else if (score >= 36) { status = '偏空'; color = '#2b7f2b'; }
    else { status = '强势看空'; color = '#1a8f1a'; }

    // 目标仓位（与状态档位对齐：偏空及以下不给多头仓位，指令更明确）
    let basePct;
    if (score >= 78) basePct = 95;
    else if (score >= 68) basePct = 78;
    else if (score >= 58) basePct = 55;
    else if (score >= 48) basePct = 30;
    else basePct = 0;

    // 风险偏好调整
    if (settings.risk === 2) basePct = clamp(basePct * 1.15, 0, 100);
    else if (settings.risk === 0) basePct = basePct * 0.6;
    // 高波动减仓
    if (atrPct > 3.5) basePct = basePct * 0.85;
    else if (atrPct > 2.5) basePct = basePct * 0.92;
    // 熊市环境（沪深300 < MA60）强制降仓
    if (bearMarket) basePct = basePct * 0.35;
    basePct = clamp(basePct, 0, settings.maxPosition || 100);
    const targetPct = Math.round(basePct);

    return {
      score, status, color, targetPct, price, prevClose, pct, atrPct,
      indicators: {
        ma5: m5, ma10: m10, ma20: m20, ma60: m60,
        dif, dea, macd, rsi6: r6, rsi12: r12, rsi24: r24, k: kk, d: dd, j: jj,
        bollUpper: bu, bollMid: bm, bollLower: bl, atr, atrPct, mfi,
        vol, vma5, vRatio, h20, l20, distHigh, distLow,
      },
      fund: { streakDays, latest: ff.length ? ff[ff.length - 1] : null, sum5: ff.length ? ff.slice(-5).reduce((s, x) => s + x.mainNetInflow, 0) : 0 },
      breadth: br, hhxg: hxg, macro, sox, relStrength: rel,
      market: { index: idx, mom20, bearMarket },
      signals,
    };
  }

  // 生成可执行指令
  function generateInstruction(analysis, state, settings) {
    settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const price = analysis.price;
    const totalCapital = state.totalCapital;
    const currentShares = state.shares || 0;
    const currentValue = currentShares * price;
    const currentPct = totalCapital ? currentValue / totalCapital * 100 : 0;
    const targetValue = totalCapital * analysis.targetPct / 100;
    const targetShares = Math.floor(targetValue / price / 100) * 100;
    const deltaShares = targetShares - currentShares;
    const deltaValue = deltaShares * price;

    let action, side;
    if (deltaShares >= 100) { action = '买入'; side = 'buy'; }
    else if (deltaShares <= -100) { action = '卖出'; side = 'sell'; }
    else { action = '持有'; side = 'hold'; }

    // 分档（份）
    const lotValue = totalCapital / settings.lots;
    const deltaLots = Math.round(deltaValue / lotValue * 10) / 10;

    // 止损止盈（基于持仓成本）
    const cost = state.avgCost > 0 ? state.avgCost : price;
    const stopLoss = +(cost * (1 - settings.stopPct / 100)).toFixed(3);
    const takeProfit = +(cost * (1 + settings.takePct / 100)).toFixed(3);

    // 分批执行建议
    let tranches = [];
    if (side === 'buy') {
      const qty = Math.abs(deltaShares);
      const t1 = Math.floor(qty * 0.5 / 100) * 100;
      const t2 = Math.floor(qty * 0.3 / 100) * 100;
      const t3 = qty - t1 - t2;
      tranches = [t1, t2, t3].filter((x) => x >= 100).map((s, idx) => ({
        step: idx + 1, shares: s, amount: +(s * price).toFixed(2), note: idx === 0 ? '首仓（现价附近）' : (idx === 1 ? '回踩加仓' : '突破/企稳加仓'),
      }));
    } else if (side === 'sell') {
      const qty = Math.abs(deltaShares);
      tranches = [{ step: 1, shares: qty, amount: +(qty * price).toFixed(2), note: '逢高减仓' }];
    }

    // 建议价格
    const buyZone = side === 'buy' ? `买入区间：${(price * 0.99).toFixed(3)} ~ ${(price * 1.01).toFixed(3)}` : '';
    const sellZone = side === 'sell' ? `卖出区间：${(price * 1.005).toFixed(3)} 以上逢高` : '';

    return {
      action, side, price, currentPct: +currentPct.toFixed(1), targetPct: analysis.targetPct,
      deltaShares, deltaValue: +deltaValue.toFixed(0), deltaLots,
      tranches, buyZone, sellZone, stopLoss, takeProfit,
      lots: settings.lots, lotValue: +lotValue.toFixed(0),
    };
  }

  // 生成盘尾复盘
  function generateReview(analysis, instruction, state, quote, klines) {
    const price = analysis.price;
    const shares = state.shares || 0;
    const marketValue = shares * price;
    const costValue = shares * (state.avgCost || 0);
    const unrealized = marketValue - costValue;
    const totalAsset = state.cash + marketValue;
    const totalPnl = totalAsset - state.totalCapital;
    const dayChange = analysis.pct;

    const lines = [];
    lines.push(`【今日行情】${state.name} 收盘 ${r2(price, 3)}，涨跌幅 ${r2(dayChange, 2)}%，振幅 ${r2(analysis.indicators.bollUpper != null ? (quote && quote.amplitude != null ? quote.amplitude : 0) : 0, 2)}%。`);
    lines.push(`【账户状态】总资产 ${r2(totalAsset, 0)} 元（本金 ${r2(state.totalCapital, 0)}，总盈亏 ${totalPnl >= 0 ? '+' : ''}${r2(totalPnl, 0)} 元 / ${r2(totalPnl / state.totalCapital * 100, 2)}%）；持仓 ${shares} 份，市值 ${r2(marketValue, 0)}，浮动盈亏 ${unrealized >= 0 ? '+' : ''}${r2(unrealized, 0)} 元。`);
    lines.push(`【仓位回顾】当前仓位 ${instruction.currentPct}%，目标仓位 ${analysis.targetPct}%，偏差 ${(instruction.currentPct - analysis.targetPct).toFixed(1)} 个百分点，${instruction.action === '持有' ? '维持不变' : '建议' + instruction.action + ' ' + Math.abs(instruction.deltaShares) + ' 份'}。`);
    lines.push(`【综合评分】${analysis.score}/100（${analysis.status}）。`);
    lines.push(`【关键信号】` + analysis.signals.filter((s) => s.dir !== 'neutral').slice(0, 5).map((s) => s.text).join('；') + '。');
    lines.push(`【明日预案】若评分维持 ${analysis.score >= 60 ? '60 以上，维持多头思路，回踩 MA10/MA20 附近可低吸' : analysis.score <= 40 ? '40 以下，控制仓位，反弹至压力位减仓' : '48~60 之间，观望为主，等待方向选择'}；止损 ${r2(instruction.stopLoss, 3)}，止盈 ${r2(instruction.takeProfit, 3)}。`);
    return lines.join('\n');
  }

  // ---------- 多 ETF 动量轮动 ----------
  // 单只 ETF 的轮动打分（动量为主 + 趋势为辅，返回 0-100）
  function computeRotation(klines) {
    const n = klines.length;
    if (!n) return null;
    const closes = klines.map((k) => k.close);
    const price = closes[n - 1];
    const ma = (len) => { if (n < len) return null; let s = 0; for (let i = n - len; i < n; i++) s += closes[i]; return s / len; };
    const ma20 = ma(20), ma60 = ma(60);
    const mom20 = n > 20 ? (price / closes[n - 21] - 1) * 100 : 0;
    const mom60 = n > 60 ? (price / closes[n - 61] - 1) * 100 : 0;
    let score = 50;
    score += clamp(mom20 * 1.5, -20, 20);
    score += clamp(mom60 * 0.6, -12, 12);
    if (ma20 != null) score += price > ma20 ? 8 : -8;
    if (ma60 != null) score += price > ma60 ? 6 : -6;
    score = Math.round(clamp(score, 0, 100));
    return { price, mom20, mom60, ma20, ma60, aboveMa20: ma20 != null && price > ma20, aboveMa60: ma60 != null && price > ma60, score };
  }

  // 轮动决策：pool=[{code,name,rotation,analyzeScore}], market={bearMarket,sentimentIndex,...}
  function pickRotation(pool, market) {
    const m = market || {};
    // 综合分 = 动量分 × 50% + 综合评分（技术面+宏观+情绪） × 50%
    pool.forEach((r) => {
      if (r.rotation) {
        const base = r.rotation.score;
        const full = r.analyzeScore != null ? r.analyzeScore : base;
        r.combined = Math.round(base * 0.5 + full * 0.5);
      }
    });
    const sorted = pool.slice().filter((r) => r.rotation).sort((a, b) => b.combined - a.combined);
    const top = sorted[0] || null;
    const eligible = sorted.filter((r) => r.rotation.mom20 > 0);
    let pick = null, action = '空仓', reason = '';
    if (m.bearMarket) { action = '空仓'; reason = '大盘熊市（沪深300<MA60）'; }
    else if (!eligible.length) { action = '空仓'; reason = '所有ETF 20日动量均为负'; }
    else { pick = eligible[0]; action = '持有'; reason = `动量最强（20日 ${r2(pick.rotation.mom20, 2)}%）`; }

    let targetPct = 0;
    if (pick) {
      const sc = pick.rotation.score;
      if (sc >= 75) targetPct = 80;
      else if (sc >= 65) targetPct = 60;
      else if (sc >= 55) targetPct = 40;
      else targetPct = 20;
      if (m.sentimentIndex != null && m.sentimentIndex >= 85) targetPct *= 0.6;   // 情绪过热不追高
      if (m.sentimentIndex != null && m.sentimentIndex < 25) targetPct *= 0.7;    // 情绪冰点谨慎
      // 宏观：美债10Y 高位/急升 → 压制科技成长，降仓
      const u = m.us10y;
      if (u != null) {
        if (u > 4.5) targetPct *= 0.6;
        else if (u > 4.2) targetPct *= 0.85;
        else if (u < 4.0) targetPct *= 1.1;
      }
      // 费半大跌隔夜 → 科技情绪承压，降仓
      if (m.soxChg != null && m.soxChg < -2) targetPct *= 0.8;
      // 科技相对强度弱于大盘 → 降仓
      if (m.relStrength != null && m.relStrength < -3) targetPct *= 0.85;
    }
    return { top, pick, eligible, sorted, action, reason, targetPct: Math.round(targetPct), bearMarket: !!m.bearMarket };
  }

  // ---------- 前瞻预测：1天 / 3天 / 1周 / 1月 ----------
  // 规则型可解释预测：短周期重动量/反转/量价/费半，长周期重趋势/宏观/资金/相对强度
  function predict(klines, analysis, extras) {
    extras = extras || {};
    const v = analysis.indicators || {};
    const price = analysis.price;
    const mkt = analysis.market || {};
    const atrPct = v.atrPct != null ? v.atrPct : (v.atr && price ? v.atr / price * 100 : 2);

    // ---- 归一化信号（-1..1）----
    let trend = 0, tn = 0;
    if (v.ma20 != null) { trend += price > v.ma20 ? 1 : -1; tn++; }
    if (v.ma60 != null) { trend += price > v.ma60 ? 1 : -1; tn++; }
    if (v.ma5 != null && v.ma20 != null) { trend += v.ma5 > v.ma20 ? 1 : -1; tn++; }
    trend = tn ? trend / tn : 0;

    const mom20 = mkt.mom20 != null ? mkt.mom20 : 0;
    const mom = Math.max(-1, Math.min(1, mom20 / 15));

    const r6 = v.rsi6;
    const rsiRev = r6 != null ? (r6 < 30 ? 1 : r6 > 70 ? -1 : (r6 < 40 ? 0.3 : r6 > 60 ? -0.3 : 0)) : 0;

    const macdDir = (v.dif != null && v.dea != null) ? (v.dif > v.dea ? 1 : -1) : 0;

    const f = extras.fundFlow || [];
    let fund = 0;
    if (f.length) {
      const lp = f[f.length - 1];
      if (lp.mainNetInflowPct > 5) fund = 1;
      else if (lp.mainNetInflowPct < -5) fund = -1;
      else if (lp.mainNetInflowPct > 0) fund = 0.5;
      else fund = -0.5;
    }

    const macro = extras.macro || {};
    const us = macro.us10y || {};
    let macroS = 0;
    if (us.price != null) {
      if (us.price > 4.5) macroS -= 2; else if (us.price > 4.2) macroS -= 1; else if (us.price < 4.0) macroS += 1;
      if (us.chg20bp != null && us.chg20bp > 30) macroS -= 1; else if (us.chg20bp != null && us.chg20bp < -30) macroS += 1;
    }
    const cn = macro.cn10y || {};
    if (cn.chg20bp != null) { if (cn.chg20bp > 20) macroS -= 1; else if (cn.chg20bp < -20) macroS += 1; }
    macroS = Math.max(-1, Math.min(1, macroS / 4));

    const hx = extras.hhxg || {};
    let senti = 0;
    if (hx.sentimentIndex != null) {
      if (hx.sentimentIndex >= 85) senti = -0.5;
      else if (hx.sentimentIndex >= 65) senti = 0.5;
      else if (hx.sentimentIndex >= 25) senti = -0.3;
      else senti = 0.5;
    }

    const sox = extras.sox || {};
    const soxS = sox.chgPct != null ? (sox.chgPct > 2 ? 1 : sox.chgPct < -2 ? -1 : 0) : 0;

    const idx = extras.index || {};
    const indexS = idx.ma60 != null ? (idx.price >= idx.ma60 ? 1 : -1) : 0;

    const rel = extras.relStrength != null ? (extras.relStrength > 3 ? 1 : extras.relStrength < -3 ? -1 : 0) : 0;

    const dayChg = analysis.pct != null ? analysis.pct : 0;
    const vRatio = v.vRatio != null ? v.vRatio : 1;
    let volS = 0;
    if (vRatio > 1.3) volS = dayChg > 0 ? 1 : -1;
    else if (vRatio < 0.7) volS = dayChg > 0 ? 0.3 : -0.3;

    // 各周期加权：短周期重动量/反转/量价/费半，长周期重趋势/宏观/资金/相对强度
    const w = {
      d1: 0.30 * mom + 0.25 * rsiRev + 0.15 * volS + 0.10 * soxS + 0.10 * senti + 0.10 * indexS,
      d3: 0.25 * mom + 0.20 * trend + 0.15 * macdDir + 0.15 * volS + 0.10 * soxS + 0.10 * indexS + 0.05 * rel,
      w1: 0.25 * trend + 0.20 * mom + 0.15 * fund + 0.15 * macroS + 0.10 * indexS + 0.10 * rel + 0.05 * senti,
      m1: 0.25 * trend + 0.20 * macroS + 0.20 * fund + 0.15 * indexS + 0.10 * rel + 0.10 * mom,
    };
    const toProb = (s) => Math.max(5, Math.min(95, Math.round(50 + s * 50)));
    const range = { d1: atrPct, d3: atrPct * 1.7, w1: atrPct * 2.6, m1: atrPct * 4.6 };
    const label = (s) => (s > 0.2 ? '看涨' : s < -0.2 ? '看跌' : '震荡');
    const key = (s) => (s > 0.6 ? '强' : s > 0.2 ? '偏' : s > -0.2 ? '中' : s > -0.6 ? '偏' : '强');

    const out = {};
    for (const k of ['d1', 'd3', 'w1', 'm1']) {
      const s = w[k];
      const upProb = toProb(s);
      out[k] = {
        dir: label(s),
        upProb,
        downProb: 100 - upProb,
        rangePct: +range[k].toFixed(1),
        score: Math.round(s * 100),
        priceLow: +(price * (1 - range[k] / 100)).toFixed(3),
        priceHigh: +(price * (1 + range[k] / 100)).toFixed(3),
      };
    }
    out.summary = {
      dir: label(w.w1),
      upProb: toProb(w.w1),
      keySignals: [
        (trend > 0 ? '多头' : trend < 0 ? '空头' : '震荡') + '趋势',
        mom20 > 0 ? '正动量' : mom20 < 0 ? '负动量' : '动量平',
        fund > 0 ? '主力流入' : fund < 0 ? '主力流出' : '资金中性',
        macroS > 0 ? '宏观宽松' : macroS < 0 ? '宏观偏紧' : '宏观中性',
        senti > 0 ? '情绪暖' : senti < 0 ? '情绪冷' : '情绪中性',
        soxS > 0 ? '费半强' : soxS < 0 ? '费半弱' : '费半平',
        indexS > 0 ? '大盘多头' : '大盘熊市',
      ],
    };
    return out;
  }

  const api = { DEFAULT_SETTINGS, analyze, generateInstruction, generateReview, computeRotation, pickRotation, predict, clamp, last, lastVal, r2 };
  global.Engine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
