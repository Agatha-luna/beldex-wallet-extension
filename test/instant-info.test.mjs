// What the wallet screen shows the instant it opens, before refresh() has
// verified fresh figures. The background's sync cache is the server's raw
// view, whose total_sent counts decoy appearances; showing it produced a
// negative balance on a small chain, and after a wallet switch it showed the
// previous wallet's balance. Only this wallet's corrected snapshot qualifies.
//
//   node --experimental-strip-types --test test/instant-info.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { instantInfo } from '../src/lib/instantInfo.ts'

const ME = '9vXRByNVCSDVYUz-this-wallet'
const OTHER = 'A2J6sspFManPw13-another-wallet'
const BDX = 1_000_000_000n

const corrected = {
  address: ME,
  total_received: String(99_899n * BDX),
  total_sent: String(49_999n * BDX), // after key-image correction
  total_sent_raw: String(109_999n * BDX), // what the server claimed
  locked_funds: String(10_000n * BDX),
  scanned_block_height: 4700
}
// The raw server reply: decoys inflate total_sent past total_received.
const rawCache = {
  address: ME,
  info: {
    total_received: String(99_899n * BDX),
    total_sent: String(109_999n * BDX),
    locked_funds: String(10_000n * BDX),
    scanned_block_height: 4742,
    blockchain_height: 4742
  }
}
const balanceOf = i => BigInt(i.total_received) - BigInt(i.total_sent)

test('no corrected snapshot yet: nothing instant, the skeleton stays', () => {
  assert.equal(instantInfo(ME, rawCache, undefined), null)
})

test('amounts come from the corrected snapshot, never the raw cache', () => {
  assert.ok(balanceOf(rawCache.info) < 0n, 'the raw cache alone would show a negative balance')
  const i = instantInfo(ME, rawCache, corrected)
  assert.equal(balanceOf(i), 49_900n * BDX)
  assert.equal(i.locked_funds, corrected.locked_funds)
})

test('heights come from this wallet\'s cache, which decoys do not affect', () => {
  const i = instantInfo(ME, rawCache, corrected)
  assert.equal(i.scanned_block_height, 4742)
  assert.equal(i.blockchain_height, 4742)
})

test('a snapshot left by another wallet is not shown under this one', () => {
  assert.equal(instantInfo(ME, rawCache, { ...corrected, address: OTHER }), null)
})

test('a cache left by another wallet contributes nothing, not even heights', () => {
  const i = instantInfo(ME, { ...rawCache, address: OTHER, info: { ...rawCache.info, scanned_block_height: 99, blockchain_height: 99 } }, corrected)
  assert.equal(balanceOf(i), 49_900n * BDX)
  assert.equal(i.scanned_block_height, 4700)
  assert.equal(i.blockchain_height, 4700)
})

test('works without a sync cache (Firefox < 115 has no storage.session)', () => {
  const i = instantInfo(ME, undefined, corrected)
  assert.equal(balanceOf(i), 49_900n * BDX)
  assert.equal(i.blockchain_height, 4700)
})
