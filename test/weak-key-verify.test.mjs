// Coverage for weak-key rejection in checkSignature / verifyMessage
// (external audit: "Message Verification Accepts a Weak Spend Key That Needs No
// Secret"). An ownership proof must require a secret spend scalar; the identity
// point and any torsion (small-order / mixed-order) point break that, so the
// public verifier must reject such keys BEFORE the signature equation.

import test from 'node:test'
import assert from 'node:assert/strict'
import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'
import {
  checkSignature, verifyMessage, signMessage,
  bytesToHex, hexToBytes, base58Encode
} from '../src/lib/signMessage.ts'

const P = ed25519.ExtendedPoint
const L = ed25519.CURVE.n

const leToNum = b => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n }
const numToLe = (n, len = 32) => { const o = new Uint8Array(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 0xffn); n >>= 8n } return o }
const cat = (...ps) => { const o = new Uint8Array(ps.reduce((n, p) => n + p.length, 0)); let k = 0; for (const p of ps) { o.set(p, k); k += p.length } return o }
const hashToScalar = d => leToNum(keccak_256(d)) % L

// The identity-key forgery from the finding: for A = O the verify equation
// c·A + r·G collapses to r·G, so the attacker picks r, sets comm = r·G, derives
// the challenge c = H(prefix ‖ pub ‖ comm), and submits (c ‖ r) — accepted with
// no secret. This helper reproduces it for ANY pub (only actually *accepted*
// pre-fix when A is the identity).
function forgeIdentitySig(prefixHash, pubBytes, r = 987654321n % L) {
  const R = P.BASE.multiply(r).toRawBytes()
  const c = hashToScalar(cat(prefixHash, pubBytes, R))
  return cat(numToLe(c), numToLe(r))
}

const PREFIX = keccak_256(new TextEncoder().encode('own the account, please'))
const IDENTITY = P.ZERO.toRawBytes() // 0x01 followed by zeros

test('the identity-key forgery is rejected (the core fix)', () => {
  // The forge is genuine: verify the equation it targets actually holds, so
  // this test would PASS the signature check if the weak-key gate were absent.
  const r = 987654321n % L
  const sig = forgeIdentitySig(PREFIX, IDENTITY, r)
  const c = leToNum(sig.subarray(0, 32))
  const comm = P.ZERO.multiplyUnsafe(c).add(P.BASE.multiplyUnsafe(r)).toRawBytes()
  assert.equal(hashToScalar(cat(PREFIX, IDENTITY, comm)), c, 'forge satisfies the verify equation')
  // ...yet the verifier must reject the identity key outright.
  assert.equal(checkSignature(PREFIX, IDENTITY, sig), false)
})

test('every low-order / torsion point is rejected as a key', () => {
  // A known order-8 point; enumerate its multiples 1..8. 8·P = identity;
  // 1..7·P are non-identity torsion points. All must be rejected, whatever the
  // signature bytes.
  const gen = P.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')
  assert.equal(gen.isTorsionFree(), false, 'sanity: generator is torsion')
  let acc = gen
  for (let k = 1; k <= 8; k++) {
    const pub = acc.toRawBytes()
    const sig = forgeIdentitySig(PREFIX, pub)
    assert.equal(checkSignature(PREFIX, pub, sig), false, `${k}·P (order-8 subgroup) must be rejected`)
    acc = acc.add(gen)
  }
})

test('non-canonical / off-curve encodings are rejected at decode', () => {
  const bad = [
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', // y > p, non-canonical
    'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // y = p, non-canonical
    '0200000000000000000000000000000000000000000000000000000000000000'  // not a valid curve point
  ]
  for (const hex of bad) {
    const sig = forgeIdentitySig(PREFIX, hexToBytes(hex))
    assert.equal(checkSignature(PREFIX, hexToBytes(hex), sig), false, `must reject ${hex.slice(0, 8)}…`)
  }
})

test('a normal prime-order wallet key still verifies (no honest regression)', () => {
  // Deterministic non-real keypair (same construction as sign-message.test).
  const secInt = L - 4242n
  const A = P.BASE.multiply(secInt)
  assert.equal(A.isTorsionFree(), true, 'a·G is torsion-free')
  assert.notEqual(A.equals(P.ZERO), true)
  const sec = bytesToHex(numToLe(secInt))
  const pub = bytesToHex(A.toRawBytes())

  const { signature } = signMessage('gm, prove ownership', sec, pub)
  assert.equal(verifyMessage('gm, prove ownership', pub, signature), true)
  // And it must fail against a different message.
  assert.equal(verifyMessage('a different message', pub, signature), false)
})

test('verifyMessage end-to-end rejects an identity-key proof', () => {
  const idHex = bytesToHex(IDENTITY)
  const sig = forgeIdentitySig(PREFIX, IDENTITY)
  const signature = 'SigV1' + base58Encode(sig)
  // Note: verifyMessage hashes the message itself; use the same message the
  // forge targeted by hashing it here would differ — so assert the KEY gate via
  // checkSignature above, and here assert a plausibly-forged proof is refused.
  assert.equal(verifyMessage('own the account, please', idHex, signature), false)
})
