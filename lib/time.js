// Time helpers. All instants are UTC milliseconds; display is converted to IST in the browser.
// US time zone rules come from the IANA database via Intl, so the 1 Nov clock change is handled.

export const IST_OFFSET_MIN = 330;
export const DELTA_EXPIRY_HOUR_UTC = 12; // 5:30 PM IST
export const DERIBIT_EXPIRY_HOUR_UTC = 8; // 1:30 PM IST

const DAY = 86400000;

/** Offset (ms) of a time zone at a given instant: local wall time minus UTC. */
export function tzOffsetMs(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `tz` reads y-mo-d h:mi. */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** The next Delta daily expiry (12:00 UTC) strictly after `nowMs`. */
export function nextDeltaExpiry(nowMs) {
  const d = new Date(nowMs);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), DELTA_EXPIRY_HOUR_UTC);
  return nowMs < today ? today : today + DAY;
}

/** US cash equity open (09:30 America/New_York) on the UTC calendar day of `nowMs`. */
export function usOpenUtc(nowMs) {
  const d = new Date(nowMs);
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 9, 30, 'America/New_York');
}

/**
 * Session blocks used in the 12-month volatility study (fixed IST clock times):
 * Asia 05:30-13:30, London 13:30-19:30, New York 19:30-01:30, Late 01:30-05:30.
 */
export function sessionAt(nowMs) {
  const utcMin = Math.floor(nowMs / 60000) % 1440;
  const m = (utcMin + IST_OFFSET_MIN) % 1440;
  if (m >= 330 && m < 810) return { name: 'Asia', startIst: '05:30', endIst: '13:30' };
  if (m >= 810 && m < 1170) return { name: 'London', startIst: '13:30', endIst: '19:30' };
  if (m >= 1170 || m < 90) return { name: 'New York', startIst: '19:30', endIst: '01:30' };
  return { name: 'Late', startIst: '01:30', endIst: '05:30' };
}

export function lastFridayOfMonth(year, monthIndex) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = lastDay; d > 0; d--) {
    if (new Date(Date.UTC(year, monthIndex, d)).getUTCDay() === 5) return d;
  }
  return null;
}

/** Upcoming Deribit expiries (08:00 UTC): next daily, next Friday weekly, next monthly, next quarterly. */
export function deribitExpiries(nowMs) {
  const at = (y, m, d) => Date.UTC(y, m, d, DERIBIT_EXPIRY_HOUR_UTC);
  const n = new Date(nowMs);
  const y = n.getUTCFullYear();
  const mo = n.getUTCMonth();
  const d = n.getUTCDate();

  let daily = at(y, mo, d);
  if (daily <= nowMs) daily += DAY;

  let weekly = at(y, mo, d);
  while (new Date(weekly).getUTCDay() !== 5 || weekly <= nowMs) weekly += DAY;

  const monthlyFor = (yy, mm) => at(yy, mm, lastFridayOfMonth(yy, mm));
  let monthly = monthlyFor(y, mo);
  if (monthly <= nowMs) monthly = monthlyFor(mo === 11 ? y + 1 : y, (mo + 1) % 12);

  let quarterly = null;
  for (let i = 0; i < 15 && quarterly === null; i++) {
    const yy = y + Math.floor((mo + i) / 12);
    const mm = (mo + i) % 12;
    if ([2, 5, 8, 11].includes(mm)) {
      const t = monthlyFor(yy, mm);
      if (t > nowMs) quarterly = t;
    }
  }
  return [
    { label: 'Daily', at: daily },
    { label: 'Weekly', at: weekly },
    { label: 'Monthly', at: monthly },
    { label: 'Quarterly', at: quarterly },
  ];
}
