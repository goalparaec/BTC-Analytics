// Dashboard front end. All numbers come from /api/snapshot; nothing is calculated or guessed here
// except clocks and countdowns. Text is set with textContent only.

import { classify, spreadLevel, beLevel, sessionClass, scaleMove } from './signals.js';

const POLL_MS = 10000;
const HISTORY_MS = 10 * 60 * 1000;
const root = document.getElementById('app');
const state = { snap: null, loadedAt: 0, error: null, expiry: 0, side: 'call', distance: 1500, history: null };

try {
  const saved = JSON.parse(localStorage.getItem('desk') || '{}');
  if (saved.side === 'call' || saved.side === 'put') state.side = saved.side;
  if ([500, 1000, 1500, 2000, 2500].includes(saved.distance)) state.distance = saved.distance;
} catch { /* storage unavailable: defaults are fine */ }
const save = () => {
  try { localStorage.setItem('desk', JSON.stringify({ side: state.side, distance: state.distance })); } catch { /* ignore */ }
};

// ---------- helpers ----------
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const NA = () => el('span', { class: 'na', text: '–' });
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const f0 = nf(0), f1 = nf(1), f2 = nf(2), f3 = nf(3);
const usd = (x) => (isNum(x) ? (Math.abs(x) >= 1000 ? f0.format(x) : f2.format(x)) : null);
const pct = (x, d = 2) => (isNum(x) ? `${nf(d).format(x)}%` : null);
const sign = (x, f) => (isNum(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}${f.format(Math.abs(x))}` : null);
const cell = (v, cls) => el('td', { class: cls }, v === null || v === undefined ? NA() : v);

function dur(ms) {
  if (!isNum(ms)) return '–';
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${neg ? '−' : ''}${d ? `${d}d ` : ''}${p(h)}:${p(m)}:${p(s)}`;
}
const age = (ms) => (!isNum(ms) ? '–' : ms < 1500 ? '<2s' : ms < 90000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`);
const istTime = (ms, withDate = true) => new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  ...(withDate ? { weekday: 'short', day: '2-digit', month: 'short' } : {}),
}).format(new Date(ms));
const utcTime = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// ---------- panels ----------
function panel(title, ...body) {
  return el('section', { class: 'panel' }, title ? el('h2', { text: title }) : null, ...body);
}
const tone = (node, c) => { node.classList.add(c); return node; };
const lvl = (level) => (level ? `t-${level}` : '');
function kv(rows) {
  const dl = el('dl', { class: 'kv' });
  for (const [k, v, tagModel] of rows) {
    dl.append(el('dt', {}, k, tagModel ? [' ', el('span', { class: 'tag', text: 'model' })] : null));
    dl.append(el('dd', {}, v === null || v === undefined ? NA() : v));
  }
  return dl;
}

function statusBar(s) {
  const dots = el('div', { class: 'dots' });
  for (const src of s.sources) {
    const cls = !src.ok ? 'down' : src.stale ? 'stale' : '';
    const label = !src.ok ? `${src.name}: ${src.error}` : `${src.name} · ${age(src.ageMs)} old · ${src.latencyMs} ms`;
    dots.append(el('span', { class: `dot ${cls}`, title: label }, el('i'), src.name.replace('futures:', '').replace('spot:', '')));
  }
  const bad = s.sources.filter((x) => !x.ok).length;
  return el('div', { class: 'statusbar' },
    el('span', { id: 'updated', text: 'Updated just now' }),
    el('span', { text: bad ? `${bad} of ${s.sources.length} sources down` : `${s.sources.length} sources up` }),
    dots);
}

function countdownPanel(s) {
  const t = s.time;
  const nextEv = s.events.find((e) => e.atUtc > t.now);
  return tone(panel('Delta expiry',
    el('div', { class: 'big', id: 'cd-expiry', 'data-target': t.deltaExpiry, text: dur(t.deltaExpiry - Date.now()) }),
    el('p', { class: 'muted', text: `${istTime(t.deltaExpiry)} IST · ${utcTime(t.deltaExpiry)} UTC` }),
    kv([
      ['US stock open', `${istTime(t.usOpenUtc, false)} IST`],
      ['Session now', `${t.session.name} ${t.session.startIst}–${t.session.endIst}`],
      ['Next event', nextEv ? nextEv.name : null],
      ['In', nextEv ? el('span', { id: 'cd-event', 'data-target': nextEv.atUtc, text: dur(nextEv.atUtc - Date.now()) }) : null],
    ])), 'c-teal');
}

function spotPanel(s) {
  const sp = s.spot;
  const rows = el('tbody');
  for (const v of sp.venues) {
    rows.append(el('tr', {},
      el('td', { text: `${v.name} (${v.quote})` }),
      v.down ? el('td', { colspan: '3', class: 'down', title: v.error, text: 'down' }) : [
        cell(usd(v.price)),
        cell(isNum(v.devBps) ? sign(v.devBps, f1) : null, isNum(v.devBps) && Math.abs(v.devBps) > 15 ? 'down' : ''),
        cell(v.stale ? 'stale' : age(v.ageMs), v.stale ? 'down' : ''),
      ]));
  }
  return tone(panel('Reference price',
    el('div', { class: 'big', text: sp.reference ? `$${f2.format(sp.reference.price)}` : 'no price' }),
    el('p', { class: 'muted', text: sp.reference ? sp.reference.source : 'No usable source' }),
    kv([
      ['Delta vs venue median (bps)', isNum(sp.deltaVsMedianBps) ? sign(sp.deltaVsMedianBps, f1) : null],
    ]),
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: 'Venue' }), el('th', { text: 'Price' }), el('th', { text: 'vs median bps' }), el('th', { text: 'Age' }))),
      rows))), 'c-blue');
}

function movePanel(s, ex) {
  const o = s.options;
  const der = o.deribit;
  const dv = der.dvol;
  const dEx = der.options && ex ? der.options[0] : null;
  const rv = (w) => (s.vol[w] && isNum(s.vol[w].rv) ? pct(s.vol[w].rv * 100, 1) : null);
  const r = s.ivRv;
  const ratio = (x) => (isNum(x) ? `${f2.format(x)}×` : null);
  return tone(panel('Expected move',
    ex && ex.expectedMove
      ? [el('div', { class: 'big', text: `±${f0.format(ex.expectedMove.pts)}` }),
         el('p', { class: 'muted' }, `${pct(ex.expectedMove.pct)} of spot to expiry (ATM straddle)`, ' ', el('span', { class: 'tag', text: 'from mark prices' }))]
      : el('p', { class: 'muted', text: 'Not available' }),
    kv([
      ['ATM strike', ex && ex.atm ? f0.format(ex.atm.strike) : null],
      ['ATM implied vol (Delta)', ex && ex.atm && ex.atm.iv ? pct(ex.atm.iv * 100, 1) : null],
      ['1σ move to expiry', ex && isNum(ex.oneSigmaPts) ? `±${f0.format(ex.oneSigmaPts)}` : null, true],
      ['Realised vol 1h / 4h / 24h', [rv('h1'), rv('h4'), rv('h24')].map((x) => x || '–').join(' / ')],
      ['24h range', s.vol.h24 ? `${f0.format(s.vol.h24.rangePts)} (${pct(s.vol.h24.rangePct)})` : null],
      ['Implied ÷ realised 1h / 4h / 24h', r ? [ratio(r.vs1h), ratio(r.vs4h), ratio(r.vs24h)].map((x) => x || '–').join(' / ') : null],
      ['Deribit DVOL (30-day)', dv ? `${f1.format(dv.value)}${isNum(dv.change24h) ? ` (${sign(dv.change24h, f1)} 24h)` : ''}` : null],
      ['Deribit ATM IV, nearest', dEx && isNum(dEx.atmIv) ? `${pct(dEx.atmIv * 100, 1)} · ${istTime(dEx.expiryTs)}` : null],
      ['Max pain (Delta OI)', ex && ex.maxPain ? f0.format(ex.maxPain) : null, true],
    ])), 'c-violet');
}

function expiryTabs(exps) {
  const wrap = el('div', { class: 'tabs', role: 'group', 'aria-label': 'Expiry' });
  exps.forEach((e, i) => wrap.append(el('button', {
    class: 'tab', type: 'button', 'aria-pressed': String(i === state.expiry),
    onclick: () => { state.expiry = i; render(); },
  }, `${istTime(e.expiryTs)} IST`, ` · ${f1.format(e.hoursToExpiry)}h`)));
  return wrap;
}

function plannerPanel(ex) {
  if (!ex || !ex.ladder) return panel('Trade planner', el('p', { class: 'muted', text: ex && ex.error ? ex.error : 'No option data' }));
  const tools = el('div', { class: 'row-tools' },
    el('div', { class: 'tabs', role: 'group', 'aria-label': 'Side' },
      ['call', 'put'].map((sd) => el('button', { class: `tab ${sd}`, type: 'button', 'aria-pressed': String(state.side === sd), onclick: () => { state.side = sd; save(); render(); } }, sd === 'call' ? 'Calls (above spot)' : 'Puts (below spot)'))),
    el('div', { class: 'tabs', role: 'group', 'aria-label': 'Distance' },
      [500, 1000, 1500, 2000, 2500].map((d) => el('button', { class: 'tab', type: 'button', 'aria-pressed': String(state.distance === d), onclick: () => { state.distance = d; save(); render(); } }, `${f0.format(d)} pts`))));
  const body = el('tbody');
  for (const row of ex.ladder) {
    const o = row[state.side];
    const hl = row.target === state.distance ? 'hl' : '';
    if (!o) { body.append(el('tr', { class: hl }, el('td', { text: `${f0.format(row.target)}` }), el('td', { colspan: '11', class: 'na', text: 'no strike on this side' }))); continue; }
    body.append(el('tr', { class: hl },
      cell(`${f0.format(row.target)}`),
      cell(f0.format(o.strike)),
      cell(`${f0.format(o.distance)}`),
      cell(usd(o.bid)),
      cell(usd(o.ask)),
      cell(pct(o.spreadPct, 1), lvl(spreadLevel(o.spreadPct))),
      cell(isNum(o.breakEvenMove) ? `${f0.format(o.breakEvenMove)} (${pct(o.breakEvenPct)})` : null),
      cell(isNum(o.beVsExpected) ? `${f2.format(o.beVsExpected)}×` : null, lvl(beLevel(o.beVsExpected))),
      cell(isNum(o.thetaPerHour) ? f2.format(o.thetaPerHour) : null),
      cell(isNum(o.probTouch) ? pct(o.probTouch * 100, 0) : null),
      cell(isNum(o.probBeyondBreakEven) ? pct(o.probBeyondBreakEven * 100, 0) : null)));
  }
  const th = (t, tip) => el('th', { title: tip || null, text: t });
  return tone(panel('Trade planner',
    tools,
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {},
        th('Target', 'Distance you asked for'), th('Strike'), th('Actual', 'Actual distance from spot'), th('Bid'), th('Ask', 'Price you pay'), th('Spread', 'Bid-ask spread as % of mid'),
        th('Break-even move', 'Points BTC must travel from spot for a buyer at the ask to break even at expiry'),
        th('Needs × exp. move', 'Break-even move divided by the ATM straddle expected move'),
        th('Theta $/h (model)', 'Black-Scholes time decay in USD per hour per 1 BTC'),
        th('P(touch) (model)', 'Chance price touches the strike before expiry, zero-drift approximation'),
        th('P(beyond BE) (model)', 'Chance price finishes beyond break-even at expiry'))),
      body)),
    el('div', { class: 'legend' }, 'Spread:', el('span', { class: 'sw g', text: '< 5%' }), el('span', { class: 'sw w', text: '5–15%' }), el('span', { class: 'sw b', text: '> 15%' }),
      '· Needs × exp. move:', el('span', { class: 'sw g', text: '< 0.8' }), el('span', { class: 'sw w', text: '0.8–1.2' }), el('span', { class: 'sw b', text: '> 1.2' })),
    el('p', { class: 'note', text: 'Prices are USD per 1 BTC of option. Buying uses the ask. Model columns use the option’s own implied vol and no interest rate. Colours are rules of thumb for a buyer.' })), 'c-blue');
}

function chainPanel(ex, spot) {
  if (!ex || !ex.chain) return null;
  const body = el('tbody');
  for (const r of ex.chain) {
    const atm = ex.atm && r.strike === ex.atm.strike ? 'atm' : '';
    const c = r.call, p = r.put;
    body.append(el('tr', { class: atm },
      cell(c ? usd(c.bid) : null, 'callc'), cell(c ? usd(c.ask) : null, 'callc'), cell(c && c.markIv ? pct(c.markIv * 100, 1) : null, 'callc'), cell(c ? c.oi : null, 'callc'),
      el('td', { class: 'strike', text: f0.format(r.strike) }),
      cell(p ? usd(p.bid) : null, 'putc'), cell(p ? usd(p.ask) : null, 'putc'), cell(p && p.markIv ? pct(p.markIv * 100, 1) : null, 'putc'), cell(p ? p.oi : null, 'putc')));
  }
  return tone(panel('Option chain around the money',
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {},
        ['Call bid', 'Call ask', 'Call IV', 'Call OI'].map((x) => el('th', { class: 'callh', text: x })),
        el('th', { style: 'text-align:center', text: 'Strike' }),
        ['Put bid', 'Put ask', 'Put IV', 'Put OI'].map((x) => el('th', { class: 'puth', text: x })))),
      body)),
    el('p', { class: 'note', text: `Strikes within ±3,000 of ${f0.format(spot)}. OI is open interest as Delta reports it. Bold row is at the money.` })), 'c-blue');
}

function futuresPanel(s) {
  const body = el('tbody');
  for (const f of s.futures) {
    if (!f.ok) { body.append(el('tr', {}, el('td', { text: f.venue }), el('td', { colspan: '4', class: 'down', title: f.error, text: 'down' }))); continue; }
    const fr = isNum(f.fundingRate) ? `${f3.format(f.fundingRate * 100)}%` : isNum(f.fundingRateRaw) ? `raw ${f.fundingRateRaw}` : null;
    body.append(el('tr', {},
      el('td', { text: f.venue }),
      cell(usd(f.mark)),
      cell(fr),
      cell(isNum(f.oiBtc) ? `${f0.format(f.oiBtc)} BTC` : null),
      cell(f.stale ? 'stale' : age(f.ageMs), f.stale ? 'down' : '')));
  }
  return tone(panel('Perpetual futures',
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { text: 'Venue' }), el('th', { text: 'Mark' }), el('th', { text: 'Funding / 8h' }), el('th', { text: 'Open interest' }), el('th', { text: 'Age' }))),
      body)),
    el('p', { class: 'note', text: 'Funding is the rate per funding interval as each venue reports it. Delta’s units are shown raw until confirmed.' })), 'c-amber');
}

function eventsPanel(s) {
  const list = el('div');
  for (const e of s.events) {
    list.append(el('div', { class: 'ev' },
      el('span', {}, el('strong', { text: e.name }), ' ', el('span', { class: `tag ${e.impact}`, text: e.impact })),
      el('span', { class: 'when', 'data-target': e.atUtc, text: dur(e.atUtc - Date.now()) }),
      el('span', { class: 'small' }, `${istTime(e.atUtc)} IST · `, el('a', { href: e.source, target: '_blank', rel: 'noopener noreferrer', text: 'official schedule' }), ` · ${e.note}`)));
  }
  const exp = el('div', { class: 'ev' }, el('span', { class: 'small' }, 'Deribit expiries (08:00 UTC): ',
    s.time.deribitExpiries.filter((x) => x.at).map((x) => `${x.label} ${istTime(x.at)}`).join(' · ')));
  return tone(panel('Events and expiries', list, exp, el('p', { class: 'note', text: `Event dates checked against the official pages on ${s.eventsVerifiedOn}. Always confirm on the source before a release.` })), 'c-rose');
}

function signalsPanel(s, ex) {
  const grid = el('div', { class: 'signals' });
  for (const g of classify(s, state.history, state.expiry)) {
    grid.append(el('div', { class: `sig ${g.level}`, title: g.tip },
      el('div', { class: 'l', text: g.label }),
      el('div', { class: 'v', text: g.value }),
      el('span', { class: 'chip', text: g.text })));
  }
  return panel('Market signals', grid,
    el('p', { class: 'note', text: 'Quick read for someone buying options. Green is favourable, red is unfavourable, amber is caution, blue is fair. Hover a card for the rule behind it.' }));
}

const WD = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function historyPanel(h, ex) {
  if (!h) return tone(panel('History (Supabase)', el('p', { class: 'muted', text: 'Loading…' })), 'c-green');
  if (!h.configured) {
    return tone(panel('History (Supabase)', el('p', { class: 'muted', text: 'Not connected. Add SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel project settings, then redeploy, to see the history from your database.' })), 'c-green');
  }
  if (!h.ok) {
    return tone(panel('History (Supabase)', el('p', { class: 'down', text: `Could not read Supabase: ${h.error}` }),
      el('p', { class: 'note', text: 'Check the URL and key in Vercel, and that the migrations have been run.' })), 'c-green');
  }
  const st = h.stats;
  const cv = h.coverage;
  const day = (ms) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }).format(new Date(ms));
  const stats = el('div', { class: 'stats' },
    [['Days', f0.format(st.n)], ['Avg move 5:30→5:30', `${f0.format(st.absMove.mean)} pts`], ['Median move', `${f0.format(st.absMove.median)} pts`], ['90% of days move under', `${f0.format(st.absMove.p90)} pts`],
     ['Avg range', `${f0.format(st.range.mean)} pts`], ['Range 10th–90th', `${f0.format(st.range.p10)}–${f0.format(st.range.p90)}`]]
      .map(([l, v]) => el('div', { class: 'stat' }, el('div', { class: 'l', text: l }), el('div', { class: 'v', text: v }))));
  const maxWd = Math.max(...st.byWeekday.map((d) => d.meanRange));
  const wd = el('tbody');
  for (const d of st.byWeekday) {
    wd.append(el('tr', {}, el('td', { text: WD[d.isoDow] }), cell(f0.format(d.meanRange)), cell(f0.format(d.meanAbsMove)),
      el('td', {}, el('span', { class: 'hbar', style: `width:${Math.round((d.meanRange / maxWd) * 90)}px` }))));
  }
  const last = el('tbody');
  for (const r of h.last) {
    const mv = isNum(r.open) && isNum(r.close) ? r.close - r.open : null;
    last.append(el('tr', {}, el('td', { text: day(r.windowEnd) }), cell(usd(r.open)), cell(usd(r.close)),
      cell(isNum(mv) ? sign(mv, f0) : null, isNum(mv) ? (mv > 0 ? 'up' : mv < 0 ? 'down' : '') : ''), cell(isNum(r.rangePts) ? f0.format(r.rangePts) : null)));
  }
  // hourly activity bars (weekday), coloured by session
  const wk = Array.from({ length: 24 }, (_, i) => h.hourly.find((x) => x.istHour === i && !x.weekend));
  const maxH = Math.max(...wk.map((x) => (x && isNum(x.avgRangePts) ? x.avgRangePts : 0)), 1);
  const bars = el('div', { class: 'bars', role: 'img', 'aria-label': 'Average hourly range by IST hour on weekdays' });
  const labels = el('div', { class: 'barlabels' });
  wk.forEach((x, i) => {
    const m = i * 60 + 30; // IST minute of the hour's middle; same session boundaries as the clock
    const cls = m >= 330 && m < 810 ? 'asia' : m >= 810 && m < 1170 ? 'london' : m >= 1170 || m < 90 ? 'ny' : 'late';
    bars.append(el('div', { class: `bar ${cls}`, style: `height:${x ? Math.max(2, Math.round((x.avgRangePts / maxH) * 100)) : 2}%`, title: x ? `${String(i).padStart(2, '0')}:00 IST · avg range ${f0.format(x.avgRangePts)} pts (${f2.format(x.avgRangePct)}%)` : 'no data' }));
    labels.append(el('span', { text: i % 3 === 0 ? String(i) : '' }));
  });
  const ratio = (() => {
    if (!ex || !ex.expectedMove) return null;
    const typ = scaleMove(st.absMove.mean, ex.hoursToExpiry);
    return typ ? el('p', { class: 'note' }, `Priced now: ±${f0.format(ex.expectedMove.pts)} pts with ${f1.format(ex.hoursToExpiry)}h left. The average real move scaled to that time is ±${f0.format(typ)} pts (${f2.format(ex.expectedMove.pts / typ)}×).`) : null;
  })();
  return tone(panel('History (Supabase)', stats, ratio,
    el('div', { class: 'grid2' },
      el('div', {}, el('h2', { text: 'Last 14 trading days (5:30 PM → 5:30 PM IST)' }), el('div', { class: 'scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Ends' }), el('th', { text: 'Open' }), el('th', { text: 'Close' }), el('th', { text: 'Move' }), el('th', { text: 'Range' }))), last))),
      el('div', {}, el('h2', { text: 'By weekday (day ending)' }), el('div', { class: 'scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', { text: 'Day' }), el('th', { text: 'Avg range' }), el('th', { text: 'Avg move' }), el('th', { text: '' }))), wd)))),
    el('h2', { style: 'margin-top:14px', text: 'Average hourly range by IST hour (weekdays)' }), bars, labels,
    el('div', { class: 'legend' }, el('span', { class: 'sw', style: 'background:#e3f0fd;color:#1d5fa8', text: 'Asia' }), el('span', { class: 'sw', style: 'background:#fff2d1;color:#8a5a00', text: 'London' }), el('span', { class: 'sw', style: 'background:#e2f5e9;color:#137a43', text: 'New York' }), el('span', { class: 'sw', style: 'background:#edf1f5;color:#4b5b6c', text: 'Late' })),
    el('p', { class: 'note', text: `Data: ${f0.format(cv.spotRows)} hourly spot candles, ${f0.format(cv.contracts)} option contracts, ${f0.format(cv.optionCandles)} option candles, ${day(cv.spotFrom)} to ${day(cv.spotTo)}. Move = absolute change from open to close of the window; range = high minus low.` })), 'c-green');
}

// ---------- render ----------
function render() {
  const s = state.snap;
  root.replaceChildren();
  if (state.error) root.append(el('div', { class: 'banner err', role: 'alert', text: `Could not refresh: ${state.error}. Showing the last good data${s ? '' : ' (none yet)'}.` }));
  if (!s) return;
  if (s.warnings.length) root.append(el('div', { class: 'banner', role: 'status' }, el('ul', {}, s.warnings.map((w) => el('li', { text: w })))));
  root.append(statusBar(s));
  const exps = s.options.expiries;
  if (state.expiry >= exps.length) state.expiry = 0;
  const ex = exps[state.expiry] || null;
  root.append(signalsPanel(s, ex));
  root.append(el('div', { class: 'grid3' }, countdownPanel(s), spotPanel(s), movePanel(s, ex)));
  if (exps.length) root.append(panel('Expiry', expiryTabs(exps)));
  root.append(plannerPanel(ex));
  const chain = chainPanel(ex, s.spot.reference ? s.spot.reference.price : 0);
  if (chain) root.append(chain);
  root.append(el('div', { class: 'grid2' }, futuresPanel(s), eventsPanel(s)));
  root.append(historyPanel(state.history, ex));
  document.getElementById('foot-meta').textContent = `Snapshot v${s.version} · calculations v${s.calcVersion} · generated ${new Date(s.generatedAt).toISOString()}`;
  tick();
}

function tick() {
  const now = Date.now();
  document.getElementById('clock-ist').textContent = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
  if (state.snap) {
    const sess = document.getElementById('session');
    sess.textContent = state.snap.time.session.name;
    sess.className = `pill s-${sessionClass(state.snap.time.session.name)}`;
    const u = document.getElementById('updated');
    if (u) u.textContent = `Updated ${age(now - state.loadedAt)} ago`;
  }
  document.querySelectorAll('[data-target]').forEach((n) => { n.textContent = dur(Number(n.dataset.target) - now); });
}

async function load() {
  try {
    const res = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    state.snap = await res.json();
    state.loadedAt = Date.now();
    state.error = null;
  } catch (e) {
    state.error = e.message || String(e);
  }
  render();
}

async function loadHistory() {
  try {
    const res = await fetch('/api/history', { cache: 'no-store' });
    if (!res.ok) throw new Error(`server answered ${res.status}`);
    state.history = await res.json();
  } catch (e) {
    state.history = { configured: true, ok: false, error: e.message || String(e) };
  }
  if (state.snap) render();
}

load();
loadHistory();
setInterval(load, POLL_MS);
setInterval(loadHistory, HISTORY_MS);
setInterval(tick, 1000);
