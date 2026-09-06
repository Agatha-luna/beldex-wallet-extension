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
