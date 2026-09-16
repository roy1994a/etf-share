/**
 * 前端主逻辑：数据拉取、指标计算、评分、图表、交易、复盘
 */
(function () {
  'use strict';

  const RED = '#dc2626', GREEN = '#16a34a', MUTED = '#64748b', ACCENT = '#2563eb', PURPLE = '#7c3aed', AMBER = '#d97706';
  // 仅用于首屏引导（池加载前必须先请求一个标的）；加载后一律以 App.code 为准。
  // 不要再拿它当"当前标的"用 —— 这正是池内第一格显示错标的行情的根因。
  const DEFAULT_CODE = '159516';

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
    code: DEFAULT_CODE,   // 当前分析的标的（可搜索/点击池内卡片切换）
    codeName: '半导体设备',
    tradeCode: DEFAULT_CODE,
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
      refreshPredict(); // 不阻塞：首次约 20 秒，之后命中 5 分钟缓存
    } catch (e) {
      App.lastError = e.message || '加载失败';
      $('#footStatus').textContent = '⚠ 数据加载失败：' + App.lastError + '（请确认后端已启动）';
      $('#qMeta').textContent = '数据加载失败';
      toast('数据加载失败：' + App.lastError, 'err');
    }
  }

  // 标的显示名：池内多为简称（"半导体设备"/"医药"），ETF 补后缀，股票不加。
  // 名称里已含 "ETF" 时不再叠加，避免出现 "半导体设备ETF国泰ETF"。
  function displayName(e) {
    const n = (e && (e.name || e.code)) || '';
    if (/ETF/i.test(n)) return n;
    return n + ((e && e.type === 'stock') ? '' : 'ETF');
  }

  // 统一切换当前分析标的：下拉框 / 搜索 / 池内卡片 / 行动卡候选 共用同一入口，
  // 避免各处自己拼 App.code 造成口径不一致。
  function selectInstrument(code, name) {
    if (!code) return;
    App.code = String(code);
    App.codeName = name || App.code;
    App.tradeCode = App.code;
    const tc = $('#tradeCode'); if (tc) tc.value = App.code;
    loadAll();
    if (typeof renderPoolList === 'function') renderPoolList(); // 同步高亮
  }

  // 交易标的选择器：按轮动池动态生成（ETF + 股票）
  function buildTradeCodeOptions() {
    const sel = $('#tradeCode');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = App.etfPool.map((e) => '<option value="' + e.code + '">' + displayName(e) + ' (' + e.code + ')</option>').join('');
    sel.value = App.etfPool.some((e) => e.code === cur) ? cur : App.etfPool[0].code;
    App.tradeCode = sel.value;
  }

  // ---------- 轮动池管理（增删标的） ----------
  function renderPoolList() {
    const el = $('#poolList');
    if (!el) return;
    el.innerHTML = App.etfPool.map((x) =>
      '<div class="pool-item' + (x.code === App.code ? ' active' : '') + '" data-code="' + x.code + '" data-name="' + (x.name || x.code) + '" title="点击切换查看 ' + (x.name || x.code) + '">' +
      '<span>' + displayName(x) + ' <span class="c">' + x.code + '</span></span>' +
      '<button class="pool-del" data-code="' + x.code + '" title="从池中移除">×</button></div>'
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
      if (del && del.dataset.code) { poolRemove(del.dataset.code); return; }
      // 点击池内标的 → 切换当前查看标的（放在删除判定之后，避免误触删除）
      const item = e.target.closest('.pool-item');
      if (item && item.dataset.code) {
        selectInstrument(item.dataset.code, item.dataset.name);
        toast('已切换到 ' + (item.dataset.name || item.dataset.code), 'ok');
      }
    });
  }

  // 轮动池行情条 / 行动卡候选表：点击直接切换当前查看标的
  function bindPoolClickSwitch() {
    const strip = $('#etfQuoteStrip');
    if (strip) {
      strip.addEventListener('click', (e) => {
        const card = e.target.closest('.etf-quote-card');
        if (card && card.dataset.code) selectInstrument(card.dataset.code, card.dataset.name);
      });
    }
    const ac = $('#actionCard');
    if (ac) {
      ac.addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-code]');
        if (row && row.dataset.code) selectInstrument(row.dataset.code, row.dataset.name);
      });
    }
  }

  // 多 ETF 实时行情：抓取并渲染
  async function refreshEtfQuotes() {
    const el = $('#etfQuoteStrip');
    if (!el) return;
    try {
      const qs = await Promise.all(App.etfPool.map(async (e) => {
        try {
          // 复用已拉取的行情，但必须比较 App.code（当前选中标的）而非写死的 CODE：
          // 原来写死 CODE='159516'，用户一旦切到别的标的，
          // 池内第一格「半导体设备 159516」就会显示成别的标的的价格和涨跌幅。
          const reuse = (e.code === App.code && App.quote) ? App.quote : null;
          const r = reuse ? { quote: reuse } : await api('/api/quote?code=' + e.code);
          return { name: e.name, code: e.code, quote: r.quote || null };
        } catch (err) { return { name: e.name, code: e.code, quote: null }; }
      }));
      el.innerHTML = qs.map((x) => {
        const q = x.quote;
        const price = q ? q.price : null;
        const pct = q ? q.pctChange : null;
        const cls = (pct == null) ? 'flat' : (pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat'));
        return '<div class="etf-quote-card clickable' + (x.code === App.code ? ' active' : '') + '" data-code="' + x.code + '" data-name="' + x.name + '" title="点击切换查看 ' + x.name + '">' +
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

  // 前瞻预测面板（1天/3天/1周/1月）
  let predictData = null;
  async function refreshPredict() {
    try {
      const r = await api('/api/predict?code=' + App.code);
      predictData = r;
      renderPredictTab();
      renderStrategy(); // 预测联动：刷新今日策略
    } catch (e) {
      const el = $('#predictPanel');
      if (el) el.innerHTML = '<div style="color:#8b98a9">预测加载失败（首次约需 20 秒，稍后自动重试）</div>';
    }
  }

  function renderPredictTab() {
    const r = predictData;
    if (!r || !r.prediction) return;
    const p = r.prediction, el = $('#predictPanel'), elCards = $('#predictCards');
    const nm = { d1: '1天', d3: '3天', w1: '1周', m1: '1月' };
    const arrow = (d) => (d === '看涨' ? '↑' : d === '看跌' ? '↓' : '→');
    const sigLabel = { buy: '✅ 达到买入阈值', avoid: '⛔ 达到回避阈值', neutral: '⏸ 未达阈值（观望）' };
    const cardsHtml = ['d1', 'd3', 'w1', 'm1'].map((k) => {
      const x = p[k];
      const cls = x.dir === '看涨' ? 'bull' : (x.dir === '看跌' ? 'bear' : 'flat');
      // 展示"可信概率"（Platt 标定后），同时把原始概率与打折幅度如实标注
      let probHtml = '<div class="s">可信概率 涨 <b>' + x.upProb + '%</b> / 跌 ' + x.downProb + '%</div>';
      if (x.calibrated && x.upProbRawLearned != null && x.upProbRawLearned !== x.upProb) {
        probHtml += '<div class="s muted">学习器原始 ' + x.upProbRawLearned + '% → 标定 ' + x.upProb + '%</div>';
      }
      if (x.upProbRawModel != null && x.upProbRawModel !== x.upProb) {
        probHtml += '<div class="s muted">（手工模型另给 ' + x.upProbRawModel + '%）</div>';
      }
      let sigHtml = '';
      if (x.decisionGrade === 'reference') {
        // P4：d1 方向 51.3% < 朴素基准 51.6%，无边际 → 只作参考，不给买卖信号
        sigHtml = '<div class="s flat">📎 参考（1天周期无边际：51.3% vs 朴素 51.6%），不用于决策</div>';
      } else if (x.signal) {
        const sc = x.signal === 'buy' ? 'bull' : x.signal === 'avoid' ? 'bear' : 'flat';
        sigHtml = '<div class="s ' + sc + '">' + (sigLabel[x.signal] || x.signal) + '（阈值 ' + x.threshold + '，样本外胜率 ' + (x.thresholdWinRate == null ? '--' : (x.thresholdWinRate * 100).toFixed(0) + '%') + '）</div>';
      }
      if (x.smoothWindow > 1 && x.upProbUnsmooth != null && x.upProbUnsmooth !== x.upProb) {
        sigHtml += '<div class="s muted">已用 EMA' + x.smoothWindow + ' 平滑：未平滑 ' + x.upProbUnsmooth + '% → ' + x.upProb + '%</div>';
      }
      return '<div class="pr-card"><div class="n">' + nm[k] + '</div>' +
        '<div class="v ' + cls + '">' + arrow(x.dir) + ' ' + x.dir + '</div>' +
        '<div class="s">预期 ' + (x.expectedChg >= 0 ? '+' : '') + x.expectedChg + '% → ' + fmtPrice(x.expectedPrice) + '</div>' +
        probHtml +
        '<div class="s">高点 ' + fmtPrice(x.priceHigh) + ' / 低点 ' + fmtPrice(x.priceLow) + '</div>' + sigHtml + '</div>';
    }).join('');
    const live = p.live || r.live;
    let summaryHtml = '<div class="pr-summary">综合（未来1周）：' + arrow(p.summary.dir) + p.summary.dir + '，<b>可信上涨概率 ' + p.summary.upProb + '%</b>' +
      (p.summary.upProbRaw != null && p.summary.upProbRaw !== p.summary.upProb ? '（模型原始 ' + p.summary.upProbRaw + '%）' : '') +
      '<br/><span class="muted">' + (p.summary.keySignals || []).join(' · ') + '</span>';
    if (live && live.ok) {
      const M = live.model || {};
      const tp = M.tradingPolicy && M.tradingPolicy.thresholds ? M.tradingPolicy.thresholds : {};
      summaryHtml += '<br/><span class="muted">市场状态 ' + live.regime + '　·　Hedge 学习器：' + (M.experts || '--') + ' 专家 / ' + (M.universeSize || '--') + ' 标的 / ' + (M.samples || 0).toLocaleString() + ' 样本　·　损失函数 ' + (M.lossType || '--') + '　·　概率标定 ' + (M.calibrated ? '已启用' : '未启用') + '</span>';
      const contrib = (live.contributions || []).slice(0, 6);
      if (contrib.length) {
        summaryHtml += '<br/><span class="muted">主导专家：' + contrib.map((c) => c.label + (c.contribution > 0 ? ' +' : ' ') + c.contribution).join('　') + '</span>';
      }
      summaryHtml += '<br/><span class="muted">实盘阈值（拟合集含费期望最优）：' + ['d1', 'd3', 'w1', 'm1'].filter((k) => tp[k]).map((k) => nm[k] + ' ' + tp[k].threshold + (tp[k].winRate != null ? '（胜率 ' + (tp[k].winRate * 100).toFixed(0) + '%）' : '')).join('　') + '</span>';
    }
    summaryHtml += '</div>';
    // 多周期共振信号（回测里胜率最高的下单方式）
    const conf = live && live.confluence;
    if (conf) {
      const bt = conf.backtest || {};
      const items = (conf.met || []).map((m) =>
        '<span class="' + (m.pass ? 'bull' : 'flat') + '" style="margin-right:10px">' + m.label + ' ' + m.upProb + '%' + (m.pass ? ' ✓' : ' ✗') + '（阈值 ' + (m.threshold * 100).toFixed(0) + '%）</span>').join('');
      summaryHtml += '<div class="pr-summary" style="border-top:1px dashed var(--border);margin-top:6px;padding-top:6px">' +
        '<b>多周期共振</b> ' + (conf.allPass ? '<span class="bull">✅ 三周期全部达标 —— 可执行买入</span>' : '<span class="flat">⏸ 未全部达标 —— 继续观望</span>') +
        '<br/>' + items +
        '<br/><span class="muted">回测（含费）：验证 ' + (bt.valWinRate == null ? '--' : (bt.valWinRate * 100).toFixed(1) + '%') + '（' + (bt.valTrades || 0) + '笔）　测试 <b>' + (bt.testWinRate == null ? '--' : (bt.testWinRate * 100).toFixed(1) + '%') + '</b>（' + (bt.testTrades || 0) + '笔，单笔 ' + (bt.testExpectancy == null ? '--' : bt.testExpectancy + '%') + '）</span>' +
        '</div>';
    }
    if (el) el.innerHTML = cardsHtml + summaryHtml;
    if (elCards) elCards.innerHTML = cardsHtml + summaryHtml;
    const pn = $('#predictName');
    if (pn) pn.textContent = r.name + ' (' + r.code + ')';
    renderPredictChart();
    renderPredictLink();
  }

  function renderPredictChart() {
    const dom = $('#predictChart');
    if (!window.echarts || !predictData || !predictData.prediction || !predictData.prediction.path) return;
    const p = predictData.prediction;
    const path = p.path, labels = path.map((x) => x.label), prices = path.map((x) => x.price);
    const cur = predictData.price;
    const old = window.echarts.getInstanceByDom(dom);
    if (old) old.dispose();
    const chart = echarts.init(dom);
    App.charts.predict = chart;
    const horizonMark = [
      { coord: ['T+1', p.d1.expectedPrice], value: 'T+1 ' + (p.d1.expectedChg >= 0 ? '+' : '') + p.d1.expectedChg + '%', itemStyle: { color: '#f59e0b' } },
      { coord: ['T+3', p.d3.expectedPrice], value: 'T+3 ' + (p.d3.expectedChg >= 0 ? '+' : '') + p.d3.expectedChg + '%', itemStyle: { color: '#f59e0b' } },
      { coord: ['T+5', p.w1.expectedPrice], value: 'T+5 ' + (p.w1.expectedChg >= 0 ? '+' : '') + p.w1.expectedChg + '%', itemStyle: { color: '#a855f7' } },
      { coord: ['T+22', p.m1.expectedPrice], value: 'T+22 ' + (p.m1.expectedChg >= 0 ? '+' : '') + p.m1.expectedChg + '%', itemStyle: { color: '#22d3ee' } },
    ];
    // 置信区间带：按各周期 rangePct 插值（T+1≈d1、T+3≈d3、T+5≈w1、T+22≈m1）
    const bandAnchors = [
      { d: 0, pct: 0 },
      { d: 1, pct: p.d1.rangePct },
      { d: 3, pct: p.d3.rangePct },
      { d: 5, pct: p.w1.rangePct },
      { d: 22, pct: p.m1.rangePct },
    ];
    const bandPct = prices.map((pr, idx) => {
      const day = idx + 1;
      let lo = bandAnchors[0], hi = bandAnchors[bandAnchors.length - 1];
      for (let i = 0; i < bandAnchors.length - 1; i++) {
        if (day >= bandAnchors[i].d && day <= bandAnchors[i + 1].d) { lo = bandAnchors[i]; hi = bandAnchors[i + 1]; break; }
      }
      const t = (day - lo.d) / Math.max(1, hi.d - lo.d);
      return lo.pct + (hi.pct - lo.pct) * t;
    });
    const lower = prices.map((pr, i) => +(pr * (1 - bandPct[i] / 100)).toFixed(3));
    const upper = prices.map((pr, i) => +(pr * (1 + bandPct[i] / 100)).toFixed(3));
    chart.setOption({
      backgroundColor: 'transparent', animation: false,
      tooltip: { trigger: 'axis', backgroundColor: '#ffffff', borderColor: '#e2e8f0', textStyle: { color: '#1e293b' }, formatter: function (ps) { const i = ps[0].dataIndex; return '<b>' + labels[i] + '</b><br/>预期价 ' + fmtPrice(prices[i]) + '（' + (path[i].chg >= 0 ? '+' : '') + path[i].chg + '%）<br/>置信区间 ' + fmtPrice(lower[i]) + ' ~ ' + fmtPrice(upper[i]) + '（±' + (+bandPct[i].toFixed(1)) + '%）'; } },
      grid: { left: 60, right: 20, top: 30, bottom: 30 },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: '#64748b', fontSize: 10, interval: 2 } },
      yAxis: { scale: true, axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } },
      graphic: [{ type: 'text', right: 12, top: 4, style: { text: '当前 ' + fmtPrice(cur) + ' · 阴影=置信区间', fill: '#64748b', fontSize: 11 } }],
      legend: { top: 0, left: 8, textStyle: { color: '#64748b', fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
      series: [
        // 置信区间带：填充 + 上下沿虚线边界（更清晰）
        { name: '置信区间', type: 'line', data: lower, stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(59,130,246,.20)' }, silent: true, tooltip: { show: false } },
        { name: '', type: 'line', data: upper.map((u, i) => +(u - lower[i]).toFixed(3)), stack: 'band', symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(59,130,246,.20)' }, silent: true, tooltip: { show: false } },
        { name: '区间上沿', type: 'line', data: upper, symbol: 'none', lineStyle: { width: 1, color: 'rgba(96,165,250,.7)', type: 'dashed' }, silent: true, tooltip: { show: false } },
        { name: '区间下沿', type: 'line', data: lower, symbol: 'none', lineStyle: { width: 1, color: 'rgba(96,165,250,.7)', type: 'dashed' }, silent: true, tooltip: { show: false } },
        { name: '预期走势', type: 'line', data: prices, symbol: 'circle', symbolSize: 4, lineStyle: { width: 2.5, color: '#3b82f6' }, markPoint: { data: horizonMark, label: { fontSize: 10, color: '#1e293b' }, symbol: 'circle', symbolSize: 8 } },
        { name: '当前价', type: 'line', data: labels.map(() => cur), symbol: 'none', lineStyle: { width: 1, color: '#64748b', type: 'dashed' } },
      ],
    }, true);
  }

  function renderPredictLink() {
    if (!predictData || !predictData.prediction) return;
    const w1 = predictData.prediction.w1;
    const arrow = (d) => (d === '看涨' ? '↑' : d === '看跌' ? '↓' : '→');
    const linkHtml = '<div class="pl-row">未来1周预测：<b>' + arrow(w1.dir) + ' ' + w1.dir + '</b>（上涨概率 ' + w1.upProb + '% / 下跌概率 ' + (100 - w1.upProb) + '%）</div>' +
      (w1.dir === '看跌'
        ? '<div class="pl-row warn">⚠ 预测看跌：建议下调仓位、今日买入暂缓、逢高减仓（操作建议已按预测下调）</div>'
        : w1.dir === '看涨'
          ? '<div class="pl-row good">✅ 预测看涨：可逢低布局，按目标仓位执行</div>'
          : '<div class="pl-row">预测震荡：按技术面信号执行</div>');
    const el1 = $('#predictStrategyLink'), el2 = $('#sPredictLink');
    if (el1) el1.innerHTML = linkHtml;
    if (el2) el2.innerHTML = linkHtml;
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
    // 分时模式：即使日K缺失，也渲染分时图
    if (!App.klines.length) {
      if (App.period === 'minute' && (App.minute || []).length) { renderChart(); return; }
      renderEmpty(); return;
    }
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

    // 预测联动：用未来1周预测调整操作建议
    let ins = App.instruction;
    if (ins && predictData && predictData.prediction) {
      ins = Engine.applyPrediction(ins, predictData.prediction);
    }
    renderPredictLink();

    if (ins) {
      $('#sPositionPanel').innerHTML =
        '<div class="pos-bar"><div class="fill" style="width:' + ins.targetPct + '%"></div></div>' +
        '<div class="pos-row"><span class="lbl">当前仓位</span><span class="val">' + ins.currentPct + '%</span></div>' +
        '<div class="pos-row"><span class="lbl">目标仓位</span><span class="val" style="color:' + a.color + '">' + ins.targetPct + '%</span></div>' +
        '<div class="pos-row"><span class="lbl">需调整</span><span class="val ' + dirClass(ins.deltaShares) + '">' + signed(ins.deltaShares, 0) + ' 份</span></div>' +
        '<div class="pos-row"><span class="lbl">每份资金</span><span class="val">' + fmt(ins.lotValue, 0) + ' 元</span></div>' +
        '<div class="pos-row"><span class="lbl">资金份数</span><span class="val">' + ins.lots + ' 份</span></div>';
    }

    if (ins) {
      let html = (ins.predictionNote ? '<div class="pl-row ' + (ins.prediction && ins.prediction.dir === '看跌' ? 'warn' : 'good') + '">' + ins.predictionNote + '</div>' : '') +
        '<div class="action-badge ' + ins.side + '">' + ins.action + (ins.side === 'buy' ? '（做多）' : ins.side === 'sell' ? '（减仓/做空）' : '（观望）') + '</div>';

      if (ins.side === 'buy') {
        html += '<div style="margin:8px 0">目标仓位 <b>' + ins.targetPct + '%</b>，需加仓 <b>' + fmt(ins.deltaShares, 0) + ' 份</b>（约 ' + fmt(ins.deltaValue, 0) + ' 元）。建议分 3 批执行：</div>';
        html += '<ol class="steps">' + (ins.tranches || []).map((t) => '<li>第 ' + t.step + ' 批：' + fmt(t.shares, 0) + ' 份（约 ' + fmt(t.amount, 0) + ' 元）—— ' + t.note + '</li>').join('') + '</ol>';
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
        const q = code === App.code ? App.quote : App.otherQuotes[code];
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
        '<tr><td>' + new Date(t.time).toLocaleString('zh-CN') + '</td><td class="' + t.side + '">' + (t.side === 'buy' ? '买入' : '卖出') + '</td><td>' + (t.name || t.code || '--') + '</td><td>' + fmtPrice(t.price) + '</td><td>' + fmt(t.shares, 0) + '</td><td>' + fmt(t.amount, 0) + '</td><td>' + fmt(t.fee, 2) + '</td></tr>'
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
        style: { text: maText(lastIdx), fill: '#64748b', fontSize: 11, fontWeight: 'bold' },
      }],
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', crossStyle: { color: MUTED } },
        backgroundColor: '#ffffff', borderColor: '#e2e8f0', textStyle: { color: '#1e293b', fontSize: 12 },
        formatter: function (params) {
          const idx = params[0].dataIndex; const kk = k[idx]; if (!kk) return '';
          const pct = kk.open ? (kk.close - kk.open) / kk.open * 100 : 0;
          return '<b>' + kk.date + '</b><br/>开 ' + fmtPrice(kk.open) + ' 高 ' + fmtPrice(kk.high) + '<br/>低 ' + fmtPrice(kk.low) + ' 收 ' + fmtPrice(kk.close) +
            '<br/>涨跌 ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%' +
            '<br/>MA5 ' + maVal(ind.ma5, idx) + ' · MA10 ' + maVal(ind.ma10, idx) + ' · MA20 ' + maVal(ind.ma20, idx) + ' · MA60 ' + maVal(ind.ma60, idx) +
            '<br/>量 ' + fmt(kk.volume / 10000, 1) + ' 万手';
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: '#1e293b' } },
      grid: [
        { left: 62, right: 18, top: 24, height: '36%' },
        { left: 62, right: 18, top: '47%', height: '11%' },
        { left: 62, right: 18, top: '61%', height: '13%' },
        { left: 62, right: 18, top: '77%', height: '14%' },
      ],
      xAxis: [0, 1, 2, 3].map((i) => ({
        type: 'category', data: dates, gridIndex: i, boundaryGap: true,
        axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { show: i === 3, color: MUTED, fontSize: 10 },
        axisTick: { show: false }, splitLine: { show: false },
      })),
      yAxis: [
        // 主图价格轴：十字光标随动，轴上显示当前价
        { scale: true, gridIndex: 0, position: 'left', axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } }, axisPointer: { label: { show: true, backgroundColor: '#1e293b', color: '#fff', formatter: (p) => fmtPrice(p.value) } } },
        { scale: true, gridIndex: 1, position: 'left', axisLabel: { show: false }, splitLine: { show: false } },
        { scale: true, gridIndex: 2, position: 'left', axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } },
        { scale: true, gridIndex: 3, position: 'left', min: 0, max: 100, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } },
      ],
      dataZoom: [
        // 默认显示最近 120 根（券商日K习惯），蜡烛更粗、波动更明显
        { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: Math.max(0, 100 - (App.period === 'week' ? 100 : 120) * 100 / dates.length), end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2, 3], top: '93%', height: 16, borderColor: '#e2e8f0', backgroundColor: '#ffffff', fillerColor: 'rgba(59,130,246,.15)', textStyle: { color: MUTED, fontSize: 10 } },
      ],
      series: [
        { name: (App.codeName || App.code), type: 'candlestick', data: ohlc, xAxisIndex: 0, yAxisIndex: 0, itemStyle: { color: RED, color0: GREEN, borderColor: RED, borderColor0: GREEN } },
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
      tooltip: { trigger: 'axis', backgroundColor: '#ffffff', borderColor: '#e2e8f0', textStyle: { color: '#1e293b' }, formatter: function (ps) { const i = ps[0].dataIndex; const pct = pctOf(prices[i]); return '<b>' + times[i] + '</b><br/>价 ' + fmtPrice(prices[i]) + '（' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%）<br/>均价 ' + fmtPrice(avg[i]) + '<br/>昨收 ' + fmtPrice(prevClose); } },
      grid: [{ left: 62, right: 56, top: 24, height: '68%' }, { left: 62, right: 18, top: '80%', height: '12%' }],
      xAxis: [
        { type: 'category', data: times, gridIndex: 0, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: MUTED, fontSize: 10 }, boundaryGap: false },
        { type: 'category', data: times, gridIndex: 1, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { show: false }, boundaryGap: false },
      ],
      yAxis: [
        { gridIndex: 0, position: 'left', min: yMin, max: yMax, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } },
        // 右侧涨跌幅刻度
        { gridIndex: 0, position: 'right', min: yMinPct, max: yMaxPct, axisLabel: { color: MUTED, fontSize: 10, formatter: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%' }, splitLine: { show: false }, axisLine: { lineStyle: { color: '#e2e8f0' } } },
        { gridIndex: 1, position: 'left', axisLabel: { show: false }, splitLine: { show: false } },
      ],
      series: [
        { name: '价格', type: 'line', data: priceData, xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1.4 }, areaStyle: { color: 'rgba(59,130,246,.08)' } },
        { name: '均价', type: 'line', data: avg, xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1, color: '#f59e0b' } },
        { name: '昨收', type: 'line', data: pts.map(() => prevClose), xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1, color: '#64748b', type: 'dashed' } },
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
      tooltip: { trigger: 'axis', backgroundColor: '#ffffff', borderColor: '#e2e8f0', textStyle: { color: '#1e293b' } },
      grid: { left: 40, right: 10, top: 10, bottom: 22 },
      xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#e2e8f0' } }, axisLabel: { color: MUTED, fontSize: 10 } },
      yAxis: { scale: true, axisLabel: { color: MUTED, fontSize: 10 }, splitLine: { lineStyle: { color: '#eef2f7' } } },
      series: [
        { name: '收盘', type: 'line', data: closes, symbol: 'none', lineStyle: { width: 1.5, color: ACCENT }, areaStyle: { color: 'rgba(59,130,246,.12)' } },
        { name: 'MA5', type: 'line', data: ma5, symbol: 'none', lineStyle: { width: 1, color: AMBER } },
      ],
    }, true);
  }

  // ---------- 数据源健康 ----------
  async function loadHealth(probe) {
    const el = $('#healthPanel');
    if (!el) return;
    if (probe) el.innerHTML = '正在探测全部数据源（约 3~6 秒）…';
    try {
      const r = await api('/api/health' + (probe ? '?probe=1' : ''));
      renderHealth(r);
    } catch (e) {
      el.innerHTML = '<span style="color:#c0392b">健康检查失败：' + e.message + '</span>';
    }
  }

  function renderHealth(r) {
    const el = $('#healthPanel');
    if (!el) return;
    const st = { ok: ['✅', '#1a7f37', '正常'], degraded: ['⚠️', '#bf8700', '降级'], down: ['❌', '#b91c1c', '不可用'], unknown: ['❔', '#64748b', '未测'] };
    let h = '';
    if (r.build) {
      // 构建指纹：用来确认公网跑的是不是最新那版代码（以前只能靠"新功能像不像上线"间接推断）
      const b = r.build;
      h += '<div class="muted" style="margin-bottom:8px">运行版本 <b>' + (b.commit || '未知') + '</b>' +
        ' · ' + (b.provider || '-') +
        ' · 启动于 ' + (b.startedAt ? new Date(b.startedAt).toLocaleString('zh-CN') : '-') + '</div>';
    }
    if (r.probe && r.probe.items) {
      h += '<div class="rl-title">主动探测结果 <span class="muted">耗时 ' + r.probe.ms + ' ms</span></div>';
      h += '<table class="data-table compact"><thead><tr><th>数据源</th><th>结果</th><th>错误</th></tr></thead><tbody>';
      r.probe.items.forEach((x) => {
        h += '<tr><td>' + x.name + '</td><td>' + (x.ok ? '<span style="color:#1a7f37">✅ 可用</span>' : '<span style="color:#b91c1c">❌ 失败</span>') + '</td><td class="muted">' + (x.error || '') + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    const keys = Object.keys(r.health || {});
    if (keys.length) {
      h += '<div class="rl-title" style="margin-top:10px">本次运行累计 <span class="muted">（进程内统计，重启清零）</span></div>';
      h += '<table class="data-table compact"><thead><tr><th>数据源</th><th>状态</th><th>成功/失败</th><th>成功率</th><th>最近错误</th></tr></thead><tbody>';
      const order = { down: 0, degraded: 1, unknown: 2, ok: 3 };
      keys.sort((a, b) => (order[r.health[a].status] - order[r.health[b].status]));
      keys.forEach((k) => {
        const x = r.health[k];
        const m = st[x.status] || st.unknown;
        h += '<tr><td>' + (x.note ? x.name + ' <span class="muted">(' + x.note + ')</span>' : x.name) + '</td>' +
          '<td><span style="color:' + m[1] + '">' + m[0] + ' ' + m[2] + '</span></td>' +
          '<td>' + x.ok + ' / ' + x.fail + '</td>' +
          '<td>' + (x.successRate == null ? '--' : (x.successRate * 100).toFixed(0) + '%') + '</td>' +
          '<td class="muted">' + ((x.lastErr || '').slice(0, 60)) + '</td></tr>';
      });
      h += '</tbody></table>';
    }
    const down = keys.filter((k) => r.health[k].status === 'down');
    if (down.length) {
      h += '<div class="warn-box">⚠️ <b>' + down.length + ' 个数据源不可用</b>：' + down.map((k) => r.health[k].name).join('、') +
        '<br/>系统已自动回退到备用源（见上方"备用"标注）。回退期间数据口径可能不同（如不复权、T-1），结论可信度相应下降。</div>';
    }
    el.innerHTML = h;
  }

  // ---------- 今日行动卡（池级合成结论）----------
  var actionData = null;

  async function loadActionCard() {
    const el = $('#actionCard');
    if (!el) return;
    try {
      const r = await api('/api/action');
      actionData = r;
      renderActionCard();
    } catch (e) {
      el.innerHTML = '<span style="color:#c0392b">行动卡加载失败：' + e.message + '</span>';
    }
  }

  function renderActionCard() {
    const el = $('#actionCard');
    if (!el || !actionData || !actionData.ok) return;
    const a = actionData;
    const vc = a.verdict === '建仓' ? 'bull' : (a.verdict === '减仓' ? 'bear' : 'flat');
    const icon = a.verdict === '建仓' ? '🟢' : a.verdict === '减仓' ? '🔴' : (a.verdict === '持有' ? '🔵' : '⏸');
    let h = '';
    // 一行结论
    h += '<div class="ac-verdict ' + vc + '">' + icon + ' <b>' + a.verdict + '</b>' +
         '<span class="ac-reason">' + (a.reason || '') + '</span></div>';
    // 关键三问
    h += '<div class="ac-meta">' +
      '<span>操作频率 <b>' + ({ monthly: '月度', weekly: '周度', daily: '日度' }[a.operatingMode] || a.operatingMode) + '</b></span>' +
      '<span>信号平滑 <b>EMA' + a.smoothWindow + '</b></span>' +
      '<span>下次复查 <b>' + a.nextReviewDate + '</b></span>' +
      '</div>';
    // 门禁
    h += '<div class="ac-checks">' + (a.checks || []).map((c) =>
      '<span class="' + (c.pass ? 'ok' : 'bad') + '">' + (c.pass ? '✅' : '❌') + ' ' + c.item + '：' + c.detail + '</span>').join('') + '</div>';
    // 持仓
    if (a.positions && a.positions.length) {
      h += '<table class="data-table compact"><thead><tr><th>持仓</th><th>份额</th><th>成本</th><th>现价</th><th>浮动</th></tr></thead><tbody>';
      a.positions.forEach((p) => {
        h += '<tr><td>' + p.name + '</td><td>' + p.shares + '</td><td>' + p.avgCost + '</td><td>' + p.price + '</td><td class="' + (p.pnlPct >= 0 ? 'bull' : 'bear') + '">' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct + '%</td></tr>';
      });
      h += '</tbody></table>';
    } else {
      h += '<div class="muted">当前空仓</div>';
    }
    // 候选表
    h += '<table class="data-table compact"><thead><tr><th>动量排名</th><th>标的</th><th>20日动量</th><th>1周可信</th><th>1月可信</th><th>共振+门槛</th><th>信号</th></tr></thead><tbody>';
    (a.candidates || []).slice(0, 8).forEach((c) => {
      const g = c.gatePass === true ? '✅ 通过' : (c.gatePass === false ? '✗ 未过' : '--');
      // 停牌提示：模型的「20日动量」是按K线根数算的，停牌期间无K线，
      // 会把 40+ 个自然日的涨幅压缩成「20日」，读数被严重放大（有研硅 +63.97% vs 真实 +12.55%）。
      const sus = c.suspendDays
        ? ' <span class="ac-sus" title="' + (c.suspendFrom || '') + '→' + (c.suspendTo || '') + ' 停牌，模型按相邻交易日处理，指标失真">⚠️停牌' + c.suspendDays + '日' +
          (c.mom20cal != null && c.mom20 != null ? '，真实20日 ' + (c.mom20cal >= 0 ? '+' : '') + c.mom20cal + '%' : '') + '</span>'
        : '';
      h += '<tr' + (c.gatePass ? ' class="ac-hit"' : '') + ' data-code="' + c.code + '" data-name="' + (c.name || c.code) + '" title="点击切换查看 ' + (c.name || c.code) + '" style="cursor:pointer"><td>' + c.momRank + '</td><td>' + c.name + (c.held ? ' <span class="muted">(持仓)</span>' : '') + sus + '</td><td>' + (c.mom20 >= 0 ? '+' : '') + c.mom20 + '%</td><td>' + c.pW1 + '%</td><td>' + c.pM1 + '%</td><td>' + g + '</td><td>' + (c.w1Signal === 'buy' ? '✅买入' : c.w1Signal === 'avoid' ? '⛔回避' : '⏸观望') + '</td></tr>';
    });
    h += '</tbody></table>';
    h += '<div class="warn-box">⚠️ 证据等级：' + a.evidenceLevel + '<br/>' +
         '阈值：3天 ' + (a.thresholds.d3 || '--') + ' · 1周 ' + (a.thresholds.w1 || '--') + ' · 1月 ' + (a.thresholds.m1 || '--') +
         '　｜　<b>1天周期已降级为「参考」</b>（方向 51.3% 低于朴素基准 51.6%，无边际）</div>';
    el.innerHTML = h;
  }

  // ---------- 研究台账 ----------
  var ledgerData = null, rlData = null;

  function pct(v, d) { return v == null ? '--' : (v * 100).toFixed(d === undefined ? 1 : d) + '%'; }

  async function loadLedger() {
    $('#ledgerSummary').innerHTML = '加载中…';
    try {
      const [lg, rl] = await Promise.all([api('/api/ledger'), api('/api/rl')]);
      ledgerData = lg; rlData = rl;
      renderLedger();
    } catch (e) {
      $('#ledgerSummary').innerHTML = '<span style="color:#c0392b">台账加载失败：' + e.message + '</span>';
    }
  }

  function renderLedger() {
    if (!ledgerData) return;
    const st = ledgerData.stats || {};
    const gradeName = { A: 'A级·硬数据', B: 'B级·量化衍生', C: 'C级·二手转述', D: 'D级·模型推断', E: 'E级·主观叙事' };
    const gradeColor = { A: '#1a7f37', B: '#2f81f7', C: '#bf8700', D: '#c2410c', E: '#b91c1c' };

    // 总览
    const rows = [
      ['条目总数', st.totalEntries + ' 条'],
      ['已结算 / 部分 / 待结算', st.resolvedEntries + ' / ' + st.partialEntries + ' / ' + st.openEntries],
      ['可判定预测', st.scoredOutcomes + ' 个（来自 ' + (st.distinctDates || '--') + ' 个到期日、' + (st.distinctCodes || '--') + ' 个标的）'],
      ['方向命中率', st.scoredOutcomes ? pct(st.hitRate) : '尚无到期样本'],
      ['Brier 分数', st.scoredOutcomes ? String(st.brier) + '（0.25 = 与"永远猜50%"持平）' : '--'],
      ['平均奖励', st.scoredOutcomes ? String(st.reward) : '--'],
      ['区间命中率', st.scoredOutcomes ? pct(st.rangeHitRate) : '--'],
    ];
    let html = '<table class="kv-table">' + rows.map((r) =>
      '<tr><th>' + r[0] + '</th><td>' + r[1] + '</td></tr>').join('') + '</table>';
    if (st.overconfidenceCount) {
      html += '<div class="warn-box">⚠️ 有 ' + st.overconfidenceCount + ' 条结论的<b>置信度超过了证据能支撑的上限</b>（台账中已自动标注），这是"防止言之凿凿却不靠谱"的机制。</div>';
    }
    if (!st.scoredOutcomes) {
      html += '<div class="warn-box">⚠️ 目前<b>还没有到期可判定的预测</b>。这正是台账存在的意义：在真实结果出来之前，任何"准确率"说法都是空话。周/月周期的预测需要时间兑现。</div>';
    }
    if (st.correlationWarning) {
      html += '<div class="warn-box">' + st.correlationWarning + '</div>';
    }
    html += '<div class="muted">' + (st.baselineNote || '') + '</div>';
    $('#ledgerSummary').innerHTML = html;

    // 证据分层
    const bg = st.byGrade || {};
    const keys = ['A', 'B', 'C', 'D', 'E'].filter((g) => bg[g]);
    $('#ledgerGrades').innerHTML = keys.length ? '<table class="data-table"><thead><tr><th>主要依据等级</th><th>条目</th><th>样本</th><th>方向命中率</th><th>Brier</th></tr></thead><tbody>' +
      keys.map((g) => '<tr><td><span class="grade-badge" style="background:' + gradeColor[g] + '">' + gradeName[g] + '</span></td><td>' + bg[g].entries + '</td><td>' + bg[g].n + '</td><td>' + pct(bg[g].hitRate) + '</td><td>' + (bg[g].brier == null ? '--' : bg[g].brier) + '</td></tr>').join('') +
      '</tbody></table><div class="muted">这张表回答：<b>靠新闻(C级)得出的结论，是不是比靠数据(A/B级)得出的结论更不准？</b>样本积累后会用真实结果说话。</div>'
      : '<div class="muted">样本不足</div>';

    // 策略采纳状态（P1：明确区分"生效"与"评估未采纳"）
    if (rlData && rlData.meta && rlData.meta.tradingPolicy) {
      const tp = rlData.meta.tradingPolicy;
      let ph = '<div class="rl-title">策略采纳状态 <span class="muted">唯一生效来源是「已生效」；其余为评估记录，不接入实盘</span></div>';
      ph += '<table class="data-table compact"><thead><tr><th>策略</th><th>是否生效</th><th>验证表现</th><th>测试表现</th><th>未采纳原因</th></tr></thead><tbody>';
      const d = tp.decided || {};
      const ths = d.thresholds || {};
      ph += '<tr><td><b>阈值策略</b>（d3/w1/m1：' + ['d3', 'w1', 'm1'].map((k) => ths[k] ? ths[k].threshold : '--').join(' / ') + '）</td>' +
        '<td><b style="color:#1a7f37">✅ 已生效</b></td><td>' + (d.basis || '--') + '</td><td>--</td><td>--</td></tr>';
      const ev = tp.evaluated || {};
      Object.keys(ev).forEach((k) => {
        const e = ev[k];
        const nm = { timingPolicy: '择时退出', rotationWeight: '轮动权重 w', chosenStrategy: '选优策略' }[k] || k;
        const v = e.valCalmar != null ? ('Calmar ' + e.valCalmar) : (e.valExpectancy != null ? ('期望 ' + e.valExpectancy + '%') : '--');
        const t = e.testCalmar != null ? ('Calmar ' + e.testCalmar) : (e.testReturn != null ? ('收益 ' + e.testReturn + '%') : '--');
        ph += '<tr><td>' + nm + (e.name ? '<span class="muted"> ' + e.name + '</span>' : '') + '</td>' +
          '<td style="color:#b91c1c">❌ 未采纳</td><td>' + v + '</td><td>' + t + '</td><td class="muted">' + (e.rejectReason || '--') + '</td></tr>';
      });
      ph += '</tbody></table>';
      ph += '<div class="muted">操作频率 <b>' + (tp.operatingMode || '--') + '</b>　信号平滑 <b>EMA' + (tp.signalSmoothing || 1) + '</b></div>';
      $('#rlPanel').insertAdjacentHTML('afterbegin', ph);
    }

    // RL 权重
    if (rlData && rlData.horizons) {
      const meta = rlData.meta || {};
      const rep = rlData.report || {};
      let h = '<div class="muted">Hedge 在线学习 · 学习率 η=' + meta.eta + ' · 遗忘因子 γ=' + meta.discount + ' · 权重下限=' + meta.floor + ' · 已学习 ' + (meta.rounds || 0) + ' 轮</div>';
      const cfg = rep.config || {};
      if (cfg.universeSize) {
        h += '<div class="muted">训练配置：<b>' + cfg.universeSize + ' 个标的</b> · 平均 ' + cfg.avgBars + ' 根日K · <b>' + cfg.experts + ' 个专家</b> · 海外序列 ' + (cfg.yahoo || []).join('/') + '（滞后1日） · 损失函数 <b>' + cfg.lossType + '</b> · η=' + cfg.eta + ' · 训练 ' + (cfg.trainSamples + cfg.valSamples).toLocaleString() + ' / 测试 ' + cfg.testSamples.toLocaleString() + ' 样本</div>';
      }
      if (rep.learnedTest) {
        h += '<div class="rl-title" style="margin-top:10px">① 样本外方向准确率（测试集）</div>';
        h += '<table class="data-table"><thead><tr><th>周期</th><th>朴素基准</th><th>手工权重</th><th>学习后(样本外)</th><th>Brier</th></tr></thead><tbody>';
        ['d1', 'd3', 'w1', 'm1'].forEach((k) => {
          const lab = (rlData.horizons[k] || {}).label || k;
          const nv = (rep.naiveTest || {})[k] || {}, pr = (rep.priorTest || {})[k] || {}, le = rep.learnedTest[k] || {};
          const gain = (le.hitRate != null && pr.hitRate != null) ? (le.hitRate - pr.hitRate) * 100 : null;
          h += '<tr><td>' + lab + '</td><td>' + pct(nv.hitRate) + '</td><td>' + pct(pr.hitRate) + '</td><td><b>' + pct(le.hitRate) + '</b>' + (gain != null && gain > 0 ? ' <span style="color:#1a7f37">+' + gain.toFixed(1) + 'pt</span>' : '') + '</td><td>' + le.brier + '</td></tr>';
        });
        h += '</tbody></table>';
      }
      if (rep.tradingTest && rep.chosenThreshold) {
        h += '<div class="rl-title" style="margin-top:12px">② 含费实盘回测（测试集）—— 这才是"胜率"</div>';
        h += '<table class="data-table"><thead><tr><th>周期</th><th>阈值</th><th>交易数</th><th>胜率</th><th>单笔期望</th><th>单笔夏普</th><th>标的均值</th></tr></thead><tbody>';
        ['d1', 'd3', 'w1', 'm1'].forEach((k) => {
          const lab = (rlData.horizons[k] || {}).label || k;
          const list = rep.tradingTest[k] || [];
          const th = (rep.chosenThreshold || {})[k];
          const t = list.find((x) => x.threshold === th) || list[0] || {};
          const beat = (t.avgRetPct != null && t.baselineAvgPct != null && t.avgRetPct > t.baselineAvgPct);
          h += '<tr><td>' + lab + '</td><td>' + (t.threshold == null ? '--' : t.threshold) + '</td><td>' + (t.trades || 0) + '</td><td><b>' + pct(t.winRate) + '</b></td><td' + (beat ? ' style="color:#1a7f37"' : '') + '>' + (t.avgRetPct == null ? '--' : (t.avgRetPct > 0 ? '+' : '') + t.avgRetPct + '%') + '</td><td>' + (t.sharpe == null ? '--' : t.sharpe) + '</td><td>' + (t.baselineAvgPct == null ? '--' : t.baselineAvgPct + '%') + '</td></tr>';
        });
        h += '</tbody></table>';
        h += '<div class="muted">已计入双边费用（ETF 0.08% / 个股 0.18%）。阈值在<b>验证集</b>上按含费期望选出，此处为<b>测试集</b>复核。高阈值档位交易数少（百余笔），胜率会偏高，请结合"交易数"一起看。</div>';
      }
      if (rep.walkForward && rep.walkForward.length) {
        h += '<div class="rl-title" style="margin-top:12px">③ Walk-forward 滚动验证（最接近实盘）</div>';
        h += '<table class="data-table compact"><thead><tr><th>折</th><th>测试区间</th><th>训练样本</th><th>方向命中率</th></tr></thead><tbody>';
        let sum = 0;
        rep.walkForward.forEach((w) => {
          sum += w.hitRate;
          h += '<tr><td>' + w.fold + '</td><td>' + w.testStart + ' ~ ' + w.testEnd + '</td><td>' + w.trainN.toLocaleString() + '</td><td><b>' + pct(w.hitRate) + '</b></td></tr>';
        });
        h += '</tbody></table><div class="muted">平均 <b>' + pct(sum / rep.walkForward.length) + '</b>（' + rep.walkForward.length + ' 折）。各折有波动，说明优势不稳定 —— 不要按单次结果下注。</div>';
      }
      h += '<div class="warn-box">⚠️ 诚实边界：方向上有约 +2~6pt 的样本外优势，但<b>概率的技巧分仍 ≤ 0</b>（Brier ≈ 0.25），说明概率幅度本身不提供额外信息。系统已用 Platt 标定把"70%"压回可信区间，并只在超过阈值时才给买入信号。<b>优势很薄，必须靠止损和仓位控制，而不是靠预测。</b></div>';
      ['d1', 'd3', 'w1', 'm1'].forEach((k) => {
        const hz = rlData.horizons[k]; if (!hz) return;
        const cal = hz.calibration || {};
        h += '<div class="rl-block"><div class="rl-title">' + hz.label + '<span class="muted">　概率标定 a=' + cal.a + '（b 锁 0）' + (cal.a < 0.85 ? ' → 原始概率过度自信，需向 50% 收缩' : cal.a > 1.15 ? ' → 原始概率偏保守' : ' → 已基本标定') + '</span></div>';
        h += '<table class="data-table compact"><thead><tr><th>专家</th><th>手工先验</th><th>学到的权重</th><th>命中率</th><th>弃权率</th><th>Brier</th></tr></thead><tbody>';
        (hz.leaderboard || []).forEach((r) => {
          if (!r.trained && r.priorWeight < 0.02) return;
          const d = r.weight - r.priorWeight;
          const arrow = d > 0.02 ? '⬆️' : d < -0.02 ? '⬇️' : '';
          h += '<tr><td>' + r.label + (r.trained ? '' : ' <span class="muted">(保留先验)</span>') + '</td><td>' + pct(r.priorWeight) + '</td><td><b>' + pct(r.weight) + '</b> ' + arrow + '</td><td>' + pct(r.hitRate) + '</td><td>' + pct(r.abstainRate, 0) + '</td><td>' + (r.brier == null ? '--' : r.brier) + '</td></tr>';
        });
        h += '</tbody></table></div>';
      });
      $('#rlPanel').innerHTML = h;
    } else {
      $('#rlPanel').innerHTML = '<div class="muted">学习器尚未训练。请执行 <code>node train-rl.js</code></div>';
    }

    // 明细
    const list = (ledgerData.entries || []).slice().reverse();
    $('#ledgerList').innerHTML = list.map((e) => {
      const mix = e.evidenceMix || { counts: {} };
      const badges = ['A', 'B', 'C', 'D', 'E'].filter((g) => (mix.counts || {})[g]).map((g) =>
        '<span class="grade-badge" style="background:' + gradeColor[g] + '">' + g + '×' + mix.counts[g] + '</span>').join(' ');
      const sc = e.scores && e.scores.n ? '<b>' + e.scores.hits + '/' + e.scores.n + '</b>（' + pct(e.scores.hitRate, 0) + '）· Brier ' + e.scores.brier : '<span class="muted">待到期</span>';
      let out = '<div class="ledger-item">';
      out += '<div class="ledger-head"><span class="ledger-name">' + e.name + (e.code ? ' <span class="muted">' + e.code + '</span>' : '') + '</span>';
      out += '<span class="ledger-meta">' + e.anchorDate + ' @ ' + (e.anchorPrice == null ? '--' : e.anchorPrice) + '　' + badges + '</span></div>';
      out += '<div class="ledger-q">' + (e.question || '') + '</div>';
      out += '<div class="ledger-v">' + (e.verdict || '').replace(/\n/g, '<br>') + '</div>';
      out += '<div class="ledger-meta">立场 ' + e.stance + '　置信度 ' + pct(e.confidence, 0);
      if (e.overconfidence) out += ' <span style="color:#b91c1c">⚠️ 超出证据上限 ' + pct(e.confidenceCeiling, 0) + '（' + e.ceilingReason + '）</span>';
      out += '　结算 ' + sc + '</div>';
      if (e.outcomes && e.outcomes.length) {
        out += '<table class="data-table compact"><thead><tr><th>周期</th><th>预测</th><th>实际</th><th>涨跌</th><th>方向</th><th>来源</th></tr></thead><tbody>';
        e.outcomes.forEach((o) => {
          if (o.pending) { out += '<tr><td>' + o.horizonLabel + '</td><td colspan="4" class="muted">待兑现</td><td>' + (o.source || '') + '</td></tr>'; return; }
          out += '<tr><td>' + o.horizonLabel + '</td><td>' + o.predictedDir + '（' + o.upProb + '%）</td><td>' + o.actualDir + '</td><td>' + (o.actualPct > 0 ? '+' : '') + o.actualPct + '%</td><td>' + (o.dirHit ? '✅' : '❌') + '</td><td>' + (o.source === 'human-override' ? '<b>人工覆写</b>' : o.source) + '</td></tr>';
        });
        out += '</tbody></table>';
      }
      if (e.lessons) out += '<div class="ledger-lesson">💡 ' + e.lessons + '</div>';
      out += '</div>';
      return out;
    }).join('') || '<div class="muted">台账为空，请执行 node seed-ledger.js</div>';
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
    // 池内标的点击切换
    bindPoolClickSwitch();
    // 数据源健康：重新探测
    const pb = $('#probeBtn');
    if (pb) pb.addEventListener('click', () => loadHealth(true));
    // 标签页
    document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('#tab-' + b.dataset.tab).classList.add('active');
      if (b.dataset.tab === 'review') loadReviews();
      if (b.dataset.tab === 'ledger') { loadLedger(); loadHealth(false); }
      if (b.dataset.tab === 'predict') { if (predictData) renderPredictChart(); loadActionCard(); }
      if (b.dataset.tab === 'analysis') {
        // 重新渲染图表：修复标签页隐藏时初始化为 0 尺寸导致分时/K线不显示
        setTimeout(() => { renderChart(); if (App.charts.mini) App.charts.mini.resize(); }, 60);
      } else if (b.dataset.tab === 'strategy' || b.dataset.tab === 'trade') {
        setTimeout(() => { if (App.charts.main) App.charts.main.resize(); if (App.charts.mini) App.charts.mini.resize(); }, 50);
      }
      if (b.dataset.tab === 'predict') {
        setTimeout(() => { if (App.charts.predict) App.charts.predict.resize(); }, 50);
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
