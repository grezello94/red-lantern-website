#!/usr/bin/env node
/* Creates lightweight Windows/macOS Print Bridge setup bundles on either OS. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'downloads');
const stageDir = path.join(outputDir, '.bridge-stage');
const bundleName = 'Red-Lantern-Print-Bridge';
const releaseManifestPath = path.join(outputDir, 'print-bridge-release.json');
const bridgeFiles = [
  'addons-domain.js',
  'printer-domain.js',
  'print-bridge.js',
  'print-bridge-supervisor.js',
  'run-print-bridge-hidden.vbs',
  'install-print-bridge-windows.ps1',
  'install-print-bridge-macos.sh',
];
const bridgeVersionMatch = fs
  .readFileSync(path.join(root, 'print-bridge.js'), 'utf8')
  .match(/const BRIDGE_VERSION = '([^']+)'/);
const releaseManifest = JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8'));
if (!bridgeVersionMatch || releaseManifest.version !== bridgeVersionMatch[1]) {
  throw new Error(
    `Print Bridge version mismatch: print-bridge.js is ${bridgeVersionMatch?.[1] || 'unknown'}, but downloads/print-bridge-release.json is ${releaseManifest.version || 'unknown'}.`
  );
}
const readme = `Red Lantern Print Bridge

1. Install Node.js 22 or newer from https://nodejs.org if it is not already installed.
2. Double-click START-SETUP.cmd on Windows or open START-SETUP.command on macOS.
3. Return to Orders > Operations > Print & offline setup and choose Check again.

The Bridge stays local to this computer, pairs its printer queues to this
workstation automatically, repairs the Windows printing service silently, and
stores its offline SQLite ledger in your user profile. Do not expose port 9124
to the public internet.
`;

function createStagedBundle(platform) {
  const target = path.join(stageDir, platform, bundleName);
  fs.mkdirSync(target, { recursive: true });
  bridgeFiles.forEach((file) => fs.copyFileSync(path.join(root, file), path.join(target, file)));
  fs.writeFileSync(path.join(target, 'README.txt'), readme, 'utf8');
  if (platform === 'windows') {
    fs.writeFileSync(
      path.join(target, 'START-SETUP.cmd'),
      '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\install-print-bridge-windows.ps1"\r\nif errorlevel 1 pause\r\n',
      'ascii'
    );
  } else {
    const launcher = path.join(target, 'START-SETUP.command');
    fs.writeFileSync(
      launcher,
      '#!/bin/bash\nset -euo pipefail\ncd "$(dirname "$0")"\nbash ./install-print-bridge-macos.sh\necho\nread -r -p "Press Return to close…"\n',
      'utf8'
    );
    fs.chmodSync(launcher, 0o755);
    fs.chmodSync(path.join(target, 'install-print-bridge-macos.sh'), 0o755);
  }
}

function zipBundle(platform, outputName) {
  const sourceParent = path.join(stageDir, platform);
  const destination = path.join(outputDir, outputName);
  fs.rmSync(destination, { force: true });
  if (process.platform === 'win32') {
    execFileSync('tar.exe', ['-a', '-c', '-f', destination, bundleName], {
      cwd: sourceParent,
      stdio: 'inherit',
      windowsHide: true,
    });
    return;
  }
  execFileSync('zip', ['-qry', destination, bundleName], { cwd: sourceParent, stdio: 'inherit' });
}

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
try {
  createStagedBundle('windows');
  createStagedBundle('macos');
  zipBundle('windows', 'Red-Lantern-Print-Bridge-Windows.zip');
  zipBundle('macos', 'Red-Lantern-Print-Bridge-macOS.zip');
  console.log('Created Print Bridge setup bundles in downloads.');
} finally {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
