// Envelope validation for the dapp bridge (src/lib/dappProtocol.ts).
// parseDappRequest is the content script's first line of defense: anything
// not exactly matching the PROTOCOL.md §1 request shape must be dropped.
//
// The module is dependency-free TypeScript, so we transpile it in-process
// (using the repo's own typescript devDependency) and import the result via a
// data: URL — no build step, single source of truth. Plus source-text drift
// guards for the constants the wire protocol pins.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/lib/dappProtocol.ts'), 'utf8')

// ---- drift guards: the constants tests below assume must exist verbatim ----

const METHODS = [
  'bdx_connect', 'bdx_disconnect', 'bdx_getAddress', 'bdx_getBalance',
  'bdx_sendTransaction', 'bdx_getOperationStatus', 'bdx_signMessage',
  'bdx_signAuthChallenge', 'bdx_verifyMessage',
  'bdx_resolveBns', 'bdx_getNetwork', 'bdx_getState'
]

test('dappProtocol.ts declares the exact protocol v1 method set', () => {
  for (const m of METHODS) assert.ok(src.includes(`'${m}'`), `missing method ${m}`)
  assert.ok(src.includes("REQUEST_TARGET = 'beldex-contentscript'"))
  assert.ok(src.includes("RESPONSE_TARGET = 'beldex-inpage'"))
  assert.ok(src.includes('PROTOCOL_VERSION = 1'))
})

// Bidirectional drift guard (external audit — docs/types must not diverge from
// code): the DAPP_METHODS array actually declared in source must EXACTLY equal
// the list this test (and the README table) pin. Adding or removing a wire
// method without updating both fails CI here.
test('DAPP_METHODS in source matches the pinned set exactly', () => {
  const block = src.match(/DAPP_METHODS\s*=\s*\[([\s\S]*?)\]/)
  assert.ok(block, 'could not locate DAPP_METHODS in dappProtocol.ts')
  const declared = [...block[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  assert.deepEqual([...declared].sort(), [...METHODS].sort(),
    'DAPP_METHODS drifted from the pinned method set — update the README table and this test')
})

test('dappProtocol.ts declares the exact protocol v1 error codes', () => {
  for (const pair of [
    'USER_REJECTED: 4001', 'UNAUTHORIZED: 4100', 'LOCKED: 4900',
    'NO_WALLET: 4901', 'EXPIRED: 4999', 'METHOD_NOT_FOUND: -32601',
    'INVALID_PARAMS: -32602', 'INTERNAL: -32603'
  ]) {
    assert.ok(src.includes(pair), `missing error ${pair}`)
  }
})

// ---- behavioral tests via an extracted evaluation of parseDappRequest -------
// The function is dependency-free; evaluate just it (plus the constants it
// reads) in this process. Types are stripped by transpiling with the
// TypeScript compiler API available through the extension's own devDependency.

const ts = await import('typescript').then(m => m.default ?? m)
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText
const mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { parseDappRequest, validatePortMessage } = mod
const T = 'beldex-contentscript'

test('accepts exact-shape requests', () => {
  const r = parseDappRequest({ target: 'beldex-contentscript', id: 'abc', method: 'bdx_connect' })
  assert.deepEqual(r, { id: 'abc', method: 'bdx_connect' })
  const r2 = parseDappRequest({
    target: 'beldex-contentscript', id: 'x', method: 'bdx_resolveBns', params: { name: 'shop.bdx' }
  })
  assert.deepEqual(r2, { id: 'x', method: 'bdx_resolveBns', params: { name: 'shop.bdx' } })
})

test('drops everything malformed', () => {
  const bad = [
    null, undefined, 42, 'str', [],
    {},
    { target: 'wrong', id: 'a', method: 'bdx_connect' },
    { target: 'beldex-contentscript', method: 'bdx_connect' },              // no id
    { target: 'beldex-contentscript', id: 7, method: 'bdx_connect' },       // non-string id
    { target: 'beldex-contentscript', id: '', method: 'bdx_connect' },      // empty id
    { target: 'beldex-contentscript', id: 'a'.repeat(200), method: 'bdx_connect' }, // oversized id
    { target: 'beldex-contentscript', id: 'a', method: 'evil_method' },     // unknown method
    { target: 'beldex-contentscript', id: 'a', method: 'bdx_connect', params: 'str' },
    { target: 'beldex-contentscript', id: 'a', method: 'bdx_connect', params: [1] },
    { target: 'beldex-contentscript', id: 'a', method: 'bdx_connect', params: null }
  ]
  for (const b of bad) assert.equal(parseDappRequest(b), null, JSON.stringify(b))
})

test('every protocol method is accepted', () => {
  for (const method of METHODS) {
    assert.ok(parseDappRequest({ target: 'beldex-contentscript', id: 'i', method }), method)
  }
})

// ---- per-method schema bounding (external audit) ----------------------------

test('no-parameter methods reject any non-empty params object', () => {
  for (const method of ['bdx_connect', 'bdx_getState', 'bdx_getNetwork', 'bdx_getAddress', 'bdx_getBalance', 'bdx_disconnect']) {
    // empty params object is tolerated; a populated one is rejected
    assert.ok(parseDappRequest({ target: T, id: 'a', method, params: {} }), `${method} + {}`)
    assert.equal(parseDappRequest({ target: T, id: 'a', method, params: { junk: 1 } }), null, `${method} + junk`)
  }
})

test('oversized string fields are rejected at the boundary', () => {
  const big = 'x'.repeat(100_000)
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_verifyMessage', params: { message: big, address: 'bx', signature: 'SigV1' } }), null)
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_signMessage', params: { message: 'x'.repeat(513) } }), null)
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_resolveBns', params: { name: 'x'.repeat(65) } }), null)
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_getOperationStatus', params: { operationId: 'x'.repeat(129) } }), null)
  // within caps -> accepted
  assert.ok(parseDappRequest({ target: T, id: 'a', method: 'bdx_signMessage', params: { message: 'ok' } }))
})

test('unknown fields, wrong types, and non-primitive values are rejected', () => {
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_signMessage', params: { message: 'ok', extra: 1 } }), null, 'unknown field')
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_signMessage', params: { message: 42 } }), null, 'wrong type')
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_verifyMessage', params: { message: { nested: 'deep' }, address: 'a', signature: 's' } }), null, 'nested object value')
  // recognized fields only are copied through (no leftover junk)
  const r = parseDappRequest({ target: T, id: 'a', method: 'bdx_sendTransaction', params: { to: 'bxabc', amount: '100', sweep: false } })
  assert.deepEqual(r.params, { to: 'bxabc', amount: '100', sweep: false })
})

test('prototype-pollution keys are rejected, not copied', () => {
  // JSON.parse / structured clone create an OWN "__proto__" key; it is unknown
  // to the schema and must reject the request rather than touch the prototype.
  const evil = JSON.parse('{"message":"ok","__proto__":{"polluted":true}}')
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_signMessage', params: evil }), null)
  assert.equal(({}).polluted, undefined, 'prototype must be untouched')
})

test('too many keys is rejected without deep work', () => {
  const many = {}
  for (let i = 0; i < 100; i++) many['k' + i] = 1
  assert.equal(parseDappRequest({ target: T, id: 'a', method: 'bdx_sendTransaction', params: many }), null)
})

test('validatePortMessage applies the same schema (no page target)', () => {
  // authoritative background re-validation: rejects unknown method, oversized
  // params, and junk on no-param methods — independent of the content script.
  assert.ok(validatePortMessage({ id: 'a', method: 'bdx_signMessage', params: { message: 'ok' } }))
  assert.equal(validatePortMessage({ id: 'a', method: 'evil' }), null)
  assert.equal(validatePortMessage({ id: 'a', method: 'bdx_signMessage', params: { message: 'x'.repeat(513) } }), null)
  assert.equal(validatePortMessage({ id: 'a', method: 'bdx_getState', params: { junk: 1 } }), null)
})
