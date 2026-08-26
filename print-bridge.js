/*
 * Red Lantern Print Bridge
 *
 * Run this on the restaurant computer that has the LAN/USB printers installed:
 *   npm run print-bridge
 *
 * The Orders console uses this local service only to discover printer names.
 * Printing is intentionally not exposed until the KOT dispatch workflow is enabled.
 */
const http = require('http');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PRINT_BRIDGE_PORT || 9124);
const BRIDGE_VERSION = '2026.08.18.3';
const storageDir =
  process.env.PRINT_BRIDGE_DATA_DIR || path.join(os.homedir(), '.red-lantern-print-bridge');
const configFile = path.join(storageDir, 'printer-config.json');
const queueFile = path.join(storageDir, 'kot-queue.json');
const ledgerFile = path.join(storageDir, 'orders-ledger.sqlite');
let ledger = null;

function localLedger() {
  if (ledger) return ledger;
  fsSync.mkdirSync(storageDir, { recursive: true });
  ledger = new DatabaseSync(ledgerFile);
  ledger.exec(`CREATE TABLE IF NOT EXISTS ledger_actions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    synced_at TEXT
  )`);
  ledger.exec(
    'CREATE INDEX IF NOT EXISTS ledger_actions_status_created ON ledger_actions(status, created_at)'
  );
  ledger.exec(`CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    acknowledged_at TEXT
  )`);
  // Existing Bridge installations keep their local ledger across upgrades.
  // Add the payload fingerprint without requiring staff to delete that data.
  try {
    ledger.exec("ALTER TABLE print_jobs ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
  } catch (_) {}
  try {
    ledger.exec('ALTER TABLE print_jobs ADD COLUMN acknowledged_at TEXT');
  } catch (_) {}
  return ledger;
}

function claimPrintJob(id, kind, printerName, contentHash = '') {
  const safeId = String(id || '')
    .trim()
    .slice(0, 160);
  if (!safeId) return { claim: true, tracked: false };
  const db = localLedger(),
    now = new Date().toISOString();
  const existing = db.prepare('SELECT status, content_hash FROM print_jobs WHERE id=?').get(safeId);
  // A retry with the same payload must never create a second physical slip.
  // If the content has changed, however, it is a genuinely new print request
  // and must not be hidden behind an old completed job.
  if (existing?.status === 'printed' && (!contentHash || existing.content_hash === contentHash))
    return { claim: false, duplicate: true };
  if (existing?.status === 'printing') return { claim: false, pending: true };
  db.prepare(
    'INSERT INTO print_jobs (id,kind,printer_name,status,created_at,completed_at,content_hash,acknowledged_at) VALUES (?,?,?,?,?,NULL,?,NULL) ON CONFLICT(id) DO UPDATE SET status=excluded.status, printer_name=excluded.printer_name, created_at=excluded.created_at, completed_at=NULL, content_hash=excluded.content_hash, acknowledged_at=NULL'
  ).run(
    safeId,
    kind,
    String(printerName || '').slice(0, 160),
    'printing',
    now,
    String(contentHash || '').slice(0, 64)
  );
  return { claim: true, tracked: true };
}
function finishPrintJob(id, success) {
  const safeId = String(id || '')
    .trim()
    .slice(0, 160);
  if (!safeId) return;
  localLedger()
    .prepare('UPDATE print_jobs SET status=?, completed_at=?, acknowledged_at=NULL WHERE id=?')
    .run(success ? 'printed' : 'failed', success ? new Date().toISOString() : null, safeId);
}

function ledgerAction(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || '{}');
  } catch (_) {}
  return {
    id: row.id,
    type: row.type,
    payload,
    status: row.status,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at || '',
  };
}

function queueLedgerAction(input) {
  const type = String(input.type || '');
  const id = String(input.id || input.payload?.clientRequestId || '')
    .trim()
    .slice(0, 120);
  const supportedTypes = new Set([
    'counter-order',
    'order-status',
    'order-items',
    'order-table',
    'kitchen-status',
    'availability-update',
    'operations-config',
    'table-areas',
    'settlement',
  ]);
  if (!supportedTypes.has(type) || !id)
    throw new Error('This offline action needs a unique action ID.');
  const payload =
    input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
      ? input.payload
      : null;
  if (!payload) throw new Error('Offline action details are required.');
  if (type === 'counter-order' && (!Array.isArray(payload.items) || !payload.items.length))
    throw new Error('An offline order needs at least one item.');
  const encoded = JSON.stringify(payload);
  if (encoded.length > 250000) throw new Error('Offline order is too large to store locally.');
  const now = new Date().toISOString();
  const db = localLedger();
  db.prepare(
    'INSERT INTO ledger_actions (id,type,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING'
  ).run(id, type, encoded, 'queued', now, now);
  return ledgerAction(db.prepare('SELECT * FROM ledger_actions WHERE id=?').get(id));
}

function updateLedgerAction(id, status, error = '') {
  const safeId = String(id || '').slice(0, 120);
  if (!safeId || !['queued', 'syncing', 'synced', 'blocked'].includes(status))
    throw new Error('Invalid ledger action update.');
  const now = new Date().toISOString();
  const db = localLedger();
  const existing = db.prepare('SELECT id FROM ledger_actions WHERE id=?').get(safeId);
  if (!existing) throw new Error('Offline action was not found.');
  db.prepare(
    'UPDATE ledger_actions SET status=?, attempts=attempts+1, last_error=?, updated_at=?, synced_at=? WHERE id=?'
  ).run(status, String(error || '').slice(0, 500), now, status === 'synced' ? now : null, safeId);
  return ledgerAction(db.prepare('SELECT * FROM ledger_actions WHERE id=?').get(safeId));
}

function ledgerSummary() {
  const rows = localLedger()
    .prepare('SELECT status, COUNT(*) AS count FROM ledger_actions GROUP BY status')
    .all();
  const counts = { queued: 0, syncing: 0, blocked: 0, synced: 0 };
  rows.forEach((row) => {
    if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count || 0);
  });
  const jobs = localLedger()
    .prepare('SELECT status, COUNT(*) AS count FROM print_jobs GROUP BY status')
    .all();
  const printJobs = { printing: 0, printed: 0, failed: 0 };
  jobs.forEach((row) => {
    if (Object.hasOwn(printJobs, row.status)) printJobs[row.status] = Number(row.count || 0);
  });
  const unresolvedFailures = localLedger()
    .prepare(
      "SELECT COUNT(*) AS count FROM print_jobs WHERE status='failed' AND acknowledged_at IS NULL"
    )
    .get();
  return {
    actions: counts,
    pendingActions: counts.queued + counts.syncing,
    blockedActions: counts.blocked,
    printJobs: { ...printJobs, unresolvedFailed: Number(unresolvedFailures?.count || 0) },
  };
}

function recentPrintFailures() {
  return localLedger()
    .prepare(
      "SELECT id, kind, printer_name, created_at, completed_at FROM print_jobs WHERE status='failed' AND acknowledged_at IS NULL ORDER BY created_at DESC LIMIT 5"
    )
    .all()
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      printerName: job.printer_name,
      createdAt: job.created_at,
      completedAt: job.completed_at || '',
    }));
}

function acknowledgePrintJobs(ids) {
  const safeIds = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .map((id) =>
          String(id || '')
            .trim()
            .slice(0, 160)
        )
        .filter(Boolean)
    ),
  ].slice(0, 50);
  if (!safeIds.length) throw new Error('Choose at least one failed print job to mark reviewed.');
  const placeholders = safeIds.map(() => '?').join(','),
    now = new Date().toISOString();
  const result = localLedger()
    .prepare(
      `UPDATE print_jobs SET acknowledged_at=? WHERE status='failed' AND acknowledged_at IS NULL AND id IN (${placeholders})`
    )
    .run(now, ...safeIds);
  return Number(result.changes || 0);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

async function installedPrinters() {
  let output = '';
  if (process.platform === 'win32') {
    // Different Windows installations expose printer data through different
    // management providers, so try all supported built-in discovery routes.
    const attempts = [
      [
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name',
        ],
      ],
      [
        'powershell.exe',
        ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
      ],
      ['wmic.exe', ['printer', 'get', 'name', '/value']],
    ];
    const failures = [];
    for (const [command, args] of attempts) {
      try {
        output = await run(command, args);
        break;
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (!output && failures.length === attempts.length) {
      throw new Error(
        'Windows could not read installed printers. Confirm the Print Spooler is running and install the printer manufacturer’s Windows driver.'
      );
    }
    const names = output.includes('Name=')
      ? output.split(/\r?\n/).map((line) => line.replace(/^Name=/i, ''))
      : output.split(/\r?\n/);
    return formatPrinters(names);
  }
  if (process.platform === 'darwin') {
    try {
      output = await run('lpstat', ['-p']);
    } catch (_) {
      throw new Error(
        'macOS printing is unavailable. Add the printer in System Settings > Printers & Scanners, then install its AirPrint or manufacturer driver.'
      );
    }
    return formatPrinters(
      output.split(/\r?\n/).map((line) => {
        const match = line.match(/^printer\s+([^\s]+)/i);
        return match ? match[1] : '';
      })
    );
  } else {
    try {
      output = await run('lpstat', ['-p']);
    } catch (_) {
      throw new Error(
        'CUPS printer discovery is unavailable. Install and configure CUPS and the printer driver.'
      );
    }
    return formatPrinters(
      output.split(/\r?\n/).map((line) => {
        const match = line.match(/^printer\s+([^\s]+)/i);
        return match ? match[1] : '';
      })
    );
  }
}

function formatPrinters(names) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(storageDir, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

async function printText(printerName, text, settings = {}) {
  const file = path.join(os.tmpdir(), `red-lantern-kot-${crypto.randomUUID()}.txt`);
  await fs.writeFile(file, text, 'utf8');
  try {
    if (process.platform === 'win32') {
      const quote = (value) => String(value).replace(/'/g, "''");
      const paperWidth = Number(settings.paperWidth) === 58 ? 58 : 80;
      const fontFamily = [
        'Arial',
        'Calibri',
        'Verdana',
        'Tahoma',
        'Trebuchet MS',
        'Georgia',
        'Times New Roman',
        'Courier New',
        'Consolas',
        'Lucida Console',
      ].includes(String(settings.fontFamily))
        ? String(settings.fontFamily).replace(/'/g, "''")
        : 'Arial';
      const bodyFontSize = Math.max(8, Math.min(13, Number(settings.fontSize) || 10));
      const headerFontSize = Math.max(12, Math.min(18, Number(settings.headerFontSize) || 15));
      const headerStyle = settings.headerBold === false ? 'Regular' : 'Bold';
      const footerStyle = settings.footerBold ? 'Bold' : 'Regular';
      const layout = (value, min, max, fallback) =>
        Math.max(min, Math.min(max, Number(value) || fallback));
      // 309 hundredths of an inch is 78.5 mm: the measured printable span of
      // the 80 mm reference receipt.  The driver still owns the actual paper
      // form, so this safely shrinks when a printer has a narrower print area.
      // Never enlarge a saved printable width. Some 80 mm drivers expose only
      // 250 units of usable width; forcing 300 makes the right columns print
      // outside the paper and causes the clipping seen on the receipt.
      const configuredMainWidth = layout(settings.billingMainWidth, 160, 400, 309),
        mainWidth = configuredMainWidth,
        leftMargin = layout(settings.billingOuterLeft, 0, 40, 0),
        rightMargin = layout(settings.billingOuterRight, 0, 40, 0),
        topMargin = layout(settings.billingOuterTop, 0, 40, 0),
        bottomMargin = layout(settings.billingOuterBottom, 0, 40, 0);
      const restaurantFontSize = layout(settings.restaurantNameFontSize, 8, 24, 14),
        headerFooterFontSize = layout(settings.headerFooterFontSize, 8, 20, 13),
        dateBillFontSize = layout(settings.dateBillFontSize, 8, 20, 13),
        itemFontSize = layout(settings.itemListingFontSize, 8, 10, 10),
        totalFontSize = layout(settings.grandTotalFontSize, 10, 11, 11),
        kotHeaderFontSize = layout(settings.kotHeaderFontSize, 8, 24, 12),
        kotTitleFontSize = layout(settings.kotTitleFontSize, 10, 26, 15),
        kotMetaFontSize = layout(settings.kotMetaFontSize, 8, 20, 10),
        kotItemFontSize = layout(settings.kotItemFontSize, 8, 22, 12),
        kotFooterFontSize = layout(settings.kotFooterFontSize, 8, 20, 10),
        itemGap = layout(settings.itemRowGap, 0, 20, 3),
        separatorGap = layout(settings.separatorGap, 0, 20, 3),
        separatorThickness = layout(settings.separatorThickness, 1, 4, 1),
        grandTotalWidth = layout(settings.grandTotalContentWidth, 120, 400, 261),
        itemMinHeight = layout(settings.billingItemBoxHeight, 0, 40, 0);
      const script = `Add-Type -AssemblyName System.Drawing
$lines = Get-Content -LiteralPath '${quote(file)}' -Encoding UTF8
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '${quote(printerName)}'
if (-not $doc.PrinterSettings.IsValid) { throw 'The selected Windows printer is no longer available.' }
# 79 mm rolls are configured by Windows drivers as 80 mm. Some Everycom
# drivers report that 80 mm form as 283 hundredths of an inch (about 72 mm),
# so include it rather than falling back to the driver's unrelated default.
$minWidth = if (${paperWidth} -eq 58) { 220 } else { 270 }
$maxWidth = if (${paperWidth} -eq 58) { 240 } else { 320 }
$thermalPaper = @($doc.PrinterSettings.PaperSizes | Where-Object { $_.Width -ge $minWidth -and $_.Width -le $maxWidth } | Select-Object -First 1)
if ($thermalPaper.Count) { $doc.DefaultPageSettings.PaperSize = $thermalPaper[0] }
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(${leftMargin}, ${rightMargin}, ${topMargin}, ${bottomMargin})
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.add_PrintPage({ param($sender, $event)
  $g = $event.Graphics; $width = [Math]::Max(120, [Math]::Min($event.MarginBounds.Width, ${mainWidth}) - 8); $y = $event.MarginBounds.Top
  $bodySize = ${bodyFontSize}; $sectionStarts = @{}
  foreach ($line in $lines) {
    $displayLine = $line; $style = [System.Drawing.FontStyle]::Regular; $size = $bodySize; $alignment = [System.Drawing.StringAlignment]::Center; $fontName = ''
    if ($line.StartsWith('__SECTIONSTART__')) { $sectionStarts[$line.Substring(16)] = $y; continue }
    if ($line.StartsWith('__SECTIONEND__')) { $parts = $line.Substring(14).Split('|', 2); if ($parts.Count -eq 2 -and $sectionStarts.ContainsKey($parts[0])) { $y = [Math]::Max($y, $sectionStarts[$parts[0]] + [Math]::Max(0, [int]$parts[1])) }; continue }
    if ($line.StartsWith('__KOTRULE__')) {
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, 3)
      $g.DrawLine($pen, $event.MarginBounds.Left, $y + 3, $event.MarginBounds.Left + $width, $y + 3)
      $pen.Dispose(); $y += 9; continue
    }
    if ($line.StartsWith('__SEPARATOR__')) {
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, ${separatorThickness})
      $g.DrawLine($pen, $event.MarginBounds.Left, $y + 2, $event.MarginBounds.Left + $width, $y + 2)
      $pen.Dispose(); $y += 4 + ${separatorGap}; continue
    }
    if ($line.StartsWith('__KOTITEM__')) {
      # Draw the complete line in one GDI operation.  The former token-by-token
      # renderer was driver-sensitive and could print only the first character
      # of an item on some thermal printers.
      $plainItem = $line.Substring(11).Replace('[[', '').Replace(']]', '')
      $font = New-Object System.Drawing.Font('${fontFamily}', ${kotItemFontSize}, [System.Drawing.FontStyle]::Bold)
      $format = New-Object System.Drawing.StringFormat; $format.Alignment = [System.Drawing.StringAlignment]::Near; $format.Trimming = [System.Drawing.StringTrimming]::Word
      $bounds = New-Object System.Drawing.RectangleF([single]$event.MarginBounds.Left, [single]$y, [single]$width, 400)
      $height = $g.MeasureString($plainItem, $font, $width, $format).Height
      $g.DrawString($plainItem, $font, [System.Drawing.Brushes]::Black, $bounds, $format)
      $y += [Math]::Ceiling($height) + ${itemGap}; $font.Dispose(); $format.Dispose(); continue
    }
    if ($line.StartsWith('__ITEMHEAD__') -or $line.StartsWith('__ITEM__')) {
      $cells = $line.Substring($(if ($line.StartsWith('__ITEMHEAD__')) { 12 } else { 8 })).Split('|')
      $isHead = $line.StartsWith('__ITEMHEAD__')
      $style = if ($isHead) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
      $size = ${itemFontSize}
      $font = New-Object System.Drawing.Font('${fontFamily}', $size, $style)
      $serialWidth = [Math]::Floor(${layout(settings.serialColumnWidth, 0, 40, 10)}); $columnGap = 4; $qtyWidth = [Math]::Max(28, [Math]::Floor(${layout(settings.quantityColumnWidth, 8, 60, 20)})); $priceWidth = [Math]::Max(46, [Math]::Floor(${layout(settings.priceColumnWidth, 15, 100, 40)})); $amountWidth = [Math]::Max(60, [Math]::Floor(${layout(settings.amountColumnWidth, 15, 120, 55)})); $itemMinWidth = [Math]::Floor(${layout(settings.itemNameMinWidth, 50, 220, 110)}); $maxColumns = [Math]::Max(40, $width - $itemMinWidth); $columnTotal = $qtyWidth + $priceWidth + $amountWidth + ($columnGap * 2)
      if ($columnTotal -gt $maxColumns) { $scale = $maxColumns / $columnTotal; $qtyWidth = [Math]::Max(25, [Math]::Floor($qtyWidth * $scale)); $priceWidth = [Math]::Max(40, [Math]::Floor($priceWidth * $scale)); $amountWidth = [Math]::Max(52, $maxColumns - $qtyWidth - $priceWidth - ($columnGap * 2)) }
      $labelWidth = [Math]::Max(50, $width - $qtyWidth - $priceWidth - $amountWidth - ($columnGap * 2))
      $left = $event.MarginBounds.Left
      $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near
      $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far
      $label = if ($cells.Count -gt 0) { $cells[0] } else { '' }; $serial = ''
      if (-not $isHead -and $label -match '^(\\d+\\.\\s+)(.*)$') { $serial = $matches[1]; $label = $matches[2] }
      $contentLeft = $left; $contentWidth = $labelWidth
      if ($serial) { $g.DrawString($serial, $font, [System.Drawing.Brushes]::Black, [single]$left, [single]$y); $contentLeft += $serialWidth; $contentWidth = [Math]::Max(50, $labelWidth - $serialWidth) }
      $labelLines = New-Object System.Collections.Generic.List[string]; $pending = ''
      foreach ($word in $label.Split(' ')) { $candidate = if ($pending) { "$pending $word" } else { $word }; if ($pending -and $g.MeasureString($candidate, $font).Width -gt $contentWidth) { $labelLines.Add($pending); $pending = $word } else { $pending = $candidate } }
      if ($pending) { $labelLines.Add($pending) }; if ($labelLines.Count -eq 0) { $labelLines.Add('') }
      $lineHeight = [Math]::Ceiling($g.MeasureString('Ag', $font).Height); $rowHeight = [Math]::Max([Math]::Max($labelLines.Count * $lineHeight, $lineHeight), ${itemMinHeight})
      for ($labelIndex = 0; $labelIndex -lt $labelLines.Count; $labelIndex++) { $g.DrawString($labelLines[$labelIndex], $font, [System.Drawing.Brushes]::Black, [single]$contentLeft, [single]($y + ($labelIndex * $lineHeight))) }
      $qtyText = if ($cells.Count -gt 1) { $cells[1] } else { '' }; $priceText = if ($cells.Count -gt 2) { $cells[2] } else { '' }; $amountText = if ($cells.Count -gt 3) { $cells[3] } else { '' }
      $qtyX = $left + $labelWidth + $qtyWidth - $g.MeasureString($qtyText, $font).Width; $priceX = $left + $labelWidth + $qtyWidth + $columnGap + $priceWidth - $g.MeasureString($priceText, $font).Width; $amountX = $left + $labelWidth + $qtyWidth + $columnGap + $priceWidth + $columnGap + $amountWidth - $g.MeasureString($amountText, $font).Width
      $g.DrawString($qtyText, $font, [System.Drawing.Brushes]::Black, [single]$qtyX, [single]$y)
      $g.DrawString($priceText, $font, [System.Drawing.Brushes]::Black, [single]$priceX, [single]$y)
      $g.DrawString($amountText, $font, [System.Drawing.Brushes]::Black, [single]$amountX, [single]$y)
      $y += [Math]::Ceiling($rowHeight) + $(if ($isHead) { 5 } else { ${itemGap} }); $font.Dispose(); $near.Dispose(); $right.Dispose(); continue
    }
    if ($line.StartsWith('__COMPACTHEAD__') -or $line.StartsWith('__COMPACTITEM__')) {
      $isHead = $line.StartsWith('__COMPACTHEAD__')
      $prefixLength = if ($isHead) { 15 } else { 15 }
      $cells = $line.Substring($prefixLength).Split('|')
      $style = if ($isHead) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
      $font = New-Object System.Drawing.Font('Consolas', [Math]::Min(${itemFontSize}, 9), $style)
      $qtyWidth = 23; $priceWidth = 47; $amountWidth = 52; $labelWidth = [Math]::Max(68, $width - $qtyWidth - $priceWidth - $amountWidth)
      $left = $event.MarginBounds.Left; $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near; $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far
      $label = if ($cells.Count -gt 0) { $cells[0] } else { '' }; $qty = if ($cells.Count -gt 1) { $cells[1] } else { '' }; $price = if ($cells.Count -gt 2) { $cells[2] } else { '' }; $amount = if ($cells.Count -gt 3) { $cells[3] } else { '' }
      $rowHeight = [Math]::Max($g.MeasureString($label, $font, $labelWidth, $near).Height, $g.MeasureString('Ag', $font).Height)
      $g.DrawString($label, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left, $y, $labelWidth, $rowHeight + 3)), $near)
      $g.DrawString($qty, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth, $y, $qtyWidth, $rowHeight + 3)), $right)
      $g.DrawString($price, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth + $qtyWidth, $y, $priceWidth, $rowHeight + 3)), $right)
      $g.DrawString($amount, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth + $qtyWidth + $priceWidth, $y, $amountWidth, $rowHeight + 3)), $right)
      $y += [Math]::Ceiling($rowHeight) + $(if ($isHead) { 5 } else { 4 }); $font.Dispose(); $near.Dispose(); $right.Dispose(); continue
    }
    if ($line.StartsWith('__COMPACTTOTAL__')) {
      $cells = $line.Substring(16).Split('|'); $font = New-Object System.Drawing.Font('Consolas', [Math]::Min(${totalFontSize}, 10), [System.Drawing.FontStyle]::Bold); $left = $event.MarginBounds.Left
      $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near; $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far; $height = $g.MeasureString('Ag', $font).Height
      $g.DrawString($(if ($cells.Count -gt 0) { $cells[0] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left, $y, $width * .7, $height + 3)), $near)
      $g.DrawString($(if ($cells.Count -gt 1) { $cells[1] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + ($width * .7), $y, $width * .3, $height + 3)), $right)
      $y += [Math]::Ceiling($height) + 4; $font.Dispose(); $near.Dispose(); $right.Dispose(); continue
    }
    if ($line.StartsWith('__SUMMARY__') -or $line.StartsWith('__TOTAL__')) {
      $cells = $line.Substring($(if ($line.StartsWith('__SUMMARY__')) { 11 } else { 9 })).Split('|')
      $isTotal = $line.StartsWith('__TOTAL__'); $style = if ($isTotal) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }; $size = if ($isTotal) { ${totalFontSize} } else { ${dateBillFontSize} }
      $font = New-Object System.Drawing.Font('${fontFamily}', $size, $style); $left = $event.MarginBounds.Left
      # The subtotal spans the full printable width. Grand Total may be inset
      # per printer, using its saved Grand total content width setting.
      if ($isTotal -and ${paperWidth} -eq 80) { $rowWidth = [Math]::Min($width, ${grandTotalWidth}); $left += [Math]::Max(0, ($width - $rowWidth) / 2) } else { $rowWidth = $width }
      $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near; $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far
      $height = $g.MeasureString('Ag', $font).Height
      $summaryLeft = if ($cells.Count) { $cells[0] } else { '' }; $summaryRight = if ($cells.Count -gt 1) { $cells[1] } else { '' }
      $summaryLine = if ($isTotal) { ('{0}: {1}' -f $summaryLeft, $summaryRight) } else { ('{0}    {1}' -f $summaryLeft, $summaryRight) }
      $g.DrawString($summaryLine, $font, [System.Drawing.Brushes]::Black, [single]$left, [single]$y)
      $y += [Math]::Ceiling($height) + $(if ($isTotal) { 6 } else { 3 }); $font.Dispose(); $near.Dispose(); $right.Dispose(); continue
    }
    if ($line.StartsWith('__KOTHEADER__')) { $displayLine = $line.Substring(13); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${kotHeaderFontSize} }
    elseif ($line.StartsWith('__KOTTITLE__')) { $displayLine = $line.Substring(12); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${kotTitleFontSize} }
    elseif ($line.StartsWith('__KOTCENTERMETABOLD__')) { $displayLine = $line.Substring(21); $alignment = [System.Drawing.StringAlignment]::Center; $style = [System.Drawing.FontStyle]::Bold; $size = ${kotMetaFontSize} }
    elseif ($line.StartsWith('__KOTCENTERMETA__')) { $displayLine = $line.Substring(17); $alignment = [System.Drawing.StringAlignment]::Center; $size = ${kotMetaFontSize} }
    elseif ($line.StartsWith('__KOTMETA__')) { $displayLine = $line.Substring(11); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${kotMetaFontSize} }
    elseif ($line.StartsWith('__KOTMETABOLD__')) { $displayLine = $line.Substring(15); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${kotMetaFontSize} }
    elseif ($line.StartsWith('__KOTITEM__')) { $displayLine = $line.Substring(11); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${kotItemFontSize} }
    elseif ($line.StartsWith('__KOTNOTE__')) { $displayLine = $line.Substring(11); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${kotMetaFontSize} }
    elseif ($line.StartsWith('__KOTFOOTER__')) { $displayLine = $line.Substring(13); $style = [System.Drawing.FontStyle]::${footerStyle}; $size = ${kotFooterFontSize} }
    elseif ($line.StartsWith('__KOT_PRINTER__')) { $displayLine = $line.Substring(15); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${kotTitleFontSize} }
    elseif ($line.StartsWith('__TITLE__')) { $displayLine = $line.Substring(9); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${restaurantFontSize} }
    elseif ($line.StartsWith('__BILLTITLE__')) { $displayLine = $line.Substring(13); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${restaurantFontSize} }
    elseif ($line.StartsWith('__BILLHEADER__')) { $displayLine = $line.Substring(14); $style = [System.Drawing.FontStyle]::Bold; $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__SUBTITLE__')) { $displayLine = $line.Substring(12); $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__FOOTER__')) { $displayLine = $line.Substring(10); $style = [System.Drawing.FontStyle]::${footerStyle}; $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__DATEBILL__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__META__')) { $displayLine = $line.Substring(8); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__METABOLD__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__CENTER__')) { $displayLine = $line.Substring(10) }
    elseif ($line.StartsWith('__LEFT__')) { $displayLine = $line.Substring(8); $alignment = [System.Drawing.StringAlignment]::Near }
    elseif ($line.StartsWith('__MONO__')) { $displayLine = $line.Substring(8); $alignment = [System.Drawing.StringAlignment]::Near; $size = 13; $fontName = 'Consolas' }
    elseif ($line.StartsWith('__LABEL__')) { $displayLine = $line.Substring(9); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__ITEMLABEL__')) { $displayLine = $line.Substring(13); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${itemFontSize} }
    elseif ($line.StartsWith('__ITEMTEXT__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${itemFontSize} }
    elseif ($line.StartsWith('__GRIDHEAD__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = [Math]::Min(10, ${itemFontSize}); $fontName = 'Consolas' }
    elseif ($line.StartsWith('__GRID__')) { $displayLine = $line.Substring(8); $alignment = [System.Drawing.StringAlignment]::Near; $size = [Math]::Min(10, ${itemFontSize}); $fontName = 'Consolas' }
    elseif ($line.StartsWith('__GRAND__')) { $displayLine = $line.Substring(9); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${totalFontSize} }
    elseif ($line.StartsWith('__TABLE__')) { $displayLine = $line.Substring(9); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${itemFontSize} }
    elseif ($line.StartsWith('__TABLEHEAD__')) { $displayLine = $line.Substring(13); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${totalFontSize} }
    elseif ($line -match '^(KOT|Order) #') { $style = [System.Drawing.FontStyle]::Bold; $size = 15 }
    elseif ($line -match '^\\d+x ') { $style = [System.Drawing.FontStyle]::Bold; $size = 11 }
    if ($line.StartsWith('__SUBTITLE__') -or $line.StartsWith('__CENTER__')) { $size = $bodySize }
    if (-not $fontName) { $fontName = '${fontFamily}' }
    $font = New-Object System.Drawing.Font($fontName, $size, $style)
    $format = New-Object System.Drawing.StringFormat; $format.Alignment = $alignment
    if ($line -match '^\\d+x ') { $format.Alignment = [System.Drawing.StringAlignment]::Near }
    $bounds = New-Object System.Drawing.RectangleF($event.MarginBounds.Left, $y, $width, 200)
    $height = $g.MeasureString($displayLine, $font, $width, $format).Height
    $g.DrawString($displayLine, $font, [System.Drawing.Brushes]::Black, $bounds, $format)
    $extra = if ($line.StartsWith('__TABLE__') -or $line.StartsWith('__KOTITEM__')) { ${itemGap} } elseif ($line.StartsWith('__SEPARATOR__')) { ${separatorGap} } elseif ($line.StartsWith('__META__') -or $line.StartsWith('__MONO__')) { 0 } else { 1 }; $y += [Math]::Max([Math]::Ceiling($height), ${itemMinHeight}) + $extra; $font.Dispose(); $format.Dispose()
  }
})
$doc.Print()`;
      await run('powershell.exe', ['-NoProfile', '-Command', script]);
    } else {
      await run('lp', ['-d', printerName, file]);
    }
  } finally {
    await fs.unlink(file).catch(() => {});
  }
}

function kotHighlightLabels(items) {
  const words = (value) =>
    String(value || '')
      .toLowerCase()
      .match(/[a-z]+/g) || [];
  const labels = items.map(
    (item) =>
      `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` ${item.style}` : ''}`
  );
  const sets = labels.map((label) => new Set(words(label)));
  return labels.map((label, index) => {
    if (labels.length < 2) return label;
    const own = [...sets[index]];
    let nearest = null,
      overlap = -1;
    sets.forEach((candidate, candidateIndex) => {
      if (candidateIndex === index) return;
      const shared = own.filter((word) => candidate.has(word)).length;
      if (shared > overlap) {
        overlap = shared;
        nearest = candidate;
      }
    });
    const distinctive = own
      .filter((word) => !nearest?.has(word))
      .sort((a, b) => b.length - a.length)[0];
    if (!distinctive) return label;
    return label.replace(new RegExp(`\\b(${distinctive})\\b`, 'i'), '[[$1]]');
  });
}

function kotText(payload) {
  const order = payload.order || {};
  const settings = payload.settings || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const tableLine = order.tableArea || order.tableNumber
    ? `Table: ${order.tableArea || 'Dining'} · ${order.tableNumber || '—'}`
    : order.fulfillment
      ? `Order: ${order.fulfillment}`
      : '';
  const guestLine = `Guest: ${order.customer || 'Walk-in customer'}`;
  const labels = kotHighlightLabels(items);
  const rows = items.flatMap((item, index) =>
    [
      // KOTs always lead with quantity. This is the kitchen's agreed format,
      // not a per-printer preference.
      `__KOTITEM__${Number(item.quantity || 0)}x ${labels[index]}`,
      item.note ? `__KOTNOTE__↳ ${item.note}` : '',
    ].filter(Boolean)
  );
  const savedFeed = Number(settings.kotBottomFeedLines);
  const bottomLines =
    (Number.isFinite(savedFeed) ? Math.max(0, Math.min(12, savedFeed)) : 3) +
    Math.max(0, Math.min(2, Number(settings.extraSpace) || 0)) * 2;
  return [
    `__KOTTITLE__${String(payload.printerLabel || payload.printerName || 'Kitchen').trim()}`,
    '__KOTRULE__',
    `__KOTMETABOLD__KOT # ${order.kotNumber || '—'}`,
    tableLine ? `__KOTMETA__${tableLine}` : '',
    `__KOTMETA__${guestLine}`,
    order.reprint ? '__KOTMETABOLD__*** REPRINT ***' : '',
    '__KOTRULE__',
    ...rows,
    order.note && settings.showNotes !== false ? `__KOTNOTE__Note: ${order.note}` : '',
    '__KOTRULE__',
    '\n'.repeat(bottomLines),
  ]
    .filter(Boolean)
    .join('\n');
}
function billText(payload) {
  const order = payload.order || {},
    settings = payload.settings || {},
    items = Array.isArray(order.items) ? order.items : [],
    line = '__SEPARATOR__';
  const sectionHeight = (key, fallback) =>
    Math.max(0, Math.min(500, Number(settings[key]) || fallback));
  const money = (value) => `₹${Math.round(Number(value) || 0)}`;
  const decimal = (value) => (Number(value) || 0).toFixed(2);
  const itemPrice = (item) =>
    Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
  const subtotal = items.reduce(
    (sum, item) => sum + itemPrice(item) * Number(item.quantity || 0),
    0
  );
  const total = Number(order.total) > 0 ? Number(order.total) : subtotal;
  const walletDiscount = Math.max(0, Math.floor(Number(order.loyalty_points_redeemed || 0)));
  const itemRows = items.flatMap((item, index) => {
    const label = `${settings.showItemSerial ? `${index + 1}. ` : ''}${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}`;
    const quantity = Number(item.quantity || 0),
      unit = itemPrice(item),
      itemAmount = quantity * unit;
    return [
      `__ITEM__${label}|${quantity}|${decimal(unit)}|${decimal(itemAmount)}`,
      item.style ? `__ITEM__  ${item.style} gravy|||` : '',
    ].filter(Boolean);
  });
  const token = String(order.daily_order_number || '—').padStart(2, '0');
  const placedAt = order.created_at ? new Date(order.created_at) : new Date();
  const placedDate = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).format(placedAt);
  const placedTime = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(placedAt);
  const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const billNumber = order.bill_number ? String(order.bill_number).padStart(2, '0') : '—';
  const customer = String(order.customer_name || '').trim();
  const phone = String(order.customer_phone || '').replace(/^walkin-.*$/i, '');
  const service =
    order.mode === 'table'
      ? `Dine In · ${order.table_area || 'Table'} ${order.table_number || ''}`.trim()
      : order.fulfillment_type === 'delivery'
        ? 'Delivery'
        : 'Parcel';
  const customerLine = customer
    ? `Name: ${customer}${phone ? ` (M: ${phone})` : ''}`
    : phone
      ? `Mobile: ${phone}`
      : 'Name: Walk-in customer';
  // Keep this as the same compact three-line block as the measured reference:
  // date/order type, cashier/bill number, then the emphasised token.
  const details = [
    line,
    `__META__${customerLine}`,
    `__META__Date: ${placedDate} ${placedTime}          ${service}`,
    `__META__Cashier: biller       Bill No.: ${billNumber}`,
    `__METABOLD__Token No.: ${token}`,
    line,
  ];
  const itemHeader = '__ITEMHEAD__Item|Qty|Price|Amount';
  const totals = [
    `__SUMMARY__Total Qty: ${quantity}|Sub Total: ${money(subtotal)}`,
    walletDiscount ? `__SUMMARY__Points discount|-${money(walletDiscount)}` : '',
  ];
  const defaultHeader =
    'Colva Goa\n9922853605 / 9049558369\n[Follow] Insta ID:\nred_lantern_restaurant';
  const defaultFooter =
    'Thank you for choosing us!\nKindly leave us a review\nGoogle | Zomato | Swiggy';
  return [
    settings.reprint ? '__CENTER__*** REPRINT ***' : '',
    settings.showRestaurantName === false
      ? ''
      : `__BILLTITLE__${settings.restaurantName || 'Red Lantern Restaurant'}`,
    `__BILLHEADER__${settings.receiptHeader || defaultHeader}`,
    line,
    `__META__${customerLine}`,
    line,
    ...details.slice(2, -1),
    line,
    itemHeader,
    line,
    ...itemRows,
    line,
    ...totals,
    `__TOTAL__GRAND TOTAL|${money(total)}`,
    line,
    `__FOOTER__${settings.receiptFooter || defaultFooter}`,
    '\n\n\n',
  ]
    .filter(Boolean)
    .join('\n');
}

function allowedOrigin(request) {
  const origin = request.headers.origin || '';
  if (
    !origin ||
    /^https:\/\/(www\.)?redlanternrestaurant\.in$/i.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
  )
    return origin || '*';
  return '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 512000) reject(new Error('Request too large.'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function reply(res, status, body, origin = '') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (req.headers.origin && !origin)
    return reply(res, 403, { error: 'This website is not allowed to access the Print Bridge.' });
  if (req.method === 'OPTIONS') return reply(res, 204, {}, origin);
  if (req.method === 'GET' && req.url === '/health') {
    try {
      localLedger().prepare('SELECT 1 AS ok').get();
    } catch (error) {
      return reply(
        res,
        503,
        {
          ok: false,
          service: 'Red Lantern Print Bridge',
          error: 'The local SQLite ledger is unavailable.',
          detail: error.message,
        },
        origin
      );
    }
    return reply(
      res,
      200,
      {
        ok: true,
        service: 'Red Lantern Print Bridge',
        version: BRIDGE_VERSION,
        platform: process.platform,
        node: process.version,
        ledger: 'ready',
        ledgerSummary: ledgerSummary(),
      },
      origin
    );
  }
  if (req.method === 'GET' && req.url === '/v1/setup-status') {
    try {
      localLedger().prepare('SELECT 1 AS ok').get();
      const [printers, config] = await Promise.all([
        installedPrinters(),
        readJson(configFile, { printers: [], routes: [] }),
      ]);
      const savedPrinters = Array.isArray(config.printers) ? config.printers : [];
      const savedRoutes = Array.isArray(config.routes) ? config.routes : [];
      const configuredPrinters = savedPrinters.filter((printer) =>
        String(printer.deviceName || '').trim()
      );
      const configuredKotIds = new Set(
        configuredPrinters
          .filter((printer) => printer.type === 'kot')
          .map((printer) => String(printer.id))
      );
      const configuredKotRoutes = savedRoutes.filter((route) =>
        configuredKotIds.has(String(route.printerId))
      );
      return reply(
        res,
        200,
        {
          ok: true,
          platform: process.platform,
          platformLabel:
            process.platform === 'win32'
              ? 'Windows'
              : process.platform === 'darwin'
                ? 'macOS'
                : process.platform,
          version: BRIDGE_VERSION,
          node: process.version,
          ledger: 'ready',
          printerCount: printers.length,
          configuredPrinterCount: configuredPrinters.length,
          configuredBillPrinterCount: configuredPrinters.filter(
            (printer) => printer.type === 'bill'
          ).length,
          configuredKotRouteCount: configuredKotRoutes.length,
          routeCount: savedRoutes.length,
          ledgerSummary: ledgerSummary(),
          recentPrintFailures: recentPrintFailures(),
        },
        origin
      );
    } catch (error) {
      return reply(
        res,
        503,
        { ok: false, error: 'Print Bridge needs attention.', detail: error.message },
        origin
      );
    }
  }
  if (req.method === 'POST' && req.url === '/v1/restart') {
    reply(res, 202, { ok: true, message: 'Print Bridge is restarting.' }, origin);
    setTimeout(() => {
      // The installed supervisor immediately replaces this child. Do not create
      // a detached process here: detached replacements escape Task Scheduler
      // and were the cause of later unrecovered bridge outages.
      if (process.env.PRINT_BRIDGE_SUPERVISED === '1') {
        server.close(() => process.exit(75));
        setTimeout(() => process.exit(75), 1000).unref();
        return;
      }
      const child = spawn(process.execPath, [__filename], {
        cwd: __dirname,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    }, 250).unref();
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/printers') {
    try {
      return reply(res, 200, { printers: await installedPrinters() }, origin);
    } catch (error) {
      return reply(
        res,
        500,
        { error: 'Unable to read installed printers.', detail: error.message },
        origin
      );
    }
  }
  if (req.method === 'GET' && req.url === '/v1/config') {
    try {
      return reply(
        res,
        200,
        { config: await readJson(configFile, { printers: [], routes: [] }) },
        origin
      );
    } catch (error) {
      return reply(
        res,
        500,
        { error: 'Unable to read local printer configuration.', detail: error.message },
        origin
      );
    }
  }
  if (req.method === 'PUT' && req.url === '/v1/config') {
    try {
      const config = (await readBody(req)).config || {};
      const printers = (Array.isArray(config.printers) ? config.printers : [])
        .slice(0, 250)
        .map((printer) => ({
          id: String(printer.id || '').slice(0, 60),
          name: String(printer.name || '')
            .trim()
            .slice(0, 60),
          type: printer.type === 'bill' ? 'bill' : 'kot',
          deviceId: String(printer.deviceId || '').slice(0, 160),
          deviceName: String(printer.deviceName || '').slice(0, 120),
        }))
        .filter((printer) => printer.id && printer.name);
      const printerIds = new Set(printers.map((printer) => printer.id));
      const routes = (Array.isArray(config.routes) ? config.routes : [])
        .slice(0, 2000)
        .map((route) => ({
          id: String(route.id || '').slice(0, 60),
          printerId: String(route.printerId || '').slice(0, 60),
          category: String(route.category || '')
            .trim()
            .slice(0, 100),
          itemName: String(route.itemName || '')
            .trim()
            .slice(0, 160),
        }))
        .filter((route) => route.id && printerIds.has(route.printerId) && route.category);
      const safeConfig = { printers, routes, savedAt: new Date().toISOString() };
      await writeJson(configFile, safeConfig);
      return reply(res, 200, { ok: true, savedAt: safeConfig.savedAt }, origin);
    } catch (error) {
      return reply(
        res,
        400,
        { error: error.message || 'Unable to save local printer configuration.' },
        origin
      );
    }
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/ledger/actions')) {
    try {
      const requested =
        new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('status') || 'queued';
      const statuses =
        requested === 'all'
          ? ['queued', 'syncing', 'blocked', 'synced']
          : requested
              .split(',')
              .filter((status) => ['queued', 'syncing', 'blocked'].includes(status));
      const rows = statuses.length
        ? localLedger()
            .prepare(
              `SELECT * FROM ledger_actions WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 500`
            )
            .all(...statuses)
        : [];
      return reply(res, 200, { actions: rows.map(ledgerAction) }, origin);
    } catch (error) {
      return reply(
        res,
        500,
        { error: 'Unable to read the local order ledger.', detail: error.message },
        origin
      );
    }
  }
  if (req.method === 'POST' && req.url === '/v1/print-jobs/acknowledge') {
    try {
      const body = await readBody(req);
      return reply(res, 200, { ok: true, acknowledged: acknowledgePrintJobs(body.ids) }, origin);
    } catch (error) {
      return reply(
        res,
        400,
        { error: error.message || 'Unable to acknowledge print jobs.' },
        origin
      );
    }
  }
  if (req.method === 'POST' && req.url === '/v1/ledger/actions') {
    try {
      return reply(res, 201, { ok: true, action: queueLedgerAction(await readBody(req)) }, origin);
    } catch (error) {
      return reply(
        res,
        400,
        { error: error.message || 'Unable to save the offline order.' },
        origin
      );
    }
  }
  const ledgerUpdateMatch = req.url.match(/^\/v1\/ledger\/actions\/([^/]+)\/(synced|blocked)$/);
  if (req.method === 'POST' && ledgerUpdateMatch) {
    try {
      const body = await readBody(req);
      return reply(
        res,
        200,
        {
          ok: true,
          action: updateLedgerAction(
            decodeURIComponent(ledgerUpdateMatch[1]),
            ledgerUpdateMatch[2],
            body.error
          ),
        },
        origin
      );
    } catch (error) {
      return reply(
        res,
        400,
        { error: error.message || 'Unable to update the offline order.' },
        origin
      );
    }
  }
  if (req.method === 'GET' && req.url === '/v1/kot-queue') {
    try {
      return reply(res, 200, { jobs: await readJson(queueFile, []) }, origin);
    } catch (error) {
      return reply(
        res,
        500,
        { error: 'Unable to read local KOT queue.', detail: error.message },
        origin
      );
    }
  }
  if (req.method === 'POST' && req.url === '/v1/kot-queue') {
    try {
      const payload = await readBody(req);
      const printerId = String(payload.printerId || '').slice(0, 60);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerId || !items.length)
        throw new Error('A KOT needs a printer and at least one item.');
      const jobs = await readJson(queueFile, []);
      const job = {
        id: crypto.randomUUID(),
        status: 'queued',
        queuedAt: new Date().toISOString(),
        order: payload.order || null,
        printerId,
        items,
      };
      jobs.push(job);
      await writeJson(queueFile, jobs.slice(-1000));
      return reply(res, 201, { ok: true, job }, origin);
    } catch (error) {
      return reply(res, 400, { error: error.message || 'Unable to queue KOT.' }, origin);
    }
  }
  if (req.method === 'POST' && req.url === '/v1/print-kot') {
    let printJobId = '';
    try {
      const payload = await readBody(req);
      printJobId = String(payload.printJobId || '');
      const printerName = String(payload.printerName || '')
        .trim()
        .slice(0, 160);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerName || !items.length)
        throw new Error('A printer and at least one KOT item are required.');
      const ticketText = kotText({ ...payload, items });
      const contentHash = crypto.createHash('sha256').update(ticketText).digest('hex');
      const claim = claimPrintJob(payload.printJobId, 'kot', printerName, contentHash);
      if (!claim.claim)
        return reply(
          res,
          claim.duplicate ? 200 : 202,
          { ok: true, duplicate: !!claim.duplicate, pending: !!claim.pending, printerName },
          origin
        );
      await printText(printerName, ticketText, payload.settings || {});
      finishPrintJob(payload.printJobId, true);
      return reply(res, 201, { ok: true, printerName, itemCount: items.length }, origin);
    } catch (error) {
      try {
        finishPrintJob(printJobId, false);
      } catch (_) {}
      return reply(res, 400, { error: error.message || 'Unable to print KOT.' }, origin);
    }
  }
  if (req.method === 'POST' && req.url === '/v1/print-bill') {
    let printJobId = '';
    try {
      const payload = await readBody(req);
      printJobId = String(payload.printJobId || '');
      const printerName = String(payload.printerName || '')
        .trim()
        .slice(0, 160);
      if (!printerName || !payload.order?.id)
        throw new Error('A bill printer and order are required.');
      const claim = claimPrintJob(payload.printJobId, 'bill', printerName);
      if (!claim.claim)
        return reply(
          res,
          claim.duplicate ? 200 : 202,
          { ok: true, duplicate: !!claim.duplicate, pending: !!claim.pending, printerName },
          origin
        );
      await printText(printerName, billText(payload), payload.settings || {});
      finishPrintJob(payload.printJobId, true);
      return reply(res, 201, { ok: true, printerName }, origin);
    } catch (error) {
      try {
        finishPrintJob(printJobId, false);
      } catch (_) {}
      return reply(res, 400, { error: error.message || 'Unable to print bill.' }, origin);
    }
  }
  return reply(res, 404, { error: 'Not found.' }, origin);
});
server.on('error', (error) => {
  console.error(`Red Lantern Print Bridge could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Red Lantern Print Bridge is running at http://127.0.0.1:${PORT}`);
});
