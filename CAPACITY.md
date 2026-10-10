# Restaurant concurrency and deployment checks

The application runs on Coolify/Contabo with a separate Neon database and local
Windows print bridge. There is no verified production device/order ceiling yet.
CPU, container memory, Neon compute, connection latency, menu/order sizes, and
printer queues all affect that ceiling. A stored order count is not a concurrent
request limit, and one device can generate several requests.

## Protections in one server process

| Work | Default maximum |
| --- | ---: |
| Active ordinary API requests | 64 total |
| Concurrent reads | 48 |
| Concurrent order/payment/other mutations | 24 |
| Concurrent large imports/external analysis | 2 |
| Live event streams | 128 |
| Concurrent database HTTP requests | 24 |
| Waiting database HTTP requests | 128 |

Reads and imports have separate limits so they cannot use every order/payment
slot. Excess work receives HTTP 503 and `Retry-After`; it is rejected before its
handler runs. Clients must retain their request ID and retry. The Orders local
ledger already retains unsynced counter orders. QR/Captain retries retain their
original request ID and now respect the full server backoff with jitter.

Database queue waits stop after 2 seconds; each complete SQL HTTP response has a
15-second deadline. The transport never retries a SQL write automatically:
failure to receive a response does not prove that the write failed to commit.
Order and payment idempotency identifiers handle that uncertainty.

Concurrent order reads share a bounded 500-ms snapshot, with authorization applied
independently to each response. Successful mutations invalidate the snapshots.
New order timing work calculates that order, rather than every open order.
Hidden Orders screens pause their display polling; durable queued saves still
sync in the background. Live streams are disconnected on backpressure and recover
through their persisted event cursor.

The current-order view retains every active ticket for the current operating day
plus the most recent 100 terminal orders. The history view still retrieves its
most recent 100 matching orders; it is not unlimited history pagination.
Public QR orders allow 300 submissions/minute per IP by default, plus 30/minute
per customer/IP, so a shared restaurant Wi-Fi connection does not have the old
30-order aggregate limit. These are abuse guards, not measured capacity.

## Repeatable isolated verification

```sh
npm run test:unit
npm run test:load -- --json=/tmp/red-lantern-server-load.json
```

The load harness refuses non-loopback application URLs and `.env` reads. It runs
real Express routes, authentication, API admission, and SQL transport controls
against an explicitly simulated database with 20–40-ms query latency, plus a
150–170-ms slow-query scenario. It never submits restaurant orders or prints.
The PostgreSQL regression suite separately uses PGlite to run real parameterized
SQL with deterministic competing request interleaves. PGlite is a single-process
test engine; this is not a multi-session Neon benchmark.

Observed final local burst results (Apple Silicon, Node 22.23.3, matching the
production Docker major version):

| Simultaneous clients | Orders saved | Order p95, including retries | Health p95 |
| --- | ---: | ---: | ---: |
| 25, two rounds | 50 | 0.37 s | 8.2 ms |
| 50, two rounds | 100 | 2.31 s | 37.5 ms |
| 100, two rounds | 200 | 6.28 s | 41.4 ms |
| 100, slower simulated SQL | 100 | 9.43 s | 3.9 ms |

All 1,890 mixed logical requests completed in that run, including 450 new counter
orders; excess requests retried. The harness permits up to 12 attempts to measure
eventual recovery, whereas a single foreground QR/Captain action retries at most
four times. Counter ledger recovery can continue later. Twelve concurrent retries
with one request ID produced one order. Eight competing submissions to one blank
table produced one order and seven explicit review conflicts. No crash or duplicate
number was observed. The simulated fixture holds its data in the test process,
so its 356-MiB peak RSS is not a measurement of production server memory.

These short bursts demonstrate controlled overload and integrity, not a promise
that Contabo handles 100 devices without waiting or that software cannot crash.
Verify a sustained workload in a separate staging app/database with the same
Contabo/container limits before announcing a production ceiling. Include customer
QR submissions, employee PIN sign-ins, payment, printing, and larger active boards
in that staging mix. Do not run the harness against the live restaurant.

## Coolify operations

The Docker entrypoint runs Node directly so it receives termination signals.
On SIGTERM/SIGINT, the server refuses new work, closes live streams, finishes
tracked handlers and background work, then closes the database transport. The
default overall deadline is 30 seconds. Set Coolify/container stop grace time to
at least 40 seconds; a supervisor issuing SIGKILL earlier preempts application
draining. Limits can be configured using the documented variables in `.env.example`.

`/api/healthz` is lightweight liveness and stays accessible under API overload.
`/api/readyz` reports whether the startup orders schema is prepared and the server
is accepting work; it is not a per-request remote database connectivity test.
Authenticated Admin can read `/api/admin/runtime` for active/peak requests,
rejections, database queue state, memory use, and background-task count. Watch
these alongside Coolify CPU/RAM and Neon query latency when tuning limits.

Printer delivery is separately bounded by Windows spooler and printer speed.
Durable ticket routing/recovery and database order integrity cannot guarantee
that an unplugged or failed physical printer will print.
