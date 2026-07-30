# Red Lantern Orders

This document describes the restaurant staff Orders console: QR orders, counter takeaway orders, dine-in tables, KOTs, bills, printers, offline behaviour, and Operations configuration.

## Main staff flow

`/orders` is the secure staff console. It has three order-entry paths:

1. **QR orders** — a customer scans a table or business-card QR code and orders through the Air Menu.
2. **Takeaway** — counter staff create a walk-in or phone order from the staff menu.
3. **Dine-in tables** — staff select an allocated table and create a dine-in order from the same counter menu.

All saved orders receive a daily order number. KOT numbers use one restaurant-wide daily sequence across QR, takeaway, and dine-in orders, and reset to `1` at the start of each India/Kolkata day.

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

### Print Bridge

Physical printing requires the local `print-bridge.js` process on the counter computer. The website sends print jobs to `http://127.0.0.1:9124`; Vercel cannot directly reach LAN/USB printers.

The Print Bridge:

- Detects Windows installed printers.
- Receives KOT/Bill jobs locally.
- Uses the printer's configured 58 mm or 80 mm preference to select the matching Windows thermal paper form.
- Uses small margins to reduce blank paper at the top.
- Receives per-printer receipt/KOT settings with each job.

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
- Counter orders created while offline are stored safely in the current browser/device queue.
- When internet returns, the console syncs queued counter orders without reloading the page.
- The page shows an offline/sync message while work is waiting.

Important: cloud saving requires internet. Local physical KOT/Bill printing while the internet is down requires a local workflow/bridge plus the relevant order data already available locally. LAN cable connection alone does not make a cloud-hosted order API available.

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
| `GET http://127.0.0.1:9124/health` | Detect whether local printing is available. |
| `GET http://127.0.0.1:9124/v1/printers` | Lists Windows/CUPS installed printers. |
| `PUT http://127.0.0.1:9124/v1/config` | Syncs Operations printer/routing configuration. |
| `POST http://127.0.0.1:9124/v1/print-kot` | Sends one routed KOT ticket to an installed local printer. |
| `POST http://127.0.0.1:9124/v1/print-bill` | Sends one final Bill to the configured local Bill printer. |

The bridge must remain local. Never expose port `9124` to the public internet.

### Data integrity safeguards

- The server recalculates and validates menu prices before saving a counter order.
- `client_request_id` prevents duplicated counter orders during retries/offline sync.
- Daily order and KOT counters are database-backed to avoid collisions between staff devices.
- KOT fingerprints prevent sending the same unchanged order items repeatedly.
- Bill print jobs are claimed before printing to reduce duplicate receipt printing.
- Printer routes are validated so one exact menu target cannot be sent to competing printer routes.
