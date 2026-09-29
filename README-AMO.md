# Beldex Wallet: build notes for AMO reviewers

- **Add-on:** Beldex Wallet 1.0.0
- **Add-on ID:** `beldex-wallet@beldex.io`
- **Publisher:** the Beldex team (https://beldex.io)
- **Source:** https://github.com/Beldex-Coin/beldex-wallet-extension

## Build environment

- Linux x86_64. We tested on Ubuntu.
- Node.js 22 LTS (tested 22.23.2) and npm 10 (tested 10.9.8).
  Node 20 or newer is required: on Node 18 the build fails inside `copy-webpack-plugin`.
- No other tools, no `.env` file and no environment variables are needed. Every endpoint comes from
  [`src/lib/networks.json`](src/lib/networks.json).

## Build

```bash
npm ci
npm run build-for-amo
```

The add-on is written to `firefox/`, with `manifest.json` at its root. Compare that folder file by file
with the uploaded package.

To also run the test suite (optional), run `npm test` after the build. Several tests use the built bundle,
and `test/bridge.test.mjs` runs the crypto bridge under `--disallow-code-generation-from-strings`,
which is the same restriction the MV3 CSP enforces.

## Where each file in the package comes from

| File in `firefox/` | Source |
|---|---|
| `manifest.json` | [`public/manifest.firefox.json`](public/manifest.firefox.json). At build time, `webpack.config.js` fills in `host_permissions` from the URLs in `src/lib/networks.json`. |
| `panel.js` | [`src/popup/`](src/popup/) (React UI in the sidebar) |
| `approval.js` | [`src/approval/`](src/approval/) (approval window for dapp requests) |
| `background.js` | [`src/background/`](src/background/) |
| `content.js` | [`src/content/`](src/content/) (relays dapp messages between the page and the background) |
| `inpage.js` | [`src/inpage/`](src/inpage/) (the `window.beldex` provider for dapps) |
| `panel.html`, `approval.html`, `icons/` | [`public/`](public/), copied unchanged |
| `fonts/*.woff2` | npm packages `@fontsource/michroma` and `@fontsource/space-mono`, copied unchanged |
| `*.LICENSE.txt` | License headers of the bundled npm libraries, extracted by webpack |
| `assets/BeldexLibAppCpp_WASM.wasm` | [`vendor/beldex-app-bridge/`](vendor/beldex-app-bridge/), copied unchanged (see below) |

The `.js` files are minified webpack output. The source for all of them is in `src/`, and the build uses
no source maps or eval-based tooling. npm dependencies are pinned in `package-lock.json` and are not modified.

## The crypto core (WebAssembly)

All key handling and transaction signing is done by the Beldex crypto library: C++ from
https://github.com/Beldex-Coin/beldex-core-cpp, compiled to WebAssembly with Emscripten. It ships as the
package `@bdxi/beldex-app-bridge` 3.1.0 (wrapper source:
https://github.com/Beldex-Coin/beldex-utils), which is kept in
[`vendor/beldex-app-bridge/`](vendor/beldex-app-bridge/) and installed through a `file:` dependency.

| File | What it is | sha256 |
|---|---|---|
| `BeldexLibAppCpp_WASM.wasm` | The compiled crypto core | `63ef334eec3552352ee37328b6dca7174544105c88de74fe07ef246b780b798a` |
| `BeldexLibAppCpp_WASM.js` | Emscripten-generated loader, not minified, with one change (below) | `2ba36781e7a1a817168fc6e87ccfde288ae768ed473d876e63d67492741b5553` |
| `index.js` | Plain JavaScript wrappers from beldex-utils | |

**Our one change to generated code.** Emscripten's loader normally builds some functions with
`new Function`, which the MV3 CSP forbids. [`scripts/patch-embind-csp.mjs`](scripts/patch-embind-csp.mjs)
replaces that single function (`craftInvokerFunction`) with one that does the same work without
generating code. This is equivalent to what Emscripten emits with `-sDYNAMIC_EXECUTION=0`. The patch is
already applied to the vendored file. To confirm it, run the script again, and it reports `already patched`:

```bash
node scripts/patch-embind-csp.mjs vendor/beldex-app-bridge/BeldexLibAppCpp_WASM.js
```

**Rebuilding the WASM from source:**

- beldex-core-cpp commit: [FILL]
- Emscripten version: [FILL]
- Build command: [FILL]

## Network access

The seed and spend key never leave the browser. They are stored encrypted (AES-256-GCM, with the key
derived by PBKDF2 at 600,000 iterations), and every transaction is signed locally by the WASM core. The
add-on has no analytics and no remote code, and it adds no fees of its own.

These are the only hosts it contacts, which are also the only entries in `host_permissions`:

| Host | Purpose | Data sent |
|---|---|---|
| `lwsapi.rpcnode.stream`, `lwstestapi.rpcnode.stream` | Beldex light-wallet server (mainnet and testnet). `rpcnode.stream` is Beldex's domain for its public nodes. | Wallet address and private **view** key (read-only: it can see incoming payments but cannot spend); signed transactions to broadcast |
| `explorer.beldex.io`, `testnet.beldex.dev` | Beldex Name Service (BNS) lookup | The name the user typed |
| `api.coingecko.com` | BDX price | Nothing user-specific |

## Permissions

- `storage`: stores the encrypted wallet, and holds the unlocked session in `storage.session`.
- `alarms`: auto-lock and a 30-second balance sync.
- `notifications`: tells the user about incoming payments.
- **Content scripts on `https://` pages:** provide `window.beldex` so dapps can ask to connect. They only
  pass messages between the page and the background. They do not read or change page content. Every
  connection, send and signature needs the user's approval for that site.
