// Dapp bridge router (read path, protocolVersion 1 — see bdx-web3js/PROTOCOL.md).
//
// Trust model:
// - Origins are derived EXCLUSIVELY from port.sender (browser metadata), never
//   from message payloads.
// - A grant is per (origin, walletId), stored in chrome.storage.local. Wallet
//   switches never transfer access.
// - Reads require a grant AND an unlocked session; pre-connect a page learns
//   only that a provider exists (bdx_getState is coarse).
// - Keys/seed/view key never appear in any message handled here.
//
// Service-worker restarts: pending-approval METADATA survives in
// storage.session, but the live respond-callback (and the dapp's port) do not.
// If the SW dies mid-approval, the content script fails the in-flight request
// (-32603) and the page can simply call connect() again — if the user approved
// meanwhile, the persisted grant resolves it instantly with no UI.

import { CONFIG } from '../lib/config'
import * as lws from '../lib/lws'
import { resolveBnsWallet, looksLikeBnsName } from '../lib/bns'
import { sessionStore } from '../lib/sessionStore'
import {
  DappEvent, DappMethod, DappPortMessage, DappPortRequest, ERR, PORT_NAME, PROTOCOL_VERSION
} from '../lib/dappProtocol'
// Pure arithmetic (@noble), no WASM and no window — safe in the service worker.
import { addressSpendKey, verifyMessage } from '../lib/signMessage'
import type { WalletSecrets } from '../lib/messages'

// Storage keys shared with background/index.ts — keep in sync.
const WALLETS_KEY = 'wallets'
const ACTIVE_KEY = 'active_wallet_id'
const SESSION_KEY = 'session_secrets'
const CACHE_KEY = 'sync_cache'

const GRANTS_KEY = 'dapp_origins'          // storage.local
const PENDING_KEY = 'dapp_pending'         // storage.session (metadata only)
const CORRECTED_KEY = 'corrected_balance'  // storage.session, written by the panel (Dashboard)

const APPROVAL_TTL_MS = 5 * 60_000
const READS_PER_MINUTE = 10
const BALANCE_STALE_MS = 60_000
const ATOMIC = 1_000_000_000n

interface Grant { walletId: string; grantedAt: number }
type GrantMap = Record<string, Grant>

interface PendingMeta { origin: string; method: DappMethod; createdAt: number; params?: object }

interface PendingLive extends PendingMeta {
  /** The id the PAGE generated for this request. Replies must echo it: the
   *  inpage provider matches responses against its own pending map, so a reply
   *  carrying our internal approval id is silently dropped and the dapp's
   *  promise hangs forever. Not the same value as the approval reqId, which is
   *  wallet-internal and used for the approval UI / storage.session. */
  pageReqId: string
  respond: (msg: DappPortMessage) => void
  timer: ReturnType<typeof setTimeout>
  windowId?: number
}

// ---- state (service-worker lifetime) ---------------------------------------

const ports = new Map<chrome.runtime.Port, { origin: string; tabId?: number }>()
const pendingLive = new Map<string, PendingLive>()   // reqId -> live approval
const windowToReq = new Map<number, string>()
const readStamps = new Map<string, number[]>()       // origin -> request times

// ---- small wallet-store readers (same keys as background/index.ts) ---------

interface StoredWallet { name: string; address: string }

async function getWallets(): Promise<Record<string, StoredWallet>> {
  return (await chrome.storage.local.get(WALLETS_KEY))[WALLETS_KEY] ?? {}
}
async function getActiveId(): Promise<string | null> {
  const id = (await chrome.storage.local.get(ACTIVE_KEY))[ACTIVE_KEY]
  return typeof id === 'string' && id ? id : null
}
async function getSession(): Promise<{ walletId: string; secrets: WalletSecrets } | null> {
  return (await sessionStore.get(SESSION_KEY))[SESSION_KEY] ?? null
}
async function getGrants(): Promise<GrantMap> {
  return (await chrome.storage.local.get(GRANTS_KEY))[GRANTS_KEY] ?? {}
}
async function setGrants(g: GrantMap): Promise<void> {
  await chrome.storage.local.set({ [GRANTS_KEY]: g })
}

function nettype(): 'mainnet' | 'testnet' {
  return CONFIG.NETWORK
}

function err(code: number, message: string): { code: number; message: string } {
  return { code, message }
}

/** Does `origin` hold a grant for the ACTIVE wallet? Returns activeId or null. */
async function grantedActiveId(origin: string): Promise<string | null> {
  const [grants, activeId] = await Promise.all([getGrants(), getActiveId()])
  return activeId && grants[origin]?.walletId === activeId ? activeId : null
}

// ---- events ----------------------------------------------------------------

function sendToOrigin(origin: string, event: DappEvent, data?: unknown): void {
  for (const [port, meta] of ports) {
    if (meta.origin !== origin) continue
    try { port.postMessage({ event, ...(data !== undefined ? { data } : {}) }) } catch { /* dead port */ }
  }
}

/** The site in the user's ACTIVE tab (matched via its content-script port —
 *  no "tabs" permission needed since we never read the URL) and whether it
 *  holds a grant for the active wallet. Null when the tab isn't a website. */
export async function dappActiveTabSite(): Promise<{ origin: string; connected: boolean } | null> {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    const tabId = tabs[0]?.id
    if (tabId === undefined) return null
    let origin: string | null = null
    for (const meta of ports.values()) {
      if (meta.tabId === tabId) { origin = meta.origin; break }
    }
    if (!origin) return null
    return { origin, connected: !!(await grantedActiveId(origin)) }
  } catch {
    return null
  }
}

/** Push an event to every connected origin holding a grant for `walletId`
 *  (or for ANY wallet when walletId is null — used for lock/unlock). */
async function broadcast(event: DappEvent, data: unknown, walletId: string | null): Promise<void> {
  const grants = await getGrants()
  const origins = new Set(
    Object.entries(grants)
      .filter(([, g]) => walletId === null || g.walletId === walletId)
      .map(([o]) => o)
  )
  for (const origin of origins) sendToOrigin(origin, event, data)
}

// Called from background/index.ts at the relevant state transitions:

export async function dappNotifyLocked(): Promise<void> {
  await broadcast('lock', {}, null)
}

export async function dappNotifyUnlocked(address: string): Promise<void> {
  await broadcast('unlock', {}, null)
  const activeId = await getActiveId()
  if (activeId) await broadcast('connect', { address, network: nettype() }, activeId)
}

export async function dappNotifyWalletSwitched(): Promise<void> {
  // Previous grants never carry over — dapps must reconnect (spec §5).
  await broadcast('accountsChanged', { address: null }, null)
}

/** Balance delta observed by the background sync. */
export async function dappNotifyBalanceFromInfo(info: Record<string, unknown>): Promise<void> {
  const activeId = await getActiveId()
  if (!activeId) return
  const session = await getSession()
  if (!session || session.walletId !== activeId) return
  // Same corrected-overlay figures bdx_getBalance serves — never push the
  // raw naive numbers to pages if a correction exists.
  const b = await balanceForDapp(info, session.secrets.address)
  await broadcast('balanceChanged', b, activeId)
}

/** A wallet was deleted: drop its grants and tell those origins. */
export async function dappCleanupWallet(walletId: string): Promise<void> {
  const grants = await getGrants()
  let changed = false
  for (const [origin, g] of Object.entries(grants)) {
    if (g.walletId !== walletId) continue
    delete grants[origin]
    changed = true
    sendToOrigin(origin, 'disconnect', {})
  }
  if (changed) await setGrants(grants)
}

// ---- balance ---------------------------------------------------------------

const num = (v: unknown) => { try { return BigInt(String(v ?? 0)) } catch { return 0n } }

function naiveBalance(info: Record<string, unknown>): {
  total: string; unlocked: string; approximate: boolean; height: number
} {
  // NAIVE: the LWS's total_sent over-counts (any ring membership). The panel
  // corrects it with client-side key images (WASM — window contexts only), the
  // background cannot; hence approximate:true on the wire (PROTOCOL.md §4.4).
  const received = num(info.total_received)
  const sent = num(info.total_sent)
  const locked = num(info.locked_funds)
  const total = received > sent ? received - sent : 0n
  const unlocked = total > locked ? total - locked : 0n
  const height = Number(info.scanned_block_height ?? info.scanned_height ?? 0) || 0
  return { total: total.toString(), unlocked: unlocked.toString(), approximate: true, height }
}

/**
 * Best balance the background can serve: raw LWS figures adjusted by the
 * key-image correction a WASM context (panel / send-approval card) published.
 *
 * The published entry snapshots BOTH the corrected total_sent and the raw
 * total_sent it was derived from. Their difference is the decoy OVERCOUNT —
 * which only ever grows (outputs get sampled as ring decoys; they never
 * un-sample) and is unaffected by our own real spends. So even when the raw
 * figures have moved since the correction (e.g. the user just sent from a
 * dapp), `current_raw_sent − overcount` remains an accurate estimate, and the
 * balance no longer collapses to zero right after a send. `approximate` is
 * false only when the raw figures exactly match the correction snapshot.
 */
async function balanceForDapp(raw: Record<string, unknown>, address: string): Promise<{
  total: string; unlocked: string; approximate: boolean; height: number
}> {
  const corr = (await sessionStore.get(CORRECTED_KEY))[CORRECTED_KEY]
  if (!corr || corr.address !== address) return naiveBalance(raw)
  const rawSent = num(raw.total_sent)
  const rawRecv = num(raw.total_received)
  const snapSent = num(corr.total_sent_raw ?? corr.total_sent)
  const corrSent = num(corr.total_sent)
  const overcount = snapSent > corrSent ? snapSent - corrSent : 0n
  const adjSent = rawSent > overcount ? rawSent - overcount : 0n
  const locked = num(raw.locked_funds)
  const total = rawRecv > adjSent ? rawRecv - adjSent : 0n
  const unlocked = total > locked ? total - locked : 0n
  const height = Number(raw.scanned_block_height ?? raw.scanned_height ?? 0) || 0
  const exact = rawSent === snapSent && rawRecv === num(corr.total_received)
  return { total: total.toString(), unlocked: unlocked.toString(), approximate: !exact, height }
}

async function readBalance(): Promise<Record<string, unknown>> {
  const session = await getSession()
  if (!session) throw err(ERR.LOCKED, 'wallet locked')
  const cached = (await sessionStore.get(CACHE_KEY))[CACHE_KEY]
  if (cached?.info && cached.address === session.secrets.address && Date.now() - (cached.at ?? 0) < BALANCE_STALE_MS) {
    return cached.info
  }
  const info = await lws.getAddressInfo({ address: session.secrets.address, view_key: session.secrets.secViewKey })
  await sessionStore.set({ [CACHE_KEY]: { info, at: Date.now(), address: session.secrets.address } })
  return info
}

// ---- send transaction validation + lock ------------------------------------

const U64_MAX = 18_446_744_073_709_551_615n
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/

/** Format-only address check (prefix/alphabet/length). The WASM fully
 *  re-validates (checksum, network) before signing — this is the cheap gate. */
function addressShapeOk(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const a = s.trim()
  if (!a.startsWith('bx') || !BASE58_RE.test(a)) return false
  return (a.length >= 95 && a.length <= 99) || (a.length >= 104 && a.length <= 110)
}

export interface ValidatedSend {
  to: string
  /** integer string of atomic units; absent when sweeping */
  amount?: string
  priority: 1 | 2 | 3 | 4 | 5
  sweep: boolean
}

/** Validate bdx_sendTransaction params per PROTOCOL.md §4.5. Returns the
 *  normalized params or an error message naming the offending field. */
export function validateSendParams(params: unknown): { ok: true; send: ValidatedSend } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  if (!addressShapeOk(p.to)) return { ok: false, error: 'invalid field "to" (BNS names must be resolved first)' }
  const sweep = p.sweep === true
  if (sweep && p.amount !== undefined) return { ok: false, error: '"sweep" and "amount" are mutually exclusive' }
  let amount: string | undefined
  if (!sweep) {
    if (typeof p.amount !== 'string' || !/^\d+$/.test(p.amount)) {
      return { ok: false, error: 'invalid field "amount" (integer string of atomic units required)' }
    }
    const v = BigInt(p.amount)
    if (v <= 0n || v > U64_MAX) return { ok: false, error: 'invalid field "amount" (out of range)' }
    amount = v.toString()
  }
  let priority: ValidatedSend['priority'] = 1
  if (p.priority !== undefined) {
    if (typeof p.priority !== 'number' || ![1, 2, 3, 4, 5].includes(p.priority)) {
      return { ok: false, error: 'invalid field "priority" (1–5)' }
    }
    priority = p.priority as ValidatedSend['priority']
  }
  if (p.paymentId !== undefined) {
    // v1 deviation from PROTOCOL.md §4.5, deliberately: the send bridge's
    // manual-payment-ID path is untested here. Integrated addresses carry the
    // payment ID safely.
    return { ok: false, error: 'field "paymentId" not supported — use an integrated address' }
  }
  return { ok: true, send: { to: (p.to as string).trim(), priority, sweep, ...(amount !== undefined ? { amount } : {}) } }
}

/** Longest message a site may ask the user to sign. Long enough for an
 *  ownership challenge or a login statement, short enough that the approval
 *  card can show ALL of it — the user must never approve text they cannot see. */
const MAX_SIGN_MESSAGE = 512

/** Validate bdx_signMessage params (PROTOCOL.md §4.6). Control characters are
 *  rejected so a message cannot hide its real content behind newlines or
 *  terminal escapes in the approval card. */
export function validateSignParams(params: unknown): { ok: true; message: string } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  if (typeof p.message !== 'string' || p.message.length === 0) {
    return { ok: false, error: 'invalid field "message" (non-empty string required)' }
  }
  if (p.message.length > MAX_SIGN_MESSAGE) {
    return { ok: false, error: `invalid field "message" (max ${MAX_SIGN_MESSAGE} characters)` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p.message)) {
    return { ok: false, error: 'invalid field "message" (control characters are not allowed)' }
  }
  return { ok: true, message: p.message }
}

// One in-flight send per wallet, shared by the panel's own send flow and dapp
// sends (two concurrent constructions could pick the same outputs → double
// spend). Held in storage.session with a stale-out so a crashed signer can't
// wedge the wallet.

const SEND_LOCK_KEY = 'send_lock'
const SEND_LOCK_STALE_MS = 3 * 60_000

export async function sendLockHeld(): Promise<boolean> {
  const l = (await sessionStore.get(SEND_LOCK_KEY))[SEND_LOCK_KEY]
  return !!l && Date.now() - (l.at ?? 0) < SEND_LOCK_STALE_MS
}

export async function dappSendLockAcquire(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (await sendLockHeld()) return { ok: false, error: 'A transaction is already in progress' }
  await sessionStore.set({ [SEND_LOCK_KEY]: { at: Date.now() } })
  return { ok: true }
}

export async function dappSendLockRelease(): Promise<{ ok: true }> {
  await sessionStore.remove(SEND_LOCK_KEY)
  return { ok: true }
}

// ---- rate limiting ---------------------------------------------------------

function readAllowed(origin: string): boolean {
  const now = Date.now()
  const stamps = (readStamps.get(origin) ?? []).filter(t => now - t < 60_000)
  if (stamps.length >= READS_PER_MINUTE) { readStamps.set(origin, stamps); return false }
  stamps.push(now)
  readStamps.set(origin, stamps)
  return true
}

// ---- pending approvals ------------------------------------------------------

async function persistPending(reqId: string, meta: PendingMeta): Promise<void> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  all[reqId] = meta
  await sessionStore.set({ [PENDING_KEY]: all })
}

async function removePending(reqId: string): Promise<PendingMeta | null> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  const meta = all[reqId] ?? null
  if (meta) {
    delete all[reqId]
    await sessionStore.set({ [PENDING_KEY]: all })
  }
  const live = pendingLive.get(reqId)
  if (live) {
    clearTimeout(live.timer)
    if (live.windowId !== undefined) windowToReq.delete(live.windowId)
    pendingLive.delete(reqId)
  }
  return meta
}

function settlePending(reqId: string, msg: { result?: unknown; error?: { code: number; message: string } }): void {
  const live = pendingLive.get(reqId)
  if (live) {
    // Echo the PAGE's request id, never the internal approval id.
    try { live.respond({ id: live.pageReqId, ...msg }) } catch { /* port gone */ }
  }
}

/** Tell any open panel/approval page that the pending queue changed. */
function notifyPanels(): void {
  chrome.runtime.sendMessage({ type: 'DAPP_PENDING_CHANGED' }).catch(() => {
    /* no extension page open to hear it — fine */
  })
}

const anyChrome = chrome as any

async function panelIsOpen(): Promise<boolean> {
  try {
    if (anyChrome.sidebarAction?.isOpen) {
      return await anyChrome.sidebarAction.isOpen({}) // Firefox
    }
    if (chrome.runtime.getContexts) {
      const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as any] })
      return ctxs.length > 0 // Chrome 116+
    }
  } catch { /* fall through */ }
  return false
}

/** Methods that can end up needing an approval UI. */
const APPROVAL_METHODS = new Set<DappMethod>(['bdx_connect', 'bdx_sendTransaction', 'bdx_signMessage'])

/**
 * Start opening the side panel — call this SYNCHRONOUSLY, with no `await`
 * anywhere between the triggering port message and this call, or Chrome
 * silently drops the request ("may only be called in response to a user
 * gesture"). We don't yet know whether the request will actually need an
 * approval UI (e.g. bdx_connect might be pre-granted) — by the time the
 * async grant/lock checks in handleMethod finish, the gesture window is
 * long gone, so we speculatively fire this immediately for every
 * APPROVAL_METHODS call and only look at the result once we know an
 * approval UI is actually needed. Worst case for a pre-granted reconnect:
 * the panel opens showing the wallet with nothing pending — harmless.
 */
function trySidePanelOpen(tabId: number): Promise<boolean> {
  if (anyChrome.sidePanel?.open) {
    return anyChrome.sidePanel.open({ tabId }).then(() => true).catch(() => false)
  }
  if (anyChrome.sidebarAction?.open) { // Firefox
    return anyChrome.sidebarAction.open().then(() => true).catch(() => false)
  }
  return Promise.resolve(false)
}

/**
 * Surface an approval request to the user. Preferred: inside the wallet's
 * side panel (panel shows the request via DAPP_LIST_PENDING) — `panelOpenAttempt`
 * is the (already in-flight) result of trySidePanelOpen, started synchronously
 * back when the port message first arrived; we just await it here. If that
 * didn't get the panel open (no permission, unsupported browser, or the
 * gesture didn't carry through), fall back to a standalone popup window so
 * the request still has *some* surface instead of failing outright.
 *
 * @returns true if the request is now visible somewhere the user will see it.
 */
async function openApproval(reqId: string, panelOpenAttempt: Promise<boolean> | null): Promise<boolean> {
  if (await panelIsOpen()) { notifyPanels(); return true }
  if (panelOpenAttempt && await panelOpenAttempt) { notifyPanels(); return true }

  // Anchor the popup to the TOP-RIGHT of the user's browser window (like
  // MetaMask) — computed from the focused window's geometry, no extra
  // permissions needed. Falls back to the browser's default placement.
  const WIDTH = 400
  const HEIGHT = 640
  let position: { left: number; top: number } | undefined
  try {
    const focused = await chrome.windows.getLastFocused()
    if (typeof focused.left === 'number' && typeof focused.width === 'number') {
      position = {
        left: Math.max(0, focused.left + focused.width - WIDTH - 16),
        top: Math.max(0, (focused.top ?? 0) + 80)
      }
    }
  } catch { /* default placement */ }

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`approval.html?reqId=${encodeURIComponent(reqId)}`),
      type: 'popup', width: WIDTH, height: HEIGHT, focused: true, ...position
    })
    const live = pendingLive.get(reqId)
    if (live && win.id !== undefined) {
      live.windowId = win.id
      windowToReq.set(win.id, reqId)
    }
    return true
  } catch {
    return false
  }
}

// ---- method handlers --------------------------------------------------------

async function handleMethod(
  origin: string,
  req: DappPortRequest,
  respond: (msg: DappPortMessage) => void,
  panelOpenAttempt: Promise<boolean> | null = null
): Promise<void> {
  const reply = (result: unknown) => respond({ id: req.id, result })
  const fail = (e: { code: number; message: string }) => respond({ id: req.id, error: e })

  switch (req.method) {
    case 'bdx_getState': {
      const wallets = await getWallets()
      if (Object.keys(wallets).length === 0) return reply({ state: 'no-wallet' })
      const session = await getSession()
      const activeId = await getActiveId()
      return reply({ state: session && session.walletId === activeId ? 'unlocked' : 'locked' })
    }

    case 'bdx_getNetwork': {
      const cached = (await sessionStore.get(CACHE_KEY))[CACHE_KEY]
      const height = Number(cached?.info?.blockchain_height ?? cached?.info?.scanned_block_height ?? 0) || 0
      return reply({
        nettype: nettype(), height,
        protocolVersion: PROTOCOL_VERSION,
        walletVersion: chrome.runtime.getManifest().version
      })
    }

    case 'bdx_resolveBns': {
      const name = (req.params as { name?: unknown } | undefined)?.name
      if (typeof name !== 'string' || !looksLikeBnsName(name)) {
        return fail(err(ERR.INVALID_PARAMS, 'invalid field "name"'))
      }
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      try {
        const wallet = await resolveBnsWallet(name)
        if (!wallet) return fail(err(ERR.INTERNAL, 'name not registered'))
        return reply({ name: name.trim().toLowerCase(), address: wallet, verified: false })
      } catch {
        return fail(err(ERR.INTERNAL, 'resolution failed')) // sanitized (spec §6)
      }
    }

    case 'bdx_getAddress':
    case 'bdx_getBalance': {
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      const session = await getSession()
      if (!session || session.walletId !== activeId) return fail(err(ERR.LOCKED, 'wallet locked'))
      if (req.method === 'bdx_getAddress') return reply({ address: session.secrets.address })
      try {
        const raw = await readBalance()
        return reply(await balanceForDapp(raw, session.secrets.address))
      } catch (e) {
        const known = e as { code?: number; message?: string }
        if (typeof known?.code === 'number') return fail(err(known.code, known.message ?? 'error'))
        return fail(err(ERR.INTERNAL, 'balance unavailable')) // sanitized
      }
    }

    case 'bdx_disconnect': {
      const grants = await getGrants()
      if (grants[origin]) {
        delete grants[origin]
        await setGrants(grants)
        sendToOrigin(origin, 'disconnect', {})
      }
      return reply({})
    }

    case 'bdx_connect': {
      const wallets = await getWallets()
      const activeId = await getActiveId()
      if (!activeId || Object.keys(wallets).length === 0) {
        return fail(err(ERR.NO_WALLET, 'no wallet created'))
      }
      // Idempotent once granted (spec §4.1) — even while locked this reveals
      // nothing new to an origin the user already approved for this wallet.
      if (await grantedActiveId(origin)) {
        return reply({ address: wallets[activeId].address, network: nettype() })
      }
      // One pending approval per origin (spec §7.4).
      for (const p of pendingLive.values()) {
        if (p.origin === origin) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      await queueApproval(origin, req.method, undefined, req.id, respond, panelOpenAttempt)
      return // settled later by DAPP_APPROVE / DAPP_REJECT / window close / TTL
    }

    case 'bdx_sendTransaction': {
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      const v = validateSendParams(req.params)
      if (!v.ok) return fail(err(ERR.INVALID_PARAMS, v.error))
      // Global single-flight: one send at a time across dapp + panel flows.
      if (await sendLockHeld()) return fail(err(ERR.INTERNAL, 'transaction already in progress'))
      for (const p of pendingLive.values()) {
        if (p.method === 'bdx_sendTransaction') return fail(err(ERR.INTERNAL, 'transaction already in progress'))
        if (p.origin === origin) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      await queueApproval(origin, req.method, v.send as unknown as object, req.id, respond, panelOpenAttempt)
      return // settled by DAPP_COMPLETE / DAPP_FAIL / DAPP_REJECT / close / TTL
    }

    case 'bdx_signMessage': {
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      const v = validateSignParams(req.params)
      if (!v.ok) return fail(err(ERR.INVALID_PARAMS, v.error))
      const session = await getSession()
      if (!session || session.walletId !== activeId) return fail(err(ERR.LOCKED, 'wallet locked'))
      for (const p of pendingLive.values()) {
        if (p.origin === origin) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      await queueApproval(origin, req.method, { message: v.message }, req.id, respond, panelOpenAttempt)
      return // settled by DAPP_SIGN_COMPLETE / DAPP_FAIL / DAPP_REJECT / close / TTL
    }

    case 'bdx_verifyMessage': {
      // Public and keyless (spec §4.7): pure signature arithmetic, no grant,
      // no approval, nothing about this wallet is revealed.
      const p = (req.params ?? {}) as { message?: unknown; address?: unknown; signature?: unknown }
      if (typeof p.message !== 'string' || !p.message
        || typeof p.address !== 'string' || typeof p.signature !== 'string') {
        return fail(err(ERR.INVALID_PARAMS, 'message, address and signature are required'))
      }
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      const spend = addressSpendKey(p.address)
      if (!spend) return fail(err(ERR.INVALID_PARAMS, 'invalid field "address"'))
      try {
        return reply({ valid: verifyMessage(p.message, spend, p.signature) })
      } catch {
        return reply({ valid: false })
      }
    }

    default:
      return fail(err(ERR.METHOD_NOT_FOUND, `unsupported method in this wallet version: ${req.method}`))
  }
}

async function queueApproval(
  origin: string,
  method: DappMethod,
  params: object | undefined,
  pageReqId: string,
  respond: (msg: DappPortMessage) => void,
  panelOpenAttempt: Promise<boolean> | null
): Promise<void> {
  const reqId = crypto.randomUUID()
  const meta: PendingMeta = {
    origin, method, createdAt: Date.now(), ...(params !== undefined ? { params } : {})
  }
  const timer = setTimeout(async () => {
    settlePending(reqId, { error: err(ERR.EXPIRED, 'approval expired') })
    const live = pendingLive.get(reqId)
    await removePending(reqId)
    if (live?.windowId !== undefined) chrome.windows.remove(live.windowId).catch(() => {})
    notifyPanels()
  }, APPROVAL_TTL_MS)
  pendingLive.set(reqId, { ...meta, pageReqId, respond, timer })
  await persistPending(reqId, meta)

  const shown = await openApproval(reqId, panelOpenAttempt)
  if (!shown) {
    settlePending(reqId, {
      error: err(ERR.PANEL_CLOSED, 'Open the Beldex Wallet extension (click its icon in your browser toolbar), then try again.')
    })
    await removePending(reqId)
  }
}

// ---- internal messages from the approval UI / Settings ----------------------
// (called from background/index.ts's message switch — sender is our own
// extension, already verified there)

/** Oldest live approval request — what an open side panel should display.
 *  Also prunes expired entries. */
export async function dappFirstPending(): Promise<
  { reqId: string; origin: string; method: string; params?: object } | null
> {
  const all: Record<string, PendingMeta> = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  let best: { reqId: string; meta: PendingMeta } | null = null
  for (const [reqId, meta] of Object.entries(all)) {
    if (Date.now() - meta.createdAt > APPROVAL_TTL_MS) { await removePending(reqId); continue }
    if (!best || meta.createdAt < best.meta.createdAt) best = { reqId, meta }
  }
  if (!best) return null
  return {
    reqId: best.reqId, origin: best.meta.origin, method: best.meta.method,
    ...(best.meta.params !== undefined ? { params: best.meta.params } : {})
  }
}

export async function dappGetPending(reqId: string): Promise<
  { ok: true; pending: { origin: string; method: string; params?: object } } | { ok: false; error: string }
> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  const meta: PendingMeta | undefined = all[reqId]
  if (!meta || Date.now() - meta.createdAt > APPROVAL_TTL_MS) {
    return { ok: false, error: 'This request has expired — retry from the site.' }
  }
  return {
    ok: true,
    pending: {
      origin: meta.origin, method: meta.method,
      ...(meta.params !== undefined ? { params: meta.params } : {})
    }
  }
}

export async function dappApprove(reqId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  const meta: PendingMeta | undefined = all[reqId]
  if (!meta) return { ok: false, error: 'Request no longer pending' }
  if (Date.now() - meta.createdAt > APPROVAL_TTL_MS) {
    settlePending(reqId, { error: err(ERR.EXPIRED, 'approval expired') })
    await removePending(reqId)
    return { ok: false, error: 'This request has expired — retry from the site.' }
  }
  const session = await getSession()
  const activeId = await getActiveId()
  if (!session || !activeId || session.walletId !== activeId) {
    return { ok: false, error: 'Unlock the wallet first' }
  }
  const grants = await getGrants()
  grants[meta.origin] = { walletId: activeId, grantedAt: Date.now() }
  await setGrants(grants)
  const result = { address: session.secrets.address, network: nettype() }
  settlePending(reqId, { result })
  await removePending(reqId)
  sendToOrigin(meta.origin, 'connect', result)
  notifyPanels()
  return { ok: true }
}

export async function dappReject(reqId: string): Promise<{ ok: true }> {
  settlePending(reqId, { error: err(ERR.USER_REJECTED, 'user rejected') })
  await removePending(reqId)
  notifyPanels()
  return { ok: true }
}

/** Send flow finished in the approval surface (panel/popup): deliver the
 *  result to the waiting dapp. */
export async function dappComplete(
  reqId: string, result: { txHash: string; fee: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  if (!all[reqId]) return { ok: false, error: 'Request no longer pending' }
  settlePending(reqId, { result: { txHash: String(result.txHash), fee: String(result.fee ?? '0') } })
  await removePending(reqId)
  notifyPanels()
  return { ok: true }
}

/** Message signed in the approval surface: hand the signature to the dapp.
 *  The panel does the signing because the spend key lives in the session there,
 *  never in this worker. */
export async function dappSignComplete(
  reqId: string, result: { signature: string; address: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  if (!all[reqId]) return { ok: false, error: 'Request no longer pending' }
  settlePending(reqId, {
    result: { signature: String(result.signature), address: String(result.address) }
  })
  await removePending(reqId)
  notifyPanels()
  return { ok: true }
}

/** Send flow failed. The wire error is SANITIZED (spec §6) — the detailed
 *  reason stays in the wallet UI, never goes to the page. */
export async function dappFail(reqId: string): Promise<{ ok: true }> {
  settlePending(reqId, { error: err(ERR.INTERNAL, 'transaction failed') })
  await removePending(reqId)
  notifyPanels()
  return { ok: true }
}

export async function dappListOrigins(): Promise<Array<{ origin: string; grantedAt: number }>> {
  const [grants, activeId] = await Promise.all([getGrants(), getActiveId()])
  return Object.entries(grants)
    .filter(([, g]) => g.walletId === activeId)
    .map(([origin, g]) => ({ origin, grantedAt: g.grantedAt }))
    .sort((a, b) => b.grantedAt - a.grantedAt)
}

export async function dappRevokeOrigin(origin: string): Promise<{ ok: true }> {
  const grants = await getGrants()
  if (grants[origin]) {
    delete grants[origin]
    await setGrants(grants)
    sendToOrigin(origin, 'disconnect', {})
  }
  return { ok: true }
}

// ---- wiring -----------------------------------------------------------------

export function initDappBridge(): void {
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PORT_NAME) return
    // Origin comes from the browser, never from the page (spec §7.8).
    const origin =
      port.sender?.origin ??
      (port.sender?.url ? safeOrigin(port.sender.url) : null)
    if (!origin || origin === 'null') { port.disconnect(); return }
    const tabId = port.sender?.tab?.id
    ports.set(port, { origin, ...(tabId !== undefined ? { tabId } : {}) })
    port.onDisconnect.addListener(() => ports.delete(port))
    port.onMessage.addListener((raw: unknown) => {
      // The content script already validated shape, but it is less trusted
      // than this process — validate again.
      const req = validatePortRequest(raw)
      if (!req) return

      // Must happen in this same synchronous tick — see trySidePanelOpen's
      // doc comment. Any `await` before this line and Chrome drops the gesture.
      const panelOpenAttempt = APPROVAL_METHODS.has(req.method) && tabId !== undefined
        ? trySidePanelOpen(tabId)
        : null

      const respond = (msg: DappPortMessage) => { try { port.postMessage(msg) } catch { /* gone */ } }
      handleMethod(origin, req, respond, panelOpenAttempt).catch(() =>
        respond({ id: req.id, error: err(ERR.INTERNAL, 'internal error') })
      )
    })
  })

  // Approval popup window closed without a decision = user rejection (spec §7.4).
  chrome.windows.onRemoved.addListener(windowId => {
    const reqId = windowToReq.get(windowId)
    if (!reqId) return
    settlePending(reqId, { error: err(ERR.USER_REJECTED, 'user rejected') })
    removePending(reqId)
  })
}

function safeOrigin(url: string): string | null {
  try { return new URL(url).origin } catch { return null }
}

function validatePortRequest(raw: unknown): DappPortRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 128) return null
  if (typeof m.method !== 'string') return null
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) return null
  const req: DappPortRequest = { id: m.id, method: m.method as DappMethod }
  if (m.params !== undefined) req.params = m.params as object
  return req
}
