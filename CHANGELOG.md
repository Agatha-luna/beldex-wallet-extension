# Changelog

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
