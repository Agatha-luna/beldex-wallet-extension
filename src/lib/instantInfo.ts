// What the wallet screen may show the moment it opens, before the Dashboard's
// refresh() has fetched and key-image-verified fresh figures.

/** The background's sync cache (storage.session `sync_cache`): the server's
 *  get_address_info reply, verbatim. */
export interface SyncCache {
  address?: string
  info?: Record<string, unknown>
}

/** The last key-image-corrected figures (storage.session `corrected_balance`),
 *  written by the Dashboard's refresh() and by SendApprovalCard. */
export interface CorrectedBalance {
  address?: string
  total_received?: string
  total_sent?: string
  locked_funds?: string
  scanned_block_height?: number
}

/**
 * Figures to render instantly for `address`, or null to keep the loading
 * skeleton until refresh() completes.
 *
 * Amounts never come from the sync cache: its total_sent counts every time one
 * of our outputs was sampled as a decoy in someone else's ring, and on a small
 * chain that alone pushes the balance below zero. They come only from the last
 * corrected snapshot. Both entries must belong to this wallet, since either can
 * still hold another wallet's figures right after a switch. The cache supplies
 * only the heights, which decoys don't touch.
 */
export function instantInfo(
  address: string,
  cache: SyncCache | undefined,
  corrected: CorrectedBalance | undefined
): Record<string, unknown> | null {
  if (!corrected || corrected.address !== address) return null
  const heights = cache?.address === address ? cache.info : undefined
  const scanned = Number(heights?.scanned_block_height ?? corrected.scanned_block_height ?? 0) || 0
  return {
    total_received: corrected.total_received ?? '0',
    total_sent: corrected.total_sent ?? '0',
    locked_funds: corrected.locked_funds ?? '0',
    scanned_block_height: scanned,
    blockchain_height: Number(heights?.blockchain_height ?? scanned) || scanned
  }
}
