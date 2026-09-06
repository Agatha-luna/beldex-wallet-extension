// BNS name resolution for the send flow.
//
// Uses the Beldex explorer's public lookup API, which returns decrypted mapping
// values for a plaintext name:
//   GET https://explorer.beldex.io/api/bnslookup?name=<name>
//   -> { status: "ok", bnsData: { available, name, wallet, bchat, belnet, ethAddress } }
// `available: true` means the name is unregistered; a registered name carries
// its wallet address in `bnsData.wallet`.
//
// THREAT MODEL:
// - Privacy: the queried name is visible to the explorer (standard for light
//   wallets that don't run a full node).
// - Integrity: we fully trust the explorer to return the correct address for a
//   name. A compromised or malicious endpoint could return an attacker's
//   address. This is NOT independently verified client-side (doing so would
//   require fetching the on-chain encrypted record and decrypting it with the
//   name-derived key). The mitigation is UX: the send review modal shows the
//   full resolved address before the user confirms, so a substitution is
//   visible to anyone who checks the address. Self-hosting BNS_LOOKUP_URL
//   removes the third-party trust.

import { CONFIG } from './config'
import { fetchJson, HTTP } from './http'

// starts alphanumeric, alphanumeric/hyphen/underscore inside, optional .bdx suffix
const NAME_RE = /^[a-z0-9](?:[a-z0-9-_]*[a-z0-9])?(\.bdx)?$/

/** Heuristic: could this input be a BNS name (as opposed to a raw address)? */
export function looksLikeBnsName(input: string): boolean {
  const s = input.trim().toLowerCase()
  // Addresses are ~95-106 mixed-case base58 chars; names are short, lowercase,
  // and may carry a .bdx suffix.
  return s.length >= 1 && s.length < 64 && NAME_RE.test(s)
}

interface LookupResult { registered: boolean; wallet: string }

async function lookup(name: string): Promise<LookupResult> {
  const json = await fetchJson<any>(
    `${CONFIG.BNS_LOOKUP_URL}?name=${encodeURIComponent(name)}`, {}, HTTP.BNS
  )
  if (json?.status !== 'ok') throw new Error('lookup failed')
  return {
    registered: json?.bnsData?.available === false,
    wallet: typeof json?.bnsData?.wallet === 'string' ? json.bnsData.wallet : ''
  }
}

/**
 * Resolve a BNS name to its wallet address. Users may type the name with or
 * without the ".bdx" suffix; the registry may store either form, so both are
 * tried. Returns null when the name isn't registered at all; throws a
 * descriptive error when it's registered but carries no wallet mapping.
 */
export async function resolveBnsWallet(input: string): Promise<string | null> {
  const bare = input.trim().toLowerCase().replace(/\.bdx$/, '')
  if (!bare) return null

  let sawRegisteredWithoutWallet = false
  for (const candidate of [bare, `${bare}.bdx`]) {
    const r = await lookup(candidate)
    if (r.wallet) return r.wallet
    if (r.registered) sawRegisteredWithoutWallet = true
  }
  if (sawRegisteredWithoutWallet) {
    throw new Error(`"${bare}" is registered but has no wallet address mapped to it`)
  }
  return null
}
