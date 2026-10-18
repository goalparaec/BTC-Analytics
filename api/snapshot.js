import { fetchAll, buildSnapshot } from '../lib/snapshot.js';

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const results = await fetchAll(now);
    const snap = buildSnapshot(results, Date.now());
    res.setHeader('Cache-Control', 's-maxage=5, stale-while-revalidate=10');
    res.status(200).json(snap);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
