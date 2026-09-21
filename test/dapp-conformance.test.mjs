// Runtime conformance guard (external audit: "Protocol, Type Declarations, and
// Repository Documentation Have Drifted From Implementation"). Pins the
// security-relevant wire facts the docs got wrong, by driving the BUILT
// background bundle: grant requirements per method, walletVersion privacy
// gating, coarse pre-grant getState, and unknown-method handling. If the
// routing changes without the README/protocol notes changing, this fails.
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

describe('dapp wire conformance', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, sentToPage, onConnect

  before(() => {
    local = new Map(); session = new Map(); sentToPage = []
    const connectListeners = []
    const chrome = {
      runtime: {
        id: 'ext-id',
        onMessage: { addListener: () => {} },
        onConnect: { addListener: f => connectListeners.push(f) },
        onInstalled: { addListener: () => {} },
        getManifest: () => ({ version: '9.9.9' }),
        getURL: p => 'chrome-extension://ext-id/' + p,
        sendMessage: async () => {}, getContexts: async () => []
      },
      storage: { local: memStore(local), session: memStore(session) },
      alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: async () => {} },
      action: { onClicked: { addListener: () => {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      windows: { onRemoved: { addListener: () => {} }, getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }), create: async () => ({ id: 9 }), remove: async () => {} },
      tabs: { query: async () => [{ id: 1 }] },
      notifications: { create: () => {} }
    }
    const unref = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t?.unref?.(); return t }
    const sandbox = {
      chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder,
      setTimeout: unref, clearTimeout, setInterval, clearInterval,
      fetch: async () => ({ ok: true, json: async () => ({}) }), URL
    }
    sandbox.self = sandbox; sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)

    const portListeners = []
    const port = {
      name: 'bdx-dapp', sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/x' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m), disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    onConnect = req => portListeners.forEach(f => f(req, port))
  })

  function seed({ grant, unlocked = true } = {}) {
    local.clear(); session.clear(); sentToPage.length = 0
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    if (grant) local.set('dapp_origins', { [ORIGIN]: { walletId: 'w1', grantedAt: Date.now() } })
    if (unlocked) session.set('session_secrets', { walletId: 'w1', generation: 'g', secrets: SECRETS })
  }
  const call = async (method, params) => {
    sentToPage.length = 0
    onConnect({ id: 'r', method, ...(params ? { params } : {}) })
    await new Promise(r => setTimeout(r, 120))
    return sentToPage.find(m => m.id === 'r')
  }

  test('grant-required reads reject an ungranted origin with 4100', async () => {
    seed({ grant: false })
    for (const m of ['bdx_getAddress', 'bdx_getBalance', 'bdx_getOperationStatus']) {
      const r = await call(m, m === 'bdx_getOperationStatus' ? { operationId: 'x' } : undefined)
      assert.equal(r?.error?.code, 4100, `${m} must require a grant`)
    }
  })

  test('walletVersion is grant-gated on bdx_getNetwork', async () => {
    seed({ grant: false })
    const ungranted = await call('bdx_getNetwork')
    assert.equal(ungranted.result.walletVersion, undefined, 'ungranted must NOT learn walletVersion')
    assert.ok(ungranted.result.nettype, 'nettype is public')
    assert.equal(ungranted.result.protocolVersion, 1)

    seed({ grant: true })
    const granted = await call('bdx_getNetwork')
    assert.equal(granted.result.walletVersion, '9.9.9', 'granted origin gets walletVersion')
  })

  test('bdx_getState is coarse pre-grant (locked even when unlocked)', async () => {
    seed({ grant: false, unlocked: true })
    const r = await call('bdx_getState')
    assert.equal(r.result.state, 'locked', 'ungranted must not learn unlocked/locked granularity')

    seed({ grant: true, unlocked: true })
    const g = await call('bdx_getState')
    assert.equal(g.result.state, 'unlocked', 'granted origin sees the true state')
  })

  test('keyless reads need no grant; unknown methods are dropped at the port', async () => {
    seed({ grant: false })
    const net = await call('bdx_getNetwork')
    assert.ok(net.result, 'bdx_getNetwork is open')
    // The background port now authoritatively re-validates the method against
    // DAPP_METHODS (external audit), so an unknown method is dropped BEFORE
    // dispatch — no reply at all (stronger than the old default-case
    // METHOD_NOT_FOUND, which stays reachable only for a KNOWN-but-unhandled
    // method that passes the schema).
    const unknown = await call('bdx_notARealMethod')
    assert.equal(unknown, undefined, 'unknown methods are not routed')
  })
})
