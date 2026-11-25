# Tourney Logs

Tournament brackets, results and decks, kept up to date from Challonge.

- **Bracket** with lines showing where every player came from, zoom, search, match notes and links.
- **Ongoing / Finished** tournaments. Ongoing ones refresh from Challonge every 10 minutes by themselves.
- **Decks** (finished tournaments): score, players, archetype with the decklist image, and a pie chart of the decks.
- **Admin login**: only you can add tournaments and edit things. Everyone else can look, no account needed.

It runs on Cloudflare's free plan as one Worker: the site, an API, a D1 database (tournaments, matches,
decks and decklist images) and a 10-minute timer. Your Challonge API key stays on the server.

## Put it online (once)

You need a free Cloudflare account: <https://dash.cloudflare.com/sign-up>.

1. **Connect this repository.** In the Cloudflare dashboard go to **Workers & Pages → Create → Import a
   repository**, connect GitHub, pick **tourney-logs**, keep the suggested settings (deploy command
   `npx wrangler deploy`) and click **Deploy**. The database is created automatically on this first deploy.
2. **Add the secrets.** Open the new **tourney-logs** Worker → **Settings → Variables and Secrets** and add
   these as **Secret** (encrypted):

   | Name | Value |
   |---|---|
   | `CHALLONGE_USERNAME` | your Challonge username |
   | `CHALLONGE_API_KEY` | your Challonge API key (challonge.com → Settings → Developer API) |
   | `ADMIN_PASSWORD` | a password you choose, for logging in to edit |
   | `ADMIN_TOKEN` | *(optional)* a long random string, so scripts or Claude can update things for you |

3. **Open the site** at the address shown on the Worker's page, like
   `https://tourney-logs.<your-name>.workers.dev`. The tournaments and decks from Match Book are already
   there. To edit, open the site with `/#login` on the end (there is no login button on the page).

From then on, every change pushed to the `main` branch goes live by itself in a minute or two.

**If the first deploy fails with a database error:** in the dashboard go to **Storage & Databases → D1 →
Create**, name it `tourney-logs`, then put its *Database ID* in `wrangler.jsonc` as
`"database_id": "…"` next to `"database_name"` (or tell Claude the ID) and deploy again.

## Using it

- **Add a tournament:** log in → **Add tournament** → paste the Challonge link. It's read straight away.
- **Updates:** ongoing tournaments refresh every 10 minutes. On a tournament page, **Refresh from
  Challonge** updates it right now. A tournament counts as finished once every match that has to be played
  is done; finished ones stop refreshing (and so do ones nothing has changed in for 14 days).
- **Your edits are kept:** notes and links always survive a refresh, and so does any match you edited by
  hand (it keeps your score instead of Challonge's).
- **Decks:** open a finished tournament → **Decks** → tap a player's name.

**Challonge API use:** one request per tournament per refresh, only while it's ongoing: at most 6 an hour
per tournament, and none between events. To refresh less often, change `"*/10 * * * *"` in
`wrangler.jsonc` (for example `"*/30 * * * *"` for every 30 minutes).

## Backups

Logged in as admin, open `/api/backup` to download everything (except images) as one JSON file.

## Working on it

```sh
npm install
npm test                # importer tests
cp .dev.vars.example .dev.vars   # then fill in test values
npm run dev             # http://localhost:8787 (local database; trigger the timer at /__scheduled)
```
