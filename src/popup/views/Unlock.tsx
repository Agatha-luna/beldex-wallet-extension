import { useState } from 'react'
import { sendToBackground, WalletMeta } from '../../lib/messages'
import { truncateMiddle } from '../../lib/format'
import { Onboarding } from './Onboarding'
import { CONFIG } from '../../lib/config'

export function Unlock({ walletName, wallets, onChanged }:
  { walletName: string; wallets: WalletMeta[]; onChanged: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  // "Create new wallet" from the login screen: full onboarding (create/restore
  // + seed quiz), saved as an additional wallet alongside the locked ones.
  if (adding) {
    return <Onboarding addMode onDone={onChanged} onCancel={() => setAdding(false)} />
  }

  // Only wallets on the active chain: SWITCH_WALLET refuses the others, and
  // bringing one onto this chain needs an unlocked session, which we do not
  // have here. They are offered in wallet selection instead.
  const others = wallets.filter(w => !w.active && w.networks.includes(CONFIG.NETWORK))

  const unlock = async () => {
    setBusy(true)
    const r = await sendToBackground({ type: 'UNLOCK', password })
    setBusy(false)
    if (r.ok) onChanged()
    else setError(r.error)
  }

  const switchTo = async (id: string) => {
    setError(''); setPassword('')
    await sendToBackground({ type: 'SWITCH_WALLET', id })
    onChanged()
  }

  return (
    <div className="wrap" style={{ paddingTop: 60 }}>
      <div className="center" style={{ marginBottom: 24 }}>
        <div className="brand lg" style={{ justifyContent: 'center' }}>
          <img src="icons/logo.svg" alt="" />
          Beldex
        </div>
        <h2 style={{ marginTop: 18, marginBottom: 4 }}>{walletName || 'Welcome back'}</h2>
        <p className="tagline">Unlock this wallet</p>
        {/* Which chain this wallet will open on. The network switcher lives in
            Settings, which is unreachable while locked, so stating it here keeps
            a locked user from wondering where they are. */}
        <span className={CONFIG.IS_TESTNET ? 'net-badge' : 'net-label'}>{CONFIG.NETWORK_LABEL}</span>
      </div>
      <div className="card">
        <input type="password" autoFocus placeholder="Password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && unlock()} />
        <button className="btn-primary" disabled={busy || !password} onClick={unlock}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}
      </div>

      <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setAdding(true)}>
        + Create new wallet
      </button>

      {others.length > 0 && (
        <>
          <h4>Other wallets</h4>
          <div className="card" style={{ padding: '4px 0' }}>
            {others.map(w => (
              <div className="menu-item" key={w.id} onClick={() => switchTo(w.id)}>
                <span>
                  {w.name}
                  {w.address && <span className="muted" style={{ marginLeft: 8, fontSize: 10 }}>
                    {truncateMiddle(w.address, 6)}
                  </span>}
                </span>
                <span className="chev">›</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
