import { useEffect, useRef, useState } from 'react'
import { sendToBackground, WalletMeta, WalletSecrets } from '../../lib/messages'
import { Onboarding } from './Onboarding'
import { correctedTotalSent } from '../../lib/spent'
import { ATOMIC, fmtBDX, parseAtomic, toAtomic, absBig, toBdxFloat } from '../../lib/money'
import * as lws from '../../lib/lws'
import { sendFunds, SEND_STEPS } from '../../lib/send'
import { Settings } from './Settings'
import { Receive } from './Receive'
import { SiteConnectionBar } from './ConnectedSitesBadge'
import { truncateMiddle, truncateUnlessTab } from '../../lib/format'
import { getBdxPriceUsdt } from '../../lib/price'
import { getPidLabels } from '../../lib/pidLabels'
import { looksLikeBnsName, resolveBnsWallet } from '../../lib/bns'
import { decodeAddress } from '../../lib/bridge'
import { closePanel } from '../../lib/platform'
import { sessionStore } from '../../lib/sessionStore'
import { CONFIG } from '../../lib/config'

const POLL_MS = 10_000 // Beldex block time ~30s; poll LWS every 10s while popup is open

interface Tx {
  hash: string
  total_received?: string
  total_sent?: string
  timestamp?: string
  height?: number
  mempool?: boolean
  coinbase?: boolean
  unlock_time?: number
  mixin?: number
  payment_id?: string
}

type TxFilter = 'all' | 'in' | 'out'

// Locally-tracked outgoing txs moved to ../../lib/pendingTxs so dapp-initiated
// sends (SendApprovalCard) can record pendings into the same history.
import { addPendingLocal, reconcilePendingLocal, pendingKey } from '../../lib/pendingTxs'


function timeAgo(ts?: string): string {
  if (!ts) return ''
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function Dashboard({ address, walletName, wallets, onLocked }:
  { address: string; walletName: string; wallets: WalletMeta[]; onLocked: () => void }) {
  const [info, setInfo] = useState<any>(null)
  const [txs, setTxs] = useState<Tx[]>([])
  const [creds, setCreds] = useState<lws.Credentials | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [copied, setCopied] = useState(false)
  const [hideBalance, setHideBalance] = useState(() => localStorage.getItem('hideBalance') === '1')
  const [price, setPrice] = useState<number | null>(null)
  const [txFilter, setTxFilter] = useState<TxFilter>('all')
  const [selectedTx, setSelectedTx] = useState<Tx | null>(null)
  const [txHashCopied, setTxHashCopied] = useState(false)
  const [pidLabels, setPidLabels] = useState<Record<string, string>>({})
  useEffect(() => { if (selectedTx) getPidLabels().then(setPidLabels) }, [selectedTx])
  const [error, setError] = useState('')
  const [view, setView] = useState<'home' | 'send' | 'receive' | 'settings' | 'addwallet'>('home')
  const [showWallets, setShowWallets] = useState(false)

  // send form
  const [to, setTo] = useState('')
  const [resolved, setResolved] = useState<{ name: string; address: string } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveErr, setResolveErr] = useState('')
  const [amount, setAmount] = useState('')
  const [flash, setFlash] = useState(false)
  // review-before-send modal: target='' while a BNS name is still resolving
  const [review, setReview] = useState<{ target: string; name?: string } | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewErr, setReviewErr] = useState('')
  const [sending, setSending] = useState(false)
  const [sendPhase, setSendPhase] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')
  const [sendStepCode, setSendStepCode] = useState(0)
  const [sendError, setSendError] = useState('')
  const [txResult, setTxResult] = useState('')
  const [hashCopied, setHashCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const secretsRef = useRef<WalletSecrets | null>(null)
  // Single-flight guard (external audit): the 10s poll must not start a second
  // refresh while one is still in flight — a slow/hanging LWS would otherwise
  // accumulate overlapping fetches. Each fetch is also bounded by its deadline.
  const refreshInFlight = useRef(false)

  const refresh = async (c: lws.Credentials) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    getBdxPriceUsdt().then(p => p !== null && setPrice(p)) // 60s-cached; fire-and-forget
    try {
      const [i, t] = await Promise.all([lws.getAddressInfo(c), lws.getAddressTxs(c)])

      // SECURITY/CORRECTNESS: the server's total_sent / spent_outputs are guesses —
      // it flags any output that appears as a ring member (decoy) in other people's
      // transactions. Verify with key images (requires our spend key) so the balance
      // and history only reflect REAL spends. Without this, phantom "sent"
      // transactions appear whenever strangers sample our outputs as decoys.
      const s = secretsRef.current
      if (s) {
        const rawTotalSent = String(i.total_sent ?? '0') // snapshot BEFORE correction
        i.total_sent = String(await correctedTotalSent(s, i))
        for (const tx of t.transactions ?? []) {
          tx.total_sent = String(await correctedTotalSent(s, tx))
        }
        // Publish the key-image-corrected figures for the dapp bridge: the
        // background can't run the WASM, so without this a dapp's getBalance
        // would use the LWS's raw total_sent — which counts every decoy-ring
        // appearance and collapses the balance toward zero once the wallet
        // has outgoing activity. total_sent_raw lets the background compute
        // the decoy overcount and stay accurate as raw figures move between
        // corrections. Keep the shape in sync with background/dapp.ts.
        sessionStore.set({
          corrected_balance: {
            address,
            total_received: String(i.total_received ?? '0'),
            total_sent: String(i.total_sent),
            total_sent_raw: rawTotalSent,
            locked_funds: String(i.locked_funds ?? '0'),
            scanned_block_height: Number(i.scanned_block_height ?? 0),
            at: Date.now()
          }
        }).catch(() => {})
      }

      setInfo(i)
      const serverList: Tx[] = (t.transactions ?? [])
        // drop pure decoy-usage entries: nothing received, nothing really sent
        .filter((tx: Tx) => parseAtomic(tx.total_received) > 0n || parseAtomic(tx.total_sent) > 0n)

      // Just-sent txs the LWS hasn't indexed yet: show them as pending right away.
      const localPending = await reconcilePendingLocal(address, new Set(serverList.map(tx => tx.hash)))
      const list = [
        ...localPending.map(p => ({
          hash: p.hash,
          total_sent: p.sentAtomic,
          total_received: '0',
          timestamp: p.timestamp,
          mempool: true
        } as Tx)),
        ...serverList
      ].sort((a: Tx, b: Tx) => new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime())
      setTxs(list)
      setError('')
    } catch (e: any) {
      setError(`rpc node unreachable (${e.message}) — retrying…`)
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
      setLoadedOnce(true)
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let cancelled = false
    ;(async () => {
      try {
        // Instant display from the background sync cache while we fetch fresh data.
        // storage.session may be absent (Firefox < 115); it's only an optimization.
        const cached = (await (chrome.storage as any).session?.get('sync_cache'))?.['sync_cache']
        if (cached?.info && !cancelled) setInfo(cached.info)

        const s = await sendToBackground({ type: 'GET_SECRETS' })
        if (!s.ok || !s.secrets) { onLocked(); return }
        secretsRef.current = s.secrets
        const c = { address: s.secrets.address, view_key: s.secrets.secViewKey }
        if (cancelled) return
        setCreds(c)
        try {
          await lws.login(c)
          await refresh(c)
        } catch (e: any) {
          // server down/unreachable — keep polling below so we recover
          // automatically once it responds again
          setError(`rpc node unreachable (${e.message}) — retrying…`)
          setLoadedOnce(true)
        }
        timer = setInterval(() => refresh(c), POLL_MS)
      } catch (e: any) {
        setError(`LWS error: ${e.message}`)
      }
    })()
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [])

  // A dapp-initiated send (SendApprovalCard, possibly in the fallback popup)
  // just recorded a pending tx — refresh so it appears in history immediately.
  useEffect(() => {
    const onPending = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && pendingKey(address) in changes && creds) refresh(creds)
    }
    chrome.storage.onChanged.addListener(onPending)
    return () => chrome.storage.onChanged.removeListener(onPending)
  }, [creds, address])

  // Lock the UI the moment the background session ends (auto-lock alarm, Lock
  // in another view, wallet switch). Without this, an open panel keeps the
  // secrets in memory and keeps polling the LWS after the wallet has "locked".
  useEffect(() => {
    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && 'session_secrets' in changes && changes['session_secrets'].newValue === undefined) {
        secretsRef.current = null
        onLocked() // unmounts us; the mount effect's cleanup stops the poll timer
      }
    }
    chrome.storage.onChanged.addListener(onStorage)
    return () => chrome.storage.onChanged.removeListener(onStorage)
  }, [])

  // User activity re-arms the auto-lock timer (throttled to one ping per 30s),
  // so the wallet doesn't lock out from under someone actively using the panel.
  useEffect(() => {
    let lastPing = 0
    const ping = () => {
      const now = Date.now()
      if (now - lastPing < 30_000) return
      lastPing = now
      sendToBackground({ type: 'TOUCH' })
    }
    window.addEventListener('pointerdown', ping)
    window.addEventListener('keydown', ping)
    return () => {
      window.removeEventListener('pointerdown', ping)
      window.removeEventListener('keydown', ping)
    }
  }, [])

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address)
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  // Live BNS resolution: debounce the recipient field; if it looks like a name,
  // resolve it via the daemon and show what it points at before sending.
  useEffect(() => {
    setResolved(null); setResolveErr('')
    const input = to.trim()
    if (!input || !looksLikeBnsName(input)) return
    const t = setTimeout(async () => {
      setResolving(true)
      try {
        const addr = await resolveBnsWallet(input)
        if (addr) {
          await decodeAddress(addr) // sanity: daemon must return a valid address
          setResolved({ name: input.toLowerCase(), address: addr })
        } else {
          setResolveErr(`No wallet record for "${input}"`)
        }
      } catch (e: any) {
        setResolveErr(`BNS lookup failed: ${e.message}`)
      } finally {
        setResolving(false)
      }
    }, 500)
    return () => clearTimeout(t)
  }, [to])

  /**
   * Opens the review modal. BNS names are re-resolved fresh HERE, at the moment
   * of review, so a stale earlier resolution can never be the thing confirmed.
   */
  const openReview = async () => {
    setError(''); setReviewErr('')
    const input = to.trim()
    const amt = amount.trim()

    // --- amount validation (BigInt: no float precision loss on large amounts) ---
    if (!/^\d*\.?\d+$/.test(amt)) { setError('Enter a valid amount'); return }
    if ((amt.split('.')[1]?.length ?? 0) > 9) { setError('BDX supports at most 9 decimal places'); return }
    const amtAtomic = toAtomic(amt)
    if (amtAtomic <= 0n) { setError('Amount must be greater than 0'); return }
    if (unlocked !== null && amtAtomic > unlocked) {
      setError(`Amount exceeds your unlocked balance (${fmtBDX(unlocked)} BDX)`); return
    }

    // --- recipient validation: BNS name (re-resolved) or a raw address ---
    if (looksLikeBnsName(input)) {
      setReview({ target: '', name: input.toLowerCase() })
      setReviewLoading(true)
      try {
        const addr = await resolveBnsWallet(input)
        if (!addr) throw new Error(`Could not resolve BNS name "${input}"`)
        await decodeAddress(addr) // must be a valid Beldex address
        setReview({ target: addr, name: input.toLowerCase() })
      } catch (e: any) {
        setReviewErr(e.message)
      } finally {
        setReviewLoading(false)
      }
    } else {
      try {
        await decodeAddress(input) // rejects malformed / wrong-network addresses
      } catch {
        setError('Invalid Beldex address'); return
      }
      setReview({ target: input })
    }
  }

  // Broadcasts to an already-reviewed, confirmed target address.
  const doSend = async (target: string) => {
    setError(''); setTxResult(''); setSending(true)
    setSendPhase('sending'); setSendStepCode(0); setSendError(''); setHashCopied(false)
    // Global single-flight send lock, shared with dapp-initiated sends — two
    // concurrent constructions could select the same outputs (double spend).
    const lock = await sendToBackground({ type: 'SEND_LOCK_ACQUIRE' })
    if (!lock.ok) {
      setSendError(lock.error); setSendPhase('error'); setSending(false)
      return
    }
    const lockOwner = lock.lockOwner // release only our own lock
    try {
      const s = await sendToBackground({ type: 'GET_SECRETS' })
      if (!s.ok || !s.secrets) { onLocked(); return }

      const r = await sendFunds({
        secrets: s.secrets,
        toAddress: target,
        amount: amount.trim(), // display units, e.g. "1.25"
        priority: flash ? 5 : 1, // 5 = flash (instant) per wallet2.h tx_priority_flash
        onStatus: code => setSendStepCode(code)
      })
      // track locally so it shows as pending in history immediately,
      // even before the LWS scanner picks it up
      await addPendingLocal(address, {
        hash: r.tx_hash,
        sentAtomic: r.total_sent ?? String(toAtomic(amount.trim())),
        timestamp: new Date().toISOString()
      })
      setTxResult(r.tx_hash)
      setSendPhase('success')
      setTo(''); setAmount('')
      if (creds) refresh(creds)
    } catch (e: any) {
      setSendError(e.message)
      setSendPhase('error')
    } finally {
      setSending(false)
      await sendToBackground({ type: 'SEND_LOCK_RELEASE', owner: lockOwner }).catch(() => {})
    }
  }

  const toggleHide = () => {
    const next = !hideBalance
    setHideBalance(next)
    localStorage.setItem('hideBalance', next ? '1' : '0')
  }
  const mask = (v: string) => (hideBalance ? '••••••' : v)

  // total_sent is already key-image-corrected in refresh(), so this is the real balance.
  // BigInt throughout so balances above 2^53 atomic (~9M BDX) stay exact.
  const balance: bigint | null = info ? parseAtomic(info.total_received) - parseAtomic(info.total_sent) : null
  const locked = info ? parseAtomic(info.locked_funds) : 0n
  const unlocked: bigint | null = balance !== null ? (balance - locked > 0n ? balance - locked : 0n) : null
  // The LWS refreshes `blockchain_height` on a slower cadence than its scanner,
  // so scanned_block_height can briefly exceed it. Treat the max as the true tip.
  const scanned = info ? Number(info.scanned_block_height ?? 0) : 0
  const chainHeight = info ? Math.max(scanned, Number(info.blockchain_height ?? 0)) : 0
  const synced = info && scanned >= chainHeight

  return (
    <div className="wrap">
      <div className="header">
        <div className="brand">
          <img src="icons/logo.svg" alt="" />Beldex
          {/* Non-mainnet builds are visually unmistakable — mixing up a testnet
              and mainnet wallet is an easy and expensive mistake to make. */}
          {CONFIG.NETWORK !== 'mainnet' && <span className="net-badge">{CONFIG.NETWORK_LABEL}</span>}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-icon" title="Switch wallet" onClick={() => setShowWallets(true)}>
            {walletName || 'Wallet'} ▾
          </button>
          {!new URLSearchParams(location.search).has('tab') && (
            <button className="btn-icon" title="Open full screen"
              onClick={async () => {
                await chrome.tabs.create({ url: chrome.runtime.getURL('panel.html?tab=1') })
                closePanel() // close the side panel/sidebar; the tab takes over
              }}>
              ⛶
            </button>
          )}
          <button className="btn-icon" title="Settings" onClick={() => setView(view === 'settings' ? 'home' : 'settings')}>
            ⚙
          </button>
          <button className="btn-icon" onClick={async () => { await sendToBackground({ type: 'LOCK' }); onLocked() }}>
            Lock
          </button>
        </div>
      </div>

      {view === 'settings' && <Settings walletName={walletName} onBack={() => setView('home')} onWiped={onLocked} onChanged={onLocked} />}
      {view === 'receive' && <Receive address={address} onBack={() => setView('home')} />}
      {view === 'addwallet' && (
        <Onboarding addMode onDone={onLocked} onCancel={() => setView('home')} />
      )}

      {view !== 'settings' && view !== 'receive' && view !== 'addwallet' && <>
      <div className="card balance-card">
        <div className="sync">
          {info
            ? <>block {scanned.toLocaleString()} / {chainHeight.toLocaleString()}{' '}
                <span className="live">{synced ? '● synced' : '◌ scanning…'}</span></>
            : <span className="skel" style={{ width: 150, height: 10 }} />}
        </div>
        <div className="balance">
          {balance === null
            ? <span className="skel" style={{ width: 130, height: 24, verticalAlign: 'middle' }} />
            : mask(fmtBDX(balance))} <span className="unit">BDX</span>
          <button className="eye-btn" title={hideBalance ? 'Show balance' : 'Hide balance'} onClick={toggleHide}>
            {hideBalance ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        </div>
        {price !== null ? (
          <div className="fiat">
            {balance !== null && <>≈ <b>{mask((toBdxFloat(balance) * price).toFixed(2))} USDT</b> · </>}
            1 BDX = {price.toFixed(4)} USDT
          </div>
        ) : !loadedOnce ? (
          <div className="fiat"><span className="skel" style={{ width: 170, height: 10 }} /></div>
        ) : null}
        <div className="sub-balances">
          <span>Unlocked <b className="ok">
            {unlocked === null ? <span className="skel" style={{ width: 44, height: 10 }} /> : mask(fmtBDX(unlocked))}
          </b></span>
          <span>Locked <b className="warn">
            {balance === null ? <span className="skel" style={{ width: 44, height: 10 }} /> : mask(fmtBDX(locked))}
          </b></span>
        </div>
        <button className="btn-icon" disabled={refreshing} onClick={() => creds && refresh(creds)}>
          {refreshing ? '…' : '↻ refresh'}
        </button>
        <div className="addr">
          <span title={address}>{truncateUnlessTab(address)}</span>
          <button className="btn-icon" onClick={copyAddress}>{copied ? '✓' : '⧉'}</button>
        </div>
      </div>

      {view === 'home' && (
        <>
          <div className="row">
            <button className="btn-primary" onClick={() => { setTxResult(''); setView('send') }}>↑ Send</button>
            <button className="btn-primary" onClick={() => setView('receive')}>↓ Receive</button>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h4>History</h4>
            <div className="chips">
              {(['all', 'in', 'out'] as TxFilter[]).map(f => (
                <button key={f} className={`chip ${txFilter === f ? 'active' : ''}`} onClick={() => setTxFilter(f)}>
                  {f === 'all' ? 'All' : f === 'in' ? '↓ Received' : '↑ Sent'}
                </button>
              ))}
            </div>
          </div>
          <div className="card history-card">
            {!loadedOnce && txs.length === 0 && [0, 1, 2, 3].map(i => (
              <div className="skel-row" key={i}>
                <span className="skel skel-circle" />
                <span style={{ flex: 1 }}>
                  <span className="skel" style={{ width: '85%', height: 9, marginBottom: 5 }} />
                  <span className="skel" style={{ width: 60, height: 8, display: 'block' }} />
                </span>
                <span className="skel" style={{ width: 52, height: 12 }} />
              </div>
            ))}
            {loadedOnce && (() => {
              const filtered = txs.filter(tx => {
                const incoming = parseAtomic(tx.total_received) - parseAtomic(tx.total_sent) >= 0n
                return txFilter === 'all' || (txFilter === 'in' ? incoming : !incoming)
              })
              if (filtered.length === 0) {
                return <p className="muted center">{txs.length === 0 ? 'No transactions yet' : 'Nothing here'}</p>
              }
              return filtered.map(tx => {
                const delta = parseAtomic(tx.total_received) - parseAtomic(tx.total_sent)
                const incoming = delta >= 0n
                return (
                  <div className="tx" key={tx.hash}>
                    <div className={`icon ${incoming ? '' : 'out'}`}>{incoming ? '↓' : '↑'}</div>
                    <div className="meta">
                      <div className="hash" title={tx.hash}>{tx.hash}</div>
                      <div className="when">
                        {tx.mempool ? <span className="pending">⏳ pending</span> : timeAgo(tx.timestamp)}
                      </div>
                    </div>
                    <div className={`amt ${incoming ? 'in' : 'out'}`}>
                      {incoming ? '+' : '−'}{fmtBDX(absBig(delta))}
                    </div>
                    <button className="tx-info" title="Transaction details"
                      onClick={() => { setTxHashCopied(false); setSelectedTx(tx) }}>ⓘ</button>
                  </div>
                )
              })
            })()}
          </div>
          <SiteConnectionBar walletName={walletName} />
        </>
      )}

      {view === 'send' && (
        <div className="card">
          <h2>Send BDX</h2>
          <input placeholder="Recipient address or BNS name" value={to} onChange={e => setTo(e.target.value)} />
          {resolving && <p className="muted" style={{ marginTop: -6 }}>Resolving name…</p>}
          {resolved && (
            <div style={{ marginTop: -6, marginBottom: 8 }}>
              <p className="ok" style={{ margin: '0 0 4px' }}>✓ {resolved.name} resolves to:</p>
              {/* full address so it can be verified out-of-band (audit M4) */}
              <div className="ok" style={{
                fontFamily: 'var(--mono)', fontSize: 10, overflowWrap: 'anywhere',
                background: '#0d0d0d', border: '1px solid var(--border)', padding: '6px 8px'
              }}>
                {resolved.address}
              </div>
              <p className="muted" style={{ margin: '4px 0 0', fontSize: 10 }}>
                Verify this address with the recipient — BNS lookups trust explorer.beldex.io.
              </p>
            </div>
          )}
          {resolveErr && <p className="warn" style={{ marginTop: -6 }}>{resolveErr}</p>}
          <input placeholder="Amount (BDX)" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
          <label className="checkbox">
            <input type="checkbox" checked={flash} onChange={e => setFlash(e.target.checked)} />
            ⚡ Flash — instant confirmation
          </label>
          <div className="row">
            <button className="btn-ghost" disabled={sending} onClick={() => setView('home')}>Back</button>
            <button className="btn-primary" disabled={sending || !to.trim() || !amount.trim()} onClick={openReview}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}
      </>}

      {review && sendPhase === 'idle' && (
        <div className="modal-overlay" onClick={() => setReview(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Review transaction</h2>

            {review.name && (
              <div className="detail-row">
                <span className="muted">BNS name</span>
                <span className="ok">{review.name}</span>
              </div>
            )}

            <p className="muted" style={{ margin: '10px 0 4px' }}>
              {review.name ? 'Resolves to' : 'Recipient'}
            </p>
            {reviewLoading ? (
              <p className="muted">Resolving name…</p>
            ) : reviewErr ? (
              <p className="error">{reviewErr}</p>
            ) : (
              // full address, untruncated — this is exactly what will receive the funds
              <div className="seed" style={{ wordBreak: 'break-all' }}>{review.target}</div>
            )}

            <div className="detail-row">
              <span className="muted">Amount</span>
              <span><b>{amount.trim()} BDX</b></span>
            </div>
            <div className="detail-row">
              <span className="muted">Priority</span>
              <span>{flash ? '⚡ Flash (instant)' : 'Normal'}</span>
            </div>

            <p className="warn" style={{ marginTop: 10 }}>
              ⚠ Transactions are irreversible. Verify the full recipient address before confirming.
            </p>

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn-ghost" onClick={() => setReview(null)}>Cancel</button>
              <button className="btn-primary"
                disabled={reviewLoading || !!reviewErr || !review.target}
                onClick={() => {
                  const target = review.target
                  setReview(null)
                  doSend(target)
                }}>
                Confirm send
              </button>
            </div>
          </div>
        </div>
      )}

      {sendPhase !== 'idle' && (
        <div className="modal-overlay">
          <div className="modal center">
            {sendPhase === 'sending' && (
              <>
                <div className="spinner" />
                <h2 style={{ marginTop: 16 }}>Sending</h2>
                <p className="muted send-step" key={sendStepCode}>
                  {SEND_STEPS[sendStepCode] ?? 'Preparing…'}
                </p>
                <div className="progress"><div className="bar" style={{ width: `${(sendStepCode / 5) * 100}%` }} /></div>
                <p className="muted" style={{ fontSize: 10 }}>step {Math.max(1, sendStepCode)} of 5</p>
              </>
            )}

            {sendPhase === 'success' && (
              <>
                <svg className="tick" viewBox="0 0 52 52" width="72" height="72">
                  <circle className="tick-circle" cx="26" cy="26" r="24" fill="none" />
                  <path className="tick-check" fill="none" d="M14 27 l8 8 l16 -16" />
                </svg>
                <h2 style={{ marginTop: 10 }}>Sent!</h2>
                <p className="muted" style={{ marginBottom: 4 }}>Transaction hash</p>
                <div className="addr" style={{ marginTop: 0, marginBottom: 14 }}>
                  <span title={txResult}>{truncateMiddle(txResult)}</span>
                  <button className="btn-icon" onClick={async () => {
                    await navigator.clipboard.writeText(txResult)
                    setHashCopied(true)
                    setTimeout(() => setHashCopied(false), 1500)
                  }}>{hashCopied ? '✓' : '⧉'}</button>
                </div>
                <button className="btn-primary" onClick={() => { setSendPhase('idle'); setView('home') }}>Done</button>
              </>
            )}

            {sendPhase === 'error' && (
              <>
                <div className="fail-mark">✕</div>
                <h2 style={{ marginTop: 10 }}>Send failed</h2>
                <p className="error" style={{ marginBottom: 14 }}>{sendError}</p>
                <button className="btn-ghost" style={{ width: '100%' }} onClick={() => setSendPhase('idle')}>Close</button>
              </>
            )}
          </div>
        </div>
      )}

      {showWallets && (
        <div className="modal-overlay" onClick={() => setShowWallets(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Wallets</h2>
            {wallets.map(w => (
              <div className="menu-item" key={w.id} onClick={async () => {
                setShowWallets(false)
                if (!w.active) {
                  // switching locks the session — the target wallet's password is required
                  await sendToBackground({ type: 'SWITCH_WALLET', id: w.id })
                  onLocked()
                }
              }}>
                <span>
                  {w.active ? <b className="ok">● </b> : ''}{w.name}
                  {w.address && <span className="muted" style={{ marginLeft: 8, fontSize: 10 }}>
                    {truncateMiddle(w.address, 6)}
                  </span>}
                </span>
                {!w.active && <span className="chev">›</span>}
              </div>
            ))}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn-ghost" onClick={() => setShowWallets(false)}>Close</button>
              <button className="btn-primary" onClick={() => { setShowWallets(false); setView('addwallet') }}>
                + Add wallet
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedTx && (() => {
        const delta = parseAtomic(selectedTx.total_received) - parseAtomic(selectedTx.total_sent)
        const incoming = delta >= 0n
        const confirmations = selectedTx.mempool || !selectedTx.height
          ? 0
          : Math.max(0, chainHeight - Number(selectedTx.height) + 1)
        const rows: Array<[string, React.ReactNode]> = [
          ['Type', <span className={incoming ? 'ok' : 'error'}>{incoming ? '↓ Received' : '↑ Sent'}</span>],
          ['Amount', `${incoming ? '+' : '−'}${fmtBDX(absBig(delta))} BDX`],
          ['Status', selectedTx.mempool
            ? <span className="pending">⏳ Pending (mempool)</span>
            : <span className="ok">✓ Confirmed</span>],
          ['Confirmations', selectedTx.mempool ? '—' : confirmations.toLocaleString()],
          ['Block height', selectedTx.height ? Number(selectedTx.height).toLocaleString() : '—'],
          ['Date', selectedTx.timestamp ? new Date(selectedTx.timestamp).toLocaleString() : '—'],
          ['Ring size', selectedTx.mixin != null ? String(Number(selectedTx.mixin) + 1) : '—']
        ]
        if (selectedTx.payment_id && !/^0+$/.test(selectedTx.payment_id)) {
          rows.push(['Payment ID', truncateMiddle(selectedTx.payment_id)])
          const pidLabel = pidLabels[selectedTx.payment_id.toLowerCase()]
          if (pidLabel) rows.push(['Label', <b className="ok">{pidLabel}</b>])
        }
        return (
          <div className="modal-overlay" onClick={() => setSelectedTx(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h2>Transaction</h2>
              <div className="addr" style={{ marginTop: 0, marginBottom: 12 }}>
                <span title={selectedTx.hash}>{truncateMiddle(selectedTx.hash)}</span>
                <button className="btn-icon" onClick={async () => {
                  await navigator.clipboard.writeText(selectedTx.hash)
                  setTxHashCopied(true)
                  setTimeout(() => setTxHashCopied(false), 1500)
                }}>{txHashCopied ? '✓' : '⧉'}</button>
              </div>
              {rows.map(([label, val]) => (
                <div className="detail-row" key={label}>
                  <span className="muted">{label}</span>
                  <span>{val}</span>
                </div>
              ))}
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn-ghost" onClick={() => setSelectedTx(null)}>Close</button>
                <a className="btn-primary center" style={{ textDecoration: 'none', padding: '12px 18px' }}
                  href={`${CONFIG.EXPLORER_TX_URL}${selectedTx.hash}`} target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              </div>
            </div>
          </div>
        )
      })()}

      {error && <p className="error">{error}</p>}
    </div>
  )
}
