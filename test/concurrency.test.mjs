// Barrier-based concurrency coverage (external audit: "Security-Critical dApp
// State Updates Are Not Serialized"). Drives the BUILT background bundle with a
// storage layer whose writes are delayed, so two message handlers genuinely
// interleave — both reach their check-then-write before either write lands.
// Without the in-worker serialization (named mutexes + send-lock owner token +
// serialized grant RMW) these would race; the asserts pin the fixed behavior.
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

// A store whose writes resolve on a later macrotask, widening the check->write
// window so concurrent handlers interleave deterministically.
function delayedStore(map, writeDelay = 5) {
  return {
    get: async k => {
      const keys = k == null ? [...map.keys()] : Array.isArray(k) ? k : [k]
      const o = {}
      for (const key of keys) if (map.has(key)) o[key] = map.get(key)
      return o
    },
    set: async o => {
      await new Promise(r => setTimeout(r, writeDelay))
      for (const [k, v] of Object.entries(o)) map.set(k, v)
    },
    remove: async k => {
      await new Promise(r => setTimeout(r, writeDelay))
      for (const key of [].concat(k)) map.delete(key)
    },
    setAccessLevel: async () => {}
  }
}

describe('serialized dapp state updates', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, sentToPage, onConnect, callBg

  before(() => {
    local = new Map(); session = new Map(); sentToPage = []
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
      storage: { local: delayedStore(local), session: delayedStore(session) },
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
    const unrefTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t?.unref?.(); return t }
    const sandbox = {
      chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder,
      setTimeout: unrefTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async () => ({ ok: true, json: async () => ({}) }), URL
    }
    sandbox.self = sandbox; sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)

    const portListeners = []
    const port = {
      name: 'bdx-dapp',
      sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/x' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m), disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    onConnect = req => portListeners.forEach(f => f(req, port))
    callBg = req => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
  })

  function reseed(grants = { [ORIGIN]: { walletId: 'w1', grantedAt: Date.now() } }) {
    local.clear(); session.clear(); sentToPage.length = 0
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    local.set('dapp_origins', grants)
    session.set('session_secrets', { walletId: 'w1', generation: 'gen-1', secrets: SECRETS })
  }
  const settle = () => new Promise(r => setTimeout(r, 300))

  test('two concurrent send-lock acquisitions: exactly one wins', async () => {
    reseed()
    const [a, b] = await Promise.all([
      callBg({ type: 'SEND_LOCK_ACQUIRE' }),
      callBg({ type: 'SEND_LOCK_ACQUIRE' })
    ])
    const wins = [a, b].filter(r => r.ok)
    assert.equal(wins.length, 1, 'only one acquire may succeed')
    assert.ok(wins[0].lockOwner, 'winner gets an owner token')
  })

  test('a stale owner cannot release a newer holder\'s lock', async () => {
    reseed()
    const first = await callBg({ type: 'SEND_LOCK_ACQUIRE' })
    assert.ok(first.ok)
    // Force the persisted lock stale (> 3 min) so a replacement can be taken.
    const rec = session.get('send_lock')
    session.set('send_lock', { ...rec, at: Date.now() - 4 * 60_000 })
    // A newer operation takes over the stale lock.
    const second = await callBg({ type: 'SEND_LOCK_ACQUIRE' })
    assert.ok(second.ok, 'stale lock is replaceable')
    // The ORIGINAL owner releasing must NOT delete the new holder's lock.
    await callBg({ type: 'SEND_LOCK_RELEASE', owner: first.lockOwner })
    assert.ok(session.get('send_lock'), 'the newer lock must survive a stale release')
    assert.equal(session.get('send_lock').owner, second.lockOwner)
    // The rightful owner can release it.
    await callBg({ type: 'SEND_LOCK_RELEASE', owner: second.lockOwner })
    assert.equal(session.get('send_lock'), undefined)
  })

  test('two concurrent sendTransactions: only one approval is queued', async () => {
    reseed()
    await Promise.all([
      new Promise(res => { onConnect({ id: 'p1', method: 'bdx_sendTransaction', params: { to: SECRETS.address, amount: '1000000000' } }); setTimeout(res, 0) }),
      new Promise(res => { onConnect({ id: 'p2', method: 'bdx_sendTransaction', params: { to: SECRETS.address, amount: '1000000000' } }); setTimeout(res, 0) })
    ])
    await settle()
    const pending = session.get('dapp_pending') ?? {}
    const sends = Object.values(pending).filter(m => m.method === 'bdx_sendTransaction')
    assert.equal(sends.length, 1, 'exactly one send approval may be admitted')
    const errors = sentToPage.filter(m => m.error)
    assert.ok(errors.length >= 1, 'the loser gets an error, not a second prompt')
  })

  test('concurrent whole-map grant mutations do not lose an update', async () => {
    // Three granted origins; revoke two of them concurrently. Each revocation
    // is a read-modify-write of the same map — unserialized, the slower write
    // (built from a stale snapshot) would resurrect the origin the other one
    // removed. Serialized, both revocations land.
    const A = 'https://a.example', B = 'https://b.example', C = 'https://c.example'
    reseed({
      [A]: { walletId: 'w1', grantedAt: 1 },
      [B]: { walletId: 'w1', grantedAt: 2 },
      [C]: { walletId: 'w1', grantedAt: 3 }
    })
    await Promise.all([
      callBg({ type: 'DAPP_REVOKE_ORIGIN', origin: A }),
      callBg({ type: 'DAPP_REVOKE_ORIGIN', origin: B })
    ])
    const after = local.get('dapp_origins') ?? {}
    assert.equal(after[A], undefined, 'revocation of A must not be lost')
    assert.equal(after[B], undefined, 'revocation of B must not be lost')
    assert.ok(after[C], 'the untouched grant C must remain')
  })
})
