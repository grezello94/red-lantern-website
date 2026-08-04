# Production readiness checklist

Run this checklist before relying on Orders during service.

## Automated checks

- GitHub Actions runs `npm test` on Node 22 for every pull request and change to `main`.
- `npm test` checks the application source, rebuilds the downloadable Bridge bundles, and starts a temporary localhost Print Bridge with a temporary SQLite ledger.
- In Admin, open **Database Health** after deployment. It checks the Orders database, storage warning threshold, Admin credentials, and Orders-console credentials without exposing secrets.

## One-time production configuration

- Set `NEON_DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ORDERS_USERNAME`, and `ORDERS_PASSWORD` in Vercel Production environment variables.
- In Neon, enable the strongest backup / point-in-time recovery plan available for the production project. Confirm a restore procedure at least once on a separate database; never test restoration against live production.
- Configure Vercel deployment/error notifications for the production project and review **Admin → Orders Error Logs** daily during the first week after release.
- Keep port `9124` private on the billing computer. It must only listen on `127.0.0.1`; do not add router port forwarding.

## Before each service

- Open `/orders` on the billing computer and check **Operations → Print & offline setup**.
- Confirm no SQLite ledger action is blocked, correct printers are detected, and printer routes are saved.
- Print one controlled KOT and Bill after changing a printer, printer driver, paper size, or billing computer.

## Incident handling

- If the ledger says **waiting to sync**, keep `/orders` open and restore internet; it retries cloud sync every 15 seconds.
- If it says **needs review**, do not clear browser data, uninstall the Bridge, or delete `~/.red-lantern-print-bridge`. Resolve or record the action first.
- If database health fails, stop accepting non-essential changes, preserve the diagnostic timestamp, and use the verified Neon restore process only if data recovery is required.
