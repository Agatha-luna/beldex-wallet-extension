// Coverage for validateSignParams (src/background/dapp.ts).
//
// A bdx_signMessage message is rendered verbatim in the approval card; the
// user must visually read EXACTLY the bytes they sign. ASCII control chars
// were always rejected; the audit found that Unicode bidi controls and
// invisible characters slipped through, letting a malicious dapp craft a
// message whose rendered text differs from its logical content (e.g. RLO
// reordering). These tests pin the extended rejection set.
//
// dapp.ts imports chrome-backed modules, so we extract just the
// dependency-free validation block (MAX_SIGN_MESSAGE + DISALLOWED_SIGN_CHARS +
// validateSignParams), transpile it with the repo's own typescript, and import
// it via a data: URL — same single-source-of-truth pattern as
// dapp-protocol.test.mjs.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/background/dapp.ts'), 'utf8')

const start = src.indexOf('const MAX_SIGN_MESSAGE')
const end = src.indexOf('// One in-flight send')
assert.ok(start !== -1 && end > start, 'validation block markers drifted in dapp.ts')
const block = 'export ' + src.slice(start, end)

const ts = await import('typescript').then(m => m.default ?? m)
const js = ts.transpileModule(block, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText
const { validateSignParams } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

test('accepts ordinary messages, including non-ASCII text', () => {
  for (const m of [
    'hello world',
    'beldex-asset-owner|v1|56e4bae7df73d7ce|1786950846|b0249c5b',
    'prix: 12,50 € — café ☕',
    'русский текст',
    '日本語のメッセージ',
    'مرحبا بالعالم',           // RTL text itself is fine — only CONTROLS are banned
    'a'.repeat(512)
  ]) {
    const r = validateSignParams({ message: m })
    assert.equal(r.ok, true, JSON.stringify(m))
    assert.equal(r.message, m)
  }
})

test('rejects non-strings, empty and oversized messages', () => {
  for (const p of [undefined, null, {}, { message: 42 }, { message: '' }, { message: 'a'.repeat(513) }]) {
    assert.equal(validateSignParams(p).ok, false, JSON.stringify(p))
  }
})

test('rejects ASCII control characters (pre-audit behavior preserved)', () => {
  for (const m of ['line1\nline2', 'tab\there', 'esc\x1b[2Jwipe', 'nul\x00', 'del\x7f']) {
    assert.equal(validateSignParams({ message: m }).ok, false, JSON.stringify(m))
  }
})

test('rejects bidi direction controls', () => {
  const bidi = [
    '‪', '‫', '‬', '‭', '‮', // LRE RLE PDF LRO RLO
    '⁦', '⁧', '⁨', '⁩',           // LRI RLI FSI PDI
    '‎', '‏'                                // LRM RLM
  ]
  for (const c of bidi) {
    assert.equal(validateSignParams({ message: `pay 1 BDX ${c}to attacker` }).ok, false,
      'U+' + c.codePointAt(0).toString(16))
  }
  // The classic RLO spoof: rendered text reads reversed.
  assert.equal(validateSignParams({ message: 'transfer to ‮rekcatta' }).ok, false)
})

test('rejects invisible characters', () => {
  const invisible = [
    '­',                               // soft hyphen
    '​', '‌', '‍',           // ZWSP ZWNJ ZWJ
    ' ', ' ',                     // line / paragraph separator
    '⁠', '⁡', '⁢', '⁣', '⁤', // word joiner + invisible operators
    '﻿'                                // ZWNBSP / BOM
  ]
  for (const c of invisible) {
    assert.equal(validateSignParams({ message: `visible${c}hidden` }).ok, false,
      'U+' + c.codePointAt(0).toString(16))
  }
})

test('rejects the broader default-ignorable / format classes (audit follow-up)', () => {
  const cps = [
    0x061c,          // ARABIC LETTER MARK (bidi, was omitted)
    0x034f,          // COMBINING GRAPHEME JOINER (was omitted)
    0x206a, 0x206f,  // deprecated formatting controls (was omitted)
    0x115f, 0x1160, 0x3164, 0xffa0, // Hangul fillers
    0x17b4, 0x17b5,  // Khmer inherent vowels
    0x180e, 0x180b, 0x180f, // Mongolian MVS / FVS
    0xfe00, 0xfe0f,  // variation selectors (incl. VS16, was omitted)
    0xe0100, 0xe01ef, // variation selectors supplement (astral)
    0xe0001, 0xe007f, // language tag + cancel tag (astral)
    0x1d173,          // musical begin-beam format control (astral)
    0x1bca0,          // shorthand format control (astral)
    0x0080, 0x009f,   // C1 controls (was omitted)
    0xfdd0, 0xfffe, 0x1fffe, 0x10ffff, // noncharacters (BMP + astral planes)
  ]
  for (const cp of cps) {
    const c = String.fromCodePoint(cp)
    assert.equal(validateSignParams({ message: `visible${c}hidden` }).ok, false,
      'must reject U+' + cp.toString(16).toUpperCase())
  }
})

test('rejects the reserved beldex-auth-v1 prefix (no forged auth statements)', () => {
  // Audience-bound sign-in statements exist ONLY as wallet-composed
  // bdx_signAuthChallenge output. A page calling bdx_signMessage directly
  // (bypassing the SDK, which has the same client-side check) must not be
  // able to get one signed — including with leading whitespace.
  for (const m of [
    'beldex-auth-v1 domain=https://evil.example uri=https://evil.example/ address=bx1 network=mainnet nonce=aaaaaaaa iat=1 exp=2',
    'beldex-auth-v1',
    '  beldex-auth-v1 anything'
  ]) {
    const r = validateSignParams({ message: m })
    assert.equal(r.ok, false, JSON.stringify(m))
    assert.match(r.error, /reserved/)
  }
  // A tab-prefixed attempt is also rejected — by the earlier control-char
  // gate (tabs are C0), before the prefix check even runs.
  assert.equal(validateSignParams({ message: '\tbeldex-auth-v1 x' }).ok, false)
  // Prefix must anchor at the start: mentioning it inside text stays legal.
  assert.equal(validateSignParams({ message: 'the beldex-auth-v1 format is neat' }).ok, true)
})

test('still accepts emoji WITHOUT a variation selector and combining marks', () => {
  // Base emoji (no VS16) and legitimate combining diacritics remain allowed;
  // only the invisible/ignorable selectors and controls are rejected.
  for (const m of ['coffee ☕', 'café', 'àḅc']) {
    assert.equal(validateSignParams({ message: m }).ok, true, JSON.stringify(m))
  }
})
