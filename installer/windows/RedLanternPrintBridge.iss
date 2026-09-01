#define AppName "Red Lantern Print Bridge"
#define AppVersion "1.0.11"
#ifndef NodeRuntime
  #error NodeRuntime must point to a Node.js 22 node.exe file
#endif

[Setup]
AppId={{1B8F76A8-98CE-494E-98B0-05F248445E6B}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\Red Lantern Print Bridge
PrivilegesRequired=admin
DisableProgramGroupPage=yes
OutputDir=..\..\releases
OutputBaseFilename=Red-Lantern-Print-Bridge-Windows-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "..\..\printer-domain.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\print-bridge.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\print-bridge-supervisor.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\run-print-bridge-hidden.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\install-print-bridge-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#NodeRuntime}"; DestDir: "{app}"; DestName: "node.exe"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-print-bridge-windows.ps1"""; Flags: runhidden waituntilterminated

[UninstallRun]
Filename: "schtasks.exe"; Parameters: "/Delete /TN ""Red Lantern Print Bridge"" /F"; Flags: runhidden
Filename: "schtasks.exe"; Parameters: "/Delete /TN ""Red Lantern Print Bridge Recovery"" /F"; Flags: runhidden
Filename: "cmd.exe"; Parameters: "/c del /q ""{userstartup}\Red Lantern Print Bridge.vbs"" ""{userstartup}\Red Lantern Print Bridge.cmd"""; Flags: runhidden
