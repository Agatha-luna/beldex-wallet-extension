// Regression: an approval must execute against the wallet/session it was
// reviewed under — never whatever became active meanwhile (external audit:
// "Approval Execution Is Not Bound to an Immutable Wallet/Session Context").
//
// Drives the BUILT background bundle through a fake chrome API and checks:
//   1. pending metadata records the queue-time walletId + sessionGeneration,
//      and DAPP_GET_PENDING renders the RECORDED wallet's identity;
//   2. a wallet switch rejects the previous wallet's pending approvals;
//   3. GET_SECRETS with an `expect` binding refuses after a switch / relock;
//   4. approving a connect after a switch does NOT grant the new wallet.
//
//   npm run build   # produces the bundle this test loads

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const CANDIDATES = ['dist/background.js', 'dist-testnet/background.js',
                    'firefox/background.js', 'firefox-testnet/background.js']
const bundle = CANDIDATES.map(p => join(here, '..', p)).find(existsSync)

const ORIGIN = 'https://site.test'
const mkSecrets = (tag) => ({
  address: 'bx' + tag + 'addr', pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
  pubViewKey: 'c'.repeat(64), secViewKey: 'd'.repeat(64), mnemonic: 'x', seed: 'y'
})

function memStore(map) {
  return {
    get: async k => {
      const keys = k == null ? [...map.keys()] : Array.isArray(k) ? k : [k]
      const o = {}
      for (const key of keys) if (map.has(key)) o[key] = map.get(key)
      return o
    },
    set: async o => { for (const [k, v] of Object.entries(o)) map.set(k, v) },
    remove: async k => { for (const key of [].concat(k)) map.delete(key) },
    setAccessLevel: async () => {}
  }
}

describe('approval context binding', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, sentToPage, onConnect, callBg, port

  before(async () => {
    local = new Map()
    session = new Map()
    sentToPage = []
    const msgListeners = [], connectListeners = []

    const chrome = {
      runtime: {
        id: 'ext-id',
        onMessage: { addListener: f => msgListeners.push(f) },
        onConnect: { addListener: f => connectListeners.push(f) },
        onInstalled: { addListener: () => {} },
        getManifest: () => ({ version: '0.0.0' }),
        getURL: p => 'chrome-extension://ext-id/' + p,
        sendMessage: async () => {},
        getContexts: async () => []
      },
      storage: { local: memStore(local), session: memStore(session) },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: async () => {} },
      action: { onClicked: { addListener: () => {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      windows: {
        onRemoved: { addListener: () => {} },
        getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }),
        create: async () => ({ id: 99 }), remove: async () => {}
      },
      tabs: { query: async () => [{ id: 1 }] },
      notifications: { create: () => {} }
    }

    const sandbox = {
      chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async () => ({ ok: true, json: async () => ({}) }), URL
    }
    sandbox.self = sandbox
    sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)

    // Two wallets; A active + unlocked; ORIGIN granted for A only.
    local.set('wallets', { A: { name: 'Wallet A', address: mkSecrets('A').address },
                           B: { name: 'Wallet B', address: mkSecrets('B').address } })
    local.set('active_wallet_id', 'A')
    local.set('dapp_origins', { [ORIGIN]: { walletId: 'A', grantedAt: Date.now() } })
    session.set('session_secrets', { walletId: 'A', generation: 'gen-A', secrets: mkSecrets('A') })

    const portListeners = []
    port = {
      name: 'bdx-dapp',
      sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/page' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m),
      disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    onConnect = req => portListeners.forEach(f => f(req, port))
    callBg = (req) => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
  })

  const settle = () => new Promise(r => setTimeout(r, 200))
  const pendingId = () => Object.keys(session.get('dapp_pending') ?? {})[0]

  test('pending metadata records queue-time wallet + generation', async () => {
    onConnect({ id: 'pg-sign', method: 'bdx_signMessage', params: { message: 'hello' } })
    await settle()
    const meta = (session.get('dapp_pending'))[pendingId()]
    assert.equal(meta.walletId, 'A')
    assert.equal(meta.sessionGeneration, 'gen-A')

    const view = await callBg({ type: 'DAPP_GET_PENDING', reqId: pendingId() })
    assert.equal(view.ok, true)
    assert.equal(view.pending.walletId, 'A')
    assert.equal(view.pending.walletName, 'Wallet A')          // rendered from record
    assert.equal(view.pending.sessionGeneration, 'gen-A')
  })

  test('GET_SECRETS honors the binding, refuses after relock/switch', async () => {
    // Correct binding while A is active + unlocked -> served.
    let s = await callBg({ type: 'GET_SECRETS', expect: { walletId: 'A', generation: 'gen-A' } })
    assert.equal(s.ok, true)
    assert.equal(s.secrets.address, mkSecrets('A').address)

    // Stale generation (A relocked+unlocked since) -> refused.
    s = await callBg({ type: 'GET_SECRETS', expect: { walletId: 'A', generation: 'OLD' } })
    assert.equal(s.ok, false)

    // Binding for a different wallet than the active/session one -> refused.
    s = await callBg({ type: 'GET_SECRETS', expect: { walletId: 'B', generation: 'gen-A' } })
    assert.equal(s.ok, false)

    // Unbound legacy call still works (panel's own flows).
    s = await callBg({ type: 'GET_SECRETS' })
    assert.equal(s.ok, true)
  })

  test('switching wallets rejects the previous wallet\'s pending approval', async () => {
    sentToPage.length = 0
    onConnect({ id: 'pg-sign2', method: 'bdx_signMessage', params: { message: 'bye' } })
    await settle()
    assert.ok(pendingId(), 'approval should be queued')

    // Switch to B (endSession clears session; SWITCH sets active B).
    await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    await settle()

    assert.equal(pendingId(), undefined, 'pending approval for A must be gone')
    const reply = sentToPage.find(m => m.id === 'pg-sign2')
    assert.ok(reply?.error, 'the dapp must receive an error, not silence')
  })

  test('approving a stale connect does not grant the newly active wallet', async () => {
    // Re-seed: A active+unlocked, ORIGIN NOT yet granted.
    local.set('active_wallet_id', 'A')
    local.set('dapp_origins', {})
    session.set('session_secrets', { walletId: 'A', generation: 'gen-A2', secrets: mkSecrets('A') })
    sentToPage.length = 0

    onConnect({ id: 'pg-conn', method: 'bdx_connect' })
    await settle()
    const reqId = pendingId()
    assert.ok(reqId, 'connect approval queued')
    assert.equal((session.get('dapp_pending'))[reqId].walletId, 'A')

    // User switches to B and unlocks it, THEN approves the stale connect.
    local.set('active_wallet_id', 'B')
    session.set('session_secrets', { walletId: 'B', generation: 'gen-B', secrets: mkSecrets('B') })
    const r = await callBg({ type: 'DAPP_APPROVE', reqId })
    await settle()

    assert.equal(r.ok, false, 'approve must refuse when active wallet != recorded wallet')
    const grants = local.get('dapp_origins') ?? {}
    assert.equal(grants[ORIGIN], undefined, 'no grant may be created for B')
  })
})
