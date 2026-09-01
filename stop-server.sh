#!/bin/bash
# 半导体设备ETF系统 · 停止 Web 服务并取消开机自启
LABEL="com.etf159516.server"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
  echo "✅ 已停止 Web 服务"
elif launchctl unload "$PLIST_DST" 2>/dev/null; then
  echo "✅ 已停止 Web 服务"
else
  echo "ℹ Web 服务未在运行"
fi
rm -f "$PLIST_DST"
echo "已取消开机自启"
