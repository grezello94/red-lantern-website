On Error Resume Next
Set shell = CreateObject("WScript.Shell")
result = shell.Run("node.exe " & Chr(34) & Replace(WScript.ScriptFullName, "run-print-bridge-hidden.vbs", "print-bridge-supervisor.js") & Chr(34), 0, True)
If Err.Number <> 0 Then WScript.Quit 1
WScript.Quit result
