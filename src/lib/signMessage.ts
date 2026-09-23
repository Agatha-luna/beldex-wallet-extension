// Wallet-standard message signing, in JS.
//
// The WASM core (@bdxi/beldex-app-bridge v3.0.0) contains generate_signature but
// does not embind-export it, so the only way to offer bdx_signMessage without an
// upstream core release is to do the group arithmetic here. That is done with
// @noble/curves + @noble/hashes — audited implementations — rather than by
// hand-rolling field or hash primitives.
//
// The construction is exactly wallet2::sign() / crypto::generate_signature():
//
//   h    = keccak256(message)                      (cn_fast_hash)
//   k    = random scalar
//   comm = k·G
//   c    = keccak256(h ‖ A ‖ comm) mod ℓ           (hash_to_scalar)
//   r    = k − c·a  mod ℓ                          (sc_mulsub)
//   out  = "SigV1" + monero_base58(c ‖ r)
//
// Verified by `crypto::check_signature(h, A, sig)`, which is what the CLI's
// `verify_value <address> <signature> <value>` and the explorer both run.
//
// NOTE: SigV1, not SigV2. Beldex's wallet2 uses the SigV1 magic and hashes the
// message directly; a SigV2-style scheme would not verify in beldex-wallet-cli.

import { ed25519 } from '@noble/curves/ed25519'
import { keccak_256 } from '@noble/hashes/sha3'

const L = ed25519.CURVE.n // group order ℓ
const SIG_MAGIC = 'SigV1'

// -------------------------------------------------------------- conversions

function bytesToNumberLE(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!)
  return n
}

function numberToBytesLE(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const s = hex.trim()
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error('invalid hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// ------------------------------------------------------------------ base58
// Monero's block-based base58 (8-byte blocks -> 11 chars), NOT the Bitcoin one.

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11]

export function base58Encode(data: Uint8Array): string {
  let out = ''
  for (let i = 0; i < data.length; i += 8) {
    const block = data.subarray(i, i + 8)
    const size = ENCODED_BLOCK_SIZES[block.length]!
    let value = 0n
    for (const byte of block) value = (value << 8n) | BigInt(byte) // big-endian
    const chars = new Array<string>(size).fill('1')
    for (let pos = size - 1; value > 0n; pos--) {
      chars[pos] = B58_ALPHABET[Number(value % 58n)]!
      value /= 58n
    }
    out += chars.join('')
  }
  return out
}

export function base58Decode(text: string): Uint8Array {
  if (!text) return new Uint8Array()
  const out: number[] = []
  for (let i = 0; i < text.length; i += 11) {
    const chunk = text.slice(i, i + 11)
    const size = chunk.length === 11 ? 8 : ENCODED_BLOCK_SIZES.indexOf(chunk.length)
    if (size <= 0) throw new Error('invalid base58 length')
    let value = 0n
    for (const ch of chunk) {
      const digit = B58_ALPHABET.indexOf(ch)
      if (digit < 0) throw new Error('invalid base58 character')
      value = value * 58n + BigInt(digit)
    }
    if (value >= 1n << BigInt(8 * size)) throw new Error('base58 block overflow')
    const block = new Uint8Array(size)
    for (let j = size - 1; j >= 0; j--) { block[j] = Number(value & 0xffn); value >>= 8n }
    out.push(...block)
  }
  return new Uint8Array(out)
}

// ------------------------------------------------------------------ scalars

function hashToScalar(data: Uint8Array): bigint {
  return bytesToNumberLE(keccak_256(data)) % L
}

/** Uniform random scalar in [1, ℓ). 64 random bytes reduced mod ℓ — the bias
 *  from a 512-bit reduction is negligible (< 2^-250). */
function randomScalar(): bigint {
  const wide = new Uint8Array(64)
  crypto.getRandomValues(wide)
  const k = bytesToNumberLE(wide) % L
  return k === 0n ? randomScalar() : k
}

// ---------------------------------------------------------------- signing

export interface SignedMessage {
  /** "SigV1…" — what the CLI's verify_value expects. */
  signature: string
  /** The key the signature verifies against (account spend public key). */
  pubkey: string
}

/**
 * Sign `message` with a Monero-convention Schnorr signature.
 *
 * @param message     UTF-8 message (the explorer's ownership challenge)
 * @param secSpendKey account spend SECRET key, hex (from the unlocked session)
 * @param pubSpendKey account spend PUBLIC key, hex — the asset `owner` value
 */
export function signMessage(message: string, secSpendKey: string, pubSpendKey: string): SignedMessage {
  const a = bytesToNumberLE(hexToBytes(secSpendKey))
  const A = hexToBytes(pubSpendKey)
  if (A.length !== 32) throw new Error('bad spend public key')
  if (a <= 0n || a >= L) throw new Error('bad spend secret key')

  // The pair must actually belong together, or we would hand out a signature
  // that can never verify (and leak nothing about why).
  const derived = ed25519.ExtendedPoint.BASE.multiply(a).toRawBytes()
  if (bytesToHex(derived) !== bytesToHex(A)) {
    throw new Error('spend key pair mismatch')
  }

  const h = keccak_256(new TextEncoder().encode(message))

  for (let attempt = 0; attempt < 8; attempt++) {
    const k = randomScalar()
    const comm = ed25519.ExtendedPoint.BASE.multiply(k).toRawBytes()
    const c = hashToScalar(concat(h, A, comm))
    if (c === 0n) continue
    const r = (((k - c * a) % L) + L) % L
    if (r === 0n) continue

    const sig = concat(numberToBytesLE(c), numberToBytesLE(r))
    // Self-check before it leaves the wallet: cheap, and turns any future
    // regression into a local error instead of a signature the chain's own
    // tooling rejects.
    if (!checkSignature(h, A, sig)) throw new Error('self-check failed')
    return { signature: SIG_MAGIC + base58Encode(sig), pubkey: bytesToHex(A) }
  }
  throw new Error('could not produce a signature')
}

// ------------------------------------------------------------- verification

/** crypto::check_signature(). prefixHash/pub 32 bytes, sig 64 bytes (c ‖ r). */
export function checkSignature(prefixHash: Uint8Array, pub: Uint8Array, sig: Uint8Array): boolean {
  if (prefixHash.length !== 32 || pub.length !== 32 || sig.length !== 64) return false
  let A
  try {
    A = ed25519.ExtendedPoint.fromHex(pub) // rejects off-curve / non-canonical encodings
  } catch {
    return false // not a curve point
  }
  // WEAK-KEY REJECTION (external audit). An ownership proof must establish
  // knowledge of a secret spend scalar. For the identity point A=O, the verify
  // equation c·A + r·G reduces to r·G, so an attacker picks r, derives the
  // challenge, and forges an accepted proof with no secret. Any point carrying
  // a torsion (small-order) component similarly weakens the required
  // discrete-log assumption. Require A to be the identity's opposite: a
  // non-identity point in the prime-order subgroup (torsion-free). A genuine
  // wallet key a·G (a∈[1,ℓ)) always satisfies this, so honest verification is
  // unaffected. The signer's zero-scalar checks cannot protect a *public*
  // verifier handed an attacker-chosen key, so the gate must live here.
  if (A.equals(ed25519.ExtendedPoint.ZERO)) return false // identity
  if (!A.isTorsionFree()) return false                   // small-order / mixed-order component

  const c = bytesToNumberLE(sig.subarray(0, 32))
  const r = bytesToNumberLE(sig.subarray(32))
  if (c >= L || r >= L || c === 0n) return false // sc_check + sc_isnonzero

  // comm = c·A + r·G
  const comm = A.multiplyUnsafe(c).add(ed25519.ExtendedPoint.BASE.multiplyUnsafe(r))
  const commBytes = comm.toRawBytes()
  // ge_tobytes() of the identity is 0x01 followed by zeros.
  if (commBytes[0] === 1 && commBytes.every((b, i) => i === 0 || b === 0)) return false

  return hashToScalar(concat(prefixHash, pub, commBytes)) === c
}

/** Verify a "SigV1…" signature over `message` against a spend public key. */
export function verifyMessage(message: string, pubSpendKey: string, signature: string): boolean {
  // Defense in depth (external audit): bound work before Keccak/base58 even if
  // a caller bypasses the dapp-bridge boundary schema. A real SigV1 is ~100
  // chars and challenges are short; these caps are generous.
  if (typeof message !== 'string' || message.length > 65_536) return false
  if (typeof signature !== 'string' || signature.length > 4096) return false
  const sig = signature.trim()
  if (!sig.startsWith(SIG_MAGIC)) return false
  let raw: Uint8Array
  let pub: Uint8Array
  try {
    raw = base58Decode(sig.slice(SIG_MAGIC.length))
    pub = hexToBytes(pubSpendKey)
  } catch {
    return false
  }
  return checkSignature(keccak_256(new TextEncoder().encode(message)), pub, raw)
}

// --------------------------------------------------------------- addresses
// Address -> spend public key, so bdx_verifyMessage can take an address like
// the CLI's `verify_value` does. Done here rather than through the WASM's
// decode_address because verification must work in the service worker, where
// the Emscripten glue cannot load.

export function addressSpendKey(address: string): string | null {
  // Bound base58 work before decoding (external audit). Real addresses are
  // ~95-110 chars; anything far beyond that is not an address.
  if (typeof address !== 'string' || address.length > 512) return null
  let raw: Uint8Array
  try {
    raw = base58Decode(address.trim())
  } catch {
    return null
  }
  if (raw.length < 69) return null
  // [varint prefix][spend 32][view 32][payment id 8 if integrated][checksum 4]
  let i = 0
  for (; i < raw.length; i++) if ((raw[i]! & 0x80) === 0) { i++; break }
  const body = raw.subarray(0, raw.length - 4)
  const checksum = raw.subarray(raw.length - 4)
  const expected = keccak_256(body).subarray(0, 4)
  for (let j = 0; j < 4; j++) if (checksum[j] !== expected[j]) return null
  const spend = raw.subarray(i, i + 32)
  return spend.length === 32 ? bytesToHex(spend) : null
}

// ------------------------------------------------- addresses across networks
// The inverse of addressSpendKey: build an address for an arbitrary nettype.
//
// A Beldex account IS a keypair; the address is only that keypair wearing a
// network-specific prefix. Seed -> spend/view derivation does not involve the
// nettype at all, so the same account exists on every chain and switching
// networks is a re-ENCODING of keys the wallet already holds — never a
// re-derivation. That is what lets the network switch happen without the seed,
// without the password, and without a re-unlock. (test/address.test.mjs pins
// all of this against the WASM core.)
//
// This lives here, next to the decoder, for the same reason the decoder does:
// it must work where the Emscripten glue cannot load. The background owns the
// session and therefore performs the switch, and it is a service worker — the
// WASM's address_and_keys_from_seed is doubly unavailable to it, needing both
// the glue and the SEED that the session deliberately strips.
//
//   address = base58( varint(prefix) ‖ pubSpend[32] ‖ pubView[32] ‖ keccak256(…)[0..4] )

/**
 * CRYPTONOTE_PUBLIC_ADDRESS_BASE58_PREFIX per nettype, as the core defines it
 * (0 = mainnet, 1 = testnet, 2 = devnet). Consensus constants, so they live in
 * code rather than in networks.json with the endpoints — an operator may
 * repoint an LWS URL, never an address prefix.
 */
export const ADDRESS_PREFIX: Readonly<Record<number, number>> = { 0: 209, 1: 53, 2: 24 }

/** LEB128, as used for the address prefix. */
function varint(n: number): Uint8Array {
  const out: number[] = []
  let v = n
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v > 0) byte |= 0x80
    out.push(byte)
  } while (v > 0)
  return new Uint8Array(out)
}

/**
 * Encode a standard (non-integrated, non-subaddress) address for `nettype`
 * from the account's PUBLIC keys.
 *
 * Throws on malformed keys or an unknown nettype rather than returning a
 * plausible-looking wrong address — a wrong address here is silently
 * unspendable funds, so this must fail loudly.
 */
export function addressForNettype(pubSpendKey: string, pubViewKey: string, nettype: number): string {
  const prefix = ADDRESS_PREFIX[nettype]
  if (prefix === undefined) throw new Error(`unknown nettype ${nettype}`)

  const spend = hexToBytes(pubSpendKey)
  const view = hexToBytes(pubViewKey)
  if (spend.length !== 32) throw new Error('bad spend public key')
  if (view.length !== 32) throw new Error('bad view public key')

  const p = varint(prefix)
  const body = new Uint8Array(p.length + 64)
  body.set(p, 0)
  body.set(spend, p.length)
  body.set(view, p.length + 32)

  const full = new Uint8Array(body.length + 4)
  full.set(body, 0)
  full.set(keccak_256(body).subarray(0, 4), body.length)

  return base58Encode(full)
}
