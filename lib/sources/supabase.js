// Historical data from Supabase (read-only, through the REST API with the public anon/publishable key).
// The key can only read; row level security blocks all writes. Never put a service-role key here.
import { getJson, SourceError, num, toMs } from '../http.js';

export function supabaseConfig(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!url || !key) return null;
  if (!/^https:\/\//.test(url)) throw new SourceError('SUPABASE_URL must start with https://');
  return { url, key };
}

function headersFor(key) {
  // Legacy anon keys are JWTs and also go in Authorization; new sb_publishable keys go in apikey only.
  return key.startsWith('eyJ') ? { apikey: key, authorization: `Bearer ${key}` } : { apikey: key };
}

export async function fetchHistory(env = process.env) {
  const cfg = supabaseConfig(env);
  if (!cfg) return null;
  const headers = headersFor(cfg.key);
  const q = (path) => getJson(`${cfg.url}/rest/v1/${path}`, { timeoutMs: 8000, headers });
  const [w, h, c] = await Promise.all([
    q('btc_daily_530?select=window_end,open,close,range_pts,range_pct,abs_move_pts,end_isodow&order=window_end.desc&limit=400'),
    q('btc_hourly_activity?select=ist_hour,is_weekend,candles,avg_range_pct,avg_range_pts'),
    q('v_data_coverage?select=*'),
  ]);
  if (![w.json, h.json, c.json].every(Array.isArray)) throw new SourceError('unexpected response shape');
  const windows = w.json.map((r) => ({
    windowEnd: Date.parse(r.window_end),
    open: num(r.open), close: num(r.close),
    rangePts: num(r.range_pts), rangePct: num(r.range_pct), absMovePts: num(r.abs_move_pts),
    isoDow: num(r.end_isodow),
  })).filter((r) => Number.isFinite(r.windowEnd));
  const hourly = h.json.map((r) => ({
    istHour: num(r.ist_hour), weekend: !!r.is_weekend, candles: num(r.candles),
    avgRangePct: num(r.avg_range_pct), avgRangePts: num(r.avg_range_pts),
  })).filter((r) => r.istHour !== null);
  const cv = c.json[0] || {};
  return {
    windows,
    hourly,
    coverage: {
      spotFrom: toMs(Date.parse(cv.spot_from) / 1000), spotTo: toMs(Date.parse(cv.spot_to) / 1000),
      spotRows: num(cv.spot_rows), contracts: num(cv.contracts), optionCandles: num(cv.option_candles),
      firstExpiry: Date.parse(cv.first_expiry) || null, lastExpiry: Date.parse(cv.last_expiry) || null,
    },
    latencyMs: Math.max(w.latencyMs, h.latencyMs, c.latencyMs),
  };
}
