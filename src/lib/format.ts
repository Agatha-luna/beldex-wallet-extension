/** "bxcHWKBb4rBE79V...1JGFaFacE" — first/last n chars with … between. Copy actions must use the full value. */
export function truncateMiddle(s: string, n = 15): string {
  if (!s || s.length <= n * 2 + 3) return s
  return `${s.slice(0, n)}...${s.slice(-n)}`
}

/** True when running in the wide full-screen tab (panel.html?tab=1) rather than the narrow side panel. */
export function isTabMode(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains('tab-mode')
}

/** Truncate in the narrow side panel, but show the full string in the wide tab where it fits. */
export function truncateUnlessTab(s: string, n = 15): string {
  return isTabMode() ? s : truncateMiddle(s, n)
}

/** "3m ago" / "2h ago" / "5d ago" — coarse relative time for history rows. */
export function timeAgo(ts?: string): string {
  if (!ts) return ''
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
