# Red Lantern Website

This project powers the restaurant's website, staff console, and Captain mobile flow.

## Stack

- Node.js 22
- Express server for API routes and static hosting
- Plain browser JS for `orders` and `captain` pages
- Jest for unit tests
- Playwright for smoke browser tests
- GitHub Actions for CI

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app locally:

   ```bash
   npm run dev
   ```

3. Open the app in the browser:

   - `/orders.html`
   - `/captain.html`
   - `/index.html`

## Useful commands

```bash
npm run lint
npm run format
npm run typecheck
npm run test:unit
npm run e2e
npm run release:check
```

## Release workflow

Use the release scripts to verify the repo before tagging:

```bash
npm run release:check
npm run release:tag
```

The tag script checks the current branch and repo status, then creates an annotated tag based on the version in `package.json`.

## Notes

- The `orders` and `captain` pages rely on a local print bridge for hardware printing. The runtime config is exposed via `window.RED_LANTERN_CONFIG.printBridgeOrigin` in `client-config.js`.
- Browser smoke tests are kept in `tests/` and are run separately from Jest via `playwright.config.js`.
- Type checks are intentionally light and centered around the modularized order helpers under `src/orders`.

## Add-on and modifier management

No manual database query is required. In **Admin → Air Menu & QR Ordering → Add-on Management**:

1. Create a reusable group such as `Choose crust` or `Extra toppings`.
2. Set the minimum, maximum and single/multiple selection rule.
3. Add choices, prices and availability. A zero-price choice is supported.
4. Use **Assigned dishes** to search for and select every menu dish that uses the group.
5. Publish the Air Menu settings.

The configuration is stored in the existing Neon-backed Air Menu record, with revision backups. Register, Captain and QR ordering receive the assigned groups from the server. Every order is repriced and validated on the server; the submitted browser price is never trusted. The selected names and prices are saved with the order so historical bills and KOTs remain understandable after a future menu edit.

An authenticated inventory integration can update one choice without republishing the full menu:

```text
PATCH /api/admin/air-menu/addons/:groupId/options/:optionId/availability
Content-Type: application/json

{ "active": false }
```

Disabled choices disappear from new Register, Captain and QR customisation dialogs. Existing submitted orders retain their saved selection snapshot.

The completed application path covers Admin creation and dish assignment,
single/multiple min-max enforcement, sold-out controls, secure server-side
repricing, immutable order snapshots, Register/Captain/QR ordering, order
history, bills, KOTs, browser fallback printing, Normal KDS and Smart KDS.
Automated coverage is included in `addons-domain.test.js`,
`print-bridge-format.test.js`, `tests/admin-smoke.spec.js` and
`tests/orders-smoke.spec.js`. A production release still requires the physical
printer and Neon verification recorded in `PRODUCTION_READINESS.md`.
