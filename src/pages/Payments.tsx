import { useEffect, useState } from "react";
import { api, fmtTime, rs, timeAgo } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Input, Modal, Pager, Spinner, cx, toast, usePaged } from "../components/ui";
import { ShiftNotice } from "../components/StartShift";
import { canOperate, walletName } from "../../shared/types";

interface Payment { id: number; source: string; received_at: string; amount: number | null; sender_name: string | null; reference: string | null; subject: string | null; snippet: string | null; sale_id: number | null; ignored: number }
interface Cand { id: number; total: number; created_at: string; user_name: string; summary: string | null }
interface Conn { email: string; connected_at: string; last_sync_at: string | null; last_error: string | null }

export default function Payments() {
  const { user, shift } = useAuth();
  const live = canOperate(user, shift);
  const admin = user?.role === "admin";
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [conn, setConn] = useState<Conn | null>(null);
  const [totals, setTotals] = useState({ today: 0, week: 0, unmatched: 0 });
  const [more, setMore] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  // Filter tabs and a search box (sender name, reference or amount); both run on the server so they cover everything.
  const [status, setStatus] = useState<"all" | "unlinked" | "linked" | "ignored">("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);

  const load = async (before?: number) => {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", String(before));
    if (status !== "all") params.set("status", status);
    if (query) params.set("q", query);
    const d = await api(`/api/payments?${params}`);
    setRows((r) => (before && r ? [...r, ...d.payments] : d.payments));
    setConn(d.connection); setTotals(d.totals); setMore(d.has_more);
  };
  useEffect(() => { setRows(null); load(); const t = setInterval(() => load(), 30_000); return () => clearInterval(t); }, [status, query]);

  const { shown, pager } = usePaged(rows ?? [], 25, `${status} ${query}`);
  // Linking and unlinking ask first, like a cash sale does at the counter.
  const [confirmLink, setConfirmLink] = useState<{ p: Payment; sale: Cand | null } | null>(null);

  const sync = async () => {
    setBusy(true);
    try { const d = await api("/api/payments/sync", { method: "POST" }); toast(d.added ? `${d.added} new payment${d.added > 1 ? "s" : ""}` : "Up to date"); await load(); }
    catch (e: any) { toast(e.message, true); await load(); } finally { setBusy(false); }
  };
  const makeLink = async () => {
    try { const d = await api("/api/payments/connect-link", { method: "POST" }); setLink(d.url); } catch (e: any) { toast(e.message, true); }
  };
  const copy = async () => { await navigator.clipboard.writeText(link); toast("Link copied"); };
  const [open, setOpen] = useState<number | null>(null);
  const [cands, setCands] = useState<Cand[] | null>(null);
  const expand = async (p: Payment) => {
    if (open === p.id) { setOpen(null); return; }
    setOpen(p.id); setCands(null);
    if (!p.sale_id && !p.ignored) setCands((await api(`/api/payments/${p.id}/candidates`)).sales);
  };
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); setOpen(null); await load(); } catch (e: any) { toast(e.message, true); }
  };
  const linkTo = (p: Payment, saleId: number | null) => act(() => api(`/api/payments/${p.id}/match`, { json: { sale_id: saleId } }), saleId ? `Linked to sale #${saleId}` : "Unlinked");
  const doConfirmed = async () => {
    if (!confirmLink) return;
    const { p, sale } = confirmLink;
    setConfirmLink(null);
    await linkTo(p, sale ? sale.id : null);
  };
  const ignore = (p: Payment, ignored: boolean) => act(() => api(`/api/payments/${p.id}/ignore`, { json: { ignored } }), ignored ? "Marked as not a shop payment" : "Restored");

  const disconnect = async () => {
    if (!confirm("Disconnect the payment inbox? Payments already pulled in are kept.")) return;
    await api("/api/payments/connection", { method: "DELETE" }); toast("Disconnected"); load();
  };

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Payments</h1>
          <p className="text-sm text-neutral-500">Online payments arrive here automatically from the connected NayaPay inbox. Link each one to the sale it paid for.</p>
        </div>
        {conn && live && <Button onClick={sync} disabled={busy}>{busy ? "Syncing…" : "Sync now"}</Button>}
      </div>

      <Card className="p-4">
        {conn ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /><span className="truncate">NayaPay: {conn.email}</span></div>
              <div className="mt-0.5 text-xs text-neutral-500">
                {conn.last_error ? <span className="text-red-600">Last sync failed: {conn.last_error}</span> : conn.last_sync_at ? `Checked ${timeAgo(conn.last_sync_at)} · checks every minute` : "Waiting for first sync"}
              </div>
            </div>
            {admin && <button onClick={disconnect} className="text-xs text-neutral-500 hover:text-red-600">Disconnect</button>}
          </div>
        ) : (
          <div>
            <div className="text-sm font-medium">NayaPay: no inbox connected</div>
            <p className="mt-0.5 text-xs text-neutral-500">
              {admin ? "Create a one-time link and send it to whoever owns the Gmail inbox that receives NayaPay emails. They sign in with Google and allow read-only access. The link works once and expires in 24 hours." : "An admin needs to connect the payment inbox."}
            </p>
          </div>
        )}
        {admin && (
          <div className="mt-3 border-t border-line pt-3">
            {link ? (
              <div className="flex gap-2"><Input readOnly value={link} onFocus={(e) => e.target.select()} /><Button variant="primary" onClick={copy}>Copy</Button></div>
            ) : (
              <Button onClick={makeLink}>{conn ? "Create link to connect a different inbox" : "Create connect link"}</Button>
            )}
          </div>
        )}
      </Card>

      <ShiftNotice what="link payments to sales" />

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-3 sm:p-4"><div className="text-[12px] font-medium text-neutral-500">Today</div><div className="tabular mt-1 text-lg font-semibold sm:text-2xl">{rs(totals.today)}</div></Card>
        <Card className="p-3 sm:p-4"><div className="text-[12px] font-medium text-neutral-500">Last 7 days</div><div className="tabular mt-1 text-lg font-semibold sm:text-2xl">{rs(totals.week)}</div></Card>
        <Card className="p-3 sm:p-4"><div className="text-[12px] font-medium text-neutral-500">Not linked</div><div className="tabular mt-1 text-lg font-semibold sm:text-2xl">{totals.unmatched}</div></Card>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 overflow-x-auto rounded-md bg-neutral-100 p-0.5 text-[12px] font-medium">
          {([["all", "All"], ["unlinked", "Not linked"], ["linked", "Linked"], ["ignored", "Not shop"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)} className={cx("whitespace-nowrap rounded px-3 py-1.5", status === k ? "bg-white shadow-sm" : "text-neutral-500")}>
              {label}{k === "unlinked" && totals.unmatched > 0 && <span className="tabular ml-1 text-amber-700">{totals.unmatched}</span>}
            </button>
          ))}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, reference or amount" className="sm:w-64" />
      </div>

      {rows === null ? <Spinner /> : rows.length === 0 ? (
        <p className="py-10 text-center text-sm text-neutral-400">{query || status !== "all" ? "No payments match." : "No payments yet."}</p>
      ) : (
        <Card className="divide-y divide-line">
          {shown.map((p) => (
            <div key={p.id} className={cx(!!p.ignored && "opacity-50")}>
              <button onClick={() => expand(p)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-neutral-50/60 sm:gap-3 sm:px-4">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.sender_name ?? p.subject ?? "Payment"}</div>
                  <div className="truncate text-xs text-neutral-500">{walletName(p.source)} · {fmtTime(p.received_at)}{p.reference ? ` · ${p.reference}` : ""}</div>
                </div>
                {p.ignored ? <Badge>Not shop</Badge> : p.sale_id ? <Badge tone="good">Sale #{p.sale_id}</Badge> : <Badge tone="warn">Not linked</Badge>}
                <span className="tabular w-16 shrink-0 text-right font-semibold sm:w-20">{p.amount == null ? "?" : rs(p.amount)}</span>
              </button>
              {open === p.id && live && (
                <div className="space-y-3 bg-neutral-50 px-3 py-3 text-xs sm:px-4">
                  <div className="text-neutral-600"><span className="font-medium text-ink">{p.subject}</span>{p.snippet ? <p className="mt-0.5">{p.snippet}</p> : null}</div>
                  {p.ignored ? (
                    <Button onClick={() => ignore(p, false)}>This is a shop payment</Button>
                  ) : p.sale_id ? (
                    <Button onClick={() => setConfirmLink({ p, sale: null })}>Unlink from sale #{p.sale_id}</Button>
                  ) : (
                    <>
                      <div>
                        <div className="mb-1 font-medium text-neutral-500">Link to an online sale</div>
                        {cands === null ? <div className="text-neutral-400">Loading…</div> : cands.length === 0 ? (
                          <div className="text-neutral-400">No unlinked online sales in the last 7 days.</div>
                        ) : (
                          <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line bg-white">
                            {cands.map((s) => (
                              <li key={s.id}>
                                <button onClick={() => setConfirmLink({ p, sale: s })} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-50">
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[13px] text-ink">{s.summary ?? `Sale #${s.id}`}</div>
                                    <div className="truncate text-neutral-500">#{s.id} · {s.user_name} · {fmtTime(s.created_at)}</div>
                                  </div>
                                  <span className={cx("tabular shrink-0 text-[13px] font-semibold", s.total === p.amount ? "text-emerald-700" : "text-neutral-500")}>{rs(s.total)}{s.total === p.amount ? " ✓" : ""}</span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <button onClick={() => ignore(p, true)} className="text-neutral-500 underline hover:text-ink">Not a shop payment</button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pager {...pager} more={more} onMore={() => load(rows[rows.length - 1].id)} />
        </Card>
      )}
      <Modal open={!!confirmLink} onClose={() => setConfirmLink(null)} title={confirmLink?.sale ? "Link this payment?" : "Unlink this payment?"} center>
        {confirmLink && (
          <div className="space-y-4">
            <div className="space-y-2 rounded-lg bg-neutral-50 p-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate"><span className="text-neutral-500">{walletName(confirmLink.p.source)} from </span><b>{confirmLink.p.sender_name ?? "unknown"}</b></span>
                <span className="tabular font-semibold">{confirmLink.p.amount == null ? "?" : rs(confirmLink.p.amount)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-neutral-500">{confirmLink.sale ? <>to sale <b className="text-ink">#{confirmLink.sale.id}</b> · {confirmLink.sale.user_name}</> : <>from sale <b className="text-ink">#{confirmLink.p.sale_id}</b></>}</span>
                {confirmLink.sale && <span className="tabular font-semibold">{rs(confirmLink.sale.total)}</span>}
              </div>
            </div>
            {confirmLink.sale && confirmLink.p.amount !== confirmLink.sale.total && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">The amounts don't match. Only link it if you're sure this payment was for that sale.</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setConfirmLink(null)} className="py-2.5">Cancel</Button>
              <Button onClick={doConfirmed} variant="primary" className="py-2.5">{confirmLink.sale ? "Yes, link it" : "Yes, unlink"}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

