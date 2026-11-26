import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, fmtDay, fmtTime, rs, waLink } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Field, Input, Pager, Spinner, cx, toast, usePaged } from "../components/ui";
import { canOperate, type Preorder, type PreorderSettings, type PreorderStatus } from "../../shared/types";
import { ShiftNotice } from "../components/StartShift";

const TABS: { key: PreorderStatus | "all"; label: string }[] = [
  { key: "new", label: "Awaiting payment" },
  { key: "paid", label: "Paid" },
  { key: "collected", label: "Picked up" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];
const TONE: Record<PreorderStatus, "warn" | "accent" | "good" | "neutral"> = { new: "warn", paid: "accent", collected: "good", cancelled: "neutral" };
const LABEL: Record<PreorderStatus, string> = { new: "Awaiting payment", paid: "Paid", collected: "Picked up", cancelled: "Cancelled" };

function addDays(ymd: string, n: number) {
  return new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
}

// What to have ready, per pickup day, from orders that are still open.
function PrepList({ orders, today }: { orders: Preorder[]; today: string }) {
  const days = [today, addDays(today, 1)];
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {days.map((day) => {
        const open = orders.filter((o) => o.pickup_on === day && (o.status === "new" || o.status === "paid"));
        const totals = new Map<string, { qty: number; paid: number }>();
        for (const o of open) for (const l of o.lines ?? []) {
          const t = totals.get(l.name) ?? { qty: 0, paid: 0 };
          t.qty += l.qty;
          if (o.status === "paid") t.paid += l.qty;
          totals.set(l.name, t);
        }
        return (
          <Card key={day} className="p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold">{day === today ? "Today" : "Tomorrow"} <span className="font-normal text-neutral-400">{fmtDay(day)}</span></h2>
              <span className="text-xs text-neutral-400">{open.length} {open.length === 1 ? "order" : "orders"}</span>
            </div>
            {totals.size === 0 ? <p className="py-3 text-center text-xs text-neutral-400">Nothing to prepare</p> : (
              <ul className="space-y-1 text-sm">
                {[...totals].sort((a, b) => b[1].qty - a[1].qty).map(([name, t]) => (
                  <li key={name} className="flex justify-between"><span>{name}</span><span className="tabular"><b>{t.qty}</b><span className="text-xs text-neutral-400"> · {t.paid} paid</span></span></li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function OrderRow({ o, onStatus, live }: { o: Preorder; onStatus: (o: Preorder, s: PreorderStatus) => void; live: boolean }) {
  const chat = waLink(o.phone, `Hi ${o.name}, about your Khaapa pre-order ${o.code} (${rs(o.total)}).`);
  return (
    <div className={cx("px-3 py-3 text-sm sm:px-4", o.status === "cancelled" && "opacity-60")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{o.code}</span>
            <Badge tone={TONE[o.status]}>{LABEL[o.status]}</Badge>
            <span className="text-xs text-neutral-500">pickup {fmtDay(o.pickup_on)}</span>
          </div>
          <div className="mt-0.5 text-[13px]">
            <span className="font-medium">{o.name}</span>
            <span className="text-neutral-500"> · </span>
            {chat ? <a href={chat} target="_blank" rel="noreferrer" className="tabular text-neutral-600 underline decoration-neutral-300 hover:text-ink">{o.phone}</a> : <span className="tabular">{o.phone}</span>}
          </div>
        </div>
        <span className="tabular text-base font-semibold">{rs(o.total)}</span>
      </div>
      <div className="mt-1 flex items-start gap-3">
        <div className="min-w-0 flex-1 text-[13px] text-neutral-600">{o.lines?.map((l) => `${l.qty}× ${l.name}`).join(", ")}</div>
        {o.has_proof && (
          <a href={`/api/preorders/${o.id}/proof`} target="_blank" rel="noreferrer" title="Payment screenshot" className="shrink-0">
            <img src={`/api/preorders/${o.id}/proof`} alt="Payment screenshot" loading="lazy" className="h-16 w-12 rounded border border-line object-cover object-top hover:opacity-80" />
          </a>
        )}
      </div>
      {o.status === "new" && !o.has_proof && <div className="mt-0.5 text-xs text-neutral-400">No screenshot uploaded yet. Check WhatsApp.</div>}
      {o.note && <div className="mt-0.5 text-xs text-neutral-500">Note: {o.note}</div>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {live && <>
        {o.status === "new" && <Button variant="primary" onClick={() => onStatus(o, "paid")} className="min-h-8 px-3">Payment checked, mark paid</Button>}
        {o.status === "paid" && <Button variant="primary" onClick={() => onStatus(o, "collected")} className="min-h-8 px-3">Picked up</Button>}
        {(o.status === "new" || o.status === "paid") && <button onClick={() => onStatus(o, "cancelled")} className="text-xs text-neutral-500 hover:text-red-600">Cancel</button>}
        {o.status === "paid" && <button onClick={() => onStatus(o, "new")} className="text-xs text-neutral-500 hover:text-ink">Not paid after all</button>}
        {o.status === "cancelled" && <button onClick={() => onStatus(o, "new")} className="text-xs text-neutral-500 hover:text-ink">Reopen</button>}
        </>}
        <span className="ml-auto text-xs text-neutral-400">
          {fmtTime(o.created_at)}{o.handled_by_name ? ` · ${o.handled_by_name}` : ""}{o.sale_id ? ` · sale #${o.sale_id}` : ""}
        </span>
      </div>
    </div>
  );
}

function SettingsCard({ initial, onSaved }: { initial: PreorderSettings; onSaved: () => void }) {
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api("/api/preorder-settings", { method: "PUT", json: f }); toast("Saved"); onSaved(); } catch (err: any) { toast(err.message, true); }
  };
  return (
    <Card className="p-4">
      <h2 className="text-[13px] font-semibold">Shown to customers after they order</h2>
      <p className="mb-3 text-xs text-neutral-500">Where they send the money and the screenshot. Items show up for pre-order when "Available for pre-order" is ticked on Menu items.</p>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2 sm:items-end lg:grid-cols-4">
        <Field label="NayaPay number"><Input value={f.nayapay_number} onChange={(e) => setF({ ...f, nayapay_number: e.target.value })} placeholder="03xx xxxxxxx" /></Field>
        <Field label="NayaPay account name"><Input value={f.nayapay_name} onChange={(e) => setF({ ...f, nayapay_name: e.target.value })} placeholder="Name on the account" /></Field>
        <Field label="SadaPay number"><Input value={f.sadapay_number} onChange={(e) => setF({ ...f, sadapay_number: e.target.value })} placeholder="03xx xxxxxxx" /></Field>
        <Field label="SadaPay account name"><Input value={f.sadapay_name} onChange={(e) => setF({ ...f, sadapay_name: e.target.value })} placeholder="Name on the account" /></Field>
        <Field label="WhatsApp number"><Input value={f.whatsapp} onChange={(e) => setF({ ...f, whatsapp: e.target.value })} placeholder="03xx xxxxxxx" /></Field>
        <Button type="submit">Save</Button>
      </form>
    </Card>
  );
}

export default function Orders() {
  const { user, shift } = useAuth();
  const [d, setD] = useState<{ orders: Preorder[]; counts: Record<string, number>; settings: PreorderSettings; today: string } | null>(null);
  // The WhatsApp message links to /orders?q=PO-12 so whoever opens it lands on that order.
  const [params] = useSearchParams();
  const [tab, setTab] = useState<PreorderStatus | "all">(params.get("q") ? "all" : "new");
  const [q, setQ] = useState(params.get("q") ?? "");

  const load = () => api("/api/preorders").then(setD).catch((e) => toast(e.message, true));
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const shown = useMemo(() => (d?.orders ?? []).filter((o) => (tab === "all" || o.status === tab) && `${o.code} ${o.name} ${o.phone}`.toLowerCase().includes(q.toLowerCase())), [d, tab, q]);
  const { shown: page, pager } = usePaged(shown, 25, `${tab} ${q}`);

  const setStatus = async (o: Preorder, status: PreorderStatus) => {
    const ask: Partial<Record<PreorderStatus, string>> = {
      paid: `Mark ${o.code} as paid? Only if you've seen ${rs(o.total)} arrive on NayaPay or SadaPay. This records it as a ${rs(o.total)} online sale now and takes the items out of stock.`,
      collected: `${o.name} picked up ${o.code}?`,
      cancelled: `Cancel ${o.code}?${o.status === "paid" ? ` Its ${rs(o.total)} sale is voided and stock goes back. They already paid, so sort out the refund with them.` : ""}`,
      new: o.status === "paid" ? `Move ${o.code} back to awaiting payment? Its ${rs(o.total)} sale is voided.` : undefined,
    };
    if (ask[status] && !confirm(ask[status])) return;
    try { await api(`/api/preorders/${o.id}/status`, { json: { status } }); toast(`${o.code}: ${LABEL[status].toLowerCase()}`); load(); } catch (err: any) { toast(err.message, true); }
  };

  if (!d) return <Spinner />;
  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pre-orders</h1>
          <p className="text-sm text-neutral-500">Customers order at <a href="/preorder" target="_blank" className="underline decoration-neutral-300">/preorder</a>, pay on NayaPay or SadaPay and send the screenshot on WhatsApp. Check the money arrived, then mark it paid: that's when it counts as a sale.</p>
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, name, phone" className="sm:w-56" />
      </div>

      <ShiftNotice what="mark orders paid or picked up" />

      <PrepList orders={d.orders} today={d.today} />

      <Card>
        <div className="flex gap-1 overflow-x-auto border-b border-line p-2 text-[12px] font-medium">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={cx("whitespace-nowrap rounded-md px-2.5 py-1", tab === t.key ? "bg-accent-soft text-accent" : "text-neutral-500 hover:text-ink")}>
              {t.label}{t.key !== "all" && d.counts[t.key] ? <span className="ml-1 tabular">{d.counts[t.key]}</span> : null}
            </button>
          ))}
        </div>
        <div className="divide-y divide-line">
          {page.length === 0 && <p className="p-8 text-center text-sm text-neutral-400">No orders here.</p>}
          {page.map((o) => <OrderRow key={o.id} o={o} onStatus={setStatus} live={canOperate(user, shift)} />)}
        </div>
        <Pager {...pager} className="border-t border-line" />
      </Card>

      {user?.role === "admin" && <SettingsCard initial={d.settings} onSaved={load} />}
    </div>
  );
}
