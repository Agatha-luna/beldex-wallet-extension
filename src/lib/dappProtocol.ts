// Shared constants/types for the dapp bridge. Normative spec: bdx-web3js/PROTOCOL.md
// (protocolVersion 1). This file is imported by the inpage script, the content
// script, and the background router — keep it dependency-free.

export const PROTOCOL_VERSION = 1

export const REQUEST_TARGET = 'beldex-contentscript'
export const RESPONSE_TARGET = 'beldex-inpage'
export const PORT_NAME = 'bdx-dapp'

export const REQUEST_PROVIDER_EVENT = 'beldex:requestProvider'
export const ANNOUNCE_PROVIDER_EVENT = 'beldex:announceProvider'

export const ERR = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  LOCKED: 4900,
  NO_WALLET: 4901,
  PANEL_CLOSED: 4902,
  EXPIRED: 4999,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603
} as const

export const DAPP_METHODS = [
  'bdx_connect', 'bdx_disconnect', 'bdx_getAddress', 'bdx_getBalance',
  'bdx_sendTransaction', 'bdx_getOperationStatus', 'bdx_signMessage', 'bdx_signAuthChallenge',
  'bdx_verifyMessage', 'bdx_resolveBns', 'bdx_getNetwork', 'bdx_getState'
] as const
export type DappMethod = (typeof DAPP_METHODS)[number]

export const DAPP_EVENTS = [
  'connect', 'disconnect', 'accountsChanged', 'networkChanged',
  'balanceChanged', 'lock', 'unlock'
] as const
export type DappEvent = (typeof DAPP_EVENTS)[number]

/** Message flowing content script → background over the port. */
export interface DappPortRequest {
  id: string
  method: DappMethod
  params?: object
}

/** Messages flowing background → content script over the port. */
export type DappPortMessage =
  | { id: string; result?: unknown; error?: { code: number; message: string } }
  | { event: DappEvent; data?: unknown }

// ---- per-method parameter schemas (external audit) -------------------------
//
// Page-controlled params must be bounded BEFORE they cross the extension
// boundary (structured-clone into the privileged worker) and before any
// base58/Keccak/JSON work. Each method declares exactly the fields it accepts,
// with primitive type + a length cap; the sanitizer copies ONLY those fields
// into a fresh object, rejects unknown/extra fields and prototype-pollution
// keys, and rejects params on no-parameter methods. These are STRUCTURAL/SIZE
// gates — semantic validation (charset, ranges, checksums) still runs in the
// background handlers, which return INVALID_PARAMS for a well-formed-but-wrong
// request. `maxLen` is a UTF-16 length cap (O(1)); it bounds UTF-8 bytes to
// <=4x, which is the point — to reject a giant string cheaply.

interface FieldSpec { type: 'string' | 'number' | 'boolean'; maxLen?: number }
type MethodSchema = Record<string, FieldSpec> | null // null = no params allowed

const MAX_PARAM_KEYS = 16 // bounds Object.keys() enumeration on a hostile object

const METHOD_SCHEMAS: Record<DappMethod, MethodSchema> = {
  bdx_connect: null,
  bdx_disconnect: null,
  bdx_getState: null,
  bdx_getNetwork: null,
  bdx_getAddress: null,
  bdx_getBalance: null,
  bdx_resolveBns: { name: { type: 'string', maxLen: 64 } },
  bdx_verifyMessage: {
    message: { type: 'string', maxLen: 8192 },
    address: { type: 'string', maxLen: 128 },
    signature: { type: 'string', maxLen: 256 }
  },
  bdx_signMessage: { message: { type: 'string', maxLen: 512 } },
  bdx_signAuthChallenge: {
    nonce: { type: 'string', maxLen: 128 },
    requestId: { type: 'string', maxLen: 64 },
    expiresInMs: { type: 'number' }
  },
  bdx_sendTransaction: {
    to: { type: 'string', maxLen: 128 },
    amount: { type: 'string', maxLen: 32 },
    sweep: { type: 'boolean' },
    priority: { type: 'number' },
    // recognized-but-rejected downstream; kept so the handler still errors on it
    paymentId: { type: 'string', maxLen: 64 },
    idempotencyKey: { type: 'string', maxLen: 128 }
  },
  bdx_getOperationStatus: { operationId: { type: 'string', maxLen: 128 } }
}

/** Copy only the schema-recognized fields of `rawParams` into a fresh object,
 *  enforcing type + length caps and rejecting unknown/extra fields. Returns the
 *  bounded params (possibly absent), or null if the payload violates the schema
 *  or is a no-param method carrying params. Never traverses field VALUES beyond
 *  a primitive type check, so a nested/oversized value is rejected in O(1). */
function sanitizeParams(method: DappMethod, rawParams: unknown): { params?: object } | null {
  const schema = METHOD_SCHEMAS[method]
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    return null
  }
  if (schema === null) {
    // No-parameter method: reject any params object carrying own keys.
    if (rawParams !== undefined && Object.keys(rawParams as object).length > 0) return null
    return {}
  }
  const raw = (rawParams ?? {}) as Record<string, unknown>
  const keys = Object.keys(raw)
  if (keys.length > MAX_PARAM_KEYS) return null
  // Any key not in the schema (including injected __proto__/constructor own
  // keys from a cloned {"__proto__":…}) rejects the whole request.
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(schema, k)) return null

  // Copy each PRESENT recognized field, enforcing type + size. A missing field
  // is NOT rejected here — it is small (no DoS vector), and dropping it would
  // turn the handler's specific INVALID_PARAMS into a silent drop. Presence and
  // semantics (charset, ranges, checksums) stay with the background handlers.
  const clean: Record<string, unknown> = {}
  for (const field of Object.keys(schema)) {
    const spec = schema[field]!
    const v = raw[field]
    if (v === undefined) continue
    if (spec.type === 'string') {
      if (typeof v !== 'string' || v.length > (spec.maxLen ?? 0)) return null
    } else if (spec.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null
    } else { // boolean
      if (typeof v !== 'boolean') return null
    }
    clean[field] = v
  }
  return Object.keys(clean).length ? { params: clean } : {}
}

/**
 * Strict, bounded validation for page → content-script messages (spec §1:
 * anything not exactly matching is silently dropped). Validates the envelope
 * AND applies the per-method parameter schema, so oversized/unknown/deeply
 * nested page payloads are rejected before being forwarded across the port.
 * Pure function so it can be unit-tested without chrome APIs.
 */
export function parseDappRequest(msg: unknown): DappPortRequest | null {
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  if (m.target !== REQUEST_TARGET) return null
  return buildRequest(m.id, m.method, m.params)
}

/**
 * Authoritative re-validation of a content-script → background PORT message
 * (external audit: the background must not trust the less-privileged content
 * script). Same schema as parseDappRequest, minus the page `target` field.
 */
export function validatePortMessage(raw: unknown): DappPortRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  return buildRequest(m.id, m.method, m.params)
}

function buildRequest(id: unknown, method: unknown, params: unknown): DappPortRequest | null {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null
  if (typeof method !== 'string' || !(DAPP_METHODS as readonly string[]).includes(method)) return null
  const sanitized = sanitizeParams(method as DappMethod, params)
  if (!sanitized) return null
  const req: DappPortRequest = { id, method: method as DappMethod }
  if (sanitized.params !== undefined) req.params = sanitized.params
  return req
}
