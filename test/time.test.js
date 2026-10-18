import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDeltaExpiry, usOpenUtc, sessionAt, lastFridayOfMonth, deribitExpiries, zonedToUtc } from '../lib/time.js';
import { EVENTS } from '../lib/events-data.js';

const iso = (ms) => new Date(ms).toISOString();

test('Delta expiry is 12:00 UTC (5:30 PM IST)', () => {
  assert.equal(iso(nextDeltaExpiry(Date.UTC(2026, 9, 18, 11, 59))), '2026-10-18T12:00:00.000Z');
  assert.equal(iso(nextDeltaExpiry(Date.UTC(2026, 9, 18, 12, 0))), '2026-10-19T12:00:00.000Z');
  assert.equal(iso(nextDeltaExpiry(Date.UTC(2026, 9, 18, 17, 0))), '2026-10-19T12:00:00.000Z');
});

test('US open follows the clock change on 1 Nov 2026', () => {
  assert.equal(iso(usOpenUtc(Date.UTC(2026, 9, 30, 10))), '2026-10-30T13:30:00.000Z'); // EDT
  assert.equal(iso(usOpenUtc(Date.UTC(2026, 10, 2, 10))), '2026-11-02T14:30:00.000Z'); // EST
});

test('zonedToUtc handles both sides of the change', () => {
  assert.equal(iso(zonedToUtc(2026, 10, 28, 14, 0, 'America/New_York')), '2026-10-28T18:00:00.000Z');
  assert.equal(iso(zonedToUtc(2026, 12, 9, 14, 0, 'America/New_York')), '2026-12-09T19:00:00.000Z');
});

test('sessions in IST', () => {
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 0, 0)).name, 'Asia'); // 05:30 IST
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 8, 0)).name, 'London'); // 13:30 IST
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 14, 0)).name, 'New York'); // 19:30 IST
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 19, 59)).name, 'New York'); // 01:29 IST
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 20, 0)).name, 'Late'); // 01:30 IST
  assert.equal(sessionAt(Date.UTC(2026, 9, 18, 23, 59)).name, 'Late'); // 05:29 IST
});

test('Deribit expiry calendar', () => {
  assert.equal(lastFridayOfMonth(2026, 9), 30);
  assert.equal(lastFridayOfMonth(2026, 11), 25);
  const sun = Date.UTC(2026, 9, 18, 17, 0);
  const e = Object.fromEntries(deribitExpiries(sun).map((x) => [x.label, iso(x.at)]));
  assert.equal(e.Daily, '2026-10-19T08:00:00.000Z');
  assert.equal(e.Weekly, '2026-10-23T08:00:00.000Z');
  assert.equal(e.Monthly, '2026-10-30T08:00:00.000Z');
  assert.equal(e.Quarterly, '2026-12-25T08:00:00.000Z');
  // after the October monthly has passed, the next monthly is November's last Friday
  const after = Object.fromEntries(deribitExpiries(Date.UTC(2026, 9, 31, 0)).map((x) => [x.label, iso(x.at)]));
  assert.equal(after.Monthly, '2026-11-27T08:00:00.000Z');
});

test('event table is well formed and on weekdays', () => {
  const ids = new Set();
  for (const e of EVENTS) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(e.time, /^\d{2}:\d{2}$/);
    assert.match(e.source, /^https:\/\//);
    const dow = new Date(`${e.date}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${e.id} falls on a weekend`);
  }
});
