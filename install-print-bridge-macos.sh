#!/bin/bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
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
install_dir="$HOME/Library/Application Support/Red Lantern Print Bridge"

for required in printer-domain.js print-bridge.js; do
  if [ ! -f "$source_dir/$required" ]; then
    echo "$required was not found in $source_dir"
    exit 1
  fi
done

mkdir -p "$agent_dir" "$install_dir"
# Always replace the installed runtime. The downloaded/extracted setup folder
# can then be moved or deleted without breaking the LaunchAgent.
install -m 0644 "$source_dir/printer-domain.js" "$install_dir/printer-domain.js"
install -m 0644 "$source_dir/print-bridge.js" "$install_dir/print-bridge.js"
if [ -f "$source_dir/print-bridge-supervisor.js" ]; then
  install -m 0644 "$source_dir/print-bridge-supervisor.js" "$install_dir/print-bridge-supervisor.js"
fi

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
cat > "$plist.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$node_path</string><string>$install_dir/print-bridge.js</string></array>
  <key>WorkingDirectory</key><string>$install_dir</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
EOF
mv -f "$plist.new" "$plist"
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/$label"
ready=false
for _ in 1 2 3 4 5 6 7 8; do
  if curl -fsS --max-time 2 http://127.0.0.1:9124/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done
if [ "$ready" != true ]; then
  echo "The LaunchAgent was updated, but Print Bridge did not become ready."
  exit 1
fi
echo "Print Bridge was updated, restarted, and will start automatically when you sign in."
