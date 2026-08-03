param(
  [string]$ProjectPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridge = Join-Path $project 'print-bridge.js'
if (!(Test-Path -LiteralPath $bridge)) { throw "print-bridge.js was not found in $project" }

$bundledNode = Join-Path $project 'node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$nodeMajor = (& $node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -ne '22') { throw "Node.js 22 is required. This computer has $(& $node -v). Install Node.js 22 LTS, then run this setup again." }
try {
  if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:9124/health').StatusCode -eq 200) {
    Write-Host 'Print Bridge is already running. No setup changes were made.'
    exit 0
  }
} catch { }
try {
  $existing = Get-ScheduledTask -TaskName 'Red Lantern Print Bridge' -ErrorAction SilentlyContinue
  if ($existing) {
    Start-ScheduledTask -TaskName 'Red Lantern Print Bridge'
    Write-Host 'Existing Print Bridge setup was started.'
    exit 0
  }
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $bridge) -WorkingDirectory $project
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName 'Red Lantern Print Bridge' -Action $action -Trigger $trigger -Description 'Starts the Red Lantern local printer bridge when this user signs in.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'Red Lantern Print Bridge'
  Write-Host 'Print Bridge installed as a Windows sign-in task and started.'
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $launcher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
  @("@echo off", "start `"`" /b `"$node`" `"$bridge`"") | Set-Content -LiteralPath $launcher -Encoding Ascii
  Start-Process -FilePath $node -ArgumentList $bridge -WorkingDirectory $project -WindowStyle Hidden
  Write-Host 'Print Bridge installed in this user’s Startup folder and started.'
}
