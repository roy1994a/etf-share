# 部署到公共服务器指南

本系统零外部依赖（仅 Node 内置模块），部署只需：Node.js 运行时 + 本目录文件。

## 关键前提（安全，务必先读）

1. **Server酱 SendKey 是机密**。公共部署时**不要**把它写进 `notify.config.json` 提交到服务器，改用**环境变量**：`SENDKEY=你的key`、`CHANNEL=serverchan`（代码已支持环境变量覆盖）。
2. **当前无鉴权**：任何能打开网页的人都能点「交易/重置」。若只是给别人「看」，需加只读/密码（见下）。
3. **账户是共享的**：所有访客看到的是同一个 `data/account.json`。若要每人独立账户，需改造为多用户（另做）。

## 架构

| 进程 | 作用 | 需持续运行 |
| --- | --- | --- |
| `server.js` | Web 界面 + API + 打开网页时拉起盯盘 | 是（公共访问）|
| `monitor.js` | 盘中盯盘/轮动/自动交易/微信推送 | 是（交易时段）|

公共部署需让 `server.js` 监听 `0.0.0.0`（已默认），并让两个进程都能访问 `data/` 目录（写文件）。

## 方案 A：Render 免费版（最快上手，适合「仅网页查看」，一键式）

> 已为你准备好 `Dockerfile` + `render.yaml`，部署约 10 分钟。

- 免费额度：Web Service 免费实例，闲置 15 分钟休眠、请求自动唤醒 → 适合给别人**看界面**（盯盘不可靠，盯盘留在你本地电脑跑即可）。
- **只读**：部署默认 `READ_ONLY=true`（禁交易/重置/盯盘），访客只能搜索/切换 ETF 与股票看行情和策略。

**步骤：**

1. **把项目推到 GitHub**（私有仓库即可；`notify.config.json` 已在 `.gitignore` 和 `.dockerignore`，SendKey 不会上传）。
2. 打开 [render.com](https://render.com)，用 GitHub 登录（免费注册）。
3. 点 **New → Blueprint**，连接你的仓库 → 选 `render.yaml` → **Apply**（会检测到 Dockerfile 自动构建）。
   - 或用 **New → Web Service**：连接仓库 → Runtime 选 **Docker** → 保持默认（会自动用 Dockerfile）→ Create。
4. 等待 2-5 分钟构建完成，Render 会给一个公网地址 `https://xxx.onrender.com`。
5. 把该地址发给任何人，即可打开查看。

> 提示：部署的只是「只读展示站」。你自己的**盯盘 + 微信推送**继续在本地电脑跑（`start-server.sh` + 打开网页启动盯盘）。

**本地预览部署效果（可选）**：
```bash
docker build -t etf-share . && docker run -p 8899:8899 -e READ_ONLY=true etf-share
# 打开 http://127.0.0.1:8899 即可看到只读版
```

## 方案 B：Oracle Cloud Always Free（免费、永远在线，可跑盯盘）

- 2 台免费 AMD VM（1核1GB），永远在线，适合**完整功能**（server + monitor 常驻）。
- 需绑信用卡验证（不扣费）。

步骤（以 Ubuntu VM 为例）：
```bash
# 1. 安装 Node
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# 2. 上传项目到 ~/etf（scp / git）
# 3. 启动
cd ~/etf
echo 'SENDKEY=你的key' >> .env
HOST=0.0.0.0 PORT=8899 nohup node server.js > server.log 2>&1 &
# 4. 盯盘（可选：让打开网页时自动拉起，或手动常驻）
nohup node monitor.js > monitor.log 2>&1 &
```
- 在云控制台安全组/防火墙放行 8899 端口。
- 访问 `http://<公网IP>:8899`。

## 方案 C：Fly.io / Railway / 国内轻量服务器

- Fly.io：免费额度可跑小机器，需绑卡；`flyctl deploy` 配 Dockerfile。
- 国内（阿里云/腾讯云轻量，约 ¥50-100/年）：延迟最低、实时性最好，适合 A 股盯盘，但需实名+付费。

## 只读模式（推荐：给他人只看行情、不能交易）

代码已内置只读模式，部署时加环境变量即可：

```bash
READ_ONLY=true HOST=0.0.0.0 PORT=8899 node server.js
```

只读模式下自动：禁用交易、重置、复盘保存、盯盘启动；前端隐藏下单/重置/复盘按钮并显示「只读模式」提示。访客可自由**搜索/切换任意 ETF** 查看行情与策略。

> 本系统仅供学习研究，公网部署请务必处理好密钥与鉴权，责任自负。
