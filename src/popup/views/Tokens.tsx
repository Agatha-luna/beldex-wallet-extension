import { fmtToken, groupDigits, shortenTokenId, tokenColor } from '../../lib/tokenAmount'

export interface TokenRow {
  tokenId: string
  status: 'confirmed' | 'pending' | 'missing' | 'unknown'
  ticker: string
  fullName: string
  decimalPoint: number
  /** Spendable balance in atomic units, key-image verified where possible. */
  verified: bigint
  // Descriptor extras — only meaningful when status === 'confirmed'.
  owner?: string
  metaInfo?: string
  currentSupply?: string
  totalMaxSupply?: string
}

const STATUS_LABEL: Record<TokenRow['status'], string> = {
  confirmed: '',
  pending: '⏳ pending mint',
  missing: '⚠ not found on chain',
  unknown: '? unverified'
}

export function Tokens({ rows, loading, supported, onSelect, onRegister, onBack }: {
  rows: TokenRow[]
  loading: boolean
  /** null = no lookup attempted yet; false = this server has no token endpoints. */
  supported: boolean | null
  onSelect: (tokenId: string) => void
  onRegister: () => void
  onBack: () => void
}) {
  return (
    <div className="card">
      <h2>Tokens</h2>

      {supported === false && (
        <p className="warn" style={{ marginTop: -6 }}>
          This server doesn't support privacy tokens — showing cached data, unverified.
        </p>
      )}

      {loading && rows.length === 0 && <p className="muted center">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="muted center">No tokens yet. Receive one, or register a new token below.</p>
      )}

      {rows.map(r => {
        const label = STATUS_LABEL[r.status]
        const name = r.status === 'confirmed' ? r.ticker : shortenTokenId(r.tokenId, 8, 4)
        const initial = (name || '?').charAt(0).toUpperCase()
        return (
          <div className="token-row" key={r.tokenId} onClick={() => onSelect(r.tokenId)}>
            <div className="token-avatar" style={{ background: tokenColor(r.tokenId) }}>{initial}</div>
            <div className="token-info">
              <div className="token-title">
                <b style={r.status === 'confirmed' ? {} : { fontFamily: 'var(--mono)' }}>{name}</b>
                {label && <span className="token-badge">{label}</span>}
              </div>
              {r.status === 'confirmed' && r.fullName && <div className="token-subtitle">{r.fullName}</div>}
            </div>
            <div className="token-values">
              <div className="token-amount">{groupDigits(fmtToken(r.verified, r.decimalPoint))}</div>
              {r.status === 'confirmed' && r.ticker && <div className="token-unit">{r.ticker}</div>}
            </div>
          </div>
        )
      })}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn-ghost" onClick={onBack}>Back</button>
        <button className="btn-primary" onClick={onRegister}>+ Register token</button>
      </div>
    </div>
  )
}
