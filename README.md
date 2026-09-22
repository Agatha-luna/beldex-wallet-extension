# Beldex Wallet Extension

A non-custodial Manifest V3 browser-extension light wallet for Beldex (BDX). It runs as a
**side panel** (Chrome/Edge/Brave) or **sidebar** (Firefox), with an optional full-screen tab
mode, and exposes a `window.beldex` provider so Beldex dapps can connect with per-site approval.

It is built on the same WASM crypto core (`BeldexLibAppCpp_WASM`, from
[`beldex-core-cpp`](https://github.com/Beldex-Coin/beldex-core-cpp)) used by
[`beldex-lws-frontend`](https://github.com/Beldex-Coin/beldex-lws-frontend), consumed via the
`@bdxi/beldex-app-bridge` npm package.

## Architecture

```
panel.html (side panel / sidebar / ?tab=1)      background (SW / event page)
┌──────────────────────────────────────┐        ┌──────────────────────────────┐
│ React UI            src/popup/       │  msgs  │ src/background/index.ts      │
│ WASM bridge — ONLY here              │◄──────►│ Encrypted vaults             │
│   src/lib/bridge.ts, send.ts,        │        │   PBKDF2-600k + AES-256-GCM  │
│   spent.ts                           │        │   chrome.storage.local       │
│ LWS client          src/lib/lws.ts   │        │ Session in storage.session   │
│ BNS lookup          src/lib/bns.ts   │        │ Alarms: auto-lock, 30s sync  │
└──────────────┬───────────────────────┘        │ Brute-force backoff          │
               │ view key only                  │ Dapp router src/background/  │
               ▼                                │   dapp.ts (origin grants)    │
     Beldex LWS  ──►  beldexd                   └──────────────┬───────────────┘
     (scans chain with view key)                               │ port
                                                               ▼
                                          content.js (isolated) ◄─► inpage.js (MAIN world)
                                                               window.beldex on the page
```

Key invariants:

- **The WASM runs only in the panel.** The Emscripten glue targets window contexts and MV3
  service workers are ephemeral, so all key handling and transaction signing happens there.
  The background never loads WASM.
- **Secrets at rest** are AES-256-GCM under PBKDF2-600k; decrypted secrets live only in
  `chrome.storage.session` (memory-backed, never disk) while unlocked.
- **Multi-wallet:** each wallet has its own independently-encrypted vault and password.
  Switching wallets locks the session; legacy single-vault storage migrates automatically.
- **The dapp layer holds no secrets.** `inpage.js` runs in hostile territory (the page can see
  it), so the provider is frozen and every trust decision lives in the background router.
- **All atomic math is BigInt** (`src/lib/money.ts`); floats are used only for fiat display.
- The glue resolves the wasm at `/assets/BeldexLibAppCpp_WASM.wasm`; webpack copies it out of
  `node_modules` into the build dir so it loads from the extension origin (satisfies MV3's
  no-remote-code rule; CSP includes `wasm-unsafe-eval`).

### The embind CSP fix (important)

MV3's CSP forbids `new Function` — `unsafe-eval` is never grantable, only `wasm-unsafe-eval`.
Emscripten's embind used to assemble invokers with `new Function` (`createNamedFunction` /
`craftInvokerFunction`); **`@bdxi/beldex-app-bridge` 3.0.1 ships the eval-free equivalents**
(what `-sDYNAMIC_EXECUTION=0` emits), so the wallet no longer carries a `patch-package` patch —
the dependency is **exact-pinned to 3.0.1** (no caret) so new glue *and* a new unaudited WASM
binary can't install silently. `test/bridge.test.mjs` runs under
`node --disallow-code-generation-from-strings` — the same restriction the browser CSP enforces —
and exercises every bridge call the extension uses, so a CSP regression in any future bump fails
CI.

**If `@bdxi/beldex-app-bridge` is ever bumped:** review the new glue diff, verify the WASM binary
hash (recorded in the handoff notes), update the exact pin, and re-run the tests. The long-term
fix is for `beldex-core-cpp` to ship `-sDYNAMIC_EXECUTION=0` builds with a reproducible recipe.

## Setup

```bash
npm install                    # exact-pinned deps (no postinstall patch step)
npm run build                  # mainnet, both browsers
npm run build:chrome           # -> dist/
npm run build:firefox          # -> firefox/
npm run build:testnet          # testnet, both browsers
npm run build:chrome:testnet   # -> dist-testnet/
npm run build:firefox:testnet  # -> firefox-testnet/
npm run typecheck
npm test                       # CSP-strict bridge + dapp protocol/conformance tests
npx web-ext lint --source-dir=firefox --self-hosted
```

- **Chrome/Edge/Brave:** `chrome://extensions` → enable Developer mode → **Load unpacked** → select `dist/` (or `dist-testnet/`).
- **Firefox:** `about:debugging` → This Firefox → **Load Temporary Add-on** → select `firefox/manifest.json` (or `firefox-testnet/manifest.json`).

Both targets share identical `panel.js` / `background.js` / `content.js` / `inpage.js`; only the
manifest differs (Chrome `side_panel` vs Firefox `sidebar_action` + a `gecko` id). Platform
divergence for panel open/close is isolated in `src/lib/platform.ts`.

### Network selection and `.env`

The chain is a **runtime choice**, selected in **Settings → Network**. Every network's endpoints
ship in every build. `BDX_NETWORK` / `--env network=…` now set which chain a *fresh* wallet starts
on (and the testnet build branding) — not what the build can reach.

The active network is **global**, and changing it is the *only* thing that changes it: picking a
wallet never does. Each wallet records the networks it appears on, and only wallets on the active
chain are **selectable** — which is what makes wallet selection incapable of moving you between
chains. The active wallet is remembered per network, so switching chains restores whichever wallet
you last used there.

Wallet selection lists **every** wallet, including ones that live only on the other chain: those
are shown greyed with "not on <network>", and tapping one offers to use it here in a single
confirm. Hiding them would leave no route to bring a wallet across. It is the same keypair either
way — only the address encoding differs.

Switching chains is refused outright when the wallet you are currently using is not on the target
chain. The confirm step asks whether to bring it across: accepting adds it and keeps you on it,
declining cancels the switch and returns you to your wallet. The alternative — silently landing
you on whatever wallet that chain happened to have — is how a network switch loses your place.

> **This replaced an earlier invariant.** The chain used to be fixed at compile time so that a
> build could only ever reach the chain it was compiled for. A user-facing switcher is
> incompatible with that, so it is gone. What guards the user instead is that non-mainnet is
> always *visibly* marked — an amber label beside the wordmark in the header and on the Unlock
> screen, a warning on the send screen, and the chain named on every dapp approval — and that the
> chain is stated at all times rather than inferred.

#### How switching works

A Beldex account is **one keypair on every chain**; the address is only that keypair encoded with
a network-specific prefix, and seed → spend/view derivation never involves the nettype. So the
same account always exists on both networks and a switch is a *re-encoding*, not a re-derivation:

- the wallet **stays unlocked** when the same wallet is on both chains — nothing new is
  decrypted and there is no re-unlock. It necessarily locks when the target chain's active wallet
  is a *different* wallet, whose password the session does not hold;
- the switch needs **no password** — it reveals nothing and spends nothing, only re-encoding an
  address the session already holds. It is still confirmed, and that step states the
  consequences: the receiving address changes, the new chain is only tracked from now on, and
  whether you are moving to play money or real money;
- the account is **registered with the target chain's LWS from the background** (`/login`,
  `create_account: true`) on switch and at wallet setup, so it exists on that server
  regardless of whether a panel is open — without it the first reads come back
  "account not exists" rather than an empty balance;
- the address is recomputed in pure JS from the session's **public** keys
  (`addressForNettype` in `src/lib/signMessage.ts`), so it works in the background service
  worker, which can neither load the WASM nor see the seed (the session strips it);
- per-wallet history, tokens and pending txs namespace themselves for free, because they are
  already keyed by address — and the address differs per chain;
- chain-specific caches (`sync_cache`, `corrected_balance`) are dropped on switch;
- a switch is **refused while a send holds the global lock** — a transaction under construction
  has already picked outputs and a fee against one chain's unspent set;
- pending dapp approvals are **voided** (they were reviewed against another chain's address and
  balance), while **grants survive**: connected sites keep their connection and receive
  `networkChanged` + `accountsChanged`.

`test/address.test.mjs` pins the keypair/address claims against the WASM core itself, and
`test/network-switch.test.mjs` drives the whole state machine through the built background.

```bash
cp .env.example .env       # .env is gitignored; the template is committed
```

Config resolves in this order, each layer overriding the one before:

1. `src/lib/networks.json` — the checked-in defaults for each network.
2. `.env` — local overrides (`BDX_NETWORK`, `TESTNET_LWS_URL`, `MAINNET_PRICE_URL`, …).
   `process.env` beats `.env`, so CI can override without writing a file.
3. `--env network=…` on the webpack CLI — what the `:testnet` npm scripts pass.

`webpack.config.js` resolves **every** network, hands them to `DefinePlugin` as `__BDX_NETS__`
(plus `__BDX_DEFAULT_NET__`, read by `src/lib/config.ts`), and **derives** the manifest's
`host_permissions` from the union of all of their URLs. So pointing `TESTNET_LWS_URL` at a local
server in `.env` automatically grants permission to reach it, and switching chains can never land
on a host the manifest didn't grant — endpoints and permissions can't drift apart, which is the
usual cause of "the fetch fails and nothing says why". Ports are stripped from the derived
patterns, since Chrome rejects a manifest whose host permissions contain one.

Testnet builds additionally get a distinct extension name (`Beldex Wallet (Testnet)`) and Firefox
add-on id — so a testnet-default and mainnet-default build can be installed side by side with
separate storage.

| | mainnet | testnet |
|---|---|---|
| `NETTYPE` | 0 | 1 |
| Address prefix | 209 | 53 |
| LWS | `lwsapi.beldex.io` | `lwsapi.beldex.dev` |
| Explorer / BNS | `explorer.beldex.io` | `testnet.beldex.dev` |
| Daemon JSON-RPC | `explorer.beldex.io` | `209.126.86.93:29091` |

> **One caveat on the testnet defaults.** The daemon RPC is plaintext `http://` — extension pages
> are secure contexts, so the browser will block that fetch as mixed content (the build prints a
> warning). It is unused today, but it needs to be `https` before anything calls it. Note that
> because every build now ships every network, that warning fires on mainnet builds too, and
> `http://209.126.86.93/*` appears in their `host_permissions`. Set `TESTNET_DAEMON_RPC_URL` to an
> `https` endpoint in `.env` to clear both.
>
> `SHOW_FIAT` is now **off** for testnet by default: it quotes the *mainnet* BDX price, which was
> merely odd when testnet was a separate build and is actively misleading when a user can switch
> chains in-app. Set `TESTNET_SHOW_FIAT=true` to restore it.

## Features

| Area | Status |
|---|---|
| Create / restore wallet (25-word seed), seed-confirmation quiz | done |
| Multi-wallet, per-wallet vault + password, auto-migration | done |
| Runtime mainnet/testnet switching (Settings → Network), same account on both chains | done |
| Per-network wallet selection; bring a wallet onto the current chain in one confirm | done |
| Encrypted vault, unlock/lock, auto-lock alarm, brute-force backoff | done |
| Dashboard: balance (total/unlocked/locked), hide-balance, BDX→USDT price, sync height | done |
| Send, incl. BNS name resolution, review modal, live progress, flash priority (5) | done |
| Spent-output detection (client-side key images, filters LWS false positives) | done — `src/lib/spent.ts` |
| History: filters, local pending-tx tracking (24h TTL), details modal, explorer link | done |
| Receive: QR with logo, integrated ("unique") addresses with local labels | done |
| Settings: reveal seed/view/spend key, change password, rename, auto-lock, delete | done |
| Dapp bridge: `window.beldex` provider, per-origin grants, connect + send approval UI | done |
| Incoming-funds notifications (with optional amount hiding) | done |
| `bdx_signMessage` / `bdx_verifyMessage` | done — approval-gated signing (`SignApprovalCard`), keyless public verify |
| `bdx_signAuthChallenge` | done — wallet-composed sign-in proof (origin set by the wallet, not the page) |
| `bdx_sendTransaction` operation recovery | done — `bdx_getOperationStatus` + optional `idempotencyKey` |
| Subaddresses | **not supported by design** — the LWS cannot scan them (see below) |
| Per-tx fee in history | not available — LWS doesn't return it; could be cached at send time |

### Dapp bridge

Implements the `bdx-web3js` wire protocol (`PROTOCOL.md` v1). Discovery uses an EIP-6963-style
`beldex:requestProvider` / `beldex:announceProvider` handshake. The full method set is the source
of truth in `src/lib/dappProtocol.ts` (`DAPP_METHODS`), and `test/dapp-protocol.test.mjs` pins it:

- **Open (no grant), rate-limited:** `bdx_getState`, `bdx_getNetwork`, `bdx_resolveBns`,
  `bdx_verifyMessage`.
- **Grant required:** `bdx_getAddress`, `bdx_getBalance`, `bdx_getOperationStatus`.
- **Grant + user approval:** `bdx_connect`, `bdx_sendTransaction`, `bdx_signMessage`,
  `bdx_signAuthChallenge` — rendered in-panel when the panel is open, otherwise in a
  MetaMask-style popup anchored top-right.

Sends take a global single-flight lock shared with the panel's own send flow, and the approval
card shows a real WASM-computed fee estimate. Connected sites are listed (and revocable) in
Settings and in a bottom site bar.

**Deliberate deviations from the SDK's `PROTOCOL.md` (privacy/anti-phishing hardening):**

- **`walletVersion` is grant-gated.** `bdx_getNetwork` returns `nettype`, `height` and
  `protocolVersion` to any origin, but `walletVersion` only to a granted one — version
  granularity is useful for phishing-kit targeting, so ungranted pages don't get it. `bdx_getState`
  is likewise coarse pre-grant (collapses locked/unlocked to `locked`).
- **The origin is shown as ASCII/punycode, never Unicode-decoded.** Approval cards render the
  browser-reported origin verbatim so homograph lookalikes (`xn--…`) stay visible rather than
  being decoded into a convincing spoof.
- **Insecure (`http://`) origins can't connect.** Content scripts inject only into `https` (plus
  loopback for dev), and the background refuses to grant any impersonatable `http://` origin.
- **Request `id`s are correlation handles, not authentication.** The inpage provider matches
  responses to its own pending map by `id`; this de-duplicates replies, it does **not**
  authenticate the sender. The MAIN-world provider runs in the page's context and is assumed
  hostile — every trust decision (origin, grant, approval) is made in the background from
  browser-supplied `port.sender`, never from anything the page provides.
- **Send outcomes are recoverable.** An approved send transitions to an EXECUTING operation whose
  outcome is persisted before any reply; a client that times out uses `bdx_getOperationStatus` or
  an `idempotencyKey` retry rather than treating a timeout as proof of non-execution.

## Known limitations / open items

1. **LWS trust & privacy.** The server sees your view key: it can observe incoming funds but
   can never spend. `generated_locally: true` is sent even on restore, so a never-before-seen
   address may not get a full history rescan — wiring `IMPORT_WALLET_REQUEST` is a TODO.
2. **BNS integrity.** Resolution fully trusts `explorer.beldex.io`; a compromised endpoint could
   substitute an address. Mitigation is the full-address review modal (threat model in
   `src/lib/bns.ts`). Buying BNS names would require extending `beldex-core-cpp` — the WASM
   contains the code but exposes no entry point.
3. **Subaddresses** aren't supported by the MyMonero-lineage core + LWS combination; funds sent
   to one would be invisible. Integrated addresses are the deliberate substitute. Proper support
   needs LWS-side subaddress registration (à la monero-lws) first.
4. **Firefox baseline is 128** (`strict_min_version` in `manifest.firefox.json`). MAIN-world
   content scripts — how the provider is injected before page scripts run — need Firefox 128+;
   on older versions the provider would land in the isolated world and dapps wouldn't see
   `window.beldex`. (`storage.session` also needs 115+; 128 covers both.)
5. **AMO data-collection declaration** is `["none"]` — defensible (the view key goes to the
   app's own backend), but confirm against Mozilla policy before publishing.
6. **Verify before mainnet ship.** Send end-to-end on testnet after any core/bridge bump —
   CLSAG since HF15, Bulletproofs+ since HF20.

## Trust model

Light-wallet architecture (MyMonero model): the server scans the chain with your **view key**.
It can observe incoming transactions but can never spend funds — spend keys exist only inside
the panel page, encrypted at rest with your password. Dapps never receive keys of any kind;
they get an address only after you approve the origin, and every send is user-confirmed.
