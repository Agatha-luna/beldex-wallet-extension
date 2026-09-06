// Dapp transaction approval + signing. Rendered in the panel (preferred) or
// the approval.html popup (fallback) — both are window contexts, so the WASM
// send bridge runs HERE, never in the service worker.
//
// Audit M1/M4 compliance: the FULL untruncated recipient address, the exact
// amount (all 9 decimals), the priority, and the requesting origin are all
// shown before the user can approve. Fee is heuristic pre-approval (the
// MyMonero-lineage bridge computes the real fee only during construction);
// the EXACT fee paid is shown on the success screen and returned to the dapp.

import { useEffect, useState } from 'react'
import { sendToBackground } from '../../lib/messages'
import { sendFunds, SEND_STEPS } from '../../lib/send'
import { ATOMIC, DECIMALS } from '../../lib/money'
import { addPendingLocal } from '../../lib/pendingTxs'
import { getBridge } from '../../lib/bridge'
import { rawPost, getAddressInfo } from '../../lib/lws'
import { correctedTotalSent } from '../../lib/spent'
import { sessionStore } from '../../lib/sessionStore'
import type { WalletSecrets } from '../../lib/messages'

export interface SendReqParams {
  to: string
  amount?: string // atomic units
  priority: 1 | 2 | 3 | 4 | 5
  sweep: boolean
}

/** Recompute + publish key-image-corrected balance figures for the dapp
 *  bridge (shape kept in sync with Dashboard.tsx / background/dapp.ts). */
async function publishCorrectedBalance(secrets: WalletSecrets): Promise<void> {
  const info: any = await getAddressInfo({ address: secrets.address, view_key: secrets.secViewKey })
  const rawTotalSent = String(info.total_sent ?? '0')
  const corrected = await correctedTotalSent(secrets, info)
  await sessionStore.set({
    corrected_balance: {
      address: secrets.address,
      total_received: String(info.total_received ?? '0'),
      total_sent: corrected.toString(),
      total_sent_raw: rawTotalSent,
      locked_funds: String(info.locked_funds ?? '0'),
      scanned_block_height: Number(info.scanned_block_height ?? 0),
      at: Date.now()
    }
  })
}

/** Exact display: all significant decimals, trailing zeros trimmed. */
function exactBDX(atomic: bigint): string {
  const whole = atomic / ATOMIC
  const frac = (atomic % ATOMIC).toString().padStart(DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

/** Display-units string for the send bridge ("1.25"), exact. */
function displayUnits(atomic: bigint): string {
  const whole = atomic / ATOMIC
  const frac = (atomic % ATOMIC).toString().padStart(DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

type Phase = 'review' | 'signing' | 'success' | 'failed'

export function SendApprovalCard({ reqId, origin, params, walletName, expect, onDone }: {
  reqId: string
  origin: string
  params: SendReqParams
  walletName: string
  /** Immutable approval context recorded when the request was queued —
   *  GET_SECRETS refuses if the session/wallet changed since review began. */
  expect: { walletId: string; generation: string | null }
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>('review')
  const [stepCode, setStepCode] = useState(0)
  const [error, setError] = useState('')
  const [txHash, setTxHash] = useState('')
  const [fee, setFee] = useState('')

  const amountAtomic = params.amount ? BigInt(params.amount) : null
  // Real pre-approval fee estimate via the WASM's estimated_tx_network_fee
  // (fed with the LWS's current per-byte fee). Null while loading / on failure
  // — the static heuristic text is the fallback.
  const [feeEstimate, setFeeEstimate] = useState<bigint | null>(null)

  useEffect(() => {
    if (phase !== 'review') return
    let stop = false
    ;(async () => {
      try {
        const s = await sendToBackground({ type: 'GET_SECRETS', expect })
        if (!s.ok || !s.secrets) return
        // Current network fee rates ride along on /get_unspent_outs
        // (wallet_light_rpc.h GET_UNSPENT_OUTS: per_byte_fee / per_kb_fee).
        const resp: any = await rawPost('/get_unspent_outs', {
          address: s.secrets.address, view_key: s.secrets.secViewKey,
          amount: '0', mixin: 9, use_dust: false, dust_threshold: '2000000000'
        })
        const bridge = await getBridge()
        const perB = resp?.per_byte_fee != null ? String(resp.per_byte_fee) : null
        const perKb = resp?.per_kb_fee != null ? String(resp.per_kb_fee) : null
        if (!perB && !perKb) return
        const fee: string = bridge.estimated_tx_network_fee(
          perKb, params.priority, perB, resp?.fee_per_o != null ? String(resp.fee_per_o) : perB, null
        )
        if (!stop && /^\d+$/.test(String(fee))) setFeeEstimate(BigInt(fee))
      } catch { /* keep the heuristic text */ }
    })()
    return () => { stop = true }
  }, [phase])

  // Keepalive: the signing flow + user reading time must outlive the MV3
  // service worker's ~30s idle timeout, or the dapp's reply channel dies.
  useEffect(() => {
    if (phase === 'success' || phase === 'failed') return
    const t = setInterval(() => { sendToBackground({ type: 'TOUCH' }).catch(() => {}) }, 15_000)
    return () => clearInterval(t)
  }, [phase])

  const reject = async () => {
    await sendToBackground({ type: 'DAPP_REJECT', reqId })
    onDone()
  }

  const approve = async () => {
    setPhase('signing'); setError(''); setStepCode(0)
    // Global single-flight send lock (shared with the panel's own send flow).
    const lock = await sendToBackground({ type: 'SEND_LOCK_ACQUIRE' })
    if (!lock.ok) { setError(lock.error); setPhase('review'); return }
    // Atomic PENDING -> EXECUTING BEFORE any construction (external audit):
    // this cancels the review timer and mints the execution token, so the
    // transaction can no longer be terminated by an approval timeout while it
    // broadcasts, and its outcome is recoverable if the channel dies.
    let operationId = ''
    let executionToken = ''
    try {
      const begin = await sendToBackground({ type: 'DAPP_BEGIN_SEND', reqId })
      if (!begin.ok) throw new Error(begin.error)
      operationId = begin.operationId ?? ''
      executionToken = begin.executionToken ?? ''

      // Bound fetch: fails if the wallet or session changed since this card
      // was rendered — the tx must be built with the DISPLAYED wallet's keys.
      const s = await sendToBackground({ type: 'GET_SECRETS', expect })
      if (!s.ok || !s.secrets) throw new Error(s.ok ? 'Wallet locked — unlock and retry' : s.error)

      const r = await sendFunds({
        secrets: s.secrets,
        toAddress: params.to,
        // Bridge expects DISPLAY units; convert exactly from atomic.
        amount: params.sweep ? '0' : displayUnits(amountAtomic!),
        priority: params.priority,
        isSweeping: params.sweep,
        onStatus: code => setStepCode(code)
      })

      const paidFee = r.used_fee ?? '0'
      setTxHash(r.tx_hash); setFee(paidFee)
      // Record locally so the tx shows in history IMMEDIATELY (⏳ pending),
      // before the LWS scanner indexes it — same store the panel's send uses.
      await addPendingLocal(s.secrets.address, {
        hash: r.tx_hash,
        sentAtomic: String(r.total_sent ?? params.amount ?? '0'),
        timestamp: new Date().toISOString()
      }).catch(() => {})
      // Publish a fresh key-image correction (this IS a WASM context) so the
      // background's balance overlay stays accurate after our spend — without
      // it, the raw LWS figures would collapse the dapp-visible balance to
      // zero until the panel's next correction pass.
      await publishCorrectedBalance(s.secrets).catch(() => {})
      // Records the broadcast outcome (durable) before replying to the dapp.
      await sendToBackground({
        type: 'DAPP_COMPLETE', reqId, operationId, executionToken,
        result: { txHash: r.tx_hash, fee: String(paidFee) }
      })
      setPhase('success')
    } catch (e: any) {
      // Full reason stays HERE in the wallet; the dapp gets a sanitized error.
      setError(e?.message ?? 'Transaction failed')
      // Pass the token so a post-begin failure is recorded as failed (lets the
      // dapp safely retry with the same idempotency key). Pre-begin failures
      // have no token and are handled as before.
      await sendToBackground({
        type: 'DAPP_FAIL', reqId,
        ...(operationId && executionToken ? { operationId, executionToken } : {})
      }).catch(() => {})
      setPhase('failed')
    } finally {
      await sendToBackground({ type: 'SEND_LOCK_RELEASE' }).catch(() => {})
    }
  }

  const box: React.CSSProperties = {
    fontSize: 11, wordBreak: 'break-all', background: '#0d0d0d',
    border: '1px solid var(--border)', padding: '8px 10px'
  }

  if (phase === 'signing') {
    return (
      <div className="card center">
        <h2>Sending…</h2>
        <p className="muted">{SEND_STEPS[stepCode] ?? 'Preparing…'}</p>
        <p className="warn">Do not close the wallet.</p>
      </div>
    )
  }

  if (phase === 'success') {
    return (
      <div className="card center">
        <h2>Transaction Sent</h2>
        <h4>Transaction hash</h4>
        <div style={box}>{txHash}</div>
        {fee && fee !== '0' && <p className="muted">Network fee: {exactBDX(BigInt(fee))} BDX</p>}
        <button className="btn-primary" style={{ width: '100%', marginTop: 10 }} onClick={onDone}>Done</button>
      </div>
    )
  }

  if (phase === 'failed') {
    return (
      <div className="card center">
        <h2>Transaction Failed</h2>
        <p className="error">{error}</p>
        <p className="muted">No funds left your wallet unless the error occurred after broadcast.</p>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={onDone}>Close</button>
      </div>
    )
  }

  return (
    <>
      <h2 style={{ textAlign: 'center' }}>Transaction Request</h2>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--green)', wordBreak: 'break-all',
        textAlign: 'center', border: '1px dashed var(--green)', padding: 12,
        marginBottom: 14, background: '#0d0d0d'
      }}>
        {origin}
      </div>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          This site asks <b>{walletName || 'your wallet'}</b> to send:
        </p>
        <h4>Amount</h4>
        <div style={{ ...box, fontSize: 15, fontWeight: 700 }}>
          {params.sweep ? 'ENTIRE SPENDABLE BALANCE (sweep)' : `${exactBDX(amountAtomic!)} BDX`}
        </div>
        <h4>To address — verify it in full</h4>
        <div style={box}>{params.to}</div>
        <h4>Priority</h4>
        <div style={box}>
          {params.priority}{params.priority === 5 ? ' — FLASH (instant, higher fee)' : ' — standard'}
        </div>
        <h4>Network fee</h4>
        <div style={box}>
          {feeEstimate !== null
            ? <>Estimated ≈ <b>{exactBDX(feeEstimate)} BDX</b> — exact fee is computed during
                signing and shown after broadcast.</>
            : <>Estimated ≈ 0.02–0.05 BDX{params.priority === 5 ? ' (flash pays more)' : ''} — exact
                fee is computed during signing and shown after broadcast.</>}
        </div>
      </div>
      <p className="warn center">
        ⚠ Beldex transactions are irreversible. Check the address and amount carefully.
      </p>
      <div className="row">
        <button className="btn-ghost" onClick={reject}>Reject</button>
        <button className="btn-primary" onClick={approve}>Approve &amp; Send</button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  )
}
