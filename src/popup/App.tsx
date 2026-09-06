import { useEffect, useState } from 'react'
import { sendToBackground, PendingApproval, WalletMeta, WalletState } from '../lib/messages'
import { Onboarding } from './views/Onboarding'
import { Unlock } from './views/Unlock'
import { Dashboard } from './views/Dashboard'
import { ConnectApprovalCard } from './views/ConnectApprovalCard'
import { SendApprovalCard, SendReqParams } from './views/SendApprovalCard'
import { SignApprovalCard, SignReqParams } from './views/SignApprovalCard'
import { AuthSignApprovalCard, AuthSignReqParams } from './views/AuthSignApprovalCard'

type PendingReq = { reqId: string } & PendingApproval

export function App() {
  const [state, setState] = useState<WalletState | 'loading'>('loading')
  const [address, setAddress] = useState<string>('')
  const [walletName, setWalletName] = useState<string>('')
  const [wallets, setWallets] = useState<WalletMeta[]>([])
  const [error, setError] = useState<string>('')
  // Dapp approval request waiting on the user (shown in-panel, MetaMask-style).
  const [pendingReq, setPendingReq] = useState<PendingReq | null>(null)

  const refreshPending = async () => {
    try {
      const r = await sendToBackground({ type: 'DAPP_LIST_PENDING' })
      if (r.ok) setPendingReq(r.pendingReq ?? null)
    } catch { /* background unreachable — GET_STATE path surfaces it */ }
  }

  const refresh = async () => {
    try {
      const r = await sendToBackground({ type: 'GET_STATE' })
      if (r.ok && r.state) {
        setError('')
        setState(r.state)
        setAddress(r.address ?? '')
        setWalletName(r.walletName ?? '')
        setWallets(r.wallets ?? [])
      } else if (!r.ok) {
        // don't hang on "Loading…" — surface why the background couldn't respond
        setError(r.error)
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not reach the wallet background')
    }
  }

  useEffect(() => {
    refresh()
    refreshPending()
    // Background pings this when a dapp request arrives / resolves.
    const onMsg = (m: unknown) => {
      if ((m as { type?: string })?.type === 'DAPP_PENDING_CHANGED') refreshPending()
    }
    chrome.runtime.onMessage.addListener(onMsg)
    return () => chrome.runtime.onMessage.removeListener(onMsg)
  }, [])

  if (state === 'loading') {
    return (
      <Screen>
        <p className="muted center" style={{ paddingTop: 100 }}>
          {error ? '' : 'Loading…'}
        </p>
        {error && (
          <div className="center" style={{ paddingTop: 60 }}>
            <p className="error">{error}</p>
            <button className="btn-ghost" onClick={refresh}>Retry</button>
          </div>
        )}
      </Screen>
    )
  }
  if (state === 'uninitialized') return <Onboarding onDone={refresh} />
  if (state === 'locked') return <Unlock walletName={walletName} wallets={wallets} onChanged={refresh} />
  // A dapp request takes over the unlocked panel until decided. Wallet
  // identity comes from the request's IMMUTABLE record (walletName/Address
  // captured at queue time), and send/sign bind GET_SECRETS to that record —
  // never to whatever wallet happens to be active by approval time.
  if (pendingReq) {
    const done = () => { setPendingReq(null); refreshPending() }
    const expect = { walletId: pendingReq.walletId, generation: pendingReq.sessionGeneration }
    return (
      <Screen>
        {pendingReq.method === 'bdx_sendTransaction' ? (
          <SendApprovalCard
            reqId={pendingReq.reqId}
            origin={pendingReq.origin}
            params={pendingReq.params as unknown as SendReqParams}
            walletName={pendingReq.walletName}
            expect={expect}
            onDone={done}
          />
        ) : pendingReq.method === 'bdx_signMessage' ? (
          <SignApprovalCard
            reqId={pendingReq.reqId}
            origin={pendingReq.origin}
            params={pendingReq.params as unknown as SignReqParams}
            walletName={pendingReq.walletName}
            expect={expect}
            onDone={done}
          />
        ) : pendingReq.method === 'bdx_signAuthChallenge' ? (
          <AuthSignApprovalCard
            reqId={pendingReq.reqId}
            origin={pendingReq.origin}
            params={pendingReq.params as unknown as AuthSignReqParams}
            walletName={pendingReq.walletName}
            expect={expect}
            onDone={done}
          />
        ) : (
          <ConnectApprovalCard
            reqId={pendingReq.reqId}
            origin={pendingReq.origin}
            walletName={pendingReq.walletName}
            address={pendingReq.walletAddress}
            onDone={done}
          />
        )}
      </Screen>
    )
  }
  // key= forces a clean remount when switching between wallets
  return <Dashboard key={address} address={address} walletName={walletName} wallets={wallets} onLocked={refresh} />
}

export function Screen({ children }: { children: React.ReactNode }) {
  return <div className="wrap">{children}</div>
}
