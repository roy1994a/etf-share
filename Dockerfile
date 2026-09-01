# 半导体设备ETF轮动系统 · 公网部署镜像（零依赖，无需 npm install）
FROM node:20-slim

WORKDIR /app

# 复制项目（.dockerignore 已排除密钥/数据/日志）
COPY . .

# 公网部署默认：监听所有网卡 + 只读模式（禁交易/重置/盯盘）
ENV HOST=0.0.0.0 \
    PORT=8899 \
    READ_ONLY=true

EXPOSE 8899

CMD ["node", "server.js"]
