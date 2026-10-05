// Whether the token registration form may open, and if not, why.

export type TokenGate =
  /** Registration is not offered on this network (mainnet, for now). */
  | { kind: 'disabled' }
  /** The chain is on the token fork: open the form. */
  | { kind: 'open' }
  /** The chain has not reached the token fork yet. */
  | { kind: 'not-live'; forkVersion: number; needVersion: number; forkHeight: number | null; height: number | null; blocksLeft: number | null }
  /** The chain is past the fork height, but the server still reports an older
   *  fork: it has not been upgraded for privacy tokens. */
  | { kind: 'server-behind'; forkVersion: number; needVersion: number }
  /** The fork could not be read from the server. */
  | { kind: 'unknown' }

/**
 * `forkVersion` is what the light wallet server reports (null when the request
 * failed); `needVersion` is the fork registration requires; `forkHeight` is the
 * network's scheduled activation block; `height` is the chain tip as the wallet
 * last saw it. Registration only opens on a network that offers it AND once
 * the server confirms the chain is on the token fork - the node rejects a
 * registration before then, so the form would only collect a doomed request.
 */
export function tokenGate(p: {
  enabled: boolean
  forkVersion: number | null
  needVersion: number
  forkHeight: number | null
  height: number | null
}): TokenGate {
  if (!p.enabled) return { kind: 'disabled' }
  if (p.forkVersion === null) return { kind: 'unknown' }
  if (p.forkVersion >= p.needVersion) return { kind: 'open' }
  if (p.forkHeight !== null && p.height !== null && p.height >= p.forkHeight) {
    return { kind: 'server-behind', forkVersion: p.forkVersion, needVersion: p.needVersion }
  }
  const blocksLeft = p.forkHeight !== null && p.height !== null ? p.forkHeight - p.height : null
  return {
    kind: 'not-live',
    forkVersion: p.forkVersion,
    needVersion: p.needVersion,
    forkHeight: p.forkHeight,
    height: p.height,
    blocksLeft
  }
}
