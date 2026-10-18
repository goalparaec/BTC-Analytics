// Quick-read status signals. Pure functions (no DOM) so they are unit-tested.
// The thresholds are rules of thumb for someone BUYING options; they are shown in each tooltip.
// level: good (green) | bad (red) | warn (amber) | info (blue) | neutral (grey)

export const T = {
  trendPct: 1,            // 24h move beyond +/-1% counts as a trend
  ivRvCheap: 0.9,         // implied vol / realised vol below this: options look cheap
  ivRvRich: 1.2,          // above this: options look expensive
  fundingHigh: 0.03,      // % per 8h: longs crowded above this
  fundingLow: -0.01,      // % per 8h: shorts crowded below this
  venueBps: 15,           // spot venues further apart than this disagree
  eventHours: 24,         // an event inside this many hours is flagged
  movePricedCheap: 0.85,  // straddle move / typical move
  movePricedRich: 1.15,
  spreadGood: 5,          // bid-ask spread % of mid
  spreadBad: 15,
  beGood: 0.8,            // break-even move / expected move
  beBad: 1.2,
};

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const median = (a) => {
  const s = a.filter(isNum).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const spreadLevel = (pct) => (!isNum(pct) ? null : pct < T.spreadGood ? 'good' : pct < T.spreadBad ? 'warn' : 'bad');
export const beLevel = (x) => (!isNum(x) ? null : x < T.beGood ? 'good' : x <= T.beBad ? 'warn' : 'bad');
export const sessionClass = (name) => ({ Asia: 'asia', London: 'london', 'New York': 'ny', Late: 'late' }[name] || 'late');

/** Scale a 24h typical move to a shorter horizon with the square-root-of-time rule. */
export const scaleMove = (move24h, hours) => (isNum(move24h) && isNum(hours) && hours > 0 ? move24h * Math.sqrt(hours / 24) : null);

export function classify(snap, history, expiryIdx = 0) {
  const out = [];
  const f1 = (x) => (Math.round(x * 10) / 10).toString();

  // 1. 24h trend
  const ch = snap.vol && snap.vol.h24 ? snap.vol.h24.changePct : null;
  if (isNum(ch)) {
    const level = ch > T.trendPct ? 'good' : ch < -T.trendPct ? 'bad' : 'neutral';
    out.push({ id: 'trend', label: 'Last 24h', value: `${ch > 0 ? '+' : ''}${f1(ch)}%`, text: level === 'good' ? 'Up' : level === 'bad' ? 'Down' : 'Flat', level, tip: `Move over the last 24 hours. Up/Down when beyond ±${T.trendPct}%.` });
  } else out.push({ id: 'trend', label: 'Last 24h', value: '–', text: 'No data', level: 'neutral', tip: 'Needs Delta 1-minute candles.' });

  // 2. implied vs realised volatility
  const r = snap.ivRv && snap.ivRv.vs24h;
  if (isNum(r)) {
    const level = r < T.ivRvCheap ? 'good' : r > T.ivRvRich ? 'bad' : 'info';
    out.push({ id: 'ivrv', label: 'Options price', value: `${f1(Math.round(r * 100) / 100)}×`, text: level === 'good' ? 'Cheap' : level === 'bad' ? 'Expensive' : 'Fair', level, tip: `Implied vol ÷ 24h realised vol. For a buyer: below ${T.ivRvCheap} cheap, above ${T.ivRvRich} expensive.` });
  } else out.push({ id: 'ivrv', label: 'Options price', value: '–', text: 'No data', level: 'neutral', tip: 'Needs option chain and candles.' });

  // 3. funding
  const rates = (snap.futures || []).filter((x) => x.ok && isNum(x.fundingRate)).map((x) => x.fundingRate * 100);
  const fr = median(rates);
  if (isNum(fr)) {
    const level = fr > T.fundingHigh ? 'warn' : fr < T.fundingLow ? 'warn' : 'neutral';
    out.push({ id: 'funding', label: 'Funding', value: `${fr.toFixed(3)}%`, text: fr > T.fundingHigh ? 'Longs crowded' : fr < T.fundingLow ? 'Shorts crowded' : 'Neutral', level, tip: `Median funding rate per 8h over ${rates.length} venues. Above ${T.fundingHigh}% longs are paying a lot, below ${T.fundingLow}% shorts are.` });
  } else out.push({ id: 'funding', label: 'Funding', value: '–', text: 'No data', level: 'neutral', tip: 'No venue returned a funding rate.' });

  // 4. venues agree
  const devs = ((snap.spot && snap.spot.venues) || []).filter((v) => !v.down && isNum(v.devBps)).map((v) => Math.abs(v.devBps));
  if (devs.length) {
    const worst = Math.max(...devs);
    const level = worst > T.venueBps ? 'bad' : 'good';
    out.push({ id: 'venues', label: 'Price venues', value: `${f1(worst)} bps`, text: level === 'good' ? 'Agree' : 'Disagree', level, tip: `Largest gap from the median across ${devs.length} spot venues. Over ${T.venueBps} bps is flagged.` });
  }

  // 5. next event
  const ev = (snap.events || []).find((e) => e.atUtc > snap.time.now);
  if (ev) {
    const hrs = (ev.atUtc - snap.time.now) / 3600000;
    const near = hrs <= T.eventHours;
    out.push({ id: 'event', label: 'Next event', value: ev.name, text: near ? `In ${f1(hrs)}h` : `In ${f1(hrs / 24)}d`, level: near ? 'warn' : 'neutral', tip: `Flagged when it is within ${T.eventHours} hours.` });
  }

  // 6. priced move vs history (needs Supabase history)
  const ex = snap.options && snap.options.expiries[expiryIdx];
  if (history && history.ok && history.stats && ex && ex.expectedMove && isNum(ex.hoursToExpiry)) {
    const typical = scaleMove(history.stats.absMove.mean, ex.hoursToExpiry);
    const ratio = typical ? ex.expectedMove.pts / typical : null;
    if (isNum(ratio)) {
      const level = ratio < T.movePricedCheap ? 'good' : ratio > T.movePricedRich ? 'bad' : 'info';
      out.push({ id: 'priced', label: 'Move priced vs history', value: `${(Math.round(ratio * 100) / 100).toFixed(2)}×`, text: level === 'good' ? 'Cheap' : level === 'bad' ? 'Expensive' : 'In line', level, tip: `Straddle expected move ÷ the average real 5:30 PM–5:30 PM move over ${history.stats.n} days, scaled to the time left (square-root rule). Below ${T.movePricedCheap} cheap, above ${T.movePricedRich} expensive for a buyer.` });
    }
  }

  // 7. data health
  const total = (snap.sources || []).length;
  const down = (snap.sources || []).filter((s) => !s.ok).length;
  const stale = (snap.sources || []).filter((s) => s.ok && s.stale).length;
  out.push({ id: 'health', label: 'Data sources', value: `${total - down}/${total}`, text: down ? `${down} down` : stale ? `${stale} stale` : 'All up', level: down ? 'bad' : stale ? 'warn' : 'good', tip: 'Sources currently answering. Failed or stale sources are left out of calculations.' });
  return out;
}
