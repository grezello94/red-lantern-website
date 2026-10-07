# Captain App feature coverage

The Captain App is the table service workspace. Online acceptance, token management and feedback remain separate responsibilities.

## Daily operations

- New dine-in KOTs and additional rounds, pickup and delivery orders when granted.
- All, running, empty, attention and pending-bill table filters.
- Kitchen notifications for completed KOTs or individual Smart KDS tasks. System notification permission is requested explicitly under Service tools; live in-app updates remain available. Notifications require the app to remain active; this is not a background push subscription.
- Service tools: Sync data, Update menu, Unsuccessful KOTs, Pending bills, Server connection, Notifications, Printer settings and App settings.
- Unsuccessful KOTs use the existing per-account durable journal, request IDs, saved-order KOT retries and explicit review of table conflicts. Turning automatic sync off preserves manual retry. A failed menu sync reports failure instead of claiming success.
- Native order actions: edit quantities (zero removes), cancel the order and its KOTs, collect payment, apply ordinary/special dine-in discounts, assign table service and set priority. Server checks apply to direct API requests as well as visible controls.
- New tables can be added to an assigned area without leaving Captain.
- Logout and account/session revocation retain the existing behavior.

## Admin settings

Admin → Captain App → Captain App settings controls delivery, takeaway, A–Z/popularity sorting, recommendations, guest names, order details, guest details first, voice search, waiter assignment, mandatory KOTs, automatic retry, order priority, Captain printing and item/KOT/no notifications. These settings save with employee accounts and are refreshed with authenticated sessions. Employee action permissions remain independently required.

Mandatory KOT printing requires submission with Send KOT and a configured kitchen queue. A saved order whose KOT cannot be created remains recoverable. Successful KOT creation records the ticket; physical paper output still depends on the existing Orders/print-bridge dispatch workflow and the printer. This change does not replace bridge dispatch or claim paper output has been confirmed.

Voice search uses browser speech recognition when available and falls back to typed search. Item-ready notifications use persisted Smart KDS task readiness; conventional KDS provides whole-ticket readiness.

## Assignment, priority and discounts

Table assignment transfers responsibility to an eligible Captain/waiter in the dining area. Optional KOT waiter selection records the waiter on the saved ticket separately from table ownership; KDS and bridge-generated printouts show that waiter. Selecting a KOT waiter does not broaden that employee's table access.

Order priority requires the Set order priority grant and enabled priority setting. Urgent orders gain a priority modifier in Smart KDS while timing, capacity and fairness rules remain in force. Conventional KDS displays the urgency.

Ordinary and special discounts have separate grants. Both are dine-in only and use the employee's configured amount/percentage limit and an audit reason. Special discounts do not bypass that limit.

## Printers and connectivity

Kitchen printer formats can be inspected in Captain; employees with configuration permission can change 58/80 mm paper and item serial numbers. Settings update the existing shared printer configuration with a conflict check. Bluetooth queues are paired and installed on the print bridge computer. Custom paper forms and cutter behavior are configured in the system printer driver; the browser does not directly pair Bluetooth printers.

Server connection shows the configured origin and performs an authenticated connectivity check. Hosted deployments have a hostname rather than a restaurant LAN IP. The app does not scan the local network or change server addresses.

## Clarification pending

The supplied phrase “Contactless PIN” could mean a temporary guest PIN for table QR ordering or the existing captain PIN and offline order capture. Captain sign-in and offline drafts/queued orders already work. A separate guest table PIN has not been added pending clarification; guest QR submissions currently need server connectivity.

## Validation boundaries

Automated authorization tests use a mocked database. Browser tests exercise layouts and request payloads with mocked APIs. Physical printers, Bluetooth pairing, browser microphone recognition and a live restaurant database require deployment/device verification.
