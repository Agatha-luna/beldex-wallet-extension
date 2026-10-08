// A token output of ours that turns up as a decoy in someone else's transfer
// must not show as sent in the activity list.
//
//   node --experimental-strip-types --test test/token-legs.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { correctLegs } from '../src/lib/tokenLegs.ts'

const ours = new Set(['ki-real'])
const falseSpend = async candidates =>
  candidates.filter(c => !ours.has(c.key_image)).reduce((n, c) => n + BigInt(c.amount), 0n)
const cand = (key_image, amount) => ({ key_image, amount: String(amount), tx_pub_key: 'p', out_index: 0 })

test('decoy-only appearance in another wallet\'s transfer: nothing sent', async () => {
  const legs = [{ token_id: 't', received: '0', sent: '49900000', spent_outputs: [cand('ki-other', 49900000)] }]
  await correctLegs(legs, 0n, falseSpend)
  assert.equal(legs[0].sent, '0')
})

test('own send whose ring also sampled our other outputs: only the real input counts', async () => {
  const legs = [{ token_id: 't', received: '4900000', sent: '54900000',
    spent_outputs: [cand('ki-real', 5000000), cand('ki-a', 45000000), cand('ki-b', 4900000)] }]
  await correctLegs(legs, 1000n, falseSpend)
  assert.equal(legs[0].sent, '5000000') // net −100,000 = 1,000.00 TG sent
})

test('older server without spent_outputs: no real BDX spend means not our transfer', async () => {
  const legs = [{ token_id: 't', received: '0', sent: '1000' }]
  await correctLegs(legs, 0n, falseSpend)
  assert.equal(legs[0].sent, '0')
})

test('older server without spent_outputs: our own send (paid a BDX fee) is left as reported', async () => {
  const legs = [{ token_id: 't', received: '4900', sent: '5000' }]
  await correctLegs(legs, 1234n, falseSpend)
  assert.equal(legs[0].sent, '5000')
})

test('receive-only legs and BDX-only transactions are untouched', async () => {
  const legs = [{ token_id: 't', received: '700', sent: '0' }]
  await correctLegs(legs, 0n, falseSpend)
  assert.equal(legs[0].sent, '0')
  await correctLegs(undefined, 0n, falseSpend)
})
