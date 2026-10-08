# Printer recovery release — 8 October 2026

Bridge release: `2026.10.08.2`.

The incident exposed separate failures in the cloud order schema and the installed local printer service. A missing `direct_orders.service_priority` column prevented kitchen-ticket API requests. Some installed Bridges also lacked the newer `/v1/test-print` endpoint, causing a `Not found` response even when their normal KOT endpoint worked. Readiness could inspect yesterday's saved printer configuration before downloading today's routes.

The cloud now verifies the complete order schema before serving order and kitchen-ticket requests. Migration readiness is shared within each server process and does not report success when required columns are absent. `/api/orders/readiness` checks this without creating an order or printing anything.

Orders synchronizes current printer routes before asking the Bridge for readiness. It uses the configured Bridge origin consistently, bounds local requests, shares concurrent health/setup checks, and checks again after reconnecting or returning to the app. A legacy Bridge can send a clearly labeled test slip through its existing KOT endpoint if `/v1/test-print` is unavailable.

A successfully saved order remains saved if printing fails. Its cart is cleared, and printing problems that require attention remain visible so staff can recover the saved ticket without submitting another food order. Routine connection recovery on a paired workstation runs silently. Recovery reads every saved KOT round for active accepted, preparing, and ready orders. Automatic jobs retain the same IDs across app restarts; the local SQLite ledger prevents repeated requests from producing a second slip. A print with an uncertain result still requires review rather than a blind automatic duplicate.

## Remembered printer pairing

Successful workstation setup is remembered separately from the live connection check. Closing the PWA, restarting the computer or Bridge, losing the network, or a failed Windows printer-discovery query does not remove the saved workstation and printer assignments. Orders retains the last confirmed printer queues and configuration while it reconnects. The Bridge stores its identity, configuration and print ledger in its stable per-user data directory, outside the extracted installer files. If browser storage is cleared, Orders restores the established assignments from the local Bridge rather than replacing them with an empty setup.

After a pairing has been established, connection checks and retries run in the background when Orders opens, regains focus, returns online, and during service. A routine Bridge interruption does not open an alert, reset the printer setup, erase a printer-settings draft, or show a reconnect banner. Saved tickets resume using their original automatic job IDs when the service is reachable again. Initial setup and confirmed print failures or uncertain output still have visible status so staff can account for affected orders.

Settings are flushed and atomically replaced, with a backup JSON copy and an independent SQLite settings copy. Missing or damaged copies recover the established workstation identity and configuration. Cloud configuration carries an exact decimal revision; stale browser or offline saves cannot overwrite a newer configuration. Background synchronization keeps remembered bindings through failed printer discovery and only applies a newer authoritative revision. Deliberate deletions still propagate, and stale recovery cannot restore a deleted printer. Table allocation saves update only the table allocation, preserving printer assignments saved concurrently elsewhere.

Use the same signed-in operating-system account on the counter. Explicitly removing the saved Bridge data or printer assignments, or formatting the computer can remove the remembered pairing; ordinary app and Bridge restarts do not. A changed printer driver, renamed queue, or disconnected physical printer still requires the corresponding system repair.

## Install the workstation update once

1. Push the website/backend release and rebuilt setup ZIPs together to `main`. Coolify on the Contabo server deploys this Dockerfile application automatically. `/api/healthz` reports release `2026.10.08.2` and `ordersSchemaReady: true` after startup migration checks complete.
2. On the Windows counter computer, open **Orders → Operations → Print & offline setup**, download the latest Windows setup, extract it, and run `START-SETUP.cmd`.
3. Confirm **Printing is ready**, then use **Test print** for each configured printer. Keep the Orders app open on the computer hosting the Bridge during service.

The update preserves the workstation identity, printer configuration, and SQLite order/print ledger. The installed Bridge starts at Windows sign-in and its supervisor recovers stopped or unresponsive processes. It does not require a daily setup download. macOS has its corresponding one-time setup bundle.

## Regression evidence

`tests/printing-recovery.spec.js` verifies:

- A cloud-confirmed dine-in order is not requeued or resubmitted when KOT preparation returns a schema error.
- An older Bridge's missing test route falls back to a labeled test slip without creating a food order.
- Current cloud routes reach the Bridge before its readiness result is judged.
- Earlier KOT rounds recover after an app restart with the same automatic job IDs.
- A returning Bridge recovers pending work through the configured origin after an online event; another focus event does not send a second slip.
- An established pairing survives a service interruption and app reopen, retains its saved queues and routing, and resumes a saved KOT without connection alerts or another slip.
- A failed system-printer discovery does not erase remembered queues.
- Background setup checks preserve the active printer-settings draft, its input focus, and text selection.
- Cleared browser storage restores its remembered assignments from the Bridge while the website is unavailable; background recovery never replaces them with an empty configuration.

Browser tests mock cloud and Bridge responses. Separate Bridge process tests exercise durable ledger behavior. These checks do not prove that the restaurant's physical printer has paper, accepts its Windows driver, or produces a readable slip. Verify one test slip on every restaurant printer after the workstation update and after changing a driver, queue, or network address.

This release passed 191 unit/backend/Bridge tests and 27 browser checks across printing recovery, Orders, Register and employee permissions. A real Bridge supervisor crash/restart smoke test also verified recovery of damaged settings, the same workstation identity, printer routes, and queued orders. The rebuilt setup ZIPs contain the tested sources. Physical Windows installation and output remain workstation checks.
