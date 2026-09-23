# Changelog

## Unreleased

### Changed — network model

- **The active network is global, and selecting a wallet no longer changes it.**
  It was previously a per-wallet property, which meant picking a wallet silently
  moved the user to that wallet's chain — a real bug, and the reason the two
  controls are now fully separated.
- **Only wallets on the active network are selectable**, which is what makes
  "pick a wallet" incapable of changing the chain. A wallet records the networks
  it appears on.
- **Wallet selection lists every wallet**, including ones that live only on the
  other chain — shown greyed with "not on <network>", with a one-confirm
  "use here" that brings the wallet onto the current chain and selects it
  (`ADD_WALLET_TO_NETWORK`). Hiding them would leave no route to bring a wallet
  across. It is the same keypair either way; only the address encoding differs.
- **Settings → Network is only the chain switch** — no wallet counts, no
  per-wallet enable/disable. Where wallets live is decided in wallet selection,
  where the wallets are.
- **The active wallet is remembered per network**, so switching chains restores
  whichever wallet was last used there rather than forcing a choice.
- **Switching moved out of the header into Settings → Network.** The header now
  carries a passive network label beside the wordmark (amber on testnet, muted
  on mainnet) — always stated, never a control, so a stray tap cannot change
  chains. The Unlock screen shows it too, since Settings is unreachable while
  locked.
- **Switching is refused when the wallet you are looking at is not on the target
  chain** (`WALLET_NOT_ON_NETWORK`). The confirm step then asks whether to bring
  that wallet across; accepting adds it and *stays on it*, declining does not
  switch at all and returns you to the wallet you were already using. Moving the
  user onto some other chain's wallet unannounced is what loses their place —
  and a chain with no wallet at all is just the same rule with nothing to fall
  back to. The question appears only when it applies, keeping the common path a
  plain switch.
- The Unlock screen lists only wallets on the active chain, since bringing one
  across needs an unlocked session.

### Fixed

- **A newly created or restored wallet opened locked**, asking for the password
  that had just been set. `SAVE_WALLET` recorded the wallet in the mirror key
  only, never as the active wallet *for the current network* — so `getActiveId()`
  kept returning the previous wallet, the new session failed to match it, and
  the panel fell back to the unlock screen. It now opens straight into the new
  wallet.
- **The wallet list could render rows on top of one another.** The modal had no
  height ceiling, so a long list overflowed the overlay instead of scrolling.
  It now scrolls internally with the action row pinned beneath.
- The "use this wallet on <network>" step is a **dedicated view** rather than a
  box expanded inside the list, which used to push the surrounding rows around
  under the user's finger.

### Added

- **Runtime mainnet/testnet switching.** The chain is no longer fixed at build
  time; it is selected in Settings → Network (see the model notes above).

  A Beldex account is one keypair on every chain — the address is only that
  keypair encoded with a network-specific prefix, and seed → spend/view
  derivation never involves the nettype — so **the same account always exists on
  both networks** and switching is a re-encoding, not a re-derivation. The wallet
  therefore **stays unlocked** across a switch: no password, no re-unlock. The
  new address is computed in pure JS from the session's *public* keys
  (`addressForNettype`), which is what lets the background service worker do it
  at all — it can neither load the WASM nor see the seed, which the session
  deliberately strips.

  - Per-wallet history, tokens and pending txs namespace themselves, being
    already keyed by address; `sync_cache` / `corrected_balance` are dropped.
  - A switch is **refused while a send holds the global lock** — a transaction
    under construction has already selected outputs and a fee against one
    chain's unspent set.
  - Pending dapp approvals are **voided** (reviewed against another chain's
    address and balance); **grants survive**, and connected sites receive
    `networkChanged` + `accountsChanged`. The approval window binds itself to
    the chain recorded on the request, and refuses if it no longer matches.
  - Non-mainnet is always visibly marked: an amber label beside the wordmark in
    the header and on the Unlock screen, a warning on the send screen, and the
    chain named on every dapp approval.
  - **No password required.** Switching reveals nothing and spends nothing — it
    re-encodes an address the session already holds. It is still confirmed, and
    it is refused while a send holds the global lock, since a transaction under
    construction is bound to one chain's unspent set.
  - **A confirmation step states the consequences first**: the receiving address
    changes (anything saved elsewhere no longer applies), the new chain is only
    tracked from the moment you switch — the same light-wallet caveat the
    restore flow already gives — and whether you are moving to play money or
    real money.

- **`/login` is now sent from the background** at wallet setup and on every
  network switch (`create_account: true`), instead of relying on the panel's
  mount effect. A seed brought in from the CLI or another wallet names an
  account the LWS has never seen, and on a switch the account genuinely does not
  exist on the target chain's server yet — without registering it first, reads
  come back "account not exists" rather than an empty balance. Registration no
  longer depends on a panel being open, or staying open, after the switch.

### Changed

- **Every network's endpoints now ship in every build**, and `host_permissions`
  are derived from the union of all of them. This **replaces** the previous
  invariant that "a build can only ever reach the chain it was compiled for",
  which a user-facing switcher is incompatible with. `BDX_NETWORK` /
  `--env network=…` now choose the default chain for a *fresh wallet* and the
  testnet build branding, rather than restricting the build.
  - Consequence: the plaintext testnet daemon-RPC host appears in mainnet
    builds' `host_permissions`, and its build-time mixed-content warning now
    fires on every build. Set `TESTNET_DAEMON_RPC_URL` to an `https` endpoint to
    clear both. (It is still unused by any code path.)
- `TESTNET_SHOW_FIAT` now defaults to **false** — quoting the mainnet BDX price
  beside valueless coins was merely odd across separate builds, and misleading
  once a user can switch chains in-app.
- Importing a seed that is already present is now rejected by matching the
  account across **all** networks, not just the incoming address — otherwise the
  same wallet could be imported twice, once per chain.

### Tests

- `test/address.test.mjs` — pins the load-bearing claim against the WASM core:
  keys are byte-identical across nettypes, and `addressForNettype` reproduces
  `address_and_keys_from_seed` exactly for mainnet/testnet/devnet.
- `test/network-switch.test.mjs` — drives the whole model through the built
  background bundle: list filtering per network, wallet selection NOT changing
  the chain, per-network active wallet, empty-chain bootstrap, session survive
  vs end, session re-encoding, the password gate + backoff, send-lock refusal,
  cache invalidation, approval voiding, grant survival + events, backend
  re-pointing and /login registration.

## 1.2.0

### Added / changed

- **Send operation state machine** — a `bdx_sendTransaction` approval now
  transitions PENDING → EXECUTING atomically before any transaction is built
  (`DAPP_BEGIN_SEND`): the review timeout is cancelled and an unguessable
  execution token is minted, so an approved send can no longer be terminated by
  an approval timeout or lost channel while it broadcasts. The broadcast outcome
  is persisted (as an operation record) before the reply, so it survives a dead
  channel or service-worker restart.
- **`bdx_getOperationStatus`** — a new read method letting the origin that
  created a send query its outcome (`executing` / `confirmed` / `failed` /
  `unknown`) instead of blindly retrying after a client timeout.
- **Idempotency** — `bdx_sendTransaction` accepts an optional `idempotencyKey`;
  a retry with the same key replays the recorded outcome (or refuses while one
  is in progress) instead of creating a second approved payment.
- A still-pending send / sign / sign-in approval is now cancelled when its
  page's message channel disconnects (connect approvals stay, being recoverable
  via the persisted grant).
- **Per-method payload bounding at the extension boundary** — every dApp method
  now has a parameter schema enforced in the content script (before forwarding
  over the port) and re-enforced authoritatively in the background. Only
  recognized fields are copied into a fresh object, with per-field type and
  length caps; unknown/extra fields, prototype-pollution keys, params on
  no-parameter methods, oversized strings, and unknown methods are rejected
  before any structured-clone, base58, or Keccak work. `verifyMessage` /
  `addressSpendKey` also gained defensive length caps.
- **Sign-message filter now covers all default-ignorable Unicode** — the
  `bdx_signMessage` / `bdx_signAuthChallenge` visual-integrity denylist was
  extended from a hand-picked set to whole Unicode classes: the full
  Default_Ignorable_Code_Point set (incl. U+061C, U+034F, U+206A–206F,
  variation selectors like U+FE0F and their astral supplement, tags), C1
  controls, noncharacters, and lone surrogates — so a dApp can't get a
  signature over byte-distinct text that renders identically.
- **Auto-lock honors real inactivity** — approval surfaces now keep the MV3
  worker warm with a `KEEPALIVE` heartbeat that does NOT re-arm auto-lock; only
  genuine pointer/keyboard/focus activity sends `TOUCH`. A pending, unattended
  dApp approval can no longer hold an unlocked session past its configured
  inactivity timeout. Settings text updated to state the policy.
- **Message-verification weak-key rejection** — `checkSignature` (behind
  `bdx_verifyMessage`) now rejects the Ed25519 identity point and any
  torsion/small-order spend key before the signature equation. Such keys let an
  attacker construct an accepted ownership proof with no secret; a genuine
  prime-order wallet key is unaffected.
- **Bounded backend calls + polling single-flight** — all LWS/BNS/price fetches
  go through a shared wrapper (`src/lib/http.ts`) with an AbortController
  deadline and a response-size budget (Content-Length check + bounded streaming
  read), so a slow-drip/hanging/oversized backend can't keep a call alive or
  accumulate memory. The dashboard 10s poll and the background 30s sync each
  refuse to start while one is already in flight. A raw-tx submit gets a long
  deadline (aborting a broadcast early manufactures ambiguity); a submit-phase
  timeout is treated as an UNKNOWN outcome (operation left executing, no
  auto-retry) per the send state machine, not a definite failure.
- **Serialized security-critical state updates** — the send lock, pending-approval
  admission, and grant-map updates now run under in-worker mutexes so two
  interleaved message handlers can't both pass a check-then-write. The send lock
  carries an owner token (a stale holder's release can't delete a newer lock),
  and grant edits are per-mutation read-modify-writes so a concurrent
  revoke/approve can't lose an update or resurrect a removed origin.

## 1.1.0

### Added

- **`bdx_signAuthChallenge` dapp method** — a dedicated, approval-gated sign-in
  proof where the **wallet composes the statement**, inserting the origin it
  observed from the content-script sender. The page supplies only the
  server-issued `nonce` (and optional `requestId` / `expiresInMs`); it cannot
  influence `domain`, `uri`, `address`, `network`, `iat`, or `exp`. This
  audience-binds the proof by the wallet, closing a bdx-web3js finding where a
  malicious page could ask `bdx_signMessage` to sign a statement naming a
  different domain. Returns `{ message, signature, address }` where `message`
  is the exact signed bytes, verifiable via `bdx_verifyMessage`. A dedicated
  "Sign-in Request" approval card shows the origin, the parsed fields, and the
  full statement. `bdx_signMessage` behavior is unchanged.
