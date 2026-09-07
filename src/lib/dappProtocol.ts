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
  'bdx_sendTransaction', 'bdx_signMessage', 'bdx_verifyMessage',
  'bdx_resolveBns', 'bdx_getNetwork', 'bdx_getState'
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

/**
 * Strict envelope validation for page → content-script messages (spec §1:
 * anything not exactly matching is silently dropped). Pure function so it can
 * be unit-tested without chrome APIs.
 */
export function parseDappRequest(msg: unknown): DappPortRequest | null {
  if (typeof msg !== 'object' || msg === null) return null
  const m = msg as Record<string, unknown>
  if (m.target !== REQUEST_TARGET) return null
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 128) return null
  if (typeof m.method !== 'string' || !(DAPP_METHODS as readonly string[]).includes(m.method)) return null
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null || Array.isArray(m.params))) return null
  const req: DappPortRequest = { id: m.id, method: m.method as DappMethod }
  if (m.params !== undefined) req.params = m.params as object
  return req
}
