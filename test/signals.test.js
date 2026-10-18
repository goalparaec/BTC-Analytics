import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, spreadLevel, beLevel, scaleMove, sessionClass } from '../public/signals.js';

const base = () => ({
  time: { now: 1_000_000_000_000 },
  vol: { h24: { changePct: 0.2 } },
  ivRv: { vs24h: 1.0 },
  futures: [{ ok: true, fundingRate: 0.0001 }, { ok: true, fundingRate: 0.0002 }, { ok: false }],
  spot: { venues: [{ devBps: 3 }, { devBps: -4 }, { down: true }] },
  events: [{ name: 'CPI', atUtc: 1_000_000_000_000 + 5 * 3600000 }],
  sources: [{ ok: true }, { ok: true }],
  options: { expiries: [{ hoursToExpiry: 12, expectedMove: { pts: 600 } }] },
});
const get = (arr, id) => arr.find((s) => s.id === id);

test('levels at the thresholds', () => {
  assert.equal(spreadLevel(4.99), 'good'); assert.equal(spreadLevel(5), 'warn'); assert.equal(spreadLevel(15), 'bad'); assert.equal(spreadLevel(null), null);
  assert.equal(beLevel(0.79), 'good'); assert.equal(beLevel(1.2), 'warn'); assert.equal(beLevel(1.21), 'bad');
  assert.equal(sessionClass('New York'), 'ny'); assert.equal(sessionClass('???'), 'late');
  assert.equal(scaleMove(1000, 6), 500); assert.equal(scaleMove(1000, 0), null);
});

test('classify: neutral market', () => {
  const s = classify(base(), null);
  assert.equal(get(s, 'trend').level, 'neutral');
  assert.equal(get(s, 'ivrv').level, 'info');
  assert.equal(get(s, 'funding').level, 'neutral'); // median of 0.01% and 0.02%
  assert.equal(get(s, 'venues').level, 'good');
  assert.equal(get(s, 'event').level, 'warn'); // 5 hours away
  assert.equal(get(s, 'health').level, 'good');
  assert.equal(get(s, 'priced'), undefined); // no history, no signal
});

test('classify: stressed market', () => {
  const b = base();
  b.vol.h24.changePct = -3; b.ivRv.vs24h = 1.5; b.futures = [{ ok: true, fundingRate: 0.0005 }];
  b.spot.venues = [{ devBps: 40 }]; b.sources = [{ ok: true }, { ok: false }];
  const s = classify(b, null);
  assert.equal(get(s, 'trend').level, 'bad'); assert.equal(get(s, 'ivrv').level, 'bad');
  assert.equal(get(s, 'funding').text, 'Longs crowded'); assert.equal(get(s, 'venues').level, 'bad'); assert.equal(get(s, 'health').level, 'bad');
});

test('classify: priced move vs history uses mean abs move scaled by sqrt(time)', () => {
  const h = { ok: true, stats: { n: 300, absMove: { mean: 1200 } } };
  // 12h left -> typical 1200*sqrt(0.5)=848.5 ; expected 600 -> 0.707 -> cheap
  const p = get(classify(base(), h), 'priced');
  assert.equal(p.level, 'good'); assert.equal(p.value, '0.71×');
  const b = base(); b.options.expiries[0].expectedMove.pts = 1100; // 1.30x
  assert.equal(get(classify(b, h), 'priced').level, 'bad');
});
