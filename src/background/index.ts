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
import { CONFIG } from '../lib/config'
import * as lws from '../lib/lws'
import type { BgRequest, BgResponse, WalletMeta, WalletSecrets, WalletState } from '../lib/messages'
import { wireToolbarOpensPanel } from '../lib/platform'
import { sessionStore } from '../lib/sessionStore'
import {
  initDappBridge, dappGetPending, dappFirstPending, dappApprove, dappReject,
  dappBeginSend, dappComplete, dappSignComplete, dappFail, dappSendLockAcquire, dappSendLockRelease,
  dappListOrigins, dappRevokeOrigin, dappActiveTabSite, dappNotifyLocked, dappNotifyUnlocked,
  dappNotifyWalletSwitched, dappNotifyBalanceFromInfo, dappCleanupWallet,
  dappInvalidateOnSessionEnd, dappInvalidateForWallet, dappAuthSignComplete
} from './dapp'

// Open the panel when the toolbar icon is clicked (Chrome side panel / Firefox sidebar).
wireToolbarOpensPanel()

// Dapp bridge: ports from content scripts + approval-window plumbing.
initDappBridge()

const LEGACY_VAULT_KEY = 'beldex_vault'
const WALLETS_KEY = 'wallets'
const ACTIVE_KEY = 'active_wallet_id'
const SESSION_KEY = 'session_secrets'
const CACHE_KEY = 'sync_cache'
const ALARM_LOCK = 'auto_lock'
const ALARM_SYNC = 'bg_sync'
const ATOMIC = 1e9

interface StoredWallet { name: string; address: string; vault: Vault }
type WalletMap = Record<string, StoredWallet>

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

async function getActiveId(): Promise<string | null> {
  const wallets = await getWallets()
  const ids = Object.keys(wallets)
  if (ids.length === 0) return null
  const o = await chrome.storage.local.get(ACTIVE_KEY)
  const id = o[ACTIVE_KEY]
  if (id && wallets[id]) return id
  await chrome.storage.local.set({ [ACTIVE_KEY]: ids[0] })
  return ids[0]
}

async function walletList(): Promise<WalletMeta[]> {
  const wallets = await getWallets()
  const active = await getActiveId()
  return Object.entries(wallets).map(([id, w]) => ({
    id, name: w.name, address: w.address, active: id === active
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

async function startSession(walletId: string, secrets: WalletSecrets): Promise<void> {
  // Least privilege (audit L4): the session never holds the mnemonic or raw
  // seed — no runtime consumer needs them (sends/key-images use the sec keys;
  // Settings' reveal flows re-decrypt the vault via REVEAL). Keeps the most
  // catastrophic secrets out of every GET_SECRETS round-trip and JS context.
  const sessionSecrets: WalletSecrets = { ...secrets, mnemonic: '', seed: '' }
  await sessionStore.set({ [SESSION_KEY]: { walletId, generation: crypto.randomUUID(), secrets: sessionSecrets } })
  await touchAutoLock()
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: 0.5, delayInMinutes: 0 })
  // walletId passed EXPLICITLY (external audit): this runs detached, and the
  // active id may have changed by the time it executes — the notification
  // must describe the wallet that actually unlocked.
  dappNotifyUnlocked(walletId, secrets.address).catch(() => {})
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
  const wallets = await walletList()
  const session = await getSession()
  const activeId = await getActiveId()
  const active = wallets.find(w => w.active)
  let state: WalletState = 'uninitialized'
  if (session && session.walletId === activeId) state = 'unlocked'
  else if (wallets.length > 0) state = 'locked'
  return {
    ok: true,
    state,
    address: state === 'unlocked' ? session!.secrets.address : undefined,
    walletName: active?.name,
    wallets
  }
}

async function handle(req: BgRequest): Promise<BgResponse> {
  switch (req.type) {
    case 'GET_STATE':
      return stateResponse()

    case 'SAVE_WALLET': {
      const wallets = await getWallets()
      // Reject a restore/create of an address already present, so re-importing the
      // same seed doesn't create duplicate entries (App.tsx keys wallets by address).
      if (Object.values(wallets).some(w => w.address && w.address === req.secrets.address)) {
        return { ok: false, error: 'This wallet is already imported' }
      }
      const vault = await encryptVault(JSON.stringify(req.secrets), req.password)
      const id = crypto.randomUUID()
      const name = req.name?.trim() || `Wallet ${Object.keys(wallets).length + 1}`
      wallets[id] = { name, address: req.secrets.address, vault }
      await setWallets(wallets)
      await chrome.storage.local.set({ [ACTIVE_KEY]: id })
      await endSession() // drop any previous wallet's session/cache
      await dappInvalidateForWallet(id) // approvals for other wallets are void
      await startSession(id, req.secrets)
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
        if (!wallets[activeId].address && secrets.address) {
          wallets[activeId].address = secrets.address // backfill migrated wallet
          await setWallets(wallets)
        }
        await backoffReset(activeId)
        // TOCTOU re-check (external audit): decryption is slow (PBKDF2-600k)
        // and a concurrent SWITCH_WALLET may have changed the active id —
        // starting this session anyway would leave session.walletId pointing
        // at a wallet that is no longer active, and GET_SECRETS would serve it.
        if (await getActiveId() !== activeId) {
          return { ok: false, error: 'Wallet switched during unlock — try again' }
        }
        await startSession(activeId, secrets)
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
      const wallets = await getWallets()
      if (!wallets[req.id]) return { ok: false, error: 'Unknown wallet' }
      const activeId = await getActiveId()
      if (req.id !== activeId) {
        await endSession() // switching requires the target wallet's password
        await chrome.storage.local.set({ [ACTIVE_KEY]: req.id })
        // Approvals queued for the previous wallet are void (external audit) —
        // approving them now would bind a different wallet than displayed.
        await dappInvalidateForWallet(req.id)
        dappNotifyWalletSwitched().catch(() => {}) // grants never carry over
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
