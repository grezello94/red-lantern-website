#!/bin/bash
set -euo pipefail
export COPYFILE_DISABLE=1

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
release_dir="$root_dir/releases"
stage_dir="$release_dir/.macos-bridge-stage"
payload_dir="$stage_dir/payload/Library/Application Support/Red Lantern Print Bridge"
scripts_dir="$stage_dir/scripts"
unsigned_pkg="$release_dir/Red-Lantern-Print-Bridge-macOS-unsigned.pkg"
final_pkg="$release_dir/Red-Lantern-Print-Bridge-macOS.pkg"

command -v pkgbuild >/dev/null || { echo "pkgbuild is required. Run this on macOS with Xcode Command Line Tools installed."; exit 1; }
node_path="$(command -v node || true)"
[ -n "$node_path" ] || { echo "Node.js 22 is required to build the macOS installer."; exit 1; }
[ "$($node_path -p 'process.versions.node.split(".")[0]')" = "22" ] || { echo "The macOS installer must be built with Node.js 22."; exit 1; }
rm -rf "$stage_dir" "$unsigned_pkg" "$final_pkg"
mkdir -p "$payload_dir" "$scripts_dir" "$release_dir"
cp -X "$root_dir/print-bridge.js" "$payload_dir/print-bridge.js"
cp -X "$root_dir/install-print-bridge-macos.sh" "$payload_dir/install-print-bridge-macos.sh"
cp -X "$node_path" "$payload_dir/node"
chmod 755 "$payload_dir/node"

cat > "$payload_dir/run-print-bridge.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
for node_path in "/Library/Application Support/Red Lantern Print Bridge/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$node_path" ] && [ "$($node_path -p 'process.versions.node.split(".")[0]')" = "22" ]; then
    export PRINT_BRIDGE_DATA_DIR="/Library/Application Support/Red Lantern Print Bridge/data"
    exec "$node_path" "/Library/Application Support/Red Lantern Print Bridge/print-bridge.js"
  fi
done
echo "Node.js 22 LTS was not found. Install Node.js 22 LTS, then restart the Red Lantern Print Bridge service." >&2
exit 1
EOF
chmod 755 "$payload_dir/run-print-bridge.sh"

cat > "$payload_dir/in.redlantern.print-bridge.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>in.redlantern.print-bridge</string>
  <key>ProgramArguments</key><array><string>/Library/Application Support/Red Lantern Print Bridge/run-print-bridge.sh</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/red-lantern-print-bridge.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/red-lantern-print-bridge-error.log</string>
</dict></plist>
EOF

cat > "$scripts_dir/postinstall" <<'EOF'
#!/bin/bash
set -euo pipefail
service="/Library/LaunchDaemons/in.redlantern.print-bridge.plist"
install -m 644 "/Library/Application Support/Red Lantern Print Bridge/in.redlantern.print-bridge.plist" "$service"
mkdir -p "/Library/Application Support/Red Lantern Print Bridge/data"
launchctl bootout system/in.redlantern.print-bridge 2>/dev/null || true
launchctl bootstrap system "$service" || true
exit 0
EOF
chmod 755 "$scripts_dir/postinstall"
xattr -cr "$stage_dir" 2>/dev/null || true
find "$stage_dir" -name '._*' -type f -delete

pkgbuild --root "$stage_dir/payload" --scripts "$scripts_dir" --identifier "in.redlantern.print-bridge" --version "1.0.0" --install-location / --filter '(^|/)\._.*$' --filter '(^|/)\.DS_Store$' --filter '(^|/)\.svn(/|$)' --filter '(^|/)CVS(/|$)' "$unsigned_pkg"
if [ -n "${MAC_INSTALLER_IDENTITY:-}" ]; then
  productsign --sign "$MAC_INSTALLER_IDENTITY" "$unsigned_pkg" "$final_pkg"
  if [ -n "${APPLE_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$final_pkg" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
    xcrun stapler staple "$final_pkg"
  fi
  echo "Signed macOS installer created at $final_pkg"
else
  mv "$unsigned_pkg" "$final_pkg"
  echo "Unsigned macOS installer created at $final_pkg. Set MAC_INSTALLER_IDENTITY to sign it."
fi
rm -rf "$stage_dir"
