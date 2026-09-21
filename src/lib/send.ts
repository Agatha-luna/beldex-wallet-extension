// Send-funds flow, matching the actual v3 bridge API (MyMoneroLibAppBridgeClass).
// The WASM drives the whole process: it builds each LWS request itself and hands
// it to our callbacks, so we pass req_params through to the server verbatim.
// Arg shape verified against the bridge class source and the wasm's embedded
// parser strings (destinations / to_address / send_amount).

import { getBridge } from './bridge'
import { CONFIG } from './config'
import { rawPost } from './lws'
import type { WalletSecrets } from './messages'

export interface TokenDescriptorInput {
  ticker: string
  full_name: string
  meta_info: string
  decimal_point: number | string
  total_max_supply: string
  current_supply: string
}

export interface SendParams {
  secrets: WalletSecrets
  toAddress: string
  /** display units as the user typed them, e.g. "1.25" — NOT atomic units.
   *  In the token's own units when tokenId is set; BDX otherwise. Ignored
   *  (destinations are derived from the descriptor) when isDeployToken. */
  amount: string
  /** 1 = default … 5 = flash (instant) — tx_priority_flash in wallet2.h */
  priority: number
  isSweeping?: boolean
  onStatus?: (code: number) => void
  /** HF22: naming a token switches the whole send to it. The fee stays BDX
   *  and is drawn from native outputs regardless. Omit entirely for a plain
   *  BDX send — leaving it undefined (not "") keeps the request byte-for-byte
   *  the same as before this feature existed. */
  tokenId?: string
  /** Required whenever tokenId is set — the token's own decimal_point. */
  tokenDecimalPoint?: number | string
  /** HF22 token registration: mints the initial supply to this wallet and
   *  locks collateral. No destinations; the bridge derives them from the
   *  descriptor and ignores `amount`/`toAddress` in this mode. */
  isDeployToken?: boolean
  tokenDescriptor?: TokenDescriptorInput
}

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
      // wallet / form state flags expected by the C++ form-submission controller
      fromWallet_didFailToInitialize: false,
      fromWallet_didFailToBoot: false,
      fromWallet_needsImport: false,
      requireAuthentication: false,
      isRegister: false,
      registration_string: undefined,
      hasPickedAContact: false,
      resolvedAddress_fieldIsVisible: false,
      manuallyEnteredPaymentID_fieldIsVisible: false,
      resolvedPaymentID_fieldIsVisible: false,

      // HF22 registration mints the initial supply to this wallet and locks
      // collateral — it takes no destinations at all (see tokenDescriptor).
      destinations: p.isDeployToken ? [] : [{ to_address: p.toAddress, send_amount: p.amount }],
      is_sweeping: p.isSweeping ?? false,
      from_address_string: p.secrets.address,
      sec_viewKey_string: p.secrets.secViewKey,
      sec_spendKey_string: p.secrets.secSpendKey,
      pub_spendKey_string: p.secrets.pubSpendKey,
      priority: p.priority,
      nettype: CONFIG.NETTYPE,

      // HF22 privacy tokens. Left undefined (not "") for a plain BDX send so
      // the request the bridge builds is byte-for-byte the same as before
      // this feature existed.
      token_id: p.tokenId,
      token_decimal_point: p.tokenDecimalPoint !== undefined ? String(p.tokenDecimalPoint) : undefined,
      is_deploy_token: p.isDeployToken,
      token_descriptor: p.tokenDescriptor
        ? {
            ticker: p.tokenDescriptor.ticker,
            full_name: p.tokenDescriptor.full_name,
            meta_info: p.tokenDescriptor.meta_info,
            decimal_point: p.tokenDescriptor.decimal_point,
            total_max_supply: p.tokenDescriptor.total_max_supply,
            current_supply: p.tokenDescriptor.current_supply
          }
        : undefined,

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
