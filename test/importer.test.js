import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFromChallonge, challongeSlug } from "../src/importer.js";

test("challongeSlug reads bracket links", () => {
  assert.equal(challongeSlug("https://challonge.com/8ezukeos"), "8ezukeos");
  assert.equal(challongeSlug("https://challonge.com/en/abc_12"), "abc_12");
  assert.equal(challongeSlug("https://myclub.challonge.com/cup1"), "myclub-cup1");
  assert.equal(challongeSlug("https://example.com/cup1"), null);
});

// A 4-player double elimination: W1 (A-B), W2 (C-D), WF, L1, LF, GF, reset.
const P = { A: 1, B: 2, C: 3, D: 4 };
const match = (id, round, p1, p2, extra = {}) => ({ match: {
  id, round, player1_id: p1, player2_id: p2, state: "complete", winner_id: p1, scores_csv: "2-0",
  suggested_play_order: id, identifier: String(id), ...extra } });
const api = { tournament: {
  name: "Test Cup", game_name: "Yu-Gi-Oh!", tournament_type: "double elimination", state: "complete", start_at: "2026-01-02T10:00:00.000+00:00",
  participants: Object.entries(P).map(([n, id]) => ({ participant: { id, name: n } })),
  matches: [
    match(1, 1, P.A, P.B), match(2, 1, P.C, P.D),
    match(3, 2, P.A, P.C, { player1_prereq_match_id: 1, player2_prereq_match_id: 2 }),
    match(4, -1, P.B, P.D, { player1_prereq_match_id: 1, player1_is_prereq_match_loser: true, player2_prereq_match_id: 2, player2_is_prereq_match_loser: true }),
    match(5, -2, P.C, P.B, { player1_prereq_match_id: 3, player1_is_prereq_match_loser: true, player2_prereq_match_id: 4 }),
    match(6, 3, P.A, P.C, { player1_prereq_match_id: 3, player2_prereq_match_id: 5 }),
    match(7, 3, null, null, { state: "pending", winner_id: null, scores_csv: "", player1_prereq_match_id: 6, player2_prereq_match_id: 6, player2_is_prereq_match_loser: true }),
  ] } };

test("labels the finals and skips an unneeded reset in the counts", () => {
  const { tournament, matches } = buildFromChallonge(api, { slug: "testcup", sourceUrl: "https://challonge.com/testcup" });
  const round = Object.fromEntries(matches.map(m => [m.id, m.data.round]));
  assert.equal(round.c3, "Winners final");
  assert.equal(round.c5, "Losers final");
  assert.equal(round.c6, "Grand final");
  assert.equal(round.c7, "Grand final reset");
  assert.deepEqual(tournament.counts, { total: 6, live: 0, done: 6 });
  assert.equal(tournament.format, "Double elimination");
  assert.deepEqual(matches.find(m => m.id === "c5").data.p1From, { match: "c3", loser: true });
});

test("re-import keeps notes, links and hand-edited matches", () => {
  const existing = new Map([
    ["c1", { notes: "great set", links: [{ label: "", url: "https://example.com/v" }] }],
    ["c2", { edited: true, score: "2-1", winner: "p2", status: "done", notes: "" }],
  ]);
  const { matches } = buildFromChallonge(api, { slug: "testcup", sourceUrl: "x", existing, oldTournament: { notes: "n", createdAt: "2026-01-01T00:00:00Z" } });
  const c1 = matches.find(m => m.id === "c1").data, c2 = matches.find(m => m.id === "c2").data;
  assert.equal(c1.notes, "great set");
  assert.equal(c1.links.length, 1);
  assert.equal(c2.score, "2-1");
  assert.equal(c2.winner, "p2");
  assert.equal(c2.edited, true);
});
