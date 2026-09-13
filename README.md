# 多 ETF 动量轮动 · 智能交易模拟系统

零依赖（仅 Node 内置模块）的 ETF 交易模拟与盯盘工具集。行情来自腾讯行情（前复权日K + 实时 qt），支持**多 ETF 动量轮动**（半导体设备 / 医药 / 有色），策略引擎为 50 分基准的综合评分 + 目标仓位模型，融合六大维度：

1. **技术面**（MA/MACD/RSI/KDJ/BOLL/ATR/MFI）
2. **主力资金方向**（东财主力/超大单净流入、连续流入流出天数）
3. **市场情绪面**（赚钱效应指数、涨停/跌停家数、涨跌分布）
4. **消息面**（新闻标题关键词情感打分，含时间衰减）
5. **宏观利率**（美债10Y / 中债10Y：利率上行压制高久期成长股，含 52 周新高、20 日趋势）
6. **科技板块**（费半 SOX 隔夜联动、科创50 相对沪深300 超额强度）

## 组件

| 文件 | 作用 |
| --- | --- |
| `server.js` | Web 后端：行情代理 + 模拟账户 + 交易 + 复盘（浏览器 GUI 用） |
| `public/` | 前端页面（总览/指标/策略/交易台/复盘/设置） |
| `daily-report.js` | 每日交易策略报告生成器（文字版，落盘到 `data/reports/`） |
| `monitor.js` | **实时盯盘助手**（盘中轮询 → 多ETF动量轮动 → 自动交易 → 微信推送） |
| `lib/market.js` | 共享行情模块（K线/分时/实时价/主力资金/情绪/消息/指数/校准） |
| `lib/rotation-account.js` | 多 ETF 持仓账户（每只独立成本/份额/盈亏）+ 轮动自动交易 |
| `lib/indicators.js` | Node 侧技术指标库（供回测训练与台账结算使用） |
| `lib/signals.js` | **专家信号提取**（11 个可独立评估的信号专家） |
| `lib/rl.js` | **Hedge 在线学习器** + Platt 概率标定 + Brier 分解 |
| `lib/research-ledger.js` | **研究台账**：结论留痕 / 到期结算 / 证据分级 / 过度自信护栏 |
| `train-rl.js` | 历史回测训练器（三段切分 + 超参搜索 + 样本外评估） |
| `ledger.js` | 研究台账 CLI（stats/list/show/resolve/feedback/report/export） |
| `seed-ledger.js` | 回填历史咨询记录到台账 |
| `public/static/indicators.js` | 技术指标库（MA/MACD/RSI/KDJ/BOLL/ATR/MFI） |
| `public/static/engine.js` | 策略引擎（综合评分 + 仓位管理 + 轮动打分/决策 + 复盘文案） |

## 研究台账与自学习（回答"你到底准不准"）

系统会把**每一次咨询的结论**（方向、概率、关键位、依据、置信度）结构化落盘，到期后**自动拉真实行情结算**，
再用 **Hedge 在线学习**把结果回灌成专家权重与概率标定参数。

**第一次真实结算的结果（2026-09-13）**：5 条"未来1天"预测命中 1 条（20%），
归因发现是**方向标签阈值与概率不自洽**（41% 的上涨概率被标成"震荡"）。修正阈值后，
同一批样本命中率 20% → 80%。这就是台账的价值：**"震荡"看起来永远不会错，没有结算就永远发现不了这个 bug**。

**样本外成绩单**（17 标的 / 21857 样本 / 测试集 4301 条）：

| 周期 | 手工权重 | 学习后（样本外） | 标定斜率 a |
| --- | --- | --- | --- |
| 未来 1 天 | 51.1% | **52.8%** | 0.207 |
| 未来 3 天 | 50.2% | **52.9%** | 0.433 |
| 未来 1 周 | 46.7% | **52.1%** | 0.483 |
| 未来 1 月 | 42.9% | **52.2%** | 0.971 |

> ⚠️ **诚实的边界**：Brier ≈ 0.25、技巧分 ≤ 0，意味着**概率输出并不优于"永远猜基础概率"**；
> 标定斜率 a < 1 说明**原始概率严重过度自信** —— 系统说"70%"，实际应读作"约 58%"。
> 模型有微弱的方向优势（52~53%），但**不足以支撑重仓**。

详细说明见 `reports/研究台账与自学习系统-诚实性说明-20260913.md` 与 `reports/Hedge学习器训练报告-20260913.md`。

## 快速开始

```bash
# 1) 启动 Web 模拟系统（可选）
node server.js            # 打开 http://127.0.0.1:8899

# 2) 生成当日文字策略报告
node daily-report.js

# 3) 启动实时盯盘助手（常驻）
node monitor.js           # 按 notify.config.json 的 channel 推送
node monitor.js --once    # 单次评估，打印当前策略与将触发的事件（不推送）
node monitor.js --dry-run # 常驻但只打印，不实际推送（先调试用）

# 4) 研究台账与学习器（可选）
node seed-ledger.js       # 回填历史咨询记录
node ledger.js resolve    # 拉真实行情结算到期预测
node ledger.js stats      # 查看准确率（含证据分级分层）
node train-rl.js          # 训练 Hedge 学习器（约 1 分钟）
```

## 实时盯盘助手（monitor.js）

### 触发时机（“适当的时候”）

| 事件 | 触发条件 | 内容 |
| --- | --- | --- |
| 开盘策略 | 每个交易日首次进入交易时段（9:30 后，上午/下午皆可） | 当日初始策略 |
| 盘中快照 | 交易时段内每 `reportIntervalMin` 分钟 | 常规策略速览 |
| 评分异动 | 综合评分跨越关键阈值（36/48/60/72，对应状态切换） | 状态切换提醒 + 新策略 |
| 调仓提醒 | 目标仓位偏离 ≥ 0.5 份资金（约 2.5 万元） | 买卖指令 + 分批方案 |
| 止损/止盈 | 持仓价格触及止损价/止盈价 | 高优先级风控预警 |
| 收盘复盘 | 15:00 收盘后（每交易日一次） | 当日复盘 + 明日预案 |

### 推送渠道配置

编辑 `notify.config.json`（模板见 `notify.config.example.json`）：

| `channel` | 说明 | 需要填写的 `notify` 字段 |
| --- | --- | --- |
| `console` | 打印到终端（默认，免配置） | 无 |
| `serverchan` | Server酱 → 微信服务号推送（免费） | `serverchan.sendkey`（https://sct.ftqq.com 获取） |
| `pushplus` | PushPlus → 微信推送（免费） | `pushplus.token`（https://www.pushplus.plus 获取） |
| `wecom` | 企业微信群机器人 | `wecom.webhook`（群机器人 Webhook 地址） |
| `wecomapp` | 企业微信自建应用消息（可推个人微信） | `wecomapp.corpid`/`secret`/`agentid`/`touser` |
| `dingtalk` | 钉钉群机器人 | `dingtalk.webhook`（自定义机器人 Webhook 地址） |
| `generic` | 通用 HTTP 网关（可对接短信网关/自建服务） | `generic.url`（可选 `headers`/`bodyTemplate`） |

示例（微信 Server酱）：

```json
{
  "channel": "serverchan",
  "notify": { "serverchan": { "sendkey": "SCTxxxxxxxxxxxx" } }
}
```

> 短信说明：国内短信需在运营商侧开通签名与模板（付费），本项目不做直连；可用 `generic` 对接你自己的短信网关（POST `{title,text}` 到指定 URL）。

### 运行方式

**Web 服务（开机自启，推荐）**

```bash
bash start-server.sh   # 注册 launchd 开机自启并立即启动（其他人可经局域网访问）
bash stop-server.sh    # 停止并取消自启
```

- 本机访问：http://127.0.0.1:8899
- 同一 Wi-Fi 的其他人：http://<本机局域网IP>:8899（`start-server.sh` 会打印）
- 公网访问需部署到云服务器（见 `DEPLOY.md`）

**盯盘（打开网页即启动）**

1. Web 服务运行后，浏览器打开 http://127.0.0.1:8899
2. **打开网页界面即自动启动盯盘**（前端加载时调用 `/api/monitor/start`，若已在运行则复用）
3. 手动：`curl -X POST http://127.0.0.1:8899/api/monitor/start`

手动管理（可选）：

```bash
node monitor.js --once                            # 单次评估（不推送）
node monitor.js --dry-run                         # 前台调试（不推送）
nohup node monitor.js > data/monitor.log 2>&1 &   # 后台常驻（手动）
curl -X POST http://127.0.0.1:8899/api/monitor/start   # 手动启动盯盘
curl http://127.0.0.1:8899/api/monitor/status           # 查看盯盘状态
```

日志写入 `data/monitor.log`。可在 `notify.config.json` 的 `holidays` 数组里维护 A 股休市日，避免节假日误触发。

## 免责声明

本系统仅供学习研究，所有行情、评分、指令均为自动计算，不构成任何投资建议。据此操作，风险自负。
