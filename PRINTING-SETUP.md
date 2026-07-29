# Printer setup

The Print Bridge only lists printers that the operating system has already installed. It uses built-in operating-system queries and does not bundle third-party printer drivers, since the correct driver depends on the printer manufacturer and model.

## Windows

1. Install the manufacturer’s current Windows driver for each USB or LAN printer.
2. Confirm each printer appears in **Settings > Bluetooth & devices > Printers & scanners** and print a Windows test page.
3. Ensure the **Print Spooler** Windows service is running.
4. Install the automatic startup task once by running `powershell -ExecutionPolicy Bypass -File .\install-print-bridge-windows.ps1` from this project folder.

The bridge tries CIM, PowerShell PrinterManagement, and WMIC discovery, in that order, so it continues working when one Windows management provider is unavailable.

## macOS

1. Add every printer in **System Settings > Printers & Scanners**.
2. Use AirPrint where supported, or install the printer manufacturer’s macOS driver.
3. Print a test page from macOS.
4. Install the automatic startup agent once by running `bash ./install-print-bridge-macos.sh` in the project folder.

The bridge reads the macOS CUPS printer list through `lpstat`.

## Why this is a separate installer

A PWA runs inside the browser security sandbox. Browsers do not permit a website or installed PWA to start background programs, install drivers, enumerate local printers, or create login tasks. The one-time system installer above runs with the signed-in user’s permission, then starts the local bridge automatically at every sign-in.
