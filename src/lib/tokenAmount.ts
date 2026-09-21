// Atomic-unit math for HF22 privacy tokens — same BigInt approach as money.ts,
// but parameterized by each token's own decimal_point (0-18) instead of BDX's
// fixed 9. Never mix a token amount with a BDX one, and never sum two
// different tokens: each is denominated in its own unit.

function scaleFor(decimals: number): bigint {
  return BigInt('1' + '0'.repeat(Math.max(0, decimals)))
}

/** The bridge's token amounts are C++ uint64_t under the hood (parse_token_amount /
 *  stoull) — an atomic value past this throws a native "stoull: out of range"
 *  exception instead of a helpful error. Validate against it client-side. */
export const UINT64_MAX = (1n << 64n) - 1n

/** Parse an atomic value coming from the LWS (integer string or number) to BigInt. */
export function parseTokenAtomic(v: string | number | undefined | null): bigint {
  if (v === undefined || v === null || v === '') return 0n
  const s = String(v).trim()
  const intPart = s.split('.')[0].replace(/[^\d-]/g, '')
  try {
    return BigInt(intPart || '0')
  } catch {
    return 0n
  }
}

/**
 * Convert a user-typed display amount to atomic units. Returns null when the
 * input isn't a well-formed non-negative decimal, or carries more fractional
 * digits than the token's decimal_point supports — callers surface that as a
 * validation error rather than silently truncating.
 */
export function toTokenAtomic(display: string, decimals: number): bigint | null {
  const trimmed = display.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null
  const [whole, frac = ''] = trimmed.split('.')
  if (frac.length > decimals) return null
  return BigInt(whole) * scaleFor(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** Format atomic units as a display string, trimming trailing zero fraction digits. */
export function fmtToken(atomic: bigint, decimals: number): string {
  const neg = atomic < 0n
  const a = neg ? -atomic : atomic
  if (decimals <= 0) return `${neg ? '-' : ''}${a}`
  const scale = scaleFor(decimals)
  const whole = a / scale
  const frac = (a % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

/** Thousands separators on the integer part only, fraction left readable as-is. */
export function groupDigits(value: string): string {
  const [whole, frac] = value.split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac ? `${grouped}.${frac}` : grouped
}

/** Token ids are 64 hex chars — too long for a list row; elide the middle. */
export function shortenTokenId(id: string, lead = 10, tail = 6): string {
  if (!id || id.length <= lead + tail + 1) return id || ''
  return `${id.slice(0, lead)}…${id.slice(-tail)}`
}

/** Deterministic avatar color for a token id — there's no real logo to show
 *  for an arbitrary user-registered token, so every list row gets a stable,
 *  distinct-looking circle instead of a generic placeholder for all of them. */
export function tokenColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 45%)`
}
