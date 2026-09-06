// Regression: an approval-gated reply must echo the PAGE's request id.
//
// The inpage provider correlates responses against the id it generated. The
// background used to answer with its own internal approval reqId, so the reply
// arrived, matched nothing in the page's pending map, and was dropped — every
// connect() / sendTransaction() / signMessage() promise hung forever with no
// error anywhere. Reads were unaffected (they answer with req.id directly),
// and connect appeared to work only because the wallet also pushes a `connect`
// event, which carries no id.
//
// This drives the BUILT background bundle through a fake chrome API: request in
// over a content-script port, approval completed from the panel, reply out.
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

const PAGE_REQ_ID = 'page-generated-id-1'
// https: an http origin would be purged by the startup insecure-origin grant
// migration (audit M2), which is unrelated to the reply plumbing under test.
const ORIGIN = 'https://site.test'
const SECRETS = {
  address: 'bx9testaddress', pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
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

describe('approval replies', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let session, sentToPage, onMessage, onConnect

  before(async () => {
    const local = new Map()
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
        create: async () => ({ id: 99 }),
        remove: async () => {}
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

    // One unlocked wallet, origin already granted.
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    local.set('dapp_origins', { [ORIGIN]: { walletId: 'w1', grantedAt: Date.now() } })
    session.set('session_secrets', { walletId: 'w1', secrets: SECRETS })

    const portListeners = []
    const port = {
      name: 'bdx-dapp',
      sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/page' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m),
      disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))

    onConnect = req => portListeners.forEach(f => f(req, port))
    onMessage = (req, url = 'chrome-extension://ext-id/panel.html') =>
      msgListeners[0](req, { id: 'ext-id', url }, () => {})
  })

  test('a signMessage approval replies with the page request id', async () => {
    onConnect({ id: PAGE_REQ_ID, method: 'bdx_signMessage', params: { message: 'hello' } })
    await new Promise(r => setTimeout(r, 300))

    assert.equal(sentToPage.length, 0, 'must not answer before the user approves')
    const pending = session.get('dapp_pending') ?? {}
    const reqId = Object.keys(pending)[0]
    assert.ok(reqId, 'no approval was queued')
    assert.equal(pending[reqId].method, 'bdx_signMessage')
    assert.notEqual(reqId, PAGE_REQ_ID, 'internal approval id is distinct by construction')

    onMessage({ type: 'DAPP_SIGN_COMPLETE', reqId, result: { signature: 'SigV1x', address: SECRETS.address } })
    await new Promise(r => setTimeout(r, 300))

    assert.equal(sentToPage.length, 1)
    assert.equal(sentToPage[0].id, PAGE_REQ_ID,
      'reply must echo the page id, not the wallet-internal approval id')
    assert.equal(sentToPage[0].result.signature, 'SigV1x')
  })

  test('a read replies with the page request id too', async () => {
    sentToPage.length = 0
    onConnect({ id: 'read-1', method: 'bdx_getAddress' })
    await new Promise(r => setTimeout(r, 300))
    assert.equal(sentToPage[0].id, 'read-1')
    assert.equal(sentToPage[0].result.address, SECRETS.address)
  })
})
