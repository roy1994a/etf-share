/**
 * 前端主逻辑：数据拉取、指标计算、评分、图表、交易、复盘
 */
(function () {
  'use strict';

  const RED = '#ef4444', GREEN = '#22c55e', MUTED = '#8b98a9', ACCENT = '#3b82f6', PURPLE = '#a855f7', AMBER = '#f59e0b';
  const CODE = '159516';

  const App = {
    state: null,
    quote: null,
    klines: [],
    minute: null,
    ind: null,
    analysis: null,
    instruction: null,
    settings: Engine.DEFAULT_SETTINGS ? Object.assign({}, Engine.DEFAULT_SETTINGS) : { risk: 1, stopPct: 5, takePct: 8, lots: 10, maxPosition: 100 },
    period: 'day',
    side: 'buy',
    code: '159516',       // 当前分析的 ETF（可搜索切换）
    codeName: '半导体设备',
    tradeCode: '159516',
    otherQuotes: {},
    readOnly: false,
    etfPool: [
      { code: '159516', name: '半导体设备' },
      { code: '512010', name: '医药' },
      { code: '512400', name: '有色' },
    ],
    charts: {},
    hasEcharts: !!window.echarts,
    lastError: '',
  };

  // ---------- 工具 ----------
  function $(s) { return document.querySelector(s); }
  function fmt(n, d) { if (n == null || isNaN(n)) return '--'; return (+n).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function fmtPrice(n) { return n == null ? '--' : (+n).toFixed(3); }
  function dirClass(n) { return n > 0 ? 'up' : (n < 0 ? 'down' : 'flat'); }
  function signed(n, d) { if (n == null) return '--'; return (n > 0 ? '+' : '') + (+n).toFixed(d || 2); }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    const j = await r.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!j.ok && j.error) throw new Error(j.error);
    return j;
  }

  function toast(msg, type) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + (type || '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast'; }, 3000);
  }

  // ---------- 设置持久化 ----------
  function loadSettings() {
    try {
      const s = localStorage.getItem('etf_sim_settings');
      if (s) App.settings = Object.assign(App.settings, JSON.parse(s));
    } catch (e) {}
  }
  function saveSettings() {
    try { localStorage.setItem('etf_sim_settings', JSON.stringify(App.settings)); } catch (e) {}
    applySettingsUI();
  }

  // ---------- 数据加载 ----------
  async function loadAll() {
    try {
      const stateR = await api('/api/state');
      App.state = stateR.state;
      App.state.positions = App.state.positions || {};
      App.readOnly = !!stateR.readOnly;
      App.lanIp = stateR.lanIp || null;
      applyReadOnly();
      // 轮动池（ETF + 科技板块股票）来自后端，用于行情条与交易标的
      if (stateR.pool && stateR.pool.length) {
        App.etfPool = stateR.pool;
        buildTradeCodeOptions();
      }

      // 分析用K线：分时模式下仍用日K做分析
      App.klinePeriod = App.period === 'minute' ? 'day' : App.period;
      const klineR = await api('/api/kline?period=' + App.klinePeriod + '&limit=260&code=' + App.code);
      App.klines = klineR.klines || [];
      App.quote = klineR.quote || null;
      if (App.quote) { App.quote.name = App.quote.name || App.code; App.codeName = App.quote.name; }

      // 分时数据：分时模式必取
      if (App.period === 'minute') {
        try {
          const m = await api('/api/minute?code=' + App.code);
          App.minute = m.points || [];
          if (m.prevClose) App.minutePrevClose = m.prevClose;
        } catch (e) { App.minute = []; }
      }

      // 抓取持仓中其它 ETF 的实时价（用于多持仓展示）
      App.otherQuotes = {};
      const heldCodes = Object.keys(App.state.positions).filter((c) => c !== App.code);
      if (heldCodes.length) {
        await Promise.all(heldCodes.map(async (c) => {
          try { const r = await api('/api/quote?code=' + c); App.otherQuotes[c] = r.quote; } catch (e) {}
        }));
      }

      computeAndRender();
      refreshEtfQuotes();
      refreshMacro();
    } catch (e) {
      App.lastError = e.message || '加载失败';
      $('#footStatus').textContent = '⚠ 数据加载失败：' + App.lastError + '（请确认后端已启动）';
      $('#qMeta').textContent = '数据加载失败';
      toast('数据加载失败：' + App.lastError, 'err');
    }
  }

  // 交易标的选择器：按轮动池动态生成（ETF + 股票）
  function buildTradeCodeOptions() {
    const sel = $('#tradeCode');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = App.etfPool.map((e) => '<option value="' + e.code + '">' + e.name + (e.type === 'stock' ? '' : 'ETF') + ' (' + e.code + ')</option>').join('');
    sel.value = App.etfPool.some((e) => e.code === cur) ? cur : App.etfPool[0].code;
    App.tradeCode = sel.value;
  }

  // ---------- 轮动池管理（增删标的） ----------
  function renderPoolList() {
    const el = $('#poolList');
    if (!el) return;
    el.innerHTML = App.etfPool.map((x) =>
      '<div class="pool-item"><span>' + x.name + (x.type === 'etf' ? 'ETF' : '') + ' <span class="c">' + x.code + '</span></span>' +
      '<button class="pool-del" data-code="' + x.code + '">×</button></div>'
    ).join('');
  }
  async function refreshPool() {
    try {
      const r = await api('/api/pool');
      if (r.pool && r.pool.length) { App.etfPool = r.pool; buildTradeCodeOptions(); renderPoolList(); refreshEtfQuotes(); }
    } catch (e) {}
  }
  async function poolAdd(code, name) {
    try {
      await api('/api/pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', code, name }) });
      toast('已添加 ' + name, 'ok'); await refreshPool();
    } catch (e) { toast('添加失败：' + e.message, 'err'); }
  }
  async function poolRemove(code) {
    try {
      await api('/api/pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', code }) });
      toast('已移除 ' + code, 'ok'); await refreshPool();
    } catch (e) { toast('移除失败：' + e.message, 'err'); }
  }
  function bindPoolManager() {
    const btn = $('#poolMgrBtn'), mgr = $('#poolManager');
    if (!btn || !mgr) return;
    btn.addEventListener('click', () => { const show = mgr.style.display === 'none'; mgr.style.display = show ? '' : 'none'; if (show) renderPoolList(); });
    const input = $('#poolAdd'), box = $('#poolAddResults');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const kw = input.value.trim();
        if (!kw) { box.style.display = 'none'; return; }
        if (/^\d{6}$/.test(kw)) {
          box.innerHTML = '<div class="sr-item" data-code="' + kw + '" data-name="' + kw + '">添加 ' + kw + '（点击确认）</div>';
          box.style.display = 'block'; return;
        }
        try {
          const r = await api('/api/search?q=' + encodeURIComponent(kw));
          const list = (r.results || []).slice(0, 8);
          if (!list.length) { box.innerHTML = '<div class="sr-item muted">无匹配</div>'; box.style.display = 'block'; return; }
          box.innerHTML = list.map((x) => '<div class="sr-item" data-code="' + x.code + '" data-name="' + x.name + '">' + x.name + ' <span class="c">' + x.code + '</span></div>').join('');
          box.style.display = 'block';
        } catch (e) { box.style.display = 'none'; }
      }, 300);
    });
    box.addEventListener('click', async (e) => {
      const it = e.target.closest('.sr-item');
      if (!it || !it.dataset.code) return;
      await poolAdd(it.dataset.code, it.dataset.name);
      input.value = ''; box.style.display = 'none';
    });
    mgr.addEventListener('click', (e) => {
      const del = e.target.closest('.pool-del');
      if (del && del.dataset.code) poolRemove(del.dataset.code);
    });
  }

  // 多 ETF 实时行情：抓取并渲染
  async function refreshEtfQuotes() {
    const el = $('#etfQuoteStrip');
    if (!el) return;
    try {
      const qs = await Promise.all(App.etfPool.map(async (e) => {
        try {
          const r = e.code === CODE ? { quote: App.quote } : await api('/api/quote?code=' + e.code);
          return { name: e.name, code: e.code, quote: r.quote || null };
        } catch (err) { return { name: e.name, code: e.code, quote: null }; }
      }));
      el.innerHTML = qs.map((x) => {
        const q = x.quote;
        const price = q ? q.price : null;
        const pct = q ? q.pctChange : null;
        const cls = (pct == null) ? 'flat' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'));
        return '<div class="etf-quote-card">' +
          '<div class="n">' + x.name + ' <span class="c">' + x.code + '</span></div>' +
          '<div class="p">' + (price != null ? fmtPrice(price) : '--') + '</div>' +
          '<div class="chg ' + cls + '">' + (pct != null ? signed(pct, 2) + '%' : '--') + '</div>' +
          '</div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<div style="color:#8b98a9">行情加载失败</div>';
    }
  }

  // 总览页技术指标面板（当前标的中切换）
  function renderTechPanel() {
    const el = $('#techPanel');
    if (!el || !App.analysis) return;
    const v = App.analysis.indicators;
    const items = [
      ['MA5/10/20/60', fmtPrice(v.ma5) + ' / ' + fmtPrice(v.ma10) + ' / ' + fmtPrice(v.ma20) + ' / ' + fmtPrice(v.ma60)],
      ['MACD', 'DIF ' + (v.dif == null ? '--' : (+v.dif).toFixed(4)) + ' · DEA ' + (v.dea == null ? '--' : (+v.dea).toFixed(4)) + ' · 柱 ' + (v.macd == null ? '--' : (+v.macd).toFixed(4))],
      ['RSI6 / RSI12 / RSI24', fmt(v.rsi6, 1) + ' / ' + fmt(v.rsi12, 1) + ' / ' + fmt(v.rsi24, 1)],
      ['KDJ', 'K ' + fmt(v.k, 1) + ' · D ' + fmt(v.d, 1) + ' · J ' + fmt(v.j, 1)],
      ['BOLL', '上 ' + fmtPrice(v.bollUpper) + ' · 中 ' + fmtPrice(v.bollMid) + ' · 下 ' + fmtPrice(v.bollLower)],
      ['ATR', fmtPrice(v.atr) + '（' + fmt(v.atrPct, 2) + '%）'],
      ['MFI / 量比(5日)', fmt(v.mfi, 1) + ' / ' + fmt(v.vRatio, 2)],
      ['近20日高/低', fmtPrice(v.h20) + ' / ' + fmtPrice(v.l20)],
    ];
    el.innerHTML = items.map(([k, val]) => '<div class="ind-item"><div class="k">' + k + '</div><div class="v">' + val + '</div></div>').join('');
  }

  // 宏观利率与科技板块面板
  async function refreshMacro() {
    const el = $('#macroPanel');
    if (!el) return;
    try {
      const r = await api('/api/macro');
      const us = r.us10y, cn = r.cn10y, sox = r.sox;
      const card = (label, val, sub, cls) => '<div class="m-card"><div class="n">' + label + '</div><div class="v ' + (cls || '') + '">' + val + '</div>' + (sub ? '<div class="s">' + sub + '</div>' : '') + '</div>';
      const usCls = (us && us.price > 4.5) ? 'bear' : ((us && us.price < 4.0) ? 'bull' : '');
      const usSub = us ? ('近月 ' + (us.chg20bp != null ? signed(us.chg20bp, 0) + 'bp' : '--') + ' · 52周高 ' + (us.high52 != null ? fmtPrice(us.high52) : '--')) : '';
      const cnSub = cn ? ('近月 ' + (cn.chg20bp != null ? signed(cn.chg20bp, 0) + 'bp' : '--')) : '';
      const soxCls = (sox && sox.chgPct != null) ? (sox.chgPct > 0 ? 'up' : 'down') : '';
      const soxSub = (sox && sox.chgPct != null) ? '隔夜 ' + signed(sox.chgPct, 2) + '%' : '';
      const note = (us && us.price > 4.5) ? '⚠ 美债10Y高位，压制科技/成长估值，注意控制仓位' : ((us && us.price < 4.0) ? '美债10Y低位，利好成长风格' : '美债10Y中性');
      el.innerHTML =
        card('美债10Y', us ? fmtPrice(us.price) + '%' : '--', usSub, usCls) +
        card('中债10Y', cn ? fmtPrice(cn.price) + '%' : '--', cnSub) +
        card('费半SOX', sox ? fmt(sox.price, 0) : '--', soxSub, soxCls) +
        '<div class="m-note">' + note + '</div>';
    } catch (e) {
      el.innerHTML = '<div style="color:#8b98a9">宏观数据加载失败</div>';
    }
  }

  // ---------- 只读模式 UI ----------
  function applyReadOnly() {
    const ro = App.readOnly;
    const tradeForm = document.querySelector('.trade-form');
    const quickBtns = document.querySelector('.quick-btns');
    if (tradeForm) tradeForm.style.display = ro ? 'none' : '';
    if (quickBtns) quickBtns.style.display = ro ? 'none' : '';
    const resetBtn = $('#resetBtn'); if (resetBtn) resetBtn.style.display = ro ? 'none' : '';
    const saveReview = $('#saveReviewBtn'); if (saveReview) saveReview.style.display = ro ? 'none' : '';
    const genReview = $('#genReviewBtn'); if (genReview) genReview.style.display = ro ? 'none' : '';
    const hint = $('#readOnlyHint'); if (hint) hint.style.display = ro ? '' : 'none';
  }

  // ---------- ETF 搜索切换 ----------
  let searchTimer = null;
  function bindEtfSearch() {
    const input = $('#etfSearch');
    const box = $('#etfSearchResults');
    if (!input || !box) return;
    const doSearch = async (kw) => {
      kw = (kw || '').trim();
      if (!kw) { box.innerHTML = ''; box.style.display = 'none'; return; }
      // 6位数字代码 → 直接切换
      if (/^\d{6}$/.test(kw)) {
        App.code = kw; App.tradeCode = kw; App.codeName = kw;
        const tc = $('#tradeCode'); if (tc) tc.value = kw;
        box.innerHTML = ''; box.style.display = 'none';
        loadAll(); return;
      }
      try {
        const r = await api('/api/search?q=' + encodeURIComponent(kw));
        const list = (r.results || []).slice(0, 10);
        if (!list.length) { box.innerHTML = '<div class="sr-item muted">无匹配基金</div>'; box.style.display = 'block'; return; }
        box.innerHTML = list.map((x) => '<div class="sr-item" data-code="' + x.code + '" data-name="' + x.name + '">' + x.name + ' <span class="c">' + x.code + '</span></div>').join('');
        box.style.display = 'block';
      } catch (e) { box.innerHTML = '<div class="sr-item muted">搜索失败</div>'; box.style.display = 'block'; }
    };
    input.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch(input.value), 300); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); doSearch(input.value); } });
    box.addEventListener('click', (e) => {
      const it = e.target.closest('.sr-item');
      if (!it || !it.dataset.code) return;
      App.code = it.dataset.code; App.codeName = it.dataset.name; App.tradeCode = it.dataset.code;
      const tc = $('#tradeCode'); if (tc) tc.value = it.dataset.code;
      input.value = it.dataset.name;
      box.innerHTML = ''; box.style.display = 'none';
      loadAll();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.etf-search')) box.style.display = 'none'; });
  }

  function computeAndRender() {
    if (!App.klines.length) { renderEmpty(); return; }
    // 用实时价校准当日最后一根K（仅当日K分析时）
    const lastK = App.klines[App.klines.length - 1];
    if (App.quote && App.quote.price != null && App.klinePeriod === 'day') {
      const t = App.quote.time || '';
      const qDate = t.length >= 8 ? t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6, 8) : null;
      if (qDate && lastK.date === qDate) {
        lastK.open = App.quote.open != null ? App.quote.open : lastK.open;
        lastK.close = App.quote.price;
        lastK.high = App.quote.high != null ? App.quote.high : lastK.high;
        lastK.low = App.quote.low != null ? App.quote.low : lastK.low;
        lastK.volume = App.quote.volume != null ? App.quote.volume : lastK.volume;
      } else if (qDate && lastK.date < qDate) {
        App.klines.push({ date: qDate, open: App.quote.open != null ? App.quote.open : App.quote.price, close: App.quote.price, high: App.quote.high != null ? App.quote.high : App.quote.price, low: App.quote.low != null ? App.quote.low : App.quote.price, volume: App.quote.volume || 0 });
      } else {
        lastK.close = App.quote.price;
      }
    }
    App.ind = Indicators.computeAll(App.klines);
    App.analysis = Engine.analyze(App.klines, App.ind, App.quote, App.settings);
    if (App.state) App.instruction = Engine.generateInstruction(App.analysis, App.state, App.settings);

    renderQuote();
    renderDashboard();
    renderChart();
    renderIndicators();
    renderTechPanel();
    renderStrategy();
    renderTrade();
    $('#footStatus').textContent = '数据源：腾讯行情 · 更新于 ' + new Date().toLocaleTimeString('zh-CN') + (App.lanIp ? ' · 局域网访问 http://' + App.lanIp + ':8899' : '') + ' · 系统仅作学习研究，不构成投资建议';
  }

  function renderEmpty() {
    $('#qPrice').textContent = '--';
    $('#dScore').textContent = '--';
    $('#mainChart').innerHTML = '<div style="padding:40px;color:#8b98a9;text-align:center">暂无行情数据，请确认后端服务已启动并联网。</div>';
  }

  // ---------- 渲染：顶栏行情 ----------
  function renderQuote() {
    const q = App.quote;
    if (!q) return;
    $('#etfName').innerHTML = (q.name || App.codeName || '半导体设备ETF国泰') + ' <span class="code">' + (q.code || App.code) + '</span>';
    const price = q.price;
    const pct = q.pctChange;
    $('#qPrice').textContent = fmtPrice(price);
    const chgEl = $('#qChg');
    chgEl.textContent = (pct != null ? signed(pct, 2) + '%' : '') + (q.change != null ? '  ' + signed(q.change, 3) : '');
    chgEl.className = 'chg ' + dirClass(pct || 0);
    $('#qMeta').textContent = '高 ' + fmtPrice(q.high) + ' · 低 ' + fmtPrice(q.low) + ' · 昨收 ' + fmtPrice(q.prevClose) + ' · 额 ' + (q.amount != null ? (q.amount / 10000).toFixed(2) + '亿' : '--') + (q.time ? ' · ' + q.time.slice(8, 10) + ':' + q.time.slice(10, 12) : '');
  }

  // ---------- 渲染：总览 ----------
  function renderDashboard() {
    if (!App.state || !App.analysis) return;
    const s = App.state, a = App.analysis;
    const price = a.price;
    const mv = s.shares * price;
    const total = s.cash + mv;
    const totalPnl = total - s.totalCapital;
    const totalPnlPct = s.totalCapital ? totalPnl / s.totalCapital * 100 : 0;
    const unreal = mv - s.avgCost * s.shares;

    $('#dTotalAsset').textContent = fmt(total, 0);
    $('#dTotalPnl').textContent = '总盈亏 ' + signed(totalPnl, 0) + ' 元（' + signed(totalPnlPct, 2) + '%）';
    $('#dTotalPnl').className = 'sub ' + dirClass(totalPnl);
    $('#dCash').textContent = fmt(s.cash, 0);
    $('#dCapital').textContent = fmt(s.totalCapital, 0);
    $('#dMarketValue').textContent = fmt(mv, 0);
    $('#dShares').textContent = fmt(s.shares, 0);
    $('#dCost').textContent = fmtPrice(s.avgCost || 0);
    $('#dScore').textContent = a.score;
    $('#dScore').style.color = a.color;
    $('#dStatus').textContent = a.status + ' · 目标仓位 ' + a.targetPct + '%';

    // 策略摘要
    if (App.instruction) {
      const ins = App.instruction;
      $('#dStrategySummary').innerHTML =
        '<div class="action-badge ' + ins.side + '">' + ins.action + '</div>' +
        '<div style="margin:8px 0">评分 <b>' + a.score + '</b>（' + a.status + '）· 当前仓位 ' + ins.currentPct + '% → 目标 ' + ins.targetPct + '%</div>' +
        '<div>' + (ins.side === 'hold' ? '维持现有仓位，等待信号。' : '建议<b>' + ins.action + ' ' + fmt(Math.abs(ins.deltaShares), 0) + ' 份</b>（约 ' + fmt(Math.abs(ins.deltaValue), 0) + ' 元）') + '</div>' +
        '<div class="zone">止损 ' + fmtPrice(ins.stopLoss) + ' · 止盈 ' + fmtPrice(ins.takeProfit) + '</div>';
    }

    // 行情详情
    const q = App.quote;
    if (q) {
      $('#dQuoteDetail').innerHTML =
        '<div class="row" style="display:flex;justify-content:space-between;padding:6px 0"><span class="lbl">最新价</span><b>' + fmtPrice(q.price) + '</b></div>' +
        '<div class="row" style="display:flex;justify-content:space-between;padding:6px 0"><span class="lbl">涨跌幅</span><b class="' + dirClass(q.pctChange || 0) + '">' + signed(q.pctChange, 2) + '%</b></div>' +
        '<div class="row" style="display:flex;justify-content:space-between;padding:6px 0"><span class="lbl">振幅</span><b>' + fmt(q.amplitude, 2) + '%</b></div>' +
        '<div class="row" style="display:flex;justify-content:space-between;padding:6px 0"><span class="lbl">换手率</span><b>' + fmt(q.turnover, 2) + '%</b></div>' +
        '<div class="row" style="display:flex;justify-content:space-between;padding:6px 0"><span class="lbl">成交量</span><b>' + (q.volume ? (q.volume / 10000).toFixed(1) + '万手' : '--') + '</b></div>';
    }

    renderMiniChart();
  }

  // ---------- 渲染：指标速览 ----------
  function renderIndicators() {
    if (!App.ind || !App.analysis) return;
    const v = App.analysis.indicators;
    const items = [
      ['MA5', fmtPrice(v.ma5)], ['MA10', fmtPrice(v.ma10)], ['MA20', fmtPrice(v.ma20)], ['MA60', fmtPrice(v.ma60)],
      ['MACD DIF', v.dif == null ? '--' : (+v.dif).toFixed(4)], ['MACD DEA', v.dea == null ? '--' : (+v.dea).toFixed(4)], ['MACD柱', v.macd == null ? '--' : (+v.macd).toFixed(4)],
      ['RSI6', fmt(v.rsi6, 1)], ['RSI12', fmt(v.rsi12, 1)], ['RSI24', fmt(v.rsi24, 1)],
      ['KDJ-K', fmt(v.k, 1)], ['KDJ-D', fmt(v.d, 1)], ['KDJ-J', fmt(v.j, 1)],
      ['BOLL上', fmtPrice(v.bollUpper)], ['BOLL中', fmtPrice(v.bollMid)], ['BOLL下', fmtPrice(v.bollLower)],
      ['ATR', fmtPrice(v.atr)], ['ATR%', fmt(v.atrPct, 2) + '%'], ['MFI', fmt(v.mfi, 1)],
      ['量比(5日)', fmt(v.vRatio, 2)],
    ];
    $('#indicatorGrid').innerHTML = items.map(([k, val]) => '<div class="ind-item"><div class="k">' + k + '</div><div class="v">' + val + '</div></div>').join('');
  }

  // ---------- 渲染：今日策略 ----------
  function renderStrategy() {
    if (!App.analysis) return;
    const a = App.analysis;
    const v = a.indicators;

    $('#sScorePanel').innerHTML =
      '<div class="score-ring"><div class="num" style="color:' + a.color + '">' + a.score + '</div><div class="lbl">' + a.status + '</div></div>' +
      '<div class="score-bar"><div class="fill" style="width:' + a.score + '%;background:' + a.color + '"></div></div>' +
      '<div style="display:flex;justify-content:space-between;margin-top:8px;color:#8b98a9;font-size:12px"><span>0 强空</span><span>50 中性</span><span>100 强多</span></div>' +
      '<div style="margin-top:10px;font-size:13px">波动率 ATR ' + fmt(v.atrPct, 2) + '% ' + (v.atrPct > 3 ? '（波动较大，注意风险）' : v.atrPct > 2 ? '（波动适中）' : '（波动较小）') + '</div>';

    if (App.instruction) {
      const ins = App.instruction;
      $('#sPositionPanel').innerHTML =
        '<div class="pos-bar"><div class="fill" style="width:' + ins.targetPct + '%"></div></div>' +
        '<div class="pos-row"><span class="lbl">当前仓位</span><span class="val">' + ins.currentPct + '%</span></div>' +
        '<div class="pos-row"><span class="lbl">目标仓位</span><span class="val" style="color:' + a.color + '">' + ins.targetPct + '%</span></div>' +
        '<div class="pos-row"><span class="lbl">需调整</span><span class="val ' + dirClass(ins.deltaShares) + '">' + signed(ins.deltaShares, 0) + ' 份</span></div>' +
        '<div class="pos-row"><span class="lbl">每份资金</span><span class="val">' + fmt(ins.lotValue, 0) + ' 元</span></div>' +
        '<div class="pos-row"><span class="lbl">资金份数</span><span class="val">' + ins.lots + ' 份</span></div>';
    }

    if (App.instruction) {
      const ins = App.instruction;
      let html = '<div class="action-badge ' + ins.side + '">' + ins.action + (ins.side === 'buy' ? '（做多）' : ins.side === 'sell' ? '（减仓/做空）' : '（观望）') + '</div>';

      if (ins.side === 'buy') {
        html += '<div style="margin:8px 0">目标仓位 <b>' + ins.targetPct + '%</b>，需加仓 <b>' + fmt(ins.deltaShares, 0) + ' 份</b>（约 ' + fmt(ins.deltaValue, 0) + ' 元）。建议分 3 批执行：</div>';
        html += '<ol class="steps">' + ins.tranches.map((t) => '<li>第 ' + t.step + ' 批：' + fmt(t.shares, 0) + ' 份（约 ' + fmt(t.amount, 0) + ' 元）—— ' + t.note + '</li>').join('') + '</ol>';
        html += '<div class="zone">' + ins.buyZone + '</div>';
      } else if (ins.side === 'sell') {
        html += '<div style="margin:8px 0">目标仓位 <b>' + ins.targetPct + '%</b>，需减仓 <b>' + fmt(Math.abs(ins.deltaShares), 0) + ' 份</b>（约 ' + fmt(Math.abs(ins.deltaValue), 0) + ' 元）。</div>';
        html += '<div class="zone">' + ins.sellZone + '</div>';
      } else {
        html += '<div style="margin:8px 0">当前仓位 ' + ins.currentPct + '% 与目标 ' + ins.targetPct + '% 基本一致，<b>持股不动</b>，等待下一个信号（突破/回踩确认）再行动。</div>';
      }
      html += '<div class="risk-line">⛔ 风控：止损价 ' + fmtPrice(ins.stopLoss) + '（-' + App.settings.stopPct + '%）· 止盈价 ' + fmtPrice(ins.takeProfit) + '（+' + App.settings.takePct + '%）。跌破止损无条件执行，禁止死扛。</div>';
      $('#sInstruction').innerHTML = html;
    }

    // 信号明细
    const sigs = App.analysis.signals;
    $('#sSignals').innerHTML = sigs.map((s) =>
      '<div class="sig"><span class="dot ' + s.dir + '"></span><span class="name">' + s.name + '</span><span class="txt">' + s.text + '</span><span class="w ' + dirClass(s.weight) + '">' + signed(s.weight, 0) + '</span></div>'
    ).join('');
  }

  // ---------- 渲染：交易台 ----------
  function renderTrade() {
    if (!App.state || !App.analysis) return;
    const s = App.state, a = App.analysis, price = a.price;

    // 多持仓明细
    const positions = s.positions || {};
    const entries = Object.entries(positions);
    let posHtml = '<div class="row"><span class="lbl">可用现金</span><span class="val">' + fmt(s.cash, 0) + ' 元</span></div>';
    posHtml += '<div class="row"><span class="lbl">已实现盈亏</span><span class="val ' + dirClass(s.realizedPnl) + '">' + signed(s.realizedPnl, 0) + ' 元</span></div>';
    if (!entries.length) {
      posHtml += '<div class="row" style="color:#8b98a9"><span class="lbl">持仓</span><span class="val">暂无持仓</span></div>';
    } else {
      let totalMv = 0, totalUnreal = 0;
      for (const [code, pos] of entries) {
        const q = code === CODE ? App.quote : App.otherQuotes[code];
        const curPrice = q ? q.price : null;
        const mv = curPrice != null ? pos.shares * curPrice : null;
        const unreal = mv != null ? mv - pos.avgCost * pos.shares : null;
        if (mv != null) totalMv += mv;
        if (unreal != null) totalUnreal += unreal;
        const nm = pos.name || code;
        posHtml += '<div class="row" style="border-top:1px solid #223;padding-top:6px;margin-top:6px">' +
          '<span class="lbl">' + nm + ' <span style="color:#8b98a9;font-size:11px">' + code + '</span></span>' +
          '<span class="val">' + fmt(pos.shares, 0) + ' 份</span></div>';
        posHtml += '<div class="row"><span class="lbl">成本/现价</span><span class="val">' + fmtPrice(pos.avgCost) + ' / ' + (curPrice != null ? fmtPrice(curPrice) : '--') + '</span></div>';
        posHtml += '<div class="row"><span class="lbl">市值</span><span class="val">' + (mv != null ? fmt(mv, 0) + ' 元' : '--') + '</span></div>';
        posHtml += '<div class="row"><span class="lbl">浮动盈亏</span><span class="val ' + (unreal != null ? dirClass(unreal) : 'flat') + '">' + (unreal != null ? signed(unreal, 0) + ' 元' : '--') + '</span></div>';
      }
      posHtml += '<div class="row" style="border-top:1px solid #223;padding-top:6px;margin-top:6px"><span class="lbl">持仓总市值</span><span class="val">' + fmt(totalMv, 0) + ' 元</span></div>';
      posHtml += '<div class="row"><span class="lbl">总浮动盈亏</span><span class="val ' + dirClass(totalUnreal) + '">' + signed(totalUnreal, 0) + ' 元</span></div>';
    }
    $('#tPosition').innerHTML = posHtml;

    // 交易记录表
    const tb = $('#tradesTable tbody');
    if (!s.trades || !s.trades.length) {
      tb.innerHTML = '<tr><td colspan="7" style="color:#8b98a9;text-align:center">暂无交易记录</td></tr>';
    } else {
      tb.innerHTML = s.trades.slice().reverse().slice(0, 50).map((t) =>
        '<tr><td>' + new Date(t.time).toLocaleString('zh-CN') + '</td><td class="' + t.side + '">' + (t.side === 'buy' ? '买入' : '卖出') + '</td><td>' + (t.name || t.code || CODE) + '</td><td>' + fmtPrice(t.price) + '</td><td>' + fmt(t.shares, 0) + '</td><td>' + fmt(t.amount, 0) + '</td><td>' + fmt(t.fee, 2) + '</td></tr>'
      ).join('');
    }

    // 预估
    const p = parseFloat($('#tradePrice').value) || price;
    const sh = parseInt($('#tradeShares').value, 10);
    const am = parseFloat($('#tradeAmount').value);
    if (App.side === 'buy' && am && p) {
      const est = Math.floor(am / p / 100) * 100;
      $('#tradeEstimate').textContent = '约可买 ' + fmt(est, 0) + ' 份（≈ ' + fmt(est * p, 0) + ' 元）';
    } else if (sh) {
      $('#tradeEstimate').textContent = '金额 ≈ ' + fmt(sh * p, 0) + ' 元';
    } else {
      $('#tradeEstimate').textContent = '';
    }
  }

  // ---------- 图表 ----------
  function chartEl() { return $('#mainChart'); }
  function ensureChart(key, dom) {
    if (!window.echarts) return null;
    if (!App.charts[key]) App.charts[key] = echarts.init(dom);
    return App.charts[key];
  }

  function renderChart() {
    if (!window.echarts) {
      chartEl().innerHTML = '<div style="padding:40px;color:#8b98a9;text-align:center">图表库加载失败，请检查网络后刷新。行情数据与策略仍可用。</div>';
      return;
    }
    const dom = chartEl();
    // 先销毁旧实例再重建，避免切换标的后 K 线图不显示
    const old = window.echarts.getInstanceByDom(dom);
    if (old) old.dispose();
    dom.innerHTML = '';
    const chart = echarts.init(dom);
    App.charts.main = chart;
    if (App.period === 'minute') { renderMinuteChart(chart); }
    else { renderKlineChart(chart); }
    window.addEventListener('resize', () => chart.resize());
  }

  function renderKlineChart(chart) {
    const k = App.klines, ind = App.ind;
    const dates = k.map((x) => x.date);
    const ohlc = k.map((x) => [x.open, x.close, x.low, x.high]);
    const vols = k.map((x, i) => ({ value: x.volume, itemStyle: { color: x.close >= x.open ? 'rgba(239,68,68,.6)' : 'rgba(34,197,94,.6)' } }));

    const maLine = (arr, color, name) => ({ name, type: 'line', data: arr, smooth: false, symbol: 'none', lineStyle: { width: 1, color }, xAxisIndex: 0, yAxisIndex: 0, emphasis: { disabled: true } });
    const macdBars = k.map((x, i) => ({ value: ind.macd[i] == null ? 0 : +ind.macd[i].toFixed(4), itemStyle: { color: ind.macd[i] >= 0 ? RED : GREEN } }));
    // 均线值标签：悬停到哪根K就显示哪根的均线值（右上角）
    const maVal = (arr, i) => (arr && arr[i] != null ? (+arr[i]).toFixed(3) : '--');
    const maText = (i) => 'MA5: ' + maVal(ind.ma5, i) + '  MA10: ' + maVal(ind.ma10, i) + '  MA20: ' + maVal(ind.ma20, i) + '  MA60: ' + maVal(ind.ma60, i);
    const lastIdx = k.length - 1;

    const option = {
      backgroundColor: 'transparent',
      animation: false,
      graphic: [{
        id: 'maText', type: 'text', right: 14, top: 2, z: 100,
        style: { text: maText(lastIdx), fill: '#8b98a9', fontSize: 11, fontWeight: 'bold' },
      }],
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', crossStyle: { color: MUTED } },
        backgroundColor: '#202a38', borderColor: '#2a3646', textStyle: { color: '#e6edf3', fontSize: 12 },
        formatter: function (params) {
          const idx = params[0].dataIndex; const kk = k[idx]; if (!kk) return '';
          const pct = kk.open ? (kk.close - kk.open) / kk.open * 100 : 0;
          return '<b>' + kk.date + '</b><br/>开 ' + fmtPrice(kk.open) + ' 高 ' + fmtPrice(kk.high) + '<br/>低 ' + fmtPrice(kk.low) + ' 收 ' + fmtPrice(kk.close) +
            '<br/>涨跌 ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' +
            '<br/>MA5 ' + maVal(ind.ma5, idx) + ' · MA10 ' + maVal(ind.ma10, idx) + ' · MA20 ' + maVal(ind.ma20, idx) + ' · MA60 ' + maVal(ind.ma60, idx) +
            '<br/>量 ' + fmt(kk.volume / 10000, 1) + ' 万手';
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#333' } },
      grid: [
        { left: 62, right: 18, top: 24, height: '36%' },
        { left: 62, right: 18, top: '47%', height: '11%' },
        { left: 62, right: 18, top: '61%', height: '13%' },
        { left: 62, right: 18, top: '77%', height: '14%' },
      ],
      xAxis: [0, 1, 2, 3].map((i) => ({
        type: 'category', data: dates, gridIndex: i, boundaryGap: true,
        axisLine: { lineStyle: { color: '#2a3646' } }, axisLabel: { show: i === 3, color: MUTED, fontSize: 10 },
        axisTick: { show: false }, splitLine: { show: false },
      })),
      yAxis: [
        // 主图价格轴：十字光标随动，轴上显示当前价
        { scale: true, gridIndex: 0, position: 'left', axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#223' } }, axisPointer: { label: { show: true, backgroundColor: '#333', color: '#fff', formatter: (p) => fmtPrice(p.value) } } },
        { scale: true, gridIndex: 1, position: 'left', axisLabel: { show: false }, splitLine: { show: false } },
        { scale: true, gridIndex: 2, position: 'left', axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#223' } } },
        { scale: true, gridIndex: 3, position: 'left', min: 0, max: 100, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#223' } } },
      ],
      dataZoom: [
        // 默认显示最近 120 根（券商日K习惯），蜡烛更粗、波动更明显
        { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: Math.max(0, 100 - (App.period === 'week' ? 100 : 120) * 100 / dates.length), end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2, 3], top: '93%', height: 16, borderColor: '#2a3646', backgroundColor: '#1a222d', fillerColor: 'rgba(59,130,246,.15)', textStyle: { color: MUTED, fontSize: 10 } },
      ],
      series: [
        { name: CODE, type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: RED, color0: GREEN, borderColor: RED, borderColor0: GREEN } },
        maLine(ind.ma5, '#f59e0b', 'MA5'),
        maLine(ind.ma10, '#3b82f6', 'MA10'),
        maLine(ind.ma20, '#a855f7', 'MA20'),
        maLine(ind.ma60, '#22d3ee', 'MA60'),
        { name: '成交量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
        { name: 'MACD', type: 'bar', data: macdBars, xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%' },
        { name: 'DIF', type: 'line', data: ind.dif, xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b' } },
        { name: 'DEA', type: 'line', data: ind.dea, xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', lineStyle: { width: 1, color: '#3b82f6' } },
        { name: 'K', type: 'line', data: ind.k, xAxisIndex: 3, yAxisIndex: 3, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b' } },
        { name: 'D', type: 'line', data: ind.d, xAxisIndex: 3, yAxisIndex: 3, symbol: 'none', lineStyle: { width: 1, color: '#3b82f6' } },
        { name: 'J', type: 'line', data: ind.j, xAxisIndex: 3, yAxisIndex: 3, symbol: 'none', lineStyle: { width: 1, color: '#a855f7' } },
      ],
    };
    chart.setOption(option, true);

    // 悬停/移出时更新右上角均线标签（十字光标跟随）
    chart.off('showTip');
    chart.on('showTip', function (p) {
      if (p && p.dataIndex != null && k[p.dataIndex]) {
        chart.setOption({ graphic: [{ id: 'maText', style: { text: maText(p.dataIndex) } }] });
      }
    });
    chart.off('hideTip');
    chart.on('hideTip', function () {
      chart.setOption({ graphic: [{ id: 'maText', style: { text: maText(lastIdx) } }] });
    });
  }

  function renderMinuteChart(chart) {
    const pts = App.minute || [];
    if (!pts.length) { chart.clear(); return; }
    const times = pts.map((p) => p.time.slice(0, 2) + ':' + p.time.slice(2, 4));
    const prices = pts.map((p) => p.price);
    const avg = pts.map((p) => (p.cumVol && p.cumAmount ? p.cumAmount / (p.cumVol * 100) : p.price));
    const prevClose = App.minutePrevClose || App.quote.prevClose;
    let lastCum = 0;
    const volBars = pts.map((p) => { const d = p.cumVol - lastCum; lastCum = p.cumVol; return { value: d, itemStyle: { color: p.price >= prevClose ? 'rgba(239,68,68,.5)' : 'rgba(34,197,94,.5)' } }; });
    // 券商风格：分时线按昨收上下红涨绿跌，且 Y 轴铺满当日波动区间
    const priceData = pts.map((p) => ({ value: p.price, itemStyle: { color: p.price >= prevClose ? RED : GREEN } }));
    const vals = prices.concat(avg, [prevClose]).filter((v) => v != null);
    let yMin = Math.min.apply(null, vals), yMax = Math.max.apply(null, vals);
    const pad = (yMax - yMin) * 0.1 || (prevClose * 0.004 || 0.01);
    yMin -= pad; yMax += pad;
    // 涨跌幅刻度（券商分时风格：右侧 +%/-%）
    const pctOf = (price) => (prevClose ? (price - prevClose) / prevClose * 100 : 0);
    const yMinPct = pctOf(yMin), yMaxPct = pctOf(yMax);

    const option = {
      backgroundColor: 'transparent', animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#202a38', borderColor: '#2a3646', textStyle: { color: '#e6edf3' }, formatter: function (ps) { const i = ps[0].dataIndex; const pct = pctOf(prices[i]); return '<b>' + times[i] + '</b><br/>价 ' + fmtPrice(prices[i]) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）<br/>均价 ' + fmtPrice(avg[i]) + '<br/>昨收 ' + fmtPrice(prevClose); } },
      grid: [{ left: 62, right: 56, top: 24, height: '68%' }, { left: 62, right: 18, top: '80%', height: '12%' }],
      xAxis: [
        { type: 'category', data: times, gridIndex: 0, axisLine: { lineStyle: { color: '#2a3646' } }, axisLabel: { color: MUTED, fontSize: 10 }, boundaryGap: false },
        { type: 'category', data: times, gridIndex: 1, axisLine: { lineStyle: { color: '#2a3646' } }, axisLabel: { show: false }, boundaryGap: false },
      ],
      yAxis: [
        { gridIndex: 0, position: 'left', min: yMin, max: yMax, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#223' } } },
        // 右侧涨跌幅刻度
        { gridIndex: 0, position: 'right', min: yMinPct, max: yMaxPct, axisLabel: { color: MUTED, fontSize: 10, formatter: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%' }, splitLine: { show: false }, axisLine: { lineStyle: { color: '#2a3646' } } },
        { gridIndex: 1, position: 'left', axisLabel: { show: false }, splitLine: { show: false } },
      ],
      series: [
        { name: '价格', type: 'line', data: priceData, xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1.4 }, areaStyle: { color: 'rgba(59,130,246,.08)' } },
        { name: '均价', type: 'line', data: avg, xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b' } },
        { name: '昨收', type: 'line', data: pts.map(() => prevClose), xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1, color: '#8b98a9', type: 'dashed' } },
        { name: '量', type: 'bar', data: volBars, xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
      ],
    };
    chart.setOption(option, true);
  }

  function renderMiniChart() {
    if (!window.echarts) return;
    const dom = $('#miniChart');
    if (!App.charts.mini) App.charts.mini = echarts.init(dom);
    const chart = App.charts.mini;
    const k = App.klines.slice(-60);
    const dates = k.map((x) => x.date.slice(5));
    const closes = k.map((x) => x.close);
    const ma5 = Indicators.MA(closes, 5);
    chart.setOption({
      backgroundColor: 'transparent', animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#202a38', borderColor: '#2a3646', textStyle: { color: '#e6edf3' } },
      grid: { left: 40, right: 10, top: 10, bottom: 22 },
      xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#2a3646' } }, axisLabel: { color: MUTED, fontSize: 10 } },
      yAxis: { scale: true, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#223' } } },
      series: [
        { name: '收盘', type: 'line', data: closes, symbol: 'none', lineStyle: { width: 1.5, color: ACCENT }, areaStyle: { color: 'rgba(59,130,246,.12)' } },
        { name: 'MA5', type: 'line', data: ma5, symbol: 'none', lineStyle: { width: 1, color: AMBER } },
      ],
    }, true);
  }

  // ---------- 复盘 ----------
  async function loadReviews() {
    try {
      const r = await api('/api/reviews');
      const list = (r.reviews || []).slice().reverse();
      $('#reviewList').innerHTML = list.length ? list.map((rv) =>
        '<div class="review-item"><div class="head"><span>' + rv.date + '</span><span>' + new Date(rv.time).toLocaleString('zh-CN') + (rv.auto ? ' · 自动' : '') + '</span></div><div class="body">' + (rv.content || '') + '</div></div>'
      ).join('') : '暂无记录';
    } catch (e) { toast('复盘加载失败：' + e.message, 'err'); }
  }

  async function generateReview() {
    if (!App.analysis || !App.instruction || !App.state) { toast('请先加载行情数据', 'err'); return; }
    const text = Engine.generateReview(App.analysis, App.instruction, App.state, App.quote, App.klines);
    $('#reviewContent').value = text;
    toast('复盘已生成，可编辑后保存', 'ok');
  }

  async function saveReview() {
    const content = $('#reviewContent').value.trim();
    if (!content) { toast('复盘内容为空', 'err'); return; }
    const snapshot = {
      price: App.quote ? App.quote.price : null,
      score: App.analysis ? App.analysis.score : null,
      shares: App.state ? App.state.shares : 0,
      cash: App.state ? App.state.cash : 0,
      totalCapital: App.state ? App.state.totalCapital : 0,
    };
    try {
      await api('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, auto: false, snapshot }) });
      toast('复盘已保存', 'ok');
      loadReviews();
    } catch (e) { toast('保存失败：' + e.message, 'err'); }
  }

  // ---------- 交易 ----------
  async function doTrade(side, shares, price, amount) {
    try {
      const pi = App.etfPool.find((e) => e.code === App.tradeCode);
      const body = { side, code: App.tradeCode, name: pi ? pi.name : App.tradeCode };
      if (shares) body.shares = shares;
      if (amount) body.amount = amount;
      if (price) body.price = price;
      const r = await api('/api/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      App.state = r.state;
      const last = r.state.trades[r.state.trades.length - 1];
      toast((side === 'buy' ? '买入' : '卖出') + '成功：' + (last.name || App.tradeCode) + ' ' + fmt(last.shares, 0) + ' 份 @ ' + fmtPrice(r.price), 'ok');
      computeAndRender();
    } catch (e) { toast('下单失败：' + e.message, 'err'); }
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // ETF 搜索切换
    bindEtfSearch();
    // 轮动池管理
    bindPoolManager();
    // 标签页
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('#tab-' + b.dataset.tab).classList.add('active');
      if (b.dataset.tab === 'review') loadReviews();
      if (b.dataset.tab === 'analysis' || b.dataset.tab === 'strategy' || b.dataset.tab === 'trade') {
        setTimeout(() => { if (App.charts.main) App.charts.main.resize(); if (App.charts.mini) App.charts.mini.resize(); }, 50);
      }
    }));

    // 周期切换
    document.querySelectorAll('#periodSeg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#periodSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      App.period = b.dataset.period;
      loadAll();
    }));

    // 方向切换
    document.querySelectorAll('#sideSeg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#sideSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      App.side = b.dataset.side;
      renderTrade();
    }));

    // 风险偏好切换
    document.querySelectorAll('#riskSeg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#riskSeg button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      App.settings.risk = parseInt(b.dataset.risk, 10);
    }));

    // 交易标的切换
    const tcSel = $('#tradeCode');
    if (tcSel) tcSel.addEventListener('change', () => { App.tradeCode = tcSel.value; renderTrade(); });

    // 交易按钮
    $('#tradeBtn').addEventListener('click', () => {
      const price = parseFloat($('#tradePrice').value) || null;
      const shares = parseInt($('#tradeShares').value, 10) || null;
      const amount = parseFloat($('#tradeAmount').value) || null;
      if (!shares && !amount) { toast('请填写数量或买入金额', 'err'); return; }
      if (shares && shares % 100 !== 0) { toast('份额需为 100 的整数倍', 'err'); return; }
      doTrade(App.side, shares, price, App.side === 'buy' ? amount : null);
    });

    $('#quickAllIn').addEventListener('click', () => {
      if (!App.instruction) return;
      const ins = App.instruction;
      if (ins.deltaShares >= 100) doTrade('buy', ins.deltaShares, null, null);
      else if (ins.deltaShares <= -100) doTrade('sell', -ins.deltaShares, null, null);
      else toast('当前已接近目标仓位，无需调整', '');
    });

    $('#quickAllOut').addEventListener('click', () => {
      if (!App.state || !App.state.shares) { toast('当前无持仓', 'err'); return; }
      if (!confirm('确认清仓全部 ' + fmt(App.state.shares, 0) + ' 份？')) return;
      doTrade('sell', App.state.shares, null, null);
    });

    // 输入联动
    $('#tradePrice').addEventListener('input', renderTrade);
    $('#tradeShares').addEventListener('input', renderTrade);
    $('#tradeAmount').addEventListener('input', renderTrade);

    // 复盘
    $('#genReviewBtn').addEventListener('click', generateReview);
    $('#saveReviewBtn').addEventListener('click', saveReview);
    $('#refreshReviewBtn').addEventListener('click', loadReviews);

    // 设置
    $('#saveSettingsBtn').addEventListener('click', () => {
      App.settings.stopPct = parseFloat($('#setStop').value) || 5;
      App.settings.takePct = parseFloat($('#setTake').value) || 8;
      App.settings.lots = parseInt($('#setLots').value, 10) || 10;
      App.settings.maxPosition = clampNum(parseFloat($('#setMaxPos').value), 0, 100) || 100;
      saveSettings();
      computeAndRender();
      toast('策略参数已保存', 'ok');
    });

    $('#resetBtn').addEventListener('click', async () => {
      const cap = parseFloat($('#setCapital').value) || 500000;
      if (!confirm('确认重置账户？将清空持仓、交易记录与复盘，并按本金 ' + fmt(cap, 0) + ' 元重新开始。')) return;
      try {
        const r = await api('/api/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ capital: cap }) });
        App.state = r.state;
        computeAndRender();
        toast('账户已重置，本金 ' + fmt(cap, 0) + ' 元', 'ok');
      } catch (e) { toast('重置失败：' + e.message, 'err'); }
    });
  }

  function clampNum(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function applySettingsUI() {
    $('#setStop').value = App.settings.stopPct;
    $('#setTake').value = App.settings.takePct;
    $('#setLots').value = App.settings.lots;
    $('#setMaxPos').value = App.settings.maxPosition;
    document.querySelectorAll('#riskSeg button').forEach((b) => b.classList.toggle('active', parseInt(b.dataset.risk, 10) === App.settings.risk));
  }

  // 时钟
  function tickClock() {
    const d = new Date();
    $('#clock').textContent = d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }) + ' ' + d.toLocaleTimeString('zh-CN');
  }

  // 启动
  function init() {
    loadSettings();
    bindEvents();
    tickClock();
    setInterval(tickClock, 1000);
    loadAll();
    setInterval(loadAll, 60000);           // 每 60 秒刷新行情与策略
    setInterval(refreshEtfQuotes, 15000);  // 每 15 秒刷新多 ETF 实时行情
    setInterval(refreshMacro, 300000);     // 每 5 分钟刷新宏观面板
    // 打开界面即启动盯盘（替代开机自启）
    api('/api/monitor/start', { method: 'POST' }).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
