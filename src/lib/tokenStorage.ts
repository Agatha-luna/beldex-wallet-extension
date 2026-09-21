// HF22 privacy tokens: local persistence, keyed by wallet address so
// switching wallets can never leak or mix in another account's tokens.
//
// Two things are tracked per wallet:
//  - `registered`: tokens THIS wallet minted. The id is the only field the
//    user cannot reconstruct — it's hashed from the descriptor plus a random
//    salt the bridge generates and does not keep, so if it's lost at the
//    moment of registration there is no way to derive it again.
//  - `knownIds`: every token id this wallet has ever held or registered,
//    independent of current balance. Passed as the `token_ids` param to
//    /get_token_balances so a token's status keeps being tracked even after
//    its balance drops to zero, or while a fresh registration awaits its
//    first block.
//
// chrome.storage.local, not localStorage: MV3 service workers have no DOM/
// localStorage, and this needs to be readable from popup code regardless of
// which context last wrote it.

export interface RegisteredToken {
  tokenId: string
  ticker: string
  fullName: string
  decimalPoint: number
  // As typed at registration time, already scaled for display — so the list
  // reads correctly before the chain has been consulted, and still reads
  // correctly on a server with no token endpoints at all.
  currentSupply: string
  totalMaxSupply: string
  txHash?: string
  registeredAt: number
}

function registeredKey(address: string): string {
  return `tokens:${address}:registered`
}

function knownIdsKey(address: string): string {
  return `tokens:${address}:knownIds`
}

export async function loadRegisteredTokens(address: string): Promise<RegisteredToken[]> {
  const key = registeredKey(address)
  const stored = (await chrome.storage.local.get(key))[key]
  return Array.isArray(stored) ? stored : []
}

/** Read-modify-write against storage directly (not app state), so a
 *  registration recorded from deep inside a bridge success callback can
 *  never be dropped because the UI hadn't loaded the list yet. */
export async function appendRegisteredToken(address: string, entry: RegisteredToken): Promise<RegisteredToken[]> {
  const existing = await loadRegisteredTokens(address)
  if (existing.some(t => t.tokenId === entry.tokenId)) return existing
  const next = [entry, ...existing]
  await chrome.storage.local.set({ [registeredKey(address)]: next })
  await rememberTokenIds(address, [entry.tokenId])
  return next
}

export async function loadKnownTokenIds(address: string): Promise<string[]> {
  const key = knownIdsKey(address)
  const stored = (await chrome.storage.local.get(key))[key]
  return Array.isArray(stored) ? stored : []
}

/** Merge new ids into the known set (e.g. every id a balances refresh just
 *  reported) and persist. Returns the full merged set. */
export async function rememberTokenIds(address: string, ids: string[]): Promise<string[]> {
  const existing = await loadKnownTokenIds(address)
  const merged = Array.from(new Set([...existing, ...ids.filter(Boolean)]))
  if (merged.length !== existing.length) {
    await chrome.storage.local.set({ [knownIdsKey(address)]: merged })
  }
  return merged
}
