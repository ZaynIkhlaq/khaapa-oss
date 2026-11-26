import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, rs } from "../api";
import { Button, Card, Modal, Spinner, cx, toast } from "../components/ui";
import { HistoryButton, HistoryModal, type HistoryRow } from "../components/History";
import type { Item, Stats as S, StatsHistory } from "../../shared/types";
import { BuyPriceDialog } from "../components/ItemDialogs";

function Tile({ label, value, sub, profit }: { label: string; value: string; sub?: string; profit?: { profit: number; revenue: number } }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {profit && (
        <div className={cx("tabular mt-0.5 text-[13px] font-medium", profit.profit >= 0 ? "text-emerald-700" : "text-red-600")}>
          {rs(profit.profit)} profit{profit.revenue > 0 && <span className="font-normal text-neutral-400"> · {Math.round((profit.profit / profit.revenue) * 100)}%</span>}
        </div>
      )}
      {sub && <div className="mt-0.5 text-xs text-neutral-500">{sub}</div>}
    </Card>
  );
}

function Bars({ rows, label, value, fmt, onHistory }: { rows: { key: string | number; label: string; value: number; sub?: string }[]; label: string; value: string; fmt: (n: number) => string; onHistory: () => void }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">{label}</h2>
        <span className="flex items-center gap-2 text-xs text-neutral-400">{value}<HistoryButton onClick={onHistory} /></span>
      </div>
      {rows.length === 0 ? <p className="py-6 text-center text-xs text-neutral-400">No data yet</p> : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key} title={`${r.label}: ${fmt(r.value)}`} className="text-sm">
              <div className="flex justify-between">
                <span className="truncate font-medium">{r.label}{r.sub && <span className="ml-1 text-xs font-normal text-neutral-400">{r.sub}</span>}</span>
                <span className="tabular ml-2 shrink-0 text-neutral-600">{fmt(r.value)}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-sm bg-neutral-100"><div className="h-1.5 rounded-sm bg-accent" style={{ width: `${(r.value / max) * 100}%` }} /></div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

type Pt = { key: string; label: string; revenue: number; profit: number; sales: number };

// Revenue and profit as two lines; hover (or tap) a point to read the numbers.
function LineChart({ title, note, points, every, onHistory }: { title: string; note: string; points: Pt[]; every: number; onHistory: () => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 190, L = 44, R = 10, T = 12, B = 24;
  const max = Math.max(1, ...points.map((p) => p.revenue));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const x = (i: number) => L + (points.length === 1 ? 0 : (i * (W - L - R)) / (points.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  const path = (k: "revenue" | "profit") => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const area = `${path("revenue")}L${x(points.length - 1)},${H - B}L${x(0)},${H - B}Z`;
  const h = hover === null ? null : points[hover];
  const tot = points.reduce((a, p) => ({ revenue: a.revenue + p.revenue, profit: a.profit + p.profit, sales: a.sales + p.sales }), { revenue: 0, profit: 0, sales: 0 });
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1)))));
  };
  return (
    <Card className="p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <span className="flex items-center gap-3 text-xs text-neutral-500">
          <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-accent" />Revenue</span>
          <span className="flex items-center gap-1"><span className="h-0.5 w-3 rounded bg-emerald-600" />Profit</span>
          <HistoryButton onClick={onHistory} />
        </span>
      </div>
      <div className="tabular mb-1 text-xs text-neutral-500">
        {h ? <><b className="text-ink">{h.label}</b> · {rs(h.revenue)} revenue · <span className="text-emerald-700">{rs(h.profit)} profit</span> · {h.sales} sales</>
          : <>{note}: <b className="text-ink">{rs(tot.revenue)}</b> revenue · <span className="text-emerald-700">{rs(tot.profit)} profit</span> · {tot.sales} sales</>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full touch-none select-none" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="#e9e4ee" />
            <text x={L - 6} y={y(top * f) + 4} textAnchor="end" fontSize="10" fill="#a59dae">{Math.round(top * f).toLocaleString("en-PK")}</text>
          </g>
        ))}
        {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
          <text key={p.key} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} fontSize="10" fill="#a59dae">{p.label}</text>
        ))}
        <path d={area} fill="rgb(92 47 128 / 0.08)" />
        <path d={path("revenue")} fill="none" stroke="#5c2f80" strokeWidth="2" strokeLinejoin="round" />
        <path d={path("profit")} fill="none" stroke="#059669" strokeWidth="2" strokeLinejoin="round" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke="#a59dae" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(points[hover].revenue)} r="3.5" fill="white" stroke="#5c2f80" strokeWidth="2" />
            <circle cx={x(hover)} cy={y(points[hover].profit)} r="3.5" fill="white" stroke="#059669" strokeWidth="2" />
          </g>
        )}
      </svg>
    </Card>
  );
}

// The last 24 hours, one point per hour (Pakistan time), ending with the current hour.
function last24(rows: S["last_24h"]): Pt[] {
  const now = new Date(Date.now() + 5 * 3600_000);
  const out: Pt[] = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600_000);
    const key = d.toISOString().slice(0, 13) + ":00";
    const r = rows.find((x) => x.hour === key);
    const hr = d.getUTCHours();
    out.push({ key, label: `${((hr + 11) % 12) + 1}${hr < 12 ? "am" : "pm"}`, revenue: r?.revenue ?? 0, profit: r?.profit ?? 0, sales: r?.sales ?? 0 });
  }
  return out;
}

// The last 14 days, quiet days included.
function last14(rows: S["by_day"]): Pt[] {
  const now = new Date(Date.now() + 5 * 3600_000);
  const out: Pt[] = [];
  for (let i = 13; i >= 0; i--) {
    const key = new Date(now.getTime() - i * 86400_000).toISOString().slice(0, 10);
    const r = rows.find((x) => x.day === key);
    out.push({ key, label: new Date(key + "T00:00:00Z").toLocaleDateString("en-PK", { day: "numeric", month: "short", timeZone: "UTC" }), revenue: r?.revenue ?? 0, profit: r?.profit ?? 0, sales: r?.sales ?? 0 });
  }
  return out;
}

type ChartKey = "hours" | "days" | "leaderboard" | "sellers" | "profit";
type Chart = { title: string; headers: string[]; rows: (s: S, h: StatsHistory | null) => HistoryRow[] | null };

const hourLabel = (key: string) => {
  const hr = Number(key.slice(11, 13));
  return `${key.slice(0, 10)} ${((hr + 11) % 12) + 1}${hr < 12 ? "am" : "pm"}`;
};
const moneyCells = (r: { revenue: number; profit: number; sales: number }) => [rs(r.revenue), rs(r.profit), `${r.sales}`];

// Every day from the first sale to today, newest first, so quiet days show up as empty rows.
function allDays(rows: StatsHistory["by_day"]): HistoryRow[] {
  if (rows.length === 0) return [];
  const byDay = new Map(rows.map((d) => [d.day, d]));
  const end = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const out: HistoryRow[] = [];
  for (let t = new Date(rows[0].day + "T00:00:00Z").getTime(); ; t += 86400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const d = byDay.get(day) ?? { revenue: 0, profit: 0, sales: 0 };
    out.push({ key: day, label: day, bar: d.revenue, cells: moneyCells(d) });
    if (day >= end) break;
  }
  return out.reverse();
}

function itemRows(h: StatsHistory, by: "qty" | "profit"): HistoryRow[] {
  return [...h.items].sort((a, b) => b[by] - a[by]).map((i) => ({ key: i.item_id, label: i.name, bar: i[by], cells: [`${i.qty}`, rs(i.revenue), rs(i.profit)] }));
}

const MONEY = ["Revenue", "Profit", "Sales"];
const ITEM = ["Item", "Units", "Revenue", "Profit"];
const CHARTS: Record<ChartKey, Chart> = {
  hours: { title: "Every hour with a sale", headers: ["Hour", ...MONEY], rows: (_, h) => h && h.by_hour.map((r) => ({ key: r.hour, label: hourLabel(r.hour), bar: r.revenue, cells: moneyCells(r) })) },
  days: { title: "Every day", headers: ["Day", ...MONEY], rows: (_, h) => h && allDays(h.by_day) },
  leaderboard: { title: "Leaderboard, all time", headers: ["Person", ...MONEY], rows: (s) => s.by_cashier.map((c) => ({ key: c.user_id, label: c.name, bar: c.profit, cells: moneyCells(c) })) },
  sellers: { title: "Every item sold, by units", headers: ITEM, rows: (_, h) => h && itemRows(h, "qty") },
  profit: { title: "Every item sold, by profit", headers: ITEM, rows: (_, h) => h && itemRows(h, "profit") },
};

// Every item still missing a buy price, each fixable right here.
function MissingCosts({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [edit, setEdit] = useState<Item | null>(null);
  const load = () => api("/api/items").then((d) => setItems((d.items as Item[]).filter((i) => i.cost == null)));
  useEffect(() => { if (open) load(); }, [open]);
  return (
    <>
      <Modal open={open && !edit} onClose={onClose} title="Items without a buy price">
        {items === null ? <Spinner /> : items.length === 0 ? <p className="py-6 text-center text-sm text-neutral-500">All set. Every item has a buy price.</p> : (
          <ul className="divide-y divide-line">
            {items.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">{i.name} <span className="text-xs text-neutral-400">sells {rs(i.price)}</span></span>
                <Button onClick={() => setEdit(i)} className="min-h-8 shrink-0 px-2.5">Set buy price</Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
      <BuyPriceDialog item={edit} onClose={() => setEdit(null)} onSaved={() => { load(); onSaved(); }} />
    </>
  );
}

export default function Stats() {
  const [s, setS] = useState<S | null>(null);
  const [fixing, setFixing] = useState(false);
  const [open, setOpen] = useState<ChartKey | null>(null);
  const [history, setHistory] = useState<StatsHistory | null>(null);
  const load = () => api("/api/stats").then(setS);
  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);
  const showHistory = (key: ChartKey) => {
    setOpen(key);
    if (key === "leaderboard") return;
    setHistory(null);
    api<StatsHistory>("/api/stats/history").then(setHistory).catch((e) => toast(e.message, true));
  };
  if (!s) return <Spinner />;

  const cash = s.payment_split.find((p) => p.payment === "cash")?.revenue ?? 0;
  const online = s.payment_split.find((p) => p.payment === "online")?.revenue ?? 0;

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-semibold">Stats</h1>
        <p className="text-sm text-neutral-500">Live numbers. Voided sales are excluded.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Today" value={rs(s.today.revenue)} profit={s.today} sub={`${s.today.sales} sales · ${s.today.items} items`} />
        <Tile label="Last 7 days" value={rs(s.week.revenue)} profit={s.week} sub={`${s.week.sales} sales`} />
        <Tile label="All time" value={rs(s.all.revenue)} profit={s.all} sub={`${s.all.sales} sales`} />
        <Tile label="Cash vs online" value={`${s.all.revenue ? Math.round((cash / s.all.revenue) * 100) : 0}% cash`} sub={`${rs(cash)} cash · ${rs(online)} online`} />
      </div>
      {(s.units_without_cost > 0 || s.stock_value.no_cost > 0) && (
        <button onClick={() => setFixing(true)} className="flex w-full items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[13px] text-amber-800">
          <span>Some items have no buy price, so their profit is counted as if they were free.</span>
          <span className="shrink-0 font-semibold underline">Set buy prices</span>
        </button>
      )}
      <MissingCosts open={fixing} onClose={() => setFixing(false)} onSaved={load} />
      <LineChart title="Last 24 hours" note="Last 24 hours" points={last24(s.last_24h)} every={4} onHistory={() => showHistory("hours")} />
      <div className="grid gap-3 md:grid-cols-2">
        <Bars onHistory={() => showHistory("leaderboard")} label="Leaderboard" value="profit" fmt={rs} rows={s.by_cashier.map((c) => ({ key: c.user_id, label: c.name, value: c.profit, sub: `${c.sales} sales` }))} />
        <Bars onHistory={() => showHistory("sellers")} label="Best sellers" value="units sold" fmt={(n) => `${n}`} rows={s.top_items.map((i) => ({ key: i.item_id, label: i.name, value: i.qty, sub: rs(i.revenue) }))} />
        <Bars onHistory={() => showHistory("profit")} label="Most profitable" value="profit" fmt={rs} rows={s.top_profit.filter((i) => i.profit > 0).map((i) => ({ key: i.item_id, label: i.name, value: i.profit, sub: `${i.qty} sold` }))} />
        <Card className="p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-[13px] font-semibold">Stock on the shelf</h2>
            <Link to="/pos" className="text-xs text-neutral-400 hover:text-ink">Counter →</Link>
          </div>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-neutral-500">Paid for it</dt><dd className="tabular font-medium">{rs(s.stock_value.at_cost)}</dd></div>
            <div className="flex justify-between"><dt className="text-neutral-500">Sells for</dt><dd className="tabular font-medium">{rs(s.stock_value.at_price)}</dd></div>
            <div className="flex justify-between border-t border-line pt-1.5"><dt className="text-neutral-500">Profit if it all sells</dt><dd className="tabular font-semibold text-emerald-700">{rs(s.stock_value.profit)}</dd></div>
          </dl>
          {s.stock_value.no_cost > 0 && <p className="mt-2 text-xs text-amber-700">{s.stock_value.no_cost} item{s.stock_value.no_cost > 1 ? "s have" : " has"} no buy price yet, so it is left out of the profit.</p>}
        </Card>

      </div>
      <LineChart title="Last 14 days" note="Last 14 days" points={last14(s.by_day)} every={2} onHistory={() => showHistory("days")} />
      {open && <HistoryModal open onClose={() => setOpen(null)} title={CHARTS[open].title} note="Voided sales are excluded." headers={CHARTS[open].headers} rows={CHARTS[open].rows(s, history)} />}
    </div>
  );
}
