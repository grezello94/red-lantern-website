# Restaurant flow audit — 16 October 2026

This audit records verification of the application changes for Admin, employee access, Captain, Orders, Register, KDS, Smart KDS, offline recovery, and printing.

## Flows checked

| Area | Checks and fixes | Main regression coverage |
| --- | --- | --- |
| Admin | Menu/profile drafts across filters, navigation and delayed saves; station setup; activation and timing overrides; employee role validation; atomic station/profile batches with complete validation before writes. | `admin-configuration.test.js`, `admin-batch.test.js`, `employee-admin.test.js`, Admin browser suites |
| Sign-in and permissions | Protected route aliases; restricted employee grants online/offline; stale session responses; account changes clear cached reads and visible guest data; queued work retains its original employee identity. | `orders-auth-routes.test.js`, `staff-access.test.js`, `auth-cache.test.js`, employee browser suites |
| Captain | Per-table guest/cart drafts; course and quantity handling; save/hold/send; KOT retry; assignment and service tools; ready alerts and serving; sign-out and slow-response races; durable offline journal and request IDs. | Captain regression/reliability/tool/browser suites, PostgreSQL concurrency tests |
| Orders | Reopen and edit existing bills; authoritative prices and deductions; exact revision checks; order search/history/current-floor separation; table moves; stock availability; cancellation; discounts; zero-value bills; split receipt calculations; submission locks and malformed acknowledgements. | `orders-concurrency.test.js`, `orders-deep-audit.test.js`, Orders/counter/table/availability browser suites |
| KDS | Saved KOT routing and quantities; every kitchen round remains visible; reductions and served rounds; selected-round status transitions; duplicate/stale updates; settled-order races; additional units receive separate production identities. Legacy source identities survive edits. | PostgreSQL deep audit and `tests/kds-reliability.spec.js` |
| Smart KDS | Held/capacity/fired instructions; manual/shadow permissions; pending actions; timelines and override dialog races; accessible additional controls; connection warnings and expired sessions; legacy KOTs do not serve later additions. | Smart KDS domain suites, PostgreSQL deep audit and KDS browser regressions |
| Register | Exact bill revisions and employee identity; stable settlement IDs; lost responses and duplicate submissions; cash/change, split/partial/due and zero-value payments; stale list/bill views; table labels; summary and print retries; sign-out cleanup. | `payments-domain.test.js`, `register-client.test.js`, Register browser suites |
| Offline and printing | Reconnect/replay, retryable vs rejected work, concurrent enqueue protection, malformed queue quarantine, scoped service workers, offline shells, private-cache invalidation, pending/uncertain print acknowledgements, stable per-printer job IDs, monetary wallet discounts and paise. Installed Captain updates now cache exact helper versions, preserving the current release after an offline reload. | Service-worker/auth/cache/request tests, offline/printing browser suites, real HTTP-cache migration regression, Print Bridge tests and smoke script |
| Guest menu | Existing QR access/order-window, modifier, stock and responsive menu scenarios run in the full suite; shared submission confirmation handling is covered by request-helper tests. | Air Menu and order-window browser suites; add-on and order-request tests |

## Cross-workspace transaction

`orders-deep-audit.test.js` exercises the real Express API against an isolated PostgreSQL engine (PGlite): configure kitchen routing → Captain saves a table → release KOT → KDS preparing/ready → Captain ready alert and served → Orders adds another unit with a new source ID → release and serve the next KOT → apply discount → Register split payment with cash change → repeat the settlement safely → verify summary and payment rows → reuse the table for the next guest.

Other database regressions interleave payment, edits, assignment and kitchen updates to verify stale requests cannot modify newer state. Admin regressions inject database failures partway through batches and verify rollback.

## Verification

- Full unit/API suite: **42 suites, 483 tests passed** on Node 22.23.3.
- Complete browser suite: **231 tests passed**, with retries disabled, including installed-worker update coverage.
- `npm run check`, `npm run typecheck`, `npm run lint`: passed.
- `node scripts/test-print-bridge.js`: passed with an isolated SQLite ledger and simulated printer.
- Print Bridge release **2026.10.15.1**: Windows/macOS setup archives rebuilt; embedded bridge/helper files verified against source. ZIP output is reproducible across source timestamps, timezones, file modes, and the locally tested Node 22/24 runtimes. Mac launchers retain executable permissions.
- Local load/retry checks: **passed** at 25, 50 and 100 simulated users, plus slow-database pressure at 100 users. All requests completed after controlled overload retries; no request errors. Twelve simultaneous retries saved one order; eight contenders for one table created one order and seven conflicts; order/bill numbers remained unique. This uses a simulated database and is not a production capacity measurement.

## Release preparation

- `npm run release:check` and CI now include the full application build and isolated Print Bridge smoke check, alongside unit/API, load and browser checks. The complete release command passed under Node 22.23.3 after the dependency updates.
- Production Docker packaging excludes local backup extracts, test fixtures and development metadata. Required browser helpers and downloadable Bridge setup files remain included.
- The final Node 22 production image (`red-lantern-flow-audit:local`) builds and has passed an isolated container smoke check for unprivileged execution, health/readiness, staff authentication, workspace pages, runtime assets, native image processing and Bridge downloads. Networking was disabled and fixture credentials were used.
- Production dependency audit: **0 reported vulnerabilities**, reduced from 7. The lockfile updates Multer, proxy-addr, qs, Sharp and brace-expansion within existing direct dependency ranges. A scoped ExcelJS UUID override preserves its CommonJS API; a real XLSX export/import roundtrip covers values, styles and extended conditional-format IDs.
- Deployment path: the owner confirmed on 16 October 2026 that GitHub pushes automatically deploy the website and POS at `https://www.redlanternrestaurant.in/`. Check live health, staff sign-in redirects and released asset versions after pushing to `main`. Physical printer/device/network checks and production backup/restore evidence remain recorded as unverified in [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

Browser scenarios use controlled API/Bridge responses. The complete transaction and concurrency regressions run real SQL locally; they do not connect to the production database. Physical receipt/KOT output, production credentials/data, and actual restaurant devices still require validation in the restaurant environment. Passing these checks does not establish that every possible input, device, or production condition is bug-free.
