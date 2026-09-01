# Printer setup

The Print Bridge only lists printers that the operating system has already installed. It uses built-in operating-system queries and does not bundle third-party printer drivers, since the correct driver depends on the printer manufacturer and model.

Printer configuration is capability-based and does not depend on saved printer names or a fixed number of devices. Each installed queue can be enabled for Bill printing, KOT routing, or both, with settings stored per queue.

## Windows

1. Install the manufacturer’s current Windows driver for each USB or LAN printer.
2. Confirm each printer appears in **Settings > Bluetooth & devices > Printers & scanners** and print a Windows test page.
3. Ensure the **Print Spooler** Windows service is running.
4. Install the automatic startup/recovery task once by running `powershell -ExecutionPolicy Bypass -File .\install-print-bridge-windows.ps1` from this project folder. Re-run the same installer after replacing or upgrading the Bridge files. It copies the runtime into a stable per-user installation directory and restarts the installed version.

The bridge tries CIM, PowerShell PrinterManagement, and WMIC discovery, in that order, so it continues working when one Windows management provider is unavailable. The installer registers a per-user scheduled task with automatic restart; if task registration is unavailable, it retains a Startup-folder fallback instead.

The Orders readiness check also blocks a green “Printing is ready” state when Windows or CUPS reports a configured queue as Offline/Error, when a saved queue is missing, or when a live menu item has no KOT route.

## macOS

1. Add every printer in **System Settings > Printers & Scanners**.
2. Use AirPrint where supported, or install the printer manufacturer’s macOS driver.
3. Print a test page from macOS.
4. Install or update the automatic startup agent by running `bash ./install-print-bridge-macos.sh` in the extracted setup folder. Every run replaces the stable per-user runtime and restarts the installed version.

The bridge reads the macOS CUPS printer list through `lpstat`.

## Why this is a separate installer

A PWA runs inside the browser security sandbox. Browsers do not permit a website or installed PWA to start background programs, install drivers, enumerate local printers, or create login tasks. The one-time system installer above runs with the signed-in user’s permission, then starts the local bridge automatically at every sign-in.
