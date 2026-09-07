// Approval-surface keepalive (external audit: "Approval-Page Keepalive Extends
// the Auto-Lock Session Without User Activity").
//
// Splits two signals the old code conflated:
//   - KEEPALIVE (every 15s) keeps the MV3 service worker warm during a long
//     review so the dapp's port isn't severed. It does NOT re-arm auto-lock.
//   - TOUCH is sent ONLY on genuine pointer/keyboard/focus activity in this
//     surface, and re-arms the inactivity auto-lock.
//
// So a pending-but-unattended approval no longer holds an unlocked session past
// its configured inactivity TTL: if the user walks away, the worker stays warm
// (for the dapp's benefit) but the session still locks on schedule. When it
// does, the background invalidates open send/sign approvals and rebinds any
// later unlock to the request's wallet/session generation, so nothing stale can
// execute without a fresh review.

import { useEffect } from 'react'
import { sendToBackground } from '../lib/messages'

const HEARTBEAT_MS = 15_000
const ACTIVITY_THROTTLE_MS = 10_000

/** @param active when false, no heartbeat/listeners are installed (e.g. an
 *  expired approval that no longer needs the worker warm). */
export function useApprovalKeepalive(active = true): void {
  useEffect(() => {
    if (!active) return
    const warm = setInterval(() => {
      sendToBackground({ type: 'KEEPALIVE' }).catch(() => {})
    }, HEARTBEAT_MS)

    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last < ACTIVITY_THROTTLE_MS) return
      last = now
      sendToBackground({ type: 'TOUCH' }).catch(() => {})
    }
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity)
    window.addEventListener('focus', onActivity)
    return () => {
      clearInterval(warm)
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('focus', onActivity)
    }
  }, [active])
}
