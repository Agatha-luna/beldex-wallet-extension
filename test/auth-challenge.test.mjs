// Coverage for bdx_signAuthChallenge param validation + statement construction
// (src/background/dapp.ts). The wallet composes the signed statement itself so
// the sign-in proof is audience-bound by the wallet, not by page text.
//
// validateAuthChallengeParams + buildAuthChallenge (and their constants) are a
// self-contained block; we slice it, transpile with the repo's typescript, and
// import via a data: URL — same single-source pattern as dapp-protocol.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/background/dapp.ts'), 'utf8')

const start = src.indexOf("const AUTH_PREFIX = 'beldex-auth-v1'")
const end = src.indexOf('/** Derive the wallet-controlled fields')
assert.ok(start !== -1 && end > start, 'auth-challenge block markers drifted in dapp.ts')
const block = src.slice(start, end)

const ts = await import('typescript').then(m => m.default ?? m)
const js = ts.transpileModule(block, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText
const { validateAuthChallengeParams, buildAuthChallenge } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

// ---- param validation -------------------------------------------------------

test('accepts a valid nonce with defaults', () => {
  const r = validateAuthChallengeParams({ nonce: 'abc123._-XYZ' })
  assert.equal(r.ok, true)
  assert.equal(r.value.nonce, 'abc123._-XYZ')
  assert.equal(r.value.expiresInMs, 300_000)
  assert.equal(r.value.requestId, undefined)
})

test('accepts optional requestId and expiresInMs', () => {
  const r = validateAuthChallengeParams({ nonce: 'noncenonce', requestId: 'req-1', expiresInMs: 60_000 })
  assert.equal(r.ok, true)
  assert.equal(r.value.requestId, 'req-1')
  assert.equal(r.value.expiresInMs, 60_000)
})

test('rejects bad nonce charset / length', () => {
  for (const nonce of [undefined, '', 'short', 'a'.repeat(129), 'has space', 'has/slash', 'emoji😀nonce']) {
    assert.equal(validateAuthChallengeParams({ nonce }).ok, false, JSON.stringify(nonce))
  }
})

test('rejects bad requestId', () => {
  for (const requestId of ['', 'a'.repeat(65), 'bad id', 'bad/id']) {
    assert.equal(validateAuthChallengeParams({ nonce: 'noncenonce', requestId }).ok, false, JSON.stringify(requestId))
  }
})

test('rejects bad expiresInMs (non-int, out of range)', () => {
  for (const expiresInMs of [59_999, 3_600_001, 1.5, '300000', -1, NaN]) {
    assert.equal(validateAuthChallengeParams({ nonce: 'noncenonce', expiresInMs }).ok, false, String(expiresInMs))
  }
  // Boundaries are inclusive.
  assert.equal(validateAuthChallengeParams({ nonce: 'noncenonce', expiresInMs: 60_000 }).ok, true)
  assert.equal(validateAuthChallengeParams({ nonce: 'noncenonce', expiresInMs: 3_600_000 }).ok, true)
})

test('rejects unexpected / injection fields', () => {
  for (const extra of [{ domain: 'evil.com' }, { address: 'bxEVIL' }, { network: 'mainnet' }, { iat: 0 }, { foo: 1 }]) {
    assert.equal(validateAuthChallengeParams({ nonce: 'noncenonce', ...extra }).ok, false, JSON.stringify(extra))
  }
})

// ---- statement construction (must byte-match the SDK) -----------------------

const F = {
  domain: 'https://shop.example', uri: 'https://shop.example/login',
  address: 'bx' + 'a'.repeat(95), network: 'mainnet',
  nonce: 'server-nonce-123', iat: 1786950846000, exp: 1786951146000
}

test('buildAuthChallenge is byte-exact without rid', () => {
  assert.equal(
    buildAuthChallenge(F),
    `beldex-auth-v1 domain=${F.domain} uri=${F.uri} address=${F.address}`
    + ` network=${F.network} nonce=${F.nonce} iat=${F.iat} exp=${F.exp}`
  )
})

test('buildAuthChallenge appends rid only when requestId present', () => {
  assert.equal(buildAuthChallenge({ ...F, requestId: 'r-9' }).endsWith(' rid=r-9'), true)
  assert.equal(buildAuthChallenge(F).includes(' rid='), false)
})

test('field order is fixed', () => {
  const s = buildAuthChallenge({ ...F, requestId: 'r-9' })
  const keys = [...s.matchAll(/(?:^| )([a-z]+)=/g)].map(m => m[1])
  assert.deepEqual(keys, ['domain', 'uri', 'address', 'network', 'nonce', 'iat', 'exp', 'rid'])
})
