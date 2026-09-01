#!/bin/bash
# 半导体设备ETF盯盘助手 · 停止并取消开机自启
LABEL="com.etf159516.monitor"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
  echo "✅ 已停止盯盘助手"
elif launchctl unload "$PLIST_DST" 2>/dev/null; then
  echo "✅ 已停止盯盘助手"
else
  echo "ℹ 盯盘助手未在运行"
fi

rm -f "$PLIST_DST"
echo "已取消开机自启（已删除 $PLIST_DST）"
