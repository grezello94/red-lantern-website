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
8. Keep `/orders` open throughout service. It is the counter computer that physically dispatches Captain KOTs through the local Print Bridge.

Do not treat a green **Print Bridge running** message by itself as ready for service. In **Operations → Print & offline setup**, it must say **Printing is ready**. A running Bridge without a saved printer and KOT route cannot send kitchen tickets.

If this screen says **Printing needs review**, do not assume a retry has reached the kitchen. Resolve the named printer failure, then reprint the affected KOT or Bill from Operations and confirm the paper copy. Use **Mark reviewed** only after every affected ticket has been accounted for; it clears the warning but does not print anything.

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

For Captain phones, a saved offline order is never silently merged into a table that changed on another device. Reconnect first, then use **Review & merge** only after confirming the live table bill with the other waiter. The same queued request is idempotent, so retrying it does not create a duplicate order.

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

## Captain go-live acceptance test

Run this once on the actual counter computer, printer, and two Captain phones before treating Captain as unattended service-ready. Use test dishes or cancel/settle the test orders afterward.

| Test | Expected result |
| --- | --- |
| Captain login, refresh, close and reopen | The assigned table board returns; no PIN/session loop; an unsent draft restores for the same Captain and table. |
| Phone A starts a table, adds items and a kitchen note, with **Send KOT** on | One table order and one KOT round are created. The counter computer prints each routed kitchen ticket once. |
| Phone A adds a second round to the same table | The existing bill remains one order; only the newly added items appear on the new KOT round. |
| Phone A saves with **Send KOT** off, then sends the KOT | The order is saved without a kitchen ticket, then exactly one KOT is created when retried. |
| Turn off Phone A's network, save an order, then reconnect | The saved order syncs once with the original items and note. It does not create a duplicate order or duplicate KOT. |
| While Phone A is offline, Phone B starts the same table | Phone A receives **Needs review** after reconnecting; it cannot silently merge. Confirm the live bill, then explicitly merge or reject it. |
| Restart Print Bridge or briefly disconnect a printer during a KOT | Orders shows the bridge/problem state. When restored, the counter retries the missing ticket using the same print job; already printed tickets are not duplicated. |

Record the date, devices, printer names, and any failure in **Admin → Orders Error Logs**. A pass means every expected result above was observed on paper and in the order/KOT history.
