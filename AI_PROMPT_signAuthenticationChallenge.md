# AI prompt — implement `bdx_signAuthChallenge` (wallet-injected origin)

Copy everything below the line into the AI session working on `beldex-wallet-extension`.

---

Implement a new dapp method **`bdx_signAuthChallenge`** in this Beldex Wallet extension. It closes an audit finding against the companion SDK (`bdx-web3js`): dapp sign-in proofs must be **audience-bound by the wallet**, not by page-supplied text.

## Background

The extension already implements `bdx_signMessage` (approval-gated, SigV1 `wallet2::sign` scheme via `src/lib/signMessage.ts`, max 512 chars, control characters rejected) and `bdx_verifyMessage`. Key files: `src/background/dapp.ts` (method dispatch, `validateSignParams`, grant/session checks, `queueApproval`), `src/popup/views/SignApprovalCard.tsx` (approval UI + signing, settles via `DAPP_SIGN_COMPLETE`), `src/lib/messages.ts` (message union), `src/lib/dappProtocol.ts` (method/param types).

The SDK's `connectWithProof()` currently signs a single-line statement the **page** composes:

```
beldex-auth-v1 domain=<origin> uri=<origin+path> address=<addr> network=<net> nonce=<n> iat=<ms> exp=<ms>[ rid=<id>]
```

Residual risk: a malicious page can pass raw `bdx_signMessage` text naming a *different* domain and hope the user approves. Fix: a dedicated method where the **wallet composes the statement itself**, inserting the origin it observed from the content-script sender — the page only supplies the server challenge.

## Specification

**Method:** `bdx_signAuthChallenge` — approval-gated, same grant/lock/pending-approval preconditions as `bdx_signMessage` in the `dapp.ts` switch.

**Params (from the page):**
```ts
{
  nonce: string        // required, /^[A-Za-z0-9._-]{8,128}$/  (server-issued)
  requestId?: string   // optional, /^[A-Za-z0-9._-]{1,64}$/
  expiresInMs?: number // optional integer, 60_000..3_600_000, default 300_000
}
```
Reject anything else with `-32602` (add a `validateAuthChallengeParams` next to `validateSignParams`).

**Wallet-derived fields (never from params):**
- `domain` — the origin already recorded for this dapp connection (the same trusted origin used for grant checks; NOT any string from `req.params`).
- `uri` — `domain` + pathname of the requesting tab's URL (from the content-script sender); fall back to `domain` + `/` if unavailable.
- `address` — active wallet's primary address; `network` — current nettype; `iat` — `Date.now()`; `exp` — `iat + expiresInMs`.

**Statement construction** — must byte-match the SDK's `buildAuthChallenge()`; space-separated, single line, `rid` only when `requestId` present:
```
beldex-auth-v1 domain=<d> uri=<u> address=<a> network=<n> nonce=<x> iat=<ms> exp=<ms>[ rid=<id>]
```
Enforce: no whitespace/control chars in any field value, total ≤ 512 chars (`-32602` otherwise).

**Approval UI:** a dedicated "Sign-in request" card (variant of `SignApprovalCard`), showing the requesting origin prominently plus the parsed fields (domain, expiry, nonce, requestId) AND the exact full statement text (scrollable). Sign with the existing SigV1 path used by `SignApprovalCard`; settle through the existing `DAPP_SIGN_COMPLETE`-style flow (extend `src/lib/messages.ts` with the message variant, e.g. `DAPP_AUTH_SIGN_COMPLETE`, result `{ message, signature, address }`).

**Result to the page:**
```ts
{ message: string; signature: string; address: string }  // message = exact signed bytes
```

**Errors:** `4001` reject · `4100` origin not connected · `4900` locked · `-32602` invalid params · `-32603` internal (sanitized) — mirror the existing `bdx_signMessage` case. Apply the same one-pending-approval-per-origin rule and TTL. Do NOT change `bdx_signMessage` behavior.

**Types/protocol:** add the method to `DappMethod` in `src/lib/dappProtocol.ts` and to the injected provider's allowed methods if there is an allowlist in `content.ts`/inpage script.

**Tests:** unit tests for param validation (bad nonce charset/length, bad expiresInMs, extra fields), statement construction (byte-exact against fixture strings, rid optionality, 512 cap), and dispatch preconditions (no grant → 4100, locked → 4900, second concurrent approval → -32603). Follow the existing test patterns in the repo.

**Manifest/version:** bump the extension minor version and changelog: this is an additive dapp-API change.

## Acceptance criteria

1. A connected dapp calling `bdx_signAuthChallenge` with a valid nonce gets `{ message, signature, address }` after user approval, where `message` contains the *wallet-observed* origin — regardless of anything else the page sent.
2. The signature verifies via the existing `verifyMessage` path against the returned message and address.
3. Params cannot influence domain/uri/address/network/iat/exp except through `expiresInMs` within its clamp.
4. `bdx_signMessage` unchanged; all existing tests still pass.
