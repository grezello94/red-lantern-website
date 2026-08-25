Set shell = CreateObject("WScript.Shell")
shell.Run "node.exe " & Chr(34) & Replace(WScript.ScriptFullName, "run-print-bridge-hidden.vbs", "print-bridge-supervisor.js") & Chr(34), 0, True
