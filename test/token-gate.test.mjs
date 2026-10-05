// Token registration is offered on testnet only, and opens only once the server
// reports the chain on the token fork. Before that a "not live yet" notice shows.
//
//   node --experimental-strip-types --test test/token-gate.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tokenGate } from '../src/lib/tokenGate.ts'

const networks = JSON.parse(readFileSync(new URL('../src/lib/networks.json', import.meta.url), 'utf8'))
const base = { enabled: true, needVersion: 22, forkHeight: 4_242_200 }

test('mainnet does not offer token registration; testnet does, with its fork height', () => {
  assert.equal(networks.mainnet.tokenRegistration, false)
  assert.equal(networks.testnet.tokenRegistration, true)
  assert.equal(networks.testnet.tokenForkHeight, 4_242_200)
})

test('a network without registration never opens the form', () => {
  assert.equal(tokenGate({ ...base, enabled: false, forkVersion: 22, height: 5_000_000 }).kind, 'disabled')
})

test('before the fork: not live, with the blocks still to go', () => {
  const g = tokenGate({ ...base, forkVersion: 20, height: 4_227_300 })
  assert.equal(g.kind, 'not-live')
  assert.equal(g.blocksLeft, 14_900)
  assert.equal(g.forkHeight, 4_242_200)
})

test('on the fork: the form opens', () => {
  assert.equal(tokenGate({ ...base, forkVersion: 22, height: 4_242_200 }).kind, 'open')
  assert.equal(tokenGate({ ...base, forkVersion: 23, height: null }).kind, 'open')
})

test('past the fork height but the server reports an older fork: server not upgraded', () => {
  // An LWS that predates privacy tokens always reports fork 17.
  assert.equal(tokenGate({ ...base, forkVersion: 17, height: 4_250_000 }).kind, 'server-behind')
})

test('fork unreadable: never opens the form', () => {
  assert.equal(tokenGate({ ...base, forkVersion: null, height: 4_250_000 }).kind, 'unknown')
})
