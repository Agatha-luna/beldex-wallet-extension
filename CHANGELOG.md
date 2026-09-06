# Changelog

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
