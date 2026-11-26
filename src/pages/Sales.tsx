import { useEffect, useState } from "react";
import { api, fmtTime, rs } from "../api";
import { useAuth } from "../auth";
import { Badge, Card, Pager, Spinner, cx, toast, usePaged } from "../components/ui";
import type { Sale, SaleItem } from "../../shared/types";

const lineLabel = (i: SaleItem) => (i.extra ? `+${rs(i.unit_price)} extra (${i.name})` : `${i.qty}× ${i.name}`);

// What the customer paid minus what the goods cost us. null when a line has no buy price.
function profitOf(s: Sale) {
  if (!s.items?.length || s.items.some((i) => i.unit_cost == null)) return null;
  return s.total - s.items.reduce((a, i) => a + i.qty * (i.unit_cost ?? 0), 0);
}

export default function Sales() {
  const { user, shift } = useAuth();
  const [sales, setSales] = useState<Sale[] | null>(null);
  const [more, setMore] = useState(false);
  const load = async (before?: number) => {
    const d = await api(`/api/sales?limit=100${before ? `&before=${before}` : ""}`);
    setSales((x) => (before && x ? [...x, ...d.sales] : d.sales));
    setMore(d.has_more);
  };
  useEffect(() => { load(); }, []);
  const { shown, pager } = usePaged(sales ?? []);

  const voidSale = async (s: Sale) => {
    if (!confirm(`Void sale #${s.id} (${rs(s.total)})? Stock goes back on the shelf.`)) return;
    try { await api(`/api/sales/${s.id}/void`, { method: "POST" }); toast("Voided"); load(); } catch (e: any) { toast(e.message, true); }
  };

  return (
    <div className="space-y-6 p-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-semibold">Sales</h1>
        <p className="text-sm text-neutral-500">Every sale, who rang it up, and what was in it.</p>
      </div>
      {sales === null ? <Spinner /> : sales.length === 0 ? <p className="py-12 text-center text-neutral-400">No sales yet.</p> : (
        <Card className="divide-y divide-line">
          {shown.map((s) => (
            <details key={s.id} className={cx("group", s.voided_at && "opacity-50")}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-sm hover:bg-neutral-50/60 sm:gap-3 sm:px-4">
                <span className="tabular hidden w-16 shrink-0 text-xs text-neutral-400 sm:inline">#{s.id}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">{s.items?.map(lineLabel).join(", ")}</div>
                  <div className="truncate text-xs text-neutral-500">{s.user_name} · {fmtTime(s.created_at)}{s.payment === "online" ? " · online" : ""}{s.code ? ` · ${s.code}` : ""}</div>
                </div>
                <span className="hidden sm:inline"><Badge tone={s.payment === "cash" ? "neutral" : "accent"}>{s.payment}</Badge></span>
                {s.voided_at && <Badge tone="bad">Void</Badge>}
                <span className="tabular w-16 shrink-0 text-right font-semibold sm:w-20">{rs(s.total)}</span>
              </summary>
              <div className="bg-neutral-50 px-4 py-3 text-sm">
                <div className="mb-1 text-xs text-neutral-400 sm:hidden">Sale #{s.id}</div>
                <table className="w-full">
                  <tbody>
                    {s.items?.map((i) => (
                      <tr key={i.id}><td className="py-0.5">{i.name}{i.extra ? <span className="text-neutral-500"> · extra</span> : null}</td><td className="tabular py-0.5 text-right text-neutral-500">{i.extra ? "added on top" : <>{i.qty} × {rs(i.unit_price)}</>}</td><td className="tabular w-24 py-0.5 text-right">{rs(i.qty * i.unit_price)}</td></tr>
                    ))}
                  </tbody>
                </table>
                {s.discount > 0 && (
                  <div className="mt-1 flex justify-between border-t border-line pt-1 text-emerald-700">
                    <span>Code {s.code ?? ""}</span><span className="tabular">−{rs(s.discount)}</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-line pt-1 text-xs text-neutral-500">
                  <span>Profit</span>
                  <span className={cx("tabular font-medium", (profitOf(s) ?? 0) >= 0 ? "text-emerald-700" : "text-red-600")}>{profitOf(s) == null ? "buy price missing" : rs(profitOf(s)!)}</span>
                </div>
                {s.note && <p className="mt-2 text-xs text-neutral-500">Note: {s.note}</p>}
                {!s.voided_at && (user?.role === "admin" || (!!shift && user?.id === s.user_id)) && (
                  <button onClick={() => voidSale(s)} className="mt-2 text-xs font-medium text-red-600 hover:underline">Void this sale</button>
                )}
              </div>
            </details>
          ))}
          <Pager {...pager} more={more} onMore={() => load(sales[sales.length - 1].id)} />
        </Card>
      )}
    </div>
  );
}
