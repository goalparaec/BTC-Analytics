// Builds the dashboard snapshot. buildSnapshot() is pure: same source results + same clock in,
// same snapshot out. fetchAll() is the only part that touches the network.
import { runSource, ageOf } from './http.js';
import { fetchDeltaChain, fetchDeltaPerp, fetchDeltaCandles } from './sources/delta.js';
import { SPOT_VENUES, fetchSpot } from './sources/spot.js';
import { fetchDeribitOptions, fetchDvol, fetchDeribitPerp } from './sources/deribit.js';
import { fetchBinanceFutures, fetchBybitFutures, fetchOkxFutures } from './sources/futures.js';
import {
  CALC_VERSION, MS_PER_YEAR, median, bpsDiff, pickStrike, maxPain, spreadPct, breakEvenMove,
  expectedMove, probTouch, probFinishAbove, probFinishBelow, thetaPerDay, windowStats,
} from './calc.js';
import { nextDeltaExpiry, usOpenUtc, sessionAt, deribitExpiries, zonedToUtc } from './time.js';
import { EVENTS, EVENTS_VERIFIED_ON } from './events-data.js';

export const SNAPSHOT_VERSION = 1;
export const LADDER_DISTANCES = [500, 1000, 1500, 2000, 2500];
export const CHAIN_HALF_WIDTH = 3000;
export const VENUE_DEVIATION_WARN_BPS = 15;

const SEC = 1000;
const MIN = 60 * SEC;

export async function fetchAll(now = Date.now()) {
  const jobs = [
    ['delta:chain', fetchDeltaChain, 60 * SEC],
    ['delta:perp', fetchDeltaPerp, 60 * SEC],
    ['delta:candles', () => fetchDeltaCandles(now), 3 * MIN],
    ...SPOT_VENUES.map((v) => [`spot:${v.name}`, () => fetchSpot(v), 30 * SEC]),
    ['deribit:options', fetchDeribitOptions, 2 * MIN],
    ['deribit:dvol', () => fetchDvol(now), 2 * 3600 * SEC],
    ['deribit:perp', fetchDeribitPerp, 2 * MIN],
    ['futures:Binance', fetchBinanceFutures, 2 * MIN],
    ['futures:Bybit', fetchBybitFutures, 2 * MIN],
    ['futures:OKX', fetchOkxFutures, 2 * MIN],
  ];
  const out = await Promise.all(jobs.map(([name, fn, stale]) => runSource(name, fn, stale)));
  return Object.fromEntries(out.map((r) => [r.name, r]));
}

function usable(results, name, now) {
  const r = results[name];
  return r && r.ok && ageOf(r, now) <= r.staleAfterMs ? r : null;
}

function slim(o) {
  return o
    ? { bid: o.bid, ask: o.ask, mark: o.mark, markIv: o.markIv, delta: o.delta, oi: o.oi, spreadPct: spreadPct(o.bid, o.ask) }
    : null;
}

function legInfo(o, spot, T, atmIv, exp) {
  const iv = o.markIv ?? atmIv;
  const be = breakEvenMove(o.type, o.strike, o.ask, spot);
  const theta = thetaPerDay(spot, o.strike, iv, T);
  return {
    symbol: o.symbol,
    type: o.type,
    strike: o.strike,
    distance: o.type === 'call' ? o.strike - spot : spot - o.strike,
    ...slim(o),
    breakEvenMove: be,
    breakEvenPct: be === null ? null : (be / spot) * 100,
    beVsExpected: exp && be !== null ? be / exp.pts : null,
    thetaPerHour: theta === null ? null : theta / 24,
    probTouch: probTouch(spot, o.strike, iv, T),
    probBeyondBreakEven:
      o.ask === null
        ? null
        : o.type === 'call'
          ? probFinishAbove(spot, o.strike + o.ask, iv, T)
          : probFinishBelow(spot, o.strike - o.ask, iv, T),
    modelIv: iv,
  };
}

function buildExpiry(expiryTs, opts, spot, now) {
  const hoursToExpiry = (expiryTs - now) / 3600000;
  const T = (expiryTs - now) / MS_PER_YEAR;
  const calls = opts.filter((o) => o.type === 'call');
  const puts = opts.filter((o) => o.type === 'put');
  const base = { expiryTs, hoursToExpiry, calls: calls.length, puts: puts.length };
  if (spot === null) return { ...base, error: 'no reference price' };

  const both = calls.map((c) => c.strike).filter((k) => puts.some((p) => p.strike === k));
  const atmK = both.length ? pickStrike(both, spot) : null;
  const atmCall = calls.find((o) => o.strike === atmK) ?? null;
  const atmPut = puts.find((o) => o.strike === atmK) ?? null;
  const ivs = [atmCall?.markIv, atmPut?.markIv].filter(Number.isFinite);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const exp = atmCall && atmPut ? expectedMove(atmCall.mark, atmPut.mark, spot) : null;
  const sd1 = atmIv ? spot * atmIv * Math.sqrt(T) : null;

  const above = calls.filter((o) => o.strike > spot);
  const below = puts.filter((o) => o.strike < spot);
  const ladder = LADDER_DISTANCES.map((d) => {
    const c = above.length ? above.find((o) => o.strike === pickStrike(above.map((x) => x.strike), spot + d)) : null;
    const p = below.length ? below.find((o) => o.strike === pickStrike(below.map((x) => x.strike), spot - d)) : null;
    return {
      target: d,
      call: c ? legInfo(c, spot, T, atmIv, exp) : null,
      put: p ? legInfo(p, spot, T, atmIv, exp) : null,
    };
  });

  const strikes = [...new Set(opts.map((o) => o.strike))]
    .filter((k) => Math.abs(k - spot) <= CHAIN_HALF_WIDTH)
    .sort((a, b) => a - b);
  const chain = strikes.map((k) => ({
    strike: k,
    call: slim(calls.find((o) => o.strike === k)),
    put: slim(puts.find((o) => o.strike === k)),
  }));

  return {
    ...base,
    atm: atmK === null ? null : { strike: atmK, callMark: atmCall?.mark ?? null, putMark: atmPut?.mark ?? null, iv: atmIv },
    expectedMove: exp,
    oneSigmaPts: sd1,
    maxPain: maxPain(opts),
    ladder,
    chain,
  };
}

function buildDeribit(results, now) {
  const src = usable(results, 'deribit:options', now);
  const out = { options: null, dvol: null };
  if (src) {
    const horizon = now + 3600000;
    const byExp = new Map();
    for (const o of src.data.options) {
      if (o.expiryTs <= horizon) continue;
      if (!byExp.has(o.expiryTs)) byExp.set(o.expiryTs, []);
      byExp.get(o.expiryTs).push(o);
    }
    out.options = [...byExp.keys()].sort((a, b) => a - b).slice(0, 3).map((ts) => {
      const list = byExp.get(ts);
      const und = median(list.map((o) => o.underlying));
      const strikes = [...new Set(list.map((o) => o.strike))];
      const k = und === null ? null : pickStrike(strikes, und);
      const ivs = list.filter((o) => o.strike === k).map((o) => o.markIv).filter(Number.isFinite);
      return { expiryTs: ts, atmStrike: k, atmIv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null };
    });
  }
  const dv = usable(results, 'deribit:dvol', now);
  if (dv) out.dvol = { value: dv.data.value, change24h: dv.data.change24h, pointTs: dv.data.pointTs };
  return out;
}

function buildFutures(results, now) {
  const rows = [];
  const push = (venue, name, pick) => {
    const r = results[name];
    if (!r || !r.ok) {
      rows.push({ venue, ok: false, error: r ? r.error : 'not fetched' });
      return;
    }
    const ageMs = ageOf(r, now);
    const d = pick(r.data);
    rows.push({ venue, ok: true, stale: ageMs > r.staleAfterMs, ageMs, ...d, oiUsd: d.oiBtc !== null && d.mark ? d.oiBtc * d.mark : null });
  };
  push('Delta', 'delta:perp', (d) => ({ mark: d.mark, fundingRate: null, fundingRateRaw: d.fundingRateRaw, oiBtc: null }));
  push('Binance', 'futures:Binance', (d) => ({ mark: d.mark, fundingRate: d.fundingRate, oiBtc: d.oiBtc }));
  push('Bybit', 'futures:Bybit', (d) => ({ mark: d.mark, fundingRate: d.fundingRate, oiBtc: d.oiBtc }));
  push('OKX', 'futures:OKX', (d) => ({ mark: d.mark, fundingRate: d.fundingRate, oiBtc: d.oiBtc }));
  push('Deribit', 'deribit:perp', (d) => ({ mark: d.mark, fundingRate: d.fundingRate, oiBtc: d.oiBtc }));
  return rows;
}

export function buildEvents(now) {
  return EVENTS.map((e) => {
    const [y, m, d] = e.date.split('-').map(Number);
    const [h, mi] = e.time.split(':').map(Number);
    return { ...e, atUtc: zonedToUtc(y, m, d, h, mi, e.tz) };
  })
    .filter((e) => e.atUtc > now - 2 * 3600000)
    .sort((a, b) => a.atUtc - b.atUtc)
    .slice(0, 8)
    .map((e) => ({ id: e.id, name: e.name, atUtc: e.atUtc, impact: e.impact, source: e.source, note: e.note }));
}

export function buildSnapshot(results, now) {
  const warnings = [];

  // Source health
  const sources = Object.values(results).map((r) => {
    const ageMs = r.ok ? ageOf(r, now) : null;
    return { name: r.name, ok: r.ok, stale: r.ok ? ageMs > r.staleAfterMs : null, ageMs, latencyMs: r.latencyMs, error: r.error };
  });

  // Spot venues
  const venueRows = SPOT_VENUES.map((v) => {
    const r = results[`spot:${v.name}`];
    if (!r || !r.ok) return { name: v.name, quote: v.quote, down: true, error: r ? r.error : 'not fetched' };
    const ageMs = ageOf(r, now);
    return { name: v.name, quote: v.quote, price: r.data.price, ageMs, stale: ageMs > r.staleAfterMs, hasExchangeTs: r.data.hasExchangeTs };
  });
  const good = venueRows.filter((v) => v.price !== undefined && !v.stale);
  const medianPrice = good.length >= 3 ? median(good.map((v) => v.price)) : null;
  for (const v of venueRows) v.devBps = medianPrice !== null && !v.stale && v.price !== undefined ? bpsDiff(v.price, medianPrice) : null;
  if (good.length < 3) warnings.push(`Only ${good.length} spot venue(s) usable. At least 3 are needed for a cross-check.`);

  const perp = usable(results, 'delta:perp', now);
  const chainSrc = usable(results, 'delta:chain', now);
  const deltaIndex = perp?.data.index ?? (chainSrc ? median(chainSrc.data.options.map((o) => o.spot).filter(Number.isFinite)) : null);
  const deltaVsMedianBps = deltaIndex !== null && medianPrice !== null ? bpsDiff(deltaIndex, medianPrice) : null;
  if (deltaVsMedianBps !== null && Math.abs(deltaVsMedianBps) > VENUE_DEVIATION_WARN_BPS) {
    warnings.push(`Delta index differs from the venue median by ${deltaVsMedianBps.toFixed(1)} bps.`);
  }
  const reference = deltaIndex !== null ? { price: deltaIndex, source: 'Delta index' } : medianPrice !== null ? { price: medianPrice, source: 'Median of venues' } : null;
  if (!reference) warnings.push('No reference price. Option figures are not shown.');

  // Realised volatility (Delta 1-minute candles)
  const cs = usable(results, 'delta:candles', now);
  const candles = cs ? cs.data.candles : [];
  const vol = {
    h1: cs ? windowStats(candles, 60, now) : null,
    h4: cs ? windowStats(candles, 240, now) : null,
    h24: cs ? windowStats(candles, 1440, now) : null,
  };

  // Options
  let expiries = [];
  if (chainSrc) {
    const byExp = new Map();
    for (const o of chainSrc.data.options) {
      if (o.expiryTs <= now + 15 * MIN) continue;
      if (!byExp.has(o.expiryTs)) byExp.set(o.expiryTs, []);
      byExp.get(o.expiryTs).push(o);
    }
    expiries = [...byExp.keys()].sort((a, b) => a - b).slice(0, 3).map((ts) => buildExpiry(ts, byExp.get(ts), reference ? reference.price : null, now));
  } else {
    warnings.push('Delta option chain is unavailable or stale.');
  }
  const deribit = buildDeribit(results, now);

  const first = expiries[0];
  const ivRv = first && first.atm && first.atm.iv
    ? { expiryTs: first.expiryTs, atmIv: first.atm.iv, vs1h: vol.h1?.rv ? first.atm.iv / vol.h1.rv : null, vs4h: vol.h4?.rv ? first.atm.iv / vol.h4.rv : null, vs24h: vol.h24?.rv ? first.atm.iv / vol.h24.rv : null }
    : null;

  // Time and events
  const events = buildEvents(now);
  const nextDelta = nextDeltaExpiry(now);
  const upcomingHigh = events.find((e) => e.impact === 'high' && e.atUtc - now < 24 * 3600000 && e.atUtc > now);
  if (upcomingHigh) warnings.push(`High-impact event within 24 h: ${upcomingHigh.name}.`);
  if (nextDelta - now < 2 * 3600000) warnings.push('Delta daily expiry is less than 2 hours away.');

  return {
    version: SNAPSHOT_VERSION,
    calcVersion: CALC_VERSION,
    generatedAt: now,
    warnings,
    sources,
    time: {
      now,
      session: sessionAt(now),
      deltaExpiry: nextDelta,
      usOpenUtc: usOpenUtc(now),
      deribitExpiries: deribitExpiries(now),
    },
    spot: { reference, medianPrice, deltaIndex, deltaVsMedianBps, venues: venueRows },
    vol,
    ivRv,
    options: { expiries, deribit },
    futures: buildFutures(results, now),
    events,
    eventsVerifiedOn: EVENTS_VERIFIED_ON,
  };
}
