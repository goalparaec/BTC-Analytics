import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, percentRank, summarizeWindows, windowStats } from '../lib/calc.js';
import { supabaseConfig } from '../lib/sources/supabase.js';
import { buildHistory } from '../api/history.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('percentile and percentRank', () => {
  close(percentile([1, 2, 3, 4, 5], 50), 3);
  close(percentile([1, 2, 3, 4], 50), 2.5);
  close(percentile([10, 20], 0), 10);
  close(percentile([10, 20], 100), 20);
  close(percentile([10, 20], 25), 12.5);
  assert.equal(percentile([], 50), null);
  close(percentRank([1, 2, 3, 4], 3), 75);
  close(percentRank([1, 2, 3, 4], 0), 0);
  assert.equal(percentRank([], 3), null);
  assert.equal(percentRank([1], NaN), null);
});

test('summarizeWindows: known numbers and weekday split', () => {
  const rows = [
    { windowEnd: 1, rangePts: 1000, absMovePts: 400, isoDow: 1 },
    { windowEnd: 2, rangePts: 2000, absMovePts: 800, isoDow: 1 },
    { windowEnd: 3, rangePts: 3000, absMovePts: 1200, isoDow: 2 },
    { windowEnd: 4, rangePts: NaN, absMovePts: 5, isoDow: 3 },
  ];
  const s = summarizeWindows(rows);
  assert.equal(s.n, 3); // the NaN row is dropped, not guessed
  close(s.range.mean, 2000);
  close(s.range.median, 2000);
  close(s.absMove.mean, 800);
  close(s.absMove.p90, 1120);
  assert.deepEqual(s.byWeekday.map((d) => [d.isoDow, d.n, d.meanRange]), [[1, 2, 1500], [2, 1, 3000]]);
  assert.equal(summarizeWindows([]), null);
});

test('windowStats reports the change over the window', () => {
  const cs = Array.from({ length: 61 }, (_, i) => ({ t: i * 60000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
  const w = windowStats(cs, 60, 60 * 60000);
  close(w.changePct, 60.5, 1e-9); // bars at t=0..60 min are inside the window: open 100 -> close 160.5
});

test('supabase config: absent, present, bad url', () => {
  assert.equal(supabaseConfig({}), null);
  assert.deepEqual(supabaseConfig({ SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_ANON_KEY: 'k' }), { url: 'https://x.supabase.co', key: 'k' });
  assert.throws(() => supabaseConfig({ SUPABASE_URL: 'http://x', SUPABASE_ANON_KEY: 'k' }));
});

test('history endpoint: not configured, healthy, and failing', async () => {
  assert.deepEqual(await buildHistory({}), { configured: false });
  const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_test' };
  const original = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: init.headers });
      const u = String(url);
      const body = u.includes('btc_daily_530')
        ? [{ window_end: '2026-10-18T12:00:00+00:00', open: '100', close: '90', range_pts: '30', range_pct: '0.3', abs_move_pts: '10', end_isodow: 7 },
           { window_end: '2026-10-17T12:00:00+00:00', open: '90', close: '100', range_pts: '50', range_pct: '0.5', abs_move_pts: '10', end_isodow: 6 }]
        : u.includes('btc_hourly_activity') ? [{ ist_hour: 19, is_weekend: false, candles: 250, avg_range_pct: 0.5, avg_range_pts: 600 }]
        : [{ spot_from: '2025-10-16T18:00:00+00:00', spot_to: '2026-10-18T17:00:00+00:00', spot_rows: 8808, contracts: 20440, option_candles: 520441, first_expiry: '2025-10-19T12:00:00+00:00', last_expiry: '2026-10-18T12:00:00+00:00' }];
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const out = await buildHistory(env);
    assert.equal(out.ok, true);
    assert.equal(out.stats.n, 2);
    assert.equal(out.coverage.optionCandles, 520441);
    assert.deepEqual(out.moves, [10, 10]);
    assert.ok(seen.every((s) => s.headers.apikey === 'sb_publishable_test' && !s.headers.authorization), 'publishable key goes in apikey only');
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"Invalid API key"}' });
    const bad = await buildHistory(env);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /HTTP 401/);
  } finally {
    globalThis.fetch = original;
  }
});
