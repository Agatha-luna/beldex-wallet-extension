// Send-funds flow, matching the actual v3 bridge API (MyMoneroLibAppBridgeClass).
// The WASM drives the whole process: it builds each LWS request itself and hands
// it to our callbacks, so we pass req_params through to the server verbatim.
// Arg shape verified against the bridge class source and the wasm's embedded
// parser strings (destinations / to_address / send_amount).

import { getBridge } from './bridge'
import { CONFIG } from './config'
import { rawPost } from './lws'
import { buildSendArgs } from './sendArgs'
import type { SendParams } from './sendArgs'
export type { SendParams, TokenDescriptorInput } from './sendArgs'

export interface SendResult {
  tx_hash: string
  used_fee?: string
  tx_key?: string
  total_sent?: string
  /** Present only on a successful registration. Hashed from the descriptor
   *  plus a salt the bridge generates and does not keep — persist it
   *  immediately, it cannot be re-derived if lost. */
  token_id?: string
}

export async function sendFunds(p: SendParams): Promise<SendResult> {
  const bridge = await getBridge()

  const passthrough = (endpoint: string) =>
    (req_params: any, cb: (err_msg: any, res?: any) => void) => {
      rawPost(endpoint, req_params).then(r => cb(null, r)).catch(e => cb(e.message || String(e)))
    }

  return new Promise<SendResult>((resolve, reject) => {
    bridge.async__send_funds({
      ...buildSendArgs(p, CONFIG.NETTYPE),

      get_unspent_outs_fn: passthrough('/get_unspent_outs'),
      get_random_outs_fn: passthrough('/get_random_outs'),
      submit_raw_tx_fn: passthrough('/submit_raw_tx'),

      status_update_fn: (params: any) => p.onStatus?.(params.code),
      willBeginSending_fn: () => {},
      canceled_fn: () => reject(new Error('Send canceled')),
      authenticate_fn: (cb: (didPass: boolean) => void) => cb(true),
      error_fn: (params: any) => reject(new Error(params.err_msg ?? 'Send failed')),
      success_fn: (params: any) =>
        resolve({
          tx_hash: params.tx_hash,
          used_fee: params.used_fee,
          tx_key: params.tx_key,
          total_sent: params.total_sent,
          token_id: params.token_id ? String(params.token_id) : undefined
        })
    })
  })
}

/** Human-readable labels for status_update_fn codes (SendFunds_ProcessStep_Code). */
export const SEND_STEPS: Record<number, string> = {
  1: 'Fetching latest balance…',
  2: 'Calculating fee…',
  3: 'Fetching decoy outputs…',
  4: 'Constructing transaction…',
  5: 'Submitting transaction…'
}
