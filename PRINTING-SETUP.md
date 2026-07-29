# Printer setup

The Print Bridge only lists printers that the operating system has already installed. It uses built-in operating-system queries and does not bundle third-party printer drivers, since the correct driver depends on the printer manufacturer and model.

## Windows

1. Install the manufacturer’s current Windows driver for each USB or LAN printer.
2. Confirm each printer appears in **Settings > Bluetooth & devices > Printers & scanners** and print a Windows test page.
3. Ensure the **Print Spooler** Windows service is running.
4. In this project folder, run `npm run print-bridge` and leave it running.

The bridge tries CIM, PowerShell PrinterManagement, and WMIC discovery, in that order, so it continues working when one Windows management provider is unavailable.

## macOS

1. Add every printer in **System Settings > Printers & Scanners**.
2. Use AirPrint where supported, or install the printer manufacturer’s macOS driver.
3. Print a test page from macOS.
4. Run `npm run print-bridge` in the project folder and leave it running.

The bridge reads the macOS CUPS printer list through `lpstat`.
