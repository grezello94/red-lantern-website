#!/bin/bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required before Print Bridge can be installed. Install a supported Node.js LTS release, then run this setup again."
  exit 1
fi
node_path="$(command -v node)"
node_major="$($node_path -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 or newer is required. This computer has Node.js $($node_path -v). Install a supported Node.js LTS release, then run this setup again."
  exit 1
fi
label="in.redlantern.print-bridge"
agent_dir="$HOME/Library/LaunchAgents"
plist="$agent_dir/$label.plist"

mkdir -p "$agent_dir"
if curl -fsS --max-time 1 http://127.0.0.1:9124/health >/dev/null 2>&1; then
  echo "Print Bridge is already running. No setup changes were made."
  exit 0
fi
if [ -f "$plist" ]; then
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null || true
  launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null || true
  echo "Existing Print Bridge setup was started."
  exit 0
fi
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
