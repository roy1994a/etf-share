#!/bin/bash
# 半导体设备ETF盯盘助手 · 一键启动（并注册为 macOS 开机自启）
# 用法：双击运行，或执行  bash start-monitor.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.etf159516.monitor"
PLIST_NAME="$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_FILE="$DIR/data/monitor.log"

if [ -z "$NODE_BIN" ]; then
  echo "❌ 未找到 node，请先安装 Node.js：https://nodejs.org"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"

# 生成 launchd 配置
cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_BIN</string>
        <string>$DIR/monitor.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_FILE</string>
    <key>StandardErrorPath</key>
    <string>$LOG_FILE</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

# 先停掉旧实例（若存在）
launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || launchctl unload "$PLIST_DST" 2>/dev/null || true

# 加载并启动
if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
  echo "✅ 已通过 launchctl bootstrap 启动"
else
  launchctl load -w "$PLIST_DST"
  echo "✅ 已通过 launchctl load 启动"
fi

echo "开机自启已注册：$PLIST_DST"
echo "日志文件：$LOG_FILE"
echo "--- 运行状态 ---"
sleep 1
launchctl list | grep "$LABEL" && echo "🟢 盯盘助手运行中" || echo "⚠ 未检测到进程，请查看日志：$LOG_FILE"
