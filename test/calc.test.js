import test from 'node:test';
import assert from 'node:assert/strict';
import {
  median, bpsDiff, normCdf, probFinishAbove, probTouch, thetaPerDay, realizedVol, parkinsonVol,
  windowStats, pickStrike, maxPain, spreadPct, breakEvenMove, expectedMove, MINUTES_PER_YEAR,
} from '../lib/calc.js';
import { bs } from './helpers.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('median handles odd, even and empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([NaN, 5]), 5);
});

test('bpsDiff', () => {
  close(bpsDiff(101, 100), 100);
  assert.equal(bpsDiff(1, 0), null);
  assert.equal(bpsDiff(null, 5), null);
});

test('normCdf matches known values', () => {
  close(normCdf(0), 0.5, 1e-7);
  close(normCdf(1.96), 0.975, 1e-4);
  close(normCdf(-1.96), 0.025, 1e-4);
  close(normCdf(1) + normCdf(-1), 1, 1e-7);
});

test('model probabilities are sane and refuse bad inputs', () => {
  const p = probFinishAbove(100000, 100000, 0.5, 1 / 365);
  assert.ok(p > 0.48 && p < 0.5);
  assert.equal(probFinishAbove(100000, 100000, 0, 0.01), null);
  assert.equal(probFinishAbove(100000, 100000, 0.5, 0), null);
  const touchNear = probTouch(100000, 100100, 0.5, 1 / 365);
  const touchFar = probTouch(100000, 103000, 0.5, 1 / 365);
  assert.ok(touchNear > touchFar && touchFar >= 0 && touchNear <= 1);
});

test('theta is negative and equals the Black-Scholes price decay for an ATM option', () => {
  const S = 100000, K = 100000, iv = 0.5, T = 2 / 365;
  const th = thetaPerDay(S, K, iv, T);
  assert.ok(th < 0);
  const p0 = bs('call', S, K, iv, T);
  const p1 = bs('call', S, K, iv, T - 1 / 365);
  // price decay over one day is close to the instantaneous daily theta (within a few percent)
  assert.ok(Math.abs((p1 - p0) / th - 1) < 0.5);
});

test('ATM straddle is about 0.8 x S x iv x sqrt(T)', () => {
  const S = 81000, iv = 0.45, T = 1 / 365;
  const straddle = bs('call', S, S, iv, T) + bs('put', S, S, iv, T);
  close(straddle / (S * iv * Math.sqrt(T)), 0.7979, 0.01);
});

test('realisedVol: flat prices give zero, known return gives known vol', () => {
  assert.equal(realizedVol([100, 100, 100, 100], MINUTES_PER_YEAR), 0);
  const closes = [100];
  for (let i = 0; i < 60; i++) closes.push(closes[i] * Math.exp(0.001));
  close(realizedVol(closes, MINUTES_PER_YEAR), 0.001 * Math.sqrt(MINUTES_PER_YEAR), 1e-9);
  assert.equal(realizedVol([1, 2], 1), null);
});

test('parkinson vol for a constant range', () => {
  const r = Math.log(1.001);
  const highs = Array(10).fill(100.1), lows = Array(10).fill(100);
  close(parkinsonVol(highs, lows, 525600), Math.sqrt((r * r) / (4 * Math.log(2)) * 525600), 1e-6);
});

test('windowStats needs 80% of the bars', () => {
  const now = 10_000_000;
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ t: now - (n - i) * 60000, o: 100, h: 101, l: 99, c: 100 + (i % 2) }));
  assert.equal(windowStats(mk(40), 60, now), null);
  const w = windowStats(mk(60), 60, now);
  assert.equal(w.rangePts, 2);
  assert.ok(w.rv > 0);
});

test('pickStrike nearest, tie goes lower', () => {
  assert.equal(pickStrike([80000, 80200, 80400], 80290), 80200);
  assert.equal(pickStrike([80000, 80200], 80100), 80000);
  assert.equal(pickStrike([], 1), null);
});

test('maxPain on a small book', () => {
  const opts = [
    { type: 'call', strike: 100, oi: 10 }, { type: 'put', strike: 100, oi: 10 },
    { type: 'call', strike: 110, oi: 1 }, { type: 'put', strike: 90, oi: 1 },
  ];
  assert.equal(maxPain(opts), 100);
});

test('spread, break-even and expected move', () => {
  close(spreadPct(99, 101), 2);
  assert.equal(spreadPct(null, 5), null);
  assert.equal(spreadPct(5, 4), null);
  assert.equal(breakEvenMove('call', 82500, 100, 81000), 1600);
  assert.equal(breakEvenMove('put', 79500, 100, 81000), 1600);
  assert.equal(breakEvenMove('call', 82500, null, 81000), null);
  const e = expectedMove(300, 320, 81000);
  assert.equal(e.pts, 620);
  close(e.pct, (620 / 81000) * 100);
  assert.equal(expectedMove(null, 1, 1), null);
});
