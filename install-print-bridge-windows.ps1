param(
  [string]$ProjectPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridge = Join-Path $project 'print-bridge.js'
$supervisor = Join-Path $project 'print-bridge-supervisor.js'
$domain = Join-Path $project 'printer-domain.js'
$addonsDomain = Join-Path $project 'addons-domain.js'
$launcherDir = Join-Path $env:LOCALAPPDATA 'Red Lantern Print Bridge'
New-Item -ItemType Directory -Path $launcherDir -Force | Out-Null
$installedBridge = Join-Path $launcherDir 'print-bridge.js'
$installedSupervisor = Join-Path $launcherDir 'print-bridge-supervisor.js'
$installedDomain = Join-Path $launcherDir 'printer-domain.js'
$installedAddonsDomain = Join-Path $launcherDir 'addons-domain.js'
$hiddenLauncher = Join-Path $launcherDir 'run-print-bridge-hidden.vbs'
if (!(Test-Path -LiteralPath $bridge)) { throw "print-bridge.js was not found in $project" }
if (!(Test-Path -LiteralPath $supervisor)) { throw "print-bridge-supervisor.js was not found in $project" }
if (!(Test-Path -LiteralPath $domain)) { throw "printer-domain.js was not found in $project" }
if (!(Test-Path -LiteralPath $addonsDomain)) { throw "addons-domain.js was not found in $project" }

$bundledNode = Join-Path $project 'node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$taskName = 'Red Lantern Print Bridge Recovery'
$nodeMajor = (& $node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 22) { throw "Node.js 22 or newer is required. This computer has $(& $node -v). Install a supported Node.js LTS release, then run this setup again." }
$vbsNode = $node.Replace('"', '""')
$vbsBridge = $installedSupervisor.Replace('"', '""')
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'Red Lantern Print Bridge.vbs'
$legacyLauncher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
# WScript waits for the supervisor and keeps the task attached, while using
# window style 0 so counter staff never see a Node/terminal window.
@(
  'Set shell = CreateObject("WScript.Shell")',
  ('shell.Run Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34), 0, True' -f $vbsNode, $vbsBridge)
) | Set-Content -LiteralPath $hiddenLauncher -Encoding Ascii
try {
  # The task runs in the signed-in counter user's session. This is important:
  # Windows printers are user-scoped on many POS systems, so a task registered
  # under an elevated installer account can appear healthy but have no printers.
  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  # Stop the Bridge and its watchdog being upgraded. Leaving the old supervisor
  # alive lets it immediately recreate the old child and compete with the new
  # scheduled-task supervisor for port 9124.
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
      $_.CommandLine -and (
        $_.CommandLine -match 'print-bridge\.js' -or
        $_.CommandLine -match 'print-bridge-supervisor\.js'
      )
    } |
    ForEach-Object {
      Invoke-CimMethod -InputObject $_ -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null
    }
  Start-Sleep -Milliseconds 350
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 350
  }
  # Install to a stable per-user directory. Setup ZIPs and project checkouts can
  # be replaced or removed after installation without breaking automatic start.
  Copy-Item -LiteralPath $bridge -Destination $installedBridge -Force
  Copy-Item -LiteralPath $supervisor -Destination $installedSupervisor -Force
  Copy-Item -LiteralPath $domain -Destination $installedDomain -Force
  Copy-Item -LiteralPath $addonsDomain -Destination $installedAddonsDomain -Force
  # WScript waits for the supervisor but has no visible console window.
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('"{0}"' -f $hiddenLauncher) -WorkingDirectory $launcherDir
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
  # A previous non-admin installation may have created the Startup fallback.
  # Once Task Scheduler is healthy, remove both fallback launchers so only one
  # supervisor can start at the next sign-in.
  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
  Write-Host 'Print Bridge is installed, running, and will restart at sign-in or after an unexpected stop.'
} catch {
  $failure = $_.Exception.Message
  # A .vbs launcher keeps the bridge completely out of the staff workflow:
  # no Command Prompt window appears at sign-in or when the fallback starts.
  @(
    'Set shell = CreateObject("WScript.Shell")',
    ('shell.Run Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34), 0, False' -f $vbsNode, $vbsBridge)
  ) | Set-Content -LiteralPath $launcher -Encoding Ascii
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
  # Start through the hidden launcher immediately too; users never need to run
  # a command or manage a terminal window.
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('"{0}"' -f $launcher) -WindowStyle Hidden
  Write-Host "Print Bridge installed silently in this user's Startup folder and started. Scheduled-task setup will be retried at the next installer update."
  Write-Warning "Scheduled-task setup fallback reason: $failure"
}
