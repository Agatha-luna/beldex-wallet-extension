// The pure half of the send payload: the exact argument object handed to the
// WASM's async__send_funds, minus the callbacks and the bridge itself.
//
// Kept in its own module with no runtime imports so the payload can be asserted
// directly in tests (test/masternode-register.test.mjs) without loading the
// Emscripten glue, the network layer, or webpack's build-time config globals.
// Everything consensus-relevant is decided here: destinations, token fields and
// registration fields.

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
  /** Master node registration. `registrationString` is the full
   *  `register_master_node …` command produced by `prepare_registration` on the
   *  operator's beldexd — it already carries the contributor addresses, the
   *  amounts, the operator cut and the expiry, so the core reads the stake out
   *  of it rather than from `amount`/`toAddress`. */
  isRegister?: boolean
  registrationString?: string
}

/**
 * The non-callback half of the async__send_funds argument object.
 *
 * Split out so the exact payload handed to the core can be asserted without
 * loading the WASM or making a network call (test/masternode-register.test.mjs).
 * Everything consensus-relevant — destinations, token fields, registration
 * fields — is decided here.
 */
export function buildSendArgs(p: SendParams, nettype: number): Record<string, unknown> {
  return {
    // wallet / form state flags expected by the C++ form-submission controller
    fromWallet_didFailToInitialize: false,
    fromWallet_didFailToBoot: false,
    fromWallet_needsImport: false,
    requireAuthentication: false,

    // Master node registration. The string is produced by prepare_registration
    // on the operator's beldexd and carries the stake, the operator cut, the
    // contributor addresses and the expiry — the core reads the spend out of
    // it, so the wallet describes no destination of its own.
    isRegister: p.isRegister ?? false,
    registration_string: p.registrationString,

    // HF22 token registration mints the initial supply to this wallet and
    // locks collateral — it takes no destinations at all (see tokenDescriptor).
    //
    // A master node registration likewise derives its amounts from the
    // registration string. The empty entry (rather than []) mirrors the mobile
    // wallet, which is the working reference for this flow: its registration
    // tab hides the address/amount inputs, so it submits exactly this shape.
    destinations: p.isDeployToken
      ? []
      : p.isRegister
        ? [{ to_address: '', send_amount: '' }]
        : [{ to_address: p.toAddress, send_amount: p.amount }],

    hasPickedAContact: false,
    resolvedAddress_fieldIsVisible: false,
    manuallyEnteredPaymentID_fieldIsVisible: false,
    resolvedPaymentID_fieldIsVisible: false,

    is_sweeping: p.isSweeping ?? false,
    from_address_string: p.secrets.address,
    sec_viewKey_string: p.secrets.secViewKey,
    sec_spendKey_string: p.secrets.secSpendKey,
    pub_spendKey_string: p.secrets.pubSpendKey,
    priority: p.priority,
    nettype,

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
      : undefined
  }
}

