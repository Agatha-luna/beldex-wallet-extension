// Coverage for the KEEPALIVE / TOUCH split (external audit: "Approval-Page
// Keepalive Extends the Auto-Lock Session Without User Activity"). Drives the
// BUILT background bundle and observes the auto-lock alarm: a KEEPALIVE
// heartbeat must NOT re-arm it (so an unattended pending approval still locks
// on schedule), while a TOUCH from real user activity must.
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

const SECRETS = {
  address: 'bx' + 'a'.repeat(95), pubSpendKey: 'a'.repeat(64), secSpendKey: 'b'.repeat(64),
  pubViewKey: 'c'.repeat(64), secViewKey: 'd'.repeat(64), mnemonic: 'x', seed: 'y'
}

function memStore(map) {
  return {
    get: async k => { const keys = k == null ? [...map.keys()] : [].concat(k); const o = {}; for (const key of keys) if (map.has(key)) o[key] = map.get(key); return o },
    set: async o => { for (const [k, v] of Object.entries(o)) map.set(k, v) },
    remove: async k => { for (const key of [].concat(k)) map.delete(key) },
    setAccessLevel: async () => {}
  }
}

describe('keepalive vs auto-lock', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, callBg, alarms

  before(() => {
    local = new Map(); session = new Map()
    alarms = [] // records chrome.alarms.create calls
    const msgListeners = []
    const chrome = {
      runtime: {
        id: 'ext-id',
        onMessage: { addListener: f => msgListeners.push(f) },
        onConnect: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        getManifest: () => ({ version: '0' }), getURL: p => 'x/' + p,
        sendMessage: async () => {}, getContexts: async () => []
      },
      storage: { local: memStore(local), session: memStore(session) },
      alarms: {
        onAlarm: { addListener: () => {} },
        create: (name, info) => alarms.push({ name, info }),
        clear: async () => {}
      },
      action: { onClicked: { addListener: () => {} } },
      sidePanel: { setPanelBehavior: async () => {} },
      windows: { onRemoved: { addListener: () => {} }, getLastFocused: async () => ({}), create: async () => ({ id: 1 }), remove: async () => {} },
      tabs: { query: async () => [] },
      notifications: { create: () => {} }
    }
    const unref = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); t?.unref?.(); return t }
    const sandbox = { chrome, console, crypto: globalThis.crypto, TextEncoder, TextDecoder, setTimeout: unref, clearTimeout, setInterval, clearInterval, fetch: async () => ({ ok: true, json: async () => ({}) }), URL }
    sandbox.self = sandbox; sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)
    callBg = req => new Promise(res => msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))
  })

  function seedUnlocked() {
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    session.set('session_secrets', { walletId: 'w1', generation: 'g', secrets: SECRETS })
  }
  const autoLockArmed = () => alarms.filter(a => a.name === 'auto_lock')

  test('KEEPALIVE does not re-arm the auto-lock alarm', async () => {
    seedUnlocked()
    alarms.length = 0
    const r = await callBg({ type: 'KEEPALIVE' })
    assert.equal(r.ok, true)
    assert.equal(autoLockArmed().length, 0, 'KEEPALIVE must not touch auto-lock')
  })

  test('TOUCH (real activity) re-arms the auto-lock alarm', async () => {
    seedUnlocked()
    alarms.length = 0
    const r = await callBg({ type: 'TOUCH' })
    assert.equal(r.ok, true)
    assert.equal(autoLockArmed().length, 1, 'TOUCH must re-arm auto-lock')
  })

  test('TOUCH while locked does nothing (no session to keep alive)', async () => {
    local.set('wallets', { w1: { name: 'W1', address: SECRETS.address } })
    local.set('active_wallet_id', 'w1')
    session.delete('session_secrets')
    alarms.length = 0
    await callBg({ type: 'TOUCH' })
    assert.equal(autoLockArmed().length, 0)
  })
})
