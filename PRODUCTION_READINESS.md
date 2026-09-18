# Production readiness checklist

Run this checklist before relying on Orders during service.

This file is also the release sign-off record. Do not mark a manual check as
passed from memory: add the date, tester, device, and evidence such as a photo,
screenshot, order number, log timestamp, or restore report.

## Status and release decision

- Release / commit: ____________________
- Test environment: Production / Staging / Local: ____________________
- Test window (Goa time): ____________________
- Test lead: ____________________
- Current decision: **NOT SIGNED OFF**
- Known exceptions approved by: ____________________

Status values:

- `[x]` passed with evidence
- `[ ]` not tested
- `[!]` failed or needs attention
- `[n/a]` genuinely not applicable, with a written reason

The production decision may be changed to **READY** only when every critical
test below is `[x]` and every failure has been resolved and retested.

## Automated checks

- GitHub Actions runs `npm test` on Node 22 for every pull request and change to `main`.
- `npm test` checks the application source, rebuilds the downloadable Bridge bundles, and starts a temporary localhost Print Bridge with a temporary SQLite ledger.
- In Admin, open **Database Health** after deployment. It checks the Orders database, storage warning threshold, Admin credentials, and Orders-console credentials without exposing secrets.

Latest local automated result (18 September 2026 re-audit):

- [x] Lint and type checking — passed
- [x] Unit tests — 117/117 passed
- [x] Browser regression tests — full suite 36/36 passed after live KOT dispatch changes
- [x] Local Print Bridge integration test — passed with an isolated temporary ledger
- Runtime used locally: Node 24.12.0; CI remains configured for Node 22.

Re-audit fixes:

- Orders bill failures no longer open a browser print window or falsely mark a bill printed.
- Orders alerts use dismissible in-page notices; explicitly entered wallet redemption no
  longer asks for two additional confirmations. Destructive/conflict confirmations remain.
- Register receipt reprints use configured Bridge Bill printers with per-printer formatting.
- Concurrent repeat clicks cannot dispatch a second manual bill while the first is pending.
- Bridge health requests used by service printing time out after 2.5 seconds instead of
  leaving recovery waiting indefinitely. Cloud KOT creation still starts immediately.
- A failed KOT is no longer hidden by a successful automatic bill result.
- Recovery preserves different orders queued while an earlier deferred print is processing.
- Missing Retry-After headers now use the intended retry backoff.
- Setup readiness can refresh after automatic printer pairing without assigning to a constant.
- Offline Orders shell asset versions now match the current page.

These changes do not establish an instant physical-print latency guarantee. Test the actual
billing computer, Bridge, driver, printer, and production database under rush load before
sign-off. Browser tests use mocked API and printer responses. Explicit report printing and
legacy browser KOT rendering still use browser print UI; routine order/bill printing does not.

These results verify the software paths, but they do not replace the physical
printer, production database, network, or staff tests below.

## One-time production configuration

- [ ] `NEON_DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
  `ORDERS_USERNAME`, and `ORDERS_PASSWORD` are set in Vercel Production.
  Verified by/date: ____________________ Evidence: ____________________
- [ ] Neon backup / point-in-time recovery is enabled and a restore was tested
  against a separate database, never the live database.
  Verified by/date: ____________________ Restore report: ____________________
- [ ] Vercel deployment and error notifications reach the responsible person.
  Verified by/date: ____________________ Evidence: ____________________
- [ ] Port `9124` listens only on `127.0.0.1` on the billing computer and no
  router port-forwarding exposes it.
  Verified by/date: ____________________ Evidence: ____________________

## Database backup and restore policy

The application database is Neon Postgres. Application code cannot prove that
the Neon project has backups enabled, so production backup status remains
**unverified** until the project owner completes and records these checks:

1. In the Neon Console, open the production project and **Backup & Restore**.
   Enable a daily scheduled snapshot on a plan that supports scheduled backups.
2. In project **Settings**, set the restore window to the longest retention that
   fits the business requirement and plan. This is the point-in-time recovery
   window for accidental edits or deletions.
3. Once a month, restore a snapshot or selected restore point to a separate
   branch/database. Never use the live production branch for a restore drill.
4. In the restored copy, verify `direct_orders`, `order_kots`, payment fields,
   `trusted_contacts`, menu content, Operations printer routes, and Smart KDS
   configuration. Record row counts, the restore point, tester, and result.
5. Keep an encrypted, access-controlled off-platform `pg_dump` for disaster
   recovery according to the restaurant's retention policy. Never commit a dump
   or `NEON_DATABASE_URL` to Git.

Backup owner: ____________________

Daily snapshot/PITR verified on (Goa time): ____________________

Latest separate-database restore drill: ____________________

Restore evidence/location: ____________________

Recovery objective: restore to within ______ hours, service resumed within ______ hours.

## Critical end-to-end acceptance tests

Use unique test customer numbers and write the resulting order/KOT numbers in
the evidence field. Remove or clearly label test orders afterward.

### QR ordering and trusted contacts

- [ ] An unknown mobile number's first QR order waits for counter approval and
  does not reach the kitchen early.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] After approval, that number's next QR order is accepted automatically and
  reaches every correctly routed kitchen destination once.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] A number imported without a name is saved as trusted, auto-accepted, and
  remains searchable by mobile number after refresh and sign-in on another device.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Blocking a trusted number restores manual approval; unblocking restores
  auto-acceptance.
  Tester/date/device: ____________________ Evidence: ____________________

### Register, Captain and table service

- [ ] Create one dine-in order from the Register. Confirm table/area, customer,
  Captain name, item prices, quantities, total, and KOT number are correct.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Create and add to one table order from the Captain App. Confirm separate
  KOT rounds, correct Captain names, and no duplicated items or tickets.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Test takeaway and delivery orders and confirm the correct fulfillment
  label appears on the Register, KOT, bill, history and printable summary.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Refresh and hard-refresh Tables, Live orders, New takeaway, Operations,
  Customer & Orders, Captain App, Air Menu and Trusted Contacts. Each returns
  to the same section without losing a saved order or unsent draft.
  Tester/date/device: ____________________ Evidence: ____________________

### Payments and printing

Automated on 15 September 2026: Register single and split settlement now writes
each Cash, UPI/GPay, Card, Zomato, Other or Due allocation to the database
payment ledger. The backend validates every allocation against the saved bill
total, treats cash overpayment as change, treats UPI overpayment as a tip, and
uses an idempotency key so a repeated click cannot create a second settlement.
The Dashboard and the Admin/Register date-wise print summaries read actual
collected, outstanding, change and tip values from that ledger. Parked/held
orders remain open and do not become sales or collections until completed.

- [ ] Cash settlement records tendered cash, bill amount and change correctly.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] UPI settlement records the received amount and any extra amount according
  to the configured tip/change policy.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] A normal KOT prints exactly once at every routed kitchen printer.
  Tester/date/printers: ____________________ Evidence: ____________________
- [ ] Reprint produces a clearly marked **DUPLICATE COPY** and does not create a
  new order or new KOT round.
  Tester/date/printers: ____________________ Evidence: ____________________
- [ ] The bill and Admin/Register summary show payment mode, table or parcel
  reference, staff names, prices and totals correctly.
  Tester/date/printers: ____________________ Evidence: ____________________

### Add-ons and modifiers

Automated on 03 September 2026: Admin rule/assignment persistence, Register,
Captain and QR selection, min/max and sold-out validation, authoritative price
snapshots, history, browser fallback KOT, bill/KOT Print Bridge payloads and
formatting, Normal KDS, and Smart KDS all passed. The checks below remain manual
release evidence because they require the deployed Neon database and actual
restaurant printer queues.

- [ ] Create one required single-choice group and one optional multiple-choice
  group, assign both to a dish, publish, then confirm they appear in Register,
  Captain and QR ordering.
  Tester/date/devices: ____________________ Evidence: ____________________
- [ ] Confirm minimum and maximum rules prevent an invalid order on every client,
  and confirm a forged or stale add-on ID is rejected by the server.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Place a variant item with paid add-ons. Confirm the database total, Register,
  bill, KOT, Normal KDS and Smart KDS show the same choices and amount.
  Tester/date/printers: ____________________ Evidence: ____________________
- [ ] Disable one add-on choice and confirm it disappears from new orders while
  an older order and reprinted bill/KOT retain the saved choice snapshot.
  Tester/date/device: ____________________ Evidence: ____________________

### Failure recovery

- [ ] Disconnect internet after pressing Send KOT, reconnect, and retry. Confirm
  only one database order and one logical KOT exist.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Save or hold an order offline, reconnect, and confirm it synchronizes once
  without losing the table reservation.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Stop the Print Bridge, send a controlled order, restart the Bridge, and
  confirm the pending print is recovered without uncontrolled duplicates.
  Tester/date/device: ____________________ Evidence: ____________________
- [ ] Complete the separate-database Neon restore drill and verify order, KOT,
  payment and trusted-contact records in the restored copy.
  Tester/date: ____________________ Evidence: ____________________

### Device and peak-service test

- [ ] Register tested on the actual billing computer and supported tablet.
  Devices/browsers: ____________________ Evidence: ____________________
- [ ] QR menu tested on at least one current iPhone and one Android phone.
  Devices/browsers: ____________________ Evidence: ____________________
- [ ] Run a supervised rush rehearsal with simultaneous table, takeaway and QR
  orders. Confirm staff can understand Smart KDS priorities and no accepted
  order is lost, duplicated, or routed to the wrong station.
  Order count/duration/staff: ____________________ Evidence: ____________________

## Final sign-off

- [ ] All critical checks above passed.
- [ ] Every `[!]` result was fixed and retested.
- [ ] Admin → Database Health is healthy after the production deployment.
- [ ] Admin → Orders Error Logs has no unresolved release-blocking errors.
- [ ] Rollback owner and incident contact are available for the first service.

Decision: READY / NOT READY: ____________________

Approved by: ____________________ Date/time (Goa): ____________________

Notes and accepted limitations:

______________________________________________________________________________

______________________________________________________________________________

## Before each service

- Open `/orders` on the billing computer and check **Operations → Print & offline setup**.
- Confirm no SQLite ledger action is blocked, correct printers are detected, and printer routes are saved.
- Print one controlled KOT and Bill after changing a printer, printer driver, paper size, or billing computer.

## Incident handling

- If the ledger says **waiting to sync**, keep `/orders` open and restore internet; it retries cloud sync every 15 seconds.
- If it says **needs review**, do not clear browser data, uninstall the Bridge, or delete `~/.red-lantern-print-bridge`. Resolve or record the action first.
- If database health fails, stop accepting non-essential changes, preserve the diagnostic timestamp, and use the verified Neon restore process only if data recovery is required.

## Silent printer-process follow-up — 18 September 2026

Print Bridge 2026.09.18.1 explicitly runs printer PowerShell commands hidden and
non-interactively, without a command shell. Windows upgrades retire the legacy
Bridge scheduled task and CMD Startup launcher. WScript startup uses batch mode
and returns failures as exit codes instead of displaying script-error dialogs.
The supervisor and restart children retain their hidden-process settings.
macOS service startup already uses launchd without opening Terminal.

Install the updated Bridge bundle on the billing computer; deploying the website
alone cannot update its installed local Bridge. The one-time ZIP setup still
opens its setup console. Normal service startup, recovery and printing are hidden.
Windows visual verification (sign-in, several KOTs/bills, Bridge restart) remains
pending; local automated checks cannot verify third-party driver UI on Windows.

## Counter/Captain KOT dispatch follow-up — 18 September 2026

- Counter Send KOT starts dispatch immediately after the cloud save succeeds;
  KOT creation and Bridge readiness checks run concurrently.
- Live SSE and persisted events carry the affected order ID. The billing computer
  dispatches that order directly, independently of history/search filters or a
  pending full order-list refresh. New events arriving during dispatch trigger
  a follow-up so an additional round is not skipped.
- Captain release of saved/held KOTs updates acceptance before notifying the
  billing computer. Smart KDS timing computation no longer blocks that response.
- Saved/held/unaccepted orders remain ineligible for automatic kitchen dispatch.
- Verification: 117 unit tests, 36 browser tests, syntax, lint and type checks passed.
  Browser coverage includes direct Captain dispatch while history is open and the
  order-list refresh is blocked, and no early printing of saved/held counter orders.

Dispatch is immediate on a received live event; the cross-instance event poll runs
once per second. This is not a zero-latency guarantee: database/network round trips,
OS spooling and paper movement still take time. Keep Orders open on the billing
computer with Bridge running. Deploy these server/frontend changes and measure
press-to-paper latency on the restaurant's actual network before service sign-off.

## Captain bill dispatch follow-up — 18 September 2026

Captain bill live events now reuse their already-loaded receipt and dispatch only
the bill, avoiding an extra receipt fetch and unnecessary KOT processing. Recovery
without a prepared receipt fetches it concurrently with Bridge readiness/config.
The print claim still prevents competing workstations from printing the same bill.
Captain location validation, database confirmation and physical printer time remain
necessary; zero-millisecond printing cannot be promised. This change needs website
and server deployment; keep Orders and the local Bridge running on the billing PC.

Validation: Orders browser suite 29/29 passed, including one receipt read and one
Bill dispatch for a Captain request while history is open. Lint, type checking and
application syntax checks passed.
