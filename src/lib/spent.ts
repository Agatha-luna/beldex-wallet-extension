// Client-side spend verification (key-image filtering).
//
// The LWS cannot know which outputs we actually spent — it flags an output as
// "possibly spent" whenever it appears as a ring member in ANY transaction,
// including other people's transactions that sampled it as a decoy. Deciding
// truthfully requires the private spend key, which only we hold: compute the
// key image for each candidate (tx_pub_key, out_index) and compare with the
// candidate's key_image. Match => genuinely ours. No match => decoy usage.
//
// Without this filtering the wallet shows phantom outgoing transactions and an
// understated balance. (Same approach as MyMonero's response parser.)

import { generateKeyImage } from './bridge'
import { parseAtomic } from './money'
import type { WalletSecrets } from './messages'
import type { TokenOutputCandidate } from './tokenApi'

export interface SpentCandidate {
  amount: string
  key_image: string
  tx_pub_key: string
  out_index: number
}

// Key images are deterministic per (address, txPub, outIndex) — cache for the
// panel's lifetime. Keyed by wallet address too, so switching wallets can't
// collide on the same (txPub, outIndex) tuple.
const kiCache = new Map<string, string>()

async function ourKeyImage(s: WalletSecrets, txPub: string, outIndex: number): Promise<string> {
  const k = `${s.address}:${txPub}:${outIndex}`
  let ki = kiCache.get(k)
  if (!ki) {
    ki = await generateKeyImage(txPub, s.secViewKey, s.pubSpendKey, s.secSpendKey, outIndex)
    kiCache.set(k, ki)
  }
  return ki
}

/** Sum of candidate amounts that are NOT really ours (false positives to subtract from total_sent). */
export async function falseSpendSum(s: WalletSecrets, candidates: SpentCandidate[] | undefined): Promise<bigint> {
  let fake = 0n
  for (const c of candidates ?? []) {
    try {
      const ki = await ourKeyImage(s, c.tx_pub_key, Number(c.out_index))
      if (ki !== c.key_image) fake += parseAtomic(c.amount)
    } catch {
      // can't verify this candidate — leave it counted as spent (conservative for balance)
    }
  }
  return fake
}

/** Corrects total_sent on an object bearing { total_sent, spent_outputs }. Returns corrected atomic units. */
export async function correctedTotalSent(
  s: WalletSecrets,
  obj: { total_sent?: string | number; spent_outputs?: SpentCandidate[] }
): Promise<bigint> {
  const claimed = parseAtomic(obj.total_sent)
  if (!obj.spent_outputs?.length || claimed === 0n) return claimed
  const fake = await falseSpendSum(s, obj.spent_outputs)
  const corrected = claimed - fake
  return corrected > 0n ? corrected : 0n
}

/**
 * Sum what the account can actually spend, per token, from the raw output
 * list (see tokenApi.fetchAllTokenOutputs). An output counts as ours unless
 * its own key image appears among the spends the server attached to it —
 * only the real owner can derive that key image, which is why this cannot be
 * done server-side. A failure deriving one output's key image must not
 * discard the rest: it's counted as unspent, erring towards showing a
 * balance the wallet has rather than hiding one it does.
 *
 * This is the same key-image cache used by falseSpendSum/correctedTotalSent
 * above (keyed by address:txPub:index), so a BDX refresh and a token refresh
 * never re-derive the same key image twice.
 */
export async function verifiedTokenBalances(
  s: WalletSecrets,
  outputs: TokenOutputCandidate[]
): Promise<Map<string, bigint>> {
  const totals = new Map<string, bigint>()
  for (const out of outputs) {
    let spent = false
    if (out.spend_key_images.length && out.tx_pub_key) {
      try {
        const mine = await ourKeyImage(s, out.tx_pub_key, out.index)
        spent = out.spend_key_images.includes(mine)
      } catch {
        spent = false
      }
    }
    if (spent) continue
    totals.set(out.token_id, (totals.get(out.token_id) ?? 0n) + parseAtomic(out.amount))
  }
  return totals
}
