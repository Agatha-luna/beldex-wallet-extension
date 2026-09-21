// Writes (or verifies) the signed-off build manifest that binds the packaged
// binaries to the exact source and configuration they were built from
// (release-integrity audit finding). Run by scripts/package.sh — not useful
// standalone except for verification.
//
//   node scripts/write-build-manifest.mjs                  # write release/build-manifest-v<V>.json
//   node scripts/write-build-manifest.mjs --check <file>   # recompute content hashes in CWD's
//                                                          # dist/ + firefox/ and compare
//
// The manifest records: commit + tree hash, package-lock sha256, node/npm
// versions, the resolved (non-secret) network configuration, the derived
// host_permissions actually present in each built manifest.json, and per-file
// sha256 hashes of both build outputs plus a deterministic contentHash per
// target. The zips' own hashes vary with zip metadata; contentHash is the
// reproducibility anchor.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// Write mode operates on the repo this script lives in. Check mode operates on
// the CURRENT DIRECTORY — it is invoked from inside the freshly rebuilt tree,
// and hashing the script's own repo instead would make verification circular.
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = process.argv[2] === '--check' ? process.cwd() : scriptRoot

// Shell-independent git: no shell, no cwd reliance — address the repo with -C
// and pass args as an array so nothing (e.g. `HEAD^{tree}`) is shell-expanded.
const git = (...args) => execFileSync('git', ['-C', scriptRoot, ...args], { encoding: 'utf8' }).trim()
const npmVersion = () => {
  try { return execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() } catch { return 'unknown' }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// Same derivation as webpack.config.js hostPattern() — kept trivially small so
// the cross-check below is meaningful rather than circular.
const hostPattern = (url) => {
  const u = new URL(url)
  return `${u.protocol}//${u.hostname}/*`
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function hashTarget(outDir) {
  const dir = join(root, outDir)
  const files = {}
  for (const p of walk(dir)) files[relative(dir, p).split('\\').join('/')] = sha256(readFileSync(p))
  const contentHash = sha256(Object.entries(files).map(([f, h]) => `${h}  ${f}\n`).join(''))
  return { files, contentHash }
}

const TARGETS = ['dist', 'firefox']

// ---- --check mode: recompute content hashes and compare to a manifest ------

if (process.argv[2] === '--check') {
  const manifest = JSON.parse(readFileSync(process.argv[3], 'utf8'))
  let ok = true
  for (const t of TARGETS) {
    const got = hashTarget(t).contentHash
    const want = manifest.targets[t].contentHash
    if (got !== want) {
      ok = false
      console.error(`MISMATCH ${t}/: rebuilt ${got} != manifest ${want}`)
      const rebuilt = hashTarget(t).files
      for (const f of new Set([...Object.keys(rebuilt), ...Object.keys(manifest.targets[t].files)])) {
        if (rebuilt[f] !== manifest.targets[t].files[f]) {
          console.error(`  ${f}: rebuilt=${rebuilt[f] ?? 'MISSING'} manifest=${manifest.targets[t].files[f] ?? 'MISSING'}`)
        }
      }
    }
  }
  if (!ok) process.exit(1)
  console.log('build-manifest check OK — rebuild is byte-identical to the packaged outputs')
  process.exit(0)
}

// ---- write mode ------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const networks = JSON.parse(readFileSync(join(root, 'src/lib/networks.json'), 'utf8'))

// Official releases are mainnet with NO overrides (package.sh enforces no .env
// and no BDX_*/MAINNET_*/TESTNET_* ambient environment), so the resolved
// configuration IS networks.json's mainnet block.
const net = networks.mainnet
const expectedUrls = [net.lws, net.daemonRpc, net.bnsLookup, net.explorerTx]
if (net.showFiat) expectedUrls.push(net.priceUrl)
const expectedHosts = [...new Set(expectedUrls.map(hostPattern))]

const targets = {}
for (const t of TARGETS) {
  const built = JSON.parse(readFileSync(join(root, t, 'manifest.json'), 'utf8'))
  // Bind the built manifest to the reviewed configuration: version must match
  // package.json and host_permissions must be exactly the set derived from
  // networks.json — anything else means an unrecorded input reached the build.
  if (built.version !== pkg.version) {
    throw new Error(`${t}/manifest.json version ${built.version} != package.json ${pkg.version}`)
  }
  if (JSON.stringify([...built.host_permissions].sort()) !== JSON.stringify([...expectedHosts].sort())) {
    throw new Error(`${t}/manifest.json host_permissions ${JSON.stringify(built.host_permissions)} `
      + `!= derived from networks.json ${JSON.stringify(expectedHosts)} — unrecorded config input?`)
  }
  if (/testnet/i.test(built.name)) throw new Error(`${t}/manifest.json is a testnet build`)
  targets[t] = hashTarget(t)
}

const out = join(root, 'release', `build-manifest-v${pkg.version}.json`)

const manifest = {
  name: pkg.name,
  version: pkg.version,
  builtAt: new Date().toISOString(),
  commit: git('rev-parse', 'HEAD'),
  tree: git('rev-parse', 'HEAD^{tree}'),
  packageLockSha256: sha256(readFileSync(join(root, 'package-lock.json'))),
  nodeVersion: process.version,
  npmVersion: npmVersion(),
  network: 'mainnet',
  resolvedConfig: net,          // non-secret build-time endpoints, as reviewed
  hostPermissions: expectedHosts,
  targets,
  // This manifest is an attestation only when accompanied by its detached
  // signature. package.sh produces `<file>.asc` when RELEASE_SIGNING_KEY is set
  // and prints a prominent warning otherwise. An unsigned manifest (no .asc)
  // must NOT be trusted as an official release attestation.
  signing: `detached GPG signature expected at ${relative(root, out)}.asc — UNSIGNED if that file is absent`
}

writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`wrote ${relative(root, out)}`)
console.log(`  commit       ${manifest.commit}`)
for (const t of TARGETS) console.log(`  ${t.padEnd(12)} contentHash ${targets[t].contentHash}`)
