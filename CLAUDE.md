# Notes for contributors and coding agents

Read `README.md` and `LEARNINGS.md` first. The rules below keep the numbers right; please don't break them.

- One Cloudflare Worker (`worker/index.ts`, Hono) + Vite React SPA (`src/`), shared types in `shared/types.ts`.
  `npm run build` emits `dist/client` (assets) and `dist/khaapa` (worker). Always build before `wrangler deploy`:
  the Vite plugin points wrangler at the generated config.
- Schema changes: add `migrations/000N_name.sql` (never edit an applied one), then `npm run db:migrate`.
- **Stock** changes only through a sale, a void, `POST /api/items/:id/stock` or the stock field on `PUT /api/items/:id`
  (logged as a correction). Each writes `stock_moves` and `activity_log`. Never `UPDATE items.stock` without both.
  Items that never sold can be deleted; anything sold can only be archived.
- **Every sale** goes through `insertSale()` and every void through `voidSale()`, including pre-orders marked paid.
- **Prices** take up to 2 decimals: `parsePrice()`, `round2()`, `rs()`, `priceInput()` in `shared/types.ts`.
- **Profit** = `sales.total` − buy price × qty. Each sale line freezes the buy price at sale time
  (`sale_items.unit_cost`); changing `items.cost` never rewrites the past, except lines that never had a buy price
  take the first one set (`fillMissingCosts()`). Stock moves record the buy price at the time too.
- **"Extra on top"** is one `sale_items` row with `extra = 1` on the Stickers item (`EXTRA_ITEM`): no stock, no stock
  move, `unit_cost` 0, left out of unit counts.
- **Double taps**: keep all three guards on new write paths: `api()` in `src/api.ts` drops identical in-flight
  changes, the `/api/*` dedupe middleware refuses repeats within `DEDUPE_MS`, and save buttons disable while saving.
- **Access**: approved users see everything; selling, stock, prices, payments and pre-orders need an open shift
  (`onShift` / `canOperate()`). HR approves people and runs the schedule; admins also own coupons, the payment
  inbox and settings. `role` / `is_hr` mirror `users.scopes` and are written only by `PUT /api/users/:id`.
- **Shifts** close themselves after `SHIFT_MINUTES` (`closeExpiredShifts()`).
- **Slot picks** are per week and never repeat; the per-block cap is the `slot_picks_cap` trigger. Swapped slots
  become one-offs (`pick_id` cleared).
- **Payments** are never matched to sales automatically.
- **UX**: never tell people where to go to fix something; open the fix in place (`src/components/ItemDialogs.tsx`).
- **MCP** (`worker/mcp.ts`): read tools are open to every approved member and never write. Write tools must call an
  API route through `agentRequest()`, never SQL. `run_sql` must keep its guards (single SELECT/WITH, row cap,
  hidden tables checked with quotes stripped, named columns on tables with secret columns). Tool descriptions are
  seen by every agent.
