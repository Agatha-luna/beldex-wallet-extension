// Approval window (approval.html?reqId=…) — the FALLBACK surface, used when
// the request couldn't be shown inside the side panel. Renders the same
// approval cards as the panel (ConnectApprovalCard / SendApprovalCard), so
// behavior is identical; only the chrome around them differs.
//
// The origin is displayed exactly as the browser reports it (ASCII/punycode
// form) — deliberately NOT decoded to unicode, so homograph lookalikes stay
// visible.

import { useEffect, useState } from 'react'
import { sendToBackground, PendingApproval } from '../lib/messages'
import { ConnectApprovalCard } from '../popup/views/ConnectApprovalCard'
import { SendApprovalCard, SendReqParams } from '../popup/views/SendApprovalCard'
import { SignApprovalCard, SignReqParams } from '../popup/views/SignApprovalCard'
import { AuthSignApprovalCard, AuthSignReqParams } from '../popup/views/AuthSignApprovalCard'

type Phase = 'loading' | 'expired' | 'unlock' | 'confirm'

export function ApprovalApp() {
  const reqId = new URLSearchParams(location.search).get('reqId') ?? ''

  const [phase, setPhase] = useState<Phase>('loading')
  const [pending, setPending] = useState<PendingApproval | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')

  const load = async () => {
    const p = await sendToBackground({ type: 'DAPP_GET_PENDING', reqId })
    if (!p.ok || !p.pending) {
      setError(p.ok ? 'Request not found' : p.error)
      setPhase('expired')
      return
    }
    // Wallet identity is rendered from the request's IMMUTABLE record (the
    // wallet shown when it was queued) — never re-read from current state,
    // which can change under this window (external audit). GET_STATE is used
    // only for locked/unlocked; if the ACTIVE wallet is no longer the
    // request's wallet, the request is void (the background also enforces
    // this at approve/secrets time — this just fails it early and clearly).
    setPending(p.pending)
    const state = await sendToBackground({ type: 'GET_STATE' })
    if (!state.ok) {
      setError(state.error)
      setPhase('expired')
      return
    }
    const activeWallet = state.wallets?.find(w => w.active)
    if (activeWallet && activeWallet.id !== p.pending.walletId) {
      setError('The active wallet changed — this request is no longer valid. Retry from the site.')
      setPhase('expired')
      await sendToBackground({ type: 'DAPP_REJECT', reqId }).catch(() => {})
      return
    }
    setPhase(state.state === 'unlocked' ? 'confirm' : 'unlock')
  }

  useEffect(() => { load() }, [])

  // Keepalive: without messages the MV3 service worker idles out (~30s),
  // severing the dapp's port. TOUCH every 15s keeps it warm. (The cards run
  // their own keepalive too once mounted — harmless overlap.)
  useEffect(() => {
    if (phase === 'expired') return
    const t = setInterval(() => { sendToBackground({ type: 'TOUCH' }).catch(() => {}) }, 15_000)
    return () => clearInterval(t)
  }, [phase])

  const unlock = async () => {
    setBusy(true); setError('')
    const r = await sendToBackground({ type: 'UNLOCK', password })
    setBusy(false)
    if (r.ok) { setPassword(''); await load() }
    else setError(r.error)
  }

  const rejectAndClose = async () => {
    await sendToBackground({ type: 'DAPP_REJECT', reqId }).catch(() => {})
    window.close()
  }

  // Closing the window without deciding = reject (background's windows.onRemoved).

  return (
    <div className="wrap">
      <div className="brand"><img src="icons/logo.svg" alt="" />Beldex</div>

      {phase === 'loading' && <p className="muted center">Loading…</p>}

      {phase === 'expired' && (
        <div className="card center">
          <h2>Request Expired</h2>
          <p className="muted">{error || 'This request is no longer pending.'}</p>
          <button className="btn-ghost" style={{ width: '100%' }} onClick={() => window.close()}>Close</button>
        </div>
      )}

      {phase === 'unlock' && pending && (
        <>
          <h2>{pending.method === 'bdx_sendTransaction' ? 'Transaction Request'
            : pending.method === 'bdx_signMessage' ? 'Signature Request'
            : pending.method === 'bdx_signAuthChallenge' ? 'Sign-in Request'
            : 'Connection Request'}</h2>
          <div className="origin">{pending.origin}</div>
          <div className="card">
            <p className="muted">
              Unlock <b>{pending.walletName || 'your wallet'}</b> to review this request.
            </p>
            <input type="password" autoFocus placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && password && unlock()} />
            <button className="btn-primary" disabled={busy || !password} onClick={unlock}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            {error && <p className="error">{error}</p>}
          </div>
          <button className="btn-ghost" onClick={rejectAndClose}>Reject request</button>
        </>
      )}

      {phase === 'confirm' && pending && (
        pending.method === 'bdx_sendTransaction' ? (
          <SendApprovalCard
            reqId={reqId}
            origin={pending.origin}
            params={pending.params as unknown as SendReqParams}
            walletName={pending.walletName}
            expect={{ walletId: pending.walletId, generation: pending.sessionGeneration }}
            onDone={() => window.close()}
          />
        ) : pending.method === 'bdx_signMessage' ? (
          <SignApprovalCard
            reqId={reqId}
            origin={pending.origin}
            params={pending.params as unknown as SignReqParams}
            walletName={pending.walletName}
            expect={{ walletId: pending.walletId, generation: pending.sessionGeneration }}
            onDone={() => window.close()}
          />
        ) : pending.method === 'bdx_signAuthChallenge' ? (
          <AuthSignApprovalCard
            reqId={reqId}
            origin={pending.origin}
            params={pending.params as unknown as AuthSignReqParams}
            walletName={pending.walletName}
            expect={{ walletId: pending.walletId, generation: pending.sessionGeneration }}
            onDone={() => window.close()}
          />
        ) : (
          <ConnectApprovalCard
            reqId={reqId}
            origin={pending.origin}
            walletName={pending.walletName}
            address={pending.walletAddress}
            onDone={() => window.close()}
          />
        )
      )}
    </div>
  )
}
