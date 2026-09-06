// Dapp sign-in approval (bdx_signAuthChallenge). A variant of SignApprovalCard
// for wallet-composed authentication proofs.
//
// The statement being signed is composed by the WALLET (in the background) from
// the origin it observed — the page only supplied the server nonce. This card
// shows the requesting origin prominently, the parsed fields, and the exact
// full statement text, so the user confirms the domain they are signing in to.
//
// Signing uses the same SigV1 path as SignApprovalCard; it settles through
// DAPP_AUTH_SIGN_COMPLETE, whose result carries the exact signed message.

import { useEffect, useState } from 'react'
import { sendToBackground } from '../../lib/messages'
import { signMessage } from '../../lib/signMessage'

export interface AuthSignReqParams {
  message: string
  fields: {
    domain: string; uri: string; address: string; network: string
    nonce: string; iat: number; exp: number; requestId?: string
  }
}

type Phase = 'review' | 'signing' | 'failed'

export function AuthSignApprovalCard({ reqId, origin, params, walletName, expect, onDone }: {
  reqId: string
  origin: string
  params: AuthSignReqParams
  walletName: string
  /** Immutable approval context — GET_SECRETS refuses if it changed. */
  expect: { walletId: string; generation: string | null }
  onDone: () => void
}) {
  const [phase, setPhase] = useState<Phase>('review')
  const [error, setError] = useState('')

  useEffect(() => {
    const t = setInterval(() => { sendToBackground({ type: 'TOUCH' }).catch(() => {}) }, 15_000)
    return () => clearInterval(t)
  }, [])

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
        type: 'DAPP_AUTH_SIGN_COMPLETE', reqId,
        result: { message: params.message, signature, address: s.secrets.address }
      })
      if (!r.ok) throw new Error(r.error)
      onDone()
    } catch (e) {
      setPhase('failed')
      setError(e instanceof Error ? e.message : 'Signing failed.')
      await sendToBackground({ type: 'DAPP_FAIL', reqId }).catch(() => {})
    }
  }

  const f = params.fields
  const expiryText = new Date(f.exp).toLocaleString()
  const rowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11, padding: '3px 0' }
  const keyStyle: React.CSSProperties = { color: 'var(--muted, #999)' }
  const valStyle: React.CSSProperties = { wordBreak: 'break-all', textAlign: 'right' }

  return (
    <>
      <h2 style={{ textAlign: 'center' }}>Sign-in Request</h2>
      <div style={{
        fontSize: 14, fontWeight: 700, color: 'var(--green)', wordBreak: 'break-all',
        textAlign: 'center', border: '1px dashed var(--green)', padding: 12,
        marginBottom: 14, background: '#0d0d0d'
      }}>
        {origin}
      </div>

      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          This site wants to prove you control <b>{walletName || 'your wallet'}</b> to sign in.
          The domain below is set by the wallet, not the page.
        </p>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
          <div style={rowStyle}><span style={keyStyle}>Domain</span><span style={valStyle}><b>{f.domain}</b></span></div>
          <div style={rowStyle}><span style={keyStyle}>Expires</span><span style={valStyle}>{expiryText}</span></div>
          <div style={rowStyle}><span style={keyStyle}>Nonce</span><span style={valStyle}>{f.nonce}</span></div>
          {f.requestId !== undefined && (
            <div style={rowStyle}><span style={keyStyle}>Request&nbsp;ID</span><span style={valStyle}>{f.requestId}</span></div>
          )}
        </div>

        <h4>Exact statement to sign</h4>
        <div style={{
          fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all', whiteSpace: 'pre-wrap',
          background: '#0d0d0d', border: '1px solid var(--border)', padding: '10px 12px',
          maxHeight: 160, overflowY: 'auto', fontFamily: 'monospace'
        }}>
          {params.message}
        </div>
        <p className="muted">✓ Proves you control this wallet’s address to {f.domain}</p>
        <p className="muted">✗ Does <b>not</b> move funds and does <b>not</b> reveal your keys</p>
      </div>

      <p className="warn center">
        ⚠ Only sign in to a site you trust. Confirm the domain above matches the
        site you intended to use.
      </p>

      {phase === 'signing' ? (
        <p className="center muted">Signing…</p>
      ) : (
        <div className="row">
          <button className="btn-ghost" onClick={reject}>Reject</button>
          <button className="btn-primary" onClick={approve}>Sign in</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </>
  )
}
