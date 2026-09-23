// Runtime mainnet/testnet switching, driven through the BUILT background bundle
// with a fake chrome API (same harness as approval-context-binding.test.mjs).
//
// The model these tests pin down:
//   - The active NETWORK is global. It is changed only by SWITCH_NETWORK, never
//     as a side effect of anything else — in particular, selecting a wallet must
//     not move the user to another chain (that was a real bug).
//   - A WALLET lists the networks it appears on. Every wallet is returned, with
//     that list, so wallet selection can offer a wallet from the other chain and
//     bring it over (ADD_WALLET_TO_NETWORK). Only wallets on the active chain
//     are SELECTABLE, which is what makes picking one unable to change the chain.
//   - Switching is refused (WALLET_NOT_ON_NETWORK) when the ACTIVE wallet is not
//     on the target chain. The user is asked whether to bring it along;
//     declining leaves them exactly where they were.
//   - The active wallet is remembered PER NETWORK, so switching chains restores
//     whichever wallet was last used there.
//   - The account is one keypair on every chain, so when the same wallet is on
//     both, a switch re-encodes its address and the session survives. When the
//     target chain's wallet is a different one, the session must end.
//
// Also covered: defaults and migration from the older per-wallet `network`
// field, the empty-chain bootstrap, the send lock, cache invalidation, approval
// voiding, grant survival + events, backend re-pointing, /login registration on
// the new chain, and that a newly created wallet opens UNLOCKED.
//
//   npm run build   # produces the bundle this test loads

import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { addressForNettype } from '../src/lib/signMessage.ts'
import { encryptVault } from '../src/lib/keyring.ts'

// Endpoint table resolved the way the BUILD resolves it: networks.json, then
// .env, then process.env — so pointing a network at a private LWS in .env does
// not make these assertions go stale.
//
// This deliberately re-implements webpack's tiny override lookup instead of
// importing webpack.config.js: these tests run under
// --disallow-code-generation-from-strings, and pulling in webpack itself throws
// under that flag. Only the `lws` field is needed here.
function readDotEnv (url) {
  const out = {}
  let raw
  try { raw = readFileSync(url, 'utf8') } catch { return out }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const k = t.slice(0, eq).trim()
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (k) out[k] = v
  }
  return out
}
const DOTENV = readDotEnv(new URL('../.env', import.meta.url))
const BASE_NETS = JSON.parse(readFileSync(new URL('../src/lib/networks.json', import.meta.url), 'utf8'))
const NETS = {}
for (const n of Object.keys(BASE_NETS)) {
  if (n.startsWith('_')) continue
  const override = process.env[`${n.toUpperCase()}_LWS_URL`] ?? DOTENV[`${n.toUpperCase()}_LWS_URL`]
  NETS[n] = { ...BASE_NETS[n], lws: override ?? BASE_NETS[n].lws }
}
const lwsHost = n => new URL(NETS[n].lws).host

const here = dirname(fileURLToPath(import.meta.url))
const CANDIDATES = ['dist/background.js', 'dist-testnet/background.js',
                    'firefox/background.js', 'firefox-testnet/background.js']
const bundle = CANDIDATES.map(p => join(here, '..', p)).find(existsSync)

// Real, well-formed keypairs: the address encoder validates lengths, and these
// let the tests assert the EXACT expected address per chain.
const KEYS_A = {
  pubSpendKey: '9311d9b124ea672556abc4639eb7cb75a6c296a18cf021302b12bd5839428451',
  pubViewKey: '11339ea99715fd0fd808a36ad5364b594f393cd30d15d3686f6d687354103803'
}
const KEYS_B = {
  pubSpendKey: '7b42ec256dbab0fca83ad0bfe87e9704624d9d2fc1c0714ef6e2701c96a380a6',
  pubViewKey: '45f8df72c930c39b7e1cb63590137c6174ba6571dc14b44ae00acf3b773f3e18'
}
const addrOf = (keys, net) =>
  addressForNettype(keys.pubSpendKey, keys.pubViewKey, net === 'mainnet' ? 0 : 1)

// Which chain a fresh wallet starts on is a BUILD default, so a testnet build
// makes it 'testnet'. Detected from the bundle under test rather than assumed.
let HOME = 'mainnet'
let OTHER = 'testnet'

const ORIGIN = 'https://site.test'
const PASSWORD = 'correct horse battery'

// REAL encrypted vaults, so the password gate exercises the actual
// PBKDF2+AES-GCM decrypt path rather than a stub that always succeeds.
let VAULT_A, VAULT_B

const secretsFor = keys => ({
  ...keys, secSpendKey: 'b'.repeat(64), secViewKey: 'd'.repeat(64),
  mnemonic: 'x', seed: 'y', address: ''
})

function memStore (map) {
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

describe('network switching', { skip: bundle ? false : 'no built bundle — run npm run build first' }, () => {
  let local, session, sentToPage, onConnect, callBg, fetched

  /**
   * @param opts.aNetworks networks wallet A is on (default: [HOME])
   * @param opts.bNetworks networks wallet B is on, or omitted to leave B out
   * @param opts.unlocked  start with A unlocked (default true)
   * @param opts.activeByNetwork  preset per-network active wallet
   */
  const seed = (opts = {}) => {
    const aNetworks = opts.aNetworks ?? [HOME]
    const bNetworks = opts.bNetworks ?? null
    const unlocked = opts.unlocked ?? true

    local.clear(); session.clear()
    sentToPage.length = 0; fetched.length = 0

    const allAddrs = keys =>
      Object.fromEntries(Object.keys(NETS).map(n => [n, addrOf(keys, n)]))

    const wallets = {
      A: {
        name: 'Wallet A',
        address: addrOf(KEYS_A, aNetworks[0]),
        addresses: allAddrs(KEYS_A),
        networks: aNetworks,
        vault: VAULT_A
      }
    }
    if (bNetworks) {
      wallets.B = {
        name: 'Wallet B',
        address: addrOf(KEYS_B, bNetworks[0]),
        addresses: allAddrs(KEYS_B),
        networks: bNetworks,
        vault: VAULT_B
      }
    }
    local.set('wallets', wallets)
    local.set('active_network', HOME)
    local.set('active_wallet_by_network', opts.activeByNetwork ?? { [HOME]: 'A' })
    local.set('active_wallet_id', 'A')
    local.set('dapp_origins', { [ORIGIN]: { walletId: 'A', grantedAt: Date.now() } })
    if (unlocked) {
      session.set('session_secrets', {
        walletId: 'A', generation: 'gen-A',
        secrets: { ...secretsFor(KEYS_A), address: addrOf(KEYS_A, HOME) }
      })
    }
  }

  before(async () => {
    VAULT_A = await encryptVault(JSON.stringify(secretsFor(KEYS_A)), PASSWORD)
    VAULT_B = await encryptVault(JSON.stringify(secretsFor(KEYS_B)), PASSWORD)
    fetched = []
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
      // Record every outbound call so tests can assert WHICH chain's backend the
      // bundle actually talks to after a switch.
      fetch: async (url, init) => {
        fetched.push({ url: String(url), body: init?.body ? String(init.body) : '' })
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({}), text: async () => '{}'
        }
      }, URL,
      // keyring.ts base64s the vault with atob/btoa — without these the password
      // gate fails open as "incorrect password" for every attempt.
      atob, btoa,
      // http.ts wraps every backend call in an abort deadline. Without this the
      // fetch throws before it is ever made and the wallet's own catch-and-retry
      // swallows it — so the test would see silence and wrongly call it a pass.
      AbortController
    }
    sandbox.self = sandbox
    sandbox.globalThis = sandbox
    vm.runInNewContext(readFileSync(bundle, 'utf8'), sandbox)

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
    callBg = req => new Promise(res =>
      msgListeners[0](req, { id: 'ext-id', url: 'chrome-extension://ext-id/panel.html' }, res))

    // Ask the bundle which chain it defaults to, and orient every test around it.
    local.set('wallets', { A: { name: 'Wallet A', address: 'bxA', vault: VAULT_A } })
    local.set('active_wallet_id', 'A')
    const probe = await callBg({ type: 'GET_STATE' })
    HOME = probe.network
    OTHER = HOME === 'mainnet' ? 'testnet' : 'mainnet'
  })

  const settle = () => new Promise(r => setTimeout(r, 200))
  const pendingId = () => Object.keys(session.get('dapp_pending') ?? {})[0]
  const sessionAddr = () => session.get('session_secrets')?.secrets?.address
  const storedNets = id => (local.get('wallets'))[id].networks
  const activeNet = () => local.get('active_network')
  const both = () => [HOME, OTHER]
  const sorted = a => [...a].sort()
  // Values that came out of the vm carry ITS Array/Object prototypes, which
  // deepStrictEqual rejects as "same structure but not reference-equal". Round
  // -tripping through JSON rebuilds them in this realm.
  const plain = v => JSON.parse(JSON.stringify(v))

  // ---- defaults & migration ------------------------------------------------

  test('a wallet with no network fields defaults to the build network', async () => {
    local.clear(); session.clear()
    local.set('wallets', { A: { name: 'Wallet A', address: 'bxA', vault: VAULT_A } })
    local.set('active_wallet_id', 'A')
    const r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.ok, true)
    assert.equal(r.network, HOME)
    assert.deepEqual(plain(r.wallets.map(w => w.networks)), [[HOME]])
  })

  test('a wallet stored with the older single `network` field still resolves', async () => {
    local.clear(); session.clear()
    local.set('wallets', { A: { name: 'Wallet A', address: 'bxA', network: OTHER, vault: VAULT_A } })
    local.set('active_wallet_id', 'A')
    // The active network migrates to that wallet's chain rather than snapping to
    // the build default, so an existing install lands where the user left off.
    const r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.network, OTHER)
    assert.deepEqual(plain(r.wallets[0].networks), [OTHER])
  })

  // ---- list filtering ------------------------------------------------------

  test('every wallet is listed, each saying which networks it is on', async () => {
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    const r = await callBg({ type: 'GET_STATE' })
    // Both are returned — wallet selection needs to offer B so it can be
    // brought onto this chain; hiding it would leave no route to it.
    assert.deepEqual(plain(r.wallets.map(w => w.id)), ['A', 'B'])
    const byId = Object.fromEntries(r.wallets.map(w => [w.id, w]))
    assert.deepEqual(plain(byId.A.networks), [HOME])
    assert.deepEqual(plain(byId.B.networks), [OTHER])
    // A wallet that is not on the active chain carries no address for it.
    assert.ok(byId.A.address, 'A is on this chain and must show its address')
    assert.equal(byId.B.address, '', 'B is not on this chain')
  })

  test('a wallet on both networks carries an address on both', async () => {
    seed({ aNetworks: both() })
    let r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.wallets[0].address, addrOf(KEYS_A, HOME))
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.network, OTHER)
    assert.equal(r.wallets[0].address, addrOf(KEYS_A, OTHER))
  })

  // ---- the bug: selecting a wallet must not change the network -------------

  test('selecting a wallet does NOT change the network', async () => {
    seed({ aNetworks: both(), bNetworks: both() })
    const before = activeNet()
    const r = await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    assert.equal(r.ok, true)
    assert.equal(r.network, before, 'the chain must be untouched by a wallet change')
    assert.equal(activeNet(), before)
    assert.equal(r.wallets.find(w => w.active).id, 'B')
  })

  test('selecting a wallet that is not on the active network is refused', async () => {
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    const r = await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    assert.equal(r.ok, false)
    assert.match(r.error, /not available/i)
    assert.equal(activeNet(), HOME, 'a refused selection must not move the chain either')
  })

  // ---- switching -----------------------------------------------------------

  test('switching re-encodes the address and keeps the session for the same wallet', async () => {
    seed({ aNetworks: both() })
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(r.ok, true)
    assert.equal(r.network, OTHER)
    assert.equal(r.state, 'unlocked', 'same keypair on both chains — no re-unlock')
    assert.equal(sessionAddr(), addrOf(KEYS_A, OTHER))
    assert.notEqual(addrOf(KEYS_A, OTHER), addrOf(KEYS_A, HOME))
    assert.equal(session.get('session_secrets').secrets.pubSpendKey, KEYS_A.pubSpendKey)
    assert.equal(activeNet(), OTHER)
  })

  test('switching to a chain whose last-used wallet is a DIFFERENT one ends the session', async () => {
    // A is on both, so the switch proceeds without asking; OTHER last used B.
    seed({
      aNetworks: both(), bNetworks: both(),
      activeByNetwork: { [HOME]: 'A', [OTHER]: 'B' }
    })
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(r.ok, true)
    assert.equal(r.network, OTHER)
    // B's keys are not ours to serve, so the session cannot carry over.
    assert.equal(r.state, 'locked')
    assert.equal(session.get('session_secrets'), undefined)
    assert.equal(r.wallets.find(w => w.active).id, 'B')
  })

  test('switching is refused when THIS wallet is not on the target chain', async () => {
    // Even though the target chain has a wallet of its own, the user is looking
    // at A — moving them onto B unannounced would lose their place.
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'WALLET_NOT_ON_NETWORK')
    assert.match(r.error, /Wallet A/)
    assert.equal(activeNet(), HOME, 'declining must leave the chain alone')
    assert.equal(sessionAddr(), addrOf(KEYS_A, HOME), 'and the session untouched')
  })

  test('accepting brings this wallet across and stays on it', async () => {
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER, addActiveWallet: true })
    assert.equal(r.ok, true)
    assert.equal(r.network, OTHER)
    assert.deepEqual(plain(sorted(storedNets('A'))), sorted(both()))
    // Stays on A rather than adopting B, which is what the user just asked for.
    assert.equal(r.wallets.find(w => w.active).id, 'A')
    assert.equal(r.state, 'unlocked', 'same wallet, so no re-unlock')
    assert.equal(sessionAddr(), addrOf(KEYS_A, OTHER))
  })

  test('the active wallet is remembered per network', async () => {
    seed({ aNetworks: both(), bNetworks: both() })
    // On HOME pick B; on OTHER pick A; each chain must keep its own choice.
    await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await callBg({ type: 'SWITCH_WALLET', id: 'A' })
    let r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.wallets.find(w => w.active).id, 'A')

    await callBg({ type: 'SWITCH_NETWORK', network: HOME })
    r = await callBg({ type: 'GET_STATE' })
    assert.equal(r.network, HOME)
    assert.equal(r.wallets.find(w => w.active).id, 'B', 'HOME must restore its own last wallet')
  })

  test('an empty target chain follows the same rule', async () => {
    seed({ aNetworks: [HOME] })
    let r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(r.ok, false, 'landing on a chain with no wallet would be a dead end')
    assert.equal(r.code, 'WALLET_NOT_ON_NETWORK')
    assert.equal(activeNet(), HOME)

    r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER, addActiveWallet: true })
    assert.equal(r.ok, true)
    assert.equal(r.network, OTHER)
    assert.deepEqual(plain(sorted(storedNets('A'))), sorted(both()))
    assert.equal(sessionAddr(), addrOf(KEYS_A, OTHER))
  })

  test('an unknown network is rejected, and a no-op switch changes nothing', async () => {
    seed({ aNetworks: both() })
    const bad = await callBg({ type: 'SWITCH_NETWORK', network: 'dogecoin' })
    assert.equal(bad.ok, false)
    assert.equal(activeNet(), HOME)

    const gen = session.get('session_secrets').generation
    const same = await callBg({ type: 'SWITCH_NETWORK', network: HOME })
    assert.equal(same.ok, true)
    assert.equal(session.get('session_secrets').generation, gen)
    assert.equal(sessionAddr(), addrOf(KEYS_A, HOME))
  })

  // ---- which networks a wallet appears on ----------------------------------

  test('a wallet from the other chain can be brought onto this one, then selected', async () => {
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    // B lives on the other chain: not selectable yet.
    let r = await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    assert.equal(r.ok, false)

    r = await callBg({ type: 'ADD_WALLET_TO_NETWORK', id: 'B', network: HOME })
    assert.equal(r.ok, true)
    assert.deepEqual(plain(sorted(storedNets('B'))), sorted(both()))
    assert.equal(activeNet(), HOME, 'bringing a wallet over must not change the chain')

    // ...and now it is selectable, still without moving the chain.
    r = await callBg({ type: 'SWITCH_WALLET', id: 'B' })
    assert.equal(r.ok, true)
    assert.equal(r.network, HOME)
    assert.equal(r.wallets.find(w => w.active).id, 'B')
  })

  test('adding a wallet to a network is idempotent, and validated', async () => {
    seed({ aNetworks: [HOME], bNetworks: [OTHER] })
    await callBg({ type: 'ADD_WALLET_TO_NETWORK', id: 'B', network: HOME })
    await callBg({ type: 'ADD_WALLET_TO_NETWORK', id: 'B', network: HOME })
    assert.deepEqual(plain(sorted(storedNets('B'))), sorted(both()), 'no duplicate entries')

    let r = await callBg({ type: 'ADD_WALLET_TO_NETWORK', id: 'nope', network: HOME })
    assert.equal(r.ok, false)
    r = await callBg({ type: 'ADD_WALLET_TO_NETWORK', id: 'B', network: 'dogecoin' })
    assert.equal(r.ok, false)
  })

  test('a newly created wallet opens unlocked, not asking for a password', async () => {
    seed({ aNetworks: [HOME] })
    const fresh = {
      pubSpendKey: 'c'.repeat(64), pubViewKey: 'e'.repeat(64),
      secSpendKey: 'f'.repeat(64), secViewKey: '9'.repeat(64),
      mnemonic: 'm', seed: 's', address: ''
    }
    const r = await callBg({ type: 'SAVE_WALLET', secrets: fresh, password: 'another-password', name: 'Fresh' })
    assert.equal(r.ok, true)
    // Regression: the new wallet was stored but not recorded as active FOR THIS
    // NETWORK, so getActiveId() still returned the previous wallet, the new
    // session failed to match it, and the panel demanded a password.
    assert.equal(r.state, 'unlocked')
    assert.equal(r.walletName, 'Fresh')
    const active = r.wallets.find(w => w.active)
    assert.equal(active.name, 'Fresh')
    assert.deepEqual(plain(active.networks), [HOME], 'a new wallet starts on the active chain')
  })

  // ---- send lock -----------------------------------------------------------

  test('a switch is refused while a send holds the lock', async () => {
    seed({ aNetworks: both() })
    const lock = await callBg({ type: 'SEND_LOCK_ACQUIRE' })
    // A transaction under construction is bound to one chain's unspent set, so
    // the chain must not move under it.
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(r.ok, false)
    assert.match(r.error, /in progress/i)
    assert.equal(activeNet(), HOME)

    await callBg({ type: 'SEND_LOCK_RELEASE', owner: lock.lockOwner })
    const ok = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    assert.equal(ok.ok, true)
  })

  // ---- backend -------------------------------------------------------------

  test('switching re-points the backend, and back again', async () => {
    seed({ aNetworks: both() })
    fetched.length = 0
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await settle()
    let hosts = [...new Set(fetched.map(f => new URL(f.url).host))]
    assert.ok(hosts.includes(lwsHost(OTHER)), `expected ${lwsHost(OTHER)}, saw ${JSON.stringify(hosts)}`)
    assert.ok(!hosts.includes(lwsHost(HOME)), 'must stop calling the chain we left')

    fetched.length = 0
    await callBg({ type: 'SWITCH_NETWORK', network: HOME })
    await settle()
    hosts = [...new Set(fetched.map(f => new URL(f.url).host))]
    assert.ok(hosts.includes(lwsHost(HOME)), `expected ${lwsHost(HOME)}, saw ${JSON.stringify(hosts)}`)
    assert.ok(!hosts.includes(lwsHost(OTHER)))
  })

  test('the account is registered on the new chain before anything reads it', async () => {
    seed({ aNetworks: both() })
    fetched.length = 0
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await settle()

    const loginIdx = fetched.findIndex(f => f.url === `${NETS[OTHER].lws}/login`)
    assert.ok(loginIdx >= 0,
      `no /login to ${NETS[OTHER].lws}; saw ${JSON.stringify(fetched.map(f => f.url))}`)
    const body = JSON.parse(fetched[loginIdx].body)
    assert.equal(body.create_account, true, 'must be allowed to create the account')
    assert.equal(body.address, addrOf(KEYS_A, OTHER), 'must register the NEW chain\'s address')

    const readIdx = fetched.findIndex(f => f.url.endsWith('/get_address_info'))
    if (readIdx >= 0) {
      assert.ok(loginIdx < readIdx, '/login must precede /get_address_info on a fresh chain')
    }
  })

  test('a refused switch does not touch the other chain\'s backend', async () => {
    seed({ aNetworks: [HOME] })   // A is not on OTHER, so the switch is refused
    fetched.length = 0
    const r = await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await settle()
    assert.equal(r.ok, false)
    const hosts = fetched.map(f => new URL(f.url).host)
    assert.ok(!hosts.includes(lwsHost(OTHER)), 'a refused switch must not register anything')
  })

  // ---- chain-specific state & the dapp bridge ------------------------------

  test('chain-specific caches are dropped on switch', async () => {
    seed({ aNetworks: both() })
    session.set('sync_cache',
      { info: { total_received: '999' }, at: Date.now(), address: addrOf(KEYS_A, HOME) })
    session.set('corrected_balance', { address: addrOf(KEYS_A, HOME), total_received: '999' })

    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })

    assert.notEqual(session.get('sync_cache')?.address, addrOf(KEYS_A, HOME))
    assert.equal(session.get('corrected_balance'), undefined)
  })

  test('a pending approval reviewed on the old chain is voided', async () => {
    seed({ aNetworks: both() })
    onConnect({ id: 'pg-sign', method: 'bdx_signMessage', params: { message: 'hello' } })
    await settle()
    const reqId = pendingId()
    assert.ok(reqId, 'approval should be queued')
    assert.equal((session.get('dapp_pending'))[reqId].network, HOME)

    sentToPage.length = 0
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await settle()

    assert.equal(pendingId(), undefined, 'the old chain\'s approval must be gone')
    const reply = sentToPage.find(m => m.id === 'pg-sign')
    assert.ok(reply?.error, 'the dapp must be told, not left hanging')
    assert.match(reply.error.message, /network/i)
  })

  test('grants survive, and the site is told what changed', async () => {
    seed({ aNetworks: both() })
    sentToPage.length = 0
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    await settle()

    assert.ok((local.get('dapp_origins'))[ORIGIN], 'grant must survive a network switch')
    const events = sentToPage.filter(m => m.event)
    const net = events.find(m => m.event === 'networkChanged')
    const acct = events.find(m => m.event === 'accountsChanged')
    assert.ok(net, 'networkChanged must be emitted')
    assert.equal(net.data.network, OTHER)
    assert.ok(acct, 'accountsChanged must be emitted — the address changed too')
    assert.equal(acct.data.address, addrOf(KEYS_A, OTHER))
  })

  test('bdx_getNetwork reports the new chain', async () => {
    seed({ aNetworks: both() })
    await callBg({ type: 'SWITCH_NETWORK', network: OTHER })
    sentToPage.length = 0
    onConnect({ id: 'pg-net', method: 'bdx_getNetwork' })
    await settle()
    const reply = sentToPage.find(m => m.id === 'pg-net')
    assert.ok(reply?.result)
    assert.equal(reply.result.nettype, OTHER)
  })
})
