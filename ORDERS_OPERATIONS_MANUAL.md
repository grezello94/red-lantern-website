# Red Lantern Orders — Operations Manual

This is the daily guide for owners, cashiers, waiters, and kitchen staff using Direct Orders.

## Before service starts

1. Open `/orders` on the counter computer.
2. Confirm internet is available.
3. Confirm the local Print Bridge is running on that same computer.
4. Open **Operations → Manage Printers**.
5. Check that the Bill printer and each KOT printer are configured.
6. Confirm each printer has the correct paper roll: normally 80 mm for the installed EPSON thermal printers.
7. Print one test Bill and KOT after changing a printer, paper roll, or Windows printer setting.

## QR customer orders

Customers scan the restaurant QR code and place their order through the menu.

- A new customer order appears as **New** in Live Orders.
- Call the customer when needed and confirm the order.
- Click **Accept** only after confirmation.
- Accepted orders send KOTs to their assigned kitchen printers.
- A returning customer with a prior completed order may be accepted automatically.

## Taking a Takeaway order

1. Click **Takeaway**.
2. Search or browse the food menu.
3. Click dishes to add them. Choose portion, bone/boneless, or gravy options where shown.
4. Enter customer name, mobile number, and kitchen note if available.
5. Check wallet points if the customer wants to redeem them.
6. Confirm the wallet amount twice when redeeming points.
7. Check the total.
8. Click **Place takeaway order**.

The order is saved first, then KOTs and the final Bill are sent to configured printers.

## Taking a Dine-in table order

1. Open the Table View in Orders.
2. Select the correct area and table, for example **A/C · Table 05**.
3. Add dishes using the counter menu.
4. Add the customer name or kitchen note if needed.
5. Click **Place order · Table 05**.

The KOT is sent to the kitchen. The final Bill is printed when the table is settled, not when food is first ordered.

## KOTs

KOT numbers reset every day and start from KOT #1. The number continues across QR, Takeaway, and Dine-in orders.

- One order may create more than one KOT when items belong to different kitchen stations.
- Use **Operations → KOTs** to view or reprint KOT records.
- Completed orders are retained in the KOT record/history for the day.

## Bills

The printer assigned through **Assign → Bill** prints final customer Bills.

- A Bill printer must be configured with an installed Windows printer.
- Use 80 mm or 58 mm consistently in both Orders settings and Windows printer preferences.
- If the bill has large blank paper at the top, check the printer driver paper form and restart Print Bridge.

## Printer setup

Open **Operations → Manage Printers**.

For each printer:

1. Add/select its installed system printer.
2. Use **Edit** to set its name, paper width, and print preferences.
3. Use **Assign**.
4. Choose **Bill** for final receipts, or **KOT** for kitchen tickets.
5. For KOT, select the categories/items that printer should receive.
6. Save the configuration.

## If internet goes down

Do not close the Orders page.

- The screen keeps the most recently loaded Orders visible.
- Counter orders are saved on that device and queued safely.
- When internet returns, queued orders sync automatically.
- Check the connection message at the top of Orders.

## If a Bill or KOT does not print

1. Check printer power, paper, LAN/USB connection, and Windows printer status.
2. Confirm Print Bridge is running on the same counter computer.
3. Confirm the printer is assigned correctly in Manage Printers.
4. Confirm KOT categories are routed to the intended kitchen printer.
5. Open **Admin → Orders Error Logs** for the detailed technical error and suggested action.
6. Reprint the KOT from Operations if necessary.

## End of day

1. Finish or review active orders.
2. Check KOT history for missing tickets or reprints.
3. Check Orders Error Logs for repeated printing or sync issues.
4. Keep the counter computer and Print Bridge ready for the next service day.

The next day, order and KOT numbers automatically begin again at #1.
