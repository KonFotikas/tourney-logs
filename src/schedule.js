// How often an ongoing tournament is checked on Challonge. Tournaments here run over several weeks with
// matches played now and then, so checking follows activity: often right after a result comes in,
// rarely when it has been quiet. The timer (wrangler.jsonc) wakes every 10 minutes and only calls
// Challonge for tournaments that are due.

const MIN = 60_000;

/** Minutes to wait between checks, given how long ago something last changed. */
export function checkEveryMinutes(t, now = Date.now()) {
  const last = Date.parse(t.lastChangeAt || t.syncedAt || t.createdAt || "") || 0;
  const quiet = (now - last) / MIN;
  let every;
  if (quiet < 2 * 60) every = 10;            // a result in the last 2 hours: every 10 minutes
  else if (quiet < 12 * 60) every = 30;      // in the last 12 hours: every 30 minutes
  else if (quiet < 3 * 24 * 60) every = 120; // in the last 3 days: every 2 hours
  else every = 360;                          // quieter than that: every 6 hours
  if (t.challongeState === "pending") every = Math.max(every, 120);   // not started on Challonge yet
  return every;
}

/** Should the timer check this tournament now? */
export function isDue(t, { now = Date.now(), staleDays = 60 } = {}) {
  if (t.autoSync === false) return false;
  const last = Date.parse(t.lastChangeAt || t.syncedAt || t.createdAt || "") || 0;
  if (last && now - last > staleDays * 24 * 60 * MIN) return false;   // nothing for ages: leave it to Refresh
  const synced = Date.parse(t.syncedAt || "") || 0;
  // 2 minutes of slack so a check that's due "on" a timer tick isn't pushed to the next one.
  return now - synced >= (checkEveryMinutes(t, now) - 2) * MIN;
}
