import { useEffect, useState } from 'react'
import { sendToBackground, WalletSecrets } from '../../lib/messages'
import { truncateUnlessTab } from '../../lib/format'
import { copySecret, clearSecretNow } from '../../lib/clipboard'
import { useConnectedSites, UnlinkIcon } from './ConnectedSitesBadge'

const REVEAL_SECONDS = 30 // revealed secrets auto-hide after this long

type Item = 'menu' | 'seed' | 'viewKey' | 'spendKey' | 'password' | 'autolock' | 'rename' | 'delete' | 'sites'

const AUTOLOCK_OPTIONS = [5, 15, 30, 60] // minutes

function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  )
}

const SECRET_LABELS: Record<string, { title: string; field: keyof WalletSecrets; note: string }> = {
  seed: {
    title: 'Recovery Seed',
    field: 'mnemonic',
    note: 'Anyone with these 25 words can spend your funds. Never share them.'
  },
  viewKey: {
    title: 'Private View Key',
    field: 'secViewKey',
    note: 'Allows viewing incoming transactions. Cannot spend funds.'
  },
  spendKey: {
    title: 'Private Spend Key',
    field: 'secSpendKey',
    note: 'Anyone with this key can spend your funds. Never share it.'
  }
}

export function Settings({ walletName, onBack, onWiped, onChanged }:
  { walletName: string; onBack: () => void; onWiped: () => void; onChanged: () => void }) {
  const [item, setItem] = useState<Item>('menu')
  const [password, setPassword] = useState('')
  const [revealed, setRevealed] = useState<WalletSecrets | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [okMsg, setOkMsg] = useState('')
  const [busy, setBusy] = useState(false)

  // change password form
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')

  // rename wallet form
  const [newName, setNewName] = useState(walletName)

  // delete confirmation modal
  const [showDeleteModal, setShowDeleteModal] = useState(false)

  // secrets stay masked until the user explicitly reveals them with the eye
  const [valueVisible, setValueVisible] = useState(false)

  // auto-lock duration
  const [autoLock, setAutoLock] = useState<number | null>(null)
  // hide amount in incoming-funds notifications (default off)
  const [hideNotifAmount, setHideNotifAmount] = useState(false)
  useEffect(() => {
    sendToBackground({ type: 'GET_AUTOLOCK' }).then(r => {
      if (r.ok && r.minutes) setAutoLock(r.minutes)
    })
    chrome.storage.local.get('notif_hide_amount').then(o => setHideNotifAmount(o['notif_hide_amount'] === true))
  }, [])

  const toggleNotifAmount = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !hideNotifAmount
    setHideNotifAmount(next)
    await chrome.storage.local.set({ notif_hide_amount: next })
  }

  // auto-hide countdown for revealed secrets
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS)
  useEffect(() => {
    if (!revealed) return
    setSecondsLeft(REVEAL_SECONDS)
    const t = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) { setRevealed(null); setPassword(''); return REVEAL_SECONDS }
        return s - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [revealed])

  const reset = () => {
    setPassword(''); setRevealed(null); setError(''); setOkMsg('')
    setNewPw(''); setConfirmPw(''); setCopied(false); setShowDeleteModal(false)
    setValueVisible(false)
    clearSecretNow() // don't leave a copied secret on the clipboard when leaving a screen
  }
  const go = (i: Item) => { reset(); setItem(i) }

  // Clear any copied secret when Settings unmounts (panel closed, locked, etc.),
  // since the 60s timed clear can't run once the panel is gone.
  useEffect(() => () => clearSecretNow(), [])

  const reveal = async () => {
    setBusy(true); setError('')
    const r = await sendToBackground({ type: 'REVEAL', password })
    setBusy(false)
    if (r.ok && r.secrets) setRevealed(r.secrets)
    else setError(r.ok ? 'Failed' : r.error)
  }

  const changePassword = async () => {
    setError(''); setOkMsg('')
    if (newPw.length < 8) { setError('New password must be at least 8 characters'); return }
    if (newPw !== confirmPw) { setError('New passwords do not match'); return }
    setBusy(true)
    const r = await sendToBackground({ type: 'CHANGE_PASSWORD', oldPassword: password, newPassword: newPw })
    setBusy(false)
    if (r.ok) { setOkMsg('Password changed'); setPassword(''); setNewPw(''); setConfirmPw('') }
    else setError(r.error)
  }

  const [deletePw, setDeletePw] = useState('')
  const doDelete = async () => {
    setError('')
    const r = await sendToBackground({ type: 'WIPE', password: deletePw })
    if (r.ok) onWiped()
    else setError(r.error)
  }

  const copyValue = async (v: string) => {
    await copySecret(v) // secret material: auto-clears the clipboard after 60s
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // ---- secret reveal screens (seed / view key / spend key) ----
  if (item === 'seed' || item === 'viewKey' || item === 'spendKey') {
    const cfg = SECRET_LABELS[item]
    const value = revealed ? String(revealed[cfg.field]) : null
    return (
      <div className="card">
        <h2>{cfg.title}</h2>
        {!value ? (
          <>
            <p className="muted">Enter your password to reveal.</p>
            <input type="password" autoFocus placeholder="Password" value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && password && reveal()} />
            <div className="row">
              <button className="btn-ghost" onClick={() => go('menu')}>Back</button>
              <button className="btn-primary" disabled={busy || !password} onClick={reveal}>
                {busy ? '…' : 'Reveal'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span className="muted">Auto-hides in {secondsLeft}s</span>
              <button className="btn-icon" title={valueVisible ? 'Hide' : 'Show'}
                onClick={() => setValueVisible(v => !v)}>
                <EyeIcon off={valueVisible} />
              </button>
            </div>
            {/* masked by default; keys show first/last 15 chars, the seed in full (it must be written down) */}
            <div className="seed">
              {!valueVisible
                ? (item === 'seed'
                    // mask each seed word individually so the block wraps like real words
                    ? value.split(/\s+/).map(w => '•'.repeat(Math.min(w.length, 8))).join(' ')
                    : '•'.repeat(15) + '...' + '•'.repeat(15))
                : item === 'seed' ? value : truncateUnlessTab(value)}
            </div>
            <p className="warn">⚠ {cfg.note}</p>
            <div className="row">
              <button className="btn-ghost" onClick={() => go('menu')}>Back</button>
              {/* copies the real value even while the display is masked */}
              <button className="btn-primary" onClick={() => copyValue(value)}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <p className="muted center" style={{ marginTop: 6, fontSize: 10 }}>
              Clipboard clears after 60s, or when you leave this screen
            </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  // ---- change password ----
  if (item === 'password') {
    return (
      <div className="card">
        <h2>Change Password</h2>
        <input type="password" autoFocus placeholder="Current password" value={password}
          onChange={e => setPassword(e.target.value)} />
        <input type="password" placeholder="New password (min 8 chars)" value={newPw}
          onChange={e => setNewPw(e.target.value)} />
        <input type="password" placeholder="Confirm new password" value={confirmPw}
          onChange={e => setConfirmPw(e.target.value)} />
        <div className="row">
          <button className="btn-ghost" onClick={() => go('menu')}>Back</button>
          <button className="btn-primary" disabled={busy || !password || !newPw || !confirmPw} onClick={changePassword}>
            {busy ? '…' : 'Change'}
          </button>
        </div>
        {okMsg && <p className="ok">✓ {okMsg}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  // ---- rename wallet ----
  if (item === 'rename') {
    return (
      <div className="card">
        <h2>Rename Wallet</h2>
        <input autoFocus placeholder="Wallet name" value={newName}
          onChange={e => setNewName(e.target.value)} />
        <div className="row">
          <button className="btn-ghost" onClick={() => go('menu')}>Back</button>
          <button className="btn-primary" disabled={!newName.trim()} onClick={async () => {
            const r = await sendToBackground({ type: 'RENAME_WALLET', name: newName })
            if (r.ok) { setOkMsg('Renamed'); onChanged() }
            else setError(r.error)
          }}>Save</button>
        </div>
        {okMsg && <p className="ok">✓ {okMsg}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  // ---- auto-lock duration ----
  if (item === 'autolock') {
    const pick = async (m: number) => {
      setError('')
      const r = await sendToBackground({ type: 'SET_AUTOLOCK', minutes: m })
      if (r.ok) { setAutoLock(m); setOkMsg(`Auto-lock set to ${m} minutes`) }
      else setError(r.error)
    }
    return (
      <div className="card">
        <h2>Auto-Lock</h2>
        <p className="muted">
          Lock the wallet after this long without activity. Only your own
          interaction (clicks, typing, focusing a wallet window) counts —
          a dApp request waiting for approval will not keep it unlocked.
        </p>
        <div className="row" style={{ marginBottom: 10 }}>
          {AUTOLOCK_OPTIONS.map(m => (
            <button key={m} className={autoLock === m ? 'btn-primary' : 'btn-ghost'} onClick={() => pick(m)}>
              {m >= 60 ? `${m / 60}h` : `${m}m`}
            </button>
          ))}
        </div>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={() => go('menu')}>Back</button>
        {okMsg && <p className="ok">✓ {okMsg}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    )
  }

  // ---- connected sites (dapp bridge grants for the active wallet) ----
  if (item === 'sites') {
    return <ConnectedSites walletName={walletName} onBack={() => go('menu')} />
  }

  // ---- delete wallet ----
  if (item === 'delete') {
    return (
      <div className="card">
        <h2>Delete Wallet</h2>
        <p className="muted">
          This removes <b>{walletName || 'this wallet'}</b> and its encrypted vault from
          this browser. Other wallets are not affected. Your funds remain on the
          Beldex blockchain.
        </p>
        <div className="row">
          <button className="btn-ghost" onClick={() => go('menu')}>Back</button>
          <button className="btn-danger" onClick={() => setShowDeleteModal(true)}>Delete wallet</button>
        </div>

        {showDeleteModal && (
          <div className="modal-overlay" onClick={() => setShowDeleteModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Are you sure?</h2>
              <p className="warn">
                ⚠ Once deleted, this wallet can be restored only using your seed.
                If you haven't written down your 25-word recovery seed, do it before deleting.
              </p>
              <input type="password" autoFocus placeholder="Enter password to confirm"
                value={deletePw} onChange={e => setDeletePw(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && deletePw && doDelete()} />
              <div className="row">
                <button className="btn-ghost" onClick={() => { setShowDeleteModal(false); setDeletePw(''); setError('') }}>Cancel</button>
                <button className="btn-danger" disabled={!deletePw} onClick={doDelete}>Delete</button>
              </div>
              {error && <p className="error" style={{ marginBottom: 0 }}>{error}</p>}
            </div>
          </div>
        )}
      </div>
    )
  }

  // ---- menu ----
  return (
    <div className="card" style={{ padding: '8px 0' }}>
      <h2 style={{ padding: '8px 16px 4px' }}>Settings</h2>
      <div className="menu-item" onClick={() => go('seed')}>
        <span>Show Recovery Seed</span><span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={() => go('viewKey')}>
        <span>Show Private View Key</span><span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={() => go('spendKey')}>
        <span>Show Private Spend Key</span><span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={() => { setNewName(walletName); go('rename') }}>
        <span>Rename Wallet {walletName ? `(${walletName})` : ''}</span><span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={() => go('password')}>
        <span>Change Password</span><span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={() => go('autolock')}>
        <span>Auto-Lock {autoLock ? `(${autoLock >= 60 ? `${autoLock / 60}h` : `${autoLock}m`})` : ''}</span>
        <span className="chev">›</span>
      </div>
      <div className="menu-item" onClick={toggleNotifAmount}>
        <span>Hide amount in notifications</span>
        <span className={`switch ${hideNotifAmount ? 'on' : ''}`}><span className="knob" /></span>
      </div>
      <div className="menu-item" onClick={() => go('sites')}>
        <span>Connected Sites</span><span className="chev">›</span>
      </div>
      <div className="menu-item danger" onClick={() => go('delete')}>
        <span>Delete Wallet</span><span className="chev">›</span>
      </div>
      <div style={{ padding: '10px 16px 4px' }}>
        <button className="btn-ghost" style={{ width: '100%' }} onClick={onBack}>Back</button>
      </div>
    </div>
  )
}

// Sites this wallet is connected to via the dapp bridge (bdx-web3js). Grants
// are per (origin, wallet); disconnecting fires a `disconnect` event to the site.
function ConnectedSites({ walletName, onBack }: { walletName: string; onBack: () => void }) {
  const { origins, disconnect } = useConnectedSites()

  return (
    <div className="card">
      <h2>Connected Sites</h2>
      <p className="muted">
        Sites allowed to see <b>{walletName || 'this wallet'}</b>'s address and balance.
        Transactions always require separate approval.
      </p>
      {origins.length === 0 && <p className="muted">No connected sites.</p>}
      {origins.map(o => (
        <div key={o.origin} title={o.origin} style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0',
          borderBottom: '1px solid #191919'
        }}>
          <span style={{ color: 'var(--green)', fontSize: 9 }}>●</span>
          <span style={{ flex: 1, wordBreak: 'break-all', fontSize: 11 }}>{o.origin}</span>
          <button className="btn-icon" title="Disconnect this site" onClick={() => disconnect(o.origin)}>
            <UnlinkIcon />
          </button>
        </div>
      ))}
      <button className="btn-ghost" style={{ width: '100%', marginTop: 12 }} onClick={onBack}>Back</button>
    </div>
  )
}
