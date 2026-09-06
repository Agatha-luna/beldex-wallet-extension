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
const { parseDappRequest } = mod

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
