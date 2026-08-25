#!/bin/bash
set -euo pipefail

# Creates lightweight, platform-specific setup bundles served by the website.
# The bridge uses Node's built-in SQLite API, available in Node.js 22 and newer.
# the workstation or included later in a signed native installer.
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="$root_dir/downloads"
stage_dir="$output_dir/.bridge-stage"

rm -rf "$stage_dir"
mkdir -p "$stage_dir/windows/Red-Lantern-Print-Bridge" "$stage_dir/macos/Red-Lantern-Print-Bridge"

for platform in windows macos; do
  target="$stage_dir/$platform/Red-Lantern-Print-Bridge"
  cp "$root_dir/print-bridge.js" "$target/print-bridge.js"
  cp "$root_dir/print-bridge-supervisor.js" "$target/print-bridge-supervisor.js"
  cp "$root_dir/run-print-bridge-hidden.vbs" "$target/run-print-bridge-hidden.vbs"
  cp "$root_dir/install-print-bridge-windows.ps1" "$target/install-print-bridge-windows.ps1"
  cp "$root_dir/install-print-bridge-macos.sh" "$target/install-print-bridge-macos.sh"
done

cat > "$stage_dir/windows/Red-Lantern-Print-Bridge/START-SETUP.cmd" <<'EOF'
@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\install-print-bridge-windows.ps1"
if errorlevel 1 pause
EOF

cat > "$stage_dir/macos/Red-Lantern-Print-Bridge/START-SETUP.command" <<'EOF'
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bash ./install-print-bridge-macos.sh
echo
read -r -p "Press Return to close…"
EOF
chmod +x "$stage_dir/macos/Red-Lantern-Print-Bridge/START-SETUP.command" "$stage_dir/macos/Red-Lantern-Print-Bridge/install-print-bridge-macos.sh"

cat > "$stage_dir/windows/Red-Lantern-Print-Bridge/README.txt" <<'EOF'
Red Lantern Print Bridge

1. Install Node.js 22 or newer from https://nodejs.org if it is not already installed.
2. Double-click START-SETUP.cmd.
3. Return to Orders > Operations > Print & offline setup and choose Check again.

The Bridge stays local to this computer and stores its offline SQLite ledger in
your user profile. Do not expose port 9124 to the public internet.
EOF
cp "$stage_dir/windows/Red-Lantern-Print-Bridge/README.txt" "$stage_dir/macos/Red-Lantern-Print-Bridge/README.txt"

mkdir -p "$output_dir"
rm -f "$output_dir/Red-Lantern-Print-Bridge-Windows.zip" "$output_dir/Red-Lantern-Print-Bridge-macOS.zip"
(cd "$stage_dir/windows" && zip -qry "$output_dir/Red-Lantern-Print-Bridge-Windows.zip" Red-Lantern-Print-Bridge)
(cd "$stage_dir/macos" && zip -qry "$output_dir/Red-Lantern-Print-Bridge-macOS.zip" Red-Lantern-Print-Bridge)
rm -rf "$stage_dir"
echo "Created Print Bridge setup bundles in $output_dir"
