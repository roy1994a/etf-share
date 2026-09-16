'use strict';
/**
 * lib/pool.js —— 自选资金池的**唯一事实来源**
 *
 * 为什么需要单独抽一层：
 * 在抽出本模块之前，"池子"在三处各写了一份，且已经漂移：
 *   - server.js      loadPool()          → 16 只（最新）
 *   - lib/auto-ledger poolCodes() 兜底   → 13 只（漏了有研硅/通富微电/浪潮信息）
 *   - monitor.js     defaultConfig()     → 11 只（含已不在池内的韦尔股份）
 * 后果：用户在网页上改池子，盯盘和台账却各按自己那份走 ——
 * "根据自选资金池变化自动更新"就无从谈起。
 *
 * 现在三处统一 require 本模块；改池子只有一条路径（savePool）。
 *
 * 优先级：环境变量 ETF_POOL > notify.config.json > DEFAULT_POOL
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'notify.config.json');

/**
 * 内置兜底池。
 * 说明：公网只读部署里 notify.config.json 被 .gitignore/.dockerignore 排除，
 * 若不内置就会退化成"空池"或陈旧池，因此这里保持与本地一致的最新名单。
 */
const DEFAULT_POOL = [
  { code: '159516', name: '半导体设备', type: 'etf' },
  { code: '512010', name: '医药', type: 'etf' },
  { code: '512400', name: '有色', type: 'etf' },
  { code: '512660', name: '军工', type: 'etf' },
  { code: '688981', name: '中芯国际', type: 'stock' },
  { code: '688012', name: '中微公司', type: 'stock' },
  { code: '002371', name: '北方华创', type: 'stock' },
  { code: '688256', name: '寒武纪', type: 'stock' },
  { code: '688041', name: '海光信息', type: 'stock' },
  { code: '603986', name: '兆易创新', type: 'stock' },
  { code: '688008', name: '澜起科技', type: 'stock' },
  { code: '688783', name: '西安奕材-U', type: 'stock' },
  { code: '300475', name: '香农芯创', type: 'stock' },
  { code: '688432', name: '有研硅', type: 'stock' },
  { code: '002156', name: '通富微电', type: 'stock' },
  { code: '000977', name: '浪潮信息', type: 'stock' },
];

/** 依据代码推断类型（1/5 开头为场内基金，其余按股票） */
function inferType(code) {
  const c = String(code);
  return (c[0] === '5' || c[0] === '1') ? 'etf' : 'stock';
}

function normalize(list) {
  const out = [];
  const seen = new Set();
  for (const it of (list || [])) {
    const code = String((it && it.code) || '').trim();
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: (it && it.name) || code, type: (it && it.type) || inferType(code) });
  }
  return out;
}

/**
 * 读取当前自选资金池（永远返回非空数组）。
 * @param {Object} [opts] { fresh:true 时跳过进程内缓存 }
 */
let _cache = null, _cacheAt = 0;
function loadPool(opts) {
  opts = opts || {};
  if (!opts.fresh && _cache && Date.now() - _cacheAt < 3000) return _cache.slice();

  let pool = null;
  // 1) 环境变量（公共部署用）
  if (process.env.ETF_POOL) {
    try {
      const p = normalize(JSON.parse(process.env.ETF_POOL));
      if (p.length) pool = p;
    } catch (e) { /* 忽略，继续降级 */ }
  }
  // 2) 本地配置
  if (!pool) {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        const p = normalize(cfg.etfPool);
        if (p.length) pool = p;
      }
    } catch (e) { /* 忽略，继续降级 */ }
  }
  // 3) 内置兜底
  if (!pool) pool = normalize(DEFAULT_POOL);

  _cache = pool; _cacheAt = Date.now();
  return pool.slice();
}

/** 写回自选资金池（本地配置）。公网只读部署不应调用。 */
function savePool(pool) {
  const clean = normalize(pool);
  const cfg = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  cfg.etfPool = clean;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  invalidate();
  return clean;
}

/** 池子变化后调用：让下一次 loadPool 重新读盘 */
function invalidate() { _cache = null; _cacheAt = 0; }

/** 加入一个标的（已存在则原样返回） */
function addToPool(entry) {
  const pool = loadPool({ fresh: true });
  const code = String((entry && entry.code) || '');
  if (!/^\d{6}$/.test(code)) throw new Error('代码需为 6 位数字：' + code);
  if (pool.some((x) => x.code === code)) return { pool, changed: false };
  pool.push({ code, name: (entry && entry.name) || code, type: (entry && entry.type) || inferType(code) });
  return { pool: savePool(pool), changed: true };
}

/** 移除一个标的 */
function removeFromPool(code) {
  const pool = loadPool({ fresh: true }).filter((x) => x.code !== String(code));
  return savePool(pool);
}

module.exports = {
  DEFAULT_POOL, CONFIG_FILE,
  loadPool, savePool, invalidate, addToPool, removeFromPool,
  normalize, inferType,
};
