#!/bin/bash
# 半导体设备ETF系统 · Web 服务一键启动（并注册为 macOS 开机自启）
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.etf159516.server"
PLIST_NAME="$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_FILE="$DIR/data/server.log"

if [ -z "$NODE_BIN" ]; then echo "❌ 未找到 node，请先安装 Node.js"; exit 1; fi
mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"

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
        <string>$DIR/server.js</string>
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
        <key>HOST</key><string>0.0.0.0</string>
        <key>PORT</key><string>8899</string>
        <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || launchctl unload "$PLIST_DST" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
  echo "✅ Web 服务已通过 launchctl 启动（开机自启已注册）"
else
  launchctl load -w "$PLIST_DST"
  echo "✅ Web 服务已通过 launchctl load 启动"
fi
sleep 1
echo "本机访问：http://127.0.0.1:8899"
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
[ -n "$IP" ] && echo "局域网访问（同一Wi-Fi的其他人）：http://$IP:8899"
echo "日志：$LOG_FILE"
