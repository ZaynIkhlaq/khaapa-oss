import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { newToken, SESSION_COOKIE, SESSION_HOURS } from "./auth";
import { registerMcp } from "./mcp";
import type { Item, User, Stats, StatsHistory, Scope, Preorder, PreorderLine, PreorderSettings, Slot, SlotSwap, ShiftRequest } from "../shared/types";
import { CATEGORIES, isExtraItem, parsePrice, round2, SHIFT_MINUTES, PICK_CAP, PICK_DAYS, PICK_TIMES, PICKS_MIN, pickMinutesFor, discountFor, hasScope, preorderCode, SCOPES } from "../shared/types";
import { encrypt, parsePayment, syncPayments } from "./gmail";
import { buildReport, pkToday as reportToday, REPORT_AT, storeDailyReport } from "./report";

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_EMAIL_DOMAIN: string;
  OWNER_EMAIL: string;
  TOKEN_KEY: string;
  PAYMENT_EMAIL_QUERY: string;
  // Your custom domain (e.g. shop.example.com); sign-ins started on *.workers.dev are sent there. Optional.
  CANONICAL_HOST?: string;
  // Set only by agentRequest() for an /mcp write tool; never present on a real request.
  AGENT_USER?: User;
  // Per-IP rate limit for public endpoints (wrangler.jsonc "ratelimits"); missing in local dev.
  PUBLIC_LIMIT?: RateLimit;
}

type Vars = { user: User; sessionId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------- helpers ----------
const nowIso = () => new Date().toISOString();
// Today in Pakistan time (UTC+5), YYYY-MM-DD.
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

async function log(db: D1Database, userId: number | null, action: string, entity?: string, entityId?: number, details?: unknown) {
  await db
    .prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)")
    .bind(userId, action, entity ?? null, entityId ?? null, details === undefined ? null : JSON.stringify(details))
    .run();
}

const bad = (msg: string, status = 400) => Response.json({ error: msg }, { status });

const int = (v: unknown, fallback?: number): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n === "number" && Number.isFinite(n)) return Math.trunc(n);
  if (fallback !== undefined) return fallback;
  throw new Error("Expected a number");
};

// ---------- security headers / cross-site writes ----------
// Every Worker response: no sniffing (an upload can't turn into a page), no framing, and no leaking token links
// through Referer. Static assets get the same from public/_headers.
app.use("*", async (c, next) => {
  // Browser writes must come from our own pages. SameSite=Lax still sends the session cookie from any other
  // subdomain of the same site, so check where the request came from. /mcp and /oauth/token|register are
  // called cross-origin by design (bearer tokens / PKCE, no cookies).
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS" && !c.env.AGENT_USER) {
    const url = new URL(c.req.url);
    const cookieWrite = url.pathname.startsWith("/api/") || url.pathname === "/oauth/authorize";
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    if (cookieWrite && ((origin && origin !== url.origin) || (site && site !== "same-origin" && site !== "none"))) return bad("Cross-site request refused", 403);
  }
  await next();
  c.res = new Response(c.res.body, c.res);
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "same-origin");
  if (!c.res.headers.has("X-Frame-Options")) c.res.headers.set("X-Frame-Options", "DENY");
});

// Per-IP limits on the public endpoints (Workers rate limiting binding; absent in local dev). Keys share one counter
// per bucket, so campus NAT gets the whole limit together: keep them generous.
async function limited(c: any, bucket: string): Promise<boolean> {
  const limiter = c.env.PUBLIC_LIMIT as RateLimit | undefined;
  if (!limiter) return false;
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
  return !success;
}
const slowDown = () => bad("Too many requests. Wait a minute and try again.", 429);

// ---------- auth middleware ----------
const USER_COLS = "u.id, u.username, u.name, u.email, u.picture, u.role, u.active, u.approved, u.is_hr, u.mcp_write, u.scopes, u.created_at";
function toUser(env: Env, row: Omit<User, "scopes"> & { scopes: string }): User {
  const user: User = { ...row, scopes: parseScopes(row.scopes) };
  // The owner is always admin and HR.
  if (isOwner(env, user.email)) { user.scopes = ["admin", "hr"]; user.mcp_write = 1; }
  user.is_hr = user.scopes.includes("hr") ? 1 : 0;
  return user;
}
// The signed-in user for a session cookie, or null if the session is gone, expired or the account disabled.
async function sessionUser(env: Env, token: string): Promise<User | null> {
  const row = await env.DB.prepare(`SELECT ${USER_COLS}, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`)
    .bind(token).first<Omit<User, "scopes"> & { scopes: string; expires_at: string }>();
  if (!row || row.expires_at < nowIso() || !row.active) return null;
  const { expires_at: _e, ...rest } = row;
  return toUser(env, rest);
}
async function userById(env: Env, id: number): Promise<User | null> {
  const row = await env.DB.prepare(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`).bind(id).first<Omit<User, "scopes"> & { scopes: string }>();
  return row && row.active ? toUser(env, row) : null;
}
const authed = app.use("/api/*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const open = ["/api/public/", "/api/img/", "/api/auth/", "/api/gmail/", "/api/health"];
  if (open.some((p) => path.startsWith(p))) return next();

  // A write tool on /mcp calling the same route a button would (agentRequest below). The person rides in on the env
  // object, which only this Worker can construct, so it can't be forged from outside; /mcp already checked them.
  if (c.env.AGENT_USER) {
    c.set("user", c.env.AGENT_USER);
    c.set("sessionId", "");
    return next();
  }
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return bad("Not signed in", 401);
  const user = await sessionUser(c.env, token);
  if (!user) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return bad("Session expired", 401);
  }
  c.set("user", user);
  c.set("sessionId", token);
  // Signed in but not yet approved by an admin: may only see who they are and sign out.
  if (!user.approved && path !== "/api/me" && path !== "/api/logout") return bad("Your account is waiting for admin approval", 403);
  return next();
});

// Double taps: the same change (same person, method, address and contents) twice within DEDUPE_MS is refused, so a
// slow save plus a few more taps can't restock or sell the same thing three times (Slanty, 2026-10-08). The site also
// holds back identical requests while one is in flight (src/api.ts); this catches the rest (other tabs, retries,
// agents). Claiming the key is one atomic statement, so requests milliseconds apart can't both get through. A change
// that fails releases its key, so fixing the problem and trying again works at once.
const DEDUPE_MS = 3000;
app.use("/api/*", async (c, next) => {
  const user = c.get("user");
  if (!user || c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const body = await c.req.raw.clone().arrayBuffer();
  const raw = new Uint8Array([...new TextEncoder().encode(`${user.id} ${c.req.method} ${new URL(c.req.url).pathname} `), ...new Uint8Array(body)]);
  const key = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)), (b) => b.toString(16).padStart(2, "0")).join("");
  const now = new Date();
  const claim = await c.env.DB.prepare(
    "INSERT INTO request_locks (key, created_at) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET created_at = ?2 WHERE request_locks.created_at < ?3",
  ).bind(key, now.toISOString(), new Date(now.getTime() - DEDUPE_MS).toISOString()).run();
  if (!claim.meta.changes) return bad("That was already saved: a double tap, so it only went through once.", 409);
  await next();
  if (!c.res.ok) await c.env.DB.prepare("DELETE FROM request_locks WHERE key = ? AND created_at = ?").bind(key, now.toISOString()).run();
});

const SCOPE_KEYS = SCOPES.map((s) => s.key);
const parseScopes = (raw: string | null | undefined): Scope[] => (raw ?? "").split(",").filter((s): s is Scope => SCOPE_KEYS.includes(s as Scope));
const isOwner = (env: Env, email: string | null | undefined) => (email ?? "").toLowerCase() === env.OWNER_EMAIL.toLowerCase();

// Allows admins and anyone holding the scope.
const need = (scope: Scope) => async (c: any, next: any) => {
  if (!hasScope(c.get("user"), scope)) return bad(`Needs the ${SCOPES.find((s) => s.key === scope)!.label} scope`, 403);
  return next();
};

const adminOnly = async (c: any, next: any) => {
  if (c.get("user")?.role !== "admin") return bad("Admins only", 403);
  return next();
};

// Shifts close themselves SHIFT_MINUTES after they start (ended_at = start + SHIFT_MINUTES), so nobody stays "on the
// counter" by forgetting to tap End shift. Run before anything reads open shifts, and from the minute cron.
async function closeExpiredShifts(db: D1Database) {
  const expired = await db.prepare(`SELECT id, user_id FROM shifts WHERE ended_at IS NULL AND started_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${SHIFT_MINUTES} minutes')`).all<{ id: number; user_id: number }>();
  if (!expired.results.length) return;
  await db.batch(expired.results.flatMap((s) => [
    db.prepare(`UPDATE shifts SET ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '+${SHIFT_MINUTES} minutes'), note = COALESCE(note, 'Ended automatically after ${SHIFT_MINUTES} min') WHERE id = ? AND ended_at IS NULL`).bind(s.id),
    db.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?, 'shift_end', 'shift', ?, ?)").bind(s.user_id, s.id, JSON.stringify({ auto: true })),
  ]));
}

// Working the shop (sell, void, menu items, stock, buy price, payments, pre-orders) needs an open shift, so every action is
// tied to someone who took responsibility for the counter. Admins can act without one.
const onShift = async (c: any, next: any) => {
  const user = c.get("user");
  if (hasScope(user, "admin")) return next();
  await closeExpiredShifts(c.env.DB);
  const open = await c.env.DB.prepare("SELECT 1 FROM shifts WHERE user_id = ? AND ended_at IS NULL LIMIT 1").bind(user.id).first();
  if (!open) return bad("Start your shift first", 403);
  return next();
};

// HR and admins see attendance.
const attendanceAccess = async (c: any, next: any) => {
  const user = c.get("user");
  if (!user?.is_hr && user?.role !== "admin") return bad("HR only", 403);
  return next();
};


// ---------- health / Google sign-in ----------
app.get("/api/health", (c) => c.json({ ok: true }));

const STATE_COOKIE = "khaapa_oauth";
const NEXT_COOKIE = "khaapa_next";
const redirectUri = (c: any) => `${new URL(c.req.url).origin}/api/auth/google/callback`;
const loginFail = (c: any, reason: string) => c.redirect(`/login?error=${encodeURIComponent(reason)}`);
// A same-site path to return to after sign-in. Browsers read "/\\x" as "//x" and drop tabs/newlines ("/\t/x"), so
// anything with a backslash, whitespace or control character is refused, not just "//".
const safeNext = (n: string | undefined | null) => (n && /^\/(?![/\\])[^\\\s\x00-\x1f]*$/.test(n) ? n : null);

// Google only accepts our own domain as the return address. If someone opened the site on Cloudflare's backup
// address (*.workers.dev), send the sign-in over to CANONICAL_HOST (your custom domain, a wrangler var) first so it
// doesn't fail with redirect_uri_mismatch; they end up signed in on the real domain. Leave it empty to skip.

app.get("/api/auth/google", async (c) => {
  if (await limited(c, "login")) return slowDown();
  const here = new URL(c.req.url);
  if (c.env.CANONICAL_HOST && here.hostname.endsWith(".workers.dev")) {
    here.hostname = c.env.CANONICAL_HOST;
    here.protocol = "https:";
    here.port = "";
    return c.redirect(here.toString());
  }
  const state = newToken();
  setCookie(c, STATE_COOKIE, state, { path: "/api/auth", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 });
  // Optional same-site path to return to after sign-in (the MCP approval page uses this).
  const next = c.req.query("next");
  if (next && safeNext(next)) setCookie(c, NEXT_COOKIE, next, { path: "/api/auth", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", redirectUri(c));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("hd", c.env.ALLOWED_EMAIL_DOMAIN);
  u.searchParams.set("prompt", "select_account");
  return c.redirect(u.toString());
});

app.get("/api/auth/google/callback", async (c) => {
  const q = c.req.query();
  const expected = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/auth" });
  if (q.error) return loginFail(c, "Google sign-in was cancelled");
  if (!q.code || !q.state || q.state !== expected) return loginFail(c, "Sign-in session expired, try again");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: q.code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status, await tokenRes.text());
    return loginFail(c, "Google rejected the sign-in");
  }
  const tok = await tokenRes.json<{ id_token?: string }>();
  if (!tok.id_token) return loginFail(c, "Google returned no identity");

  // The ID token came straight from Google's token endpoint over TLS, so its claims can be
  // trusted without re-verifying the signature; we still check audience and issuer.
  let claims: any;
  try {
    const payload = tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(payload));
  } catch {
    return loginFail(c, "Bad identity token");
  }
  if (claims.aud !== c.env.GOOGLE_CLIENT_ID || !["https://accounts.google.com", "accounts.google.com"].includes(claims.iss)) {
    return loginFail(c, "Identity token mismatch");
  }
  const email = String(claims.email ?? "").toLowerCase();
  const domain = c.env.ALLOWED_EMAIL_DOMAIN.toLowerCase();
  if (!claims.email_verified || !email.endsWith("@" + domain)) {
    return loginFail(c, `Use your @${domain} Google account`);
  }

  const db = c.env.DB;
  let user = await db.prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?").bind(claims.sub, email).first<User & { google_sub: string | null }>();
  const name = String(claims.name || claims.given_name || email.split("@")[0]).trim();
  const picture = claims.picture ? String(claims.picture) : null;

  const isOwner = email === c.env.OWNER_EMAIL.toLowerCase();
  if (!user) {
    // Only the owner is admin by default; everyone else joins as staff and must be promoted.
    const role = isOwner ? "admin" : "staff";
    let username = email.split("@")[0];
    const taken = await db.prepare("SELECT 1 FROM users WHERE username = ?").bind(username).first();
    if (taken) username = `${username}-${claims.sub.slice(-4)}`;
    const res = await db
      .prepare("INSERT INTO users (username, name, email, google_sub, picture, password_hash, role, approved, scopes, is_hr) VALUES (?,?,?,?,?,'',?,?,?,?)")
      .bind(username, name, email, claims.sub, picture, role, isOwner ? 1 : 0, isOwner ? "admin,hr" : "", isOwner ? 1 : 0)
      .run();
    const id = res.meta.last_row_id as number;
    await log(db, id, "user_join", "user", id, { email, role });
    user = (await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User & { google_sub: string | null }>())!;
  } else {
    if (!user.active) return loginFail(c, "Your account has been disabled. Ask an admin.");
    await db.prepare("UPDATE users SET google_sub = ?, email = ?, picture = ?, role = CASE WHEN ? THEN 'admin' ELSE role END, active = CASE WHEN ? THEN 1 ELSE active END, approved = CASE WHEN ? THEN 1 ELSE approved END WHERE id = ?")
      .bind(claims.sub, email, picture, isOwner ? 1 : 0, isOwner ? 1 : 0, isOwner ? 1 : 0, user.id).run();
  }

  const token = newToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600_000);
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)").bind(token, user.id, expires.toISOString()).run();
  setCookie(c, SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", expires });
  await log(db, user.id, "login");
  const next = getCookie(c, NEXT_COOKIE);
  deleteCookie(c, NEXT_COOKIE, { path: "/api/auth" });
  return c.redirect(safeNext(next) ?? "/pos");
});

app.post("/api/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(c.get("sessionId")).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  if (!user.approved) return c.json({ user, shift: null, on_counter: [] });
  await closeExpiredShifts(c.env.DB);
  const shift = await c.env.DB.prepare("SELECT * FROM shifts WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").bind(user.id).first();
  const counter = await c.env.DB.prepare(
    "SELECT s.id, s.started_at, u.name AS user_name, u.id AS user_id FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.ended_at IS NULL ORDER BY s.started_at ASC",
  ).all();
  return c.json({ user, shift: shift ?? null, on_counter: counter.results });
});

// ---------- public ----------
app.get("/api/public/items", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, name, category, price, image_key, stock, low_stock_at FROM items WHERE visible = 1 AND archived = 0 ORDER BY category, sort_order, name",
  ).all<Item>();
  const items = rows.results.map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    price: i.price,
    image_key: i.image_key,
    availability: i.stock <= 0 ? "out" : i.stock <= i.low_stock_at ? "low" : "in",
  }));
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM shifts WHERE ended_at IS NULL").first<{ n: number }>();
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ items, open: (open?.n ?? 0) > 0 });
});

// ---------- pre-orders ----------
// Customers pick items, pay on NayaPay or SadaPay and send the screenshot on WhatsApp. A person checks it and marks the order
// paid; collecting it records a normal sale. Nothing here verifies money automatically.
const SETTING_KEYS = ["nayapay_number", "nayapay_name", "sadapay_number", "sadapay_name", "whatsapp"] as const;
const pkDate = (offsetDays = 0) => new Date(Date.now() + 5 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

async function readSettings(db: D1Database): Promise<PreorderSettings> {
  const rows = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return {
    nayapay_number: map.nayapay_number ?? "",
    nayapay_name: map.nayapay_name ?? "",
    sadapay_number: map.sadapay_number ?? "",
    sadapay_name: map.sadapay_name ?? "",
    whatsapp: map.whatsapp ?? "",
  };
}

app.get("/api/public/preorder", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, name, category, price, image_key FROM items WHERE preorder = 1 AND archived = 0 ORDER BY category, sort_order, name").all();
  return c.json({ items: rows.results, settings: await readSettings(c.env.DB), today: pkDate(), tomorrow: pkDate(1) });
});

app.post("/api/public/preorders", async (c) => {
  if (await limited(c, "preorder")) return slowDown();
  const body = await c.req.json<{ name?: string; phone?: string; pickup?: string; note?: string; items?: { item_id: number; qty: number }[] }>().catch(() => null);
  if (!body) return bad("Bad request");
  const name = (body.name ?? "").trim().slice(0, 80);
  const phone = (body.phone ?? "").replace(/[^\d+]/g, "").slice(0, 16);
  if (!name) return bad("Please enter your name");
  if (phone.replace(/\D/g, "").length < 10) return bad("Please enter a valid phone number");
  const pickup_on = body.pickup === "tomorrow" ? pkDate(1) : pkDate();
  const wanted = (body.items ?? []).map((l) => ({ id: int(l.item_id), qty: int(l.qty) })).filter((l) => l.qty > 0);
  if (wanted.length === 0) return bad("Pick at least one item");
  if (wanted.length > 20 || wanted.some((l) => l.qty > 50)) return bad("That's a big order. Message us on WhatsApp instead.");
  const ids = [...new Set(wanted.map((l) => l.id))];
  const rows = await c.env.DB.prepare(`SELECT id, name, price FROM items WHERE preorder = 1 AND archived = 0 AND id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; name: string; price: number }>();
  const byId = new Map(rows.results.map((i) => [i.id, i]));
  const lines = new Map<number, { id: number; name: string; price: number; qty: number }>();
  for (const l of wanted) {
    const item = byId.get(l.id);
    if (!item) return bad("One of those items can't be pre-ordered any more. Refresh the page.");
    const line = lines.get(item.id);
    if (line) line.qty += l.qty;
    else lines.set(item.id, { ...item, qty: l.qty });
  }
  // Light spam guard: a phone can only have a few unpaid orders open at once.
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM preorders WHERE phone = ? AND status = 'new'").bind(phone).first<{ n: number }>();
  if ((open?.n ?? 0) >= 3) return bad("You already have 3 unpaid orders. Pay for those or message us on WhatsApp.");
  const total = round2([...lines.values()].reduce((s, l) => s + l.price * l.qty, 0));
  const note = (body.note ?? "").trim().slice(0, 300) || null;
  const token = newToken();
  const res = await c.env.DB.prepare("INSERT INTO preorders (name, phone, pickup_on, note, total, token) VALUES (?,?,?,?,?,?)").bind(name, phone, pickup_on, note, total, token).run();
  const id = res.meta.last_row_id as number;
  await c.env.DB.batch([
    ...[...lines.values()].map((l) => c.env.DB.prepare("INSERT INTO preorder_items (preorder_id, item_id, name, unit_price, qty) VALUES (?,?,?,?,?)").bind(id, l.id, l.name, l.price, l.qty)),
    c.env.DB.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (NULL,'preorder_create','preorder',?,?)")
      .bind(id, JSON.stringify({ name, total, lines: [...lines.values()].map((l) => `${l.qty}× ${l.name}`) })),
  ]);
  return c.json({ order: { id, token, code: preorderCode(id), total, pickup_on, lines: [...lines.values()].map((l) => ({ name: l.name, qty: l.qty, unit_price: l.price })) } });
});

app.get("/api/preorders", async (c) => {
  const status = c.req.query("status");
  const where = status && ["new", "paid", "collected", "cancelled"].includes(status) ? "WHERE p.status = ?" : "";
  const rows = await c.env.DB.prepare(
    `SELECT p.*, u.name AS handled_by_name FROM preorders p LEFT JOIN users u ON u.id = p.handled_by ${where} ORDER BY p.pickup_on DESC, p.id DESC LIMIT 300`,
  ).bind(...(where ? [status] : [])).all<Preorder>();
  const ids = rows.results.map((p) => p.id);
  const lines = ids.length
    ? (await c.env.DB.prepare(`SELECT * FROM preorder_items WHERE preorder_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<PreorderLine>()).results
    : [];
  const counts = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM preorders GROUP BY status").all<{ status: string; n: number }>();
  return c.json({
    orders: rows.results.map(({ token: _t, proof_key, ...p }) => ({ ...p, has_proof: !!proof_key, code: preorderCode(p.id), lines: lines.filter((l) => l.preorder_id === p.id) })),
    counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])),
    settings: await readSettings(c.env.DB),
    today: pkDate(),
  });
});

// new → paid → collected. Marking paid (a person checked the money arrived) records the sale, so it counts in
// revenue, profit and net worth right away; collected only notes the handover. Undoing paid voids that sale.
app.post("/api/preorders/:id/status", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const user = c.get("user");
  const { status } = await c.req.json<{ status: string }>();
  const order = await c.env.DB.prepare("SELECT * FROM preorders WHERE id = ?").bind(id).first<Preorder>();
  if (!order) return bad("Order not found", 404);
  const allowed: Record<string, string[]> = { new: ["paid", "cancelled"], paid: ["collected", "cancelled", "new"], collected: [], cancelled: ["new"] };
  if (!allowed[order.status]?.includes(status)) return bad(`Can't move an order from ${order.status} to ${status}`);

  // Claim the transition first so two people tapping at once can't record the sale twice.
  const r = await c.env.DB.prepare("UPDATE preorders SET status = ?, handled_by = ?, updated_at = ? WHERE id = ? AND status = ?")
    .bind(status, user.id, nowIso(), id, order.status).run();
  if (!r.meta.changes) return bad("Someone else just changed this order. Refresh.");
  let saleId: number | null = null;
  if (status === "paid") {
    const lines = (await c.env.DB.prepare("SELECT pi.*, i.cost FROM preorder_items pi LEFT JOIN items i ON i.id = pi.item_id WHERE pi.preorder_id = ?").bind(id).all<PreorderLine & { cost: number | null }>()).results;
    const saleLines: SaleLine[] = lines.map((l) => ({ item: { id: l.item_id, name: l.name, price: l.unit_price, cost: l.cost }, qty: l.qty }));
    saleId = await insertSale(c.env.DB, user, { lines: saleLines, subtotal: order.total, discount: 0, code: null, total: order.total, payment: "online", note: `Pre-order ${preorderCode(id)} · ${order.name}` });
    await c.env.DB.prepare("UPDATE preorders SET sale_id = ? WHERE id = ?").bind(saleId, id).run();
  } else if (order.status === "paid" && (status === "new" || status === "cancelled") && order.sale_id) {
    const sale = await c.env.DB.prepare("SELECT id, total, code_id FROM sales WHERE id = ?").bind(order.sale_id).first<{ id: number; total: number; code_id: number | null }>();
    if (sale) await voidSale(c.env.DB, user, sale);
    await c.env.DB.prepare("UPDATE preorders SET sale_id = NULL WHERE id = ?").bind(id).run();
  }
  await log(c.env.DB, user.id, `preorder_${status}`, "preorder", id, { code: preorderCode(id), name: order.name, total: order.total, ...(saleId ? { sale_id: saleId } : {}) });
  return c.json({ ok: true, sale_id: saleId });
});

app.post("/api/public/preorders/:id/proof", async (c) => {
  if (await limited(c, "proof")) return slowDown();
  const id = int(c.req.param("id"));
  const form = await c.req.formData().catch(() => null);
  const token = form?.get("token");
  const file = form?.get("image");
  const order = await c.env.DB.prepare("SELECT id, token, proof_key FROM preorders WHERE id = ?").bind(id).first<{ id: number; token: string | null; proof_key: string | null }>();
  if (!order || !order.token || typeof token !== "string" || token !== order.token) return bad("Order not found", 404);
  if (!(file instanceof File) || file.size === 0) return bad("Pick a screenshot");
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return bad("Send a JPG, PNG or WebP image");
  if (file.size > 6 * 1024 * 1024) return bad("That image is too big (max 6 MB)");
  const key = `proof/${id}-${newToken().slice(0, 12)}`;
  await c.env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  await c.env.DB.prepare("UPDATE preorders SET proof_key = ?, updated_at = ? WHERE id = ?").bind(key, nowIso(), id).run();
  if (order.proof_key) await c.env.IMAGES.delete(order.proof_key).catch(() => {});
  await c.env.DB.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (NULL,'preorder_proof','preorder',?,?)").bind(id, JSON.stringify({ code: preorderCode(id) })).run();
  return c.json({ ok: true, url: `${new URL(c.req.url).origin}/orders?q=${preorderCode(id)}` });
});

// Uploaded files never run as a page, even ones stored before types were checked.
const IMG_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

// Payment screenshots are only for staff.
app.get("/api/preorders/:id/proof", async (c) => {
  const order = await c.env.DB.prepare("SELECT proof_key FROM preorders WHERE id = ?").bind(int(c.req.param("id"))).first<{ proof_key: string | null }>();
  const obj = order?.proof_key ? await c.env.IMAGES.get(order.proof_key) : null;
  if (!obj) return bad("No screenshot", 404);
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("Cache-Control", "private, max-age=3600");
  h.set("Content-Security-Policy", IMG_CSP);
  return new Response(obj.body, { headers: h });
});

app.put("/api/preorder-settings", adminOnly, async (c) => {
  const body = await c.req.json<Partial<PreorderSettings>>();
  const stmts = SETTING_KEYS.filter((k) => body[k] !== undefined).map((k) =>
    c.env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, String(body[k]).trim().slice(0, 80)),
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  await log(c.env.DB, c.get("user").id, "preorder_settings", undefined, undefined, body);
  return c.json({ settings: await readSettings(c.env.DB) });
});

// ---------- images (R2) ----------
app.get("/api/img/:key", async (c) => {
  if (c.req.param("key").startsWith("proof")) return c.notFound();
  const obj = await c.env.IMAGES.get(c.req.param("key"));
  if (!obj) return c.notFound();
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("etag", obj.httpEtag);
  h.set("Cache-Control", "public, max-age=31536000, immutable");
  h.set("Content-Security-Policy", IMG_CSP);
  return new Response(obj.body, { headers: h });
});

// ---------- items ----------
app.get("/api/items", async (c) => {
  const all = c.req.query("all") === "1";
  // sold = units sold in the last 30 days (voids excluded); the counter lists best sellers first.
  const rows = await c.env.DB.prepare(
    `SELECT i.*, COALESCE((SELECT SUM(si.qty) FROM sale_items si JOIN sales s ON s.id = si.sale_id
       WHERE si.item_id = i.id AND si.extra = 0 AND s.voided_at IS NULL AND s.created_at >= datetime('now', '-30 days')), 0) AS sold
     FROM items i ${all ? "" : "WHERE i.archived = 0"} ORDER BY i.category, i.sort_order, i.name`,
  ).all<Item>();
  return c.json({ items: rows.results });
});

async function readItemBody(c: any) {
  const ct = c.req.header("content-type") ?? "";
  let fields: Record<string, string> = {};
  let file: File | null = null;
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    for (const [k, v] of form.entries()) {
      if (v instanceof File) {
        if (k === "image" && v.size > 0) file = v;
      } else fields[k] = String(v);
    }
  } else {
    fields = await c.req.json();
  }
  return { fields, file };
}

// Only real image types: the stored content type is served back as-is, so text/html or image/svg+xml would be a page
// running on our own origin.
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif|heic|heif)$/;
async function storeImage(env: Env, file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw new Error("Image must be under 5 MB");
  if (!IMAGE_TYPES.test(file.type)) throw new Error("Use a JPG, PNG, WebP or GIF photo");
  const ext = (file.type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const key = `${Date.now().toString(36)}-${newToken().slice(0, 8)}.${ext}`;
  await env.IMAGES.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
  return key;
}

// Non-admins pick from the fixed categories or one already on the menu; only admins start a new category.
async function checkCategory(c: any, category: string): Promise<string | null> {
  if (hasScope(c.get("user"), "admin") || CATEGORIES.includes(category)) return null;
  const used = await c.env.DB.prepare("SELECT 1 FROM items WHERE category = ? AND archived = 0 LIMIT 1").bind(category).first();
  return used ? null : "Pick a category from the list";
}

app.post("/api/items", onShift, async (c) => {
  try {
    const { fields, file } = await readItemBody(c);
    if (!fields.name?.trim()) return bad("Name is required");
    const catError = await checkCategory(c, (fields.category || "Snacks").trim());
    if (catError) return bad(catError);
    const image_key = file ? await storeImage(c.env, file) : null;
    const stock = int(fields.stock, 0);
    const res = await c.env.DB.prepare(
      "INSERT INTO items (name, category, price, cost, stock, low_stock_at, image_key, visible, preorder) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        fields.name.trim(),
        (fields.category || "Snacks").trim(),
        parsePrice(fields.price) ?? 0,
        parsePrice(fields.cost),
        stock,
        int(fields.low_stock_at, 5),
        image_key,
        fields.visible === "0" || fields.visible === "false" ? 0 : 1,
        fields.preorder === "1" || fields.preorder === "true" ? 1 : 0,
      )
      .run();
    const id = res.meta.last_row_id as number;
    const user = c.get("user");
    if (stock !== 0) {
      await c.env.DB.prepare("INSERT INTO stock_moves (item_id, user_id, delta, reason, note, unit_cost) VALUES (?,?,?,'restock','Opening stock',?)").bind(id, user.id, stock, parsePrice(fields.cost)).run();
    }
    await log(c.env.DB, user.id, "item_create", "item", id, { name: fields.name, price: parsePrice(fields.price) ?? 0 });
    const item = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
    return c.json({ item });
  } catch (e: any) {
    return bad(e.message ?? "Failed");
  }
});

app.put("/api/items/:id", onShift, async (c) => {
  try {
    const id = int(c.req.param("id"));
    const existing = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
    if (!existing) return bad("Item not found", 404);
    const { fields, file } = await readItemBody(c);
    const image_key = file ? await storeImage(c.env, file) : fields.remove_image === "1" ? null : existing.image_key;
    if (fields.category !== undefined && fields.category.trim() !== existing.category) {
      const catError = await checkCategory(c, fields.category.trim());
      if (catError) return bad(catError);
    }
    const next = {
      name: fields.name?.trim() || existing.name,
      category: fields.category?.trim() || existing.category,
      price: fields.price !== undefined ? parsePrice(fields.price) ?? existing.price : existing.price,
      cost: fields.cost === undefined ? existing.cost : parsePrice(fields.cost),
      low_stock_at: fields.low_stock_at !== undefined ? int(fields.low_stock_at) : existing.low_stock_at,
      visible: fields.visible !== undefined ? (fields.visible === "0" || fields.visible === "false" ? 0 : 1) : existing.visible,
      sort_order: fields.sort_order !== undefined ? int(fields.sort_order) : existing.sort_order,
      preorder: fields.preorder !== undefined ? (fields.preorder === "1" || fields.preorder === "true" ? 1 : 0) : existing.preorder,
    };
    const stock = fields.stock === undefined || fields.stock === "" ? existing.stock : int(fields.stock);
    if (stock < 0) return bad("Stock can't be negative");
    const delta = stock - existing.stock;
    const user = c.get("user");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE items SET name=?, category=?, price=?, cost=?, low_stock_at=?, image_key=?, visible=?, sort_order=?, preorder=?, stock = stock + ?, updated_at=? WHERE id=?")
        .bind(next.name, next.category, next.price, next.cost, next.low_stock_at, image_key, next.visible, next.sort_order, next.preorder, delta, nowIso(), id),
      ...(delta !== 0 ? [c.env.DB.prepare("INSERT INTO stock_moves (item_id, user_id, delta, reason, note, unit_cost) VALUES (?,?,?,'correction','Edited on Menu items',?)").bind(id, user.id, delta, next.cost)] : []),
    ]);
    if (delta !== 0) await log(c.env.DB, user.id, "stock_correction", "item", id, { delta, from: existing.stock, to: stock, note: "Edited on Menu items" });
    if (next.cost !== existing.cost) await fillMissingCosts(c.env.DB, id, next.cost);
    if (file && existing.image_key) await c.env.IMAGES.delete(existing.image_key).catch(() => {});
    const changes: Record<string, [unknown, unknown]> = {};
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] !== existing[k]) changes[k] = [existing[k], next[k]];
    if (Object.keys(changes).length || file || fields.remove_image === "1") await log(c.env.DB, user.id, "item_update", "item", id, changes);
    const item = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
    return c.json({ item });
  } catch (e: any) {
    return bad(e.message ?? "Failed");
  }
});

app.delete("/api/items/:id", onShift, async (c) => {
  const id = int(c.req.param("id"));
  await c.env.DB.prepare("UPDATE items SET archived = 1, visible = 0, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  await log(c.env.DB, c.get("user").id, "item_archive", "item", id);
  return c.json({ ok: true });
});

// Permanently removes an item that was never sold. Anything with sales stays archivable only, so history keeps its item.
app.delete("/api/items/:id/permanent", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const item = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
  if (!item) return bad("Item not found", 404);
  const sold = await c.env.DB.prepare("SELECT 1 FROM sale_items WHERE item_id = ? LIMIT 1").bind(id).first();
  if (sold) return bad("This item has sales, so it can only be archived");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM stock_moves WHERE item_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM items WHERE id = ?").bind(id),
  ]);
  if (item.image_key) await c.env.IMAGES.delete(item.image_key).catch(() => {});
  await log(c.env.DB, c.get("user").id, "item_delete", "item", id, { name: item.name, price: item.price });
  return c.json({ ok: true });
});

app.post("/api/items/:id/restore", onShift, async (c) => {
  const id = int(c.req.param("id"));
  await c.env.DB.prepare("UPDATE items SET archived = 0, updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  await log(c.env.DB, c.get("user").id, "item_restore", "item", id);
  return c.json({ ok: true });
});

// A buy price applies across the board: setting it also rewrites the buy price on every past sale of the item, so
// profit, Stats, Shares and the MCP all use it. (What customers paid never changes.) Returns how many sale lines moved.
// A buy price applies from now on: each sale line keeps the buy price it sold at, and changing items.cost never rewrites
// a past sale. The only exception: sale lines that never had a buy price (sold before anyone entered one) take the first
// one set, so their profit isn't stuck at unknown.
async function fillMissingCosts(db: D1Database, itemId: number, cost: number | null): Promise<number> {
  if (cost === null) return 0;
  const r = await db.prepare("UPDATE sale_items SET unit_cost = ? WHERE item_id = ? AND extra = 0 AND unit_cost IS NULL").bind(cost, itemId).run();
  return r.meta.changes ?? 0;
}

// Anyone on shift sets the buy price. It applies to sales from now on; past sales keep theirs.
app.put("/api/items/:id/cost", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const body = await c.req.json<{ cost: number | string | null }>();
  const item = await c.env.DB.prepare("SELECT id, cost FROM items WHERE id = ?").bind(id).first<{ cost: number | null }>();
  if (!item) return bad("Item not found", 404);
  const cost = parsePrice(body.cost);
  if (cost !== null && cost < 0) return bad("Buy price can't be negative");
  await c.env.DB.prepare("UPDATE items SET cost = ?, updated_at = ? WHERE id = ?").bind(cost, nowIso(), id).run();
  const backfilled = await fillMissingCosts(c.env.DB, id, cost);
  await log(c.env.DB, c.get("user").id, "item_cost", "item", id, { cost: [item.cost, cost], ...(backfilled ? { past_sale_lines_filled: backfilled } : {}) });
  return c.json({ ok: true });
});

// ---------- stock ----------
app.post("/api/items/:id/stock", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const user = c.get("user");
  const body = await c.req.json<{ delta?: number; set?: number; reason: string; note?: string }>();
  const item = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
  if (!item) return bad("Item not found", 404);
  const reason = ["restock", "waste", "correction"].includes(body.reason) ? body.reason : "correction";
  let delta: number;
  if (body.set !== undefined && body.set !== null) delta = int(body.set) - item.stock;
  else delta = int(body.delta);
  if (delta === 0) return c.json({ item });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE items SET stock = stock + ?, updated_at = ? WHERE id = ?").bind(delta, nowIso(), id),
    c.env.DB.prepare("INSERT INTO stock_moves (item_id, user_id, delta, reason, note, unit_cost) VALUES (?,?,?,?,?,?)").bind(id, user.id, delta, reason, body.note?.trim() || null, item.cost),
  ]);
  await log(c.env.DB, user.id, "stock_" + reason, "item", id, { delta, from: item.stock, to: item.stock + delta, note: body.note });
  const updated = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<Item>();
  return c.json({ item: updated });
});

app.get("/api/stock-moves", async (c) => {
  const limit = Math.min(int(c.req.query("limit"), 100), 500);
  const itemId = c.req.query("item_id");
  const before = c.req.query("before");
  const where: string[] = []; const args: unknown[] = [];
  if (itemId) { where.push("m.item_id = ?"); args.push(int(itemId)); }
  if (before) { where.push("m.id < ?"); args.push(int(before)); }
  const rows = await c.env.DB.prepare(
    `SELECT m.*, i.name AS item_name, u.name AS user_name FROM stock_moves m
     JOIN items i ON i.id = m.item_id JOIN users u ON u.id = m.user_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.id DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all();
  return c.json({ moves: rows.results, has_more: rows.results.length === limit });
});

async function ensureSwapTables(db: D1Database) {
  try {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS slot_swaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        from_slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        to_slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        responded_at TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS shift_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by INTEGER REFERENCES users(id),
        note TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        reviewed_at TEXT
      )`),
    ]);
  } catch {}
}

async function userCanStartShiftNow(db: D1Database, userId: number, isAdmin: boolean): Promise<boolean> {
  if (isAdmin) return true;
  const now = nowIso();
  // 1. Check if user has an active slot in slots table covering now (with 15 min early buffer)
  const slot = await db.prepare(
    "SELECT id FROM slots WHERE user_id = ? AND datetime(starts_at, '-15 minutes') <= datetime(?) AND ends_at >= ? LIMIT 1"
  ).bind(userId, now, now).first();
  if (slot) return true;

  // 2. Check if user has an approved shift request within the last 30 minutes
  const approvedReq = await db.prepare(
    "SELECT id FROM shift_requests WHERE user_id = ? AND status = 'approved' AND reviewed_at >= datetime(?, '-30 minutes') LIMIT 1"
  ).bind(userId, now).first();
  if (approvedReq) return true;

  return false;
}

// ---------- shifts ----------
app.post("/api/shifts/start", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ opening_cash?: number }>().catch(() => ({} as { opening_cash?: number }));
  await closeExpiredShifts(c.env.DB);
  await ensureSwapTables(c.env.DB);
  const open = await c.env.DB.prepare("SELECT id FROM shifts WHERE user_id = ? AND ended_at IS NULL").bind(user.id).first();
  if (open) return bad("You already have an open shift", 409);

  const canStart = await userCanStartShiftNow(c.env.DB, user.id, hasScope(user, "admin") || hasScope(user, "hr"));
  if (!canStart) {
    return c.json({ error: "You don't have a scheduled slot right now. Send a request to Admin/HR for approval.", needs_approval: true }, 403);
  }

  const res = await c.env.DB.prepare("INSERT INTO shifts (user_id, opening_cash) VALUES (?,?)")
    .bind(user.id, body.opening_cash == null ? null : int(body.opening_cash))
    .run();
  await log(c.env.DB, user.id, "shift_start", "shift", res.meta.last_row_id as number);
  const shift = await c.env.DB.prepare("SELECT * FROM shifts WHERE id = ?").bind(res.meta.last_row_id).first();
  return c.json({ shift });
});

app.post("/api/shifts/end", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ closing_cash?: number; note?: string; shift_id?: number }>().catch(() => ({} as { closing_cash?: number; note?: string; shift_id?: number }));
  let shift: any;
  // Admins and HR can end someone else's forgotten shift.
  if (body.shift_id && (user.role === "admin" || user.is_hr)) {
    shift = await c.env.DB.prepare("SELECT * FROM shifts WHERE id = ? AND ended_at IS NULL").bind(int(body.shift_id)).first();
  } else {
    shift = await c.env.DB.prepare("SELECT * FROM shifts WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").bind(user.id).first();
  }
  if (!shift) return bad("No open shift", 404);
  await c.env.DB.prepare("UPDATE shifts SET ended_at = ?, closing_cash = ?, note = ? WHERE id = ?")
    .bind(nowIso(), body.closing_cash == null ? null : int(body.closing_cash), body.note?.trim() || null, shift.id)
    .run();
  await log(c.env.DB, user.id, "shift_end", "shift", shift.id, { closing_cash: body.closing_cash });
  return c.json({ ok: true });
});

// Attendance comes from shift start/end, checked against the slots HR assigned. Raw rows; the page aggregates.
app.get("/api/attendance", attendanceAccess, async (c) => {
  const days = Math.min(Math.max(int(c.req.query("days"), 14), 1), 90);
  const from = new Date(Date.now() + 5 * 3600_000 - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const fromUtc = new Date(Date.parse(from + "T00:00:00Z") - 5 * 3600_000).toISOString(); // midnight PKT
  const [shifts, slots, users] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT s.id, s.user_id, u.name AS user_name, s.started_at, s.ended_at,
         (SELECT COUNT(*) FROM sales x WHERE x.shift_id = s.id AND x.voided_at IS NULL) AS sales_count,
         (SELECT COALESCE(SUM(total),0) FROM sales x WHERE x.shift_id = s.id AND x.voided_at IS NULL) AS sales_total
       FROM shifts s JOIN users u ON u.id = s.user_id
       WHERE s.started_at >= ? OR s.ended_at IS NULL OR s.ended_at >= ? ORDER BY s.started_at`,
    ).bind(fromUtc, fromUtc),
    c.env.DB.prepare("SELECT s.id, s.user_id, u.name AS user_name, s.starts_at, s.ends_at, s.note FROM slots s JOIN users u ON u.id = s.user_id WHERE s.ends_at >= ? ORDER BY s.starts_at").bind(fromUtc),
    c.env.DB.prepare("SELECT id, name, picture, scopes FROM users WHERE approved = 1 AND active = 1 ORDER BY name"),
  ]);
  return c.json({ from, today: new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10), now: nowIso(), shifts: shifts.results, slots: slots.results, users: users.results });
});

// Daily attendance reports (worker/report.ts): stored at REPORT_AT each day, kept for good; any day downloads as CSV.
app.get("/api/attendance/reports", attendanceAccess, async (c) => {
  const rows = await c.env.DB.prepare("SELECT day, slots, missed, off_slot, created_at FROM attendance_reports ORDER BY day DESC LIMIT 120").all();
  return c.json({ reports: rows.results, report_at: REPORT_AT, today: reportToday() });
});

app.get("/api/attendance/reports/:day", attendanceAccess, async (c) => {
  const day = c.req.param("day").replace(/\.csv$/, "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) return bad("Pick a day");
  if (day > reportToday()) return bad("That day hasn't happened yet");
  const stored = await c.env.DB.prepare("SELECT csv FROM attendance_reports WHERE day = ?").bind(day).first<{ csv: string }>();
  const csv = stored?.csv ?? (await buildReport(c.env.DB, day)).csv;
  return c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="khaapa-attendance-${day}.csv"`, "Cache-Control": "no-store" });
});

app.get("/api/shifts", async (c) => {
  const limit = Math.min(int(c.req.query("limit"), 50), 500);
  const rows = await c.env.DB.prepare(
    `SELECT s.*, u.name AS user_name,
       (SELECT COUNT(*) FROM sales x WHERE x.shift_id = s.id AND x.voided_at IS NULL) AS sales_count,
       (SELECT COALESCE(SUM(total),0) FROM sales x WHERE x.shift_id = s.id AND x.voided_at IS NULL) AS sales_total
     FROM shifts s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT ?`,
  )
    .bind(limit)
    .all();
  return c.json({ shifts: rows.results });
});

// ---------- sales ----------
// extra: the customer's add-on money, booked on the Stickers item at its own price; it moves no stock.
type SaleLine = { item: Pick<Item, "id" | "name" | "price" | "cost">; qty: number; extra?: boolean };

// Writes a sale with its lines, stock moves and activity entry. Every sale goes through here.
async function insertSale(
  db: D1Database,
  user: User,
  s: { lines: SaleLine[]; subtotal: number; discount: number; code: DiscountCodeRow | null; total: number; payment: "cash" | "online"; note?: string | null },
): Promise<number> {
  const shift = await db.prepare("SELECT id FROM shifts WHERE user_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").bind(user.id).first<{ id: number }>();
  const saleRes = await db.prepare("INSERT INTO sales (user_id, shift_id, subtotal, discount, code_id, total, payment, note) VALUES (?,?,?,?,?,?,?,?)")
    .bind(user.id, shift?.id ?? null, s.subtotal, s.discount, s.code?.id ?? null, s.total, s.payment, s.note?.trim() || null)
    .run();
  const saleId = saleRes.meta.last_row_id as number;

  const stmts: D1PreparedStatement[] = [];
  for (const l of s.lines) {
    if (l.extra) {
      stmts.push(db.prepare("INSERT INTO sale_items (sale_id, item_id, name, unit_price, unit_cost, qty, extra) VALUES (?,?,?,?,0,1,1)").bind(saleId, l.item.id, l.item.name, l.item.price));
      continue;
    }
    stmts.push(
      db.prepare("INSERT INTO sale_items (sale_id, item_id, name, unit_price, unit_cost, qty) VALUES (?,?,?,?,?,?)").bind(saleId, l.item.id, l.item.name, l.item.price, l.item.cost, l.qty),
      db.prepare("UPDATE items SET stock = stock - ?, updated_at = ? WHERE id = ?").bind(l.qty, nowIso(), l.item.id),
      db.prepare("INSERT INTO stock_moves (item_id, user_id, delta, reason, sale_id, unit_cost) VALUES (?,?,?,'sale',?,?)").bind(l.item.id, user.id, -l.qty, saleId, l.item.cost),
    );
  }
  stmts.push(
    db.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)").bind(
      user.id,
      "sale",
      "sale",
      saleId,
      JSON.stringify({ total: s.total, payment: s.payment, lines: s.lines.map((l) => (l.extra ? `+${l.item.price} extra on ${l.item.name}` : `${l.qty}× ${l.item.name}`)), ...(s.code ? { code: s.code.code, discount: s.discount } : {}) }),
    ),
  );
  await db.batch(stmts);
  return saleId;
}

app.post("/api/sales", onShift, async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ items: { item_id: number; qty: number }[]; payment?: string; note?: string; payment_id?: number | null; code?: string | null; extra?: number | string | null }>();
  if (!Array.isArray(body.items) || body.items.length === 0) return bad("Cart is empty");
  const payment = body.payment === "online" ? "online" : "cash";
  // The extra can only add to what the customer pays; a negative or malformed amount is refused, never flipped.
  const extra = body.extra == null || body.extra === "" ? 0 : parsePrice(body.extra);
  if (extra === null) return bad("Extra must be an amount of 0 or more");

  const ids = [...new Set(body.items.map((l) => int(l.item_id)))];
  const rows = await c.env.DB.prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => "?").join(",")}) AND archived = 0`).bind(...ids).all<Item>();
  const byId = new Map(rows.results.map((i) => [i.id, i]));

  const lines: { item: Item; qty: number }[] = [];
  for (const l of body.items) {
    const item = byId.get(int(l.item_id));
    const qty = int(l.qty);
    if (!item) return bad(`Item ${l.item_id} not found`);
    if (qty <= 0) return bad(`Bad quantity for ${item.name}`);
    const existing = lines.find((x) => x.item.id === item.id);
    if (existing) existing.qty += qty;
    else lines.push({ item, qty });
  }
  for (const l of lines) if (l.item.stock < l.qty) return bad(`Not enough stock for ${l.item.name} (have ${l.item.stock})`);

  const goods = round2(lines.reduce((s, l) => s + l.item.price * l.qty, 0));
  const saleLines: SaleLine[] = [...lines];
  if (extra > 0) {
    const stickers = (await c.env.DB.prepare("SELECT * FROM items WHERE archived = 0 AND name LIKE '%sticker%' ORDER BY id").all<Item>()).results.find(isExtraItem);
    if (!stickers) return bad("Add a Stickers item to take an extra amount");
    saleLines.push({ item: { id: stickers.id, name: stickers.name, price: extra, cost: 0 }, qty: 1, extra: true });
  }
  let discount = 0;
  let code: DiscountCodeRow | null = null;
  if (body.code?.trim()) {
    const r = await findCode(c.env.DB, body.code, goods);
    if ("error" in r) return bad(r.error);
    code = r.code;
    discount = r.discount;
    // Claim a use atomically so two counters can't both spend the last use of a code.
    const claim = await c.env.DB.prepare("UPDATE discount_codes SET uses = uses + 1 WHERE id = ? AND active = 1 AND (max_uses IS NULL OR uses < max_uses)").bind(code.id).run();
    if (!claim.meta.changes) return bad("That code has already been used");
  }
  const subtotal = round2(goods + extra);
  const total = round2(subtotal - discount);
  const saleId = await insertSale(c.env.DB, user, { lines: saleLines, subtotal, discount, code, total, payment, note: body.note });
  // The cashier may attach the incoming payment they confirmed; linking is always a human decision.
  let linked = false;
  if (payment === "online" && body.payment_id != null) {
    const r = await c.env.DB.prepare("UPDATE payments SET sale_id = ? WHERE id = ? AND sale_id IS NULL").bind(saleId, int(body.payment_id)).run();
    linked = !!r.meta.changes;
  }
  return c.json({ sale: { id: saleId, subtotal, discount, extra, total, payment, created_at: nowIso(), payment_linked: linked } });
});

app.get("/api/sales", async (c) => {
  const limit = Math.min(int(c.req.query("limit"), 50), 500);
  const before = c.req.query("before");
  const rows = await c.env.DB.prepare(
    `SELECT s.*, u.name AS user_name, d.code FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN discount_codes d ON d.id = s.code_id ${before ? "WHERE s.id < ?" : ""} ORDER BY s.id DESC LIMIT ?`,
  )
    .bind(...(before ? [int(before), limit] : [limit]))
    .all();
  const ids = rows.results.map((s: any) => s.id);
  let items: any[] = [];
  if (ids.length) {
    // Lines sold before a buy price was set fall back to today's buy price, same as the stats.
    items = (await c.env.DB.prepare(`SELECT si.*, COALESCE(si.unit_cost, i.cost) AS unit_cost FROM sale_items si LEFT JOIN items i ON i.id = si.item_id WHERE si.sale_id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results;
  }
  const sales = rows.results.map((s: any) => ({ ...s, items: items.filter((i) => i.sale_id === s.id) }));
  return c.json({ sales, has_more: rows.results.length === limit });
});

app.post("/api/sales/:id/void", onShift, async (c) => {
  const user = c.get("user");
  const id = int(c.req.param("id"));
  const sale = await c.env.DB.prepare("SELECT * FROM sales WHERE id = ?").bind(id).first<any>();
  if (!sale) return bad("Sale not found", 404);
  if (sale.voided_at) return bad("Already voided");
  if (user.role !== "admin" && sale.user_id !== user.id) return bad("You can only void your own sales", 403);
  await voidSale(c.env.DB, user, sale);
  return c.json({ ok: true });
});

// Puts the stock back and gives a code its use back. Used by void and by pre-orders.
async function voidSale(db: D1Database, user: User, sale: { id: number; total: number; code_id: number | null }) {
  const id = sale.id;
  const items = (await db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").bind(id).all<any>()).results;
  const stmts: D1PreparedStatement[] = [db.prepare("UPDATE sales SET voided_at = ?, voided_by = ? WHERE id = ? AND voided_at IS NULL").bind(nowIso(), user.id, id)];
  for (const it of items) {
    if (it.extra) continue;
    stmts.push(
      db.prepare("UPDATE items SET stock = stock + ?, updated_at = ? WHERE id = ?").bind(it.qty, nowIso(), it.item_id),
      db.prepare("INSERT INTO stock_moves (item_id, user_id, delta, reason, sale_id, note, unit_cost) VALUES (?,?,?,'void',?,?,?)").bind(it.item_id, user.id, it.qty, id, `Void of sale #${id}`, it.unit_cost),
    );
  }
  // A voided sale never happened: give the code its use back.
  if (sale.code_id) stmts.push(db.prepare("UPDATE discount_codes SET uses = MAX(uses - 1, 0) WHERE id = ?").bind(sale.code_id));
  stmts.push(db.prepare("INSERT INTO activity_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)").bind(user.id, "sale_void", "sale", id, JSON.stringify({ total: sale.total })));
  await db.batch(stmts);
}

// ---------- payment inbox (Gmail) ----------
const GMAIL_STATE = "khaapa_gmail";
const gmailRedirect = (c: any) => `${new URL(c.req.url).origin}/api/gmail/callback`;
const connected = (c: any, ok: boolean, msg: string) => c.redirect(`/connected?ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`);

// Admin creates a one-time link and hands it to whoever owns the payment inbox.
app.post("/api/payments/connect-link", adminOnly, async (c) => {
  const token = newToken();
  const expires = new Date(Date.now() + 24 * 3600_000).toISOString();
  await c.env.DB.prepare("INSERT INTO mail_connect_links (token, created_by, expires_at) VALUES (?,?,?)").bind(token, c.get("user").id, expires).run();
  await log(c.env.DB, c.get("user").id, "mail_link_create");
  return c.json({ url: `${new URL(c.req.url).origin}/api/gmail/connect/${token}`, expires_at: expires });
});

// Public (link-gated): start Google consent for read-only Gmail access.
app.get("/api/gmail/connect/:token", async (c) => {
  const link = await c.env.DB.prepare("SELECT * FROM mail_connect_links WHERE token = ?").bind(c.req.param("token")).first<{ expires_at: string; used_at: string | null }>();
  if (!link || link.used_at || link.expires_at < nowIso()) return connected(c, false, "This link has expired or was already used. Ask for a new one.");
  const state = `${c.req.param("token")}.${newToken().slice(0, 16)}`;
  setCookie(c, GMAIL_STATE, state, { path: "/api/gmail", httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: 900 });
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", c.env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", gmailRedirect(c));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email https://www.googleapis.com/auth/gmail.readonly");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent select_account");
  u.searchParams.set("state", state);
  return c.redirect(u.toString());
});

app.get("/api/gmail/callback", async (c) => {
  const q = c.req.query();
  const expected = getCookie(c, GMAIL_STATE);
  deleteCookie(c, GMAIL_STATE, { path: "/api/gmail" });
  if (q.error) return connected(c, false, "Access was not granted.");
  if (!q.code || !q.state || q.state !== expected) return connected(c, false, "Session expired. Open the link again.");
  const linkToken = q.state.split(".")[0];
  const link = await c.env.DB.prepare("SELECT * FROM mail_connect_links WHERE token = ?").bind(linkToken).first<{ expires_at: string; used_at: string | null; created_by: number }>();
  if (!link || link.used_at || link.expires_at < nowIso()) return connected(c, false, "This link has expired or was already used.");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: q.code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: gmailRedirect(c), grant_type: "authorization_code" }),
  });
  const tok = await tokenRes.json<{ refresh_token?: string; id_token?: string; scope?: string }>();
  if (!tokenRes.ok || !tok.refresh_token) {
    console.error("gmail connect exchange failed", tokenRes.status, JSON.stringify(tok).slice(0, 300));
    return connected(c, false, "Google did not return long-lived access. Open the link again and tick the Gmail permission.");
  }
  if (!(tok.scope ?? "").includes("gmail.readonly")) return connected(c, false, "The Gmail permission box was not ticked. Open the link again and allow it.");
  let email = "unknown";
  try { email = JSON.parse(atob(tok.id_token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? email; } catch {}

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM mail_connections"),
    c.env.DB.prepare("INSERT INTO mail_connections (email, refresh_token_enc) VALUES (?,?)").bind(email, await encrypt(c.env, tok.refresh_token)),
    c.env.DB.prepare("UPDATE mail_connect_links SET used_at = ? WHERE token = ?").bind(nowIso(), linkToken),
  ]);
  await log(c.env.DB, link.created_by, "mail_connect", undefined, undefined, { email });
  c.executionCtx.waitUntil(syncPayments(c.env).catch((e) => console.error("initial sync failed", e)));
  return connected(c, true, `${email} is connected. You can close this tab.`);
});

app.get("/api/payments", async (c) => {
  const limit = Math.min(int(c.req.query("limit"), 100), 500);
  const before = c.req.query("before");
  // Filters for the Payments page: status (linked / unlinked / ignored) and a search on sender, reference or amount.
  const where: string[] = [];
  const args: unknown[] = [];
  if (before) { where.push("id < ?"); args.push(int(before)); }
  const status = c.req.query("status");
  if (status === "linked") where.push("sale_id IS NOT NULL AND ignored = 0");
  else if (status === "unlinked") where.push("sale_id IS NULL AND ignored = 0");
  else if (status === "ignored") where.push("ignored = 1");
  const q = (c.req.query("q") ?? "").trim().slice(0, 60);
  if (q) {
    const like = `%${q.replace(/[%_\\]/g, (ch) => "\\" + ch)}%`;
    const amount = Number(q.replace(/[,\s]|^rs\.?/gi, ""));
    where.push(`(sender_name LIKE ? ESCAPE '\\' OR reference LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\'${Number.isFinite(amount) && amount > 0 ? " OR amount = ?" : ""})`);
    args.push(like, like, like, ...(Number.isFinite(amount) && amount > 0 ? [amount] : []));
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, source, received_at, amount, sender_name, reference, subject, snippet, sale_id, ignored FROM payments ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
  ).bind(...args, limit).all();
  const conn = await c.env.DB.prepare("SELECT email, connected_at, last_sync_at, last_error FROM mail_connections ORDER BY id DESC LIMIT 1").first();
  const tz = "+5 hours";
  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN date(received_at,'${tz}') = date('now','${tz}') THEN amount END),0) AS today,
            COALESCE(SUM(CASE WHEN date(received_at,'${tz}') >= date('now','${tz}','-6 days') THEN amount END),0) AS week,
            COUNT(CASE WHEN sale_id IS NULL THEN 1 END) AS unmatched FROM payments WHERE ignored = 0`,
  ).first();
  return c.json({ payments: rows.results, has_more: rows.results.length === limit, connection: conn ?? null, totals });
});

// Recent unmatched payments, for the cashier to confirm an online payment at the counter.
app.get("/api/payments/recent", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, source, received_at, amount, sender_name FROM payments WHERE sale_id IS NULL AND ignored = 0 AND received_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 minutes') ORDER BY received_at DESC LIMIT 8",
  ).all();
  return c.json({ payments: rows.results });
});

app.post("/api/payments/sync", onShift, async (c) => {
  try {
    const r = await syncPayments(c.env);
    return c.json({ ok: true, ...r });
  } catch (e: any) {
    return bad(e.message ?? "Sync failed", 502);
  }
});

// Online sales that have no payment linked yet, for manually linking a payment. Same-amount sales first.
app.get("/api/payments/:id/candidates", async (c) => {
  const pay = await c.env.DB.prepare("SELECT id, amount FROM payments WHERE id = ?").bind(int(c.req.param("id"))).first<{ id: number; amount: number | null }>();
  if (!pay) return bad("Payment not found", 404);
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.total, s.created_at, u.name AS user_name,
        (SELECT group_concat(si.qty || '× ' || si.name, ', ') FROM sale_items si WHERE si.sale_id = s.id) AS summary
     FROM sales s JOIN users u ON u.id = s.user_id
     WHERE s.payment = 'online' AND s.voided_at IS NULL AND s.created_at >= datetime('now','-7 days')
       AND NOT EXISTS (SELECT 1 FROM payments x WHERE x.sale_id = s.id)
     ORDER BY (s.total = ?) DESC, s.id DESC LIMIT 12`,
  ).bind(pay.amount ?? -1).all();
  return c.json({ sales: rows.results });
});

app.post("/api/payments/:id/match", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const body = await c.req.json<{ sale_id: number | null }>();
  if (body.sale_id != null) {
    const saleId = int(body.sale_id);
    const sale = await c.env.DB.prepare("SELECT id, payment, voided_at FROM sales WHERE id = ?").bind(saleId).first<{ payment: string; voided_at: string | null }>();
    if (!sale || sale.voided_at) return bad("Sale not found", 404);
    if (sale.payment !== "online") return bad("That sale was paid in cash");
    const taken = await c.env.DB.prepare("SELECT id FROM payments WHERE sale_id = ? AND id != ?").bind(saleId, id).first();
    if (taken) return bad("That sale already has a payment linked");
    await c.env.DB.prepare("UPDATE payments SET sale_id = ?, ignored = 0 WHERE id = ?").bind(saleId, id).run();
  } else {
    await c.env.DB.prepare("UPDATE payments SET sale_id = NULL WHERE id = ?").bind(id).run();
  }
  await log(c.env.DB, c.get("user").id, body.sale_id == null ? "payment_unlink" : "payment_match", "payment", id, { sale_id: body.sale_id });
  return c.json({ ok: true });
});

app.post("/api/payments/:id/ignore", onShift, async (c) => {
  const id = int(c.req.param("id"));
  const body = await c.req.json<{ ignored: boolean }>();
  await c.env.DB.prepare("UPDATE payments SET ignored = ?, sale_id = CASE WHEN ? THEN NULL ELSE sale_id END WHERE id = ?").bind(body.ignored ? 1 : 0, body.ignored ? 1 : 0, id).run();
  await log(c.env.DB, c.get("user").id, body.ignored ? "payment_ignore" : "payment_unignore", "payment", id);
  return c.json({ ok: true });
});

app.delete("/api/payments/connection", adminOnly, async (c) => {
  await c.env.DB.prepare("DELETE FROM mail_connections").run();
  await log(c.env.DB, c.get("user").id, "mail_disconnect");
  return c.json({ ok: true });
});

// ---------- users (admin) ----------
app.get("/api/users", need("hr"), async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, username, name, email, picture, role, active, approved, is_hr, scopes, created_at FROM users ORDER BY approved, id").all<Omit<User, "scopes"> & { scopes: string }>();
  const users = rows.results.map((u) => ({ ...u, scopes: isOwner(c.env, u.email) ? ["admin", "hr"] : parseScopes(u.scopes) }));
  return c.json({ users });
});

// HR (and admins) review, approve and assign scopes. Only admins can grant admin or change an admin.
// HR and admins let people in and decide who is HR. Only admins grant admin or change an admin.
app.put("/api/users/:id", need("hr"), async (c) => {
  const id = int(c.req.param("id"));
  const me = c.get("user");
  const iAmAdmin = me.scopes.includes("admin");
  const body = await c.req.json<{ name?: string; scopes?: string[]; active?: boolean; approved?: boolean }>();
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<Omit<User, "scopes"> & { scopes: string }>();
  if (!row) return bad("User not found", 404);
  const target = { ...row, scopes: parseScopes(row.scopes) };
  const owner = isOwner(c.env, target.email);
  const before = owner ? (["admin", "hr"] as Scope[]) : target.scopes;
  if (!iAmAdmin && before.includes("admin")) return bad("Only an admin can change an admin", 403);

  let scopes = body.scopes === undefined ? before : parseScopes(body.scopes.join(","));
  if (!iAmAdmin && scopes.includes("admin")) return bad("Only an admin can grant admin", 403);
  const active = body.active === undefined ? target.active : body.active ? 1 : 0;
  const approved = body.approved === undefined ? target.approved : body.approved ? 1 : 0;
  if (owner && (!active || !approved || !scopes.includes("admin"))) return bad("The owner account cannot be changed");
  if (id === me.id && (!active || (before.includes("admin") && !scopes.includes("admin")))) return bad("You cannot remove your own admin scope or disable yourself");
  if (owner) scopes = ["admin", "hr"];

  const name = body.name?.trim() || target.name;
  const role = scopes.includes("admin") ? "admin" : "staff";
  const is_hr = scopes.includes("hr") ? 1 : 0;
  await c.env.DB.prepare("UPDATE users SET name=?, role=?, active=?, approved=?, scopes=?, is_hr=? WHERE id=?")
    .bind(name, role, active, approved, scopes.join(","), is_hr, id).run();
  if (!active) await c.env.DB.batch([c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id), ...dropPicks(c.env.DB, id)]);
  await log(c.env.DB, me.id, approved && !target.approved ? "user_approve" : "user_update", "user", id, { name, scopes, active, approved });
  return c.json({ ok: true });
});

// ---------- schedule (slots) ----------
type SlotRow = { id: number; user_id: number; user_name: string; starts_at: string; ends_at: string; note: string | null };
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

app.get("/api/slots", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const start = isIso(from) ? new Date(from).toISOString() : new Date(Date.now() - 86400_000).toISOString();
  const end = isIso(to) ? new Date(to).toISOString() : new Date(Date.now() + 8 * 86400_000).toISOString();
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, u.name AS user_name, s.starts_at, s.ends_at, s.note, s.reminded_at, s.pick_id FROM slots s JOIN users u ON u.id = s.user_id
     WHERE s.ends_at > ? AND s.starts_at < ? ORDER BY s.starts_at, u.name LIMIT 500`,
  ).bind(start, end).all();
  const mine = await c.env.DB.prepare("SELECT id, starts_at, ends_at, note FROM slots WHERE user_id = ? AND ends_at > ? ORDER BY starts_at LIMIT 1")
    .bind(c.get("user").id, nowIso()).first();
  return c.json({ slots: rows.results, next: mine ?? null });
});

app.post("/api/slots", need("hr"), async (c) => {
  const body = await c.req.json<{ user_ids: number[]; starts_at: string; ends_at: string; note?: string }>();
  if (!isIso(body.starts_at) || !isIso(body.ends_at)) return bad("Pick a start and end time");
  const starts = new Date(body.starts_at).toISOString();
  const ends = new Date(body.ends_at).toISOString();
  if (ends <= starts) return bad("The slot must end after it starts");
  if (Date.parse(ends) - Date.parse(starts) > 16 * 3600_000) return bad("A slot can be at most 16 hours");
  const ids = [...new Set((body.user_ids ?? []).map((v) => int(v)))];
  if (ids.length === 0) return bad("Pick at least one person");
  const people = await c.env.DB.prepare(`SELECT id, name FROM users WHERE approved = 1 AND active = 1 AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<{ id: number; name: string }>();
  if (people.results.length !== ids.length) return bad("Some of those people are not approved or are disabled");
  const clash = await c.env.DB.prepare(
    `SELECT u.name FROM slots s JOIN users u ON u.id = s.user_id WHERE s.user_id IN (${ids.map(() => "?").join(",")}) AND s.starts_at < ? AND s.ends_at > ? LIMIT 1`,
  ).bind(...ids, ends, starts).first<{ name: string }>();
  if (clash) return bad(`${clash.name} already has a slot that overlaps`);

  const me = c.get("user");
  const note = body.note?.trim() || null;
  await c.env.DB.batch(people.results.map((p) => c.env.DB.prepare("INSERT INTO slots (user_id, starts_at, ends_at, note, created_by) VALUES (?,?,?,?,?)").bind(p.id, starts, ends, note, me.id)));
  await log(c.env.DB, me.id, "slot_create", "slot", undefined, { people: people.results.map((p) => p.name), starts_at: starts, ends_at: ends });
  return c.json({ ok: true, created: people.results.length });
});

app.delete("/api/slots/:id", need("hr"), async (c) => {
  const id = int(c.req.param("id"));
  const slot = await c.env.DB.prepare("SELECT s.*, u.name AS user_name FROM slots s JOIN users u ON u.id = s.user_id WHERE s.id = ?").bind(id).first<SlotRow>();
  if (!slot) return bad("Slot not found", 404);
  await c.env.DB.prepare("DELETE FROM slots WHERE id = ?").bind(id).run();
  await log(c.env.DB, c.get("user").id, "slot_delete", "slot", id, { person: slot.user_name, starts_at: slot.starts_at });
  return c.json({ ok: true });
});

// ---------- slot picks (one week at a time) ----------
// People pick blocks (Mon–Fri, PICK_TIMES) for one week: at least PICKS_MIN, at most PICK_CAP people per block (also the
// slot_picks_cap trigger). A pick is that one day in that week and nothing else (migration 0024): saving it makes its
// one slots row (pick_id set) at once, so the schedule and attendance read it like any slot. Nothing repeats a pick;
// next week people pick again.
type PickRow = { id: number; user_id: number; week: string; weekday: number; start: string };
const pickLabel = (p: { weekday: number; start: string }) => `${PICK_DAYS[p.weekday - 1].slice(0, 3)} ${p.start}`;
const isWeek = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").getUTCDay() === 1;
// Monday of the current week, Pakistan time.
const thisWeek = () => {
  const today = Date.parse(pkToday() + "T00:00:00Z");
  return new Date(today - ((new Date(today).getUTCDay() + 6) % 7) * 86400_000).toISOString().slice(0, 10);
};
const pickStart = (p: { week: string; weekday: number; start: string }) => {
  const day = new Date(Date.parse(p.week + "T00:00:00Z") + (p.weekday - 1) * 86400_000).toISOString().slice(0, 10);
  return new Date(`${day}T${p.start}:00+05:00`).toISOString();
};

// The one slot for each new pick. Only new picks come here, so a slot HR removed is never remade.
const pickSlots = (db: D1Database, picks: PickRow[]) => picks.map((p) => {
  const starts = pickStart(p);
  const ends = new Date(Date.parse(starts) + pickMinutesFor(p.start) * 60_000).toISOString();
  return db.prepare("INSERT OR IGNORE INTO slots (user_id, starts_at, ends_at, created_by, pick_id) VALUES (?,?,?,?,?)").bind(p.user_id, starts, ends, p.user_id, p.id);
});

// Drops a person's picks (all, or the given ids) and the slots they made that haven't started yet.
const dropPicks = (db: D1Database, userId: number, ids?: number[]) => {
  const only = ids ? ` AND id IN (${ids.map(() => "?").join(",")})` : "";
  const onlyPick = ids ? ` AND pick_id IN (${ids.map(() => "?").join(",")})` : "";
  return [
    db.prepare(`DELETE FROM slots WHERE user_id = ? AND pick_id IS NOT NULL AND starts_at > ?${onlyPick}`).bind(userId, nowIso(), ...(ids ?? [])),
    db.prepare(`DELETE FROM slot_picks WHERE user_id = ?${only}`).bind(userId, ...(ids ?? [])),
  ];
};

// HR opens picking (settings key slot_picks_open = "1"); until then nobody can pick. Closing it only stops new picks:
// slots already picked stay.
const picksOpen = async (db: D1Database) =>
  (await db.prepare("SELECT value FROM settings WHERE key = 'slot_picks_open'").first<{ value: string }>())?.value === "1";

app.get("/api/slot-picks", async (c) => {
  const q = c.req.query("week");
  const week = isWeek(q) ? q : thisWeek();
  const rows = await c.env.DB.prepare(
    `SELECT p.id, p.user_id, u.name AS user_name, p.week, p.weekday, p.start FROM slot_picks p JOIN users u ON u.id = p.user_id
     WHERE p.week = ? AND u.active = 1 AND u.approved = 1 ORDER BY p.weekday, p.start, u.name`,
  ).bind(week).all();
  return c.json({ picks: rows.results, open: await picksOpen(c.env.DB), week });
});

app.put("/api/slot-picks/open", need("hr"), async (c) => {
  const body = await c.req.json<{ open?: boolean }>().catch(() => ({} as { open?: boolean }));
  if (typeof body.open !== "boolean") return bad("Say open: true or false");
  await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('slot_picks_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(body.open ? "1" : "0").run();
  await log(c.env.DB, c.get("user").id, body.open ? "slot_picks_open" : "slot_picks_close");
  return c.json({ open: body.open });
});

// Saves someone's picks for one week (`week`, a Monday; this week if left out): the whole set for that week, at least
// PICKS_MIN. People set their own once per week while picking is open; HR and admins change anyone's, open or closed.
// Blocks that have already started can't be added or dropped.
app.put("/api/slot-picks", async (c) => {
  const me = c.get("user");
  type Body = { user_id?: number; week?: string; picks?: { weekday: number; start: string }[] };
  const body = await c.req.json<Body>().catch(() => ({} as Body));
  const isHr = hasScope(me, "hr");
  const userId = body.user_id === undefined ? me.id : int(body.user_id);
  if (body.week !== undefined && !isWeek(body.week)) return bad("week must be a Monday, YYYY-MM-DD");
  const week = body.week ?? thisWeek();
  if (week < thisWeek()) return bad("That week is over", 400);
  if (userId !== me.id && !isHr) return bad("Only HR can change someone else's slots", 403);
  if (!isHr && !(await picksOpen(c.env.DB))) return bad("Slot picking isn't open yet. HR opens it on the Schedule page.", 403);
  const already = !isHr && (await c.env.DB.prepare("SELECT 1 FROM slot_picks WHERE user_id = ? AND week = ? LIMIT 1").bind(userId, week).first());
  if (already) return bad("Your slots for this week are saved. Only HR can change them now.", 403);
  const person = await c.env.DB.prepare("SELECT name FROM users WHERE id = ? AND approved = 1 AND active = 1").bind(userId).first<{ name: string }>();
  if (!person) return bad("That person is not approved or is disabled", 404);
  const wanted = (Array.isArray(body.picks) ? body.picks : []).map((p) => ({ week, weekday: int(p?.weekday), start: String(p?.start ?? "") }));
  if (wanted.some((p) => p.weekday < 1 || p.weekday > PICK_DAYS.length || !PICK_TIMES.includes(p.start))) return bad("Pick from the slots on the schedule");
  const keys = new Set(wanted.map(pickLabel));
  if (keys.size !== wanted.length) return bad("Pick different slots");
  if (wanted.length < PICKS_MIN) return bad(`Pick at least ${PICKS_MIN} slots`);

  const current = (await c.env.DB.prepare("SELECT id, user_id, week, weekday, start FROM slot_picks WHERE user_id = ? AND week = ?").bind(userId, week).all<PickRow>()).results;
  const gone = current.filter((p) => !keys.has(pickLabel(p)));
  const added = wanted.filter((p) => !current.some((x) => pickLabel(x) === pickLabel(p)));
  if (gone.length === 0 && added.length === 0) return c.json({ ok: true });
  const now = nowIso();
  const started = [...gone, ...added].find((p) => pickStart(p) <= now);
  if (started) return bad(`${pickLabel(started)} has already started this week, so it can't be changed`);
  const stmts = [
    ...(gone.length ? dropPicks(c.env.DB, userId, gone.map((p) => p.id)) : []),
    ...added.map((p) => c.env.DB.prepare("INSERT INTO slot_picks (user_id, week, weekday, start) VALUES (?,?,?,?)").bind(userId, week, p.weekday, p.start)),
  ];
  try {
    await c.env.DB.batch(stmts);
  } catch (e: any) {
    if (String(e?.message ?? e).includes("slot full")) return bad(`That slot just filled up (${PICK_CAP} people max). Pick another.`, 409);
    throw e;
  }
  if (added.length) {
    const fresh = (await c.env.DB.prepare("SELECT id, user_id, week, weekday, start FROM slot_picks WHERE user_id = ? AND week = ?").bind(userId, week).all<PickRow>()).results
      .filter((p) => added.some((a) => pickLabel(a) === pickLabel(p)));
    await c.env.DB.batch(pickSlots(c.env.DB, fresh));
  }
  await log(c.env.DB, me.id, "slot_pick", "user", userId, { person: person.name, week, picks: wanted.map(pickLabel) });
  return c.json({ ok: true });
});

// HR clears someone's picks for one week (this week if no ?week=); slots already started stay for attendance.
app.delete("/api/slot-picks/:userId", need("hr"), async (c) => {
  const userId = int(c.req.param("userId"));
  const q = c.req.query("week");
  const week = isWeek(q) ? q : thisWeek();
  const person = await c.env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(userId).first<{ name: string }>();
  if (!person) return bad("User not found", 404);
  const ids = (await c.env.DB.prepare("SELECT id FROM slot_picks WHERE user_id = ? AND week = ?").bind(userId, week).all<{ id: number }>()).results.map((p) => p.id);
  if (ids.length) await c.env.DB.batch(dropPicks(c.env.DB, userId, ids));
  await log(c.env.DB, c.get("user").id, "slot_pick_clear", "user", userId, { person: person.name, week });
  return c.json({ ok: true });
});

// ---------- slot swaps & shift requests ----------
app.get("/api/slot-swaps/active-slots", async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const now = nowIso();
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.user_id, u.name AS user_name, s.starts_at, s.ends_at, s.note, s.pick_id
     FROM slots s JOIN users u ON u.id = s.user_id
     WHERE s.ends_at > ? AND u.active = 1 AND u.approved = 1
     ORDER BY s.starts_at, u.name LIMIT 500`
  ).bind(now).all<Slot>();
  return c.json({
    my_slots: rows.results.filter((s) => s.user_id === me.id),
    other_slots: rows.results.filter((s) => s.user_id !== me.id),
  });
});

app.post("/api/slot-swaps", async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  type Body = { my_slot_id: number; their_slot_id: number; note?: string };
  const body = await c.req.json<Body>().catch(() => ({} as Body));
  const mySlotId = int(body.my_slot_id);
  const theirSlotId = int(body.their_slot_id);
  if (!mySlotId || !theirSlotId) return bad("Select your slot and their slot to swap");
  if (mySlotId === theirSlotId) return bad("Cannot swap a slot with itself");

  const now = nowIso();
  const mySlot = await c.env.DB.prepare("SELECT * FROM slots WHERE id = ? AND user_id = ? AND ends_at > ?").bind(mySlotId, me.id, now).first<Slot>();
  if (!mySlot) return bad("Your selected slot was not found or has already ended", 400);

  const theirSlot = await c.env.DB.prepare("SELECT s.*, u.name AS user_name FROM slots s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.ends_at > ? AND u.active = 1").bind(theirSlotId, now).first<Slot>();
  if (!theirSlot) return bad("Their selected slot was not found or has already ended", 400);
  if (theirSlot.user_id === me.id) return bad("You cannot swap with yourself", 400);

  const pending = await c.env.DB.prepare(
    "SELECT id FROM slot_swaps WHERE status = 'pending' AND (from_slot_id IN (?,?) OR to_slot_id IN (?,?)) LIMIT 1"
  ).bind(mySlotId, theirSlotId, mySlotId, theirSlotId).first();
  if (pending) return bad("There is already a pending swap request for one of these slots", 409);

  const note = body.note?.trim() || null;
  const res = await c.env.DB.prepare(
    "INSERT INTO slot_swaps (from_user_id, to_user_id, from_slot_id, to_slot_id, note, status) VALUES (?,?,?,?,?,'pending')"
  ).bind(me.id, theirSlot.user_id, mySlotId, theirSlotId, note).run();

  await log(c.env.DB, me.id, "slot_swap_request", "slot_swap", res.meta.last_row_id as number, { to_user: theirSlot.user_name });
  return c.json({ ok: true, swap_id: res.meta.last_row_id });
});

app.post("/api/slot-swaps/:id/accept", async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const swap = await c.env.DB.prepare("SELECT * FROM slot_swaps WHERE id = ? AND status = 'pending'").bind(id).first<any>();
  if (!swap) return bad("Swap request not found or already handled", 404);
  if (swap.to_user_id !== me.id && !hasScope(me, "hr")) {
    return bad("Only the requested member or HR can accept this swap", 403);
  }

  const now = nowIso();
  const [s1, s2] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT * FROM slots WHERE id = ?").bind(swap.from_slot_id),
    c.env.DB.prepare("SELECT * FROM slots WHERE id = ?").bind(swap.to_slot_id),
  ]);
  const slot1 = s1.results[0] as Slot | undefined;
  const slot2 = s2.results[0] as Slot | undefined;
  if (!slot1 || !slot2) return bad("One of the slots no longer exists", 400);
  if (slot1.ends_at <= now || slot2.ends_at <= now) {
    return bad("One of the slots has already ended and cannot be swapped", 400);
  }
  if (slot1.user_id !== swap.from_user_id || slot2.user_id !== swap.to_user_id) {
    return bad("One of the slots has changed hands since this swap was asked for", 409);
  }

  // A swapped slot is a one-off for that week: it leaves its weekly pick, so the weekly grid shows it in amber and
  // changing either person's picks later never deletes it.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE slots SET user_id = ?, pick_id = NULL WHERE id = ?").bind(swap.to_user_id, swap.from_slot_id),
    c.env.DB.prepare("UPDATE slots SET user_id = ?, pick_id = NULL WHERE id = ?").bind(swap.from_user_id, swap.to_slot_id),
    c.env.DB.prepare("UPDATE slot_swaps SET status = 'accepted', responded_at = ? WHERE id = ?").bind(now, swap.id),
  ]);

  await log(c.env.DB, me.id, "slot_swap_accept", "slot_swap", swap.id);
  return c.json({ ok: true });
});

app.post("/api/slot-swaps/:id/decline", async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const swap = await c.env.DB.prepare("SELECT * FROM slot_swaps WHERE id = ? AND status = 'pending'").bind(id).first<any>();
  if (!swap) return bad("Swap request not found or already handled", 404);
  if (swap.to_user_id !== me.id && swap.from_user_id !== me.id && !hasScope(me, "hr")) {
    return bad("You cannot cancel or decline this swap", 403);
  }
  const status = swap.from_user_id === me.id ? "cancelled" : "declined";
  await c.env.DB.prepare("UPDATE slot_swaps SET status = ?, responded_at = ? WHERE id = ?").bind(status, nowIso(), swap.id).run();
  return c.json({ ok: true, status });
});

app.post("/api/shift-requests", async (c) => {
  await ensureSwapTables(c.env.DB);
  const user = c.get("user");
  await closeExpiredShifts(c.env.DB);
  const open = await c.env.DB.prepare("SELECT id FROM shifts WHERE user_id = ? AND ended_at IS NULL").bind(user.id).first();
  if (open) return bad("You already have an open shift", 409);

  const existing = await c.env.DB.prepare("SELECT id FROM shift_requests WHERE user_id = ? AND status = 'pending'").bind(user.id).first<{ id: number }>();
  if (existing) return c.json({ ok: true, request_id: existing.id, message: "Request already pending" });

  const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  const res = await c.env.DB.prepare("INSERT INTO shift_requests (user_id, note) VALUES (?,?)").bind(user.id, body.note?.trim() || null).run();
  await log(c.env.DB, user.id, "shift_request", "shift_request", res.meta.last_row_id as number);
  return c.json({ ok: true, request_id: res.meta.last_row_id });
});

app.post("/api/shift-requests/:id/approve", need("hr"), async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const req = await c.env.DB.prepare("SELECT r.*, u.name AS user_name FROM shift_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status = 'pending'").bind(id).first<any>();
  if (!req) return bad("Shift request not found or already reviewed", 404);

  await closeExpiredShifts(c.env.DB);
  const open = await c.env.DB.prepare("SELECT id FROM shifts WHERE user_id = ? AND ended_at IS NULL").bind(req.user_id).first<{ id: number }>();
  let shiftId = open ? open.id : null;
  if (!open) {
    const res = await c.env.DB.prepare("INSERT INTO shifts (user_id) VALUES (?)").bind(req.user_id).run();
    shiftId = res.meta.last_row_id;
    await log(c.env.DB, req.user_id, "shift_start", "shift", shiftId as number, { approved_by: me.name });
  }
  await c.env.DB.prepare("UPDATE shift_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(me.id, nowIso(), req.id).run();
  return c.json({ ok: true, shift_id: shiftId });
});

app.post("/api/shift-requests/:id/reject", need("hr"), async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const req = await c.env.DB.prepare("SELECT * FROM shift_requests WHERE id = ? AND status = 'pending'").bind(id).first();
  if (!req) return bad("Shift request not found or already reviewed", 404);
  await c.env.DB.prepare("UPDATE shift_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(me.id, nowIso(), id).run();
  return c.json({ ok: true });
});

app.get("/api/notifications", async (c) => {
  await ensureSwapTables(c.env.DB);
  const me = c.get("user");
  const isHrOrAdmin = hasScope(me, "hr");

  const [swaps, shiftRequests, myShiftRequest] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT w.id, w.from_user_id, u1.name AS from_user_name, w.to_user_id, u2.name AS to_user_name,
              w.from_slot_id, s1.starts_at AS from_slot_start, s1.ends_at AS from_slot_end,
              w.to_slot_id, s2.starts_at AS to_slot_start, s2.ends_at AS to_slot_end,
              w.status, w.note, w.created_at, w.responded_at
       FROM slot_swaps w
       JOIN users u1 ON u1.id = w.from_user_id
       JOIN users u2 ON u2.id = w.to_user_id
       JOIN slots s1 ON s1.id = w.from_slot_id
       JOIN slots s2 ON s2.id = w.to_slot_id
       WHERE (w.to_user_id = ? AND w.status = 'pending')
          OR (w.from_user_id = ? AND w.status IN ('accepted', 'declined') AND w.responded_at >= datetime('now', '-1 day'))
       ORDER BY w.id DESC LIMIT 20`
    ).bind(me.id, me.id),
    isHrOrAdmin
      ? c.env.DB.prepare(
          `SELECT r.id, r.user_id, u.name AS user_name, r.status, r.reviewed_by, r.note, r.created_at, r.reviewed_at
           FROM shift_requests r JOIN users u ON u.id = r.user_id
           WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 20`
        )
      : c.env.DB.prepare("SELECT 1 WHERE 1 = 0"),
    c.env.DB.prepare(
      `SELECT r.id, r.user_id, u.name AS user_name, r.status, r.reviewed_by, rev.name AS reviewed_by_name, r.note, r.created_at, r.reviewed_at
       FROM shift_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users rev ON rev.id = r.reviewed_by
       WHERE r.user_id = ? AND (r.status = 'pending' OR r.created_at >= datetime('now', '-2 hours'))
       ORDER BY r.id DESC LIMIT 1`
    ).bind(me.id),
  ]);

  return c.json({
    swaps: swaps.results,
    shift_requests: isHrOrAdmin ? shiftRequests.results : [],
    my_shift_request: myShiftRequest.results[0] ?? null,
  });
});

// ---------- coupons & promo codes ----------
type DiscountCodeRow = { id: number; code: string; kind: "coupon" | "promo"; sponsor_id: number | null; sponsor_name: string | null; discount_type: "fixed" | "percent"; value: number; min_order: number; max_uses: number | null; uses: number; expires_on: string | null; active: number };

async function findCode(db: D1Database, raw: string, subtotal: number): Promise<{ error: string } | { code: DiscountCodeRow; discount: number }> {
  const code = await db.prepare("SELECT d.*, s.name AS sponsor_name FROM discount_codes d LEFT JOIN sponsors s ON s.id = d.sponsor_id WHERE d.code = ?").bind(raw.trim()).first<DiscountCodeRow>();
  if (!code || !code.active) return { error: "That code isn't valid" };
  if (code.expires_on && code.expires_on < pkToday()) return { error: `That code expired on ${code.expires_on}` };
  if (code.max_uses != null && code.uses >= code.max_uses) return { error: "That code has already been used" };
  if (subtotal < code.min_order) return { error: `That code needs an order of at least Rs ${code.min_order}` };
  const discount = discountFor(code, subtotal);
  if (discount <= 0) return { error: "That code gives no discount on this order" };
  return { code, discount };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => "KH-" + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

app.post("/api/codes/check", onShift, async (c) => {
  const body = await c.req.json<{ code: string; subtotal: number }>();
  if (!body.code?.trim()) return bad("Enter a code");
  const r = await findCode(c.env.DB, body.code, int(body.subtotal, 0));
  if ("error" in r) return bad(r.error);
  const { id, code, kind, discount_type, value, min_order, sponsor_name } = r.code;
  return c.json({ rule: { id, code, kind, discount_type, value, min_order, sponsor_name }, discount: r.discount });
});

app.get("/api/codes", adminOnly, async (c) => {
  const db = c.env.DB;
  const [sponsors, codes] = await db.batch([
    db.prepare(
      `SELECT sp.id, sp.name, sp.contact,
         (SELECT COUNT(*) FROM discount_codes d WHERE d.sponsor_id = sp.id) AS coupons,
         (SELECT COUNT(*) FROM sales s JOIN discount_codes d ON d.id = s.code_id WHERE d.sponsor_id = sp.id AND s.voided_at IS NULL) AS redeemed,
         (SELECT COALESCE(SUM(s.discount),0) FROM sales s JOIN discount_codes d ON d.id = s.code_id WHERE d.sponsor_id = sp.id AND s.voided_at IS NULL) AS owed
       FROM sponsors sp ORDER BY sp.name`,
    ),
    db.prepare("SELECT d.*, s.name AS sponsor_name FROM discount_codes d LEFT JOIN sponsors s ON s.id = d.sponsor_id ORDER BY d.id DESC LIMIT 1000"),
  ]);
  return c.json({ sponsors: sponsors.results, codes: codes.results });
});

app.post("/api/sponsors", adminOnly, async (c) => {
  const body = await c.req.json<{ name: string; contact?: string }>();
  if (!body.name?.trim()) return bad("Sponsor name is required");
  const res = await c.env.DB.prepare("INSERT INTO sponsors (name, contact) VALUES (?,?)").bind(body.name.trim(), body.contact?.trim() || null).run();
  await log(c.env.DB, c.get("user").id, "sponsor_add", "sponsor", res.meta.last_row_id as number, { name: body.name });
  return c.json({ id: res.meta.last_row_id });
});

app.post("/api/codes", adminOnly, async (c) => {
  const body = await c.req.json<{ kind: string; sponsor_id?: number; count?: number; code?: string; discount_type: string; value: number; min_order?: number; max_uses?: number | null; expires_on?: string | null }>();
  const discount_type = body.discount_type === "percent" ? "percent" : "fixed";
  const value = int(body.value, 0);
  if (value <= 0 || (discount_type === "percent" && value > 100)) return bad(discount_type === "percent" ? "Percent must be 1 to 100" : "Amount must be more than zero");
  const min_order = Math.max(0, int(body.min_order, 0));
  const expires_on = body.expires_on?.trim() || null;
  if (expires_on && !/^\d{4}-\d{2}-\d{2}$/.test(expires_on)) return bad("Bad expiry date");
  const user = c.get("user");
  const insert = (code: string, kind: string, sponsorId: number | null, maxUses: number | null) =>
    c.env.DB.prepare("INSERT INTO discount_codes (code, kind, sponsor_id, discount_type, value, min_order, max_uses, expires_on, created_by) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(code, kind, sponsorId, discount_type, value, min_order, maxUses, expires_on, user.id);

  if (body.kind === "coupon") {
    const sponsor = await c.env.DB.prepare("SELECT id, name FROM sponsors WHERE id = ?").bind(int(body.sponsor_id, 0)).first<{ id: number; name: string }>();
    if (!sponsor) return bad("Pick a sponsor");
    const count = int(body.count, 1);
    if (count < 1 || count > 200) return bad("Issue between 1 and 200 coupons at a time");
    const codes = new Set<string>();
    while (codes.size < count) codes.add(randomCode());
    await c.env.DB.batch([...codes].map((code) => insert(code, "coupon", sponsor.id, 1)));
    await log(c.env.DB, user.id, "coupons_issue", "sponsor", sponsor.id, { count, discount_type, value, expires_on });
    return c.json({ codes: [...codes] });
  }

  const code = (body.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) return bad("Promo codes are 3 to 20 letters, digits or dashes");
  const taken = await c.env.DB.prepare("SELECT 1 FROM discount_codes WHERE code = ?").bind(code).first();
  if (taken) return bad("That code already exists");
  const max_uses = body.max_uses == null || body.max_uses === ("" as any) ? null : int(body.max_uses);
  if (max_uses != null && max_uses < 1) return bad("Usage limit must be at least 1");
  await insert(code, "promo", null, max_uses).run();
  await log(c.env.DB, user.id, "promo_create", "code", undefined, { code, discount_type, value, max_uses, expires_on });
  return c.json({ codes: [code] });
});

app.put("/api/codes/:id", adminOnly, async (c) => {
  const id = int(c.req.param("id"));
  const body = await c.req.json<{ active: boolean }>();
  await c.env.DB.prepare("UPDATE discount_codes SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
  await log(c.env.DB, c.get("user").id, body.active ? "code_enable" : "code_disable", "code", id);
  return c.json({ ok: true });
});

// ---------- activity log ----------
app.get("/api/activity", async (c) => {
  const limit = Math.min(int(c.req.query("limit"), 100), 500);
  const before = c.req.query("before");
  const kind = c.req.query("kind"); // sales | stock | items | team | all
  const where: string[] = []; const args: unknown[] = [];
  if (before) { where.push("a.id < ?"); args.push(int(before)); }
  const kinds: Record<string, string> = { sales: "a.action IN ('sale','sale_void')", stock: "a.action LIKE 'stock_%'", items: "a.action LIKE 'item_%'", team: "a.action IN ('user_join','user_update','user_approve','login','shift_start','shift_end','slot_create','slot_delete','slot_pick','slot_pick_clear')" };
  if (kind && kinds[kind]) where.push(kinds[kind]);
  const rows = await c.env.DB.prepare(
    `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`,
  )
    .bind(...args, limit)
    .all();
  return c.json({ activity: rows.results, has_more: rows.results.length === limit });
});

// ---------- stats ----------
// Everything on the Stats page, also used by the MCP server.
async function computeStats(db: D1Database): Promise<Stats> {
  // Pakistan Standard Time is UTC+5 all year; group days in local time.
  const tz = "+5 hours";
  const day = `date(created_at, '${tz}')`;
  const today = `${day} = date('now', '${tz}')`;
  const week = `${day} >= date('now', '${tz}', '-6 days')`;
  const live = "voided_at IS NULL";

  // Cost of goods per sale: what we paid for each line. Lines sold before a buy price was set use today's buy price.
  const lineCost = "si.qty * COALESCE(si.unit_cost, i.cost)";
  const cost = `(SELECT COALESCE(SUM(${lineCost}),0) FROM sale_items si LEFT JOIN items i ON i.id = si.item_id WHERE si.sale_id = sales.id)`;
  const noCost = `(SELECT COALESCE(SUM(si.qty),0) FROM sale_items si LEFT JOIN items i ON i.id = si.item_id WHERE si.sale_id = sales.id AND COALESCE(si.unit_cost, i.cost) IS NULL)`;
  const money = `COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(total - ${cost}),0) AS profit, COUNT(*) AS sales`;

  const [t, w, a, byDay, byCashier, topItems, lowStock, byHour, paySplit, missing, stockValue, last24] = await db.batch([
    db.prepare(`SELECT ${money},
      (SELECT COALESCE(SUM(qty),0) FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.extra = 0 AND s.${live} AND ${today.replace(/created_at/g, "s.created_at")}) AS items
      FROM sales WHERE ${live} AND ${today}`),
    db.prepare(`SELECT ${money} FROM sales WHERE ${live} AND ${week}`),
    db.prepare(`SELECT ${money} FROM sales WHERE ${live}`),
    db.prepare(`SELECT ${day} AS day, ${money} FROM sales WHERE ${live} AND ${day} >= date('now','${tz}','-13 days') GROUP BY day ORDER BY day`),
    // Leaderboard: ranked by the profit each person's sales made, not revenue.
    db.prepare(`SELECT sales.user_id, u.name, ${money} FROM sales JOIN users u ON u.id = sales.user_id WHERE sales.${live} GROUP BY sales.user_id ORDER BY profit DESC, sales DESC`),
    db.prepare(`SELECT si.item_id, si.name, SUM(CASE WHEN si.extra = 1 THEN 0 ELSE si.qty END) AS qty, SUM(si.qty*si.unit_price) AS revenue, SUM(si.qty*si.unit_price) - COALESCE(SUM(${lineCost}),0) AS profit
      FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN items i ON i.id = si.item_id WHERE s.${live} GROUP BY si.item_id ORDER BY qty DESC LIMIT 50`),
    db.prepare(`SELECT id, name, stock, low_stock_at FROM items WHERE archived = 0 AND stock <= low_stock_at ORDER BY stock ASC LIMIT 20`),
    db.prepare(`SELECT CAST(strftime('%H', created_at, '${tz}') AS INTEGER) AS hour, COUNT(*) AS sales FROM sales WHERE ${live} GROUP BY hour ORDER BY hour`),
    db.prepare(`SELECT payment, SUM(total) AS revenue, COUNT(*) AS sales FROM sales WHERE ${live} GROUP BY payment`),
    db.prepare(`SELECT COALESCE(SUM(${noCost}),0) AS units FROM sales WHERE ${live}`),
    db.prepare(`SELECT COALESCE(SUM(stock * cost),0) AS at_cost, COALESCE(SUM(stock * price),0) AS at_price,
      COALESCE(SUM(stock * (price - cost)),0) AS profit, SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS no_cost
      FROM items WHERE archived = 0 AND stock > 0`),
    // Hour by hour for the last 24 hours, labelled in Pakistan time.
    db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', created_at, '${tz}') AS hour, ${money} FROM sales
      WHERE ${live} AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') GROUP BY hour ORDER BY hour`),
  ]);

  const items = topItems.results as Stats["top_items"];
  const stats: Stats = {
    today: t.results[0] as any,
    week: w.results[0] as any,
    all: a.results[0] as any,
    by_day: byDay.results as any,
    by_cashier: byCashier.results as any,
    top_items: items.slice(0, 10),
    top_profit: [...items].sort((x, y) => y.profit - x.profit).slice(0, 10),
    low_stock: lowStock.results as any,
    by_hour: byHour.results as any,
    payment_split: paySplit.results as any,
    units_without_cost: (missing.results[0] as any).units,
    stock_value: stockValue.results[0] as any,
    last_24h: last24.results as any,
  };
  return stats;
}

app.get("/api/stats", async (c) => c.json(await computeStats(c.env.DB)));

// Everything the Stats charts only show a slice of, for their History view. Same profit rule as computeStats().
app.get("/api/stats/history", async (c) => {
  const db = c.env.DB;
  const tz = "+5 hours";
  const live = "voided_at IS NULL";
  const lineCost = "si.qty * COALESCE(si.unit_cost, i.cost)";
  const cost = `(SELECT COALESCE(SUM(${lineCost}),0) FROM sale_items si LEFT JOIN items i ON i.id = si.item_id WHERE si.sale_id = sales.id)`;
  const money = `COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(total - ${cost}),0) AS profit, COUNT(*) AS sales`;
  const [byHour, byDay, items] = await db.batch([
    db.prepare(`SELECT strftime('%Y-%m-%dT%H:00', created_at, '${tz}') AS hour, ${money} FROM sales WHERE ${live} GROUP BY hour ORDER BY hour DESC`),
    db.prepare(`SELECT date(created_at, '${tz}') AS day, ${money} FROM sales WHERE ${live} GROUP BY day ORDER BY day`),
    db.prepare(`SELECT si.item_id, si.name, SUM(CASE WHEN si.extra = 1 THEN 0 ELSE si.qty END) AS qty, SUM(si.qty*si.unit_price) AS revenue, SUM(si.qty*si.unit_price) - COALESCE(SUM(${lineCost}),0) AS profit
      FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN items i ON i.id = si.item_id WHERE s.${live} GROUP BY si.item_id ORDER BY qty DESC`),
  ]);
  const out: StatsHistory = { by_hour: byHour.results as any, by_day: byDay.results as any, items: items.results as any };
  return c.json(out);
});

// The signed-in admin's connected agents (from /mcp), and disconnecting one.
app.get("/api/mcp/connections", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.client_id, c.client_name, MIN(t.created_at) AS connected_at, MAX(t.last_used_at) AS last_used_at, MAX(t.scope) AS scope
     FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
     WHERE t.user_id = ? AND t.expires_at > ? GROUP BY t.client_id ORDER BY connected_at DESC`,
  ).bind(c.get("user").id, nowIso()).all();
  return c.json({ connections: rows.results });
});
app.delete("/api/mcp/connections/:client_id", async (c) => {
  const user = c.get("user");
  const r = await c.env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND client_id = ?").bind(user.id, c.req.param("client_id")).run();
  if (r.meta.changes) await log(c.env.DB, user.id, "mcp_disconnect", undefined, undefined, { client_id: c.req.param("client_id") });
  return c.json({ ok: true });
});

// Read-only MCP server for admins' agents (Claude Code, Codex…), with its own OAuth on top of Google sign-in.
// Runs one API route as `user`, exactly as if they'd pressed the button on the site: same guards, same activity log.
async function agentRequest(c: any, user: User, method: string, path: string, body?: unknown) {
  const req = new Request(new URL(path, c.req.url), { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await app.fetch(req, { ...c.env, AGENT_USER: user }, c.executionCtx);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

registerMcp(app, { sessionUser, userById, computeStats, log, agentRequest, sessionCookie: SESSION_COOKIE, limited });

app.notFound((c) => (new URL(c.req.url).pathname.startsWith("/api/") ? bad("Not found", 404) : c.env.ASSETS.fetch(c.req.raw)));
app.onError((err, c) => {
  console.error(err);
  return bad(err.message || "Server error", 500);
});

void authed;
export default {
  fetch: app.fetch,
  // Cron, every minute: pull new payment emails, close expired shifts and store the daily attendance report.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncPayments(env).catch((e) => console.error("payment sync failed", e)));
    ctx.waitUntil(closeExpiredShifts(env.DB).catch((e) => console.error("closing shifts failed", e)));
    ctx.waitUntil(storeDailyReport(env.DB).catch((e) => console.error("attendance report failed", e)));
    // Registered MCP clients that never got a token (anyone can register one) go after a day.
    ctx.waitUntil(env.DB.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes)").bind(new Date(Date.now() - 86400_000).toISOString()).run().catch((e) => console.error("oauth client cleanup failed", e)));
    ctx.waitUntil(env.DB.prepare("DELETE FROM request_locks WHERE created_at < ?").bind(new Date(Date.now() - 3600_000).toISOString()).run().catch(() => {}));
  },
};
