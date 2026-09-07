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
  DappEvent, DappMethod, DappPortMessage, DappPortRequest, ERR, PORT_NAME, PROTOCOL_VERSION,
  validatePortMessage
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
const OPS_KEY = 'dapp_operations'          // storage.session: send operation state machine

const APPROVAL_TTL_MS = 5 * 60_000
const OPERATION_TTL_MS = 24 * 3600_000     // keep send outcomes queryable for a day
const READS_PER_MINUTE = 10
const BALANCE_STALE_MS = 60_000
const ATOMIC = 1_000_000_000n

// ---- send operation state machine (external audit) --------------------------
//
// A send is irreversible, so its execution must NOT be terminated by an
// approval-timeout / lost-channel path once it has started broadcasting, and
// its outcome must be persisted BEFORE any reply so the dapp can recover it
// after a timeout or service-worker restart. States:
//
//   (approved) --beginSend--> executing --recordBroadcast--> confirmed
//                                        \--recordFailed---> failed
//
// The PENDING->executing transition (dappBeginSend) is atomic: it verifies the
// wallet/session binding, cancels the review TTL timer, drops the persisted
// pending metadata (so nothing can later expire it), mints an unguessable
// execution token, and records the operation. dappComplete/dappFail then
// require that token and persist the outcome first. bdx_getOperationStatus and
// an optional dapp-supplied idempotencyKey give the dapp a safe recovery /
// replay path instead of the "4999 is safe to retry" duplicate-payment trap.

type OperationState = 'executing' | 'confirmed' | 'failed'

interface OperationRecord {
  operationId: string
  executionToken: string
  origin: string
  walletId: string
  idempotencyKey?: string
  state: OperationState
  txHash?: string
  fee?: string
  createdAt: number
  updatedAt: number
}

type OperationMap = Record<string, OperationRecord>

async function getOperations(): Promise<OperationMap> {
  const all: OperationMap = (await sessionStore.get(OPS_KEY))[OPS_KEY] ?? {}
  return all
}

/** Load operations, dropping any past their TTL. Persists the pruned map only
 *  when something was actually removed. */
async function liveOperations(): Promise<OperationMap> {
  const all = await getOperations()
  const now = Date.now()
  let pruned = false
  for (const [id, op] of Object.entries(all)) {
    if (now - op.createdAt > OPERATION_TTL_MS) { delete all[id]; pruned = true }
  }
  if (pruned) await sessionStore.set({ [OPS_KEY]: all })
  return all
}

async function putOperation(op: OperationRecord): Promise<void> {
  const all = await getOperations()
  all[op.operationId] = op
  await sessionStore.set({ [OPS_KEY]: all })
}

/** The origin's operation for a given idempotency key, if any (TTL-pruned). */
async function findOperationByKey(origin: string, key: string): Promise<OperationRecord | null> {
  const all = await liveOperations()
  for (const op of Object.values(all)) {
    if (op.origin === origin && op.idempotencyKey === key) return op
  }
  return null
}

interface Grant { walletId: string; grantedAt: number }
type GrantMap = Record<string, Grant>

interface PendingMeta {
  origin: string
  method: DappMethod
  createdAt: number
  params?: object
  /** IMMUTABLE approval context (external audit): the wallet that was active —
   *  and whose identity the approval surface displays — when this request was
   *  queued. Grant creation / signing / tx construction must still match it. */
  walletId: string
  /** Session generation at queue time. Null when no session existed (a request
   *  queued while locked, reviewed after the unlock the approval surface
   *  itself performs); the walletId binding still applies. */
  sessionGeneration: string | null
}

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
  /** The content-script port that carried this request. Used to reject a
   *  still-PENDING send/sign approval when its page's channel dies (external
   *  audit: those must not stay actionable after a lost live channel; connect
   *  survives, being recoverable via the persisted grant). */
  owner?: chrome.runtime.Port
  /** Set once dappBeginSend transitions this send to EXECUTING. From then on
   *  the review timer is cancelled and neither TTL nor channel-loss may fail
   *  it — the outcome is owned by the operation record. */
  executing?: boolean
  executionToken?: string
  operationId?: string
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
async function getSession(): Promise<{ walletId: string; generation: string; secrets: WalletSecrets } | null> {
  return (await sessionStore.get(SESSION_KEY))[SESSION_KEY] ?? null
}
async function getGrants(): Promise<GrantMap> {
  return (await chrome.storage.local.get(GRANTS_KEY))[GRANTS_KEY] ?? {}
}
async function setGrants(g: GrantMap): Promise<void> {
  await chrome.storage.local.set({ [GRANTS_KEY]: g })
}

// ---- serialization (external audit) ----------------------------------------
//
// JavaScript is single-threaded but NOT atomic across `await`: the service
// worker can dispatch another Port/runtime message while a handler is suspended
// mid check-then-write. chrome.storage offers no compare-and-set, so two
// interleaved handlers could both pass a "not held / no conflict" check, or a
// whole-map grant write derived from a stale snapshot could clobber a
// concurrent one (lost revocation / resurrected origin). These named mutexes
// serialize each critical section within this worker; persisted state + owner
// tokens (below) handle cross-restart cases.
const mutexTails = new Map<string, Promise<unknown>>()
function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexTails.get(name) ?? Promise.resolve()
  // Run fn after prev settles, regardless of whether prev resolved or rejected.
  const run = prev.then(fn, fn)
  // The stored tail never rejects, so one failing section can't wedge the queue.
  mutexTails.set(name, run.then(() => {}, () => {}))
  return run
}

/** Serialized read-modify-write of the grant map (external audit): all grant
 *  mutations must go through here so a concurrent revoke/approve/cleanup can't
 *  lose an update or resurrect a removed origin. `mutate` edits the map in
 *  place and returns whether anything changed. */
async function updateGrants(mutate: (g: GrantMap) => boolean): Promise<void> {
  await withLock('grants', async () => {
    const g = await getGrants()
    if (mutate(g)) await setGrants(g)
  })
}

function nettype(): 'mainnet' | 'testnet' {
  return CONFIG.NETWORK
}

function err(code: number, message: string): { code: number; message: string } {
  return { code, message }
}

/** Plain-http origins (except loopback, kept for dapp development)
 *  can be impersonated by an active network attacker, which would defeat the
 *  origin-based grant model. content_scripts.matches already excludes them;
 *  this is defense in depth so a manifest drift can never re-enable granting
 *  an impersonatable origin. */
export function insecureOrigin(origin: string): boolean {
  if (!origin.startsWith('http://')) return false
  let host: string
  try { host = new URL(origin).hostname } catch { return true }
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1'
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
 *  (or for ANY wallet when walletId is null — used only for accountsChanged
 *  on wallet switch, where every grantee must learn it lost its connection;
 *  lock/unlock are scoped per-wallet). */
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

// Lock/unlock take the wallet id EXPLICITLY from the session that actually
// locked/unlocked (external audit): these run detached from startSession/
// endSession, and re-reading the active id here could pair one wallet's
// address or event with another wallet's grantee set after a rapid switch.
// They stay scoped per-wallet: a site granted only for another wallet must
// not observe this wallet's lock/unlock activity.

export async function dappNotifyLocked(walletId: string): Promise<void> {
  await broadcast('lock', {}, walletId)
}

export async function dappNotifyUnlocked(walletId: string, address: string): Promise<void> {
  await broadcast('unlock', {}, walletId)
  await broadcast('connect', { address, network: nettype() }, walletId)
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

/** A wallet was deleted: drop its grants, void its approvals, tell those origins. */
export async function dappCleanupWallet(walletId: string): Promise<void> {
  await rejectPendingWhere(m => m.walletId === walletId, 'wallet removed — request cancelled')
  const dropped: string[] = []
  await updateGrants(g => {
    for (const [origin, grant] of Object.entries(g)) {
      if (grant.walletId !== walletId) continue
      delete g[origin]; dropped.push(origin)
    }
    return dropped.length > 0
  })
  for (const origin of dropped) sendToOrigin(origin, 'disconnect', {})
}

// ---- pending-approval invalidation (external audit: immutable context) ------

/** Reject + remove every pending approval (live AND persisted) matching pred. */
async function rejectPendingWhere(pred: (m: PendingMeta) => boolean, message: string): Promise<void> {
  const all: Record<string, PendingMeta> = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  let any = false
  for (const [reqId, meta] of Object.entries(all)) {
    if (!pred(meta)) continue
    settlePending(reqId, { error: err(ERR.EXPIRED, message) })
    const live = pendingLive.get(reqId)
    if (live?.windowId !== undefined) chrome.windows.remove(live.windowId).catch(() => {})
    await removePending(reqId)
    any = true
  }
  if (any) notifyPanels()
}

/** Session ended (lock, wipe, or replacement): send/sign approvals were
 *  reviewed against that session's identity and must be re-requested.
 *  Connect approvals survive — unlock-then-approve is a supported flow —
 *  but remain bound to their recorded walletId. */
export async function dappInvalidateOnSessionEnd(): Promise<void> {
  await rejectPendingWhere(m => m.method !== 'bdx_connect', 'wallet locked — request cancelled')
}

/** The active wallet changed: every approval queued for another wallet is
 *  void. Approving it would pair the displayed identity (and the origin's
 *  grant) with a different wallet's keys. */
export async function dappInvalidateForWallet(activeId: string): Promise<void> {
  await rejectPendingWhere(m => m.walletId !== activeId, 'wallet changed — request cancelled')
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
  /** Optional dapp-supplied idempotency key (external audit): retrying a send
   *  with the same key returns the existing operation's outcome instead of
   *  creating a second approved payment. */
  idempotencyKey?: string
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/

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
  let idempotencyKey: string | undefined
  if (p.idempotencyKey !== undefined) {
    if (typeof p.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(p.idempotencyKey)) {
      return { ok: false, error: 'invalid field "idempotencyKey" (8–128 chars of [A-Za-z0-9._-])' }
    }
    idempotencyKey = p.idempotencyKey
  }
  return {
    ok: true,
    send: {
      to: (p.to as string).trim(), priority, sweep,
      ...(amount !== undefined ? { amount } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {})
    }
  }
}

/** Longest message a site may ask the user to sign. Long enough for an
 *  ownership challenge or a login statement, short enough that the approval
 *  card can show ALL of it — the user must never approve text they cannot see. */
const MAX_SIGN_MESSAGE = 512

/** Code points that could make the approval card RENDER differently from the
 *  logical bytes the user signs. The invariant is strict — the user must see
 *  exactly what they sign — so instead of a hand-picked list this rejects whole
 *  Unicode *classes* that are invisible, ignorable, direction-controlling, or
 *  ill-formed. Ranges are code points (the `u` flag), so astral characters
 *  (variation-selector supplements, tags) are covered too. Pinned to the
 *  Unicode 15.1 Default_Ignorable_Code_Point set; revisit on a UCD bump.
 *
 *  Covered classes:
 *  - C0 / DEL / C1 controls (\\u0000-\\u001f, \\u007f-\\u009f)
 *  - Default_Ignorable_Code_Point: soft hyphen, CGJ, ARABIC LETTER MARK
 *      (\\u061c), Hangul fillers, Khmer inherent vowels, Mongolian FVS/MVS,
 *      zero-width + LRM/RLM, bidi embeddings/overrides, word joiner /
 *      invisible operators / bidi isolates AND the deprecated format controls
 *      (all of \\u2060-\\u206f), variation selectors (\\ufe00-\\ufe0f incl. VS16
 *      \\ufe0f) and their supplement (\\u{e0100}-\\u{e01ef}), tags
 *      (\\u{e0000}-\\u{e007f}), BOM, reserved, shorthand/musical format controls
 *  - line / paragraph separators (\\u2028, \\u2029)
 *  - noncharacters: \\ufdd0-\\ufdef and U+FFFE/U+FFFF of every plane
 *  - lone (unpaired) surrogates (\\ud800-\\udfff) */
// eslint-disable-next-line no-control-regex
const DISALLOWED_SIGN_CHARS = new RegExp('[' + [
  '\\u0000-\\u001f\\u007f-\\u009f',
  '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f',
  '\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f',
  '\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufff8',
  '\\ufdd0-\\ufdef\\ud800-\\udfff',
  '\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}',
  // U+FFFE/U+FFFF noncharacters in the BMP and every supplementary plane
  '\\ufffe\\uffff',
  '\\u{1fffe}\\u{1ffff}\\u{2fffe}\\u{2ffff}\\u{3fffe}\\u{3ffff}\\u{4fffe}\\u{4ffff}',
  '\\u{5fffe}\\u{5ffff}\\u{6fffe}\\u{6ffff}\\u{7fffe}\\u{7ffff}\\u{8fffe}\\u{8ffff}',
  '\\u{9fffe}\\u{9ffff}\\u{afffe}\\u{affff}\\u{bfffe}\\u{bffff}\\u{cfffe}\\u{cffff}',
  '\\u{dfffe}\\u{dffff}\\u{efffe}\\u{effff}\\u{ffffe}\\u{fffff}\\u{10fffe}\\u{10ffff}'
].join('') + ']', 'u')

/** Validate bdx_signMessage params (PROTOCOL.md §4.6). Control characters and
 *  invisible/direction-control Unicode are rejected so a message cannot hide
 *  or visually reorder its real content in the approval card. */
export function validateSignParams(params: unknown): { ok: true; message: string } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  if (typeof p.message !== 'string' || p.message.length === 0) {
    return { ok: false, error: 'invalid field "message" (non-empty string required)' }
  }
  if (p.message.length > MAX_SIGN_MESSAGE) {
    return { ok: false, error: `invalid field "message" (max ${MAX_SIGN_MESSAGE} characters)` }
  }
  if (DISALLOWED_SIGN_CHARS.test(p.message)) {
    return { ok: false, error: 'invalid field "message" (control, invisible or direction-control characters are not allowed)' }
  }
  return { ok: true, message: p.message }
}

// ---- bdx_signAuthChallenge (wallet-composed sign-in proof) -------------------
//
// The wallet — not the page — composes the statement, inserting the origin it
// observed from the content-script sender. This makes the proof audience-bound
// by the wallet: a malicious page cannot get the user to sign a statement
// naming a domain other than the one actually asking. The page supplies only
// the server-issued nonce (and an optional requestId / expiry). See the
// companion bdx-web3js `buildAuthChallenge()` — the format below must byte-match.

const AUTH_PREFIX = 'beldex-auth-v1'
const NONCE_RE = /^[A-Za-z0-9._-]{8,128}$/
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const EXPIRES_MIN_MS = 60_000
const EXPIRES_MAX_MS = 3_600_000
const EXPIRES_DEFAULT_MS = 300_000

export interface AuthChallengeParams {
  nonce: string
  requestId?: string
  expiresInMs: number
}

/** Validate the PAGE-supplied params for bdx_signAuthChallenge. Everything
 *  security-relevant (domain/uri/address/network/iat/exp) is wallet-derived and
 *  NOT taken from here; the page may only influence nonce, requestId, and the
 *  expiry within its clamp. */
export function validateAuthChallengeParams(
  params: unknown
): { ok: true; value: AuthChallengeParams } | { ok: false; error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  const allowed = new Set(['nonce', 'requestId', 'expiresInMs'])
  for (const k of Object.keys(p)) {
    if (!allowed.has(k)) return { ok: false, error: `unexpected field "${k}"` }
  }
  if (typeof p.nonce !== 'string' || !NONCE_RE.test(p.nonce)) {
    return { ok: false, error: 'invalid field "nonce" (8–128 chars of [A-Za-z0-9._-])' }
  }
  let requestId: string | undefined
  if (p.requestId !== undefined) {
    if (typeof p.requestId !== 'string' || !REQUEST_ID_RE.test(p.requestId)) {
      return { ok: false, error: 'invalid field "requestId" (1–64 chars of [A-Za-z0-9._-])' }
    }
    requestId = p.requestId
  }
  let expiresInMs = EXPIRES_DEFAULT_MS
  if (p.expiresInMs !== undefined) {
    if (typeof p.expiresInMs !== 'number' || !Number.isInteger(p.expiresInMs)
      || p.expiresInMs < EXPIRES_MIN_MS || p.expiresInMs > EXPIRES_MAX_MS) {
      return { ok: false, error: `invalid field "expiresInMs" (integer ${EXPIRES_MIN_MS}–${EXPIRES_MAX_MS})` }
    }
    expiresInMs = p.expiresInMs
  }
  return { ok: true, value: { nonce: p.nonce, expiresInMs, ...(requestId !== undefined ? { requestId } : {}) } }
}

export interface AuthChallengeFields {
  domain: string; uri: string; address: string; network: string
  nonce: string; iat: number; exp: number; requestId?: string
}

/** Compose the exact single-line statement to be signed. Byte-identical to the
 *  SDK's buildAuthChallenge(): space-separated `key=value`, `rid` only when a
 *  requestId is present. */
export function buildAuthChallenge(f: AuthChallengeFields): string {
  let s = `${AUTH_PREFIX} domain=${f.domain} uri=${f.uri} address=${f.address}`
    + ` network=${f.network} nonce=${f.nonce} iat=${f.iat} exp=${f.exp}`
  if (f.requestId !== undefined) s += ` rid=${f.requestId}`
  return s
}

/** Derive the wallet-controlled fields and the statement. Returns an error if
 *  any field value contains whitespace/control chars or the statement exceeds
 *  the 512-char cap the approval card can fully display. */
function composeAuthChallenge(
  domain: string, senderUrl: string | undefined, address: string, network: string,
  v: AuthChallengeParams
): { ok: true; message: string; fields: AuthChallengeFields } | { ok: false; error: string } {
  let uri = domain + '/'
  if (senderUrl) {
    try {
      const u = new URL(senderUrl)
      if (u.origin === domain) uri = domain + u.pathname
    } catch { /* fall back to domain + / */ }
  }
  const iat = Date.now()
  const fields: AuthChallengeFields = {
    domain, uri, address, network, nonce: v.nonce, iat, exp: iat + v.expiresInMs,
    ...(v.requestId !== undefined ? { requestId: v.requestId } : {})
  }
  // No field value may contain whitespace or control/invisible chars — those
  // would break the single-line format or let the rendered card diverge from
  // the signed bytes.
  for (const val of [fields.domain, fields.uri, fields.address, fields.network,
    fields.nonce, ...(fields.requestId !== undefined ? [fields.requestId] : [])]) {
    if (/\s/.test(val) || DISALLOWED_SIGN_CHARS.test(val)) {
      return { ok: false, error: 'wallet-derived field contains invalid characters' }
    }
  }
  const message = buildAuthChallenge(fields)
  if (message.length > MAX_SIGN_MESSAGE) {
    return { ok: false, error: `challenge too long (max ${MAX_SIGN_MESSAGE} characters)` }
  }
  return { ok: true, message, fields }
}

// One in-flight send per wallet, shared by the panel's own send flow and dapp
// sends (two concurrent constructions could pick the same outputs → double
// spend). Held in storage.session with a stale-out so a crashed signer can't
// wedge the wallet.

const SEND_LOCK_KEY = 'send_lock'
const SEND_LOCK_STALE_MS = 3 * 60_000

// The lock lives in storage.session (survives SW restart, cleared on browser
// exit) with a stale-out so a crashed signer can't wedge the wallet, PLUS an
// owner token so a stale prior holder's release can't delete a newer holder's
// lock (external audit). All mutations run under withLock('send'), which
// serializes the check-then-write within this worker, so two interleaved
// acquires cannot both pass the not-held check.

interface SendLockRecord { owner: string; at: number }

/** The current NON-stale lock record, or null if free/stale. */
async function sendLockRecord(): Promise<SendLockRecord | null> {
  const l = (await sessionStore.get(SEND_LOCK_KEY))[SEND_LOCK_KEY] as SendLockRecord | undefined
  if (!l || Date.now() - (l.at ?? 0) >= SEND_LOCK_STALE_MS) return null
  return l
}

export async function sendLockHeld(): Promise<boolean> {
  return (await sendLockRecord()) !== null
}

/** Acquire the global single-flight send lock, returning an owner token the
 *  caller must present to release it. Serialized so concurrent acquires can't
 *  both succeed; a stale lock is replaceable. */
export async function dappSendLockAcquire(): Promise<{ ok: true; owner: string } | { ok: false; error: string }> {
  return withLock('send', async () => {
    if (await sendLockRecord()) return { ok: false as const, error: 'A transaction is already in progress' }
    const owner = crypto.randomUUID()
    await sessionStore.set({ [SEND_LOCK_KEY]: { owner, at: Date.now() } satisfies SendLockRecord })
    return { ok: true as const, owner }
  })
}

/** Release the send lock — only the matching owner may, so a stale prior holder
 *  whose lock was already replaced is a no-op and never deletes the new lock.
 *  A tokenless (legacy) call only clears a tokenless record. */
export async function dappSendLockRelease(owner?: string): Promise<{ ok: true }> {
  await withLock('send', async () => {
    const rec = (await sessionStore.get(SEND_LOCK_KEY))[SEND_LOCK_KEY] as SendLockRecord | undefined
    if (!rec) return
    if (owner ? rec.owner === owner : !rec.owner) await sessionStore.remove(SEND_LOCK_KEY)
  })
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

/** The one-pending-per-origin and one-pending-send rules must hold
 *  across service-worker restarts, so consult BOTH the live map and the
 *  persisted storage.session metadata (which survives the restart; its live
 *  reply channel does not). Expired persisted entries are pruned on the way.
 *  Deliberately NOT pruned merely for being orphaned: a persisted connect
 *  approval stays actionable after a restart (the grant persists; the page
 *  just calls connect() again — see the header comment). */
async function pendingConflicts(origin: string): Promise<{ origin: boolean; send: boolean }> {
  const now = Date.now()
  let originPending = false
  let sendPending = false
  for (const p of pendingLive.values()) {
    if (p.origin === origin) originPending = true
    if (p.method === 'bdx_sendTransaction') sendPending = true
  }
  const all: Record<string, PendingMeta> = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  for (const [reqId, meta] of Object.entries(all)) {
    if (now - meta.createdAt > APPROVAL_TTL_MS) { await removePending(reqId); continue }
    if (meta.origin === origin) originPending = true
    if (meta.method === 'bdx_sendTransaction') sendPending = true
  }
  return { origin: originPending, send: sendPending }
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

/**
 * Surface an approval request to the user. Preferred: inside the wallet's
 * side panel (panel shows the request via DAPP_LIST_PENDING). Fallbacks, in
 * order: open the side panel programmatically (works when the browser still
 * honors the user's click gesture), else a standalone popup window.
 */
async function openApproval(reqId: string, tabId?: number): Promise<void> {
  if (await panelIsOpen()) { notifyPanels(); return }

  try {
    // Chrome: needs the "sidePanel" permission and (usually) a user gesture.
    if (anyChrome.sidePanel?.open && tabId !== undefined) {
      await anyChrome.sidePanel.open({ tabId })
      notifyPanels()
      return
    }
  } catch { /* gesture not honored — fall back */ }
  try {
    if (anyChrome.sidebarAction?.open) { // Firefox
      await anyChrome.sidebarAction.open()
      notifyPanels()
      return
    }
  } catch { /* fall back */ }

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

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html?reqId=${encodeURIComponent(reqId)}`),
    type: 'popup', width: WIDTH, height: HEIGHT, focused: true, ...position
  })
  const live = pendingLive.get(reqId)
  if (live && win.id !== undefined) {
    live.windowId = win.id
    windowToReq.set(win.id, reqId)
  }
}

// ---- method handlers --------------------------------------------------------

async function handleMethod(
  origin: string,
  req: DappPortRequest,
  respond: (msg: DappPortMessage) => void,
  tabId?: number,
  senderUrl?: string,
  port?: chrome.runtime.Port
): Promise<void> {
  const reply = (result: unknown) => respond({ id: req.id, result })
  const fail = (e: { code: number; message: string }) => respond({ id: req.id, error: e })

  switch (req.method) {
    case 'bdx_getState': {
      // Rate-limited (was a free service-worker keep-alive and
      // fingerprinting oracle), and lock-state granularity is reserved for
      // origins the user granted — everyone else learns only that a provider
      // exists ('locked' covers both, and the connect flow works from it).
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      const wallets = await getWallets()
      if (Object.keys(wallets).length === 0) return reply({ state: 'no-wallet' })
      if (!(await grantedActiveId(origin))) return reply({ state: 'locked' })
      const session = await getSession()
      const activeId = await getActiveId()
      return reply({ state: session && session.walletId === activeId ? 'unlocked' : 'locked' })
    }

    case 'bdx_getNetwork': {
      // Rate-limited; walletVersion (phishing-targeting granularity)
      // only for granted origins. nettype/protocolVersion stay public — dapps
      // need them to render a connect button at all.
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      const cached = (await sessionStore.get(CACHE_KEY))[CACHE_KEY]
      const height = Number(cached?.info?.blockchain_height ?? cached?.info?.scanned_block_height ?? 0) || 0
      const granted = !!(await grantedActiveId(origin))
      return reply({
        nettype: nettype(), height,
        protocolVersion: PROTOCOL_VERSION,
        ...(granted ? { walletVersion: chrome.runtime.getManifest().version } : {})
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
      let removed = false
      await updateGrants(g => {
        if (!g[origin]) return false
        delete g[origin]; removed = true; return true
      })
      if (removed) sendToOrigin(origin, 'disconnect', {})
      return reply({})
    }

    case 'bdx_connect': {
      // Never let an impersonatable origin into the grant flow.
      if (insecureOrigin(origin)) {
        return fail(err(ERR.UNAUTHORIZED, 'insecure (http) origins cannot connect'))
      }
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
      // One pending approval per origin (spec §7.4), admitted atomically.
      // Generation is null: connect may legitimately be approved after the
      // surface's own unlock. Bound to the wallet being displayed.
      {
        const a = await admitApproval({
          origin, method: req.method, params: undefined, pageReqId: req.id,
          respond, tabId, walletId: activeId, sessionGeneration: null
        })
        if (!a.ok) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      return // settled later by DAPP_APPROVE / DAPP_REJECT / window close / TTL
    }

    case 'bdx_sendTransaction': {
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      const v = validateSendParams(req.params)
      if (!v.ok) return fail(err(ERR.INVALID_PARAMS, v.error))
      // Idempotency (external audit): a retry with the same key must never
      // create a second approved payment. Replay the recorded outcome instead.
      if (v.send.idempotencyKey) {
        const prior = await findOperationByKey(origin, v.send.idempotencyKey)
        if (prior) {
          if (prior.state === 'confirmed') {
            return reply({ txHash: prior.txHash, fee: prior.fee ?? '0', operationId: prior.operationId, idempotent: true })
          }
          if (prior.state === 'executing') {
            return fail(err(ERR.INTERNAL, 'a transaction for this idempotency key is already in progress'))
          }
          // 'failed' falls through: a new attempt for the same key is allowed.
        }
      }
      // Global single-flight: one send at a time across dapp + panel flows.
      if (await sendLockHeld()) return fail(err(ERR.INTERNAL, 'transaction already in progress'))
      {
        const session = await getSession()
        const generation = session && session.walletId === activeId ? session.generation : null
        // Atomic admission: the send-conflict + origin-conflict check and the
        // queue-write run under one mutex so two sends can't both be admitted.
        const a = await admitApproval({
          origin, method: req.method, params: v.send as unknown as object, pageReqId: req.id,
          respond, tabId, walletId: activeId, sessionGeneration: generation, owner: port,
          requireNoSend: true
        })
        if (!a.ok) {
          return fail(err(ERR.INTERNAL,
            a.kind === 'send' ? 'transaction already in progress' : 'approval already pending'))
        }
      }
      return // settled by DAPP_COMPLETE / DAPP_FAIL / DAPP_REJECT / close / TTL
    }

    case 'bdx_getOperationStatus': {
      // Recovery path (external audit): after a client timeout or lost channel
      // a dapp can learn the true outcome instead of blindly retrying. Only the
      // origin that created the operation may read it; grant + rate limit apply.
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      if (!readAllowed(origin)) return fail(err(ERR.INTERNAL, 'rate limited — slow down'))
      const opId = (req.params as { operationId?: unknown } | undefined)?.operationId
      if (typeof opId !== 'string' || !opId) return fail(err(ERR.INVALID_PARAMS, 'invalid field "operationId"'))
      const op = (await liveOperations())[opId]
      if (!op || op.origin !== origin) return reply({ status: 'unknown' })
      return reply({
        status: op.state, operationId: op.operationId,
        ...(op.state === 'confirmed' ? { txHash: op.txHash, fee: op.fee ?? '0' } : {})
      })
    }

    case 'bdx_signMessage': {
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      const v = validateSignParams(req.params)
      if (!v.ok) return fail(err(ERR.INVALID_PARAMS, v.error))
      const session = await getSession()
      if (!session || session.walletId !== activeId) return fail(err(ERR.LOCKED, 'wallet locked'))
      {
        const a = await admitApproval({
          origin, method: req.method, params: { message: v.message }, pageReqId: req.id,
          respond, tabId, walletId: activeId, sessionGeneration: session.generation, owner: port
        })
        if (!a.ok) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      return // settled by DAPP_SIGN_COMPLETE / DAPP_FAIL / DAPP_REJECT / close / TTL
    }

    case 'bdx_signAuthChallenge': {
      // Same preconditions as bdx_signMessage. The difference is the wallet
      // composes the statement from the origin IT observed — the page cannot
      // name a different domain in the signed bytes.
      const activeId = await grantedActiveId(origin)
      if (!activeId) return fail(err(ERR.UNAUTHORIZED, 'origin not connected'))
      const v = validateAuthChallengeParams(req.params)
      if (!v.ok) return fail(err(ERR.INVALID_PARAMS, v.error))
      const session = await getSession()
      if (!session || session.walletId !== activeId) return fail(err(ERR.LOCKED, 'wallet locked'))
      const composed = composeAuthChallenge(origin, senderUrl, session.secrets.address, nettype(), v.value)
      if (!composed.ok) return fail(err(ERR.INVALID_PARAMS, composed.error))
      {
        const a = await admitApproval({
          origin, method: req.method, params: { message: composed.message, fields: composed.fields },
          pageReqId: req.id, respond, tabId, walletId: activeId,
          sessionGeneration: session.generation, owner: port
        })
        if (!a.ok) return fail(err(ERR.INTERNAL, 'approval already pending'))
      }
      return // settled by DAPP_AUTH_SIGN_COMPLETE / DAPP_FAIL / DAPP_REJECT / close / TTL
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
  tabId: number | undefined,
  walletId: string,
  sessionGeneration: string | null,
  owner?: chrome.runtime.Port
): Promise<void> {
  const reqId = crypto.randomUUID()
  const meta: PendingMeta = {
    origin, method, createdAt: Date.now(), walletId, sessionGeneration,
    ...(params !== undefined ? { params } : {})
  }
  const timer = setTimeout(async () => {
    // An EXECUTING send owns its own outcome — the TTL must never fire on it
    // (the timer is cancelled at beginSend, so this is belt-and-braces).
    if (pendingLive.get(reqId)?.executing) return
    settlePending(reqId, { error: err(ERR.EXPIRED, 'approval expired') })
    const live = pendingLive.get(reqId)
    await removePending(reqId)
    if (live?.windowId !== undefined) chrome.windows.remove(live.windowId).catch(() => {})
    notifyPanels()
  }, APPROVAL_TTL_MS)
  pendingLive.set(reqId, { ...meta, pageReqId, respond, timer, ...(owner ? { owner } : {}) })
  await persistPending(reqId, meta)
  await openApproval(reqId, tabId)
}

/** Serialized "check duplicate-pending conflicts, then queue" (external audit):
 *  running the conflict check and the queue-write under one mutex stops two
 *  interleaved requests from both passing the one-per-origin / one-send check
 *  and queuing duplicate approvals. Returns which conflict blocked admission. */
async function admitApproval(args: {
  origin: string; method: DappMethod; params: object | undefined; pageReqId: string
  respond: (msg: DappPortMessage) => void; tabId?: number
  walletId: string; sessionGeneration: string | null; owner?: chrome.runtime.Port
  requireNoSend?: boolean
}): Promise<{ ok: true } | { ok: false; kind: 'send' | 'origin' }> {
  return withLock('pending', async () => {
    const c = await pendingConflicts(args.origin)
    if (args.requireNoSend && c.send) return { ok: false as const, kind: 'send' as const }
    if (c.origin) return { ok: false as const, kind: 'origin' as const }
    await queueApproval(
      args.origin, args.method, args.params, args.pageReqId, args.respond,
      args.tabId, args.walletId, args.sessionGeneration, args.owner
    )
    return { ok: true as const }
  })
}

// ---- internal messages from the approval UI / Settings ----------------------
// (called from background/index.ts's message switch — sender is our own
// extension, already verified there)

/** Oldest live approval request — what an open side panel should display.
 *  Also prunes expired entries. */
export async function dappFirstPending(): Promise<
  ({ reqId: string } & Awaited<ReturnType<typeof pendingView>>) | null
> {
  const all: Record<string, PendingMeta> = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  let best: { reqId: string; meta: PendingMeta } | null = null
  for (const [reqId, meta] of Object.entries(all)) {
    if (Date.now() - meta.createdAt > APPROVAL_TTL_MS) { await removePending(reqId); continue }
    if (!best || meta.createdAt < best.meta.createdAt) best = { reqId, meta }
  }
  if (!best) return null
  return { reqId: best.reqId, ...(await pendingView(best.meta)) }
}

/** What the approval surfaces render + bind against: the pending metadata
 *  plus the RECORDED wallet's identity (external audit: the display must come
 *  from the immutable approval context, not from whatever is active now). */
async function pendingView(meta: PendingMeta): Promise<{
  origin: string; method: string; params?: object
  walletId: string; sessionGeneration: string | null
  walletName: string; walletAddress: string
}> {
  const w = (await getWallets())[meta.walletId]
  return {
    origin: meta.origin, method: meta.method,
    ...(meta.params !== undefined ? { params: meta.params } : {}),
    walletId: meta.walletId, sessionGeneration: meta.sessionGeneration,
    walletName: w?.name ?? '', walletAddress: w?.address ?? ''
  }
}

export async function dappGetPending(reqId: string): Promise<
  { ok: true; pending: Awaited<ReturnType<typeof pendingView>> } | { ok: false; error: string }
> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  const meta: PendingMeta | undefined = all[reqId]
  if (!meta || Date.now() - meta.createdAt > APPROVAL_TTL_MS) {
    return { ok: false, error: 'This request has expired — retry from the site.' }
  }
  return { ok: true, pending: await pendingView(meta) }
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
  // External audit: the grant must go to the wallet the user was SHOWN when
  // the request was queued — never to whatever became active meanwhile.
  if (meta.walletId !== activeId) {
    settlePending(reqId, { error: err(ERR.EXPIRED, 'wallet changed — request cancelled') })
    await removePending(reqId)
    notifyPanels()
    return { ok: false, error: 'The active wallet changed — ask the site to reconnect.' }
  }
  if (insecureOrigin(meta.origin)) { // cannot be granted, ever
    settlePending(reqId, { error: err(ERR.UNAUTHORIZED, 'insecure (http) origins cannot connect') })
    await removePending(reqId)
    return { ok: false, error: 'Insecure (http) sites cannot be connected' }
  }
  await updateGrants(g => { g[meta.origin] = { walletId: activeId, grantedAt: Date.now() }; return true })
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

/** Atomic PENDING -> EXECUTING transition for a send (external audit). Called
 *  by the approval surface immediately before it starts constructing the tx.
 *  Verifies the wallet/session binding, cancels the review TTL, drops the
 *  persisted pending metadata so nothing can expire it mid-flight, records an
 *  executing operation, and returns an unguessable execution token + a queryable
 *  operationId. After this, only dappComplete/dappFail bearing the token settle
 *  the request — neither timeout nor channel-loss can. */
export async function dappBeginSend(
  reqId: string
): Promise<{ ok: true; executionToken: string; operationId: string } | { ok: false; error: string }> {
  const live = pendingLive.get(reqId)
  if (!live || live.method !== 'bdx_sendTransaction') {
    return { ok: false, error: 'This request has expired — retry from the site.' }
  }
  if (live.executing && live.executionToken && live.operationId) {
    // Idempotent begin (the surface retried): hand back the same token.
    return { ok: true, executionToken: live.executionToken, operationId: live.operationId }
  }
  // Re-verify the immutable approval context right before execution.
  const session = await getSession()
  const activeId = await getActiveId()
  if (!session || !activeId || activeId !== live.walletId || session.walletId !== live.walletId
    || (live.sessionGeneration !== null && session.generation !== live.sessionGeneration)) {
    return { ok: false, error: 'Wallet changed — review this request again' }
  }
  const executionToken = crypto.randomUUID()
  const operationId = crypto.randomUUID()
  const now = Date.now()
  const idempotencyKey = (live.params as { idempotencyKey?: unknown } | undefined)?.idempotencyKey
  const op: OperationRecord = {
    operationId, executionToken, origin: live.origin, walletId: live.walletId,
    state: 'executing', createdAt: now, updatedAt: now,
    ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {})
  }
  await putOperation(op)
  // Cancel the review timer and drop the persisted PENDING entry so the request
  // can no longer be expired or re-shown; KEEP the live entry for the reply.
  clearTimeout(live.timer)
  live.executing = true
  live.executionToken = executionToken
  live.operationId = operationId
  const persisted = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  if (persisted[reqId]) { delete persisted[reqId]; await sessionStore.set({ [PENDING_KEY]: persisted }) }
  notifyPanels()
  return { ok: true, executionToken, operationId }
}

/** Send flow finished in the approval surface (panel/popup): persist the
 *  broadcast outcome BEFORE attempting to reply, so a dead channel or SW
 *  restart can't lose it (external audit). Requires the execution token. */
export async function dappComplete(
  reqId: string,
  args: { operationId: string; executionToken: string; result: { txHash: string; fee: string } }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ops = await getOperations()
  const op = ops[args.operationId]
  if (!op || op.executionToken !== args.executionToken) {
    return { ok: false, error: 'Unknown or invalid operation' }
  }
  if (op.state === 'executing') {
    op.state = 'confirmed'
    op.txHash = String(args.result.txHash)
    op.fee = String(args.result.fee ?? '0')
    op.updatedAt = Date.now()
    await putOperation(op) // outcome persisted FIRST
  }
  // Best-effort reply; the outcome is already durable and queryable via
  // bdx_getOperationStatus if the channel is gone.
  settlePending(reqId, { result: { txHash: op.txHash, fee: op.fee ?? '0', operationId: op.operationId } })
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

/** Auth-challenge signed in the approval surface. The reply carries the exact
 *  signed `message` (the wallet-composed statement) alongside the signature so
 *  the dapp/server verifies against bytes it can re-derive. */
export async function dappAuthSignComplete(
  reqId: string, result: { message: string; signature: string; address: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const all = (await sessionStore.get(PENDING_KEY))[PENDING_KEY] ?? {}
  const meta: PendingMeta | undefined = all[reqId]
  if (!meta) return { ok: false, error: 'Request no longer pending' }
  // Defense in depth: the returned message MUST be the wallet-composed
  // statement recorded at queue time, never anything the surface substituted.
  const expected = (meta.params as { message?: unknown } | undefined)?.message
  if (typeof expected !== 'string' || String(result.message) !== expected) {
    return { ok: false, error: 'signed message does not match the approved challenge' }
  }
  settlePending(reqId, {
    result: {
      message: expected,
      signature: String(result.signature),
      address: String(result.address)
    }
  })
  await removePending(reqId)
  notifyPanels()
  return { ok: true }
}

/** Send flow failed. The wire error is SANITIZED (spec §6) — the detailed
 *  reason stays in the wallet UI, never goes to the page. When the failure
 *  happens AFTER beginSend, the operation is recorded as failed (so a retry
 *  with the same idempotency key is permitted and a status query says so). */
export async function dappFail(
  reqId: string, args?: { operationId?: string; executionToken?: string; unknown?: boolean }
): Promise<{ ok: true }> {
  if (args?.operationId && args.executionToken) {
    const ops = await getOperations()
    const op = ops[args.operationId]
    if (op && op.executionToken === args.executionToken && op.state === 'executing') {
      // UNKNOWN outcome (e.g. a submit-phase timeout): leave the operation
      // EXECUTING so an idempotent retry is refused and bdx_getOperationStatus
      // reports it as still in progress — the tx may have broadcast. Only a
      // definite failure marks it 'failed' (which permits a retry).
      if (!args.unknown) {
        op.state = 'failed'
        op.updatedAt = Date.now()
        await putOperation(op)
      }
    }
  }
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
  let removed = false
  await updateGrants(g => {
    if (!g[origin]) return false
    delete g[origin]; removed = true; return true
  })
  if (removed) sendToOrigin(origin, 'disconnect', {})
  return { ok: true }
}

// ---- wiring -----------------------------------------------------------------

export function initDappBridge(): void {
  // Migration: drop any grant a pre-1.0.1 install issued to a
  // plain-http origin — those origins are impersonatable on the network and
  // can no longer be granted (or, post-manifest-change, even injected into).
  updateGrants(g => {
    let changed = false
    for (const origin of Object.keys(g)) {
      if (insecureOrigin(origin)) { delete g[origin]; changed = true }
    }
    return changed
  }).catch(() => { /* storage hiccup — retried next SW start */ })

  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== PORT_NAME) return
    // Origin comes from the browser, never from the page (spec §7.8).
    const origin =
      port.sender?.origin ??
      (port.sender?.url ? safeOrigin(port.sender.url) : null)
    if (!origin || origin === 'null') { port.disconnect(); return }
    const tabId = port.sender?.tab?.id
    ports.set(port, { origin, ...(tabId !== undefined ? { tabId } : {}) })
    port.onDisconnect.addListener(() => {
      ports.delete(port)
      // External audit: a still-PENDING send/sign approval must not stay
      // actionable once its page's channel is gone — approving it later could
      // sign/broadcast for a page that will never receive the reply. Reject
      // those; an EXECUTING send is untouched (its outcome is owned by the
      // operation record), and connect stays (recoverable via the grant).
      for (const [reqId, live] of pendingLive) {
        if (live.owner !== port || live.executing) continue
        if (live.method === 'bdx_sendTransaction' || live.method === 'bdx_signMessage'
          || live.method === 'bdx_signAuthChallenge') {
          settlePending(reqId, { error: err(ERR.INTERNAL, 'page disconnected — request cancelled') })
          if (live.windowId !== undefined) chrome.windows.remove(live.windowId).catch(() => {})
          removePending(reqId)
          notifyPanels()
        }
      }
    })
    port.onMessage.addListener((raw: unknown) => {
      // The content script already validated + bounded the payload, but it is
      // less trusted than this process — re-apply the SAME per-method schema
      // authoritatively here (external audit), rejecting oversized/unknown/
      // deeply-nested params before any handler or crypto work.
      const req = validatePortMessage(raw)
      if (!req) return
      const respond = (msg: DappPortMessage) => { try { port.postMessage(msg) } catch { /* gone */ } }
      handleMethod(origin, req, respond, port.sender?.tab?.id, port.sender?.url, port).catch(() =>
        respond({ id: req.id, error: err(ERR.INTERNAL, 'internal error') })
      )
    })
  })

  // Approval window closed without a decision = user rejection (spec §7.4).
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

