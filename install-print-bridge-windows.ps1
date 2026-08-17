param(
  [string]$ProjectPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridge = Join-Path $project 'print-bridge.js'
if (!(Test-Path -LiteralPath $bridge)) { throw "print-bridge.js was not found in $project" }

$bundledNode = Join-Path $project 'node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$taskName = 'Red Lantern Print Bridge Recovery'
$nodeMajor = (& $node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 22) { throw "Node.js 22 or newer is required. This computer has $(& $node -v). Install a supported Node.js LTS release, then run this setup again." }
try {
  # The task runs in the signed-in counter user's session. This is important:
  # Windows printers are user-scoped on many POS systems, so a task registered
  # under an elevated installer account can appear healthy but have no printers.
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  # Stop only the Bridge being upgraded. Without this, its old process can keep
  # port 9124 occupied and cause the replacement task to exit immediately.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($bridge, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
  Start-Sleep -Milliseconds 350
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 350
  }
  $action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $bridge) -WorkingDirectory $project
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  # Keep the Bridge alive, with no visible terminal. It starts at every sign-in
  # and Task Scheduler restarts it after an unexpected exit.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts and automatically recovers the Red Lantern local printer bridge for this counter user.' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $ready = $false
  1..8 | ForEach-Object {
    if (!$ready) {
      Start-Sleep -Milliseconds 500
      try { $ready = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:9124/health').StatusCode -eq 200 } catch {}
    }
  }
  if (!$ready) { throw 'The Windows task started but the Print Bridge did not become ready.' }
  Write-Host 'Print Bridge is installed, running, and will restart at sign-in or after an unexpected stop.'
} catch {
  $failure = $_.Exception.Message
  $startup = [Environment]::GetFolderPath('Startup')
  $launcher = Join-Path $startup 'Red Lantern Print Bridge.vbs'
  $legacyLauncher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
  # A .vbs launcher keeps the bridge completely out of the staff workflow:
  # no Command Prompt window appears at sign-in or when the fallback starts.
  $vbsNode = $node.Replace('"', '""')
  $vbsBridge = $bridge.Replace('"', '""')
  @(
    'Set shell = CreateObject("WScript.Shell")',
    ('shell.Run Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34), 0, False' -f $vbsNode, $vbsBridge)
  ) | Set-Content -LiteralPath $launcher -Encoding Ascii
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
  # Start through the hidden launcher immediately too; users never need to run
  # a command or manage a terminal window.
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"{0}"' -f $launcher) -WindowStyle Hidden
  Write-Host "Print Bridge installed silently in this user's Startup folder and started. Scheduled-task setup will be retried at the next installer update."
  Write-Verbose "Scheduled-task setup fallback: $failure"
}
