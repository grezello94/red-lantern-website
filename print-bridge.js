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
const storageDir = process.env.PRINT_BRIDGE_DATA_DIR || path.join(os.homedir(), '.red-lantern-print-bridge');
const configFile = path.join(storageDir, 'printer-config.json');
const queueFile = path.join(storageDir, 'kot-queue.json');
const ledgerFile = path.join(storageDir, 'orders-ledger.sqlite');
let ledger = null;

function localLedger() {
  if (ledger) return ledger;
  fsSync.mkdirSync(storageDir, { recursive:true });
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
  ledger.exec('CREATE INDEX IF NOT EXISTS ledger_actions_status_created ON ledger_actions(status, created_at)');
  ledger.exec(`CREATE TABLE IF NOT EXISTS print_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    printer_name TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  return ledger;
}

function claimPrintJob(id, kind, printerName) {
  const safeId=String(id || '').trim().slice(0,160);
  if (!safeId) return { claim:true, tracked:false };
  const db=localLedger(), now=new Date().toISOString();
  const existing=db.prepare('SELECT status FROM print_jobs WHERE id=?').get(safeId);
  if (existing?.status === 'printed') return { claim:false, duplicate:true };
  if (existing?.status === 'printing') return { claim:false, pending:true };
  db.prepare('INSERT INTO print_jobs (id,kind,printer_name,status,created_at,completed_at) VALUES (?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET status=excluded.status, printer_name=excluded.printer_name, created_at=excluded.created_at, completed_at=NULL').run(safeId, kind, String(printerName||'').slice(0,160), 'printing', now);
  return { claim:true, tracked:true };
}
function finishPrintJob(id, success) {
  const safeId=String(id || '').trim().slice(0,160);
  if (!safeId) return;
  localLedger().prepare('UPDATE print_jobs SET status=?, completed_at=? WHERE id=?').run(success?'printed':'failed', success?new Date().toISOString():null, safeId);
}

function ledgerAction(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch (_) {}
  return { id:row.id, type:row.type, payload, status:row.status, attempts:Number(row.attempts || 0), lastError:row.last_error || '', createdAt:row.created_at, updatedAt:row.updated_at, syncedAt:row.synced_at || '' };
}

function queueLedgerAction(input) {
  const type = String(input.type || '');
  const id = String(input.id || input.payload?.clientRequestId || '').trim().slice(0, 120);
  const supportedTypes = new Set(['counter-order','order-status','order-items','order-table','kitchen-status','availability-update','operations-config','table-areas','settlement']);
  if (!supportedTypes.has(type) || !id) throw new Error('This offline action needs a unique action ID.');
  const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : null;
  if (!payload) throw new Error('Offline action details are required.');
  if (type === 'counter-order' && (!Array.isArray(payload.items) || !payload.items.length)) throw new Error('An offline order needs at least one item.');
  const encoded = JSON.stringify(payload);
  if (encoded.length > 250000) throw new Error('Offline order is too large to store locally.');
  const now = new Date().toISOString();
  const db = localLedger();
  db.prepare('INSERT INTO ledger_actions (id,type,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id, type, encoded, 'queued', now, now);
  return ledgerAction(db.prepare('SELECT * FROM ledger_actions WHERE id=?').get(id));
}

function updateLedgerAction(id, status, error = '') {
  const safeId = String(id || '').slice(0, 120);
  if (!safeId || !['queued','syncing','synced','blocked'].includes(status)) throw new Error('Invalid ledger action update.');
  const now = new Date().toISOString();
  const db = localLedger();
  const existing = db.prepare('SELECT id FROM ledger_actions WHERE id=?').get(safeId);
  if (!existing) throw new Error('Offline action was not found.');
  db.prepare('UPDATE ledger_actions SET status=?, attempts=attempts+1, last_error=?, updated_at=?, synced_at=? WHERE id=?').run(status, String(error || '').slice(0, 500), now, status === 'synced' ? now : null, safeId);
  return ledgerAction(db.prepare('SELECT * FROM ledger_actions WHERE id=?').get(safeId));
}

function ledgerSummary() {
  const rows = localLedger().prepare("SELECT status, COUNT(*) AS count FROM ledger_actions GROUP BY status").all();
  const counts = { queued:0, syncing:0, blocked:0, synced:0 };
  rows.forEach((row) => { if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count || 0); });
  const jobs = localLedger().prepare("SELECT status, COUNT(*) AS count FROM print_jobs GROUP BY status").all();
  const printJobs = { printing:0, printed:0, failed:0 };
  jobs.forEach((row) => { if (Object.hasOwn(printJobs, row.status)) printJobs[row.status] = Number(row.count || 0); });
  return { actions:counts, pendingActions:counts.queued + counts.syncing, blockedActions:counts.blocked, printJobs };
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
      ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name']],
      ['powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']],
      ['wmic.exe', ['printer', 'get', 'name', '/value']]
    ];
    const failures = [];
    for (const [command, args] of attempts) {
      try { output = await run(command, args); break; }
      catch (error) { failures.push(error.message); }
    }
    if (!output && failures.length === attempts.length) {
      throw new Error('Windows could not read installed printers. Confirm the Print Spooler is running and install the printer manufacturer’s Windows driver.');
    }
    const names = output.includes('Name=')
      ? output.split(/\r?\n/).map((line) => line.replace(/^Name=/i, ''))
      : output.split(/\r?\n/);
    return formatPrinters(names);
  }
  if (process.platform === 'darwin') {
    try { output = await run('lpstat', ['-p']); }
    catch (_) { throw new Error('macOS printing is unavailable. Add the printer in System Settings > Printers & Scanners, then install its AirPrint or manufacturer driver.'); }
    return formatPrinters(output.split(/\r?\n/).map((line) => {
      const match = line.match(/^printer\s+([^\s]+)/i);
      return match ? match[1] : '';
    }));
  } else {
    try { output = await run('lpstat', ['-p']); }
    catch (_) { throw new Error('CUPS printer discovery is unavailable. Install and configure CUPS and the printer driver.'); }
    return formatPrinters(output.split(/\r?\n/).map((line) => {
      const match = line.match(/^printer\s+([^\s]+)/i);
      return match ? match[1] : '';
    }));
  }
}

function formatPrinters(names) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
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
      const fontFamily = ['Arial','Calibri','Verdana','Tahoma','Trebuchet MS','Georgia','Times New Roman','Courier New','Consolas','Lucida Console'].includes(String(settings.fontFamily)) ? String(settings.fontFamily).replace(/'/g, "''") : 'Arial';
      const bodyFontSize = Math.max(8, Math.min(13, Number(settings.fontSize) || 10));
      const headerFontSize = Math.max(12, Math.min(18, Number(settings.headerFontSize) || 15));
      const headerStyle = settings.headerBold === false ? 'Regular' : 'Bold';
      const footerStyle = settings.footerBold ? 'Bold' : 'Regular';
      const layout = (value, min, max, fallback) => Math.max(min, Math.min(max, Number(value) || fallback));
      const configuredMainWidth = layout(settings.billingMainWidth, 160, 400, 280), mainWidth = paperWidth === 80 ? Math.max(300, configuredMainWidth) : configuredMainWidth, leftMargin = layout(settings.billingOuterLeft, 0, 40, 0), rightMargin = layout(settings.billingOuterRight, 0, 40, 0), topMargin = layout(settings.billingOuterTop, 0, 40, 0), bottomMargin = layout(settings.billingOuterBottom, 0, 40, 0);
      const restaurantFontSize = layout(settings.restaurantNameFontSize, 8, 24, 14), headerFooterFontSize = layout(settings.headerFooterFontSize, 8, 20, 13), dateBillFontSize = layout(settings.dateBillFontSize, 8, 20, 13), itemFontSize = layout(settings.itemListingFontSize, 8, 20, 13), totalFontSize = layout(settings.grandTotalFontSize, 10, 26, 14), itemGap = layout(settings.itemRowGap, 0, 20, 5), separatorGap = layout(settings.separatorGap, 0, 20, 5), itemMinHeight = layout(settings.billingItemBoxHeight, 0, 40, 0);
      const script = `Add-Type -AssemblyName System.Drawing
$lines = Get-Content -LiteralPath '${quote(file)}' -Encoding UTF8
$doc = New-Object System.Drawing.Printing.PrintDocument
$doc.PrinterSettings.PrinterName = '${quote(printerName)}'
if (-not $doc.PrinterSettings.IsValid) { throw 'The selected Windows printer is no longer available.' }
# 79 mm rolls are configured by Windows drivers as 80 mm. Reuse that driver
# form (rather than forcing a page length) and keep a 72 mm printable column.
$minWidth = if (${paperWidth} -eq 58) { 220 } else { 300 }
$maxWidth = if (${paperWidth} -eq 58) { 240 } else { 320 }
$thermalPaper = @($doc.PrinterSettings.PaperSizes | Where-Object { $_.Width -ge $minWidth -and $_.Width -le $maxWidth } | Select-Object -First 1)
if ($thermalPaper.Count) { $doc.DefaultPageSettings.PaperSize = $thermalPaper[0] }
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(${leftMargin}, ${rightMargin}, ${topMargin}, ${bottomMargin})
$doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController
$doc.add_PrintPage({ param($sender, $event)
  $g = $event.Graphics; $width = [Math]::Min($event.MarginBounds.Width, ${mainWidth}); $y = $event.MarginBounds.Top
  $bodySize = ${bodyFontSize}
  foreach ($line in $lines) {
    $displayLine = $line; $style = [System.Drawing.FontStyle]::Regular; $size = $bodySize; $alignment = [System.Drawing.StringAlignment]::Center; $fontName = ''
    if ($line.StartsWith('__ITEMHEAD__') -or $line.StartsWith('__ITEM__')) {
      $cells = $line.Substring($(if ($line.StartsWith('__ITEMHEAD__')) { 12 } else { 8 })).Split('|')
      $isHead = $line.StartsWith('__ITEMHEAD__')
      $style = if ($isHead) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
      $size = ${itemFontSize}
      $font = New-Object System.Drawing.Font('${fontFamily}', $size, $style)
      $qtyWidth = [Math]::Floor(${layout(settings.quantityColumnWidth, 8, 60, 20)}); $priceWidth = [Math]::Floor(${layout(settings.priceColumnWidth, 15, 100, 40)}); $amountWidth = [Math]::Floor(${layout(settings.amountColumnWidth, 15, 120, 55)}); $labelWidth = [Math]::Max(70, $width - $qtyWidth - $priceWidth - $amountWidth)
      $left = $event.MarginBounds.Left
      $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near
      $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far
      $label = if ($cells.Count -gt 0) { $cells[0] } else { '' }
      $labelHeight = $g.MeasureString($label, $font, $labelWidth, $near).Height
      $rowHeight = [Math]::Max($labelHeight, $g.MeasureString('Ag', $font).Height)
      $g.DrawString($label, $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left, $y, $labelWidth, $rowHeight + 4)), $near)
      $g.DrawString($(if ($cells.Count -gt 1) { $cells[1] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth, $y, $qtyWidth, $rowHeight + 4)), $right)
      $g.DrawString($(if ($cells.Count -gt 2) { $cells[2] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth + $qtyWidth, $y, $priceWidth, $rowHeight + 4)), $right)
      $g.DrawString($(if ($cells.Count -gt 3) { $cells[3] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + $labelWidth + $qtyWidth + $priceWidth, $y, $amountWidth, $rowHeight + 4)), $right)
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
      $isTotal = $line.StartsWith('__TOTAL__'); $style = if ($isTotal) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }; $size = if ($isTotal) { [Math]::Max(13, $bodySize + 3) } else { $bodySize }
      $font = New-Object System.Drawing.Font('${fontFamily}', $size, $style); $left = $event.MarginBounds.Left
      $near = New-Object System.Drawing.StringFormat; $near.Alignment = [System.Drawing.StringAlignment]::Near; $right = New-Object System.Drawing.StringFormat; $right.Alignment = [System.Drawing.StringAlignment]::Far
      $height = $g.MeasureString('Ag', $font).Height
      $g.DrawString($(if ($cells.Count) { $cells[0] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left, $y, $width * .65, $height + 4)), $near)
      $g.DrawString($(if ($cells.Count -gt 1) { $cells[1] } else { '' }), $font, [System.Drawing.Brushes]::Black, (New-Object System.Drawing.RectangleF($left + ($width * .65), $y, $width * .35, $height + 4)), $right)
      $y += [Math]::Ceiling($height) + $(if ($isTotal) { 6 } else { 3 }); $font.Dispose(); $near.Dispose(); $right.Dispose(); continue
    }
    if ($line.StartsWith('__KOT_PRINTER__')) { $displayLine = $line.Substring(15); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__TITLE__')) { $displayLine = $line.Substring(9); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${restaurantFontSize} }
    elseif ($line.StartsWith('__BILLTITLE__')) { $displayLine = $line.Substring(13); $style = [System.Drawing.FontStyle]::${headerStyle}; $size = ${restaurantFontSize} }
    elseif ($line.StartsWith('__BILLHEADER__')) { $displayLine = $line.Substring(14); $style = [System.Drawing.FontStyle]::Bold; $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__SUBTITLE__')) { $displayLine = $line.Substring(12); $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__FOOTER__')) { $displayLine = $line.Substring(10); $style = [System.Drawing.FontStyle]::${footerStyle}; $size = ${headerFooterFontSize} }
    elseif ($line.StartsWith('__DATEBILL__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__META__')) { $displayLine = $line.Substring(8); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__METABOLD__')) { $displayLine = $line.Substring(12); $alignment = [System.Drawing.StringAlignment]::Near; $style = [System.Drawing.FontStyle]::Bold; $size = ${dateBillFontSize} }
    elseif ($line.StartsWith('__SEPARATOR__')) { $displayLine = $line.Substring(13); $alignment = [System.Drawing.StringAlignment]::Near; $size = ${itemFontSize} }
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
    $extra = if ($line.StartsWith('__TABLE__')) { ${itemGap} } elseif ($line.StartsWith('__SEPARATOR__')) { ${separatorGap} } elseif ($line.StartsWith('__META__') -or $line.StartsWith('__MONO__')) { 0 } else { 1 }; $y += [Math]::Max([Math]::Ceiling($height), ${itemMinHeight}) + $extra; $font.Dispose(); $format.Dispose()
  }
})
$doc.Print()`;
      await run('powershell.exe', ['-NoProfile', '-Command', script]);
    } else {
      await run('lp', ['-d', printerName, file]);
    }
  } finally { await fs.unlink(file).catch(() => {}); }
}

function kotText(payload) {
  const order = payload.order || {};
  const settings = payload.settings || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const line = '-'.repeat(34);
  const placed = order.createdAt ? new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(order.createdAt)) : '';
  const guestLine = `Guest: ${order.customer || 'Guest'}${order.fulfillment ? ` · ${order.fulfillment}` : ''}${placed ? ` · ${placed}` : ''}${order.phone ? ` · ${order.phone}` : ''}`;
  const quantityFirst = settings.quantityFirst !== false;
  const rows = items.map((item, index) => `${settings.showItemSerial ? `${index + 1}. ` : ''}${quantityFirst ? `${Number(item.quantity || 0)}x ` : ''}${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` · ${item.style}` : ''}${quantityFirst ? '' : ` · ${Number(item.quantity || 0)}x`}`);
  const sourceLine = order.fulfillment ? `From: ${order.fulfillment}` : `Order #${order.number || order.id || '—'}`;
  return [settings.receiptHeader || '', `__KOT_PRINTER__${String(payload.printerLabel || payload.printerName || 'Kitchen').trim()}`, order.reprint ? '*** REPRINT ***' : '', line, `KOT #${order.kotNumber || '—'}`, sourceLine, settings.showCustomer !== false ? guestLine : '', line, ...rows, order.note && settings.showNotes !== false ? `${line}\nNote: ${order.note}` : '', line, settings.receiptFooter || '', '\n\n\n'].filter(Boolean).join('\n');
}
function billText(payload) {
  const order = payload.order || {}, settings = payload.settings || {}, items = Array.isArray(order.items) ? order.items : [], line = `__SEPARATOR__${'-'.repeat(Number(settings.paperWidth) === 58 ? 34 : 42)}`;
  const money = (value) => `₹${Math.round(Number(value) || 0)}`;
  const decimal = (value) => (Number(value) || 0).toFixed(2);
  const itemPrice = (item) => Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
  const subtotal = items.reduce((sum, item) => sum + itemPrice(item) * Number(item.quantity || 0), 0);
  const total = Number(order.total) > 0 ? Number(order.total) : subtotal;
  const walletDiscount = Math.max(0, Math.floor(Number(order.loyalty_points_redeemed || 0)));
  const itemRows = items.flatMap((item, index) => {
    const label = `${settings.showItemSerial ? `${index + 1}. ` : ''}${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}`;
    const quantity = Number(item.quantity || 0), unit = itemPrice(item), itemAmount = quantity * unit;
    return [
      `__ITEMTEXT__${label}`,
      `__ITEMTEXT__Qty: ${quantity}    Price: ${decimal(unit)}    Amount: ${decimal(itemAmount)}`,
      item.style ? `__ITEMTEXT__  With Gravy: ${item.style} · +₹10` : ''
    ].filter(Boolean);
  });
  const token = String(order.daily_order_number || '—').padStart(2, '0');
  const placedAt = order.created_at ? new Date(order.created_at) : new Date();
  const placedDate = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', day:'2-digit', month:'2-digit', year:'2-digit' }).format(placedAt);
  const placedTime = new Intl.DateTimeFormat('en-IN', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false }).format(placedAt);
  const quantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const billNumber = order.bill_number ? String(order.bill_number).padStart(2, '0') : '—';
  const customer = String(order.customer_name || '').trim();
  const phone = String(order.customer_phone || '').replace(/^walkin-.*$/i, '');
  const service = order.mode === 'table' ? `Dine In · ${order.table_area || 'Table'} ${order.table_number || ''}`.trim() : order.fulfillment_type === 'delivery' ? 'Delivery' : 'Parcel';
  const customerLine = customer ? `Name: ${customer}${phone ? ` (M: ${phone})` : ''}` : phone ? `Mobile: ${phone}` : 'Name: Walk-in customer';
  const details = [line, `__META__${customerLine}`, line, `__META__Date: ${placedDate}          ${service}`, `__META__${placedTime}`, `__META__Cashier: biller       Bill No.: ${billNumber}`, `__METABOLD__Token No.: ${token}`, line];
  const itemHeader = '__ITEMLABEL__Item                     Qty   Price   Amount';
  const totals = [`__LABEL__Total Qty: ${quantity}   Sub Total: ${money(subtotal)}`, walletDiscount ? `__LABEL__Points discount: -${money(walletDiscount)}` : ''];
  const defaultHeader='Colva Goa\n9922853605 / 9049558369\n[Follow] Insta ID:\nred_lantern_restaurant';
  const defaultFooter='Thank you for choosing us!\nKindly leave us a review\nGoogle | Zomato | Swiggy';
  return [settings.reprint ? '__CENTER__*** REPRINT ***' : '', settings.showRestaurantName === false ? '' : `__BILLTITLE__${settings.restaurantName || 'Red Lantern Restaurant'}`, `__BILLHEADER__${settings.receiptHeader || defaultHeader}`, ...details, itemHeader, ...itemRows, line, ...totals, `__GRAND__GRAND TOTAL: ${money(total)}`, line, `__FOOTER__${settings.receiptFooter || defaultFooter}`, '\n\n\n'].filter(Boolean).join('\n');
}

function allowedOrigin(request) {
  const origin = request.headers.origin || '';
  if (!origin || /^https:\/\/(www\.)?redlanternrestaurant\.in$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin || '*';
  return '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 512000) reject(new Error('Request too large.')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}

function reply(res, status, body, origin = '') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (req.headers.origin && !origin) return reply(res, 403, { error: 'This website is not allowed to access the Print Bridge.' });
  if (req.method === 'OPTIONS') return reply(res, 204, {}, origin);
  if (req.method === 'GET' && req.url === '/health') {
    try { localLedger().prepare('SELECT 1 AS ok').get(); }
    catch (error) { return reply(res, 503, { ok:false, service:'Red Lantern Print Bridge', error:'The local SQLite ledger is unavailable.', detail:error.message }, origin); }
    return reply(res, 200, { ok: true, service: 'Red Lantern Print Bridge', platform:process.platform, node:process.version, ledger:'ready', ledgerSummary:ledgerSummary() }, origin);
  }
  if (req.method === 'GET' && req.url === '/v1/setup-status') {
    try {
      localLedger().prepare('SELECT 1 AS ok').get();
      const [printers, config] = await Promise.all([installedPrinters(), readJson(configFile, { printers: [], routes: [] })]);
      return reply(res, 200, {
        ok:true,
        platform:process.platform,
        platformLabel:process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform,
        node:process.version,
        ledger:'ready',
        printerCount:printers.length,
        configuredPrinterCount:Array.isArray(config.printers) ? config.printers.length : 0,
        routeCount:Array.isArray(config.routes) ? config.routes.length : 0,
        ledgerSummary:ledgerSummary()
      }, origin);
    } catch (error) { return reply(res, 503, { ok:false, error:'Print Bridge needs attention.', detail:error.message }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/restart') {
    reply(res, 202, { ok: true, message: 'Print Bridge is restarting.' }, origin);
    setTimeout(() => {
      const child = spawn(process.execPath, [__filename], { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    }, 250).unref();
    return;
  }
  if (req.method === 'GET' && req.url === '/v1/printers') {
    try { return reply(res, 200, { printers: await installedPrinters() }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read installed printers.', detail: error.message }, origin); }
  }
  if (req.method === 'GET' && req.url === '/v1/config') {
    try { return reply(res, 200, { config: await readJson(configFile, { printers: [], routes: [] }) }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read local printer configuration.', detail: error.message }, origin); }
  }
  if (req.method === 'PUT' && req.url === '/v1/config') {
    try {
      const config = (await readBody(req)).config || {};
      const printers = (Array.isArray(config.printers) ? config.printers : []).slice(0, 250)
        .map((printer) => ({ id: String(printer.id || '').slice(0, 60), name: String(printer.name || '').trim().slice(0, 60), type: printer.type === 'bill' ? 'bill' : 'kot', deviceId: String(printer.deviceId || '').slice(0, 160), deviceName: String(printer.deviceName || '').slice(0, 120) }))
        .filter((printer) => printer.id && printer.name);
      const printerIds = new Set(printers.map((printer) => printer.id));
      const routes = (Array.isArray(config.routes) ? config.routes : []).slice(0, 2000)
        .map((route) => ({ id: String(route.id || '').slice(0, 60), printerId: String(route.printerId || '').slice(0, 60), category: String(route.category || '').trim().slice(0, 100), itemName: String(route.itemName || '').trim().slice(0, 160) }))
        .filter((route) => route.id && printerIds.has(route.printerId) && route.category);
      const safeConfig = { printers, routes, savedAt: new Date().toISOString() };
      await writeJson(configFile, safeConfig);
      return reply(res, 200, { ok: true, savedAt: safeConfig.savedAt }, origin);
    } catch (error) { return reply(res, 400, { error: error.message || 'Unable to save local printer configuration.' }, origin); }
  }
  if (req.method === 'GET' && req.url.startsWith('/v1/ledger/actions')) {
    try {
      const requested = new URL(req.url, `http://127.0.0.1:${PORT}`).searchParams.get('status') || 'queued';
      const statuses = requested === 'all' ? ['queued','syncing','blocked','synced'] : requested.split(',').filter((status) => ['queued','syncing','blocked'].includes(status));
      const rows = statuses.length ? localLedger().prepare(`SELECT * FROM ledger_actions WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 500`).all(...statuses) : [];
      return reply(res, 200, { actions:rows.map(ledgerAction) }, origin);
    } catch (error) { return reply(res, 500, { error:'Unable to read the local order ledger.', detail:error.message }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/ledger/actions') {
    try { return reply(res, 201, { ok:true, action:queueLedgerAction(await readBody(req)) }, origin); }
    catch (error) { return reply(res, 400, { error:error.message || 'Unable to save the offline order.' }, origin); }
  }
  const ledgerUpdateMatch = req.url.match(/^\/v1\/ledger\/actions\/([^/]+)\/(synced|blocked)$/);
  if (req.method === 'POST' && ledgerUpdateMatch) {
    try {
      const body = await readBody(req);
      return reply(res, 200, { ok:true, action:updateLedgerAction(decodeURIComponent(ledgerUpdateMatch[1]), ledgerUpdateMatch[2], body.error) }, origin);
    } catch (error) { return reply(res, 400, { error:error.message || 'Unable to update the offline order.' }, origin); }
  }
  if (req.method === 'GET' && req.url === '/v1/kot-queue') {
    try { return reply(res, 200, { jobs: await readJson(queueFile, []) }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read local KOT queue.', detail: error.message }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/kot-queue') {
    try {
      const payload = await readBody(req);
      const printerId = String(payload.printerId || '').slice(0, 60);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerId || !items.length) throw new Error('A KOT needs a printer and at least one item.');
      const jobs = await readJson(queueFile, []);
      const job = { id: crypto.randomUUID(), status: 'queued', queuedAt: new Date().toISOString(), order: payload.order || null, printerId, items };
      jobs.push(job);
      await writeJson(queueFile, jobs.slice(-1000));
      return reply(res, 201, { ok: true, job }, origin);
    } catch (error) { return reply(res, 400, { error: error.message || 'Unable to queue KOT.' }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/print-kot') {
    let printJobId='';
    try {
      const payload = await readBody(req);
      printJobId=String(payload.printJobId || '');
      const printerName = String(payload.printerName || '').trim().slice(0, 160);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerName || !items.length) throw new Error('A printer and at least one KOT item are required.');
      const claim=claimPrintJob(payload.printJobId, 'kot', printerName);
      if (!claim.claim) return reply(res, claim.duplicate ? 200 : 202, { ok:true, duplicate:!!claim.duplicate, pending:!!claim.pending, printerName }, origin);
      await printText(printerName, kotText({ ...payload, items }), payload.settings || {});
      finishPrintJob(payload.printJobId, true);
      return reply(res, 201, { ok: true, printerName }, origin);
    } catch (error) { try { finishPrintJob(printJobId, false); } catch (_) {} return reply(res, 400, { error: error.message || 'Unable to print KOT.' }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/print-bill') {
    let printJobId='';
    try {
      const payload = await readBody(req); printJobId=String(payload.printJobId || ''); const printerName = String(payload.printerName || '').trim().slice(0, 160);
      if (!printerName || !payload.order?.id) throw new Error('A bill printer and order are required.');
      const claim=claimPrintJob(payload.printJobId, 'bill', printerName);
      if (!claim.claim) return reply(res, claim.duplicate ? 200 : 202, { ok:true, duplicate:!!claim.duplicate, pending:!!claim.pending, printerName }, origin);
      await printText(printerName, billText(payload), payload.settings || {});
      finishPrintJob(payload.printJobId, true);
      return reply(res, 201, { ok: true, printerName }, origin);
    } catch (error) { try { finishPrintJob(printJobId, false); } catch (_) {} return reply(res, 400, { error: error.message || 'Unable to print bill.' }, origin); }
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
