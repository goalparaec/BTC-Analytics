// Diagnostics: one row per data source with its status and a short raw sample of the response.
// Use this after the first deploy to confirm every exchange answers from the Vercel region.
import { fetchAll } from '../lib/snapshot.js';

export default async function handler(req, res) {
  const now = Date.now();
  const results = await fetchAll(now);
  const rows = Object.values(results).map((r) => ({
    source: r.name,
    ok: r.ok,
    latencyMs: r.latencyMs,
    exchangeTs: r.exchangeTs ? new Date(r.exchangeTs).toISOString() : null,
    error: r.error,
    sample: r.sample,
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    region: process.env.VERCEL_REGION || 'local',
    checkedAt: new Date(now).toISOString(),
    okCount: rows.filter((r) => r.ok).length,
    total: rows.length,
    rows,
  });
}
