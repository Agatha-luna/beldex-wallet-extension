// HF22 privacy tokens: LWS calls. Endpoint shapes are the extended LWS API
// (get_token_balances / get_token_info / get_token_list / get_unspent_outs
// with all_tokens) documented in docs/12-extension-frontend-handoff.md §4.
//
// A server without these endpoints may 404, 501, or simply drop the
// connection — indistinguishable from each other, and all meaning the same
// thing: no chain answer. Every call here throws a tagged TokenLookupError in
// that case so callers can degrade to cached data marked unverified, instead
// of a blank screen or a claim the chain never made.

import { CONFIG } from './config'
import type { Credentials } from './lws'

export interface TokenLookupError extends Error {
  tokenLookupUnsupported: true
}

function unsupportedError(message = 'This server does not support token lookups'): TokenLookupError {
  const e = new Error(message) as TokenLookupError
  e.name = 'TokenLookupUnsupported'
  e.tokenLookupUnsupported = true
  return e
}

export function isTokenLookupUnsupported(e: unknown): e is TokenLookupError {
  return !!e && typeof e === 'object' && (e as TokenLookupError).tokenLookupUnsupported === true
}

async function post(endpoint: string, body: unknown): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${CONFIG.LWS_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (e: any) {
    throw unsupportedError(e?.message || 'Could not reach the server')
  }
  if (res.status === 404 || res.status === 501) throw unsupportedError()
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    const serverMessage = data && typeof data === 'object' ? data.Error || data.error : undefined
    // 400 with a message is the server answering properly (bad/unknown token
    // id) — must not be reported as an unsupported server.
    if (res.status === 400 && serverMessage) throw new Error(String(serverMessage))
    throw unsupportedError(serverMessage ? String(serverMessage) : `Server returned ${res.status}`)
  }
  return res.json()
}

export type TokenStatus = 'confirmed' | 'not_found' | 'unknown'

export interface TokenBalanceEntry {
  token_id: string
  status: TokenStatus
  total_received: string
  total_sent: string
  locked_funds: string
  unlocked_balance: string
  // Descriptor fields — only meaningful when status === 'confirmed'.
  ticker?: string
  full_name?: string
  owner?: string
  meta_info?: string
  current_supply?: string
  total_max_supply?: string
  decimal_point?: number
}

export interface TokenBalancesReply {
  tokens: TokenBalanceEntry[]
  scanned_height: number
  blockchain_height: number
}

/**
 * Everything the token screen needs, in one request. `tokenIds` asks about
 * tokens the account does not (yet) hold — how a just-broadcast registration
 * becomes visible before it's mined. Pass the ids cached locally; [] if none.
 */
export function getTokenBalances(c: Credentials, tokenIds: string[]): Promise<TokenBalancesReply> {
  return post('/get_token_balances', { address: c.address, view_key: c.view_key, token_ids: tokenIds })
}

export interface TokenDescriptor {
  token_id: string
  ticker: string
  full_name: string
  owner: string
  meta_info: string
  current_supply: string
  total_max_supply: string
  decimal_point: number
}

/** Public chain data — no credentials. */
export function getTokenInfo(tokenId: string): Promise<TokenDescriptor> {
  return post('/get_token_info', { token_id: tokenId })
}

export function getTokenList(offset: number, count: number): Promise<{ token_ids: string[]; total_count: number }> {
  return post('/get_token_list', { offset, count })
}

export interface TokenOutputCandidate {
  token_id: string
  amount: string
  tx_pub_key: string
  index: number
  spend_key_images: string[]
}

/**
 * Every token output the account has ever received, unfiltered — paired with
 * verifiedTokenBalances() in spent.ts. The server is view-only and cannot
 * tell a decoy from a real spend on its own: when one of our outputs is
 * sampled as a ring member in someone else's transaction, it records a spend
 * that never happened. Only the owner can tell the difference, by deriving
 * the key image (see spent.ts).
 */
export async function fetchAllTokenOutputs(c: Credentials): Promise<TokenOutputCandidate[]> {
  const p = await post('/get_unspent_outs', {
    address: c.address,
    view_key: c.view_key,
    amount: '0',
    use_dust: true,
    dust_threshold: '0',
    mixin: 9,
    all_tokens: true
  })
  const outs = Array.isArray(p.outputs) ? p.outputs : []
  return outs
    .filter((o: any) => o.token_id)
    .map((o: any) => ({
      token_id: String(o.token_id),
      amount: String(o.amount ?? '0'),
      tx_pub_key: String(o.tx_pub_key ?? ''),
      index: Number(o.index ?? 0),
      spend_key_images: Array.isArray(o.spend_key_images) ? o.spend_key_images.map((k: any) => String(k)) : []
    }))
}
