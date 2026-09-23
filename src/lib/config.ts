// Network / backend configuration.
//
// Every network's resolved settings are substituted at BUILD time (webpack
// DefinePlugin -> `__BDX_NETS__`), and which one is ACTIVE is chosen at
// runtime. webpack merges src/lib/networks.json with .env and the --env CLI
// flags for each network, and derives the manifest's host_permissions from the
// union of all of them — so the endpoints and the permissions to reach them
// still cannot drift apart, on any chain.
//
//   npm run build:chrome          -> mainnet is the DEFAULT for a fresh wallet
//   npm run build:chrome:testnet  -> testnet is the default (and the build is
//                                    still branded as a testnet build)
//   .env: BDX_NETWORK / <NET>_LWS_URL / ...   (see .env.example)
//
// NOTE — this deliberately replaces the wallet's former build-time chain
// pinning. The chain used to be fixed at compile time so a build could only
// ever reach the chain it was compiled for; a user-facing network switcher is
// incompatible with that, so both chains' endpoints now ship in every bundle.
// What protects the user instead is that testnet is always visibly marked (see
// CONFIG.IS_TESTNET / the net badge and the send-screen warning) and that the
// active network is stored per wallet, never guessed.
//
// `CONFIG` is a live view of the active network — every property is a getter,
// so existing `CONFIG.LWS_URL` call sites keep working untouched and always
// observe the current selection. Hydrate it with setActiveNetwork() before the
// first backend call in each context (the background does this from the active
// wallet's stored preference; the panel does it from GET_STATE).

export type NetworkName = 'mainnet' | 'testnet'

export interface ResolvedNetwork {
  network: NetworkName
  nettype: number
  label: string
  lws: string
  daemonRpc: string
  bnsLookup: string
  explorerTx: string
  priceUrl: string
  showFiat: boolean
  autoLockMinutes: number
}

declare const __BDX_NETS__: Record<NetworkName, ResolvedNetwork>
declare const __BDX_DEFAULT_NET__: NetworkName

/** Every network this build can reach, resolved. */
export const NETWORKS: Record<NetworkName, ResolvedNetwork> = __BDX_NETS__

export const NETWORK_NAMES = Object.keys(NETWORKS) as NetworkName[]

/** The network a brand-new wallet starts on (the build's `--env network=`). */
export const DEFAULT_NETWORK: NetworkName = __BDX_DEFAULT_NET__

export function isNetworkName(v: unknown): v is NetworkName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(NETWORKS, v)
}

let active: NetworkName = DEFAULT_NETWORK

export function activeNetwork(): NetworkName {
  return active
}

/** Point CONFIG at `name`. Unknown names are ignored so a corrupted stored
 *  preference degrades to the build default instead of breaking every fetch. */
export function setActiveNetwork(name: unknown): NetworkName {
  if (isNetworkName(name)) active = name
  return active
}

export function networkConfig(name: NetworkName): ResolvedNetwork {
  return NETWORKS[name]
}

export function nettypeOf(name: NetworkName): number {
  return NETWORKS[name].nettype
}

const cur = (): ResolvedNetwork => NETWORKS[active]

export const CONFIG = {
  // "mainnet" | "testnet" — for display and for the dapp bridge's bdx_getNetwork.
  get NETWORK(): NetworkName { return active },
  get NETWORK_LABEL(): string { return cur().label },
  /** Anything that is not mainnet is play money — surfaces must say so. */
  get IS_TESTNET(): boolean { return active !== 'mainnet' },

  // Beldex light-wallet server. Implements the endpoints defined in
  // beldex/src/wallet/wallet_light_rpc.h (/login, /get_address_info,
  // /get_address_txs, /get_unspent_outs, /get_random_outs, /submit_raw_tx).
  // It scans the chain with the account's view key; spend keys never leave the
  // client. To self-host, set <NET>_LWS_URL in .env.
  get LWS_URL(): string { return cur().lws },

  // Public daemon JSON-RPC (reserved for future daemon queries).
  get DAEMON_RPC_URL(): string { return cur().daemonRpc },

  // Explorer REST endpoint for BNS name resolution. NOTE: the extension trusts
  // this host to return the correct wallet address for a name — a compromised
  // endpoint could substitute an address. Mitigation: the send flow shows the
  // full resolved address in the review modal before broadcast (see threat
  // model in bns.ts). Self-host or pin as needed for higher assurance.
  get BNS_LOOKUP_URL(): string { return cur().bnsLookup },

  // Base URL for per-transaction explorer links (tx hash is appended).
  get EXPLORER_TX_URL(): string { return cur().explorerTx },

  // Fiat quote source, and whether to show fiat at all. Off for testnet by
  // default — quoting the price of *mainnet* BDX next to coins that have no
  // value is actively misleading now that a user can switch chains in-app.
  get PRICE_URL(): string { return cur().priceUrl },
  get SHOW_FIAT(): boolean { return cur().showFiat },

  // Serial-bridge nettype convention (see @bdxi/beldex-nettype):
  // 0 = MAINNET, 1 = TESTNET, 2 = DEVNET. Drives seed/address generation and
  // the base58 address prefix, so a mismatch here produces addresses the
  // network will reject.
  get NETTYPE(): number { return cur().nettype },

  // Auto-lock the keyring after this many minutes of inactivity.
  get AUTO_LOCK_MINUTES(): number { return cur().autoLockMinutes },
}
