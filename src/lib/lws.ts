// Minimal client for the Beldex light-wallet-server (LWS) HTTP API.
// Endpoint shapes are defined in the core repo: beldex/src/wallet/wallet_light_rpc.h
// (LOGIN, GET_ADDRESS_INFO, GET_ADDRESS_TXS, GET_UNSPENT_OUTS, SUBMIT_RAW_TX).
// The server scans the chain with your *view* key; spend keys never leave the client.

import { CONFIG } from './config'
import { fetchJson, HTTP } from './http'

// Endpoints that BROADCAST get the long submit deadline; everything else is a
// bounded read. Aborting a broadcast early would manufacture an unknown outcome
// (see the send operation state machine), so /submit_raw_tx is given room.
const SUBMIT_ENDPOINTS = new Set(['/submit_raw_tx'])

/** Verbatim POST used by the send flow — the WASM builds these request bodies itself. */
export function rawPost<T = any>(endpoint: string, body: unknown): Promise<T> {
  return post<T>(endpoint, body)
}

async function post<T>(endpoint: string, body: unknown): Promise<T> {
  const budget = SUBMIT_ENDPOINTS.has(endpoint) ? HTTP.LWS_SUBMIT : HTTP.LWS_READ
  return fetchJson<T>(`${CONFIG.LWS_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, budget)
}

export interface Credentials {
  address: string
  view_key: string
}

/** Register/login the address with the LWS so it starts (or resumes) scanning. */
export function login(c: Credentials, createAccount = true) {
  return post<{ new_address: boolean; start_height?: number }>('/login', {
    address: c.address,
    view_key: c.view_key,
    create_account: createAccount,
    generated_locally: true
  })
}

/** Balance summary: total_received, total_sent (needs key-image filtering), scan height. */
export function getAddressInfo(c: Credentials) {
  return post<any>('/get_address_info', c)
}

/** Transaction list for history display. */
export function getAddressTxs(c: Credentials) {
  return post<any>('/get_address_txs', c)
}

// The send flow (lib/send.ts) hits /get_unspent_outs, /get_random_outs and
// /submit_raw_tx directly via rawPost(), because the WASM builds those request
// bodies itself — so there are intentionally no typed wrappers for them here.

// BNS name resolution lives in lib/bns.ts (explorer bnslookup API).
