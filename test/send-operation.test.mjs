// Coverage for the send operation state machine (external audit: "Transaction
// Execution Can Outlive a Terminal dApp Failure or Timeout"). Drives the BUILT
// background bundle through a fake chrome API. Verifies:
//   - DAPP_BEGIN_SEND cancels the review TTL and mints an execution token, so
//     the approval timer can no longer expire the request mid-flight;
//   - DAPP_COMPLETE requires a valid token and persists the outcome, and the
//     outcome is queryable via bdx_getOperationStatus after the fact;
//   - a bdx_sendTransaction retry with the same idempotencyKey replays the
//     recorded outcome instead of creating a second approval (no dup payment);
//   - a mismatched/absent execution token is refused.
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
const TO = 'bx' + 'a'.repeat(95)
const SECRETS = {
  address: 'bx' + 'b'.repeat(95), pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
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

describe('send operation state machine', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
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
      sender: { origin: ORIGIN, tab: { id: 1 }, url: ORIGIN + '/checkout' },
      onMessage: { addListener: f => portListeners.push(f) },
      onDisconnect: { addListener: () => {} },
      postMessage: m => sentToPage.push(m), disconnect: () => {}
    }
    connectListeners.forEach(f => f(port))
    onConnect = req => portListeners.forEach(f => f(req, port))
    callBg = req => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
  })

  function reseed() {
    local.clear(); session.clear(); sentToPage.length = 0
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    local.set('dapp_origins', { [ORIGIN]: { walletId: 'w1', grantedAt: Date.now() } })
    session.set('session_secrets', { walletId: 'w1', generation: 'gen-1', secrets: SECRETS })
  }
  const settle = () => new Promise(r => setTimeout(r, 150))
  const pendingId = () => Object.keys(session.get('dapp_pending') ?? {})[0]

  test('begin -> complete records a queryable outcome; token is required', async () => {
    reseed()
    onConnect({ id: 'pg-send', method: 'bdx_sendTransaction', params: { to: TO, amount: '1000000000', idempotencyKey: 'order-abc-123' } })
    await settle()
    const reqId = pendingId()
    assert.ok(reqId, 'send approval queued')

    const begin = await callBg({ type: 'DAPP_BEGIN_SEND', reqId })
    assert.equal(begin.ok, true)
    assert.ok(begin.executionToken && begin.operationId, 'token + operationId returned')

    // Persisted pending entry is gone (so nothing can expire it mid-send)...
    assert.equal(session.get('dapp_pending')[reqId], undefined)
    // ...and an executing operation exists.
    const ops = session.get('dapp_operations')
    assert.equal(ops[begin.operationId].state, 'executing')

    // A bad token is refused.
    const bad = await callBg({ type: 'DAPP_COMPLETE', reqId, operationId: begin.operationId, executionToken: 'WRONG', result: { txHash: 'tx1', fee: '5' } })
    assert.equal(bad.ok, false)

    // The real token completes and persists the outcome.
    sentToPage.length = 0
    const done = await callBg({ type: 'DAPP_COMPLETE', reqId, operationId: begin.operationId, executionToken: begin.executionToken, result: { txHash: 'txHASH', fee: '5' } })
    assert.equal(done.ok, true)
    assert.equal(session.get('dapp_operations')[begin.operationId].state, 'confirmed')
    const reply = sentToPage.find(m => m.id === 'pg-send')
    assert.equal(reply?.result?.txHash, 'txHASH')
    assert.equal(reply?.result?.operationId, begin.operationId)

    // bdx_getOperationStatus reports the confirmed outcome to the origin.
    sentToPage.length = 0
    onConnect({ id: 'pg-status', method: 'bdx_getOperationStatus', params: { operationId: begin.operationId } })
    await settle()
    const st = sentToPage.find(m => m.id === 'pg-status')
    assert.equal(st?.result?.status, 'confirmed')
    assert.equal(st?.result?.txHash, 'txHASH')
  })

  test('idempotent retry replays the outcome instead of a second approval', async () => {
    // (continues from the confirmed operation above — same origin + key)
    sentToPage.length = 0
    const before = Object.keys(session.get('dapp_pending') ?? {}).length
    onConnect({ id: 'pg-send-2', method: 'bdx_sendTransaction', params: { to: TO, amount: '1000000000', idempotencyKey: 'order-abc-123' } })
    await settle()
    const reply = sentToPage.find(m => m.id === 'pg-send-2')
    assert.ok(reply?.result, 'must reply immediately, not queue an approval')
    assert.equal(reply.result.txHash, 'txHASH')
    assert.equal(reply.result.idempotent, true)
    assert.equal(Object.keys(session.get('dapp_pending') ?? {}).length, before, 'no new approval queued')
  })

  test('an EXECUTING send is not expired by the pending pruning path', async () => {
    reseed()
    onConnect({ id: 'pg-send-3', method: 'bdx_sendTransaction', params: { to: TO, amount: '1000000000' } })
    await settle()
    const reqId = pendingId()
    const begin = await callBg({ type: 'DAPP_BEGIN_SEND', reqId })
    assert.equal(begin.ok, true)

    // A fresh connect from the same origin triggers pendingConflicts pruning;
    // the executing send must survive (no persisted entry to prune) and stay
    // completable.
    onConnect({ id: 'pg-conn', method: 'bdx_connect' })
    await settle()
    const done = await callBg({ type: 'DAPP_COMPLETE', reqId, operationId: begin.operationId, executionToken: begin.executionToken, result: { txHash: 'tx3', fee: '1' } })
    assert.equal(done.ok, true)
  })
})
