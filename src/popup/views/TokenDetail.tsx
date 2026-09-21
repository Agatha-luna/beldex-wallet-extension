import { useState } from 'react'
import { truncateMiddle, timeAgo } from '../../lib/format'
import { fmtToken, groupDigits, shortenTokenId, tokenColor } from '../../lib/tokenAmount'
import { TokenRow } from './Tokens'

export interface TokenHistoryRow {
  hash: string
  timestamp?: string
  mempool?: boolean
  /** This token's net atomic amount for the tx — received minus sent. */
  net: bigint
}

const STATUS_LABEL: Record<TokenRow['status'], string> = {
  confirmed: '',
  pending: '⏳ Waiting to be mined',
  missing: '⚠ Not found on chain — the registration may have never confirmed',
  unknown: '? Server could not verify this token'
}

export function TokenDetail({ token, history, onSend, onReceive, onBack, onSelectTx }: {
  token: TokenRow
  /** Pre-filtered to this token, newest first. */
  history: TokenHistoryRow[]
  onSend: () => void
  onReceive: () => void
  onBack: () => void
  onSelectTx: (hash: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const describable = token.status === 'confirmed'
  const sendable = describable && token.verified > 0n
  const label = STATUS_LABEL[token.status]
  const displayName = describable ? token.ticker : shortenTokenId(token.tokenId, 8, 4)

  const copyId = async () => {
    await navigator.clipboard.writeText(token.tokenId)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div className="card">
        <div className="settings-header">
          <button className="settings-back" title="Back" onClick={onBack}>‹</button>
          <h2>{displayName}</h2>
        </div>

        <div style={{ textAlign: 'center' }}>
          <div className="token-avatar" style={{ background: tokenColor(token.tokenId), width: 44, height: 44, fontSize: 17, margin: '0 auto 8px' }}>
            {(displayName || '?').charAt(0).toUpperCase()}
          </div>
          {describable && token.fullName && <p className="muted" style={{ margin: 0 }}>{token.fullName}</p>}
          {label && <p className="warn" style={{ margin: '6px 0 0' }}>{label}</p>}

          <div className="balance" style={{ textAlign: 'center', margin: '10px 0 4px' }}>
            {groupDigits(fmtToken(token.verified, token.decimalPoint))}
            {describable && <span className="unit"> {token.ticker}</span>}
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn-primary" disabled={!sendable} title={sendable ? undefined : 'Nothing to send'} onClick={onSend}>
            ↑ Send
          </button>
          <button className="btn-primary" onClick={onReceive}>↓ Receive</button>
        </div>
      </div>

      <div className="detail-section-label">Token details</div>
      <div className="card">
        <div className="detail-row">
          <span className="muted">Token ID</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span title={token.tokenId}>{truncateMiddle(token.tokenId, 8)}</span>
            <button className="btn-icon" onClick={copyId}>{copied ? '✓' : '⧉'}</button>
          </span>
        </div>
        {describable && <div className="detail-row"><span className="muted">Decimals</span><span>{token.decimalPoint}</span></div>}
        {describable && token.owner && (
          <div className="detail-row">
            <span className="muted">Owner</span>
            <span title={token.owner}>{truncateMiddle(token.owner, 8)}</span>
          </div>
        )}
        {describable && token.currentSupply && (
          <div className="detail-row">
            <span className="muted">Supply</span>
            <span>
              {groupDigits(fmtToken(BigInt(token.currentSupply), token.decimalPoint))}
              {token.totalMaxSupply ? ` / ${groupDigits(fmtToken(BigInt(token.totalMaxSupply), token.decimalPoint))}` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="detail-section-label">Activity</div>
      <div className="card history-card">
        {history.length === 0 && <p className="muted center">No transactions for this token yet.</p>}
        {history.map(h => (
          <div className="tx" key={h.hash} style={{ cursor: 'pointer' }} onClick={() => onSelectTx(h.hash)}>
            <div className={`icon ${h.net < 0n ? 'out' : ''}`}>{h.net < 0n ? '↑' : '↓'}</div>
            <div className="meta">
              <div className="hash" title={h.hash}>{h.hash}</div>
              <div className="when">
                {h.mempool ? <span className="pending">⏳ pending</span> : timeAgo(h.timestamp)}
              </div>
            </div>
            <div className={`amt ${h.net < 0n ? 'out' : 'in'}`}>
              {h.net < 0n ? '−' : '+'}{groupDigits(fmtToken(h.net < 0n ? -h.net : h.net, token.decimalPoint))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
