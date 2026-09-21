import { useEffect, useRef, useState } from 'react'
import { sendToBackground, WalletMeta, WalletSecrets } from '../../lib/messages'
import { Onboarding } from './Onboarding'
import { correctedTotalSent, verifiedTokenBalances } from '../../lib/spent'
import { fmtBDX, parseAtomic, toAtomic, absBig, toBdxFloat } from '../../lib/money'
import * as lws from '../../lib/lws'
import { sendFunds, SEND_STEPS } from '../../lib/send'
import { Settings, ChevronLeftIcon } from './Settings'
import { Receive } from './Receive'
import { Tokens, TokenRow } from './Tokens'
import { TokenDetail } from './TokenDetail'
import { SiteConnectionBar } from './ConnectedSitesBadge'
import { truncateMiddle, truncateUnlessTab, timeAgo } from '../../lib/format'
import { getBdxPriceUsdt } from '../../lib/price'
import { getPidLabels } from '../../lib/pidLabels'
import { looksLikeBnsName, resolveBnsWallet } from '../../lib/bns'
import { decodeAddress, tokenRegistrationInfo, TokenRegistrationInfo } from '../../lib/bridge'
import { sessionStore } from '../../lib/sessionStore'
import { CONFIG } from '../../lib/config'
import { getTokenBalances, fetchAllTokenOutputs, isTokenLookupUnsupported } from '../../lib/tokenApi'
import { fmtToken, toTokenAtomic, groupDigits, shortenTokenId, tokenColor, UINT64_MAX } from '../../lib/tokenAmount'
import { loadKnownTokenIds, rememberTokenIds, loadRegisteredTokens, appendRegisteredToken } from '../../lib/tokenStorage'

const POLL_MS = 10_000 // Beldex block time ~30s; poll LWS every 10s while popup is open
// How long a just-broadcast registration is given before its absence from the
// chain is reported as "missing" rather than "pending". ~40 blocks at Beldex's
// ~30s target — far longer than any healthy inclusion delay, short enough
// that a genuinely dropped registration doesn't sit mislabelled all day.
const UNMINED_GRACE_MS = 20 * 60 * 1000

interface TokenLeg {
  token_id: string
  received: string
  sent: string
}

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
  // Absent entirely for ordinary BDX transactions. One tx can move several
  // tokens, so this is a leg per token rather than one collapsed id+amount.
  token_legs?: TokenLeg[]
}

type TxFilter = 'all' | 'in' | 'out'

// Locally-tracked outgoing txs moved to ../../lib/pendingTxs so dapp-initiated
// sends (SendApprovalCard) can record pendings into the same history.
import { addPendingLocal, reconcilePendingLocal, pendingKey } from '../../lib/pendingTxs'


interface TokenLegDisplay {
  outgoing: boolean
  amount: string
  ticker: string
  extra: number
}

/**
 * A transaction that moved a privacy token carries its real amount in that
 * token's own units — the BDX figure on such a row is only the fee, and
 * showing "0.0000 BDX" against a transfer that moved 1,200 POP reads as
 * nothing happened. One tx can move several tokens, so this picks the
 * largest leg by absolute value and reports how many others there are;
 * summing them would be meaningless since each is its own unit.
 */
function topTokenLeg(legs: TokenLeg[] | undefined, infoById: Map<string, TokenRow>): TokenLegDisplay | null {
  if (!legs?.length) return null
  const moved = legs
    .map(l => {
      const net = parseAtomic(l.received) - parseAtomic(l.sent)
      const info = infoById.get(l.token_id)
      return {
        net,
        magnitude: absBig(net),
        decimals: info?.decimalPoint ?? 0,
        ticker: info?.ticker || shortenTokenId(l.token_id, 6, 4)
      }
    })
    .filter(l => l.magnitude !== 0n)
  if (!moved.length) return null
  moved.sort((a, b) => (a.magnitude === b.magnitude ? 0 : a.magnitude < b.magnitude ? 1 : -1))
  const top = moved[0]
  return { outgoing: top.net < 0n, amount: fmtToken(top.magnitude, top.decimals), ticker: top.ticker, extra: moved.length - 1 }
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
  // RPC/connectivity banner — persistent, shown regardless of view. Kept
  // separate from formError (below): refresh()/refreshTokens() poll every
  // POLL_MS and clear this on success, which would silently wipe out a
  // send-form validation message shown a moment earlier if they shared state.
  const [error, setError] = useState('')
  // Send/register form validation — scoped to the send view, immune to the
  // background poll.
  const [formError, setFormError] = useState('')
  const [view, setView] = useState<'home' | 'send' | 'receive' | 'settings' | 'addwallet' | 'tokens' | 'tokenDetail'>('home')
  // Which token's detail/history screen is open — separate from sendAsset so
  // opening a token's detail view never disturbs an in-progress send form.
  const [tokenDetailId, setTokenDetailId] = useState<string | null>(null)
  // Which token the receive screen is showing an address for, if opened from
  // a token's detail screen — null for the plain BDX receive flow. Drives
  // both the screen's heading and where its Back button returns to.
  const [receiveToken, setReceiveToken] = useState<TokenRow | null>(null)
  const [homeTab, setHomeTab] = useState<'tokens' | 'activity'>('tokens')
  const [showWallets, setShowWallets] = useState(false)
  // Asset picker for the send form — a native <select>'s open dropdown is
  // drawn by the OS/browser chrome layer, not the page, so it can't be
  // screenshotted or reliably inspected inside a side panel; a plain in-DOM
  // list (same modal pattern as the wallet switcher) sidesteps that entirely.
  const [assetPickerOpen, setAssetPickerOpen] = useState(false)
  // true when the picker is the front door of Send (opened from the Home "Send"
  // button, before any asset is chosen) — its Back then exits to Home instead of
  // falling through to the compose form underneath.
  const [pickerFromHome, setPickerFromHome] = useState(false)
  const [assetSearch, setAssetSearch] = useState('')

  // send form
  const [to, setTo] = useState('')
  const [resolved, setResolved] = useState<{ name: string; address: string } | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveErr, setResolveErr] = useState('')
  const [amount, setAmount] = useState('')
  const [flash, setFlash] = useState(false)
  // review-before-send modal: target='' while a BNS name is still resolving.
  // kind distinguishes what the confirm button actually does — a token send
  // reads its amount in the token's units, a registration has no destination.
  const [review, setReview] = useState<{ target: string; name?: string; kind: 'bdx' | 'token' | 'register' } | null>(null)
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

  // HF22 privacy tokens
  // "" = BDX; anything else is a token id. Drives the unit everywhere in the
  // send form — amount field, decimals, Max, validation — because a token's
  // scale is its own and has nothing to do with BDX's 9 decimals. The fee is
  // always BDX regardless, so both units can appear on the same screen.
  const [sendAsset, setSendAsset] = useState('')
  const [tokenRows, setTokenRows] = useState<TokenRow[]>([])
  const [tokensLoading, setTokensLoading] = useState(false)
  // null = no lookup attempted yet; false = this server has no token endpoints.
  const [tokensSupported, setTokensSupported] = useState<boolean | null>(null)
  // Protocol constants (collateral, descriptor limits) come from the bridge so
  // they can't drift out of step with consensus. Null on an older bridge; the
  // form then falls back to built-in limits.
  const [tokenRegInfo, setTokenRegInfo] = useState<TokenRegistrationInfo | null>(null)
  // A third send-form mode alongside "send BDX" and "send a token": registers
  // a new token, minting the initial supply to this wallet and locking
  // collateral rather than paying it away.
  const [tokenToggle, setTokenToggle] = useState(false)
  const [tokenTicker, setTokenTicker] = useState('')
  const [tokenFullName, setTokenFullName] = useState('')
  const [tokenDecimals, setTokenDecimals] = useState('8')
  const [tokenSupply, setTokenSupply] = useState('')
  const [tokenMaxSupply, setTokenMaxSupply] = useState('')
  // What a just-completed registration produced — held separately from the
  // form fields because those are cleared before the success modal renders.
  const [registeredResult, setRegisteredResult] = useState<{ tokenId: string; ticker: string } | null>(null)
  const [tokenIdCopied, setTokenIdCopied] = useState(false)

  const heldTokens = tokenRows.filter(r => r.status === 'confirmed' && r.verified > 0n)
  const selectedToken = sendAsset ? tokenRows.find(r => r.tokenId === sendAsset) : undefined
  const isTokenSend = !tokenToggle && !!selectedToken
  const tokenInfoById = new Map(tokenRows.map(r => [r.tokenId, r]))

  // A refresh can drop a token row out from under an open detail screen (e.g.
  // balance verified down to zero and it no longer qualifies) — bounce back
  // to the list rather than leave the screen stuck on stale data.
  useEffect(() => {
    if (view === 'tokenDetail' && tokenDetailId && !tokenRows.some(r => r.tokenId === tokenDetailId)) {
      setView('tokens')
    }
  }, [view, tokenDetailId, tokenRows])

  useEffect(() => { tokenRegistrationInfo().then(setTokenRegInfo).catch(() => {}) }, [])

  const refreshTokens = async (c: lws.Credentials) => {
    setTokensLoading(true)
    try {
      const knownIds = await loadKnownTokenIds(address)
      const reply = await getTokenBalances(c, knownIds)

      // The server is view-only and cannot tell a decoy from a real spend —
      // when one of our outputs is sampled as a ring member elsewhere it
      // records a spend that never happened. Recompute from the outputs
      // themselves wherever the spend key is available; fall back to the
      // server's figure otherwise (same degrade-gracefully rule as BDX).
      let verified: Map<string, bigint> | null = null
      const s = secretsRef.current
      if (s) {
        try {
          const outs = await fetchAllTokenOutputs(c)
          verified = await verifiedTokenBalances(s, outs)
        } catch {
          // older server or request failed — unverified figures still render
        }
      }

      const regs = await loadRegisteredTokens(address)
      const now = Date.now()
      const seen = new Set<string>()
      const rows: TokenRow[] = reply.tokens.map(t => {
        seen.add(t.token_id)
        let status: TokenRow['status']
        if (t.status === 'confirmed') {
          status = 'confirmed'
        } else if (t.status === 'not_found') {
          const reg = regs.find(r => r.tokenId === t.token_id)
          const age = reg ? now - reg.registeredAt : Number.MAX_SAFE_INTEGER
          status = age < UNMINED_GRACE_MS ? 'pending' : 'missing'
        } else {
          status = 'unknown'
        }
        const unverified = parseAtomic(t.unlocked_balance)
        return {
          tokenId: t.token_id,
          status,
          ticker: t.ticker ?? '',
          fullName: t.full_name ?? '',
          decimalPoint: t.decimal_point ?? 0,
          verified: verified?.get(t.token_id) ?? unverified,
          owner: t.owner,
          metaInfo: t.meta_info,
          currentSupply: t.current_supply,
          totalMaxSupply: t.total_max_supply
        }
      })
      // A verified balance for an id the balances reply didn't mention at all
      // must still show up — never hide a balance the wallet actually has.
      if (verified) {
        for (const [tokenId, amt] of verified) {
          if (!seen.has(tokenId) && amt > 0n) {
            rows.push({ tokenId, status: 'unknown', ticker: '', fullName: '', decimalPoint: 0, verified: amt })
          }
        }
      }

      await rememberTokenIds(address, rows.map(r => r.tokenId))
      setTokenRows(rows)
      setTokensSupported(true)
    } catch (e) {
      // Old server (404/501) or unreachable: keep whatever was already shown,
      // flagged unverified — never a blank screen, never wiped cached data.
      if (isTokenLookupUnsupported(e)) setTokensSupported(false)
    } finally {
      setTokensLoading(false)
    }
  }

  const refresh = async (c: lws.Credentials) => {
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
        // drop pure decoy-usage entries: nothing received, nothing really sent.
        // A token-only transaction can carry zero BDX in both fields (e.g. a
        // token receive costs the sender BDX but not the receiver) — token_legs
        // moving something for real must keep the row regardless.
        .filter((tx: Tx) =>
          parseAtomic(tx.total_received) > 0n ||
          parseAtomic(tx.total_sent) > 0n ||
          (tx.token_legs ?? []).some(l => parseAtomic(l.received) > 0n || parseAtomic(l.sent) > 0n)
        )

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
          // Fired right after login, not awaited — it used to sit after
          // `await refresh(c)` below, which needlessly serialized the token
          // list behind the BDX balance/history fetch (slower on wallets with
          // a lot of history, since every tx needs a key-image correction).
          // That gap is exactly why a token could still be missing from the
          // Send dropdown moments after opening the wallet.
          refreshTokens(c)
          await refresh(c)
        } catch (e: any) {
          // server down/unreachable — keep polling below so we recover
          // automatically once it responds again
          setError(`rpc node unreachable (${e.message}) — retrying…`)
          setLoadedOnce(true)
        }
        timer = setInterval(() => { refresh(c); refreshTokens(c) }, POLL_MS)
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
    setFormError(''); setReviewErr('')

    if (tokenToggle) {
      const limits = tokenRegInfo
      const maxTicker = limits ? Number(limits.max_ticker_length) : 14
      const maxName = limits ? Number(limits.max_full_name_length) : 400
      const maxDp = limits ? Number(limits.max_decimal_point) : 18
      const ticker = tokenTicker.trim()
      if (!/^[A-Za-z0-9]+$/.test(ticker) || ticker.length > maxTicker) {
        setFormError(`Ticker must be 1-${maxTicker} letters or digits`); return
      }
      if (tokenFullName.length > maxName) { setFormError(`Name must be at most ${maxName} characters`); return }
      const dp = Number(tokenDecimals)
      if (!Number.isInteger(dp) || dp < 0 || dp > maxDp) {
        setFormError(`Decimals must be a whole number between 0 and ${maxDp}`); return
      }
      const maxSupplyAtomic = toTokenAtomic(tokenMaxSupply.trim(), dp)
      if (!tokenMaxSupply.trim() || maxSupplyAtomic === null || maxSupplyAtomic <= 0n) {
        setFormError('Max supply is required'); return
      }
      const supplyAtomic = toTokenAtomic(tokenSupply.trim() || '0', dp)
      if (supplyAtomic === null) { setFormError('Invalid initial supply'); return }
      if (supplyAtomic > maxSupplyAtomic) { setFormError('Initial supply cannot exceed max supply'); return }
      // The bridge stores these atomic (display value x 10^decimals) in a C++
      // uint64_t — past that it throws a native "stoull: out of range" instead
      // of a helpful error, so catch it here with the actual numbers in hand.
      if (maxSupplyAtomic > UINT64_MAX) {
        setFormError(`Max supply is too large at ${dp} decimals — reduce the supply or the decimal count`); return
      }
      // The fee is BDX regardless, and collateral is locked in BDX too.
      if (unlocked !== null && unlocked <= 0n) {
        setFormError('Registering a token still needs BDX for the network fee and collateral'); return
      }
      setReview({ target: '', kind: 'register' })
      return
    }

    const input = to.trim()
    const amt = amount.trim()

    /* Balance checks run against whichever asset is selected. For a token the
       comparison is against that token's verified balance in its own scale,
       and the ceiling is the whole balance — unlike BDX, the fee doesn't come
       out of it, since the fee is always BDX. */
    if (isTokenSend) {
      const asset = selectedToken!
      const amtAtomic = toTokenAtomic(amt, asset.decimalPoint)
      if (amtAtomic === null) { setFormError(`Enter a valid amount (up to ${asset.decimalPoint} decimal places)`); return }
      if (amtAtomic <= 0n) { setFormError('Amount must be greater than 0'); return }
      if (amtAtomic > asset.verified) {
        setFormError(`Amount exceeds your ${asset.ticker} balance (${fmtToken(asset.verified, asset.decimalPoint)} ${asset.ticker})`); return
      }
      // Sending a token still costs BDX, and a wallet holding plenty of the
      // token but no coin is a confusing failure if it isn't named.
      if (unlocked !== null && unlocked <= 0n) {
        setFormError('You need BDX to pay the network fee for a token send'); return
      }
    } else {
      // --- amount validation (BigInt: no float precision loss on large amounts) ---
      if (!/^\d*\.?\d+$/.test(amt)) { setFormError('Enter a valid amount'); return }
      if ((amt.split('.')[1]?.length ?? 0) > 9) { setFormError('BDX supports at most 9 decimal places'); return }
      const amtAtomic = toAtomic(amt)
      if (amtAtomic <= 0n) { setFormError('Amount must be greater than 0'); return }
      if (unlocked !== null && amtAtomic > unlocked) {
        setFormError(`Amount exceeds your unlocked balance (${fmtBDX(unlocked)} BDX)`); return
      }
    }

    const kind = isTokenSend ? 'token' as const : 'bdx' as const

    // --- recipient validation: BNS name (re-resolved) or a raw address ---
    if (looksLikeBnsName(input)) {
      setReview({ target: '', name: input.toLowerCase(), kind })
      setReviewLoading(true)
      try {
        const addr = await resolveBnsWallet(input)
        if (!addr) throw new Error(`Could not resolve BNS name "${input}"`)
        await decodeAddress(addr) // must be a valid Beldex address
        setReview({ target: addr, name: input.toLowerCase(), kind })
      } catch (e: any) {
        setReviewErr(e.message)
      } finally {
        setReviewLoading(false)
      }
    } else {
      try {
        await decodeAddress(input) // rejects malformed / wrong-network addresses
      } catch {
        setFormError('Invalid Beldex address'); return
      }
      setReview({ target: input, kind })
    }
  }

  // Broadcasts to an already-reviewed, confirmed target address.
  const doSend = async (target: string) => {
    setFormError(''); setTxResult(''); setSending(true)
    setSendPhase('sending'); setSendStepCode(0); setSendError(''); setHashCopied(false)
    // Global single-flight send lock, shared with dapp-initiated sends — two
    // concurrent constructions could select the same outputs (double spend).
    const lock = await sendToBackground({ type: 'SEND_LOCK_ACQUIRE' })
    if (!lock.ok) {
      setSendError(lock.error); setSendPhase('error'); setSending(false)
      return
    }
    try {
      const s = await sendToBackground({ type: 'GET_SECRETS' })
      if (!s.ok || !s.secrets) { onLocked(); return }

      const asset = isTokenSend ? selectedToken : undefined
      const r = await sendFunds({
        secrets: s.secrets,
        toAddress: target,
        amount: amount.trim(), // display units, e.g. "1.25" — in the token's own units when asset is set
        priority: flash ? 5 : 1, // 5 = flash (instant) per wallet2.h tx_priority_flash
        onStatus: code => setSendStepCode(code),
        tokenId: asset?.tokenId,
        tokenDecimalPoint: asset?.decimalPoint,
        isDeployToken: tokenToggle,
        tokenDescriptor: tokenToggle ? {
          ticker: tokenTicker.trim(),
          full_name: tokenFullName.trim(),
          meta_info: '',
          decimal_point: Number(tokenDecimals),
          total_max_supply: tokenMaxSupply.trim(),
          current_supply: tokenSupply.trim() || '0'
        } : undefined
      })

      if (r.token_id) {
        // Persist before anything else on this path — the id is hashed from
        // the descriptor plus a salt the bridge generates and does not keep,
        // so it cannot be re-derived if lost.
        await appendRegisteredToken(address, {
          tokenId: r.token_id,
          ticker: tokenTicker.trim(),
          fullName: tokenFullName.trim(),
          decimalPoint: Number(tokenDecimals),
          currentSupply: tokenSupply.trim() || '0',
          totalMaxSupply: tokenMaxSupply.trim(),
          txHash: r.tx_hash,
          registeredAt: Date.now()
        })
        setRegisteredResult({ tokenId: r.token_id, ticker: tokenTicker.trim() })
      } else {
        setRegisteredResult(null)
      }

      // Local pending-history tracking is BDX-specific (an immediate pending
      // row before the LWS scanner indexes it). A token send or registration
      // only moves BDX as its fee, so recording that as "sent" would show a
      // phantom outgoing BDX transaction for the wrong amount — the next
      // refreshTokens() poll picks up the real token-side state instead.
      if (!tokenToggle && !isTokenSend) {
        await addPendingLocal(address, {
          hash: r.tx_hash,
          sentAtomic: r.total_sent ?? String(toAtomic(amount.trim())),
          timestamp: new Date().toISOString()
        })
      }
      setTxResult(r.tx_hash)
      setSendPhase('success')
      setTo(''); setAmount(''); setTokenTicker(''); setTokenFullName(''); setTokenSupply(''); setTokenMaxSupply('')
      if (creds) { refresh(creds); refreshTokens(creds) }
    } catch (e: any) {
      setSendError(e.message)
      setSendPhase('error')
    } finally {
      setSending(false)
      await sendToBackground({ type: 'SEND_LOCK_RELEASE' }).catch(() => {})
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
        <div className="header-actions">
          <button className="btn-icon btn-wallet-switch" title="Switch wallet" onClick={() => setShowWallets(true)}>
            {walletName || 'Wallet'} ▾
          </button>
          <button className="btn-icon" title="Menu" onClick={() => setView(view === 'settings' ? 'home' : 'settings')}>
            ☰
          </button>
        </div>
      </div>

      {view === 'settings' && (
        <Settings walletName={walletName} onBack={() => setView('home')} onWiped={onLocked} onChanged={onLocked}
          onLock={async () => { await sendToBackground({ type: 'LOCK' }); onLocked() }}
          onRegisterToken={() => { setSendAsset(''); setTokenToggle(true); setTxResult(''); setFormError(''); setAssetPickerOpen(false); setPickerFromHome(false); setView('send') }} />
      )}
      {view === 'receive' && (
        <Receive address={address} ticker={receiveToken?.ticker}
          onBack={() => setView(receiveToken ? 'tokenDetail' : 'home')} />
      )}
      {view === 'addwallet' && (
        <Onboarding addMode onDone={onLocked} onCancel={() => setView('home')} />
      )}
      {view === 'tokens' && (
        <Tokens
          rows={tokenRows}
          loading={tokensLoading}
          supported={tokensSupported}
          onSelect={tokenId => { setTokenDetailId(tokenId); setView('tokenDetail') }}
          onRegister={() => { setSendAsset(''); setTokenToggle(true); setTxResult(''); setFormError(''); setAssetPickerOpen(false); setPickerFromHome(false); setView('send') }}
          onBack={() => setView('home')}
        />
      )}

      {view === 'tokenDetail' && (() => {
        const token = tokenRows.find(r => r.tokenId === tokenDetailId)
        if (!token) return null
        const history = txs
          .flatMap(tx => {
            const leg = (tx.token_legs ?? []).find(l => l.token_id === token.tokenId)
            if (!leg) return []
            const net = parseAtomic(leg.received) - parseAtomic(leg.sent)
            if (net === 0n) return []
            return [{ hash: tx.hash, timestamp: tx.timestamp, mempool: tx.mempool, net }]
          })
        return (
          <TokenDetail
            token={token}
            history={history}
            onSend={() => { setSendAsset(token.tokenId); setTokenToggle(false); setTxResult(''); setFormError(''); setAssetPickerOpen(false); setPickerFromHome(false); setView('send') }}
            onReceive={() => { setReceiveToken(token); setView('receive') }}
            onBack={() => setView('home')}
            onSelectTx={hash => {
              const tx = txs.find(t => t.hash === hash)
              if (tx) { setTxHashCopied(false); setSelectedTx(tx) }
            }}
          />
        )
      })()}

      {view !== 'settings' && view !== 'receive' && view !== 'addwallet' && view !== 'tokens' && view !== 'tokenDetail' && <>
      {view === 'home' && (
        <>
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
        <button className="btn-icon" disabled={refreshing} onClick={() => creds && (refresh(creds), refreshTokens(creds))}>
          {refreshing ? '…' : '↻ refresh'}
        </button>
        <div className="addr">
          <span title={address}>{truncateUnlessTab(address)}</span>
          <button className="btn-icon" onClick={copyAddress}>{copied ? '✓' : '⧉'}</button>
        </div>
      </div>

          <div className="row">
            <button className="btn-primary" onClick={() => { setSendAsset(''); setTokenToggle(false); setTxResult(''); setFormError(''); setAssetPickerOpen(true); setPickerFromHome(true); setView('send') }}>↑ Send</button>
            <button className="btn-primary" onClick={() => { setReceiveToken(null); setView('receive') }}>↓ Receive</button>
          </div>

          <div className="home-tabs">
            <button className={`home-tab ${homeTab === 'tokens' ? 'active' : ''}`} onClick={() => setHomeTab('tokens')}>
              Tokens
            </button>
            <button className={`home-tab ${homeTab === 'activity' ? 'active' : ''}`} onClick={() => setHomeTab('activity')}>
              Activity
            </button>
          </div>

          {homeTab === 'tokens' && (
            heldTokens.length > 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <span className="ok" style={{ cursor: 'pointer', fontSize: 11 }} onClick={() => setView('tokens')}>
                    View all
                  </span>
                </div>
                <div className="card token-list">
                  {heldTokens.map(t => (
                    <div className="token-row" key={t.tokenId}
                      title={`${t.ticker} details`}
                      onClick={() => { setTokenDetailId(t.tokenId); setView('tokenDetail') }}>
                      <div className="token-avatar" style={{ background: tokenColor(t.tokenId) }}>
                        {(t.ticker || '?').charAt(0).toUpperCase()}
                      </div>
                      <div className="token-info">
                        <div className="token-title"><b>{t.ticker}</b></div>
                        {t.fullName && <div className="token-subtitle">{t.fullName}</div>}
                      </div>
                      <div className="token-values">
                        <div className="token-amount">{groupDigits(fmtToken(t.verified, t.decimalPoint))}</div>
                        <div className="token-unit">{t.ticker}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="menu-item" onClick={() => setView('tokens')}>
                <span>Tokens</span>
                <span className="chev">›</span>
              </div>
            )
          )}

          {homeTab === 'activity' && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
                    const leg = topTokenLeg(tx.token_legs, tokenInfoById)
                    const incoming = leg ? !leg.outgoing : parseAtomic(tx.total_received) - parseAtomic(tx.total_sent) >= 0n
                    return txFilter === 'all' || (txFilter === 'in' ? incoming : !incoming)
                  })
                  if (filtered.length === 0) {
                    return <p className="muted center">{txs.length === 0 ? 'No transactions yet' : 'Nothing here'}</p>
                  }
                  return filtered.map(tx => {
                    const delta = parseAtomic(tx.total_received) - parseAtomic(tx.total_sent)
                    const leg = topTokenLeg(tx.token_legs, tokenInfoById)
                    const incoming = leg ? !leg.outgoing : delta >= 0n
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
                          {leg
                            ? <>{incoming ? '+' : '−'}{groupDigits(leg.amount)} {leg.ticker}
                                {leg.extra > 0 && <span className="muted" style={{ fontWeight: 400 }}> +{leg.extra}</span>}</>
                            : <>{incoming ? '+' : '−'}{fmtBDX(absBig(delta))}</>}
                        </div>
                        <button className="tx-info" title="Transaction details"
                          onClick={() => { setTxHashCopied(false); setSelectedTx(tx) }}>ⓘ</button>
                      </div>
                    )
                  })
                })()}
              </div>
            </>
          )}
          <SiteConnectionBar walletName={walletName} />
        </>
      )}

      {view === 'send' && assetPickerOpen && (() => {
        const q = assetSearch.trim().toLowerCase()
        const bdxMatches = !q || 'bdx'.includes(q) || 'beldex'.includes(q)
        const matches = heldTokens.filter(t =>
          !q || t.ticker.toLowerCase().includes(q) || t.fullName.toLowerCase().includes(q))
        return (
          <div className="card" style={{ padding: '8px 0' }}>
            <div className="settings-header" style={{ paddingLeft: 0, paddingRight: 0 }}>
              <button className="settings-back" title="Back" onClick={() => {
                setAssetSearch('')
                if (pickerFromHome) setView('home')
                setAssetPickerOpen(false)
              }}><ChevronLeftIcon size={22} /></button>
              <h2>Send</h2>
            </div>
            <div style={{ padding: '0 0 10px' }}>
              <input placeholder="Search tokens..." autoFocus value={assetSearch}
                onChange={e => setAssetSearch(e.target.value)} style={{ marginBottom: 0 }} />
            </div>
            <div className="token-list" style={{ maxHeight: 'none' }}>
              {bdxMatches && (
                <div className="token-row" onClick={() => { setSendAsset(''); setAmount(''); setAssetPickerOpen(false); setAssetSearch('') }}>
                  <div className="token-avatar" style={{ background: '#101010', padding: 5 }}>
                    <img src="icons/logo.svg" alt="" style={{ width: '100%', height: '100%' }} />
                  </div>
                  <div className="token-info">
                    <div className="token-title"><b>BDX</b></div>
                    <div className="token-subtitle">Beldex</div>
                  </div>
                  <div className="token-values">
                    <div className="token-amount">{unlocked === null ? '…' : groupDigits(fmtBDX(unlocked))}</div>
                    <div className="token-unit">BDX</div>
                  </div>
                </div>
              )}
              {matches.map(t => (
                <div className="token-row" key={t.tokenId}
                  onClick={() => { setSendAsset(t.tokenId); setAmount(''); setAssetPickerOpen(false); setAssetSearch('') }}>
                  <div className="token-avatar" style={{ background: tokenColor(t.tokenId) }}>
                    {(t.ticker || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="token-info">
                    <div className="token-title"><b>{t.ticker}</b></div>
                    {t.fullName && <div className="token-subtitle">{t.fullName}</div>}
                  </div>
                  <div className="token-values">
                    <div className="token-amount">{groupDigits(fmtToken(t.verified, t.decimalPoint))}</div>
                    <div className="token-unit">{t.ticker}</div>
                  </div>
                </div>
              ))}
              {!bdxMatches && matches.length === 0 && <p className="muted center">No matching asset</p>}
            </div>
          </div>
        )
      })()}

      {view === 'send' && !assetPickerOpen && (
        <div className="card">
          {!tokenToggle ? (
            <>
              <div className="settings-header" style={{ paddingLeft: 0, paddingRight: 0, marginLeft: -16 }}>
                <button className="settings-back" title="Back" onClick={() => setView('home')}><ChevronLeftIcon size={22} /></button>
                <h2>{isTokenSend ? selectedToken!.ticker : 'BDX'}</h2>
              </div>
              <div style={{ textAlign: 'center' }}>
                {isTokenSend ? (
                  <div className="token-avatar" style={{ background: tokenColor(selectedToken!.tokenId), width: 44, height: 44, fontSize: 17, margin: '0 auto 8px' }}>
                    {(selectedToken!.ticker || '?').charAt(0).toUpperCase()}
                  </div>
                ) : (
                  <div className="token-avatar" style={{ background: '#101010', padding: 8, width: 44, height: 44, margin: '0 auto 8px' }}>
                    <img src="icons/logo.svg" alt="" style={{ width: '100%', height: '100%' }} />
                  </div>
                )}
                <p className="muted" style={{ margin: 0 }}>{isTokenSend ? selectedToken!.fullName : 'Beldex'}</p>
                <div className="balance" style={{ textAlign: 'center', margin: '10px 0 20px' }}>
                  {isTokenSend
                    ? groupDigits(fmtToken(selectedToken!.verified, selectedToken!.decimalPoint))
                    : unlocked !== null ? groupDigits(fmtBDX(unlocked)) : '…'}
                  <span className="unit"> {isTokenSend ? selectedToken!.ticker : 'BDX'}</span>
                </div>
              </div>
            </>
          ) : (
            <h2>Register token</h2>
          )}

          {!tokenToggle && <>
            {/* Selecting BDX (value "") must behave byte-for-byte as before this
                feature existed — everything below keys off isTokenSend/selectedToken,
                never off sendAsset directly, so an empty selection carries no token fields.
                The asset is chosen up front on the picker screen, before this form renders. */}
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

            <div className="row">
              <input placeholder={`Amount (${isTokenSend ? selectedToken!.ticker : 'BDX'})`} inputMode="decimal"
                value={amount} onChange={e => setAmount(e.target.value)} style={{ flex: 3 }} />
              <button className="btn-ghost" style={{ flex: 'none', padding: '11px 16px', marginBottom: 10 }} onClick={() => setAmount(
                isTokenSend ? fmtToken(selectedToken!.verified, selectedToken!.decimalPoint)
                  : unlocked !== null ? fmtBDX(unlocked, 9) : ''
              )}>Max</button>
            </div>
            {isTokenSend && (
              <p className="muted" style={{ marginTop: -6 }}>The network fee is paid in BDX.</p>
            )}

            <label className="checkbox">
              <input type="checkbox" checked={flash} onChange={e => setFlash(e.target.checked)} />
              ⚡ Flash — instant confirmation
            </label>

            {formError && <p className="error">{formError}</p>}
            <div className="row">
              <button className="btn-ghost" disabled={sending} onClick={() => setView('home')}>Back</button>
              <button className="btn-primary" disabled={sending || !to.trim() || !amount.trim()} onClick={openReview}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>}

          {tokenToggle && <>
            <h4 style={{ margin: '0 0 8px' }}>New token</h4>
            <p className="muted" style={{ marginTop: -4 }}>
              {tokenRegInfo
                ? <>Registering locks {fmtBDX(BigInt(tokenRegInfo.collateral_amount))} BDX for{' '}
                    {Number(tokenRegInfo.collateral_lock_blocks).toLocaleString()} blocks. The collateral is
                    returned when the lock expires; the network fee is separate.</>
                : 'Registering locks BDX collateral for a fixed period and mints the initial supply to this wallet; the network fee is separate.'}
            </p>
            <input placeholder="Ticker (e.g. POP)" value={tokenTicker}
              onChange={e => setTokenTicker(e.target.value)}
              maxLength={Number(tokenRegInfo?.max_ticker_length) || 14} />
            <input placeholder="Full name" value={tokenFullName}
              onChange={e => setTokenFullName(e.target.value)}
              maxLength={Number(tokenRegInfo?.max_full_name_length) || 400} />
            <input placeholder="Decimals (0-18)" inputMode="numeric" value={tokenDecimals}
              onChange={e => setTokenDecimals(e.target.value)} />
            <input placeholder="Initial supply" inputMode="decimal" value={tokenSupply}
              onChange={e => setTokenSupply(e.target.value)} />
            <input placeholder="Max supply" inputMode="decimal" value={tokenMaxSupply}
              onChange={e => setTokenMaxSupply(e.target.value)} />

            <div className="sub-balances" style={{ justifyContent: 'flex-start', gap: 6 }}>
              <span>Available balance <b className="ok">{unlocked !== null ? fmtBDX(unlocked) : '—'} BDX</b></span>
            </div>
            <p className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              Registration uses the current transaction priority and estimated fee.
            </p>

            {formError && <p className="error">{formError}</p>}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn-ghost" disabled={sending}
                onClick={() => { setTokenTicker(''); setTokenFullName(''); setTokenDecimals('8'); setTokenSupply(''); setTokenMaxSupply(''); setFormError('') }}>
                Reset
              </button>
              <button className="btn-primary" disabled={sending || !tokenTicker.trim() || !tokenMaxSupply.trim()} onClick={openReview}>
                {sending ? 'Registering…' : 'Register'}
              </button>
            </div>
            <button className="btn-ghost" style={{ width: '100%', marginTop: 8 }} disabled={sending}
              onClick={() => { setTokenToggle(false); setFormError(''); setView('home') }}>
              ← Back
            </button>
          </>}
        </div>
      )}
      </>}

      {review && sendPhase === 'idle' && (
        <div className="modal-overlay" onClick={() => setReview(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            {review.kind === 'register' ? (
              <>
                <h2>Review registration</h2>
                <div className="detail-row"><span className="muted">Ticker</span><span><b>{tokenTicker.trim()}</b></span></div>
                {tokenFullName.trim() && (
                  <div className="detail-row"><span className="muted">Name</span><span>{tokenFullName.trim()}</span></div>
                )}
                <div className="detail-row"><span className="muted">Decimals</span><span>{tokenDecimals}</span></div>
                <div className="detail-row"><span className="muted">Initial supply</span><span>{tokenSupply.trim() || '0'}</span></div>
                <div className="detail-row"><span className="muted">Max supply</span><span>{tokenMaxSupply.trim()}</span></div>
                <p className="warn" style={{ marginTop: 10 }}>
                  ⚠ Registration locks BDX collateral and mints the initial supply to this wallet. This cannot be undone.
                </p>
              </>
            ) : (
              <>
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
                  <span><b>{amount.trim()} {review.kind === 'token' ? selectedToken!.ticker : 'BDX'}</b></span>
                </div>
                {review.kind === 'token' && (
                  <div className="detail-row"><span className="muted">Network fee</span><span>paid in BDX</span></div>
                )}
                <div className="detail-row">
                  <span className="muted">Priority</span>
                  <span>{flash ? '⚡ Flash (instant)' : 'Normal'}</span>
                </div>

                <p className="warn" style={{ marginTop: 10 }}>
                  ⚠ Transactions are irreversible. Verify the full recipient address before confirming.
                </p>
              </>
            )}

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn-ghost" onClick={() => setReview(null)}>Cancel</button>
              <button className="btn-primary"
                disabled={review.kind !== 'register' && (reviewLoading || !!reviewErr || !review.target)}
                onClick={() => {
                  const target = review.target
                  setReview(null)
                  doSend(target)
                }}>
                {review.kind === 'register' ? 'Confirm registration' : 'Confirm send'}
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
                <h2 style={{ marginTop: 10 }}>{registeredResult ? 'Token registered!' : 'Sent!'}</h2>
                {registeredResult && (
                  <>
                    <p className="muted" style={{ marginBottom: 4 }}>{registeredResult.ticker || 'Token'} id</p>
                    <div className="addr" style={{ marginTop: 0, marginBottom: 8 }}>
                      <span title={registeredResult.tokenId}>{truncateMiddle(registeredResult.tokenId)}</span>
                      <button className="btn-icon" onClick={async () => {
                        await navigator.clipboard.writeText(registeredResult.tokenId)
                        setTokenIdCopied(true)
                        setTimeout(() => setTokenIdCopied(false), 1500)
                      }}>{tokenIdCopied ? '✓' : '⧉'}</button>
                    </div>
                    <p className="warn" style={{ fontSize: 10, marginBottom: 10 }}>
                      This id cannot be recovered if lost — it's now saved in this wallet.
                    </p>
                  </>
                )}
                <p className="muted" style={{ marginBottom: 4 }}>Transaction hash</p>
                <div className="addr" style={{ marginTop: 0, marginBottom: 14 }}>
                  <span title={txResult}>{truncateMiddle(txResult)}</span>
                  <button className="btn-icon" onClick={async () => {
                    await navigator.clipboard.writeText(txResult)
                    setHashCopied(true)
                    setTimeout(() => setHashCopied(false), 1500)
                  }}>{hashCopied ? '✓' : '⧉'}</button>
                </div>
                <button className="btn-primary" onClick={() => {
                  setSendPhase('idle'); setTokenToggle(false); setSendAsset('')
                  setView(registeredResult ? 'tokens' : 'home')
                  setRegisteredResult(null)
                }}>Done</button>
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
        const leg = topTokenLeg(selectedTx.token_legs, tokenInfoById)
        const incoming = leg ? !leg.outgoing : delta >= 0n
        const confirmations = selectedTx.mempool || !selectedTx.height
          ? 0
          : Math.max(0, chainHeight - Number(selectedTx.height) + 1)
        const rows: Array<[string, React.ReactNode]> = [
          ['Type', <span className={incoming ? 'ok' : 'error'}>{incoming ? '↓ Received' : '↑ Sent'}</span>],
          ['Amount', leg
            ? `${incoming ? '+' : '−'}${groupDigits(leg.amount)} ${leg.ticker}`
            : `${incoming ? '+' : '−'}${fmtBDX(absBig(delta))} BDX`],
          ['Status', selectedTx.mempool
            ? <span className="pending">⏳ Pending (mempool)</span>
            : <span className="ok">✓ Confirmed</span>],
          ['Confirmations', selectedTx.mempool ? '—' : confirmations.toLocaleString()],
          ['Block height', selectedTx.height ? Number(selectedTx.height).toLocaleString() : '—'],
          ['Date', selectedTx.timestamp ? new Date(selectedTx.timestamp).toLocaleString() : '—'],
          ['Ring size', selectedTx.mixin != null ? String(Number(selectedTx.mixin) + 1) : '—']
        ]
        // One transaction can move several tokens — every leg gets its own
        // row here rather than collapsing to the top one shown in the list.
        for (const l of selectedTx.token_legs ?? []) {
          const net = parseAtomic(l.received) - parseAtomic(l.sent)
          if (net === 0n) continue
          const info = tokenInfoById.get(l.token_id)
          const ticker = info?.ticker || shortenTokenId(l.token_id, 8, 4)
          const decimals = info?.decimalPoint ?? 0
          rows.push([`Token (${ticker})`, `${net < 0n ? '−' : '+'}${groupDigits(fmtToken(absBig(net), decimals))} ${ticker}`])
        }
        // Only the sender's side of a token tx actually paid BDX; a receiver
        // moved no BDX at all, so delta is 0 there and this row is skipped.
        if (leg && delta < 0n) rows.push(['Network fee', `${fmtBDX(absBig(delta))} BDX`])
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
