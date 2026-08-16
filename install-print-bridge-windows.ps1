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
if ([int]$nodeMajor -lt 22) { throw "Node.js 22 or newer is required. This computer has $(& $node -v). Install a supported Node.js LTS release, then run this setup again." }
try {
  # An installer run is also an upgrade. Stop the old Node process first so it
  # cannot keep serving an older receipt renderer from memory.
  $existing = Get-ScheduledTask -TaskName 'Red Lantern Print Bridge' -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName 'Red Lantern Print Bridge' -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $bridge) -WorkingDirectory $project
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  # Keep the Bridge alive like a desktop utility. The defaults can stop a task
  # after a time limit and do not retry it if Node or a printer driver restarts.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'Red Lantern Print Bridge' -Action $action -Trigger $trigger -Settings $settings -Description 'Starts and keeps the Red Lantern local printer bridge running for this Windows user.' -Force | Out-Null
  Start-ScheduledTask -TaskName 'Red Lantern Print Bridge'
  Start-Sleep -Milliseconds 700
  if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:9124/health').StatusCode -ne 200) { throw 'The Windows task started but the Print Bridge did not become ready.' }
  Write-Host 'Print Bridge is installed, running, and will restart at sign-in or after an unexpected stop.'
} catch {
  $startup = [Environment]::GetFolderPath('Startup')
  $launcher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
  @("@echo off", "start `"`" /b `"$node`" `"$bridge`"") | Set-Content -LiteralPath $launcher -Encoding Ascii
  Start-Process -FilePath $node -ArgumentList $bridge -WorkingDirectory $project -WindowStyle Hidden
  Write-Host 'Print Bridge installed in this user’s Startup folder and started.'
}
