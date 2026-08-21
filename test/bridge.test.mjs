// Coverage for the bridge's MV3-CSP-safe embind marshalling. Upstream
// @bdxi/beldex-app-bridge 3.0.1 replaced embind's `new Function`-based argument
// marshalling (banned by the MV3 CSP) with eval-free runtime marshalling
// (formerly carried here as a patch-package patch — see HANDOFF.md). The
// dependency is exact-pinned; these tests exercise every bridge call
// the extension uses and run under Node's --disallow-code-generation-from-strings
// flag (see npm script) — the same restriction the browser CSP enforces — so a
// CSP regression in any future bridge bump fails here.
//
//   node --disallow-code-generation-from-strings --test test/bridge.test.mjs

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const MAINNET = 0

let bridge
let wallet

before(async () => {
  const load = require('@bdxi/beldex-app-bridge')
  bridge = await load({})
  wallet = bridge.newly_created_wallet('en-US', MAINNET)
})

test('newly_created_wallet returns a 25-word seed and bx… address', () => {
  assert.equal(wallet.mnemonic_string.trim().split(/\s+/).length, 25)
  assert.match(wallet.address_string, /^bx/)
  assert.match(wallet.sec_viewKey_string, /^[0-9a-f]{64}$/)
  assert.match(wallet.sec_spendKey_string, /^[0-9a-f]{64}$/)
})

test('seed_and_keys_from_mnemonic round-trips the same address', () => {
  const r = bridge.seed_and_keys_from_mnemonic(wallet.mnemonic_string, MAINNET)
  assert.equal(r.address_string, wallet.address_string)
  assert.equal(r.sec_spendKey_string, wallet.sec_spendKey_string)
})

test('decode_address returns matching view/spend keys', () => {
  const d = bridge.decode_address(wallet.address_string, MAINNET)
  assert.equal(d.view, wallet.pub_viewKey_string)
  assert.equal(d.spend, wallet.pub_spendKey_string)
  assert.equal(d.isSubaddress, false)
})

test('generate_key_image is valid hex and deterministic', () => {
  const other = bridge.newly_created_wallet('en-US', MAINNET)
  const args = [other.pub_viewKey_string, wallet.sec_viewKey_string, wallet.pub_spendKey_string, wallet.sec_spendKey_string, 0]
  const ki1 = bridge.generate_key_image(...args)
  const ki2 = bridge.generate_key_image(...args)
  assert.match(ki1, /^[0-9a-f]{64}$/)
  assert.equal(ki1, ki2)
})

test('new_payment_id + integrated address', () => {
  const pid = bridge.new_payment_id()
  assert.match(pid, /^[0-9a-f]{16}$/)
  const addr = bridge.new__int_addr_from_addr_and_short_pid(wallet.address_string, pid, MAINNET)
  assert.equal(typeof addr, 'string')
  assert.ok(addr.length > wallet.address_string.length)
})

test('async__send_funds drives the send flow through the marshalled callbacks', async () => {
  // We abort at the first server callback; reaching it proves the whole
  // form-submission bridge (the most complex marshalling path) works.
  const reached = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('send flow never reached get_unspent_outs')), 10_000)
    bridge.async__send_funds({
      fromWallet_didFailToInitialize: false, fromWallet_didFailToBoot: false, fromWallet_needsImport: false,
      requireAuthentication: false, isRegister: false, registration_string: undefined,
      hasPickedAContact: false, resolvedAddress_fieldIsVisible: false,
      manuallyEnteredPaymentID_fieldIsVisible: false, resolvedPaymentID_fieldIsVisible: false,
      destinations: [{ to_address: wallet.address_string, send_amount: '1.5' }],
      is_sweeping: false,
      from_address_string: wallet.address_string,
      sec_viewKey_string: wallet.sec_viewKey_string,
      sec_spendKey_string: wallet.sec_spendKey_string,
      pub_spendKey_string: wallet.pub_spendKey_string,
      priority: 1, nettype: MAINNET,
      get_unspent_outs_fn: (req, cb) => {
        clearTimeout(timer)
        assert.ok('address' in req && 'view_key' in req)
        cb('aborting test') // stop the flow here
        resolve(true)
      },
      get_random_outs_fn: (_r, cb) => cb('x'),
      submit_raw_tx_fn: (_r, cb) => cb('x'),
      status_update_fn: () => {},
      willBeginSending_fn: () => {},
      canceled_fn: () => {},
      authenticate_fn: cb => cb(true),
      error_fn: () => {}, // expected after we abort
      success_fn: () => {}
    })
  })
  assert.equal(reached, true)
})
