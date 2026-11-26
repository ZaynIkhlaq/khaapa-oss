import { useCallback, useEffect, useState } from "react";
import { api, fmtTime } from "../api";
import { Card, Pager, Spinner, cx, usePaged } from "../components/ui";
import type { Activity as Act } from "../../shared/types";

const labels: Record<string, string> = {
  login: "signed in", user_join: "joined", sale: "made a sale", sale_void: "voided a sale",
  item_create: "added an item", item_update: "edited an item", item_archive: "archived an item", item_restore: "restored an item", item_delete: "deleted an item", preorder_create: "placed a pre-order", preorder_paid: "marked a pre-order paid", preorder_collected: "handed over a pre-order", preorder_proof: "sent a payment screenshot", preorder_cancelled: "cancelled a pre-order", preorder_new: "reopened a pre-order", preorder_settings: "changed pre-order settings", mcp_connect: "connected an AI agent", mcp_disconnect: "disconnected an AI agent",
  stock_restock: "restocked", stock_waste: "wrote off stock", stock_correction: "corrected stock",
  shift_start: "started a shift", shift_end: "ended a shift", user_create: "added a teammate", user_update: "edited a teammate", user_approve: "approved a teammate", mail_link_create: "created an inbox connect link", mail_connect: "connected the payment inbox", mail_disconnect: "disconnected the payment inbox", payment_match: "linked a payment to a sale", payment_unlink: "unlinked a payment", payment_ignore: "marked a payment as not shop", payment_unignore: "restored a payment", slot_create: "assigned a slot", slot_delete: "removed a slot", slot_pick: "picked slots for a week", slot_pick_clear: "cleared slots for a week", slot_pick_add: "assigned a weekly slot", slot_picks_open: "opened slot picking", slot_picks_close: "closed slot picking", item_cost: "set a buy price",
};
const kinds = [["all", "Everything"], ["sales", "Sales"], ["stock", "Stock"], ["items", "Menu"], ["team", "Team & shifts"]] as const;

function Details({ d }: { d: string | null }) {
  if (!d) return null;
  try {
    const { via: _via, ...o } = JSON.parse(d) ?? {};
    if (o.client) return <span className="text-neutral-500"> — {o.client}, {o.access === "write" ? "can make changes" : "read-only"}</span>;
    if (o.auto) return <span className="text-neutral-500"> — automatically, time was up</span>;
    if (Array.isArray(o.lines)) return <span className="text-neutral-500"> — {o.lines.join(", ")} · Rs {o.total} {o.payment}</span>;
    if (o.delta !== undefined) return <span className="text-neutral-500"> — {o.from} → {o.to}{o.note ? ` (${o.note})` : ""}</span>;
    if (o.name && o.price !== undefined) return <span className="text-neutral-500"> — {o.name}, Rs {o.price}</span>;
    if (o.email) return <span className="text-neutral-500"> — {o.email} ({o.role})</span>;
    if (o.username) return <span className="text-neutral-500"> — @{o.username}{o.role ? ` (${o.role})` : ""}</span>;
    const keys = Object.keys(o);
    if (keys.length && Array.isArray(o[keys[0]])) return <span className="text-neutral-500"> — {keys.map((k) => `${k}: ${o[k][0]} → ${o[k][1]}`).join(", ")}</span>;
    return null;
  } catch { return null; }
}

const PAGE = 100;

export default function Activity() {
  const [rows, setRows] = useState<Act[] | null>(null);
  const [kind, setKind] = useState<string>("all");
  const [more, setMore] = useState(false);

  const load = useCallback(async (before?: number) => {
    const d = await api(`/api/activity?limit=${PAGE}&kind=${kind}${before ? `&before=${before}` : ""}`);
    setRows((r) => (before && r ? [...r, ...d.activity] : d.activity));
    setMore(d.has_more);
  }, [kind]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const { shown, pager } = usePaged(rows ?? [], 25, kind);

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Activity log</h1>
          <p className="text-sm text-neutral-500">Who did what. Nothing here can be edited or deleted.</p>
        </div>
        <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-[12px] font-medium">
          {kinds.map(([k, l]) => (
            <button key={k} onClick={() => setKind(k)} className={cx("rounded px-2.5 py-1", kind === k ? "bg-white shadow-sm" : "text-neutral-500")}>{l}</button>
          ))}
        </div>
      </div>
      {rows === null ? <Spinner /> : (
        <Card className="divide-y divide-line">
            {rows.length === 0 && <p className="p-8 text-center text-sm text-neutral-400">Quiet so far.</p>}
            {shown.map((a) => (
              <div key={a.id} className="flex items-start gap-3 px-4 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{a.user_name ?? "System"}</span> {labels[a.action] ?? a.action}
                  {a.entity_id && a.entity !== "user" ? <span className="text-neutral-400"> #{a.entity_id}</span> : null}
                  <Details d={a.details} />
                  {a.details?.includes('"via":"agent"') && <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">via AI agent</span>}
                </div>
                <span className="shrink-0 text-xs text-neutral-400">{fmtTime(a.created_at)}</span>
              </div>
            ))}
          <Pager {...pager} more={more} onMore={() => load(rows[rows.length - 1].id)} />
        </Card>
      )}
    </div>
  );
}
