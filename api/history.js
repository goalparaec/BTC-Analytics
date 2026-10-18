// Historical statistics from Supabase. Works without Supabase: answers { configured: false }.
import { fetchHistory, supabaseConfig } from '../lib/sources/supabase.js';
import { summarizeWindows } from '../lib/calc.js';

export async function buildHistory(env = process.env) {
  let cfg;
  try {
    cfg = supabaseConfig(env);
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
  if (!cfg) return { configured: false };
  try {
    const h = await fetchHistory(env);
    const last = h.windows.slice(0, 14).map((r) => ({ windowEnd: r.windowEnd, open: r.open, close: r.close, rangePts: r.rangePts, rangePct: r.rangePct, absMovePts: r.absMovePts }));
    const stats = summarizeWindows(h.windows);
    return {
      configured: true,
      ok: true,
      generatedAt: Date.now(),
      latencyMs: h.latencyMs,
      coverage: h.coverage,
      stats: stats && { ...stats, moves: undefined },
      moves: stats ? stats.moves : [],
      last,
      hourly: h.hourly,
    };
  } catch (e) {
    return { configured: true, ok: false, error: String((e && e.message) || e).slice(0, 200), detail: e && e.body ? String(e.body).slice(0, 200) : null };
  }
}

export default async function handler(req, res) {
  const out = await buildHistory();
  res.setHeader('Cache-Control', out.ok ? 's-maxage=300, stale-while-revalidate=600' : 'no-store');
  res.status(200).json(out);
}
