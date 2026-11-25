import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEveryMinutes, isDue } from "../src/schedule.js";

const now = Date.parse("2026-12-01T12:00:00Z");
const ago = (min) => new Date(now - min * 60_000).toISOString();

test("checks often after a result, rarely when quiet", () => {
  assert.equal(checkEveryMinutes({ lastChangeAt: ago(30) }, now), 10);
  assert.equal(checkEveryMinutes({ lastChangeAt: ago(5 * 60) }, now), 30);
  assert.equal(checkEveryMinutes({ lastChangeAt: ago(2 * 24 * 60) }, now), 120);
  assert.equal(checkEveryMinutes({ lastChangeAt: ago(10 * 24 * 60) }, now), 360);
  assert.equal(checkEveryMinutes({ lastChangeAt: ago(30), challongeState: "pending" }, now), 120);
});

test("isDue follows the interval, with slack for the timer", () => {
  const busy = { lastChangeAt: ago(20) };
  assert.equal(isDue({ ...busy, syncedAt: ago(5) }, { now }), false);
  assert.equal(isDue({ ...busy, syncedAt: ago(9) }, { now }), true);     // 10-minute tick, slightly early
  const quiet = { lastChangeAt: ago(4 * 24 * 60) };
  assert.equal(isDue({ ...quiet, syncedAt: ago(200) }, { now }), false);
  assert.equal(isDue({ ...quiet, syncedAt: ago(359) }, { now }), true);
});

test("stops after the stale limit and when switched off", () => {
  assert.equal(isDue({ lastChangeAt: ago(61 * 24 * 60), syncedAt: ago(9999) }, { now, staleDays: 60 }), false);
  assert.equal(isDue({ lastChangeAt: ago(30), syncedAt: ago(60), autoSync: false }, { now }), false);
  assert.equal(isDue({ createdAt: ago(1) }, { now }), true);              // never checked yet
});

// Rough monthly cost for a tournament with a result on 12 of 30 days and quiet days in between.
test("a month of a slow, multi-week tournament stays in the hundreds of calls", () => {
  let t = { lastChangeAt: ago(0), syncedAt: ago(0) }, calls = 0;
  const resultDays = new Set([0, 2, 3, 6, 8, 10, 13, 15, 17, 20, 23, 27]);
  for (let tick = 1; tick <= 30 * 24 * 6; tick++) {
    const at = now + tick * 10 * 60_000;
    const day = Math.floor(tick / (24 * 6)), hour = (tick / 6) % 24;
    if (resultDays.has(day) && hour === 20) t.lastChangeAt = new Date(at).toISOString();   // a match at 20:00
    if (isDue(t, { now: at })) { calls++; t.syncedAt = new Date(at).toISOString(); }
  }
  assert.ok(calls < 800, `calls: ${calls}`);
  console.log("calls in a month:", calls);
});
