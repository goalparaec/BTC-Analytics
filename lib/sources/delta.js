// Delta Exchange India: public market data only (no keys, no trading).
// Field names follow Delta's public API as documented; if a field is missing it becomes null,
// and /api/health shows the raw response so a changed shape is easy to spot.
import { getJson, SourceError, num, toMs } from '../http.js';

export const DELTA_BASE = 'https://api.india.delta.exchange';

/** C-BTC-83200-181026 -> call, strike 83200, expiry 2026-10-18 12:00 UTC. */
export function parseOptionSymbol(sym) {
  const m = /^([CP])-BTC-(\d+)-(\d{2})(\d{2})(\d{2})$/.exec(sym);
  if (!m) return null;
  const [, cp, strike, dd, mm, yy] = m;
  return {
    type: cp === 'C' ? 'call' : 'put',
    strike: Number(strike),
    expiryTs: Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), 12, 0, 0),
  };
}

/** Implied volatility as a fraction. Values above 5 are read as percent (45 -> 0.45). */
export function normIv(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n > 5 ? n / 100 : n;
}

export function normalizeOption(t) {
  const p = parseOptionSymbol(t.symbol);
  if (!p) return null;
  const q = t.quotes ?? {};
  const g = t.greeks ?? {};
  const delta = num(g.delta ?? q.delta);
  return {
    symbol: t.symbol,
    ...p,
    bid: num(q.best_bid),
    ask: num(q.best_ask),
    bidSize: num(q.bid_size),
    askSize: num(q.ask_size),
    mark: num(t.mark_price),
    markIv: normIv(q.mark_iv ?? t.mark_vol),
    delta: delta !== null && Math.abs(delta) <= 1 ? delta : null,
    oi: num(t.oi_contracts ?? t.oi),
    volume: num(t.volume),
    spot: num(t.spot_price),
    ts: toMs(t.timestamp),
  };
}

export async function fetchDeltaChain() {
  const url = `${DELTA_BASE}/v2/tickers?contract_types=call_options,put_options&underlying_asset_symbols=BTC`;
  const { json, latencyMs } = await getJson(url);
  if (!Array.isArray(json?.result)) throw new SourceError('unexpected response shape');
  const result = json.result.filter((t) => t && typeof t.symbol === 'string');
  const options = result.map(normalizeOption).filter(Boolean);
  if (!options.length) throw new SourceError('no BTC options found in the response');
  const stamps = options.map((o) => o.ts).filter(Number.isFinite);
  return {
    data: { options },
    exchangeTs: stamps.length ? Math.max(...stamps) : null,
    latencyMs,
    sample: JSON.stringify(result.slice(0, 1)).slice(0, 1500),
  };
}

export async function fetchDeltaPerp() {
  const { json, latencyMs } = await getJson(`${DELTA_BASE}/v2/tickers/BTCUSD`);
  const r = json?.result;
  if (!r || typeof r !== 'object') throw new SourceError('unexpected response shape');
  const mark = num(r.mark_price);
  const index = num(r.spot_price);
  if (mark === null && index === null) throw new SourceError('no price fields in response');
  return {
    data: {
      mark,
      index,
      fundingRateRaw: num(r.funding_rate),
      oiContracts: num(r.oi_contracts ?? r.oi),
    },
    exchangeTs: toMs(r.timestamp),
    latencyMs,
    sample: JSON.stringify(r).slice(0, 1500),
  };
}

/** One-minute candles for the last 25 hours, oldest first. t is the candle open in ms. */
export async function fetchDeltaCandles(nowMs = Date.now()) {
  const end = Math.floor(nowMs / 1000);
  const start = end - 25 * 3600;
  const url = `${DELTA_BASE}/v2/history/candles?resolution=1m&symbol=BTCUSD&start=${start}&end=${end}`;
  const { json, latencyMs } = await getJson(url, { timeoutMs: 7000 });
  const rows = Array.isArray(json?.result) ? json.result : null;
  if (!rows) throw new SourceError('unexpected response shape');
  const candles = rows
    .map((c) => ({ t: toMs(c.time), o: num(c.open), h: num(c.high), l: num(c.low), c: num(c.close) }))
    .filter((c) => [c.t, c.o, c.h, c.l, c.c].every((x) => x !== null))
    .sort((a, b) => a.t - b.t);
  if (candles.length < 60) throw new SourceError(`only ${candles.length} candles returned`);
  return {
    data: { candles },
    exchangeTs: candles[candles.length - 1].t + 60000,
    latencyMs,
    sample: JSON.stringify(rows.slice(-1)).slice(0, 500),
  };
}
