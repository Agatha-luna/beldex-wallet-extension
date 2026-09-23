// Background service worker: owns the encrypted wallet vaults, the unlocked
// session, and background chain-sync.
//
// Multi-wallet model: each wallet = { name, address, vault } under its own id;
// vaults are encrypted independently (each with its own password). Exactly one
// wallet is "active"; the session (chrome.storage.session — memory-backed,
// never on disk, survives SW restarts, cleared on browser exit) holds the
// active wallet's decrypted secrets while unlocked.
//
// No WASM here — the Emscripten glue targets window contexts; all crypto-core
// work happens in the panel.

import { encryptVault, decryptVault, Vault } from '../lib/keyring'
import {
  CONFIG, DEFAULT_NETWORK, NETWORK_NAMES, activeNetwork, isNetworkName,
  nettypeOf, setActiveNetwork
} from '../lib/config'
import type { NetworkName } from '../lib/config'
import { addressForNettype } from '../lib/signMessage'
import * as lws from '../lib/lws'
import type { BgRequest, BgResponse, WalletMeta, WalletSecrets, WalletState } from '../lib/messages'
import { wireToolbarOpensPanel } from '../lib/platform'
import { sessionStore } from '../lib/sessionStore'
import {
  initDappBridge, dappGetPending, dappFirstPending, dappApprove, dappReject,
  dappBeginSend, dappComplete, dappSignComplete, dappFail, dappSendLockAcquire, dappSendLockRelease,
  dappListOrigins, dappRevokeOrigin, dappActiveTabSite, dappNotifyLocked, dappNotifyUnlocked,
  dappNotifyWalletSwitched, dappNotifyBalanceFromInfo, dappCleanupWallet,
  dappInvalidateOnSessionEnd, dappInvalidateForWallet, dappAuthSignComplete,
  dappNotifyNetworkChanged, dappInvalidateForNetwork, sendLockHeld
} from './dapp'

// Open the panel when the toolbar icon is clicked (Chrome side panel / Firefox sidebar).
wireToolbarOpensPanel()

// Dapp bridge: ports from content scripts + approval-window plumbing.
initDappBridge()

const LEGACY_VAULT_KEY = 'beldex_vault'
const WALLETS_KEY = 'wallets'
// The active wallet for the CURRENT network. Derived from ACTIVE_BY_NET_KEY and
// kept written so background/dapp.ts can read "who is active" with one get.
const ACTIVE_KEY = 'active_wallet_id'
// The active network, GLOBAL. Network is deliberately not a property of the
// active wallet any more: selecting a wallet must never move the user to
// another chain, and only wallets on the active chain are selectable at all.
const ACTIVE_NET_KEY = 'active_network'
// Active wallet per network, so switching chains restores whichever wallet was
// last used there instead of forcing a choice.
const ACTIVE_BY_NET_KEY = 'active_wallet_by_network'
const SESSION_KEY = 'session_secrets'
const CACHE_KEY = 'sync_cache'
// Written by the panel (Dashboard) with key-image-corrected figures and read by
// the dapp bridge. Chain-specific, so a network switch must drop it.
const CORRECTED_KEY = 'corrected_balance'
const ALARM_LOCK = 'auto_lock'
const ALARM_SYNC = 'bg_sync'
const ATOMIC = 1e9

interface StoredWallet {
  name: string
  /** Legacy/primary address (the chain the wallet was created on). Kept so
   *  older installs keep working; `addresses` is the authoritative map. */
  address: string
  /** Address per network. The account is one keypair on every chain — only the
   *  encoding differs — so this is filled for ALL networks at save time, and
   *  backfilled from the public keys on first unlock for wallets created
   *  before the network switcher existed. */
  addresses?: Partial<Record<NetworkName, string>>
  /** Every network this wallet is available on. Normalized on read, so a wallet
   *  written by an earlier version (single `network`, or neither field) still
   *  resolves. */
  networks?: NetworkName[]
  /** Superseded by `networks`; read only for migration. */
  network?: NetworkName
  vault: Vault
}
type WalletMap = Record<string, StoredWallet>

// ---- per-network addressing --------------------------------------------------

/** Every network's address for this account, from its PUBLIC keys alone.
 *  Never needs the seed, so it works from the stripped session. */
function addressesFor(secrets: WalletSecrets): Partial<Record<NetworkName, string>> {
  const out: Partial<Record<NetworkName, string>> = {}
  for (const name of NETWORK_NAMES) {
    try {
      out[name] = addressForNettype(secrets.pubSpendKey, secrets.pubViewKey, nettypeOf(name))
    } catch {
      // Malformed key material for this account — leave the entry absent rather
      // than store a wrong address (wrong address = silently unspendable funds).
    }
  }
  return out
}

/** Networks a wallet is available on. Normalizes the older single-`network`
 *  shape and the oldest shape (neither field) to a list. */
function walletNetworks(w: StoredWallet | undefined): NetworkName[] {
  if (!w) return []
  const list = (w.networks ?? []).filter(isNetworkName)
  if (list.length) return list
  return [isNetworkName(w.network) ? w.network : DEFAULT_NETWORK]
}

function isOnNetwork(w: StoredWallet | undefined, network: NetworkName): boolean {
  return walletNetworks(w).includes(network)
}

/** The address to show/use for a wallet on a given network, '' if unknown. */
function walletAddress(w: StoredWallet | undefined, network: NetworkName): string {
  if (!w) return ''
  const mapped = w.addresses?.[network]
  if (mapped) return mapped
  // Pre-switcher wallet not yet backfilled: its stored address belongs to the
  // chain it was created on. Only claim it when that is the network being asked
  // for; the map is filled in properly at the next unlock.
  return walletNetworks(w)[0] === network ? w.address : ''
}

/**
 * Register an account with the ACTIVE network's LWS so the server starts
 * scanning for it.
 *
 * This has to happen the first time an account appears on a chain — at wallet
 * setup, and on every network switch — because the account genuinely does not
 * exist on that server yet: a /get_address_info for it comes back as "account
 * not exists" rather than an empty balance. Doing it here rather than relying
 * on the panel means registration does not depend on a panel being open, or on
 * it staying open long enough after a switch.
 *
 * `create_account: true` (login's default) is what creates it. Failures are
 * swallowed: the panel logs in again on mount and the 30s sync retries, so a
 * transient LWS outage must not block the switch itself.
 */
async function registerWithLws(address: string, secViewKey: string): Promise<void> {
  try {
    await lws.login({ address, view_key: secViewKey })
  } catch {
    // server down / not reachable — the panel's own login and the next sync retry
  }
}

/**
 * The active network. Stored globally; falls back to the chain of whatever
 * wallet was active under the pre-global scheme, so an existing install lands
 * where the user left off rather than being yanked to the build default.
 */
async function activeNetworkName(): Promise<NetworkName> {
  const o = await chrome.storage.local.get([ACTIVE_NET_KEY, ACTIVE_KEY])
  if (isNetworkName(o[ACTIVE_NET_KEY])) return o[ACTIVE_NET_KEY]
  const wallets = await getWallets()
  const prev = o[ACTIVE_KEY]
  const migrated = walletNetworks(prev ? wallets[prev] : undefined)[0] ?? DEFAULT_NETWORK
  await chrome.storage.local.set({ [ACTIVE_NET_KEY]: migrated })
  return migrated
}

/** Point CONFIG at the active network. Module state is lost whenever the MV3
 *  worker unloads, so this runs at the top of every entry point rather than
 *  once at startup. */
async function hydrateNetwork(): Promise<NetworkName> {
  return setActiveNetwork(await activeNetworkName())
}

async function activeByNetwork(): Promise<Partial<Record<NetworkName, string>>> {
  const v = (await chrome.storage.local.get(ACTIVE_BY_NET_KEY))[ACTIVE_BY_NET_KEY]
  return v && typeof v === 'object' ? v : {}
}

/** Remember `id` as the active wallet for `network`, and mirror it to
 *  ACTIVE_KEY when that network is the active one (what dapp.ts reads). */
async function setActiveWalletForNetwork(network: NetworkName, id: string): Promise<void> {
  const map = await activeByNetwork()
  map[network] = id
  const patch: Record<string, unknown> = { [ACTIVE_BY_NET_KEY]: map }
  if (await activeNetworkName() === network) patch[ACTIVE_KEY] = id
  await chrome.storage.local.set(patch)
}

// ---- wallet store (with one-time migration from the single-vault format) ----

async function getWallets(): Promise<WalletMap> {
  const o = await chrome.storage.local.get([WALLETS_KEY, LEGACY_VAULT_KEY, ACTIVE_KEY])
  let wallets: WalletMap = o[WALLETS_KEY] ?? {}
  if (Object.keys(wallets).length === 0 && o[LEGACY_VAULT_KEY]) {
    // migrate the pre-multi-wallet vault; address backfilled on first unlock
    wallets = { w1: { name: 'Wallet 1', address: '', vault: o[LEGACY_VAULT_KEY] } }
    await chrome.storage.local.set({ [WALLETS_KEY]: wallets, [ACTIVE_KEY]: 'w1' })
    await chrome.storage.local.remove(LEGACY_VAULT_KEY)
  }
  return wallets
}

async function setWallets(w: WalletMap): Promise<void> {
  await chrome.storage.local.set({ [WALLETS_KEY]: w })
}

/**
 * The active wallet — scoped to the ACTIVE NETWORK. Returns null when no wallet
 * is available on this chain, which is a legitimate state (wallets can exist on
 * another network) and the reason the panel offers to bring one along.
 *
 * Self-healing: a remembered id that was deleted, or that no longer lists this
 * network, is replaced by the first wallet that does.
 */
async function getActiveId(): Promise<string | null> {
  const network = await activeNetworkName()
  const wallets = await getWallets()
  const eligible = Object.keys(wallets).filter(id => isOnNetwork(wallets[id], network))
  if (eligible.length === 0) {
    // Don't leave a stale mirror pointing at a wallet that isn't selectable here.
    const o = await chrome.storage.local.get(ACTIVE_KEY)
    if (o[ACTIVE_KEY]) await chrome.storage.local.set({ [ACTIVE_KEY]: '' })
    return null
  }
  const map = await activeByNetwork()
  const remembered = map[network]
  const id = remembered && eligible.includes(remembered) ? remembered : eligible[0]!
  const o = await chrome.storage.local.get(ACTIVE_KEY)
  if (map[network] !== id || o[ACTIVE_KEY] !== id) {
    await chrome.storage.local.set({
      [ACTIVE_BY_NET_KEY]: { ...map, [network]: id },
      [ACTIVE_KEY]: id
    })
  }
  return id
}

/**
 * EVERY wallet, each carrying the networks it is available on. The list is not
 * filtered here: wallet selection shows all of them so a wallet that lives on
 * another chain can be brought onto this one from the same place you pick
 * wallets (ADD_WALLET_TO_NETWORK), rather than being hidden with no route to it.
 *
 * `address` is this wallet's address on the ACTIVE network, and is '' for a
 * wallet that is not on it — the UI relies on `networks` to tell the two apart,
 * never on the address being non-empty.
 */
async function walletList(): Promise<WalletMeta[]> {
  const network = await activeNetworkName()
  const wallets = await getWallets()
  const active = await getActiveId()
  return Object.entries(wallets).map(([id, w]) => ({
    id,
    name: w.name,
    address: isOnNetwork(w, network) ? walletAddress(w, network) : '',
    networks: walletNetworks(w),
    active: id === active
  }))
}

// ---- session ----------------------------------------------------------------

interface Session {
  walletId: string
  /** Fresh random id per unlock (external audit): approvals reviewed under one
   *  session must not execute under another — bound GET_SECRETS checks it. */
  generation: string
  secrets: WalletSecrets
}

async function getSession(): Promise<Session | null> {
  const o = await sessionStore.get(SESSION_KEY)
  return o[SESSION_KEY] ?? null
}

async function startSession(walletId: string, secrets: WalletSecrets, network?: NetworkName): Promise<void> {
  // Least privilege (audit L4): the session never holds the mnemonic or raw
  // seed — no runtime consumer needs them (sends/key-images use the sec keys;
  // Settings' reveal flows re-decrypt the vault via REVEAL). Keeps the most
  // catastrophic secrets out of every GET_SECRETS round-trip and JS context.
  //
  // The address is re-encoded for the wallet's CURRENT network: the vault's
  // stored address belongs to whichever chain the wallet was created on, and
  // serving that while pointed at another chain would show a foreign address
  // and register the wrong account with the LWS.
  const net = network ?? activeNetwork()
  const sessionSecrets: WalletSecrets = {
    ...secrets,
    mnemonic: '',
    seed: '',
    address: addressesFor(secrets)[net] ?? secrets.address
  }
  await sessionStore.set({ [SESSION_KEY]: { walletId, generation: crypto.randomUUID(), secrets: sessionSecrets } })
  await touchAutoLock()
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 0.5, delayInMinutes: 0 })
  // walletId passed EXPLICITLY (external audit): this runs detached, and the
  // active id may have changed by the time it executes — the notification
  // must describe the wallet that actually unlocked. The address is the
  // session's (network-correct) one, not the vault's.
  dappNotifyUnlocked(walletId, sessionSecrets.address).catch(() => {})
}

async function endSession(): Promise<void> {
  const session = await getSession()
  await sessionStore.remove([SESSION_KEY, CACHE_KEY])
  await chrome.alarms.clear(ALARM_SYNC)
  await chrome.alarms.clear(ALARM_LOCK)
  if (session) {
    // Same explicit-id rule as unlock; and approvals reviewed under this
    // session (send/sign) die with it (external audit).
    dappNotifyLocked(session.walletId).catch(() => {})
    dappInvalidateOnSessionEnd().catch(() => {})
  }
}

// ---- brute-force backoff --------------------------------------------------------
//
// Persisted in storage.local so it survives both the service worker
// idling out (~30s) AND a full browser restart — previously session-scoped,
// which let an attacker reset the counter with a relaunch. The cap is 10
// minutes (was 60s). An attacker with the profile ON DISK still brute-forces
// the vault offline against PBKDF2-600k regardless of any of this — the real
// defenses are the KDF and password strength; this is friction against
// scripted guessing through the message channel. (Planned follow-up: migrate
// the KDF to Argon2id — see keyring.ts.)

interface BackoffEntry { fails: number; nextAllowedAt: number }
const BACKOFF_KEY = 'backoff_state'
const BACKOFF_THRESHOLD = 5
const BACKOFF_CAP_MS = 10 * 60_000

async function getBackoff(): Promise<Record<string, BackoffEntry>> {
  return ((await chrome.storage.local.get(BACKOFF_KEY))[BACKOFF_KEY] as Record<string, BackoffEntry>) ?? {}
}

/** Returns an error message if this wallet is still in backoff, else null. */
async function backoffCheck(walletId: string): Promise<string | null> {
  const e = (await getBackoff())[walletId]
  if (e && Date.now() < e.nextAllowedAt) {
    const secs = Math.ceil((e.nextAllowedAt - Date.now()) / 1000)
    const human = secs >= 60 ? `${Math.ceil(secs / 60)}m` : `${secs}s`
    return `Too many attempts — try again in ${human}`
  }
  return null
}

async function backoffRecordFailure(walletId: string): Promise<void> {
  const state = await getBackoff()
  const e = state[walletId] ?? { fails: 0, nextAllowedAt: 0 }
  e.fails++
  if (e.fails >= BACKOFF_THRESHOLD) {
    // 5th failure -> 2s, then 4s, 8s, ... capped at 10 minutes
    const delay = Math.min(2 ** (e.fails - BACKOFF_THRESHOLD + 1) * 1000, BACKOFF_CAP_MS)
    e.nextAllowedAt = Date.now() + delay
  }
  state[walletId] = e
  await chrome.storage.local.set({ [BACKOFF_KEY]: state })
}

async function backoffReset(walletId: string): Promise<void> {
  const state = await getBackoff()
  if (walletId in state) {
    delete state[walletId]
    await chrome.storage.local.set({ [BACKOFF_KEY]: state })
  }
}

// ---- auto-lock ----------------------------------------------------------------

const AUTOLOCK_KEY = 'auto_lock_minutes'

async function autoLockMinutes(): Promise<number> {
  const o = await chrome.storage.local.get(AUTOLOCK_KEY)
  const m = Number(o[AUTOLOCK_KEY])
  return Number.isFinite(m) && m >= 1 && m <= 240 ? m : CONFIG.AUTO_LOCK_MINUTES
}

async function touchAutoLock() {
  chrome.alarms.create(ALARM_LOCK, { delayInMinutes: await autoLockMinutes() })
}

// ---- background sync ----------------------------------------------------------

// Single-flight guard (external audit): the 30s alarm must not start a second
// sync while one is still in flight (a slow/hanging LWS would otherwise let
// overlapping fetches accumulate). Bounded regardless by the fetch deadline.
let syncInFlight = false

async function syncOnce(): Promise<void> {
  if (syncInFlight) return
  const session = await getSession()
  if (!session) { chrome.alarms.clear(ALARM_SYNC); return }
  // The worker may have restarted since the last sync, losing the in-memory
  // network selection — re-point CONFIG before any LWS call so a background
  // sync can never query the wrong chain for this address.
  await hydrateNetwork()
  const s = session.secrets
  syncInFlight = true
  try {
    const info = await lws.getAddressInfo({ address: s.address, view_key: s.secViewKey })
    const prevCache = (await sessionStore.get(CACHE_KEY))[CACHE_KEY]
    await sessionStore.set({ [CACHE_KEY]: { info, at: Date.now(), address: s.address } })

    // Dapp bridge: push balanceChanged to connected+granted origins on any delta.
    if (
      prevCache?.address === s.address &&
      (String(prevCache?.info?.total_received) !== String(info.total_received) ||
        String(prevCache?.info?.total_sent) !== String(info.total_sent) ||
        String(prevCache?.info?.locked_funds) !== String(info.locked_funds))
    ) {
      dappNotifyBalanceFromInfo(info).catch(() => {})
    }

    // Notify on new incoming funds. Heuristic: total_received also grows from
    // change returned by our own outgoing txs, so skip when total_sent grew too.
    // Compare only caches for the same wallet (switching wallets resets this).
    if (prevCache?.address !== s.address) return
    const prevReceived = Number(prevCache?.info?.total_received ?? NaN)
    const prevSent = Number(prevCache?.info?.total_sent ?? NaN)
    const nowReceived = Number(info.total_received ?? 0)
    const nowSent = Number(info.total_sent ?? 0)
    if (!Number.isNaN(prevReceived) && nowReceived > prevReceived && nowSent <= prevSent) {
      // Privacy toggle: hide the amount from the on-screen notification if set.
      const hideAmount = (await chrome.storage.local.get('notif_hide_amount'))['notif_hide_amount'] === true
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Beldex Wallet',
        message: hideAmount
          ? 'You received BDX'
          : `Received ${((nowReceived - prevReceived) / ATOMIC).toFixed(4)} BDX`
      })
    }
  } catch {
    // network/LWS hiccup — next alarm will retry
  } finally {
    syncInFlight = false
  }
}

chrome.alarms.onAlarm.addListener(async a => {
  if (a.name === ALARM_LOCK) await endSession()
  if (a.name === ALARM_SYNC) await syncOnce()
})

// ---- message handling ----------------------------------------------------------

async function stateResponse(): Promise<BgResponse> {
  const network = activeNetwork() // handle() hydrates before dispatching
  const wallets = await walletList()
  const session = await getSession()
  const activeId = await getActiveId()
  const active = wallets.find(w => w.active)
  // `wallets` is every wallet; whether we are usable here depends on there
  // being an ACTIVE one, which getActiveId() scopes to this network.
  let state: WalletState = 'uninitialized'
  if (session && session.walletId === activeId) state = 'unlocked'
  else if (activeId) state = 'locked'
  return {
    ok: true,
    state,
    address: state === 'unlocked' ? session!.secrets.address : undefined,
    walletName: active?.name,
    wallets,
    network
  }
}

async function handle(req: BgRequest): Promise<BgResponse> {
  // MV3 workers unload and lose module state, so the active-network selection
  // is re-read from the active wallet on every message rather than once at
  // startup. Cheap (one storage.local read) and removes any window in which a
  // freshly-woken worker could fetch from the wrong chain.
  await hydrateNetwork()

  switch (req.type) {
    case 'GET_STATE':
      return stateResponse()

    case 'SAVE_WALLET': {
      const wallets = await getWallets()
      const network = activeNetwork() // a wallet added while on testnet starts on testnet
      const addresses = addressesFor(req.secrets)
      // Reject a restore/create of an account already present, on ANY network.
      // Matching only the incoming address would let the same seed be imported
      // twice by importing it once per chain — the keypair is what's duplicated,
      // and every network's encoding of it names the same account.
      const mine = new Set(Object.values(addresses).filter(Boolean) as string[])
      mine.add(req.secrets.address)
      const clash = Object.values(wallets).some(w => {
        const theirs = [w.address, ...Object.values(w.addresses ?? {})].filter(Boolean) as string[]
        return theirs.some(a => mine.has(a))
      })
      if (clash) return { ok: false, error: 'This wallet is already imported' }
      const vault = await encryptVault(JSON.stringify(req.secrets), req.password)
      const id = crypto.randomUUID()
      const name = req.name?.trim() || `Wallet ${Object.keys(wallets).length + 1}`
      wallets[id] = { name, address: req.secrets.address, addresses, networks: [network], vault }
      await setWallets(wallets)
      await endSession() // drop any previous wallet's session/cache
      // Record it as the active wallet FOR THIS NETWORK, not just in the mirror
      // key: getActiveId() resolves per network, so writing only the mirror left
      // the previous wallet "active" here — the new session then failed to match
      // it and the panel asked for a password instead of opening the wallet the
      // user had just created.
      await setActiveWalletForNetwork(network, id)
      await dappInvalidateForWallet(id) // approvals for other wallets are void
      await startSession(id, req.secrets)
      // Register at SETUP, not just on first panel mount. A seed brought over
      // from the CLI (or any other wallet) names an account this LWS has never
      // seen, so without this the first reads come back "account not exists"
      // rather than an empty balance. create_account: true is what adds it.
      registerWithLws(addresses[network] ?? req.secrets.address, req.secrets.secViewKey)
        .catch(() => {})
      return stateResponse()
    }

    case 'UNLOCK': {
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }
      const wait = await backoffCheck(activeId)
      if (wait) return { ok: false, error: wait }
      try {
        const secrets: WalletSecrets = JSON.parse(await decryptVault(wallets[activeId].vault, req.password))
        let dirty = false
        if (!wallets[activeId].address && secrets.address) {
          wallets[activeId].address = secrets.address // backfill migrated wallet
          dirty = true
        }
        // Backfill the per-network address map for wallets created before the
        // switcher existed (and for any network added by a later build). Cheap,
        // derived purely from the public keys, and makes the wallet list show a
        // real address on every chain without needing another unlock.
        const known = wallets[activeId].addresses ?? {}
        if (NETWORK_NAMES.some(n => !known[n])) {
          wallets[activeId].addresses = { ...addressesFor(secrets), ...known }
          dirty = true
        }
        if (dirty) await setWallets(wallets)
        await backoffReset(activeId)
        // TOCTOU re-check (external audit): decryption is slow (PBKDF2-600k)
        // and a concurrent SWITCH_WALLET may have changed the active id —
        // starting this session anyway would leave session.walletId pointing
        // at a wallet that is no longer active, and GET_SECRETS would serve it.
        if (await getActiveId() !== activeId) {
          return { ok: false, error: 'Wallet switched during unlock — try again' }
        }
        // Re-read the network for the same reason: a SWITCH_NETWORK may have
        // landed during the slow decrypt, and the session's address must match
        // the chain that is actually selected now, not when unlock began.
        await startSession(activeId, secrets, await hydrateNetwork())
        return stateResponse()
      } catch {
        await backoffRecordFailure(activeId)
        return { ok: false, error: 'Incorrect password' }
      }
    }

    case 'LOCK':
      await endSession()
      return stateResponse()

    case 'GET_SECRETS': {
      const session = await getSession()
      if (!session) return { ok: false, error: 'Locked' }
      // Bound fetch (external audit): approval flows pass the wallet/session
      // context recorded when their request was queued; secrets are refused if
      // the session OR the active wallet has changed since review began.
      if (req.expect) {
        const activeId = await getActiveId()
        if (session.walletId !== req.expect.walletId || activeId !== req.expect.walletId
          || (req.expect.generation !== null && session.generation !== req.expect.generation)) {
          return { ok: false, error: 'Wallet changed — review this request again' }
        }
      }
      await touchAutoLock()
      return { ok: true, secrets: session.secrets }
    }

    case 'REVEAL': {
      // Always re-verifies the password against the ACTIVE wallet's vault.
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }
      const wait = await backoffCheck(activeId)
      if (wait) return { ok: false, error: wait }
      try {
        const secrets: WalletSecrets = JSON.parse(await decryptVault(wallets[activeId].vault, req.password))
        await backoffReset(activeId)
        return { ok: true, secrets }
      } catch {
        await backoffRecordFailure(activeId)
        return { ok: false, error: 'Incorrect password' }
      }
    }

    case 'CHANGE_PASSWORD': {
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }
      // Same throttle as UNLOCK/REVEAL — without it this path is a free
      // password-guessing oracle that bypasses the backoff entirely.
      const wait = await backoffCheck(activeId)
      if (wait) return { ok: false, error: wait }
      let plaintext: string
      try {
        plaintext = await decryptVault(wallets[activeId].vault, req.oldPassword)
      } catch {
        await backoffRecordFailure(activeId)
        return { ok: false, error: 'Current password is incorrect' }
      }
      await backoffReset(activeId)
      wallets[activeId].vault = await encryptVault(plaintext, req.newPassword)
      await setWallets(wallets)
      return { ok: true }
    }

    case 'TOUCH': {
      // REAL user activity (pointer/keyboard/focus in a wallet surface):
      // re-arm the inactivity auto-lock. Approval surfaces must NOT send this
      // as a bare heartbeat — that would hold an unlocked session open while
      // the user is absent (external audit). Worker warmth uses KEEPALIVE.
      if (await getSession()) await touchAutoLock()
      return { ok: true }
    }

    case 'KEEPALIVE':
      // Keeps the MV3 service worker responsive during a long review WITHOUT
      // touching the inactivity deadline — worker liveness is a port-lifecycle
      // concern, not evidence of a user at the keyboard.
      return { ok: true }

    case 'GET_AUTOLOCK':
      return { ok: true, minutes: await autoLockMinutes() }

    case 'SET_AUTOLOCK': {
      const m = Number(req.minutes)
      if (!Number.isFinite(m) || m < 1 || m > 240) return { ok: false, error: 'Invalid duration' }
      await chrome.storage.local.set({ [AUTOLOCK_KEY]: m })
      if (await getSession()) await touchAutoLock() // re-arm with the new duration
      return { ok: true, minutes: m }
    }

    case 'SWITCH_WALLET': {
      const network = activeNetwork()
      const wallets = await getWallets()
      if (!wallets[req.id]) return { ok: false, error: 'Unknown wallet' }
      // Only wallets on the ACTIVE network are selectable. This is what stops
      // picking a wallet from silently moving the user to another chain — the
      // network is changed only by SWITCH_NETWORK, never as a side effect.
      if (!isOnNetwork(wallets[req.id], network)) {
        return { ok: false, error: `That wallet is not available on ${network}` }
      }
      const activeId = await getActiveId()
      if (req.id !== activeId) {
        await endSession() // switching requires the target wallet's password
        await setActiveWalletForNetwork(network, req.id)
        // Approvals queued for the previous wallet are void (external audit) —
        // approving them now would bind a different wallet than displayed.
        await dappInvalidateForWallet(req.id)
        dappNotifyWalletSwitched().catch(() => {}) // grants never carry over
      }
      return stateResponse()
    }

    case 'ADD_WALLET_TO_NETWORK': {
      const wallets = await getWallets()
      if (!wallets[req.id]) return { ok: false, error: 'Unknown wallet' }
      if (!isNetworkName(req.network)) return { ok: false, error: 'Unknown network' }
      // Additive and idempotent. No password: the same keypair is already valid
      // on every chain, so this grants no capability the user did not have — it
      // only decides where the wallet is offered.
      const next = Array.from(new Set([...walletNetworks(wallets[req.id]), req.network]))
      wallets[req.id].networks = next
      delete wallets[req.id].network // fully migrated off the single-network field
      // Fill in that network's address while the keys are to hand, so the wallet
      // shows a real address there immediately rather than after its next unlock.
      const session = await getSession()
      if (session && session.walletId === req.id) {
        wallets[req.id].addresses = {
          ...(wallets[req.id].addresses ?? {}),
          ...addressesFor(session.secrets)
        }
      }
      await setWallets(wallets)
      return stateResponse()
    }

    case 'SWITCH_NETWORK': {
      if (!isNetworkName(req.network)) return { ok: false, error: 'Unknown network' }
      const from = await activeNetworkName()
      if (from === req.network) return stateResponse() // idempotent, no churn

      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }

      // Refuse mid-send. A transaction under construction has already selected
      // outputs and computed a fee against ONE chain's unspent set; repointing
      // the LWS underneath it would at best fail late and at worst submit to
      // the wrong network. The send lock is the same global one the panel and
      // the dapp bridge share. Checked BEFORE the password so a busy wallet
      // says so immediately instead of after a 600k-iteration KDF.
      if (await sendLockHeld()) {
        return { ok: false, error: 'A transaction is in progress — try again once it finishes' }
      }

      // The wallet the user is looking at may not exist on the target chain. In
      // that case switching would silently drop them onto some other wallet (or
      // onto nothing at all), so it is refused and the panel asks whether to
      // bring this wallet along. Declining leaves them exactly where they are —
      // deciding for them is what makes a chain switch feel like it lost the
      // user's place.
      const activeOnTarget = isOnNetwork(wallets[activeId], req.network)
      if (!activeOnTarget && !req.addActiveWallet) {
        return {
          ok: false,
          code: 'WALLET_NOT_ON_NETWORK',
          error: `${wallets[activeId].name} is not on ${req.network}`
        }
      }

      const session = await getSession()
      const hadSession = !!session && session.walletId === activeId

      if (!activeOnTarget) {
        // The user said yes: make this wallet available on the target chain.
        wallets[activeId].networks = Array.from(new Set([...walletNetworks(wallets[activeId]), req.network]))
        delete wallets[activeId].network
      }

      // Backfill every network's address while the keys are available, so the
      // wallet list reads correctly on the target chain even before its unlock.
      if (hadSession) {
        wallets[activeId].addresses = {
          ...(wallets[activeId].addresses ?? {}),
          ...addressesFor(session!.secrets)
        }
      }
      await setWallets(wallets)

      await chrome.storage.local.set({ [ACTIVE_NET_KEY]: req.network })
      setActiveNetwork(req.network)

      // Which wallet is active on the target chain. If this wallet was already
      // there, restore whichever was last used on that chain. If we just brought
      // it over, stay on it — the user asked for THIS wallet on that chain, so
      // handing them a different one would ignore what they just chose.
      const nextId = activeOnTarget ? ((await getActiveId()) ?? activeId) : activeId
      await setActiveWalletForNetwork(req.network, nextId)

      // Every queued approval was reviewed against the old chain's address and
      // balance, so none of them may execute now (same rule as a wallet switch).
      await dappInvalidateForNetwork(req.network)

      // Cached chain state belongs to the network we just left.
      await sessionStore.remove([CACHE_KEY, CORRECTED_KEY])

      // The session survives only if the SAME wallet is active on the new chain:
      // the account is one keypair, so its address is re-encoded rather than
      // re-derived. A different wallet means different keys we do not hold, so
      // that necessarily requires its password.
      if (hadSession && nextId === activeId) {
        // Derived from the SESSION's public keys rather than read back from
        // storage: a wallet written by an older version may have no address map
        // yet, and falling back to its stored address would silently leave the
        // user on the old chain's address.
        const address = addressesFor(session!.secrets)[req.network] ?? ''
        if (address) {
          await sessionStore.set({
            [SESSION_KEY]: { ...session!, secrets: { ...session!.secrets, address } }
          })
          // Connected sites keep their grant and are told, rather than being
          // silently left believing they are on the old chain.
          dappNotifyNetworkChanged(activeId, address).catch(() => {})
          // The account does not exist on the target chain's LWS yet, so it must
          // be registered BEFORE anything reads it — a sync that runs first just
          // gets "account not exists". Chained rather than run in parallel for
          // exactly that reason.
          registerWithLws(address, session!.secrets.secViewKey)
            .then(() => syncOnce())
            .catch(() => {})
        }
      } else if (hadSession) {
        await endSession() // different wallet on the target chain
      }
      return stateResponse()
    }

    case 'RENAME_WALLET': {
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }
      const name = req.name.trim()
      if (!name) return { ok: false, error: 'Name cannot be empty' }
      wallets[activeId].name = name
      await setWallets(wallets)
      return stateResponse()
    }

    case 'WIPE': {
      // deletes the ACTIVE wallet only; other wallets stay intact
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId) return { ok: false, error: 'No wallet stored' }
      // Require the password so a walk-up attacker with an unlocked panel can't
      // delete the wallet from a UI-only confirmation. Throttled like UNLOCK.
      const wait = await backoffCheck(activeId)
      if (wait) return { ok: false, error: wait }
      try {
        await decryptVault(wallets[activeId].vault, req.password)
      } catch {
        await backoffRecordFailure(activeId)
        return { ok: false, error: 'Incorrect password' }
      }
      await backoffReset(activeId)
      delete wallets[activeId]
      await setWallets(wallets)
      const remaining = Object.keys(wallets)
      await chrome.storage.local.set({ [ACTIVE_KEY]: remaining[0] ?? '' })
      await endSession()
      await dappCleanupWallet(activeId) // drop this wallet's site grants
      return stateResponse()
    }

    // ---- dapp bridge (approval UI + Connected Sites) ----

    case 'DAPP_GET_PENDING': {
      const r = await dappGetPending(req.reqId)
      return r.ok ? { ok: true, pending: r.pending } : { ok: false, error: r.error }
    }

    case 'DAPP_LIST_PENDING':
      return { ok: true, pendingReq: await dappFirstPending() }

    case 'DAPP_APPROVE': {
      const r = await dappApprove(req.reqId)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }

    case 'DAPP_REJECT':
      return dappReject(req.reqId)

    case 'DAPP_BEGIN_SEND': {
      const r = await dappBeginSend(req.reqId)
      return r.ok
        ? { ok: true, executionToken: r.executionToken, operationId: r.operationId }
        : { ok: false, error: r.error }
    }

    case 'DAPP_COMPLETE': {
      const r = await dappComplete(req.reqId, {
        operationId: req.operationId, executionToken: req.executionToken, result: req.result
      })
      // Refresh the cache promptly so balanceChanged reaches connected dapps.
      syncOnce().catch(() => {})
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }

    case 'DAPP_SIGN_COMPLETE': {
      const r = await dappSignComplete(req.reqId, req.result)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }

    case 'DAPP_AUTH_SIGN_COMPLETE': {
      const r = await dappAuthSignComplete(req.reqId, req.result)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }

    case 'DAPP_FAIL':
      return dappFail(req.reqId, {
        operationId: req.operationId, executionToken: req.executionToken, unknown: req.unknown
      })

    case 'SEND_LOCK_ACQUIRE': {
      const r = await dappSendLockAcquire()
      return r.ok ? { ok: true, lockOwner: r.owner } : { ok: false, error: r.error }
    }

    case 'SEND_LOCK_RELEASE':
      return dappSendLockRelease(req.owner)

    case 'DAPP_LIST_ORIGINS':
      return { ok: true, origins: await dappListOrigins() }

    case 'DAPP_ACTIVE_SITE':
      return { ok: true, activeSite: await dappActiveTabSite() }

    case 'DAPP_REVOKE_ORIGIN':
      return dappRevokeOrigin(req.origin)
  }
}

chrome.runtime.onMessage.addListener((req: BgRequest, sender, sendResponse) => {
  // Defense in depth: only our own EXTENSION PAGES may talk to the keyring.
  // Content scripts (which run inside web pages and must never reach
  // privileged handlers like GET_SECRETS / DAPP_APPROVE) report the web
  // page's http(s) URL; genuine extension pages report chrome-extension://
  // (moz-extension:// on Firefox). NOTE: sender.tab is NOT a valid
  // discriminator — our own panel.html?tab=1 and the approval popup also
  // live in tabs. Dapp traffic stays exclusively on the validated Port.
  if (sender.id !== chrome.runtime.id) return
  if (!/^(chrome|moz)-extension:\/\//.test(sender.url ?? '')) return
  handle(req).then(sendResponse).catch((e: Error) => sendResponse({ ok: false, error: e.message }))
  return true // keep the channel open for the async response
})
