$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$compiler = Get-Command iscc.exe -ErrorAction SilentlyContinue
if (!$compiler) {
  throw 'Inno Setup 6 is required to build the Windows installer. Install it, then run npm run package:bridge:windows again.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$nodeMajor = (& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -ne '22') { throw "The Windows installer must be built with Node.js 22. Found $(& $node -v)." }

& $compiler.Source ("/DNodeRuntime=" + $node) (Join-Path $root 'installer\windows\RedLanternPrintBridge.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup could not build the Windows installer.' }

$installer = Join-Path $root 'releases\Red-Lantern-Print-Bridge-Windows-Setup.exe'
if ($env:WINDOWS_SIGN_COMMAND) {
  $command = $env:WINDOWS_SIGN_COMMAND.Replace('{file}', ('"' + $installer + '"'))
  Invoke-Expression $command
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer signing failed.' }
  Write-Host 'Windows installer built and signed.'
} else {
  Write-Host 'Windows installer built but is unsigned. Set WINDOWS_SIGN_COMMAND in secure CI to sign it.'
}
