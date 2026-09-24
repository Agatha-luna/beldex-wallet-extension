// Master node registration: the arguments handed to the WASM send flow.
//
// The registration string is produced by `prepare_registration` on the
// operator's beldexd and carries the stake, the operator cut, the contributor
// addresses and the expiry. The core reads all of that out of the string, so
// the wallet must pass it through untouched and must NOT try to describe the
// spend itself.
//
// The WASM's send-funds parser recognises exactly two registration keys —
// `isRegisterStr` and `registration_string` (verified by string extraction from
// the binary). These tests pin that sendFunds() populates them correctly and,
// just as importantly, that an ORDINARY send is unchanged: a stray
// registration field on a normal transfer would be a consensus-level mistake.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSendArgs } from '../src/lib/sendArgs.ts'

const MAINNET = 0

const SECRETS = {
  address: 'bxTEST', pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
  pubViewKey: 'c'.repeat(64), secViewKey: 'd'.repeat(64), mnemonic: '', seed: ''
}
const REG = 'register_master_node 18446744073709551612 bxOPERATOR 50 bxCONTRIB 50 1893456000 abcdef'

describe('master node registration arguments', () => {
  test('a registration passes the string through and flags isRegister', () => {
    const args = buildSendArgs({
      secrets: SECRETS, toAddress: '', amount: '', priority: 1,
      isRegister: true, registrationString: REG
    }, MAINNET)
    assert.equal(args.isRegister, true)
    assert.equal(args.registration_string, REG, 'the string must reach the core byte-for-byte')
  })

  test('a registration describes no destination of its own', () => {
    const args = buildSendArgs({
      secrets: SECRETS, toAddress: '', amount: '', priority: 1,
      isRegister: true, registrationString: REG
    }, MAINNET)
    // The stake and the contributors come from the registration string. Naming
    // a recipient or an amount here would be the wallet inventing a spend the
    // operator never authorised.
    assert.equal(args.destinations.length, 1)
    assert.equal(args.destinations[0].to_address, '')
    assert.equal(args.destinations[0].send_amount, '')
  })

  test('a registration carries no token fields', () => {
    const args = buildSendArgs({
      secrets: SECRETS, toAddress: '', amount: '', priority: 1,
      isRegister: true, registrationString: REG
    }, MAINNET)
    assert.equal(args.token_id, undefined)
    assert.equal(args.is_deploy_token, undefined)
    assert.equal(args.token_descriptor, undefined)
  })

  test('an ordinary BDX send is byte-for-byte unaffected', () => {
    const args = buildSendArgs({
      secrets: SECRETS, toAddress: 'bxRECIPIENT', amount: '1.25', priority: 5
    }, MAINNET)
    // The whole point of the defaults: adding this feature must not alter a
    // transaction that has nothing to do with it.
    assert.equal(args.isRegister, false)
    assert.equal(args.registration_string, undefined)
    assert.deepEqual(
      { to: args.destinations[0].to_address, amt: args.destinations[0].send_amount },
      { to: 'bxRECIPIENT', amt: '1.25' }
    )
    assert.equal(args.priority, 5)
  })

  test('a token send still carries its token fields and no registration', () => {
    const args = buildSendArgs({
      secrets: SECRETS, toAddress: 'bxRECIPIENT', amount: '10', priority: 1,
      tokenId: 'f'.repeat(64), tokenDecimalPoint: 8
    }, MAINNET)
    assert.equal(args.isRegister, false)
    assert.equal(args.registration_string, undefined)
    assert.equal(args.token_id, 'f'.repeat(64))
    assert.equal(args.token_decimal_point, '8')
  })
})
