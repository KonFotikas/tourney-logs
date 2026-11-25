// Tourney Logs server: a Cloudflare Worker that serves the site (from /public), keeps tournaments,
// matches, decks and decklist images in D1 (free, no card needed), and refreshes ongoing tournaments from Challonge on a
// timer. The Challonge key and the admin password live in Worker secrets and never reach the browser.
import { buildFromChallonge, challongeSlug } from "./importer.js";
import { isDue } from "./schedule.js";
import seed from "../data/seed.json";

// ---------- database ----------
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS tournaments (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS matches (tournament_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tournament_id, id))",
  "CREATE TABLE IF NOT EXISTS decks (tournament_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tournament_id, id))",
  "CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT)",
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)",
];
let ready = null;
// Tables are created on first use, and the data brought over from Match Book is loaded once.
function ensureDb(env) {
  if (!ready) {
    ready = (async () => {
      await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
      const seeded = await env.DB.prepare("SELECT v FROM meta WHERE k = 'seeded'").first();
      if (!seeded) {
        await loadBackup(env, seed);
        await env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('seeded', ?)").bind(new Date().toISOString()).run();
      }
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

// Backup format: { tournaments: [{ id, data, matches: [{ id, data }], decks: [{ id, data }] }] }.
// Never overwrites: rows that already exist are left alone.
async function loadBackup(env, backup) {
  const stmts = [];
  for (const t of backup.tournaments || []) {
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO tournaments (id, data) VALUES (?, ?)").bind(t.id, JSON.stringify(t.data)));
    for (const m of t.matches || []) stmts.push(env.DB.prepare("INSERT OR IGNORE INTO matches (tournament_id, id, data) VALUES (?, ?, ?)").bind(t.id, m.id, JSON.stringify(m.data)));
    for (const d of t.decks || []) {
      const data = { ...d.data };
      // A decklist image shipped with the site (public/seed-images) is copied into image storage once.
      if (data.seedImage && IMG.test(data.imageId || "")) {
        try {
          const res = await env.ASSETS.fetch(new Request(new URL(data.seedImage, "https://assets.invalid")));
          if (res.ok) await putImage(env, data.imageId, res.headers.get("content-type") || "image/png", await res.arrayBuffer(), true);
        } catch (e) { console.error("seed image", e); }
      }
      delete data.seedImage;
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO decks (tournament_id, id, data) VALUES (?, ?, ?)").bind(t.id, d.id, JSON.stringify(data)));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

// Images: one row each. D1 rows are capped at about 2 MB; the page shrinks photos well below that.
const MAX_IMAGE = 1_900_000;
async function putImage(env, id, type, buf, keepExisting = false) {
  await env.DB.prepare(`INSERT OR ${keepExisting ? "IGNORE" : "REPLACE"} INTO images (id, type, data, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, type, buf, new Date().toISOString()).run();
}
const deleteImages = (env, ids) => ids.length ? env.DB.batch(ids.map(id => env.DB.prepare("DELETE FROM images WHERE id = ?").bind(id))) : null;

const rowsToDocs = (rows) => rows.results.map(r => ({ id: r.id, ...JSON.parse(r.data) }));
async function getTournament(env, id) {
  const row = await env.DB.prepare("SELECT data FROM tournaments WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.data) : null;
}
const isDone = (t) => t.challongeState === "complete" || !!(t.counts && t.counts.total > 0 && t.counts.done >= t.counts.total);

// ---------- Challonge ----------
async function fetchChallonge(env, slug) {
  if (!env.CHALLONGE_USERNAME || !env.CHALLONGE_API_KEY) throw httpError(500, "The Challonge username or API key isn't set on the server yet.");
  const base = env.CHALLONGE_API_BASE || "https://api.challonge.com/v1";
  const res = await fetch(`${base}/tournaments/${encodeURIComponent(slug)}.json?include_participants=1&include_matches=1`, {
    headers: { authorization: "Basic " + btoa(`${env.CHALLONGE_USERNAME}:${env.CHALLONGE_API_KEY}`), "user-agent": "tourney-logs", accept: "application/json" },
  });
  if (res.status === 404) throw httpError(404, "Challonge has no tournament at that link, or your API key can't see it.");
  if (res.status === 401 || res.status === 403) throw httpError(502, "Challonge refused the API key. Check the CHALLONGE_USERNAME and CHALLONGE_API_KEY secrets.");
  if (res.status === 429) throw httpError(503, "Challonge says too many requests. Try again later.");
  if (!res.ok) throw httpError(502, `Challonge answered with an error (${res.status}).`);
  return res.json();
}

// Same content, ignoring updatedAt and the order fields happen to be stored in.
const stable = (v) => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]"
  : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter(k => k !== "updatedAt").map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"
  : JSON.stringify(v ?? null);
const sameDoc = (a, b) => stable(a) === stable(b);

// Imports (or re-imports) one tournament. Hand edits are kept (see importer.js); only changed rows are written.
async function syncTournament(env, id, sourceUrl) {
  const old = await getTournament(env, id);
  const api = await fetchChallonge(env, id);
  const rows = await env.DB.prepare("SELECT id, data FROM matches WHERE tournament_id = ?").bind(id).all();
  const existing = new Map(rows.results.map(r => [r.id, JSON.parse(r.data)]));
  const { tournament, matches } = buildFromChallonge(api, { slug: id, sourceUrl: sourceUrl || old?.sourceUrl || `https://challonge.com/${id}`, existing, oldTournament: old });
  const changed = matches.filter(m => !existing.has(m.id) || !sameDoc(existing.get(m.id), m.data));
  tournament.lastChangeAt = changed.length || !old ? tournament.syncedAt : (old.lastChangeAt || old.updatedAt || tournament.syncedAt);
  delete tournament.lastSyncError;
  const stmts = [env.DB.prepare("INSERT OR REPLACE INTO tournaments (id, data) VALUES (?, ?)").bind(id, JSON.stringify(tournament))];
  for (const m of changed) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO matches (tournament_id, id, data) VALUES (?, ?, ?)").bind(id, m.id, JSON.stringify(m.data)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { id, changed: changed.length, tournament };
}

// Timer: check ongoing tournaments that are due (see schedule.js: often while results are coming in,
// rarely when it's quiet). Finished ones are left alone, and so are ones nothing has changed in for
// STALE_DAYS; the Refresh button still works for those. `force` checks every ongoing one now.
async function syncOngoing(env, { force = false } = {}) {
  await ensureDb(env);
  const staleDays = Number(env.STALE_DAYS || 60);
  const rows = await env.DB.prepare("SELECT id, data FROM tournaments").all();
  const out = [];
  for (const r of rows.results) {
    const t = JSON.parse(r.data);
    if (isDone(t) || t.autoSync === false) continue;
    if (!force && !isDue(t, { staleDays })) continue;
    try { out.push(await syncTournament(env, r.id)); }
    catch (e) {
      t.lastSyncError = String(e.message || e).slice(0, 300); t.syncedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE tournaments SET data = ? WHERE id = ?").bind(JSON.stringify(t), r.id).run();
      out.push({ id: r.id, error: t.lastSyncError });
    }
  }
  return out;
}

// ---------- auth ----------
// One admin, signed in with ADMIN_PASSWORD (a secret). The session is a signed cookie. ADMIN_TOKEN (an
// optional secret) lets scripts or Claude call the API with "Authorization: Bearer <token>".
const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)))].map(b => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const COOKIE = "tl_admin", SESSION_DAYS = 30;
async function sessionCookie(env) {
  const exp = Date.now() + SESSION_DAYS * 86400e3;
  return `${COOKIE}=${exp}.${await hmac(env.ADMIN_PASSWORD, "session:" + exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
function readCookie(req, name) {
  for (const part of (req.headers.get("cookie") || "").split(/;\s*/)) { const i = part.indexOf("="); if (part.slice(0, i) === name) return part.slice(i + 1); }
  return "";
}
async function authOf(req, env) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") || "");
  if (bearer && env.ADMIN_TOKEN) return (safeEqual(await hmac("t", bearer[1]), await hmac("t", env.ADMIN_TOKEN))) ? "token" : null;
  if (!env.ADMIN_PASSWORD) return null;
  const [exp, sig] = readCookie(req, COOKIE).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return null;
  return safeEqual(sig, await hmac(env.ADMIN_PASSWORD, "session:" + exp)) ? "cookie" : null;
}
async function requireAdmin(req, env) {
  const how = await authOf(req, env);
  if (!how) throw httpError(401, "Log in as admin to change things.");
  // Cookie sessions must also send this header, which other sites can't add to a request (CSRF guard).
  if (how === "cookie" && req.method !== "GET" && req.headers.get("x-tl") !== "1") throw httpError(403, "Missing request header.");
}

// ---------- http ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
async function body(req, max = 256 * 1024) {
  const text = await req.text();
  if (text.length > max) throw httpError(413, "Too much data.");
  try { const v = JSON.parse(text); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
  throw httpError(400, "Expected a JSON object.");
}
const ID = "[A-Za-z0-9_-]{1,120}";
const IMG = /^[a-f0-9]{32}$/;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  let r;

  if (p === "/api/me" && m === "GET") return json({ admin: !!(await authOf(req, env)), loginEnabled: !!env.ADMIN_PASSWORD });
  if (p === "/api/login" && m === "POST") {
    const { password } = await body(req, 4096);
    if (!env.ADMIN_PASSWORD) throw httpError(503, "No admin password is set on the server yet.");
    if (typeof password !== "string" || !safeEqual(await hmac("p", password), await hmac("p", env.ADMIN_PASSWORD))) {
      await new Promise(res => setTimeout(res, 800));   // slow down guessing
      throw httpError(401, "Wrong password.");
    }
    return json({ admin: true }, 200, { "set-cookie": await sessionCookie(env) });
  }
  if (p === "/api/logout" && m === "POST") return json({ admin: false }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });

  await ensureDb(env);

  if (p === "/api/tournaments" && m === "GET") {
    return json(rowsToDocs(await env.DB.prepare("SELECT id, data FROM tournaments").all()));
  }
  if (p === "/api/tournaments" && m === "POST") {
    await requireAdmin(req, env);
    const { url: link } = await body(req, 4096);
    const slug = challongeSlug(String(link || ""));
    if (!slug) throw httpError(400, "That doesn't look like a Challonge bracket link. It should look like https://challonge.com/your_bracket.");
    if (await getTournament(env, slug)) throw httpError(409, "That tournament is already here.");
    const res = await syncTournament(env, slug, String(link));
    return json({ id: slug, tournament: res.tournament }, 201);
  }
  if ((r = new RegExp(`^/api/tournaments/(${ID})$`).exec(p))) {
    const tid = r[1];
    if (m === "GET") {
      const t = await getTournament(env, tid);
      if (!t) throw httpError(404, "No such tournament.");
      const [ms, ds] = await Promise.all([
        env.DB.prepare("SELECT id, data FROM matches WHERE tournament_id = ?").bind(tid).all(),
        env.DB.prepare("SELECT id, data FROM decks WHERE tournament_id = ?").bind(tid).all()]);
      return json({ tournament: { id: tid, ...t }, matches: rowsToDocs(ms), decks: rowsToDocs(ds) });
    }
    if (m === "PATCH") {
      await requireAdmin(req, env);
      const t = await getTournament(env, tid);
      if (!t) throw httpError(404, "No such tournament.");
      const patch = await body(req, 16 * 1024);
      if (patch.counts && typeof patch.counts === "object") t.counts = { total: +patch.counts.total || 0, live: +patch.counts.live || 0, done: +patch.counts.done || 0 };
      if (typeof patch.notes === "string") t.notes = patch.notes.slice(0, 8000);
      if (typeof patch.autoSync === "boolean") t.autoSync = patch.autoSync;
      t.updatedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE tournaments SET data = ? WHERE id = ?").bind(JSON.stringify(t), tid).run();
      return json({ id: tid, ...t });
    }
    if (m === "DELETE") {
      await requireAdmin(req, env);
      const ds = await env.DB.prepare("SELECT data FROM decks WHERE tournament_id = ?").bind(tid).all();
      const imgs = ds.results.map(x => JSON.parse(x.data).imageId).filter(x => IMG.test(x || ""));
      await env.DB.batch([
        env.DB.prepare("DELETE FROM matches WHERE tournament_id = ?").bind(tid),
        env.DB.prepare("DELETE FROM decks WHERE tournament_id = ?").bind(tid),
        env.DB.prepare("DELETE FROM tournaments WHERE id = ?").bind(tid)]);
      await deleteImages(env, imgs);
      return json({ deleted: true });
    }
  }
  if ((r = new RegExp(`^/api/tournaments/(${ID})/refresh$`).exec(p)) && m === "POST") {
    await requireAdmin(req, env);
    if (!(await getTournament(env, r[1]))) throw httpError(404, "No such tournament.");
    const res = await syncTournament(env, r[1]);
    return json({ id: r[1], changed: res.changed });
  }
  if ((r = new RegExp(`^/api/tournaments/(${ID})/(matches|decks)/(${ID})$`).exec(p)) && m === "PUT") {
    await requireAdmin(req, env);
    const [, tid, kind, id] = r;
    if (!(await getTournament(env, tid))) throw httpError(404, "No such tournament.");
    const doc = await body(req, 64 * 1024);
    delete doc.id;
    await env.DB.prepare(`INSERT OR REPLACE INTO ${kind} (tournament_id, id, data) VALUES (?, ?, ?)`).bind(tid, id, JSON.stringify(doc)).run();
    return json({ id, ...doc });
  }
  if (p === "/api/images" && m === "POST") {
    await requireAdmin(req, env);
    const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw httpError(415, "Images must be PNG, JPG, WebP or GIF.");
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) throw httpError(400, "The image is empty.");
    if (buf.byteLength > MAX_IMAGE) throw httpError(413, "That image is too big (about 1.9 MB max after shrinking). Try a smaller screenshot.");
    const id = crypto.randomUUID().replace(/-/g, "");
    await putImage(env, id, type, buf);
    return json({ id, url: "/img/" + id }, 201);
  }
  if ((r = /^\/api\/images\/([a-f0-9]{32})$/.exec(p)) && m === "DELETE") {
    await requireAdmin(req, env);
    await deleteImages(env, [r[1]]);
    return json({ deleted: true });
  }
  if (p === "/api/sync" && m === "POST") {      // run the timer's refresh now
    await requireAdmin(req, env);
    return json({ results: await syncOngoing(env, { force: true }) });
  }
  if (p === "/api/backup" && m === "GET") {     // everything except images, as one JSON file
    await requireAdmin(req, env);
    const ts = await env.DB.prepare("SELECT id, data FROM tournaments").all();
    const out = { exportedAt: new Date().toISOString(), tournaments: [] };
    for (const t of ts.results) {
      const [ms, ds] = await Promise.all([
        env.DB.prepare("SELECT id, data FROM matches WHERE tournament_id = ?").bind(t.id).all(),
        env.DB.prepare("SELECT id, data FROM decks WHERE tournament_id = ?").bind(t.id).all()]);
      out.tournaments.push({ id: t.id, data: JSON.parse(t.data),
        matches: ms.results.map(x => ({ id: x.id, data: JSON.parse(x.data) })), decks: ds.results.map(x => ({ id: x.id, data: JSON.parse(x.data) })) });
    }
    return json(out, 200, { "content-disposition": `attachment; filename="tourney-logs-backup.json"` });
  }
  throw httpError(404, "Not found.");
}

async function image(env, id) {
  if (!IMG.test(id)) return new Response("Not found", { status: 404 });
  await ensureDb(env);
  const row = await env.DB.prepare("SELECT type, data FROM images WHERE id = ?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });
  const type = row.type;
  return new Response(new Uint8Array(row.data), {
    headers: {
      "content-type": IMAGE_TYPES.includes(type) ? type : "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, env, url);
      if (url.pathname.startsWith("/img/")) return await image(env, url.pathname.slice(5));
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (!e.status) console.error(e);
      return json({ error: e.status ? e.message : "Something went wrong on the server." }, e.status || 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncOngoing(env).then(r => console.log("sync", JSON.stringify(r))));
  },
};
