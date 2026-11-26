# Khaapa (open source)

A complete point-of-sale and back office for a small student-run shop, running entirely on Cloudflare (one Worker,
D1, R2). It grew out of **Khaapa**, a tuck shop a group of students ran for an entrepreneurship class, and has been
used for real at the counter every day: real sales, real stock, real shift rotas, real money.

It's released under the MIT license so other student shops, canteens and pop-ups can use it, and so the lessons
from running it ([LEARNINGS.md](LEARNINGS.md)) are useful to anyone building something similar.

## What's in it

- **Public menu** at `/`: items, prices, photos, live in / low / sold-out status and an "open now" badge.
- **Pre-orders** at `/preorder`: customers pick items for today or tomorrow, pay by mobile wallet, send the
  screenshot on WhatsApp (or upload it); staff mark it paid, which books it as an online sale.
- **Counter (POS)** at `/pos`: tap items, charge cash or online, stock drops automatically. Press and hold a tile
  (right-click on desktop) to edit the item, restock, write off or count it, and see its stock history.
- **Back office**: stats (revenue, profit, best sellers, cashier leaderboard), sales with void, shifts,
  a full activity log, menu items with photo upload, coupons and promo codes, online payments, team management.
- **Schedule**: weekly slot picking (people pick their own blocks, with a per-block cap enforced by a trigger),
  one-off slots assigned by HR, slot swaps between people, and attendance built from real shift start/end times,
  with a daily CSV report.
- **Online payments from email**: a connected Gmail inbox is read every minute and wallet "money received" emails
  become payments that staff link to sales in one tap (never automatically; see LEARNINGS).
- **An MCP server for AI agents** at `/mcp`: every approved member can connect Claude Code, Codex, Cursor or the
  Claude app and ask questions in plain language ("what should we restock tomorrow?"). OAuth 2.1 with dynamic client
  registration and PKCE, read-only by default, with a guarded read-only SQL tool. Optional write tools reuse the
  site's own API routes, so every guard and log entry is the same as pressing the button.

## Who can do what

| Role | What they can do |
|---|---|
| User (anyone HR or an admin approved) | See everything. **After starting a shift:** sell, void their own sales, edit menu items and prices, restock / write off / count stock, set buy prices, link payments, handle pre-orders. Everything is logged under their name. |
| HR | Approve people and make them HR. Schedule, slots, attendance. |
| Admin | Everything HR does, plus granting admin, coupons, the payment inbox and pre-order settings. Can act without a shift. |

Sign-in is Google only, restricted to one email domain (`ALLOWED_EMAIL_DOMAIN`, e.g. your university). New accounts
see nothing until approved. `OWNER_EMAIL` is always admin and can't be demoted. Shifts close themselves after 60 minutes.

## Stack

- Cloudflare Worker + [Hono](https://hono.dev) API (`worker/`), React 19 + Vite + Tailwind v4 SPA (`src/`),
  shared types in `shared/types.ts`. Built with `@cloudflare/vite-plugin`.
- **D1** (SQLite) for data, schema in `migrations/`. **R2** for item photos and payment screenshots.
- Google OAuth handled in the Worker itself, then a session cookie backed by the `sessions` table.
- Money is PKR; prices take up to 2 decimals. Days are grouped in Pakistan time (UTC+5). Change `pkToday()` and the
  `+5 hours` offsets if you're elsewhere.

## Run your own

You need a Cloudflare account (the free plan is enough) and a Google Cloud OAuth client.

```bash
git clone https://github.com/ZaynIkhlaq/khaapa-oss && cd khaapa-oss
npm install
npx wrangler login                          # or export CLOUDFLARE_API_TOKEN=...
npx wrangler d1 create khaapa               # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create khaapa-images
```

Then edit `wrangler.jsonc`:

- `GOOGLE_CLIENT_ID`: your OAuth client (Google Cloud Console → APIs & Services → Credentials, type "Web application").
  Add redirect URIs `https://<your-domain>/api/auth/google/callback` and `http://localhost:5173/api/auth/google/callback`.
- `ALLOWED_EMAIL_DOMAIN`: who may sign in, e.g. `example.edu`.
- `OWNER_EMAIL`: your own address; always admin.
- `routes` and `CANONICAL_HOST`: your custom domain, or remove the route to use `*.workers.dev`.

Secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOKEN_KEY           # any long random string; encrypts the Gmail refresh token
```

Make it yours: the shop's place in `SHOP_PLACE` (`shared/types.ts`), the title and description in `index.html`,
the logo and icons in `public/`, the menu categories in `CATEGORIES`, and slot times in `PICK_TIMES`.

Deploy:

```bash
npm run db:migrate                          # applies the schema to the remote D1
npm run deploy                              # builds and deploys the Worker
```

Open the site, sign in with `OWNER_EMAIL`, add menu items, and approve your team on the Team page.

`.github/workflows/deploy.yml` deploys on every push to `main` (type check, build, migrations, `wrangler deploy`)
once you add a `CLOUDFLARE_API_TOKEN` repository secret.

### Local dev

```bash
npm run db:migrate:local
npm run dev                                 # http://localhost:5173
```

Create `.dev.vars` first with `GOOGLE_CLIENT_SECRET=...`, `TOKEN_KEY=...` and `OWNER_EMAIL=you@example.edu`.

## Online payments via Gmail (optional)

Wallet apps like NayaPay email you when money arrives. Instead of integrating a payment API, Khaapa reads that inbox:

- An admin opens **Payments** and makes a one-time connect link (valid 24 h). The inbox owner opens it, signs in with
  Google and grants read-only Gmail access. They don't need a Khaapa account.
- The refresh token is stored AES-GCM encrypted in D1, keyed by `TOKEN_KEY`.
- A cron trigger runs every minute, searches with `PAYMENT_EMAIL_QUERY` (default `from:nayapay`), parses amount,
  sender and reference (`worker/gmail.ts`, deliberately tolerant; raw text is kept so you can re-parse) and stores
  incoming payments. Linking a payment to a sale is always a person's tap.

Google Cloud: enable the Gmail API, add the `gmail.readonly` scope, and add `https://<your-domain>/api/gmail/callback`
as a redirect URI. Unverified apps show a warning; the inbox owner continues via Advanced.

## Connect an AI agent (MCP)

```bash
# Claude Code
claude mcp add --transport http khaapa https://<your-domain>/mcp
# then run /mcp inside Claude Code, pick "khaapa" → Authenticate

# Codex
codex mcp add khaapa --url https://<your-domain>/mcp
codex mcp login khaapa
```

Opening `/mcp` in a browser shows a setup guide with copyable commands for each client and the person's connected
agents. Read tools: `overview`, `sales`, `inventory`, `shifts`, `attendance`, `activity_log`, `payments`,
`preorders`, `team`, `describe_schema`, `run_sql`. `run_sql` accepts a single SELECT, returns at most 1000 rows and can
never read sessions, OAuth tokens, the mail connection or pre-order tokens.

Write access is off for everyone except `OWNER_EMAIL` (set `users.mcp_write = 1` by SQL to allow someone else). It
applies only to a connection approved as "Read and make changes", and every action shows up in the activity log
tagged "via AI agent".

## Docs

- [LEARNINGS.md](LEARNINGS.md): what running a real shop on this taught us, and the rules the code follows because of it.
- [CLAUDE.md](CLAUDE.md): the invariants, for people (and coding agents) changing the code.

## License

[MIT](LICENSE)
