/** @jest-environment node */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { inflateRawSync } = require('node:zlib');

const builder = path.join(__dirname, 'scripts/build-print-bridge-bundles.js');
const sourceNames = [
  'addons-domain.js', 'printer-domain.js', 'print-bridge.js', 'print-bridge-supervisor.js',
  'run-print-bridge-hidden.vbs', 'install-print-bridge-windows.ps1', 'install-print-bridge-macos.sh',
];
const archiveNames = ['Red-Lantern-Print-Bridge-Windows.zip', 'Red-Lantern-Print-Bridge-macOS.zip'];
const fixtures = [];

function fixture(releasedAt = '2026-10-15') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-lantern-bundle-'));
  fixtures.push(root);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'downloads'));
  fs.copyFileSync(builder, path.join(root, 'scripts/build-print-bridge-bundles.js'));
  sourceNames.forEach(name => fs.copyFileSync(path.join(__dirname, name), path.join(root, name)));
  // A known checksum vector verifies that standard ZIP readers can check these entries.
  fs.writeFileSync(path.join(root, 'printer-domain.js'), '123456789');
  const version = fs.readFileSync(path.join(root, 'print-bridge.js'), 'utf8')
    .match(/const BRIDGE_VERSION = '([^']+)'/)[1];
  fs.writeFileSync(path.join(root, 'downloads/print-bridge-release.json'), JSON.stringify({ version, releasedAt }));
  return root;
}

function build(root, timezone = 'UTC', mask = 0o022) {
  execFileSync(process.execPath, ['-e', 'process.umask(Number(process.argv[1])); require(process.argv[2]);',
    String(mask), path.join(root, 'scripts/build-print-bridge-bundles.js')], {
    env: { ...process.env, TZ: timezone }, stdio: 'pipe',
  });
  return archiveNames.map(name => fs.readFileSync(path.join(root, 'downloads', name)));
}

function entriesFromZip(archive) {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  expect(archive.readUInt16LE(end + 20)).toBe(0);
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index++) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = archive.readUInt32LE(offset + 42);
    expect(archive.readUInt32LE(local)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    expect(archive.subarray(local + 30, local + 30 + localNameLength).toString('utf8')).toBe(name);
    const size = archive.readUInt32LE(offset + 20);
    const start = local + 30 + localNameLength + localExtraLength;
    const encoded = archive.subarray(start, start + size);
    const method = archive.readUInt16LE(offset + 10);
    const data = method === 8 ? inflateRawSync(encoded) : encoded;
    expect(archive.readUInt32LE(offset + 24)).toBe(data.length);
    expect(archive.readUInt32LE(local + 14)).toBe(archive.readUInt32LE(offset + 16));
    entries.push({ name, data, method, crc: archive.readUInt32LE(offset + 16),
      mode: archive.readUInt32LE(offset + 38) >>> 16,
      time: archive.readUInt16LE(offset + 12), date: archive.readUInt16LE(offset + 14),
      extraLength, localExtraLength, commentLength });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  expect(offset).toBe(end);
  return entries;
}

afterEach(() => fixtures.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

test('setup ZIPs are identical across checkouts, timezones, source timestamps and file modes', () => {
  const first = fixture();
  const second = fixture();
  sourceNames.forEach(name => {
    fs.utimesSync(path.join(first, name), new Date('2000-01-01T01:02:03Z'), new Date('2000-01-01T01:02:03Z'));
    fs.chmodSync(path.join(first, name), 0o755);
    fs.utimesSync(path.join(second, name), new Date('2030-12-31T23:59:59Z'), new Date('2030-12-31T23:59:59Z'));
    fs.chmodSync(path.join(second, name), 0o600);
  });
  const original = build(first, 'Pacific/Kiritimati', 0o022);
  expect(build(first, 'America/Los_Angeles', 0o077)).toEqual(original);
  expect(build(second, 'Asia/Kolkata', 0o077)).toEqual(original);
});

test('setup ZIPs retain exact sources, sorted paths, stable release date and Mac executables', () => {
  const root = fixture();
  const archives = build(root, 'America/Los_Angeles');
  archives.forEach((archive, platform) => {
    const entries = entriesFromZip(archive);
    const names = entries.map(entry => entry.name);
    expect(names).toEqual([...names].sort());
    expect(entries).toHaveLength(sourceNames.length + 3);
    sourceNames.forEach(name => {
      const entry = entries.find(candidate => candidate.name === `Red-Lantern-Print-Bridge/${name}`);
      expect(entry.data).toEqual(fs.readFileSync(path.join(root, name)));
    });
    expect(entries.find(entry => entry.name.endsWith('/printer-domain.js')).crc).toBe(0xcbf43926);
    entries.forEach(entry => {
      const isDirectory = entry.name.endsWith('/');
      const executable = platform === 1 && /\/(?:START-SETUP\.command|install-print-bridge-macos\.sh)$/.test(entry.name);
      expect(entry.mode).toBe(isDirectory ? 0o40755 : executable ? 0o100755 : 0o100644);
      expect(entry.time).toBe(0);
      expect(entry.date).toBe(0x5d4f); // 15 October 2026, independent of the build timezone.
      expect(entry.extraLength + entry.localExtraLength + entry.commentLength).toBe(0);
    });
    const launcher = entries.find(entry => entry.name.endsWith(platform ? '/START-SETUP.command' : '/START-SETUP.cmd'));
    expect(launcher.data.toString()).toContain(platform ? 'bash ./install-print-bridge-macos.sh' : 'install-print-bridge-windows.ps1');
  });
});

test.each([undefined, '2026-02-30', '1979-12-31', '2108-01-01'])('invalid release date %s cannot replace a bundle', releasedAt => {
  const root = fixture();
  const original = build(root);
  const manifestPath = path.join(root, 'downloads/print-bridge-release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.releasedAt = releasedAt;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => build(root)).toThrow();
  archiveNames.forEach((name, index) => {
    expect(fs.readFileSync(path.join(root, 'downloads', name))).toEqual(original[index]);
  });
});
