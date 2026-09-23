// MetaMask-style site-connection bar, pinned at the BOTTOM of the Dashboard:
//
//   ┌─────────────────────────────────────────────┐
//   │ (B)● bridge.beldex.io          [⛓̸] [▴]      │
//   │      Wallet 1                                │
//   └─────────────────────────────────────────────┘
//
// Shows the site in the user's ACTIVE tab (matched via its content-script
// port — no "tabs" permission, we never read URLs): green dot when connected
// to this wallet (with a one-click disconnect icon), grey dot when not.
// The ▴ chevron expands the full connected-sites list, each row with its own
// disconnect icon. Live-updates on grant changes + a light active-tab poll.

import { useEffect, useState } from 'react'
import { sendToBackground } from '../../lib/messages'

const GRANTS_KEY = 'dapp_origins' // keep in sync with src/background/dapp.ts
const ACTIVE_POLL_MS = 2500

export function UnlinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M5.17 11.75l-1.72 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}

export function useConnectedSites() {
  const [origins, setOrigins] = useState<Array<{ origin: string; grantedAt: number }>>([])

  const load = () =>
    sendToBackground({ type: 'DAPP_LIST_ORIGINS' })
      .then(r => { if (r.ok) setOrigins(r.origins ?? []) })
      .catch(() => {})

  useEffect(() => {
    load()
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && GRANTS_KEY in changes) load()
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const disconnect = async (origin: string) => {
    await sendToBackground({ type: 'DAPP_REVOKE_ORIGIN', origin })
    load()
  }

  return { origins, disconnect }
}

/** Compact hostname for display ("https://app.example.com" → "app.example.com"). */
function host(origin: string): string {
  try { return new URL(origin).host } catch { return origin }
}

function SiteAvatar({ origin, connected }: { origin: string; connected: boolean }) {
  const letter = host(origin).replace(/^www\./, '').charAt(0).toUpperCase() || '?'
  return (
    <span style={{ position: 'relative', flex: 'none', width: 28, height: 28 }}>
      <span style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, borderRadius: '50%',
        background: '#1a1a1a', border: '1px solid var(--border)',
        fontSize: 13, fontWeight: 700, color: 'var(--text)'
      }}>
        {letter}
      </span>
      <span style={{
        position: 'absolute', right: -1, bottom: -1, width: 9, height: 9,
        borderRadius: '50%', border: '2px solid var(--bg)',
        background: connected ? 'var(--green)' : '#555'
      }} />
    </span>
  )
}

export function SiteConnectionBar({ walletName }: { walletName: string }) {
  const { origins, disconnect } = useConnectedSites()
  const [active, setActive] = useState<{ origin: string; connected: boolean } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let stop = false
    const poll = () =>
      sendToBackground({ type: 'DAPP_ACTIVE_SITE' })
        .then(r => { if (!stop && r.ok) setActive(r.activeSite ?? null) })
        .catch(() => {})
    poll()
    const t = setInterval(poll, ACTIVE_POLL_MS)
    return () => { stop = true; clearInterval(t) }
  }, [])

  // Nothing useful to show: no site in the active tab and nothing connected.
  if (!active && origins.length === 0) return null

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 0', borderBottom: '1px solid #191919'
  }

  return (
    // Pinned to the FAR bottom of the panel, set off from the content above by
    // a full-width divider so the connection status reads as its own footer.
    <div style={{ marginTop: 'auto', paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      {open && (
        <div className="card" style={{ marginBottom: 0, borderBottom: 'none', padding: '6px 12px' }}>
          <p className="muted" style={{ margin: '4px 0 2px', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            Connected sites
          </p>
          {origins.length === 0 && <p className="muted" style={{ margin: '6px 0' }}>No connected sites.</p>}
          {origins.map(o => (
            <div key={o.origin} title={o.origin} style={rowStyle}>
              <SiteAvatar origin={o.origin} connected />
              <span style={{ flex: 1, fontSize: 11, wordBreak: 'break-all' }}>{host(o.origin)}</span>
              <button className="btn-icon" title={`Disconnect ${host(o.origin)}`}
                style={{ padding: '3px 7px', color: 'var(--red)', borderColor: '#2a1717' }}
                onClick={() => disconnect(o.origin)}>
                <UnlinkIcon />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{
        marginBottom: 0, padding: '9px 12px',
        display: 'flex', alignItems: 'center', gap: 10
      }}>
        {active ? (
          <>
            <SiteAvatar origin={active.origin} connected={active.connected} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={active.origin}>
                {host(active.origin)}
              </div>
              <div className="muted" style={{ fontSize: 10 }}>
                {active.connected ? (walletName || 'Connected') : 'Not connected'}
              </div>
            </div>
            {active.connected && (
              <button className="btn-icon" title={`Disconnect ${host(active.origin)}`}
                style={{ padding: '4px 8px', color: 'var(--red)', borderColor: '#2a1717' }}
                onClick={() => disconnect(active.origin)}>
                <UnlinkIcon />
              </button>
            )}
          </>
        ) : (
          <>
            <span style={{ color: 'var(--green)', fontSize: 9 }}>●</span>
            <span style={{ flex: 1, fontSize: 11, color: 'var(--text-dim)' }}>
              {origins.length} connected {origins.length === 1 ? 'site' : 'sites'}
            </span>
          </>
        )}
        {origins.length > 0 && (
          <button className="btn-icon" style={{ padding: '4px 8px' }}
            title="All connected sites" onClick={() => setOpen(o => !o)}>
            {open ? '▾' : '▴'}
          </button>
        )}
      </div>
    </div>
  )
}
