// Small fetch helpers. Every source goes through runSource() so one failing exchange
// never breaks the page: it is reported as "down" with the reason.

export class SourceError extends Error {
  constructor(message, { status = null, body = '' } = {}) {
    super(message);
    this.name = 'SourceError';
    this.status = status;
    this.body = body;
  }
}

/** Number or null. Never NaN, never a guess. */
export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Timestamp in seconds, milliseconds or microseconds -> milliseconds (or null). */
export function toMs(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  if (n > 1e15) return Math.round(n / 1000); // microseconds
  if (n > 1e11) return Math.round(n); // milliseconds
  return Math.round(n * 1000); // seconds
}

export async function getJson(url, { timeoutMs = 6000, headers = {} } = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'btc-options-desk/0.1', ...headers },
    });
    const text = await res.text();
    if (!res.ok) throw new SourceError(`HTTP ${res.status}`, { status: res.status, body: text.slice(0, 300) });
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError('response is not valid JSON', { body: text.slice(0, 300) });
    }
    return { json, latencyMs: Date.now() - started };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new SourceError(`timeout after ${timeoutMs} ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one source and returns a uniform envelope.
 * fn() must return { data, exchangeTs?, latencyMs?, sample? }.
 */
export async function runSource(name, fn, staleAfterMs) {
  const started = Date.now();
  try {
    const out = await fn();
    return {
      name,
      ok: true,
      fetchedAt: Date.now(),
      exchangeTs: out.exchangeTs ?? null,
      latencyMs: out.latencyMs ?? Date.now() - started,
      staleAfterMs,
      data: out.data,
      sample: out.sample ?? null,
      error: null,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      fetchedAt: Date.now(),
      exchangeTs: null,
      latencyMs: Date.now() - started,
      staleAfterMs,
      data: null,
      sample: e && e.body ? String(e.body) : null,
      error: String((e && e.message) || e).slice(0, 200),
    };
  }
}

/** Age in ms of a source result, measured from the exchange timestamp when it has one. */
export function ageOf(src, now) {
  const t = src.exchangeTs ?? src.fetchedAt;
  return Math.max(0, now - t);
}
