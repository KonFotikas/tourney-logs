# Notes for Claude

Tourney Logs: a public site for Challonge tournaments (brackets, results, decks). One Cloudflare Worker,
free plan. The owner deploys by pushing to `main` (Cloudflare Workers Builds is connected to this repo).

## Layout
- `src/worker.js`: the Worker. Serves `public/` via the ASSETS binding; `/api/*` JSON API; `/img/<id>`
  decklist images; `scheduled()` checks ongoing tournaments that are due (cron in `wrangler.jsonc` wakes every 10 min;
  `src/schedule.js` decides who is due: 10 min after a result, slowing to 6 h when quiet).
- `src/importer.js`: Challonge v1 JSON -> tournament + match docs. Keep it the single source of import
  logic; `test/importer.test.js` covers finals labels, the unneeded-reset count rule and edit preservation.
- `public/index.html`: the whole front end (CSS + JS inline, no build step). Talks to `/api` only.
- `data/seed.json`: data copied from the old claude.ai "Match Book" page; loaded once into an empty
  database (`meta.seeded`), never overwrites. `public/seed-images/` holds images it references.

## Data (D1, binding `DB`; tables created at runtime in `ensureDb`)
- `tournaments(id, data)`, `matches(tournament_id, id, data)`, `decks(tournament_id, id, data)`,
  `images(id, type, data BLOB)`, `meta(k, v)`. `data` is a JSON document.
- Tournament id = Challonge slug (`sub-slug` for subdomain tournaments). Match id = `c<challonge id>`.
- Match doc: p1, p2, score, winner (p1|p2|""), status (upcoming|live|done), when, round, roundOrder,
  section (Winners|Losers|Group X|""), num, identifier, challongeId, p1From/p2From ({match, loser}),
  notes, links[{label,url}], edited, updatedAt.
- Deck doc: player, deck, imageId (an `images` row), imageUrl, updatedAt.
- A match with `edited: true` keeps p1/p2/score/winner/status/when on re-import; notes/links always kept.
- Finished = counts.done >= counts.total (the grand final reset is left out of counts when player 1 won
  the grand final) or Challonge state "complete". Finished tournaments aren't auto-refreshed; nor are ones unchanged for STALE_DAYS (60).
- Tournaments run over several weeks: keep Challonge calls low (see `test/schedule.test.js` month estimate).

## Secrets (Cloudflare dashboard, never in the repo)
`CHALLONGE_USERNAME`, `CHALLONGE_API_KEY`, `ADMIN_PASSWORD`, optional `ADMIN_TOKEN`
(`Authorization: Bearer <token>` for API calls). Local dev: `.dev.vars` (git-ignored).

## Conventions
- Plain JS, no framework, no build step. Keep `public/index.html` self-contained.
- Writes from the browser need the admin cookie plus header `x-tl: 1` (CSRF guard).
- Images are stored in D1 (rows max ~2 MB): the page shrinks photos before upload; the server caps at 1.9 MB.
- Run `npm test` after touching the importer. For UI changes, `npm run dev` and check at phone width.
