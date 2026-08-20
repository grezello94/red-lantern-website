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
