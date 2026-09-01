# Red Lantern Orders

This document describes the restaurant staff Orders console: QR orders, counter takeaway orders, dine-in tables, KOTs, bills, printers, offline behaviour, and Operations configuration.

## Main staff flow

`/orders` is the secure staff console. It has three order-entry paths:

1. **QR orders** — a customer scans a table or business-card QR code and orders through the Air Menu.
2. **Takeaway** — counter staff create a walk-in or phone order from the staff menu.
3. **Dine-in tables** — staff select an allocated table and create a dine-in order from the same counter menu.

All saved orders receive a daily order number. KOT numbers use one restaurant-wide daily sequence across QR, takeaway, and dine-in orders, and reset to `1` at the start of each India/Kolkata day.

## Captain phone workspace

`/captain` is a separate, mobile-first staff link for waiters. It uses the same Orders-console authentication and the same server-side order, menu-price, table, and idempotency protections as `/orders`.

- A captain selects a currently free table, adds available Air Menu dishes, enters an optional guest name/mobile/kitchen note, and sends the dine-in order.
- The server rechecks table availability when saving, so two phones cannot silently start separate Captain orders for the same active table.
- Captain phones do not host the billing computer’s trusted Print Bridge or SQLite ledger. When internet drops, they retain an account-scoped table/menu snapshot and save submitted orders into a durable local queue. Reconnection uses the same request ID, so a retry cannot create a duplicate. If the table changed on another device, the order is held for an explicit Captain review rather than merged silently.
- Keep `/orders` open on the billing computer during service. That computer detects accepted Captain orders and sends the routed KOT through the local Print Bridge. Captain phones never connect directly to a printer.
- Adding items to an active table is supported as a new Captain KOT round. The server verifies the live table ID before merging; an offline conflict must be reviewed explicitly.

## QR ordering

QR ordering uses the Air Menu and its availability controls.

- New customers create an order with status **New**. Staff verify it and click **Accept**.
- Customers with an earlier completed order are auto-accepted.
- When accepted, the system attempts to create routed KOTs and print the Bill using the configured local Print Bridge.
- QR fulfilment is Pick Up or Delivery. Delivery UI/workflow can be extended separately.

## Takeaway counter orders

Choose **Takeaway** in the Orders console to open the counter menu.

- The counter menu uses the Air Menu food/bar items, categories, prices, portions, bone/boneless options, and gravy/semi-gravy options.
- Clicking a dish adds it immediately when it has one valid option. Portion/style choices open only where needed.
- Customer name, phone, kitchen note, and wallet redemption can be entered before placing the order.
- `Place takeaway order` saves the order, sends routed KOTs, and attempts to print the final Bill on the configured Bill printer.

## Dine-in tables

Table areas are configured in **Operations → Table allocation**.

- Areas have a name and inclusive number range, e.g. `A/C 1–28` and `Non-A/C 1–9`.
- The same table number may exist in different areas.
- Allocated tables appear in the Dine-in Table View.
- Selecting a table opens the counter menu with the selected area/table attached to the order.
- A dine-in order sends KOTs to the configured kitchens. It does **not** automatically issue the final Bill, because the Bill should be printed when the table is settled.

The Table View includes a status legend. Blank/available is live today; running/KOT/printed/paid states are reserved for the continuing table-settlement workflow.

## Menu and prices

Air Menu is the source of truth for counter and QR order items.

- Food and alcohol categories can be sorted from Admin → Air Menu.
- Food categories appear before Alcohol & Bar in the counter menu.
- Item prices and portions are validated on the server at placement time. A browser cannot submit its own price.
- Menu availability can temporarily disable an item for QR/counter ordering.

## Wallet points

One wallet point equals ₹1.

- A customer needs at least 100 points to redeem.
- Counter staff can enter the amount to redeem, up to the current points balance and order total.
- The counter requires two confirmations before deducting points.
- The redeemed amount becomes a Bill discount and is included in the saved order/receipt data.

## Order statuses and history

Live Orders has status actions such as New, Accepted, Preparing, Ready, Completed, Rejected, and Cancelled.

- Completing an order removes it from the active view.
- KOT records remain available in Operations → KOTs, including completed-order history for the selected day.
- Current orders auto-refresh without re-rendering the entire console where no data changed.

## KOTs

KOTs are grouped by their assigned printer routes.

- Configure a KOT printer and assign categories or individual menu items.
- A single order can create multiple KOTs when dishes belong to different kitchens.
- KOT routes are validated to prevent the same target being assigned to multiple printers.
- KOT number is a daily number, shared across all order types.
- KOT history retains completed records so staff can reprint or investigate past tickets.

## Bills and printers

Printer management is under **Operations → Manage printers**.

Each saved printer can be:

- Edited — printer name, Windows system device, paper width, header/footer and display preferences.
- Assigned to **Bill** — receives final customer Bills.
- Assigned to **KOT** — receives kitchen tickets based on configured routes.
- Removed — requires confirmation and removes related routing rules.

There is no fixed printer-count limit in normal restaurant use. Printer use is capability-based: each installed queue can handle Bill, KOT, or both. Every Bill-capable printer receives one copy of each final bill using that queue's own paper, typography, margin, and header/footer settings. Any number of KOT-capable printers can have independent category, item, and portion routes. The shared printer-domain module is the only capability registry, so future print roles can be introduced without adding printer-name or printer-count assumptions throughout the system. Duplicate saved references are rejected by the server and collapsed defensively during Bill dispatch.

### Print Bridge

Physical printing requires the local `print-bridge.js` process on the counter computer. The website sends print jobs to `http://127.0.0.1:9124`; Vercel cannot directly reach LAN/USB printers.

In **Orders → Operations → Print & offline setup**, staff can run one readiness check for cloud access, the local Bridge, SQLite ledger, system printers, and saved printer routes. It identifies Windows or macOS automatically. Readiness requires every saved device to exist as an installed system queue and every current menu item to have a KOT route. Re-running the platform installer safely updates and restarts its single background service.

For a new workstation, that screen provides one platform-specific setup download. Unzip it and open `START-SETUP.cmd` on Windows or `START-SETUP.command` on macOS. The lightweight ZIP setup requires Node.js 22 LTS; the signed native installer release includes its own Node.js 22 runtime. The setup bundle and its platform launchers are rebuilt with `npm run bundle:print-bridge` during every website build.

#### Windows billing computer — first setup

1. Turn on the receipt/KOT printers and add them in **Windows Settings → Bluetooth & devices → Printers & scanners**.
2. On that same billing computer, open **Orders → Operations → Print & offline setup**.
3. Confirm the screen says **Windows**, click **Download setup for Windows**, unzip it, and double-click `START-SETUP.cmd`.
4. Return to Operations and select **I’ve completed setup · Check again**.
5. Confirm that the local Print Bridge, SQLite offline ledger, and installed printers are ready; then assign the detected printers and routes in **Manage printers** if needed.

#### macOS billing computer — first setup

1. Turn on the receipt/KOT printers and add them in **System Settings → Printers & Scanners**.
2. On that same billing Mac, open **Orders → Operations → Print & offline setup**.
3. Confirm the screen says **macOS**, click **Download setup for macOS**, unzip it, and open `START-SETUP.command`.
4. Return to Operations and select **I’ve completed setup · Check again**.
5. Confirm that the local Print Bridge, SQLite offline ledger, and installed printers are ready; then assign printers and routes in **Manage printers** if needed.

#### Daily startup

Nothing needs to be reinstalled or manually started. When the staff user signs in to Windows, the Print Bridge starts automatically. Open `/orders` as normal. Use **Check again** or **Restart Bridge** only after changing a printer, replacing the computer, or when Operations reports a problem.

On macOS, the installed Bridge also starts automatically after the billing user signs in. The Orders browser must be open on the same billing computer as the Bridge for local USB/LAN printing.

#### Offline and recovery rules

- Keep the billing computer powered on while the restaurant is operating. The SQLite ledger is stored only on that computer and protects queued local work.
- If the internet fails, keep using `/orders` on the billing computer. Safe counter orders and operational changes are stored locally and reconcile when the connection returns.
- Do not clear browser data, uninstall the Print Bridge, delete `~/.red-lantern-print-bridge`, or copy its SQLite file while pending work is shown. Ask the administrator to resolve a sync warning first.
- Guest QR checkout requires internet and clearly reports when an order has not been sent; guests must retry only after connectivity returns.
- Final automatic KOT/Bill printing is online-confirmed. A pending Bridge response is not reported as printed. If the Bridge stops during a print, the expired job is marked **uncertain** for staff review instead of being retried blindly and risking a duplicate slip. Check the physical printer, acknowledge the warning, and reprint deliberately only when needed.
- If Operations says the Bridge is unavailable: check that the computer is online, printer is powered on, then click **Check again**. Use **Restart Bridge** only if it still remains unavailable.

#### When printers or computers change

1. Add the new printer in Windows/macOS system printer settings first.
2. Open **Operations → Print & offline setup** and run **Check again**.
3. Open **Manage printers**, add the detected system printer, set it as Bill or KOT, assign its routes, and save.
4. Send one controlled test KOT/Bill before service starts.
5. For a replacement billing computer, perform the relevant first-setup steps above. Do not move an old local SQLite ledger to the new computer without administrator review.

The Print Bridge:

- Detects Windows installed printers.
- Receives KOT/Bill jobs locally.
- Uses the printer's configured 58 mm or 80 mm preference to select the matching Windows thermal paper form.
- Uses small margins to reduce blank paper at the top.
- Receives per-printer receipt/KOT settings with each job.
- Keeps a durable SQLite ledger at `~/.red-lantern-print-bridge/orders-ledger.sqlite` on the billing computer.
- Uses a time-limited print claim. An interrupted claim becomes an explicit unresolved/uncertain issue in Print & offline setup until staff reviews it.

The Windows printer driver must also be configured to the same roll width. For EPSON TM-T82X and the shown thermal printers, use **80 mm** unless a 58 mm roll is actually loaded.

### Printer typography and layout

Per-printer font preferences are stored. Supported Windows-safe fonts are:

`Arial`, `Calibri`, `Verdana`, `Tahoma`, `Trebuchet MS`, `Georgia`, `Times New Roman`, `Courier New`, `Consolas`, and `Lucida Console`.

Recommended defaults:

| Use | Font | Body | Header |
| --- | --- | --- | --- |
| Bill 80 mm | Arial | 9–10 pt | 14–16 pt |
| Bill 58 mm | Tahoma/Arial | 8–9 pt | 12–14 pt |
| KOT 80 mm | Consolas | 10–11 pt | 16–18 pt |
| KOT 58 mm | Consolas/Courier New | 9–10 pt | 14–16 pt |

## Offline resilience

The Orders page is designed not to become blank when the internet disconnects.

- Last loaded Orders data stays visible.
- Counter orders created while offline are stored in the local Print Bridge SQLite ledger when it is running, with the browser queue retained as a fallback.
- Safe operational edits made while offline—order status, item quantities, table moves, kitchen state, availability, and Operations/table configuration—are also queued in that ledger.
- When internet returns and the Orders console is open, queued work syncs in order without reloading the page.
- The page shows an offline/sync message while work is waiting.
- **Operations → Print & offline setup** shows the number of pending actions and flags blocked actions. Resolve a blocked action before clearing browser data or changing the billing computer.

Settlement records use a unique settlement request ID. When the local Print Bridge is available, a staff settlement made during a network failure is saved locally and reconciles exactly once after reconnecting. Final bill printing remains online-confirmed: creating fully autonomous offline KOT/bill numbering requires a separately authenticated bridge-to-server protocol, so the browser-led ledger sync is intentionally conservative there.

Guest QR checkout also requires an internet connection: it has no trusted local Print Bridge and therefore never pretends to queue a guest’s payment/loyalty request offline. The QR screen clearly states that the order was not sent, avoiding uncertain duplicate submissions.

## Operations configuration data

Operations configuration is stored in the `order_operations_config` database table as JSON. It includes:

- `printers`
- `routes`
- `tableAreas`

Orders are stored in `direct_orders`; KOT records are stored in `order_kots`; daily counters are stored in `direct_order_counters` and `order_kot_counters`; print state is stored in `order_print_jobs`.

## Diagnostics

Admin includes Orders Error Logs for technical events only. It is intended to surface errors such as:

- Order/API failures
- Offline sync problems
- KOT/Bill print failures
- Missing Print Bridge or printer routes
- Slow Orders API routes

Customer details, dish names, and order contents are intentionally excluded from diagnostic logs.

## Daily operating checklist

1. Open `/orders` on the counter computer.
2. Confirm the local Print Bridge is running.
3. Confirm Bill and KOT printers are visible in Manage Printers.
4. Confirm Bill/KOT assignments and routes are saved.
5. Confirm each Windows driver uses the same 58 mm/80 mm roll setting configured in Orders.
6. Print a test Bill and KOT after changing paper or printer settings.
7. Check Orders Error Logs if a printer or sync issue is reported.

## Current follow-up work

- Complete table live states (running, KOT sent, paid) from saved table orders and Bill settlement.
- Add table move/transfer workflow for active orders.
- Expand KOT typography/settings so every saved control is reflected in the physical template.
- Add dedicated Bill/KOT test print actions in Manage Printers.

## Developer reference

### Key Orders API routes

| Route | Purpose |
| --- | --- |
| `GET /api/orders` | Current-day Orders or history/search results. |
| `GET /api/orders/live-summary` | Live order count and latest daily order number. |
| `POST /api/orders` | Saves a customer QR order. |
| `POST /api/orders/counter` | Saves a staff takeaway or dine-in counter order. Send `tableArea` and `tableNumber` for dine-in. |
| `PATCH /api/orders/:id` | Updates an order status. |
| `POST /api/orders/:id/kots` | Creates the next routed KOT(s) for unsent order items. |
| `GET /api/orders/:id/kots` | Gets KOTs for one order. |
| `GET /api/orders/kot-history` | Gets the selected day's KOT history. |
| `GET /api/orders/:id/print` | Builds the receipt data used by Bill printing. |
| `POST /api/orders/:id/bill-print/claim` | Claims a final-Bill print job safely. |
| `POST /api/orders/:id/bill-print/complete` | Marks a Bill job printed. |
| `POST /api/orders/:id/bill-print/failed` | Marks a Bill print attempt failed. |
| `GET /api/orders/operations` | Gets printers, routes, table areas, and menu data for Operations. |
| `PUT /api/orders/operations` | Saves printers and KOT routes. |
| `PUT /api/orders/operations/table-areas` | Saves table areas separately from printer routing. |
| `GET/PUT/DELETE /api/orders/availability/:key` | Reads or changes temporary menu availability. |
| `POST /api/loyalty` | Looks up wallet points by mobile number. |

### Database tables

| Table | Responsibility |
| --- | --- |
| `direct_orders` | Every saved QR, counter, takeaway, and dine-in order. Includes status, items, total, daily number, loyalty values, fulfilment, client request ID, and optional `table_area` / `table_number`. |
| `direct_order_counters` | Allocates the next daily order number. |
| `order_kots` | KOT records, ticket payloads, routing groups, and daily KOT number. |
| `order_kot_counters` | Allocates the next daily KOT number. |
| `order_operations_config` | JSON Operations configuration: printers, routes, and table areas. |
| `order_print_jobs` | Bill print claims and states (`queued`, `printing`, `printed`, `failed`). |
| `loyalty_accounts` | Customer wallet point balance, earned/redeemed totals. |
| `menu_availability` | Temporary out-of-stock menu state. |
| `website_diagnostics` | Technical diagnostic events used by Admin logs. |

### Local Print Bridge contract

The website calls the bridge only on the same counter device:

| Bridge route | Use |
| --- | --- |
| `GET http://127.0.0.1:9124/health` | Detects local printing and reports queued/blocked ledger actions and protected print-job counts. |
| `GET http://127.0.0.1:9124/v1/setup-status` | Reports the local platform, SQLite ledger health, installed printers, saved printer routes, and queued/blocked offline work. |
| `GET http://127.0.0.1:9124/v1/printers` | Lists Windows/CUPS installed printers. |
| `PUT http://127.0.0.1:9124/v1/config` | Syncs Operations printer/routing configuration. |
| `POST http://127.0.0.1:9124/v1/print-kot` | Sends one routed KOT ticket to an installed local printer. |
| `POST http://127.0.0.1:9124/v1/print-bill` | Sends one final Bill copy to a specified configured local queue; the browser dispatches once per Bill-capable printer. |
| `POST http://127.0.0.1:9124/v1/ledger/actions` | Writes a durable offline action to the local SQLite ledger. |
| `GET http://127.0.0.1:9124/v1/ledger/actions?status=queued` | Reads queued actions for controlled reconciliation. |

The bridge must remain local. Never expose port `9124` to the public internet.

Run `npm test` before a release. It performs syntax/build checks and starts a temporary Bridge with a temporary SQLite ledger to verify health reporting and durable offline queueing.

For production backups, monitoring, credentials, and incident steps, use [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

### Data integrity safeguards

- The server recalculates and validates menu prices before saving a counter order.
- Every counter order and QR direct order sends a `client_request_id`; retrying the same submission returns the original order instead of charging, redeeming points, or creating a second order.
- Mobile numbers, guest names, special requests, delivery/pickup selection, and loyalty redemption are validated and saved with the order record—not trusted from a later client refresh.
- Loyalty redemption is conditional on the current balance, is refunded once for a rejected/cancelled order, and points are awarded once on completion. Item changes recalculate points using the active loyalty configuration and cannot invalidate a redemption.
- Status changes follow a one-way workflow (`new → accepted → preparing → ready → completed`, with rejection before completion). Terminal orders cannot be reopened by an accidental click.
- Customer QR cancellation is idempotent: a repeat cancellation does not refund points twice.
- Daily order and KOT counters are database-backed to avoid collisions between staff devices.
- KOT fingerprints prevent sending the same unchanged order items repeatedly.
- Bill print jobs are claimed before printing to reduce duplicate receipt printing. The local Print Bridge also records stable automatic KOT/Bill print-job IDs, so a repeated automatic request is acknowledged without sending a second physical ticket; intentional manual reprints use a fresh ID and remain visibly marked as reprints.
- The server keeps an append-only `order_events` trail for order creation, status changes, item edits, KOT creation, table moves, bill printing, and settlement. This supports operational review without mutating the original order record.
- Printer routes are validated so one exact menu target cannot be sent to competing printer routes.
