// Coverage for the shared bounded fetch wrapper (src/lib/http.ts) — external
// audit: remote calls must have an application deadline and a response-size
// budget so a slow-drip / hanging / oversized backend can't accumulate.
//
// The module is dependency-free (uses only fetch/AbortController/streams), so
// we transpile it in-process and drive it with a stub global fetch.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../src/lib/http.ts'), 'utf8')
const ts = await import('typescript').then(m => m.default ?? m)
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 }
}).outputText
const { fetchJson, HttpError } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

// Minimal Response-ish stub. `bodyText` is delivered as a single stream chunk;
// `contentLength` (optional) sets the header; `delayMs` defers resolution to
// exercise the abort deadline.
function stubResponse({ ok = true, status = 200, bodyText = '{}', contentLength } = {}) {
  const bytes = new TextEncoder().encode(bodyText)
  return {
    ok, status,
    headers: { get: h => (h.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: {
      getReader() {
        let sent = false
        return {
          read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
          cancel: async () => {}
        }
      }
    },
    text: async () => bodyText
  }
}

function withFetch(impl, fn) {
  const prev = globalThis.fetch
  globalThis.fetch = impl
  return (async () => { try { return await fn() } finally { globalThis.fetch = prev } })()
}

test('returns parsed JSON on a normal response', async () => {
  await withFetch(async () => stubResponse({ bodyText: '{"a":1}' }), async () => {
    const r = await fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 })
    assert.deepEqual(r, { a: 1 })
  })
})

test('maps a non-2xx status to an HttpError(status)', async () => {
  await withFetch(async () => stubResponse({ ok: false, status: 503 }), async () => {
    await assert.rejects(
      fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 }),
      e => e instanceof HttpError && e.kind === 'status' && /503/.test(e.message)
    )
  })
})

test('aborts and rejects with a timeout when the backend hangs', async () => {
  await withFetch((_url, init) => new Promise((_res, rej) => {
    // Never resolves on its own; reject when the deadline aborts the signal.
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
    })
  }), async () => {
    const t0 = Date.now()
    await assert.rejects(
      fetchJson('https://x', {}, { timeoutMs: 60, maxBytes: 1000 }),
      e => e instanceof HttpError && e.kind === 'timeout'
    )
    assert.ok(Date.now() - t0 < 2000, 'must reject promptly at the deadline, not hang')
  })
})

test('rejects an over-budget body (declared Content-Length)', async () => {
  await withFetch(async () => stubResponse({ contentLength: 5000, bodyText: 'x'.repeat(5000) }), async () => {
    await assert.rejects(
      fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 }),
      e => e instanceof HttpError && e.kind === 'too-large'
    )
  })
})

test('rejects an over-budget body when Content-Length is absent (streamed count)', async () => {
  await withFetch(async () => stubResponse({ bodyText: 'y'.repeat(4000) }), async () => {
    await assert.rejects(
      fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 }),
      e => e instanceof HttpError && e.kind === 'too-large'
    )
  })
})

test('accepts a body exactly at the budget', async () => {
  await withFetch(async () => stubResponse({ bodyText: JSON.stringify({ s: 'z'.repeat(100) }) }), async () => {
    const r = await fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 })
    assert.equal(r.s.length, 100)
  })
})

test('maps invalid JSON to an HttpError, not a raw SyntaxError', async () => {
  await withFetch(async () => stubResponse({ bodyText: 'not json' }), async () => {
    await assert.rejects(
      fetchJson('https://x', {}, { timeoutMs: 1000, maxBytes: 1000 }),
      e => e instanceof HttpError
    )
  })
})
