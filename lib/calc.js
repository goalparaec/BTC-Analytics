// Pure, deterministic calculations. No network, no clock, no randomness.
// Every function here has unit tests in test/calc.test.js. Bump CALC_VERSION when a formula changes.

export const CALC_VERSION = '1.0.0';
export const MS_PER_YEAR = 365 * 24 * 3600 * 1000;
export const MINUTES_PER_YEAR = 365 * 24 * 60;

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Difference of a vs reference b in basis points. */
export function bpsDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / b) * 1e4;
}

export function normPdf(x) {
  return 0.3989422804014327 * Math.exp(-0.5 * x * x);
}

/** Standard normal CDF (Abramowitz and Stegun 26.2.17, error below 7.5e-8). */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = normPdf(x) * poly;
  return x >= 0 ? 1 - p : p;
}

const valid = (...xs) => xs.every((x) => Number.isFinite(x) && x > 0);

/** MODEL: probability the underlying finishes above K (risk-neutral, zero rate). */
export function probFinishAbove(S, K, iv, T) {
  if (!valid(S, K, iv, T)) return null;
  const s = iv * Math.sqrt(T);
  return normCdf((Math.log(S / K) - 0.5 * s * s) / s);
}

/** MODEL: probability the underlying finishes below K. */
export function probFinishBelow(S, K, iv, T) {
  const p = probFinishAbove(S, K, iv, T);
  return p === null ? null : 1 - p;
}

/** MODEL: probability price touches K at any time before expiry (zero-drift reflection approximation). */
export function probTouch(S, K, iv, T) {
  if (!valid(S, K, iv, T)) return null;
  const s = iv * Math.sqrt(T);
  const z = Math.abs(Math.log(K / S)) / s;
  return Math.min(1, 2 * normCdf(-z));
}

/** MODEL: Black-Scholes theta in USD per day for 1 BTC of option, zero rate. Same for call and put. */
export function thetaPerDay(S, K, iv, T) {
  if (!valid(S, K, iv, T)) return null;
  const s = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * s * s) / s;
  return (-(S * normPdf(d1) * iv) / (2 * Math.sqrt(T))) / 365;
}

/** Annualised realised volatility from close prices, zero-mean (sum of squared log returns). */
export function realizedVol(closes, barsPerYear) {
  if (closes.length < 3) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) {
      const r = Math.log(closes[i] / closes[i - 1]);
      sum += r * r;
      n++;
    }
  }
  return n < 2 ? null : Math.sqrt((sum / n) * barsPerYear);
}

/** Annualised Parkinson (high-low) volatility. */
export function parkinsonVol(highs, lows, barsPerYear) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < highs.length; i++) {
    if (highs[i] > 0 && lows[i] > 0 && highs[i] >= lows[i]) {
      const r = Math.log(highs[i] / lows[i]);
      sum += r * r;
      n++;
    }
  }
  return n < 2 ? null : Math.sqrt((sum / n / (4 * Math.log(2))) * barsPerYear);
}

/**
 * Stats over the last `minutes` of 1-minute candles. Needs at least 80% of the bars,
 * otherwise returns null (no partial-window numbers presented as complete).
 */
export function windowStats(candles, minutes, nowMs) {
  const from = nowMs - minutes * 60000;
  const w = candles.filter((c) => c.t >= from && c.t <= nowMs);
  if (w.length < Math.ceil(minutes * 0.8)) return null;
  const highs = w.map((c) => c.h);
  const lows = w.map((c) => c.l);
  const hi = Math.max(...highs);
  const lo = Math.min(...lows);
  const last = w[w.length - 1].c;
  return {
    minutes,
    bars: w.length,
    rv: realizedVol(w.map((c) => c.c), MINUTES_PER_YEAR),
    parkinson: parkinsonVol(highs, lows, MINUTES_PER_YEAR),
    rangePts: hi - lo,
    rangePct: last > 0 ? ((hi - lo) / last) * 100 : null,
  };
}

/** Nearest strike to target; ties go to the lower strike. */
export function pickStrike(strikes, target) {
  let best = null;
  for (const k of [...strikes].sort((a, b) => a - b)) {
    if (best === null || Math.abs(k - target) < Math.abs(best - target)) best = k;
  }
  return best;
}

/** MODEL: strike where option holders lose the most in total (sum of intrinsic value x OI). */
export function maxPain(options) {
  const strikes = [...new Set(options.map((o) => o.strike))].sort((a, b) => a - b);
  let best = null;
  for (const k of strikes) {
    let pain = 0;
    for (const o of options) {
      const oi = o.oi ?? 0;
      pain += (o.type === 'call' ? Math.max(0, k - o.strike) : Math.max(0, o.strike - k)) * oi;
    }
    if (best === null || pain < best.pain) best = { strike: k, pain };
  }
  return best ? best.strike : null;
}

/** Quote used to BUY: the ask. No ask means no buy price, not a guess. */
export function spreadPct(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= 0 || bid < 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

/**
 * Break-even move (points) for buying one option at `ask` and holding to expiry.
 * Call: needs price at strike+ask. Put: strike-ask. Returns points from spot (positive = further away).
 */
export function breakEvenMove(type, strike, ask, spot) {
  if (![strike, ask, spot].every(Number.isFinite)) return null;
  return type === 'call' ? strike + ask - spot : spot - (strike - ask);
}

/** ATM straddle price (mark) and expected move to expiry as points and percent of spot. */
export function expectedMove(callMark, putMark, spot) {
  if (![callMark, putMark, spot].every(Number.isFinite) || spot <= 0) return null;
  const straddle = callMark + putMark;
  return { straddle, pts: straddle, pct: (straddle / spot) * 100 };
}
