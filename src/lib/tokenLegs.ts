// Token legs of a get_address_txs entry, corrected for decoys.
//
// The server counts one of our token outputs as sent whenever it appears in a
// ring — including as a decoy in someone else's transfer, which showed up as
// "−499,000 TG" for a balance that never moved. Only the owner's key images
// tell a real spend from a decoy, so the correction happens here.

// No imports: the node test suite loads this file directly. Leg amounts are
// atomic-unit integer strings; anything else reads as zero, like parseAtomic.
function atomic(v: string | undefined): bigint {
  try { return BigInt(v || '0') } catch { return 0n }
}

export interface SpentCandidate {
  amount: string
  key_image: string
  tx_pub_key: string
  out_index: number
}

/** A token leg as get_address_txs reports it. `spent_outputs` is absent on
 *  servers that predate it. */
export interface TokenLegWire {
  token_id: string
  received: string
  sent: string
  spent_outputs?: SpentCandidate[]
}

/**
 * Corrects each leg's `sent` in place. With `spent_outputs` the decoys are
 * dropped exactly (`falseSpend` sums the candidates whose key image is not
 * ours), as for BDX. Without them (older server) only one thing is certain:
 * every transaction this wallet makes pays its fee from its own BDX outputs,
 * so a transaction with no real BDX spend (`realBdxSent`, already key-image
 * corrected) cannot have spent our tokens either.
 */
export async function correctLegs(
  legs: TokenLegWire[] | undefined,
  realBdxSent: bigint,
  falseSpend: (candidates: SpentCandidate[]) => Promise<bigint>
): Promise<void> {
  for (const leg of legs ?? []) {
    const claimed = atomic(leg.sent)
    if (claimed === 0n) continue
    if (leg.spent_outputs) {
      const real = claimed - await falseSpend(leg.spent_outputs)
      leg.sent = String(real > 0n ? real : 0n)
    } else if (realBdxSent === 0n) {
      leg.sent = '0'
    }
  }
}
