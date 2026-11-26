import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime } from "../api";
import { useAuth } from "../auth";
import { Button, Card, Logo, cx, toast } from "../components/ui";
import { SHOP_PLACE, hasScope, type User } from "../../shared/types";

// Public landing page and setup guide for the read-only MCP server. Agents talk to the same address with POST;
// browsers get this page. Every approved member can read everything through it (same levels as `allowed()` in
// worker/mcp.ts); only "Make changes" depends on the person.
const URL_ = `${location.origin}/mcp`;

type Client = "claude" | "codex" | "app" | "other";
type Connection = { client_id: string; client_name: string | null; connected_at: string; last_used_at: string | null; scope: "read" | "write" };
type Access = "member" | "hr" | "admin" | "write";

function Copy({ text, label, dark = true }: { text: string; label?: string; dark?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div>
      {label && <div className="mb-1.5 text-[12px] font-medium text-neutral-500">{label}</div>}
      <div className="relative">
        <pre className={cx("overflow-x-auto rounded-lg px-4 py-3 pr-20 font-mono text-[12.5px] leading-relaxed", dark ? "bg-ink text-neutral-100" : "whitespace-pre-wrap border border-line bg-white font-sans text-[13.5px] text-ink")}>{text}</pre>
        <button onClick={copy} className={cx("absolute right-2 top-2 rounded-md px-2.5 py-1 text-[12px] font-medium transition", done ? "bg-emerald-500 text-white" : dark ? "bg-white/10 text-neutral-200 hover:bg-white/20" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")}>
          {done ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

const SETUP: Record<Client, { name: string; steps: { label: string; cmd?: string; note?: ReactNode }[] }> = {
  claude: {
    name: "Claude Code",
    steps: [
      { label: "1. Add Khaapa (works in every project)", cmd: `claude mcp add --transport http --scope user khaapa ${URL_}` },
      { label: "2. Sign in", note: <>Start Claude Code, type <code className="rounded bg-neutral-100 px-1">/mcp</code>, pick <b>khaapa</b> and choose <b>Authenticate</b>. A browser opens: sign in with your school Google account and press <b>Allow</b>.</> },
      { label: "3. Check it's connected", cmd: "claude mcp list" },
    ],
  },
  codex: {
    name: "Codex",
    steps: [
      { label: "1. Add Khaapa", cmd: `codex mcp add khaapa --url ${URL_}` },
      { label: "2. Sign in (opens a browser)", cmd: "codex mcp login khaapa" },
      { label: "If Codex says remote servers aren't enabled, add this to ~/.codex/config.toml and try again", cmd: "experimental_use_rmcp_client = true" },
    ],
  },
  app: {
    name: "Claude app",
    steps: [
      { label: "1. Copy the address", cmd: URL_ },
      { label: "2. Add it as a connector", note: <>In Claude (web or desktop) open <b>Settings → Connectors → Add custom connector</b>, name it Khaapa and paste the address.</> },
      { label: "3. Sign in", note: <>Press <b>Connect</b>, sign in with your school Google account and press <b>Allow</b>. Then turn Khaapa on in any chat.</> },
    ],
  },
  other: {
    name: "Cursor & others",
    steps: [
      { label: "Cursor, Windsurf and similar: add to your MCP config file", cmd: JSON.stringify({ mcpServers: { khaapa: { url: URL_ } } }, null, 2) },
      { label: "Any other MCP client", note: <>Use the address <code className="rounded bg-neutral-100 px-1">{URL_}</code> with the Streamable HTTP transport. Sign-in is OAuth; your client opens the browser for you.</> },
    ],
  },
};

const READS: { access: Access; title: string; desc: string; tools: string }[] = [
  { access: "member", title: "Sales & profit", desc: "Revenue and profit for any day or range, best sellers, the leaderboard, every sale with its items.", tools: "overview · sales" },
  { access: "member", title: "Menu & stock", desc: "Prices, buy prices, what's on the shelf, what's running low, how fast things sell, restocks and write-offs.", tools: "inventory" },
  { access: "member", title: "Shifts & schedule", desc: "Who's on the counter now, past shifts and the slot schedule for the week ahead.", tools: "shifts" },
  { access: "member", title: "Payments & pre-orders", desc: "Online payments and whether they're linked to a sale, pre-orders and their status.", tools: "payments · preorders" },
  { access: "member", title: "Activity log", desc: "Who did what and when, filtered by action, person or date.", tools: "activity_log" },
  { access: "member", title: "Attendance & team", desc: "Hours per person, slots attended or missed, and everyone's account.", tools: "attendance · team" },
  { access: "member", title: "Anything else", desc: "Read-only SQL for questions the other tools don't cover.", tools: "describe_schema · run_sql" },
  { access: "write", title: "Make changes", desc: "Sell, void, restock, edit items and prices, move pre-orders, link payments, run the schedule, approve people. Only on a connection you approve as \"Read and make changes\"; every action lands in the activity log as you, via agent.", tools: "record_sale · adjust_stock · update_item · set_preorder_status · …" },
];
const BECAUSE: Record<Access, string> = { member: "", hr: "You're HR", admin: "You're an admin", write: "You can let agents act" };

const EXAMPLES = [
  "How did Khaapa do this week compared to last week? Revenue, profit and the top 5 items.",
  "What's running low, and how fast does it sell? What should we restock tomorrow?",
  "Which items make the most profit per unit, and which ones barely make any?",
  "Who's on the counter right now, and who's on the slot schedule tomorrow?",
  "Are there online payments today that were never linked to a sale?",
];

function can(user: User | null, a: Access) {
  if (!user?.approved) return false;
  const admin = hasScope(user, "admin");
  if (a === "member") return true;
  if (a === "hr") return !!user.is_hr || admin;
  if (a === "write") return !!user.mcp_write;
  return admin;
}

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

export default function Mcp() {
  const { user, loading } = useAuth();
  const member = !!user?.approved;
  const [client, setClient] = useState<Client>("claude");
  const [conns, setConns] = useState<Connection[] | null>(null);

  const load = () => api("/api/mcp/connections").then((d) => setConns(d.connections)).catch(() => setConns([]));
  useEffect(() => { if (member) load(); }, [member]);

  const disconnect = async (c: Connection) => {
    if (!confirm(`Disconnect ${c.client_name ?? "this agent"}? It will have to sign in again.`)) return;
    try { await api(`/api/mcp/connections/${c.client_id}`, { method: "DELETE" }); toast("Disconnected"); load(); } catch (e: any) { toast(e.message, true); }
  };

  const reads = READS.filter((r) => r.access === "member" || can(user, r.access));

  return (
    <div className="min-h-dvh">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <Logo className="h-7" />
            <span className="text-[13px] text-neutral-400">· for agents</span>
          </Link>
          <Link to={member ? "/pos" : "/login"} className="text-[13px] font-medium text-neutral-500 hover:text-ink">{member ? "Open the app" : "Staff login"}</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-line bg-neutral-50">
        <div className="mx-auto grid max-w-5xl gap-8 px-5 py-10 md:grid-cols-[1fr_340px] md:items-center lg:py-14">
          <div>
            <div className="mb-3 inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">MCP · read-only</div>
            <h1 className="max-w-xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Ask Khaapa anything, right from your AI agent.</h1>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-neutral-600">
              Connect Claude, Codex, Cursor or any MCP client to the shop's live numbers at {SHOP_PLACE.name}. Your agent sees exactly what you see on the site, and it can't change a thing.
            </p>
            <ul className="mt-5 grid gap-2 text-[13px] text-neutral-600 sm:grid-cols-3">
              {[can(user, "write") ? "Read-only unless you choose" : "Read-only, always", "Your access, nothing more", "Disconnect any time"].map((t) => (
                <li key={t} className="flex items-center gap-2"><span className="text-emerald-600"><Check /></span>{t}</li>
              ))}
            </ul>
          </div>

          {/* Who you are */}
          <Card className="p-5">
            {loading ? <p className="text-sm text-neutral-400">Checking your account…</p> : !user ? (
              <>
                <div className="text-[15px] font-semibold">Sign in to get started</div>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">Use your school Google account. Any approved member of the Khaapa team can connect an agent.</p>
                <a href="/api/auth/google?next=/mcp" className="mt-4 flex min-h-11 items-center justify-center rounded-lg bg-accent px-4 text-[14px] font-semibold text-white shadow-sm hover:bg-accent/90">Sign in with Google</a>
              </>
            ) : member ? (
              <>
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-emerald-50 text-emerald-700"><Check /></span>
                  <div className="text-[15px] font-semibold">You're set, {user.name.split(" ")[0]}.</div>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-neutral-500">Signed in as {user.email}. Your agent signs in as you and reads what you can see. Pick your client below.</p>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-amber-50 font-semibold text-amber-700">!</span>
                  <div className="text-[15px] font-semibold">Waiting for approval</div>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-neutral-500">You're signed in as {user.email}. Once an admin approves your account, come back here and connect.</p>
              </>
            )}
          </Card>
        </div>
      </section>

      <main className="mx-auto max-w-5xl space-y-12 px-5 py-10">
        {/* How it works */}
        <section>
          <h2 className="text-lg font-semibold">How it works</h2>
          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            {[
              ["Add Khaapa", "One command or one pasted address in your agent."],
              ["Sign in", "With your school Google account, then press Allow."],
              ["Just ask", "Your agent pulls the numbers and answers in plain words."],
            ].map(([t, d], i) => (
              <li key={t} className="rounded-xl border border-line p-4">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-[13px] font-semibold text-accent">{i + 1}</span>
                <div className="mt-3 text-[14px] font-semibold">{t}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">{d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Setup */}
        <section>
          <h2 className="text-lg font-semibold">Set it up</h2>
          <div className="mt-4 flex gap-1 overflow-x-auto rounded-lg bg-neutral-100 p-1 text-[13px] font-medium">
            {(Object.keys(SETUP) as Client[]).map((k) => (
              <button key={k} onClick={() => setClient(k)} className={cx("flex-1 whitespace-nowrap rounded-md px-3 py-1.5 transition", client === k ? "bg-white shadow-sm" : "text-neutral-500 hover:text-ink")}>{SETUP[k].name}</button>
            ))}
          </div>
          <Card className="mt-3 space-y-5 p-5">
            {SETUP[client].steps.map((s) => (
              <div key={s.label}>
                {s.cmd ? <Copy text={s.cmd} label={s.label} /> : (
                  <>
                    <div className="mb-1.5 text-[12px] font-medium text-neutral-500">{s.label}</div>
                    <p className="text-[13.5px] leading-relaxed text-neutral-700">{s.note}</p>
                  </>
                )}
              </div>
            ))}
          </Card>
          <p className="mt-3 text-[12px] text-neutral-500">Your agent stays connected and renews its own access for up to 90 days, as long as your Khaapa account is active.</p>
        </section>

        {/* What it can read */}
        <section>
          <h2 className="text-lg font-semibold">What your agent can read</h2>
          <p className="mt-1 text-[13px] text-neutral-500">The same things you can see on the site.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {reads.map((r) => (
              <div key={r.title} className="rounded-xl border border-line p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[14px] font-semibold">{r.title}</div>
                  {r.access !== "member" && <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent">{BECAUSE[r.access]}</span>}
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-neutral-600">{r.desc}</p>
                <code className="mt-2 block font-mono text-[11.5px] text-neutral-400">{r.tools}</code>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] text-neutral-500">Money is in PKR and the shop runs on Pakistan time. Nothing your agent does can sell, edit or delete anything.</p>
        </section>

        {/* Ask */}
        <section>
          <h2 className="text-lg font-semibold">Then just ask</h2>
          <p className="mt-1 text-[13px] text-neutral-500">A few to start with. Copy one into your agent.</p>
          <div className="mt-4 space-y-2">
            {EXAMPLES.map((e) => <Copy key={e} text={e} dark={false} />)}
          </div>
        </section>

        {/* Connections */}
        {member && (
          <section>
            <h2 className="text-lg font-semibold">Your connected agents</h2>
            <Card className="mt-4 divide-y divide-line">
              {conns === null ? <p className="px-4 py-6 text-center text-sm text-neutral-400">Loading…</p> : conns.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-neutral-400">None yet. Follow the steps above.</p>
              ) : conns.map((c) => (
                <div key={c.client_id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{c.client_name ?? "MCP client"}</span>
                      <span className={cx("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium", c.scope === "write" ? "bg-amber-50 text-amber-700" : "bg-neutral-100 text-neutral-500")}>{c.scope === "write" ? "Can make changes" : "Read only"}</span>
                    </div>
                    <div className="text-xs text-neutral-500">Connected {fmtTime(c.connected_at)}{c.last_used_at ? ` · last used ${fmtTime(c.last_used_at)}` : " · not used yet"}</div>
                  </div>
                  <Button onClick={() => disconnect(c)} className="min-h-8 shrink-0 px-2.5">Disconnect</Button>
                </div>
              ))}
            </Card>
          </section>
        )}

        {/* Help */}
        <section className="pb-6">
          <h2 className="text-lg font-semibold">If something's off</h2>
          <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-3">
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold">"Waiting for approval"</dt>
              <dd className="mt-1 leading-relaxed text-neutral-600">The Google account you picked isn't an approved Khaapa member yet. Pick your school account, or ask an admin to approve you.</dd>
            </div>
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold">Agent says it isn't signed in</dt>
              <dd className="mt-1 leading-relaxed text-neutral-600">Claude Code: <code className="rounded bg-neutral-100 px-1">/mcp</code> → khaapa → Authenticate. Codex: <code className="rounded bg-neutral-100 px-1">codex mcp login khaapa</code>.</dd>
            </div>
            <div className="rounded-xl border border-line p-4">
              <dt className="font-semibold">Start over</dt>
              <dd className="mt-1 leading-relaxed text-neutral-600">{member ? "Disconnect it above" : "Sign in and disconnect it here"}, or run <code className="rounded bg-neutral-100 px-1">claude mcp remove khaapa</code>, then add it again.</dd>
            </div>
          </dl>
        </section>
      </main>

      <footer className="border-t border-line bg-neutral-50">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-[12px] text-neutral-500">
          <div className="flex items-center gap-2"><Logo className="h-5" /><span>Khaapa · {SHOP_PLACE.name}, {SHOP_PLACE.campus}</span></div>
          <div className="flex gap-4"><Link to="/" className="hover:text-ink">Menu</Link><Link to="/preorder" className="hover:text-ink">Pre-order</Link></div>
        </div>
      </footer>
    </div>
  );
}
