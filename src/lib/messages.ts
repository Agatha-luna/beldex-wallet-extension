// Typed message contracts between popup and background service worker.

export interface WalletSecrets {
  mnemonic: string
  address: string
  pubSpendKey: string
  pubViewKey: string
  secViewKey: string
  secSpendKey: string
  seed: string
}

export interface WalletMeta {
  id: string
  name: string
  address: string // may be '' for legacy wallets until first unlock backfills it
  active: boolean
}

export type BgRequest =
  | { type: 'GET_STATE' }
  | { type: 'SAVE_WALLET'; secrets: WalletSecrets; password: string; name?: string }
  | { type: 'UNLOCK'; password: string }
  | { type: 'LOCK' }
  // `expect` (approval flows): refuse secrets unless the current session AND
  // active wallet still match the context recorded when the request was
  // queued. generation:null binds the wallet only (request queued while locked).
  | { type: 'GET_SECRETS'; expect?: { walletId: string; generation: string | null } }
  | { type: 'REVEAL'; password: string }
  | { type: 'CHANGE_PASSWORD'; oldPassword: string; newPassword: string }
  | { type: 'GET_AUTOLOCK' }
  | { type: 'SET_AUTOLOCK'; minutes: number }
  | { type: 'TOUCH' } // user activity in the panel — re-arm the auto-lock timer
  | { type: 'SWITCH_WALLET'; id: string }
  | { type: 'RENAME_WALLET'; name: string } // renames the active wallet
  | { type: 'WIPE'; password: string } // deletes the ACTIVE wallet only (password-gated)
  // ---- dapp bridge (approval UI + Connected Sites settings) ----
  | { type: 'DAPP_GET_PENDING'; reqId: string }
  | { type: 'DAPP_LIST_PENDING' } // oldest live approval request, for the panel
  | { type: 'DAPP_APPROVE'; reqId: string }
  | { type: 'DAPP_REJECT'; reqId: string }
  | { type: 'DAPP_COMPLETE'; reqId: string; result: { txHash: string; fee: string } }
  | { type: 'DAPP_SIGN_COMPLETE'; reqId: string; result: { signature: string; address: string } }
  | { type: 'DAPP_AUTH_SIGN_COMPLETE'; reqId: string; result: { message: string; signature: string; address: string } }
  | { type: 'DAPP_FAIL'; reqId: string }
  | { type: 'SEND_LOCK_ACQUIRE' } // global one-send-at-a-time (panel + dapp)
  | { type: 'SEND_LOCK_RELEASE' }
  | { type: 'DAPP_LIST_ORIGINS' }
  | { type: 'DAPP_ACTIVE_SITE' } // site in the user's active tab + connection status
  | { type: 'DAPP_REVOKE_ORIGIN'; origin: string }

export type WalletState = 'uninitialized' | 'locked' | 'unlocked'

export interface PendingApproval {
  origin: string
  method: string
  params?: object
  walletId: string
  sessionGeneration: string | null
  walletName: string
  walletAddress: string
}

export type BgResponse =
  | {
      ok: true
      state?: WalletState
      secrets?: WalletSecrets
      address?: string
      minutes?: number
      walletName?: string
      wallets?: WalletMeta[]
      // dapp bridge. Wallet fields describe the wallet RECORDED when the
      // request was queued (immutable approval context) — approval surfaces
      // must render and bind against these, not the currently active wallet.
      pending?: PendingApproval
      pendingReq?: ({ reqId: string } & PendingApproval) | null
      origins?: Array<{ origin: string; grantedAt: number }>
      activeSite?: { origin: string; connected: boolean } | null
    }
  | { ok: false; error: string }

export function sendToBackground(req: BgRequest): Promise<BgResponse> {
  return chrome.runtime.sendMessage(req)
}
