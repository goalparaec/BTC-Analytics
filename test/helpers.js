// Synthetic exchange responses for tests. These are NOT real market data and are never used by the app.
import { normCdf } from '../lib/calc.js';

export const NOW = Date.UTC(2026, 9, 18, 17, 0, 0); // Sun 18 Oct 2026, 22:30 IST
export const SPOT = 81000;

export function bs(type, S, K, iv, T) {
  const s = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * s * s) / s;
  const d2 = d1 - s;
  return type === 'call' ? S * normCdf(d1) - K * normCdf(d2) : K * normCdf(-d2) - S * normCdf(-d1);
}

function lcg(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

const ddmmyy = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}${p(d.getUTCMonth() + 1)}${String(d.getUTCFullYear()).slice(2)}`;
};

export const DELTA_EXPIRIES = [Date.UTC(2026, 9, 19, 12), Date.UTC(2026, 9, 20, 12), Date.UTC(2026, 9, 23, 12)];

export function deltaTickers(now = NOW, spot = SPOT, iv = 0.45) {
  const out = [];
  for (const exp of DELTA_EXPIRIES) {
    const T = (exp - now) / (365 * 24 * 3600 * 1000);
    for (let k = 73000; k <= 89000; k += Math.abs(k - spot) <= 2000 ? 200 : 400) {
      for (const type of ['call', 'put']) {
        const mark = bs(type, spot, k, iv, T);
        out.push({
          symbol: `${type === 'call' ? 'C' : 'P'}-BTC-${k}-${ddmmyy(exp)}`,
          mark_price: mark.toFixed(2),
          spot_price: String(spot),
          quotes: {
            best_bid: (mark * 0.97).toFixed(2),
            best_ask: (mark * 1.03).toFixed(2),
            bid_size: '100',
            ask_size: '100',
            mark_iv: String(iv),
          },
          greeks: { delta: String(type === 'call' ? 0.5 : -0.5) },
          oi: String(1000 + ((k / 200) % 7) * 500),
          volume: '10',
          timestamp: (now - 2000) * 1000,
        });
      }
    }
  }
  return out;
}

export function candles(now = NOW, spot = SPOT, n = 1500) {
  const rnd = lcg(42);
  const out = [];
  let p = spot;
  for (let i = n; i >= 1; i--) {
    const t = Math.floor((now - i * 60000) / 60000) * 60;
    const o = p;
    p = p * (1 + (rnd() - 0.5) * 0.0012);
    out.push({ time: t, open: o, high: Math.max(o, p) * 1.0003, low: Math.min(o, p) * 0.9997, close: p, volume: 10 });
  }
  return out;
}

const deribitName = (ts, k, cp) => {
  const d = new Date(ts);
  const m = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][d.getUTCMonth()];
  return `BTC-${d.getUTCDate()}${m}${String(d.getUTCFullYear()).slice(2)}-${k}-${cp}`;
};

export function makeRoutes({ now = NOW, spot = SPOT, overrides = {} } = {}) {
  const exps = [Date.UTC(2026, 9, 19, 8), Date.UTC(2026, 9, 20, 8), Date.UTC(2026, 9, 23, 8)];
  const book = [];
  for (const e of exps) for (const k of [80000, 81000, 82000]) for (const cp of ['C', 'P']) book.push({ instrument_name: deribitName(e, k, cp), mark_iv: 44.0, open_interest: 100, volume: 5, underlying_price: spot, creation_timestamp: now - 1000 });
  const routes = [
    ['api.india.delta.exchange/v2/tickers/BTCUSD', () => ({ result: { mark_price: String(spot + 5), spot_price: String(spot), funding_rate: '0.01', oi: '5000', timestamp: (now - 1000) * 1000 } })],
    ['api.india.delta.exchange/v2/tickers?', () => ({ success: true, result: deltaTickers(now, spot) })],
    ['api.india.delta.exchange/v2/history/candles', () => ({ result: candles(now, spot) })],
    ['api.exchange.coinbase.com', () => ({ price: String(spot + 20), time: new Date(now - 500).toISOString() })],
    ['api.kraken.com', () => ({ result: { XXBTZUSD: { c: [String(spot - 15), '0.1'] } } })],
    ['bitstamp.net', () => ({ last: String(spot + 10), timestamp: String(Math.floor((now - 800) / 1000)) })],
    ['https://api.binance.com', () => ({ price: String(spot + 30) })],
    ['okx.com/api/v5/market/ticker', () => ({ data: [{ last: String(spot - 10), ts: String(now - 300) }] })],
    ['deribit.com/api/v2/public/get_book_summary_by_currency', () => ({ result: book })],
    ['deribit.com/api/v2/public/get_volatility_index_data', () => ({ result: { data: Array.from({ length: 72 }, (_, i) => [now - (72 - i) * 3600000, 40, 41, 39, 40 + i * 0.01]) } })],
    ['deribit.com/api/v2/public/ticker', () => ({ result: { mark_price: spot + 8, index_price: spot, funding_8h: 0.00005, open_interest: 400000000, timestamp: now - 400 } })],
    ['fapi.binance.com/fapi/v1/premiumIndex', () => ({ markPrice: String(spot + 12), indexPrice: String(spot), lastFundingRate: '0.00010000', nextFundingTime: now + 3600000, time: now - 500 })],
    ['fapi.binance.com/fapi/v1/openInterest', () => ({ openInterest: '90000.5' })],
    ['api.bybit.com', () => ({ time: now - 400, result: { list: [{ markPrice: String(spot + 9), indexPrice: String(spot), fundingRate: '0.00008', nextFundingTime: String(now + 3600000), openInterest: '60000' }] } })],
    ['okx.com/api/v5/public/funding-rate', () => ({ data: [{ fundingRate: '0.00006', nextFundingTime: String(now + 3600000) }] })],
    ['okx.com/api/v5/public/open-interest', () => ({ data: [{ oiCcy: '40000', ts: String(now - 300) }] })],
    ['okx.com/api/v5/public/mark-price', () => ({ data: [{ markPx: String(spot + 7) }] })],
  ];
  return routes.map(([frag, fn]) => [frag, overrides[frag] ?? fn]);
}

/** Replaces global fetch. A route override may return a function that throws or an HTTP status object. */
export function installFetchMock(opts = {}) {
  const routes = makeRoutes(opts);
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const hit = routes.find(([frag]) => u.includes(frag));
    if (!hit) return { ok: false, status: 404, text: async () => 'no route in test' };
    const body = hit[1](u);
    if (body && body.__status) return { ok: false, status: body.__status, text: async () => body.__text ?? '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return () => {
    globalThis.fetch = original;
  };
}
