// Shared JSON fetch with an application deadline and a response-size budget
// (external audit). The browser's own connection timeout is too slow and
// implementation-dependent to protect a 10s poll or a 5-min authorization
// state machine, and an unbounded body lets a slow-drip backend accumulate
// memory. Every backend call (LWS, BNS, price) goes through here.
//
// Errors are deliberately terse ("request timed out", "response too large",
// "HTTP 500") so nothing about the backend leaks when a caller surfaces the
// message; callers that reach a dapp sanitize further at the router.

export class HttpError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'too-large' | 'status' | 'network' = 'network') {
    super(message)
    this.name = 'HttpError'
  }
}

export interface FetchJsonOptions {
  /** Abort (and reject with a timeout HttpError) after this many ms. */
  timeoutMs: number
  /** Reject if the response body exceeds this many bytes. */
  maxBytes: number
}

/** Read the body with a hard byte ceiling, aborting the stream the moment it is
 *  exceeded so an unbounded/slow-drip response can't accumulate. Falls back to
 *  a buffered read where streaming isn't available. */
async function readBounded(res: Response, maxBytes: number, onExceed: () => void): Promise<string> {
  // Trust a declared Content-Length when present — reject before reading a byte.
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    onExceed()
    throw new HttpError('response too large', 'too-large')
  }
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body
  if (!body || typeof body.getReader !== 'function') {
    const text = await res.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new HttpError('response too large', 'too-large')
    }
    return text
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > maxBytes) {
        onExceed()
        try { await reader.cancel() } catch { /* already closing */ }
        throw new HttpError('response too large', 'too-large')
      }
      chunks.push(value)
    }
  }
  return new TextDecoder().decode(concat(chunks, total))
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** fetch + JSON parse, bounded by an abort deadline and a response-size budget. */
export async function fetchJson<T = unknown>(
  url: string, init: RequestInit, opts: FetchJsonOptions
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    if (!res.ok) throw new HttpError(`HTTP ${res.status}`, 'status')
    const text = await readBounded(res, opts.maxBytes, () => controller.abort())
    try {
      return JSON.parse(text) as T
    } catch {
      throw new HttpError('invalid JSON response', 'network')
    }
  } catch (e) {
    if (timedOut || (e as { name?: string })?.name === 'AbortError') {
      throw new HttpError('request timed out', 'timeout')
    }
    if (e instanceof HttpError) throw e
    throw new HttpError('network error', 'network')
  } finally {
    clearTimeout(timer)
  }
}

// Per-class deadlines/budgets. Reads are quick; a raw-tx SUBMIT is given a long
// deadline on purpose — aborting a broadcast early is what manufactures the
// unknown-outcome ambiguity (see the send operation state machine). A busy
// address's tx list can be large, hence the generous LWS read budget.
export const HTTP = {
  LWS_READ: { timeoutMs: 20_000, maxBytes: 24 * 1024 * 1024 },
  LWS_SUBMIT: { timeoutMs: 90_000, maxBytes: 1 * 1024 * 1024 },
  BNS: { timeoutMs: 12_000, maxBytes: 256 * 1024 },
  PRICE: { timeoutMs: 8_000, maxBytes: 256 * 1024 }
} as const
