// Dispatch-level coverage for bdx_signAuthChallenge, driving the BUILT
// background bundle through a fake chrome API (same harness as
// dapp-approval-reply.test.mjs). Asserts:
//   - precondition errors: no grant -> 4100, locked -> 4900, concurrent -> -32603
//   - the queued statement embeds the WALLET-OBSERVED origin, not page text
//   - DAPP_AUTH_SIGN_COMPLETE returns { message, signature, address } to the page
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

const ORIGIN = 'https://shop.example'
const SECRETS = {
  address: 'bx' + 'a'.repeat(95), pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
  pubViewKey: 'c'.repeat(64), secViewKey: 'd'.repeat(64), mnemonic: 'x', seed: 'y'
}

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

describe('bdx_signAuthChallenge dispatch', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  // Load the built bundle ONCE (its service worker keeps timers alive; loading
  // per-test would leave handles that stop the test runner from exiting).
  // Storage is reset before each test to pick the wallet/grant/lock state.
  let local, session, sentToPage, onConnect, callBg

  before(() => {
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
        sendMessage: async () => {}, getContexts: async () => []
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
    // Unref timers the BUNDLE arms (the 5-min approval-TTL setTimeout): a test
    // may deliberately leave an approval pending, and a ref'd timer would keep
    // the test runner alive after all tests finish. The tests' own waits use
    // the outer setTimeout, so this only affects background-scheduled timers.
    const unrefTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t?.unref?.(); return t }
    const sandbox = {
      chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder,
      setTimeout: unrefTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async () => ({ ok: true, json: async () => ({}) }), URL
    }
    sandbox.self = sandbox
    sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)

    const portListeners = []
    const port = {
      name: 'bdx-dapp',
      // The page claims a path; the wallet must use ITS observed origin for
      // domain and only borrow the pathname for uri.
      sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/login?x=1' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m), disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    onConnect = req => portListeners.forEach(f => f(req, port))
    callBg = req => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
  })

  function reseed({ grant = true, unlocked = true } = {}) {
    local.clear(); session.clear(); sentToPage.length = 0
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    if (grant) local.set('dapp_origins', { [ORIGIN]: { walletId: 'w1', grantedAt: Date.now() } })
    if (unlocked) session.set('session_secrets', { walletId: 'w1', generation: 'gen-1', secrets: SECRETS })
  }

  const settle = () => new Promise(r => setTimeout(r, 200))
  const pendingId = () => Object.keys(session.get('dapp_pending') ?? {})[0]

  test('no grant -> 4100', async () => {
    reseed({ grant: false })
    onConnect({ id: 'p1', method: 'bdx_signAuthChallenge', params: { nonce: 'server-nonce-1' } })
    await settle()
    assert.equal(sentToPage.at(-1)?.error?.code, 4100)
  })

  test('locked -> 4900', async () => {
    reseed({ unlocked: false })
    onConnect({ id: 'p1', method: 'bdx_signAuthChallenge', params: { nonce: 'server-nonce-1' } })
    await settle()
    assert.equal(sentToPage.at(-1)?.error?.code, 4900)
  })

  test('invalid params -> -32602', async () => {
    reseed()
    onConnect({ id: 'p1', method: 'bdx_signAuthChallenge', params: { nonce: 'bad space', domain: 'evil.com' } })
    await settle()
    assert.equal(sentToPage.at(-1)?.error?.code, -32602)
  })

  test('statement embeds the wallet-observed origin; page cannot override; concurrent -> -32603', async () => {
    reseed()
    onConnect({ id: 'p1', method: 'bdx_signAuthChallenge', params: { nonce: 'server-nonce-1', requestId: 'r-7' } })
    await settle()
    const meta = (session.get('dapp_pending'))[pendingId()]
    assert.ok(meta, 'approval queued')
    assert.equal(meta.method, 'bdx_signAuthChallenge')
    const msg = meta.params.message
    assert.match(msg, /^beldex-auth-v1 domain=https:\/\/shop\.example uri=https:\/\/shop\.example\/login /)
    assert.match(msg, / nonce=server-nonce-1 /)
    assert.match(msg, / rid=r-7$/)
    assert.equal(meta.params.fields.domain, ORIGIN)          // never page-supplied
    assert.equal(meta.params.fields.address, SECRETS.address)

    // Second concurrent request for the same origin is refused.
    sentToPage.length = 0
    onConnect({ id: 'p2', method: 'bdx_signAuthChallenge', params: { nonce: 'server-nonce-2' } })
    await settle()
    assert.equal(sentToPage.at(-1)?.error?.code, -32603)

    // Complete the first: reply carries { message, signature, address } + page id.
    sentToPage.length = 0
    const r = await callBg({
      type: 'DAPP_AUTH_SIGN_COMPLETE', reqId: pendingId(),
      result: { message: msg, signature: 'SigV1auth', address: SECRETS.address }
    })
    await settle()
    assert.equal(r.ok, true)
    const reply = sentToPage.find(m => m.id === 'p1')
    assert.ok(reply, 'reply must echo the page request id')
    assert.equal(reply.result.message, msg)
    assert.equal(reply.result.signature, 'SigV1auth')
    assert.equal(reply.result.address, SECRETS.address)
  })

  test('DAPP_AUTH_SIGN_COMPLETE rejects a substituted message', async () => {
    reseed()
    onConnect({ id: 'p1', method: 'bdx_signAuthChallenge', params: { nonce: 'server-nonce-9' } })
    await settle()
    const r = await callBg({
      type: 'DAPP_AUTH_SIGN_COMPLETE', reqId: pendingId(),
      result: { message: 'beldex-auth-v1 domain=https://evil.example ...', signature: 'x', address: SECRETS.address }
    })
    assert.equal(r.ok, false, 'a message != the approved statement must be refused')
  })
})
