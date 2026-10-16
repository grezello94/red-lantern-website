#!/usr/bin/env node
/* Creates lightweight Windows/macOS Print Bridge setup bundles on either OS. */
const fs = require('fs');
const path = require('path');
const { deflateRawSync } = require('node:zlib');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'downloads');
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
const releaseDate = new Date(`${releaseManifest.releasedAt}T00:00:00.000Z`);
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(releaseManifest.releasedAt || '') ||
  !Number.isFinite(releaseDate.getTime()) ||
  releaseDate.toISOString().slice(0, 10) !== releaseManifest.releasedAt ||
  releaseDate.getUTCFullYear() < 1980 || releaseDate.getUTCFullYear() > 2107
) {
  throw new Error('Print Bridge releasedAt must be a valid YYYY-MM-DD date between 1980 and 2107.');
}
const zipDate = ((releaseDate.getUTCFullYear() - 1980) << 9) |
  ((releaseDate.getUTCMonth() + 1) << 5) | releaseDate.getUTCDate();
const readme = `Red Lantern Print Bridge

1. Install Node.js 22 or newer from https://nodejs.org if it is not already installed.
2. Double-click START-SETUP.cmd on Windows or open START-SETUP.command on macOS.
3. Return to Orders > Operations > Print & offline setup and choose Check again.

The Bridge stays local to this computer, pairs its printer queues to this
workstation automatically, repairs the Windows printing service silently, and
stores its offline SQLite ledger in your user profile. Do not expose port 9124
to the public internet.
`;

function bundleEntries(platform) {
  const entries = [{ name: `${bundleName}/`, data: Buffer.alloc(0), mode: 0o40755 }];
  function addFile(name, data, mode = 0o100644) {
    entries.push({ name: `${bundleName}/${name}`, data: Buffer.from(data), mode });
  }
  bridgeFiles.forEach(file => addFile(file, fs.readFileSync(path.join(root, file)),
    platform === 'macos' && file === 'install-print-bridge-macos.sh' ? 0o100755 : 0o100644));
  addFile('README.txt', readme);
  if (platform === 'windows') {
    addFile('START-SETUP.cmd',
      '@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\\install-print-bridge-windows.ps1"\r\nif errorlevel 1 pause\r\n'
    );
  } else {
    addFile('START-SETUP.command',
      '#!/bin/bash\nset -euo pipefail\ncd "$(dirname "$0")"\nbash ./install-print-bridge-macos.sh\necho\nread -r -p "Press Return to close…"\n',
      0o100755
    );
  }
  return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

// Write only standard ZIP fields. Native zip/tar add host times, ownership and
// modes, which makes a rebuild dirty even when the release sources are unchanged.
function createZip(entries) {
  const files = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isDirectory = entry.name.endsWith('/');
    const compressed = isDirectory ? entry.data : deflateRawSync(entry.data, { level: 9 });
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // ZIP 2.0, deflate support.
    header.writeUInt16LE(0x0800, 6); // UTF-8 names, no data descriptor.
    header.writeUInt16LE(isDirectory ? 0 : 8, 8);
    header.writeUInt16LE(zipDate, 12); // Midnight on the manifest's UTC release date.
    header.writeUInt32LE(crc32(entry.data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    files.push(header, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix attributes, independent of the builder OS.
    header.copy(central, 6, 4, 30);
    central.writeUInt32LE(((entry.mode << 16) | (isDirectory ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + compressed.length;
  }
  const directorySize = directory.reduce((total, chunk) => total + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, ...directory, end]);
}

// Prepare both archives before replacing either output, including all validation.
const windowsBundle = createZip(bundleEntries('windows'));
const macosBundle = createZip(bundleEntries('macos'));
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'Red-Lantern-Print-Bridge-Windows.zip'), windowsBundle);
fs.writeFileSync(path.join(outputDir, 'Red-Lantern-Print-Bridge-macOS.zip'), macosBundle);
console.log('Created Print Bridge setup bundles in downloads.');
