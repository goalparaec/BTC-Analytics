import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAll, buildSnapshot } from '../lib/snapshot.js';
import { parseOptionSymbol, normIv } from '../lib/sources/delta.js';
import { parseDeribitInstrument } from '../lib/sources/deribit.js';
import { installFetchMock, NOW, SPOT } from './helpers.js';

test('symbol parsers', () => {
  const p = parseOptionSymbol('C-BTC-104200-191025');
  assert.equal(p.type, 'call');
  assert.equal(p.strike, 104200);
  assert.equal(new Date(p.expiryTs).toISOString(), '2025-10-19T12:00:00.000Z');
  assert.equal(parseOptionSymbol('BTCUSD'), null);
  const d = parseDeribitInstrument('BTC-9OCT26-80000-P');
  assert.equal(d.type, 'put');
  assert.equal(new Date(d.expiryTs).toISOString(), '2026-10-09T08:00:00.000Z');
  assert.equal(normIv('45'), 0.45);
  assert.equal(normIv('0.45'), 0.45);
  assert.equal(normIv(''), null);
});

test('full snapshot from healthy sources', async () => {
  const restore = installFetchMock();
  try {
    const results = await fetchAll(NOW);
    const snap = buildSnapshot(results, NOW);
    assert.equal(snap.sources.filter((s) => !s.ok).length, 0, JSON.stringify(snap.sources.filter((s) => !s.ok)));
    assert.equal(snap.spot.reference.price, SPOT);
    assert.equal(snap.spot.reference.source, 'Delta index');
    assert.equal(snap.options.expiries.length, 3);
    const e = snap.options.expiries[0];
    assert.equal(new Date(e.expiryTs).toISOString(), '2026-10-19T12:00:00.000Z');
    assert.equal(e.atm.strike, 81000);
    assert.ok(Math.abs(e.expectedMove.pts / (SPOT * 0.45 * Math.sqrt(e.hoursToExpiry / 8760)) - 0.7979) < 0.03);
    // ladder: the 1,500 row picks the nearest real strike
    const row = e.ladder.find((r) => r.target === 1500);
    assert.ok(Math.abs(row.call.strike - (SPOT + 1500)) <= 200);
    assert.ok(Math.abs(row.put.strike - (SPOT - 1500)) <= 200);
    assert.equal(row.call.breakEvenMove, row.call.strike + row.call.ask - SPOT);
    assert.ok(row.call.thetaPerHour < 0);
    assert.ok(row.call.probTouch > 0 && row.call.probTouch < 1);
    assert.ok(snap.vol.h1.rv > 0 && snap.vol.h24.rv > 0);
    assert.ok(snap.ivRv.vs24h > 0);
    assert.equal(snap.options.deribit.options.length, 3);
    assert.ok(snap.options.deribit.dvol.value > 40);
    assert.equal(snap.futures.filter((f) => f.ok).length, 5);
    assert.ok(snap.events.length > 0 && snap.events[0].atUtc > NOW - 7200000);
    assert.equal(snap.time.session.name, 'New York');
    for (const v of snap.spot.venues) assert.ok(Math.abs(v.devBps) < 15, `${v.name} ${v.devBps}`);
    assert.equal(snap.warnings.some((w) => w.startsWith('High-impact')), false);
  } finally {
    restore();
  }
});

test('same inputs give an identical snapshot (deterministic)', async () => {
  const restore = installFetchMock();
  try {
    const results = await fetchAll(NOW);
    const a = JSON.stringify(buildSnapshot(results, NOW));
    const b = JSON.stringify(buildSnapshot(structuredClone(results), NOW));
    assert.equal(a, b);
  } finally {
    restore();
  }
});

test('one exchange failing does not break the page and is reported', async () => {
  const restore = installFetchMock({ overrides: { 'api.bybit.com': () => ({ __status: 403, __text: 'blocked' }), 'https://api.binance.com': () => ({ __status: 451, __text: 'restricted location' }) } });
  try {
    const snap = buildSnapshot(await fetchAll(NOW), NOW);
    const bybit = snap.futures.find((f) => f.venue === 'Bybit');
    assert.equal(bybit.ok, false);
    assert.match(bybit.error, /403/);
    const binance = snap.spot.venues.find((v) => v.name === 'Binance');
    assert.equal(binance.down, true);
    assert.match(binance.error, /451/);
    assert.ok(snap.options.expiries.length === 3);
    assert.equal(snap.spot.medianPrice !== null, true); // 4 venues still agree
  } finally {
    restore();
  }
});

test('a venue that disagrees is flagged, and fewer than 3 venues means no cross-check', async () => {
  let restore = installFetchMock({ overrides: { 'okx.com/api/v5/market/ticker': () => ({ data: [{ last: String(SPOT * 1.01), ts: String(NOW - 100) }] }) } });
  try {
    const snap = buildSnapshot(await fetchAll(NOW), NOW);
    const okx = snap.spot.venues.find((v) => v.name === 'OKX');
    assert.ok(okx.devBps > 50, `okx dev ${okx.devBps}`);
  } finally {
    restore();
  }
  const down = () => ({ __status: 500 });
  restore = installFetchMock({ overrides: { 'api.kraken.com': down, 'bitstamp.net': down, 'https://api.binance.com': down } });
  try {
    const snap = buildSnapshot(await fetchAll(NOW), NOW);
    assert.equal(snap.spot.medianPrice, null);
    assert.ok(snap.warnings.some((w) => w.includes('Only 2 spot venue')));
  } finally {
    restore();
  }
});

test('no reference price means no option figures, never a guess', async () => {
  const bad = () => ({ __status: 500 });
  const restore = installFetchMock({ overrides: { 'api.india.delta.exchange/v2/tickers/BTCUSD': bad, 'api.kraken.com': bad, 'bitstamp.net': bad, 'https://api.binance.com': bad, 'okx.com/api/v5/market/ticker': bad } });
  try {
    const results = await fetchAll(NOW);
    // chain tickers carry spot_price, so remove that too by making the chain unusable
    results['delta:chain'].data.options.forEach((o) => { o.spot = null; });
    const snap = buildSnapshot(results, NOW);
    assert.equal(snap.spot.reference, null);
    assert.equal(snap.options.expiries[0].error, 'no reference price');
    assert.equal(snap.options.expiries[0].ladder, undefined);
  } finally {
    restore();
  }
});

test('stale data is excluded', async () => {
  const restore = installFetchMock();
  try {
    const results = await fetchAll(NOW);
    const snap = buildSnapshot(results, NOW + 10 * 60000); // 10 minutes later, nothing refreshed
    assert.ok(snap.sources.filter((s) => s.stale).length > 5);
    assert.equal(snap.options.expiries.length, 0);
    assert.ok(snap.warnings.some((w) => w.includes('unavailable or stale')));
  } finally {
    restore();
  }
});
