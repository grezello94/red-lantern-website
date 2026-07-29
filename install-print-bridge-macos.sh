#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
node_path="$(command -v node)"
label="in.redlantern.print-bridge"
agent_dir="$HOME/Library/LaunchAgents"
plist="$agent_dir/$label.plist"

mkdir -p "$agent_dir"
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$node_path</string><string>$project_dir/print-bridge.js</string></array>
  <key>WorkingDirectory</key><string>$project_dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Print Bridge installed and started. It will start automatically when you sign in."
