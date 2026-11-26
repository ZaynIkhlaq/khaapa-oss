# Learnings

Khaapa ran a real shop counter every weekday for a semester, staffed by a rotating team of students on phones and
laptops. Most of the code's rules exist because something went wrong once. This is the list, so you don't have to
learn them the same way.

## Money and stock

**Every stock change needs a reason and a trail.** Stock only changes through a sale, a void, or an explicit
restock / write-off / count, and each one writes a `stock_moves` row and an `activity_log` row in the same batch.
No code path updates `items.stock` on its own. When numbers look wrong (and they will), the trail is the only way to
tell a miscount from a bug from theft.

**A buy price applies from now on, never backwards.** We first recalculated profit on every past sale whenever a
buy price changed. That silently rewrote history: last week's profit changed because someone fixed a typo today.
Now each sale line freezes the buy price at the moment of sale (`sale_items.unit_cost`), and every stock move records
the buy price at that moment too, so write-offs are valued correctly. One exception: lines sold before an item had
any buy price take the first one entered. We also tried a moving average across batches and dropped it: buy prices
rarely change in a tuck shop, and nobody could explain the number at the counter.

**Allow paise from day one.** The buy-price box first stripped every non-digit, so a per-piece price like 9.16
(a pack of 12 for 110) was saved as 9, and profit was wrong until someone noticed. Prices now take two decimals,
totals are rounded with one helper, and agents get every number rounded so float noise (884.1999999) never shows.

**Swapped fields happen.** Someone created an item with selling price and buy price the wrong way round. Show
profit per unit right in the form so a negative margin is obvious before saving.

**Keep the audit log good enough to rebuild from.** Once we had to reconstruct historical buy prices for every past
sale. It worked only because each change logged `from` and `to`, and replaying the log reproduced today's values
exactly. Item creation originally didn't log the buy price; log every field that matters, at creation too.

**Never auto-match payments to sales.** Payment emails carry only an amount, and several customers pay the same
amount within a minute. The app lists recent unlinked payments at the counter and a person taps the right one.
Anything missed is linked later or marked "not a shop payment".

**Make cash the deliberate choice.** Most customers pay online, so Online is the default and resets after each
sale; cash asks for a confirmation. Otherwise online sales get recorded as cash and the drawer never balances.

## Double taps and flaky networks

A restock was saved three times in one go: a slow campus connection, an impatient thumb. One fix wasn't enough, so
there are three:

1. The client never sends an identical change (method + path + body) while the same one is in flight.
2. The server refuses the same change from the same person within 3 seconds (409), claiming a `request_locks` row
   atomically, and releases the key if the change fails.
3. Save buttons disable while saving.

Add all three to any new write path.

## People and shifts

**Shifts must end themselves.** People forget to end shifts, and attendance turns into nonsense. Shifts now close
automatically after 60 minutes (from a minute cron and on the next request) and log an automatic end; people start
a new one to keep going. Shifts open longer than 12 hours are flagged as forgotten.

**Gate actions on being on shift, not on roles.** Everyone approved can see everything. Selling, stock, prices,
payments and pre-orders need an open shift, which keeps the log honest about who was at the counter.

**Weekly slot picks shouldn't repeat.** We built "repeat every week" and then a cron to fill future weeks. It created
slots nobody remembered agreeing to. Now a pick is for one week only and people pick again each week; a per-block
cap is enforced by a database trigger so two people can't grab the last place at once.

**Swaps should turn slots into one-offs.** Accepting a swap changes who owns both slots and detaches them from the
weekly picks, so later edits to picks never delete a swapped slot.

**Approve people, don't trust a domain.** Sign-in is limited to one email domain, but anyone on that domain can
sign in. New accounts see nothing until HR or an admin approves them.

## UX at a counter

**Open the fix where the problem is.** Never tell someone where to go. A sold-out tile opens Restock; an empty search
offers "+ Add item"; an online sale links its payment right there; press and hold a tile to edit it. We deleted the
separate Inventory page because nobody went there mid-rush.

**Mobile first, one hand.** The counter is a phone held in one hand, so big tiles and two taps to charge.

## Agents (MCP)

**Agents are a great read interface.** Once the team could ask "what should we restock tomorrow?" in Claude, they
stopped asking the person who knew the numbers. Give every approved member read access by default.

**Writes go through the same routes as the buttons.** Agent write tools call the site's own API routes as the person,
so shift checks, admin checks, stock rules and logging are identical. Agent actions get tagged in the activity log.
Never let a write tool run SQL directly.

**Read-only SQL needs real guards.** One statement, SELECT/WITH only, a row cap, and a deny list of tables checked
with every quote character stripped (SQLite treats `"x"`, `'x'`, `[x]` and `` `x` `` as the same table name).
Tables with secret columns must be queried by named columns, never `*`.

**Customer text is data, not instructions.** Pre-order names, notes and payment texts are typed by strangers.
Tell the agent so in the server instructions.

**Follow the MCP auth spec exactly.** Protected-resource metadata, authorization-server metadata, dynamic client
registration, PKCE S256, refresh rotation, loopback redirect URIs matched by everything except the port. Clients are
strict, and each one breaks differently on a shortcut. Store tokens and codes hashed, and refuse framing on the
consent page.

## Cloudflare

- One Worker serving the SPA and the API keeps deploys atomic. Put `/api/*`, `/mcp`, `/oauth/*` and `/.well-known/*`
  in `run_worker_first`.
- With `@cloudflare/vite-plugin`, `wrangler deploy` reads the config generated at build time. Always build before
  deploying, or you ship stale config.
- Google only redirects back to registered hosts, so send sign-ins started on `*.workers.dev` to your custom domain.
- Rate-limit public endpoints per IP, but generously: a whole campus can sit behind one NAT address.
- SameSite=Lax cookies are still sent from sibling subdomains, so check `Origin` / `Sec-Fetch-Site` on writes.
