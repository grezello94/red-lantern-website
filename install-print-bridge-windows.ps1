param(
  [string]$ProjectPath = $PSScriptRoot,
  [string]$CounterUser = '',
  [string]$CounterProfile = ''
)

$ErrorActionPreference = 'Stop'

# Resolve the signed-in counter session before elevation. An installer opened
# with a separate administrator account must not move printer access and the
# saved workstation identity into that administrator's profile.
if (!$CounterUser -or !$CounterProfile) {
  $CounterUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $CounterProfile = $env:USERPROFILE
  try {
    $sessionId = (Get-Process -Id $PID).SessionId
    $desktop = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
      Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
    if ($desktop) {
      $owner = Invoke-CimMethod -InputObject $desktop -MethodName GetOwner
      $ownerSid = Invoke-CimMethod -InputObject $desktop -MethodName GetOwnerSid
      $counterProfileRecord = Get-ItemProperty -LiteralPath ("HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + $ownerSid.Sid) -ErrorAction Stop
      if ($owner.ReturnValue -eq 0 -and $counterProfileRecord.ProfileImagePath) {
        $CounterUser = "$($owner.Domain)\$($owner.User)"
        $CounterProfile = [Environment]::ExpandEnvironmentVariables($counterProfileRecord.ProfileImagePath)
      }
    }
  } catch {}
}

# Updating the recovery task requires elevation. Relaunch setup once with an
# administrator token so an existing installation can actually be replaced.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object Security.Principal.WindowsPrincipal($identity)
if (!$windowsPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -ProjectPath `"$ProjectPath`" -CounterUser `"$CounterUser`" -CounterProfile `"$CounterProfile`""
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
  exit $elevated.ExitCode
}

$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$bridge = Join-Path $project 'print-bridge.js'
$supervisor = Join-Path $project 'print-bridge-supervisor.js'
$domain = Join-Path $project 'printer-domain.js'
$addonsDomain = Join-Path $project 'addons-domain.js'
$launcherDir = Join-Path $CounterProfile 'AppData\Local\Red Lantern Print Bridge'
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

$expectedVersion = [regex]::Match((Get-Content -LiteralPath $bridge -Raw), "const BRIDGE_VERSION = '([^']+)'").Groups[1].Value
$bundledNode = Join-Path $project 'node.exe'
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source }
$taskName = 'Red Lantern Print Bridge Recovery'
$nodeMajor = (& $node -p "process.versions.node.split('.')[0]")
if ([int]$nodeMajor -lt 22) { throw "Node.js 22 or newer is required. This computer has $(& $node -v). Install a supported Node.js LTS release, then run this setup again." }
& $node -e "require('node:sqlite')"
if ($LASTEXITCODE -ne 0) { throw 'This Node.js runtime cannot load the durable SQLite print ledger. Install Node.js 22.13 or newer, then run setup again.' }
$sourceNode = $node
$installedNode = Join-Path $launcherDir 'node.exe'
$node = $installedNode
$vbsNode = $node.Replace('"', '""')
$vbsBridge = $installedSupervisor.Replace('"', '""')
$startup = Join-Path $CounterProfile 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
New-Item -ItemType Directory -Path $startup -Force | Out-Null
$launcher = Join-Path $startup 'Red Lantern Print Bridge.vbs'
$legacyLauncher = Join-Path $startup 'Red Lantern Print Bridge.cmd'
# WScript waits for the supervisor and keeps the task attached, while using
# window style 0 so counter staff never see a Node/terminal window.
@(
  'On Error Resume Next',
  'Set shell = CreateObject("WScript.Shell")',
  ('result = shell.Run(Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34), 0, True)' -f $vbsNode, $vbsBridge),
  'If Err.Number <> 0 Then WScript.Quit 1',
  'WScript.Quit result'
) | Set-Content -LiteralPath $hiddenLauncher -Encoding Ascii
try {
  # The task runs in the signed-in counter user's session. This is important:
  # Windows printers are user-scoped on many POS systems, so a task registered
  # under an elevated installer account can appear healthy but have no printers.
  $currentUser = $CounterUser
  # Retire the original console-based task before stopping its processes.
  # Otherwise the old task can relaunch a visible Node/CMD window at sign-in.
  $legacyTask = Get-ScheduledTask -TaskName 'Red Lantern Print Bridge' -ErrorAction SilentlyContinue
  if ($legacyTask) {
    Stop-ScheduledTask -TaskName 'Red Lantern Print Bridge' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'Red Lantern Print Bridge' -Confirm:$false -ErrorAction Stop
  }
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
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
  function Copy-InstalledFile([string]$Source, [string]$Destination) {
    if (![string]::Equals($Source, $Destination, [StringComparison]::OrdinalIgnoreCase)) {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
  }
  Copy-InstalledFile $bridge $installedBridge
  Copy-InstalledFile $supervisor $installedSupervisor
  Copy-InstalledFile $domain $installedDomain
  Copy-InstalledFile $addonsDomain $installedAddonsDomain
  Copy-InstalledFile $sourceNode $installedNode
  # Preserve the runtime along with the scripts. Deleting an extracted ZIP or
  # upgrading the globally installed Node.js can no longer break startup.
  try {
    Set-Service -Name Spooler -StartupType Automatic -ErrorAction Stop
    Start-Service -Name Spooler -ErrorAction Stop
    & "$env:SystemRoot\System32\sc.exe" failure Spooler reset= 60 actions= restart/5000/restart/10000/restart/30000 | Out-Null
  } catch { Write-Warning ("Windows spooler automatic recovery: " + $_.Exception.Message) }
  # WScript waits for the supervisor but has no visible console window.
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument ('//B //Nologo "{0}"' -f $hiddenLauncher) -WorkingDirectory $launcherDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  # Keep the Bridge alive, with no visible terminal. It starts at every sign-in
  # and Task Scheduler restarts it after an unexpected exit.
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  # Run with the highest token granted by the one-time elevated installer. The
  # Bridge uses it only to start Windows Print Spooler automatically when it is
  # stopped, keeping service recovery out of the counter staff workflow.
  $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts and automatically recovers the Red Lantern local printer bridge for this counter user.' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  $ready = $false
  1..20 | ForEach-Object {
    if (!$ready) {
      Start-Sleep -Milliseconds 500
      try {
        $health = Invoke-RestMethod -TimeoutSec 2 'http://127.0.0.1:9124/health'
        $ready = $health.ok -and $health.version -eq $expectedVersion -and $health.ledger -eq 'ready'
      } catch {}
    }
  }
  if (!$ready) { throw "The Windows task started but the updated Print Bridge did not become ready. See .red-lantern-print-bridge\supervisor.log in the counter user profile." }
  # A previous non-admin installation may have created the Startup fallback.
  # Once Task Scheduler is healthy, remove both fallback launchers so only one
  # supervisor can start at the next sign-in.
  Remove-Item -LiteralPath $launcher -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
  Write-Host 'Print Bridge is installed, running, and will restart at sign-in or after an unexpected stop.'
} catch {
  $failure = $_.Exception.Message
  # An installed task already owns startup and recovery. Do not add a second
  # Startup launcher if its initial health check happened to time out.
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw "Print Bridge task was installed, but readiness needs attention: $failure"
  }
  if (!(Test-Path -LiteralPath $installedNode) -or !(Test-Path -LiteralPath $installedBridge) -or !(Test-Path -LiteralPath $installedSupervisor)) {
    throw "Print Bridge installation did not finish copying its runtime: $failure"
  }
  # A .vbs launcher keeps the bridge completely out of the staff workflow:
  # no Command Prompt window appears at sign-in or when the fallback starts.
  @(
    'On Error Resume Next',
    'Set shell = CreateObject("WScript.Shell")',
    ('result = shell.Run(Chr(34) & "{0}" & Chr(34) & " " & Chr(34) & "{1}" & Chr(34), 0, False)' -f $vbsNode, $vbsBridge),
    'If Err.Number <> 0 Then WScript.Quit 1',
    'WScript.Quit result'
  ) | Set-Content -LiteralPath $launcher -Encoding Ascii
  Remove-Item -LiteralPath $legacyLauncher -Force -ErrorAction SilentlyContinue
  # Start through the hidden launcher immediately too; users never need to run
  # a command or manage a terminal window.
  Start-Process -FilePath "$env:SystemRoot\System32\wscript.exe" -ArgumentList ('//B //Nologo "{0}"' -f $launcher) -WindowStyle Hidden
  $fallbackReady = $false
  1..20 | ForEach-Object {
    if (!$fallbackReady) {
      Start-Sleep -Milliseconds 500
      try {
        $health = Invoke-RestMethod -TimeoutSec 2 'http://127.0.0.1:9124/health'
        $fallbackReady = $health.ok -and $health.version -eq $expectedVersion -and $health.ledger -eq 'ready'
      } catch {}
    }
  }
  if (!$fallbackReady) { throw "Print Bridge fallback started but the updated service did not become ready: $failure" }
  Write-Host "Print Bridge installed silently in this user's Startup folder and started. Scheduled-task setup will be retried at the next installer update."
  Write-Warning "Scheduled-task setup fallback reason: $failure"
}
