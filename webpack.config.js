const path = require('path')
const fs = require('fs')
const CopyPlugin = require('copy-webpack-plugin')
const webpack = require('webpack')
const networks = require('./src/lib/networks.json')

// Two targets from one codebase: Chrome (side_panel) -> dist/, Firefox
// (sidebar_action + gecko id) -> firefox/. Only the manifest differs; panel.js
// and background.js are byte-identical (platform.ts feature-detects at runtime).
//   npm run build:chrome | build:firefox | build (both)
//
// The chain is also a build-time choice (--env network=testnet, or BDX_NETWORK
// in .env): the resolved endpoints are baked into the bundle by DefinePlugin and
// their hosts are written into the manifest, so a build can only ever reach one
// chain. Testnet builds go to dist-testnet/ | firefox-testnet/ and carry a
// distinct extension name and Firefox add-on id, so both can be installed side
// by side.
//   npm run build:chrome:testnet | build:firefox:testnet | build:testnet
//
// Config precedence, lowest to highest:
//   src/lib/networks.json  ->  .env  ->  --env CLI flags

/**
 * Minimal .env reader. Deliberately not the `dotenv` package: this is a wallet,
 * and a four-line parser is worth more than a dependency in the build graph.
 * Supports `KEY=value`, `#` comments, blank lines, `export ` prefixes, and
 * optional single/double quotes. Values are NOT interpolated.
 */
function readDotEnv (file) {
  const out = {}
  if (!fs.existsSync(file)) return out
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

/**
 * Chrome/Firefox match pattern for a URL's origin. Match patterns may not carry
 * a port, so it is stripped — `http://1.2.3.4:29091/json_rpc` becomes
 * `http://1.2.3.4/*`. A manifest with a port in host_permissions is rejected
 * outright at load time, which is a confusing failure to debug.
 */
function hostPattern (url) {
  const u = new URL(url)
  return `${u.protocol}//${u.hostname}/*`
}

module.exports = (env = {}) => {
  const dotenv = readDotEnv(path.resolve(__dirname, '.env'))
  // process.env wins over .env so CI can override without writing a file.
  const cfg = (key) => process.env[key] ?? dotenv[key]

  const firefox = env.firefox === true || env.firefox === 'true'
  // CLI flag beats .env beats the mainnet default.
  const requested = env.network ?? cfg('BDX_NETWORK') ?? 'mainnet'
  const network = requested === 'testnet' ? 'testnet' : 'mainnet'
  const testnet = network === 'testnet'

  const bool = (v, fallback) => (v === undefined ? fallback : v !== 'false' && v !== '0')

  const autoLockMinutes = Number(cfg('BDX_AUTO_LOCK_MINUTES') ?? 15)
  if (!Number.isFinite(autoLockMinutes) || autoLockMinutes < 1 || autoLockMinutes > 240) {
    throw new Error(`BDX_AUTO_LOCK_MINUTES must be a number between 1 and 240 (got "${autoLockMinutes}")`)
  }

  // Every network is resolved and shipped, because the chain is now a RUNTIME
  // choice (per-wallet network switcher). `network` above only decides which
  // one a fresh wallet starts on, and the build's testnet branding.
  const resolveNetwork = (name) => {
    const P = name.toUpperCase() // MAINNET_ / TESTNET_ override prefix
    const base = networks[name]
    return {
      network: name,
      nettype: base.nettype,
      label: base.label,
      lws: cfg(`${P}_LWS_URL`) ?? base.lws,
      daemonRpc: cfg(`${P}_DAEMON_RPC_URL`) ?? base.daemonRpc,
      bnsLookup: cfg(`${P}_BNS_LOOKUP_URL`) ?? base.bnsLookup,
      explorerTx: cfg(`${P}_EXPLORER_TX_URL`) ?? base.explorerTx,
      priceUrl: cfg(`${P}_PRICE_URL`) ?? base.priceUrl,
      showFiat: bool(cfg(`${P}_SHOW_FIAT`), base.showFiat),
      autoLockMinutes
    }
  }

  const nets = {}
  for (const name of Object.keys(networks)) {
    if (name.startsWith('_')) continue // networks.json carries a _comment block
    nets[name] = resolveNetwork(name)
  }
  const net = nets[network]

  // host_permissions are DERIVED from the URLs actually in use — across EVERY
  // network, since any of them can be selected at runtime. Overriding an
  // endpoint in .env can never leave the extension unable to fetch it, and
  // switching chains can never land on a host the manifest didn't grant. The
  // price host is included only for networks with fiat on.
  const urls = []
  for (const [name, n] of Object.entries(nets)) {
    const own = [n.lws, n.daemonRpc, n.bnsLookup, n.explorerTx]
    if (n.showFiat) own.push(n.priceUrl)
    for (const u of own) {
      try { new URL(u) } catch { throw new Error(`Invalid URL in network config (${name}): "${u}"`) }
    }
    urls.push(...own)
  }
  const extra = (cfg('BDX_EXTRA_HOSTS') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const hosts = [...new Set([...urls.map(hostPattern), ...extra])]

  // http:// endpoints are a footgun worth naming at build time: extension pages
  // are secure contexts, so the browser blocks plaintext fetches as mixed
  // content. Warn rather than fail — a local daemon over http is a legitimate
  // dev setup on some setups, and DAEMON_RPC_URL is currently unused.
  for (const u of urls) {
    if (new URL(u).protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(u).hostname)) {
      console.warn(`[beldex] WARNING: ${u} is plaintext http. Extension pages are secure contexts, `
        + 'so the browser will block this fetch as mixed content. Use https for anything the wallet actually calls.')
    }
  }

  const outDir = (firefox ? 'firefox' : 'dist') + (testnet ? '-testnet' : '')
  const manifestSrc = firefox ? 'public/manifest.firefox.json' : 'public/manifest.chrome.json'

  console.log(`[beldex] building ${network} (${firefox ? 'firefox' : 'chrome'}) -> ${outDir}/  lws=${net.lws}`)

  const buildManifest = (content) => {
    const m = JSON.parse(content.toString())
    m.host_permissions = hosts
    if (testnet) {
      m.name = `${m.name} (Testnet)`
      m.description = `TESTNET BUILD — coins have no value. ${m.description}`
      if (m.browser_specific_settings?.gecko?.id) {
        // Distinct id so Firefox treats it as a separate add-on (separate
        // storage), letting a testnet and mainnet build coexist.
        m.browser_specific_settings.gecko.id = 'beldex-wallet-testnet@beldex.io'
      }
    }
    if (m.description.length > 132) {
      throw new Error(`Manifest description is ${m.description.length} characters; maximum is 132.`)
    }
    return JSON.stringify(m, null, 2) + '\n'
  }

  return {
  entry: {
    panel: './src/popup/index.tsx',
    background: './src/background/index.ts',
    // Dapp bridge (bdx-web3js protocol): approval window UI, content-script
    // relay, and the main-world provider injected into pages.
    approval: './src/approval/index.tsx',
    content: './src/content/index.ts',
    inpage: './src/inpage/index.ts'
  },
  output: {
    path: path.resolve(__dirname, outDir),
    filename: '[name].js',
    clean: true
  },
  devtool: false, // eval-based devtools violate the MV3 CSP
  module: {
    rules: [{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ }]
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    fallback: {
      // The @bdxi packages are written for node/web; polyfill what they touch.
      path: require.resolve('path-browserify'),
      buffer: require.resolve('buffer'),
      stream: require.resolve('stream-browserify'),
      util: require.resolve('util'),
      fs: false,
      crypto: false
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      Buffer: ['buffer', 'Buffer'],
      process: 'process/browser'
    }),
    // EVERY network's resolved config, substituted as an object literal and
    // read by src/lib/config.ts as __BDX_NETS__, plus which one a fresh wallet
    // starts on. All networks' endpoints are in the bundle by design — the
    // chain is a runtime, per-wallet choice now, and the manifest grants the
    // union of their hosts (see the host_permissions derivation above).
    new webpack.DefinePlugin({
      __BDX_NETS__: JSON.stringify(nets),
      __BDX_DEFAULT_NET__: JSON.stringify(network)
    }),
    new CopyPlugin({
      patterns: [
        { from: manifestSrc, to: 'manifest.json', transform: buildManifest },
        { from: 'public/panel.html', to: 'panel.html' },
        { from: 'public/approval.html', to: 'approval.html' },
        { from: 'public/icons', to: 'icons' },
        // Fonts bundled locally — MV3 forbids loading remote fonts.
        { from: 'node_modules/@fontsource/michroma/files/michroma-latin-400-normal.woff2', to: 'fonts/michroma-400.woff2' },
        { from: 'node_modules/@fontsource/space-mono/files/space-mono-latin-400-normal.woff2', to: 'fonts/space-mono-400.woff2' },
        { from: 'node_modules/@fontsource/space-mono/files/space-mono-latin-700-normal.woff2', to: 'fonts/space-mono-700.woff2' },
        {
          // The Emscripten glue resolves the wasm at "/assets/BeldexLibAppCpp_WASM.wasm",
          // which inside the extension becomes chrome-extension://<id>/assets/... — so
          // copying it here is what makes the bridge load.
          from: 'node_modules/@bdxi/beldex-app-bridge/BeldexLibAppCpp_WASM.wasm',
          to: 'assets/BeldexLibAppCpp_WASM.wasm'
        }
      ]
    })
  ],
  performance: { hints: false }
  }
}
