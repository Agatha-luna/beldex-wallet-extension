// Typed message contracts between popup and background service worker.

import type { NetworkName } from './config'

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
  /** Address on the ACTIVE network, or '' when this wallet is not on it (and
   *  for a wallet that has never been unlocked — the per-network address map is
   *  backfilled from the public keys at unlock, see background/index.ts). */
  address: string
  /** Every network this wallet appears on. A wallet is normally created on one
   *  chain, and can be made available on others explicitly
   *  (ADD_WALLET_TO_NETWORK) — it is the same keypair either way. */
  networks: NetworkName[]
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
  | { type: 'TOUCH' } // REAL user activity (pointer/keyboard/focus) — re-arms auto-lock
  | { type: 'KEEPALIVE' } // keep the MV3 worker warm ONLY — must NOT re-arm auto-lock
  // Selects the active wallet WITHIN the current network. It never changes the
  // network: only wallets that are on the active chain are selectable, so
  // picking one cannot move the user to a different chain.
  | { type: 'SWITCH_WALLET'; id: string }
  // Changes the ACTIVE NETWORK. This is a global setting, not a per-wallet one —
  // the active wallet is remembered separately for each network, so switching
  // chains restores whichever wallet was last used there.
  //
  // The session survives when the same wallet is on both chains (the account is
  // one keypair; only the address encoding differs, so it is re-encoded rather
  // than re-derived). It necessarily ends when the target chain's wallet is a
  // DIFFERENT wallet, whose password we do not hold.
  //
  // No password: this reveals nothing and spends nothing — it re-encodes an
  // address the session already holds. The panel still confirms it, so the
  // consequences are stated before the chain moves. Refused while a send holds
  // the global lock, since a transaction under construction is bound to one
  // chain's unspent set.
  //
  // Refused with code WALLET_NOT_ON_NETWORK when the ACTIVE wallet is not on the
  // target chain: the user is asked whether to bring it along, and declining
  // must leave them where they are rather than silently landing them on some
  // other wallet. `addActiveWallet` is that yes.
  | { type: 'SWITCH_NETWORK'; network: NetworkName; addActiveWallet?: boolean }
  // Make a wallet usable on another chain. Additive and idempotent: it is the
  // same keypair everywhere, so this only decides where the wallet is OFFERED.
  // Drives the "use this wallet on <network>" step in wallet selection.
  | { type: 'ADD_WALLET_TO_NETWORK'; id: string; network: NetworkName }
  | { type: 'RENAME_WALLET'; name: string } // renames the active wallet
  | { type: 'WIPE'; password: string } // deletes the ACTIVE wallet only (password-gated)
  // ---- dapp bridge (approval UI + Connected Sites settings) ----
  | { type: 'DAPP_GET_PENDING'; reqId: string }
  | { type: 'DAPP_LIST_PENDING' } // oldest live approval request, for the panel
  | { type: 'DAPP_APPROVE'; reqId: string }
  | { type: 'DAPP_REJECT'; reqId: string }
  | { type: 'DAPP_BEGIN_SEND'; reqId: string } // atomic PENDING->EXECUTING, returns token
  | { type: 'DAPP_COMPLETE'; reqId: string; operationId: string; executionToken: string; result: { txHash: string; fee: string } }
  | { type: 'DAPP_SIGN_COMPLETE'; reqId: string; result: { signature: string; address: string } }
  | { type: 'DAPP_AUTH_SIGN_COMPLETE'; reqId: string; result: { message: string; signature: string; address: string } }
  // `unknown`: the send may have broadcast but its outcome is unknown (e.g. a
  // timeout after submission began). The operation is left EXECUTING (not
  // failed) so a retry can't create a duplicate payment — the dapp must resolve
  // it via bdx_getOperationStatus. See the send operation state machine.
  | { type: 'DAPP_FAIL'; reqId: string; operationId?: string; executionToken?: string; unknown?: boolean }
  | { type: 'SEND_LOCK_ACQUIRE' } // global one-send-at-a-time (panel + dapp)
  | { type: 'SEND_LOCK_RELEASE'; owner?: string } // only the matching owner releases
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
  /** The chain this request was reviewed on. Part of the immutable approval
   *  context: switching networks voids every pending approval, because the
   *  address shown on the card is only valid for the network it was drawn on. */
  network: NetworkName
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
      /** The active network (global). The panel hydrates CONFIG from this before
       *  any backend call, so the UI and the fetches can never disagree. */
      network?: NetworkName
      // DAPP_BEGIN_SEND: the atomic execution grant handed to the approval card.
      executionToken?: string
      operationId?: string
      // SEND_LOCK_ACQUIRE: owner token required to release the lock.
      lockOwner?: string
      // dapp bridge. Wallet fields describe the wallet RECORDED when the
      // request was queued (immutable approval context) — approval surfaces
      // must render and bind against these, not the currently active wallet.
      pending?: PendingApproval
      pendingReq?: ({ reqId: string } & PendingApproval) | null
      origins?: Array<{ origin: string; grantedAt: number }>
      activeSite?: { origin: string; connected: boolean } | null
    }
  | {
      ok: false
      error: string
      /** Machine-readable reason, so callers branch on intent rather than on
       *  the wording of `error`. Currently: WALLET_NOT_ON_NETWORK. */
      code?: 'WALLET_NOT_ON_NETWORK'
    }

export function sendToBackground(req: BgRequest): Promise<BgResponse> {
  return chrome.runtime.sendMessage(req)
}
