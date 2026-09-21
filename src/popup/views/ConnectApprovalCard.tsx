// Dapp connection request rendered INSIDE the wallet panel (the preferred
// surface — the standalone approval.html popup is the fallback when no panel
// can be opened).
//
// Anti-phishing: the origin is shown exactly as the browser reports it
// (ASCII/punycode form) — deliberately NOT decoded to unicode, so homograph
// lookalikes (xn--…) stay visible.

import { useState } from 'react'
import { sendToBackground } from '../../lib/messages'
import { useApprovalKeepalive } from '../useApprovalKeepalive'

export function ConnectApprovalCard({ reqId, origin, walletName, address, onDone }: {
  reqId: string
  origin: string
  walletName: string
  address: string
  onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Keep the MV3 worker warm (so the dapp's port survives a long review)
  // WITHOUT re-arming auto-lock; only genuine input in this surface does that.
  useApprovalKeepalive()

  const decide = async (approve: boolean) => {
    setBusy(true); setError('')
    const r = approve
      ? await sendToBackground({ type: 'DAPP_APPROVE', reqId })
      : await sendToBackground({ type: 'DAPP_REJECT', reqId })
    setBusy(false)
    if (r.ok) onDone()
    else setError(r.error)
  }

  return (
    <>
      <h2 style={{ textAlign: 'center' }}>Connection Request</h2>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--green)', wordBreak: 'break-all',
        textAlign: 'center', border: '1px dashed var(--green)', padding: 12,
        marginBottom: 14, background: '#0d0d0d'
      }}>
        {origin}
      </div>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          This site wants to connect to <b>{walletName || 'your wallet'}</b>. It will be able to:
        </p>
        <p className="muted">✓ See your wallet address</p>
        <p className="muted">✓ See your balance</p>
        <p className="muted">✗ It can <b>not</b> access your keys or move funds without a separate approval.</p>
        <h4>Address that will be shared</h4>
        <div style={{
          fontSize: 11, wordBreak: 'break-all', background: '#0d0d0d',
          border: '1px solid var(--border)', padding: '8px 10px'
        }}>
          {address}
        </div>
      </div>
      <p className="warn center">⚠ Verify the site address above is exactly the site you expect.</p>
      <div className="row">
        <button className="btn-ghost" disabled={busy} onClick={() => decide(false)}>Reject</button>
        <button className="btn-primary" disabled={busy} onClick={() => decide(true)}>Connect</button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  )
}
