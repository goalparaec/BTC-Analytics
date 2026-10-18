// Deribit public data: the largest BTC options venue, used as the reference for implied volatility.
import { getJson, SourceError, num, toMs } from '../http.js';

const BASE = 'https://www.deribit.com/api/v2/public';
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** BTC-19OCT26-80000-C -> expiry 2026-10-19 08:00 UTC. */
export function parseDeribitInstrument(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(name);
  if (!m || !(m[2] in MONTHS)) return null;
  return {
    expiryTs: Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8, 0, 0),
    strike: Number(m[4]),
    type: m[5] === 'C' ? 'call' : 'put',
  };
}

export async function fetchDeribitOptions() {
  const { json, latencyMs } = await getJson(`${BASE}/get_book_summary_by_currency?currency=BTC&kind=option`, { timeoutMs: 7000 });
  const rows = json?.result;
  if (!Array.isArray(rows)) throw new SourceError('unexpected response shape');
  const options = [];
  for (const r of rows) {
    const p = parseDeribitInstrument(String(r.instrument_name));
    if (!p) continue;
    const iv = num(r.mark_iv);
    options.push({
      ...p,
      markIv: iv !== null && iv > 0 ? iv / 100 : null, // Deribit reports percent
      oiBtc: num(r.open_interest),
      volumeBtc: num(r.volume),
      underlying: num(r.underlying_price),
    });
  }
  if (!options.length) throw new SourceError('no options parsed');
  const stamps = rows.map((r) => num(r.creation_timestamp)).filter(Number.isFinite);
  return {
    data: { options },
    exchangeTs: stamps.length ? Math.max(...stamps) : null,
    latencyMs,
    sample: JSON.stringify(rows.slice(0, 1)).slice(0, 800),
  };
}

/** DVOL: Deribit's 30-day implied volatility index for BTC. Hourly points for the last 72 hours. */
export async function fetchDvol(nowMs = Date.now()) {
  const url = `${BASE}/get_volatility_index_data?currency=BTC&resolution=3600&start_timestamp=${nowMs - 72 * 3600000}&end_timestamp=${nowMs}`;
  const { json, latencyMs } = await getJson(url);
  const rows = json?.result?.data;
  if (!Array.isArray(rows) || rows.length < 2) throw new SourceError('unexpected response shape');
  const pts = rows.map((r) => ({ t: toMs(r[0]), close: num(r[4]) })).filter((p) => p.t !== null && p.close !== null);
  pts.sort((a, b) => a.t - b.t);
  const last = pts[pts.length - 1];
  const dayAgo = [...pts].reverse().find((p) => p.t <= last.t - 24 * 3600000) ?? null;
  return {
    data: {
      value: last.close,
      change24h: dayAgo ? last.close - dayAgo.close : null,
      pointTs: last.t,
    },
    exchangeTs: last.t + 3600000,
    latencyMs,
    sample: JSON.stringify(rows.slice(-1)),
  };
}

export async function fetchDeribitPerp() {
  const { json, latencyMs } = await getJson(`${BASE}/ticker?instrument_name=BTC-PERPETUAL`);
  const r = json?.result;
  if (!r) throw new SourceError('unexpected response shape');
  const mark = num(r.mark_price);
  const oiUsd = num(r.open_interest); // inverse contract: open interest is in USD
  return {
    data: {
      mark,
      index: num(r.index_price),
      fundingRate: num(r.funding_8h), // fraction per 8 hours
      oiBtc: mark && oiUsd !== null ? oiUsd / mark : null,
    },
    exchangeTs: toMs(r.timestamp),
    latencyMs,
    sample: JSON.stringify(r).slice(0, 800),
  };
}
