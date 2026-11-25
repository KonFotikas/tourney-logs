// Turns a Challonge API v1 tournament (fetched with include_participants=1&include_matches=1)
// into Tourney Logs documents: one tournament doc and one doc per match.
//
// Re-importing keeps what was added by hand: notes and links on every match, and every field of a
// match marked `edited`. The tournament's own notes and createdAt are kept too.

const FORMATS = {
  "single elimination": "Single elimination",
  "double elimination": "Double elimination",
  "round robin": "Round robin",
  "swiss": "Swiss",
};

// Wall-clock time as Challonge wrote it ("2026-11-19T05:53:00.000-05:00" -> "2026-11-19T05:53").
function localTime(s) {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d)/.exec(s || "");
  return m ? m[1] : "";
}

const src = (m, n) => {
  const pid = m[`player${n}_prereq_match_id`];
  return pid ? { match: `c${pid}`, loser: !!m[`player${n}_is_prereq_match_loser`] } : null;
};

/**
 * @param {object} api            Parsed Challonge JSON ({ tournament: {...} }).
 * @param {object} opts
 * @param {string} opts.slug      Tournament id in Tourney Logs (the Challonge slug).
 * @param {string} opts.sourceUrl Link to the bracket on challonge.com.
 * @param {Map<string, object>} [opts.existing]  Current match docs by id (to keep hand edits).
 * @param {object} [opts.oldTournament]           Current tournament doc (to keep notes/createdAt).
 * @param {Date} [opts.now]
 * @returns {{ tournament: object, matches: Array<{id: string, data: object}> }}
 */
export function buildFromChallonge(api, { slug, sourceUrl, existing = new Map(), oldTournament = null, now = new Date() }) {
  const t = api.tournament;
  const stamp = now.toISOString();

  const names = new Map();
  for (const pp of t.participants || []) {
    const p = pp.participant;
    const nm = p.display_name || p.name || p.username || "TBD";
    names.set(p.id, nm);
    for (const gid of p.group_player_ids || []) names.set(gid, nm);
  }

  const ms = (t.matches || []).map(x => x.match);
  const ttype = (t.tournament_type || "").toLowerCase();
  const double = ttype === "double elimination";
  const grouped = ms.some(m => m.group_id);
  const groups = [...new Set(ms.filter(m => m.group_id).map(m => m.group_id))].sort((a, b) => a - b);
  const groupName = new Map(groups.map((g, i) => [g, "Group " + String.fromCharCode(65 + i)]));
  const maxW = Math.max(0, ...ms.filter(m => m.round > 0 && !m.group_id).map(m => m.round));

  // Double elimination finals, found from how Challonge feeds players between matches: the grand final
  // takes the winners-final winner and the losers-final winner; the reset takes the grand final's winner
  // and loser (only played if the losers-side player wins).
  const byId = new Map(ms.map(m => [m.id, m]));
  const finals = new Map();
  if (double) {
    for (const m of ms) {
      if (m.group_id || m.round <= 0) continue;
      const pre = [[m.player1_prereq_match_id, m.player1_is_prereq_match_loser], [m.player2_prereq_match_id, m.player2_is_prereq_match_loser]];
      if (pre[0][0] && pre[0][0] === pre[1][0]) {
        finals.set(m.id, ["Grand final reset", 251, "Winners"]);
      } else if (pre.some(([p, lose]) => byId.has(p) && byId.get(p).round < 0 && !lose)) {
        finals.set(m.id, ["Grand final", 250, "Winners"]);
        for (const [p] of pre) {
          if (!byId.has(p) || finals.has(p)) continue;
          const r = byId.get(p).round;
          if (r > 0) finals.set(p, ["Winners final", 200 + r, "Winners"]);
          else if (r < 0) finals.set(p, ["Losers final", 300 - r, "Losers"]);
        }
      }
    }
  }

  function roundInfo(m) {
    const r = m.round;
    if (m.group_id) return [`Round ${Math.abs(r)}`, Math.abs(r), groupName.get(m.group_id)];
    if (ttype === "round robin" || ttype === "swiss") return [`Round ${Math.abs(r)}`, Math.abs(r) + 100, ""];
    if (double) {
      if (finals.has(m.id)) return finals.get(m.id);
      if (r < 0) return [`Losers round ${-r}`, 300 - r, "Losers"];
      return [`Winners round ${r}`, 200 + r, "Winners"];
    }
    if (r === 0) return ["Third place", 255, ""];
    const back = maxW - r;
    const label = { 0: "Final", 1: "Semi-finals", 2: "Quarter-finals" }[back] || `Round ${r}`;
    return [label, 200 + r, ""];
  }

  const ordered = [...ms].sort((a, b) => ((a.suggested_play_order || 99999) - (b.suggested_play_order || 99999)) || (a.id - b.id));
  const matches = ordered.map((m, idx) => {
    const [label, order, section] = roundInfo(m);
    const state = m.state;
    const status = state === "complete" ? "done" : (state === "open" && m.underway_at ? "live" : "upcoming");
    const winner = m.winner_id && m.winner_id === m.player1_id ? "p1" : (m.winner_id && m.winner_id === m.player2_id ? "p2" : "");
    const doc = {
      p1: names.get(m.player1_id) || "", p2: names.get(m.player2_id) || "",
      score: m.scores_csv || "", winner, status,
      when: localTime(m.scheduled_time || m.started_at),
      round: label, roundOrder: order, section,
      num: m.suggested_play_order || (idx + 1),
      identifier: m.identifier || "", challongeId: m.id,
      p1From: src(m, 1), p2From: src(m, 2),
      notes: "", links: [], updatedAt: stamp,
    };
    const id = `c${m.id}`;
    const old = existing.get(id);
    if (old) {
      doc.notes = old.notes || "";
      doc.links = Array.isArray(old.links) ? old.links : [];
      if (old.edited) {
        for (const k of ["p1", "p2", "score", "winner", "status", "when"]) if (k in old) doc[k] = old[k];
        doc.edited = true;
      }
    }
    return { id, data: doc };
  });

  // Counts skip a grand final reset that won't be played (player 1, from the winners side, won the
  // grand final), so a finished tournament reads as finished.
  const gf = matches.find(x => x.data.round === "Grand final");
  const resetOff = !!(gf && gf.data.status === "done" && gf.data.winner === "p1");
  const counts = { total: 0, live: 0, done: 0 };
  for (const { data } of matches) {
    if (resetOff && data.round === "Grand final reset") continue;
    counts.total++;
    if (data.status === "live") counts.live++;
    if (data.status === "done") counts.done++;
  }

  let format = FORMATS[ttype] || t.tournament_type || "";
  if (grouped) format = "Groups + " + format.toLowerCase();
  const tournament = {
    name: t.name || slug,
    game: t.game_name || "",
    date: String(t.start_at || t.started_at || t.created_at || "").slice(0, 10),
    format, sourceUrl, slug,
    challongeState: t.state || "",
    notes: oldTournament?.notes || "",
    counts,
    createdAt: oldTournament?.createdAt || stamp,
    updatedAt: stamp,
    syncedAt: stamp,
  };
  return { tournament, matches };
}

/** "https://challonge.com/abc", "https://challonge.com/en/abc", "https://club.challonge.com/abc" -> Challonge v1 id. */
export function challongeSlug(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host !== "challonge.com" && !host.endsWith(".challonge.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean).filter(p => !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(p) || p.length > 5);
    const slug = (parts[0] === "tournaments" ? parts[1] : parts[0]) || "";
    if (!/^[A-Za-z0-9_]+$/.test(slug)) return null;
    const sub = host.endsWith(".challonge.com") && host !== "www.challonge.com" ? host.slice(0, -".challonge.com".length) : "";
    return sub ? `${sub}-${slug}` : slug;
  } catch {
    return null;
  }
}
