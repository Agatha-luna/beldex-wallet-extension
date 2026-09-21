// Dapp message-signing approval. Rendered in the panel (preferred) or the
// approval.html popup (fallback) — the same two surfaces as SendApprovalCard.
//
// Signing happens HERE rather than in the service worker: the spend key lives
// in the panel session, and the background never sees key material.
//
// Audit posture, mirroring the send card:
// - The FULL message is shown, untruncated and unrendered, in a monospace
//   block. The user must be able to read exactly what they are signing; the
//   router rejects control characters and anything over 512 chars so nothing
//   can hide off-screen.
// - The origin is shown as the browser reports it (punycode, not unicode) so
//   homograph lookalikes stay visible.
// - What a signature does — and does not — authorise is stated plainly.

import { useState } from 'react'
import { sendToBackground } from '../../lib/messages'
import { signMessage } from '../../lib/signMessage'
import { useApprovalKeepalive } from '../useApprovalKeepalive'

export interface SignReqParams {
  message: string
}

type Phase = 'review' | 'signing' | 'failed'

export function SignApprovalCard({ reqId, origin, params, walletName, expect, onDone }: {
  reqId: string
  origin: string
  params: SignReqParams
  walletName: string
  /** Immutable approval context recorded when the request was queued —
   *  GET_SECRETS refuses if the session/wallet changed since review began. */
  expect: { walletId: string; generation: string | null }
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>('review')
  const [error, setError] = useState('')

  // Warm the worker without re-arming auto-lock (see ConnectApprovalCard).
  useApprovalKeepalive()

  const reject = async () => {
    await sendToBackground({ type: 'DAPP_REJECT', reqId })
    onDone()
  }

  const approve = async () => {
    setPhase('signing'); setError('')
    try {
      const s = await sendToBackground({ type: 'GET_SECRETS', expect })
      if (!s.ok || !s.secrets) throw new Error(s.ok ? 'Wallet is locked — unlock and try again.' : s.error)

      const { signature, pubkey } = signMessage(
        params.message, s.secrets.secSpendKey, s.secrets.pubSpendKey
      )
      if (pubkey !== s.secrets.pubSpendKey) throw new Error('Signing key mismatch.')

      const r = await sendToBackground({
        type: 'DAPP_SIGN_COMPLETE', reqId,
        result: { signature, address: s.secrets.address }
      })
      if (!r.ok) throw new Error(r.error)
      onDone()
    } catch (e) {
      setPhase('failed')
      setError(e instanceof Error ? e.message : 'Signing failed.')
      // Sanitized on the wire (spec §6): the page only learns it failed.
      await sendToBackground({ type: 'DAPP_FAIL', reqId }).catch(() => {})
    }
  }

  return (
    <>
      <h2 style={{ textAlign: 'center' }}>Signature Request</h2>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--green)', wordBreak: 'break-all',
        textAlign: 'center', border: '1px dashed var(--green)', padding: 12,
        marginBottom: 14, background: '#0d0d0d'
      }}>
        {origin}
      </div>

      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          This site is asking <b>{walletName || 'your wallet'}</b> to sign the message below.
        </p>
        <h4>Message</h4>
        <div style={{
          fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all', whiteSpace: 'pre-wrap',
          background: '#0d0d0d', border: '1px solid var(--border)', padding: '10px 12px',
          maxHeight: 180, overflowY: 'auto', fontFamily: 'monospace'
        }}>
          {params.message}
        </div>
        <p className="muted">✓ Proves you control this wallet’s address</p>
        <p className="muted">✗ Does <b>not</b> move funds and does <b>not</b> reveal your keys</p>
      </div>

      <p className="warn center">
        ⚠ Only sign messages you asked for. Read the text above — signing proves
        this wallet is yours to whoever receives it.
      </p>

      {phase === 'signing' ? (
        <p className="center muted">Signing…</p>
      ) : (
        <div className="row">
          <button className="btn-ghost" onClick={reject}>Reject</button>
          <button className="btn-primary" onClick={approve}>Sign</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  )
}
