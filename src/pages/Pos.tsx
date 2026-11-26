import { useEffect, useMemo, useRef, useState } from "react";
import { api, imgUrl, priceInput, rs, timeAgo } from "../api";
import { useAuth } from "../auth";
import { Button, ItemImage, Modal, Spinner, cx, toast } from "../components/ui";
import { ShiftNotice } from "../components/StartShift";
import { ItemEditor, ShiftFirst, StockDialog, type StockMode } from "../components/ItemDialogs";
import { canOperate, EXTRA_ITEM, isExtraItem, round2, walletName, type Item } from "../../shared/types";

type Line = { item: Item; qty: number };
type Incoming = { id: number; source: string; amount: number | null; sender_name: string | null; received_at: string };

// Online payments that arrived in the last 30 minutes and aren't linked yet. While someone is taking an online
// payment the NayaPay inbox is checked right away and every 15 seconds, and the list refreshes every 5 seconds.
function useIncoming(active: boolean, live: boolean) {
  const [list, setList] = useState<Incoming[]>([]);
  const [checked, setChecked] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const read = () => api("/api/payments/recent").then((d) => !stop && setList(d.payments)).catch(() => {});
    const sync = () => (live ? api("/api/payments/sync", { method: "POST" }).catch(() => {}) : Promise.resolve()).then(() => { if (!stop) { setChecked(Date.now()); read(); } });
    sync();
    const a = setInterval(read, 5_000);
    const b = setInterval(sync, 15_000);
    return () => { stop = true; clearInterval(a); clearInterval(b); };
  }, [active, live]);
  return { list, checked, refresh: () => api("/api/payments/recent").then((d) => setList(d.payments)).catch(() => {}) };
}

function PaymentPicker({ list, checked, total, picked, onPick }: { list: Incoming[]; checked: number | null; total: number; picked: number | null; onPick: (id: number | null) => void }) {
  return (
    <div className="text-[12px]">
      <div className="mb-1 flex items-center justify-between text-neutral-500">
        <span className="font-medium">Online payments, last 30 min</span>
        <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />{checked ? "checking live" : "checking…"}</span>
      </div>
      {list.length === 0 ? <div className="rounded-md border border-dashed border-line px-3 py-2 text-neutral-400">Waiting for the payment…</div> : (
        <ul className="space-y-1">
          {list.map((p) => (
            <li key={p.id}>
              <button onClick={() => onPick(picked === p.id ? null : p.id)} className={cx("flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-left", picked === p.id ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line text-neutral-700 hover:bg-neutral-50")}>
                <span className="truncate">{picked === p.id ? "✓ " : ""}{p.sender_name ?? "Payment"} · {walletName(p.source)} · {timeAgo(p.received_at)}</span>
                <span className={cx("tabular ml-2 shrink-0", p.amount === total && total > 0 && "font-semibold text-emerald-700")}>{p.amount == null ? "?" : rs(p.amount)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Pos() {
  const { user, shift, onCounter } = useAuth();
  const live = canOperate(user, shift);
  const [items, setItems] = useState<Item[] | null>(null);
  const [cart, setCart] = useState<Line[]>([]);
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  // Online is the default (most customers pay on NayaPay or SadaPay); cash is the deliberate choice and asks for a confirmation.
  const [payment, setPayment] = useState<"cash" | "online">("online");
  const [confirmCash, setConfirmCash] = useState(false);
  // Online sales and linking a payment ask first too, so the wrong online payment doesn't get attached.
  const [confirmOnline, setConfirmOnline] = useState(false);
  const [confirmLast, setConfirmLast] = useState<Incoming | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ id: number; total: number; online: boolean; linked: boolean } | null>(null);
  const [cash, setCash] = useState("");
  // Extra money the customer adds on top (cash or online). It can only raise the total and is booked on Stickers.
  const [extra, setExtra] = useState("");
  const [addStickers, setAddStickers] = useState(false);
  const [payId, setPayId] = useState<number | null>(null);
  const [open, setOpen] = useState(false); // order sheet on phones
  const [newItem, setNewItem] = useState<"new" | null>(null);
  const [stockItem, setStockItem] = useState<Item | null>(null);
  const [stockMode, setStockMode] = useState<StockMode>("restock");
  const setRestock = (i: Item | null) => { setStockMode("restock"); setStockItem(i); };
  // Press and hold a tile (right-click on a computer) to edit the item right here: prices, details and stock.
  // This replaced the separate Inventory page.
  const [editing, setEditing] = useState<Item | null>(null);
  const [needShift, setNeedShift] = useState(false);
  const hold = useRef<{ timer?: number; fired: boolean; x: number; y: number }>({ fired: false, x: 0, y: 0 });
  const openEditor = (i: Item) => {
    hold.current.fired = true;
    window.clearTimeout(hold.current.timer);
    navigator.vibrate?.(12);
    if (!live) return setNeedShift(true);
    setEditing(i);
  };
  const holdProps = (i: Item) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      hold.current = { fired: false, x: e.clientX, y: e.clientY, timer: window.setTimeout(() => openEditor(i), 450) };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (Math.abs(e.clientX - hold.current.x) + Math.abs(e.clientY - hold.current.y) > 10) window.clearTimeout(hold.current.timer);
    },
    onPointerUp: () => window.clearTimeout(hold.current.timer),
    onPointerLeave: () => window.clearTimeout(hold.current.timer),
    onPointerCancel: () => window.clearTimeout(hold.current.timer),
    onContextMenu: (e: React.MouseEvent) => { e.preventDefault(); if (!hold.current.fired) openEditor(i); },
    onClick: () => { if (hold.current.fired) { hold.current.fired = false; return; } add(i); },
  });

  // Check the inbox while choosing an online payment, and after an online sale until its payment is linked.
  const pay = useIncoming(live && ((payment === "online" && cart.length > 0) || (!!last?.online && !last.linked)), live);

  const load = () => api("/api/items").then((d) => setItems(d.items));
  useEffect(() => { load(); }, []);

  const cats = useMemo(() => ["All", ...Array.from(new Set((items ?? []).map((i) => i.category)))], [items]);
  // Best sellers first (last 30 days); anything sold out drops to the end.
  const shown = (items ?? [])
    .filter((i) => i.visible && (cat === "All" || i.category === cat) && i.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.stock > 0) - Number(a.stock > 0) || (b.sold ?? 0) - (a.sold ?? 0) || a.name.localeCompare(b.name));
  const stickers = (items ?? []).find(isExtraItem);
  const extraAmt = round2(Number(extra) || 0);
  const total = round2(cart.reduce((s, l) => s + l.item.price * l.qty, 0) + extraAmt);
  const count = cart.reduce((s, l) => s + l.qty, 0);
  const change = cash ? Number(cash) - total : null;

  const inCart = (id: number) => cart.find((l) => l.item.id === id)?.qty ?? 0;
  const add = (item: Item) => {
    if (item.stock - inCart(item.id) <= 0) {
      if (live) return setRestock(item);
      return toast(`${item.name} is out of stock`, true);
    }
    setLast(null);
    setCart((c) => (c.some((l) => l.item.id === item.id) ? c.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { item, qty: 1 }]));
  };
  const clear = () => { setCart([]); setExtra(""); };
  const dec = (id: number) => setCart((c) => c.map((l) => (l.item.id === id ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0));

  const checkout = async () => {
    if (!cart.length) return;
    setBusy(true);
    try {
      const online = payment === "online";
      const d = await api("/api/sales", { json: { items: cart.map((l) => ({ item_id: l.item.id, qty: l.qty })), payment, payment_id: online ? payId : null, extra: extraAmt } });
      setLast({ id: d.sale.id, total: d.sale.total, online, linked: !online || !!d.sale.payment_linked });
      clear(); setCash(""); setPayId(null); setOpen(false); setConfirmCash(false); setConfirmOnline(false); setPayment("online");
      toast(`Sale #${d.sale.id} · ${rs(d.sale.total)}`);
      await load();
    } catch (e: any) {
      toast(e.message, true);
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Charge always takes two taps: a centred pop-up confirms cash ("is this really cash?") or online (which NayaPay/SadaPay
  // payment gets linked, and whether its amount matches).
  const requestCharge = () => {
    if (!cart.length || busy) return;
    if (payment === "cash") return setConfirmCash(true);
    setConfirmOnline(true);
  };

  // Link a payment to the sale that was just made, without leaving the counter.
  const linkLast = async (paymentId: number | null) => {
    if (!last || paymentId == null) return;
    try {
      await api(`/api/payments/${paymentId}/match`, { json: { sale_id: last.id } });
      setLast({ ...last, linked: true });
      toast(`Payment linked to sale #${last.id}`);
      pay.refresh();
    } catch (e: any) { toast(e.message, true); }
  };

  const lines = (
    <ul className="divide-y divide-line">
      {cart.map((l) => (
        <li key={l.item.id} className="flex items-center gap-2 py-1.5">
          <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{l.item.name}</div>
          <div className="flex items-center">
            <button onClick={() => dec(l.item.id)} className="grid h-7 w-7 place-items-center rounded-md text-base leading-none text-neutral-600 hover:bg-neutral-100" aria-label="One less">−</button>
            <span className="tabular w-5 text-center text-[13px] font-semibold">{l.qty}</span>
            <button onClick={() => add(l.item)} className="grid h-7 w-7 place-items-center rounded-md text-base leading-none text-neutral-600 hover:bg-neutral-100" aria-label="One more">+</button>
          </div>
          <div className="tabular w-16 text-right text-[13px] font-semibold">{rs(l.item.price * l.qty)}</div>
        </li>
      ))}
    </ul>
  );

  const extraRow = stickers ? (
    <label className="flex items-center gap-2">
      <span className="min-w-0 flex-1 text-[12px] text-neutral-600">Extra on top <span className="text-neutral-400">· goes to {stickers.name}</span></span>
      <input inputMode="decimal" value={extra} onChange={(e) => setExtra(priceInput(e.target.value))} placeholder="+ Rs 0" aria-label={`Extra amount, goes to ${stickers.name}`} className="tabular w-28 rounded-md border border-line px-3 py-1.5 text-right text-[16px] focus:border-neutral-400 focus:outline-none md:text-[13px]" />
    </label>
  ) : live && (
    <button onClick={() => setAddStickers(true)} className="text-[12px] text-neutral-500 hover:text-accent">+ Add a {EXTRA_ITEM} item to take an extra amount</button>
  );

  const payBlock = cart.length > 0 && (
    <div className="space-y-2.5">
      {extraRow}
      <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-[12px] font-medium">
        {(["online", "cash"] as const).map((p) => (
          <button key={p} onClick={() => setPayment(p)} className={cx("flex-1 rounded-md py-2 capitalize", payment === p ? "bg-white shadow-sm" : "text-neutral-500")}>{p}</button>
        ))}
      </div>
      {payment === "cash" ? (
        <div className="grid grid-cols-2 gap-2">
          <input inputMode="numeric" value={cash} onChange={(e) => setCash(e.target.value.replace(/\D/g, ""))} placeholder="Cash given (Rs)" className="tabular w-full rounded-md border border-line px-3 py-2 text-[16px] focus:border-neutral-400 focus:outline-none md:text-[14px]" />
          <div className={cx("tabular flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2 text-[14px]", change !== null && change < 0 ? "text-red-600" : "text-neutral-600")}>
            <span>Change</span><b>{change === null ? "–" : rs(change)}</b>
          </div>
        </div>
      ) : (
        <PaymentPicker list={pay.list} checked={pay.checked} total={total} picked={payId} onPick={setPayId} />
      )}
    </div>
  );

  const done = last && (
    <div className="rise space-y-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-900">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide">Sale #{last.id} done</span>
        <span className="tabular text-lg font-semibold">{rs(last.total)}</span>
      </div>
      {last.online && !last.linked && (
        <div className="rounded-md bg-white p-2.5">
          <PaymentPicker list={pay.list} checked={pay.checked} total={last.total} picked={null} onPick={(id) => setConfirmLast(pay.list.find((p) => p.id === id) ?? null)} />
          <p className="mt-1.5 text-[11px] text-neutral-500">Tap the payment for this sale when it arrives.</p>
        </div>
      )}
      {last.online && last.linked && <div className="text-xs">Payment linked ✓</div>}
    </div>
  );

  const charge = (
    <Button onClick={requestCharge} disabled={!cart.length || busy || !live} variant="primary" className="w-full justify-between py-2.5 text-[14px]">
      <span>{live ? "Charge" : "Start your shift to charge"}</span>
      <span className="tabular">{rs(total)}</span>
    </Button>
  );

  return (
    <div className="flex h-[calc(100dvh-61px)] flex-col md:h-dvh md:flex-row">
      {/* Items */}
      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4">
        <div className="mb-3"><ShiftNotice what="sell at the counter" /></div>
        {onCounter.length > 0 && <p className="mb-3 text-xs text-neutral-500">On counter now: {onCounter.map((o) => o.user_name).join(", ")}</p>}
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto">
            {cats.map((c) => (
              <button key={c} onClick={() => setCat(c)} className={cx("whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium", cat === c ? "bg-accent-soft text-accent" : "text-neutral-500 hover:text-ink")}>{c}</button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" className="order-first w-full rounded-md border border-line px-3 py-2 text-[14px] focus:border-neutral-400 focus:outline-none sm:order-none sm:w-44 sm:shrink-0 sm:py-1.5 sm:text-[13px]" />
        </div>
        <p className="-mt-1 mb-2 text-[11px] text-neutral-400">Tap to add · press and hold to edit price, stock and details</p>
        {items === null ? <Spinner /> : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {shown.map((i) => {
              const left = i.stock - inCart(i.id);
              const n = inCart(i.id);
              return (
                <button key={i.id} {...holdProps(i)} className={cx("relative select-none overflow-hidden rounded-lg bg-white text-left ring-1 transition [-webkit-touch-callout:none] active:scale-[.97]", n ? "ring-2 ring-accent" : "ring-line hover:ring-neutral-400")}>
                  <ItemImage src={imgUrl(i.image_key)} name={i.name} className={cx("aspect-[4/3] w-full", left <= 0 && "opacity-40")} />
                  <div className="p-2">
                    <div className={cx("truncate text-xs font-semibold", left <= 0 && "text-neutral-400")}>{i.name}</div>
                    <div className="mt-0.5 flex items-center justify-between gap-1 whitespace-nowrap text-xs">
                      <span className="tabular font-bold">{rs(i.price)}</span>
                      {left <= 0
                        ? <span className="truncate font-medium text-accent">{live ? "Restock" : "Sold out"}</span>
                        : <span className={cx("tabular", left <= i.low_stock_at ? "text-amber-700" : "text-neutral-400")}>{left} left</span>}
                    </div>
                  </div>
                  {n > 0 && <span key={n} className="pop tabular absolute right-1.5 top-1.5 grid h-6 min-w-6 place-items-center rounded-full bg-brand-soft px-1.5 text-[12px] font-semibold text-brand-ink shadow-sm ring-1 ring-brand-edge">{n}</span>}
                </button>
              );
            })}
            {live && (
              <button onClick={() => setNewItem("new")} className="flex min-h-28 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-neutral-300 p-2 text-center text-xs font-medium text-neutral-500 hover:border-accent hover:text-accent">
                <span className="text-xl leading-none">+</span>
                {q.trim() ? <>Add “{q.trim()}”</> : "New item"}
              </button>
            )}
          </div>
        )}
        {items !== null && shown.length === 0 && !live && <p className="py-10 text-center text-sm text-neutral-400">Nothing matches “{q}”.</p>}
      </div>

      {/* Order: side panel on desktop; one-line bar that opens into a sheet on phones */}
      <aside className="hidden flex-col border-l border-line bg-white md:flex md:w-80 lg:w-96">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="text-[14px] font-semibold">Order {count > 0 && <span className="text-neutral-400">· {count}</span>}</h2>
          {cart.length > 0 && <button onClick={clear} className="text-xs text-neutral-500 hover:text-red-600">Clear</button>}
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-3">
          {cart.length === 0 ? (done || <p className="py-8 text-center text-sm text-neutral-400">Tap items to add them</p>) : lines}
          {payBlock}
        </div>
        <div className="border-t border-line p-3">{charge}</div>
      </aside>

      <div className="fixed inset-x-0 bottom-[max(env(safe-area-inset-bottom),8px)] z-20 md:hidden">
        {open && cart.length > 0 && (
          <div className="rise mx-2 mb-1 max-h-[60dvh] space-y-3 overflow-y-auto rounded-xl border border-line bg-white p-3 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-[14px] font-semibold">Order · {count}</h2>
              <button onClick={() => { clear(); setOpen(false); }} className="text-xs text-neutral-500 hover:text-red-600">Clear</button>
            </div>
            {lines}
            {payBlock}
          </div>
        )}
        {cart.length === 0 && done && <div className="mx-2 mb-1">{done}</div>}
        {cart.length > 0 && (
          <div className="mx-2 flex items-center gap-2 rounded-xl border border-line bg-white p-2 shadow-lg">
            <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left">
              <span key={count} className="pop tabular grid h-6 min-w-6 place-items-center rounded-full bg-brand-soft px-1.5 text-[12px] font-semibold text-brand-ink ring-1 ring-brand-edge">{count}</span>
              <span className="min-w-0 flex-1">
                <span className="tabular block text-[15px] font-semibold">{rs(total)}</span>
                <span className="block truncate text-[11px] text-neutral-500">{payment === "online" ? (payId ? "Online · payment picked" : "Online") : "Cash"} · {open ? "hide" : "view order"}</span>
              </span>
              <span className={cx("text-neutral-400 transition", open && "rotate-180")}>▴</span>
            </button>
            <Button onClick={requestCharge} disabled={busy || !live} variant="primary" className="px-5 py-2.5 text-[14px]">Charge</Button>
          </div>
        )}
      </div>

      <Modal open={confirmCash} onClose={() => !busy && setConfirmCash(false)} title="Cash sale?" center>
        <div className="space-y-4">
          <div className="rounded-lg bg-neutral-50 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-neutral-600">{count} item{count === 1 ? "" : "s"}{extraAmt > 0 ? ` + ${rs(extraAmt)} extra` : ""}, paid in <b className="text-ink">cash</b></span>
              <span className="tabular text-xl font-semibold">{rs(total)}</span>
            </div>
            {change !== null && change >= 0 && <div className="tabular mt-1 text-right text-[13px] text-neutral-600">Cash {rs(Number(cash))} · change <b>{rs(change)}</b></div>}
          </div>
          <p className="text-[13px] text-neutral-600">Only confirm if the customer handed over cash. If they paid on NayaPay or SadaPay, go back and pick <b>Online</b> so the payment gets linked.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => { setConfirmCash(false); setPayment("online"); }} disabled={busy} className="py-2.5">Switch to online</Button>
            <Button onClick={checkout} disabled={busy} variant="primary" className="py-2.5">{busy ? "Saving…" : "Yes, cash"}</Button>
          </div>
        </div>
      </Modal>
      <Modal open={confirmOnline} onClose={() => !busy && setConfirmOnline(false)} title="Online sale?" center>
        {(() => {
          const p = payId == null ? null : pay.list.find((x) => x.id === payId) ?? null;
          return (
            <div className="space-y-4">
              <div className="space-y-2 rounded-lg bg-neutral-50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm text-neutral-600">{count} item{count === 1 ? "" : "s"}{extraAmt > 0 ? ` + ${rs(extraAmt)} extra` : ""}, paid <b className="text-ink">online</b></span>
                  <span className="tabular text-xl font-semibold">{rs(total)}</span>
                </div>
                {p ? (
                  <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2 text-[13px]">
                    <span className="min-w-0 truncate text-neutral-600">Linking {walletName(p.source)} from <b className="text-ink">{p.sender_name ?? "unknown"}</b> · {timeAgo(p.received_at)}</span>
                    <span className={cx("tabular font-semibold", p.amount === total ? "text-emerald-700" : "text-amber-700")}>{p.amount == null ? "?" : rs(p.amount)}</span>
                  </div>
                ) : (
                  <div className="border-t border-line pt-2 text-[13px] text-neutral-500">No online payment picked. You can link it right after charging.</div>
                )}
              </div>
              {p && p.amount !== total && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">That payment's amount doesn't match the total. Go back and pick the right one unless you're sure.</p>}
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={() => setConfirmOnline(false)} disabled={busy} className="py-2.5">Back</Button>
                <Button onClick={checkout} disabled={busy} variant="primary" className="py-2.5">{busy ? "Saving…" : "Yes, charge"}</Button>
              </div>
            </div>
          );
        })()}
      </Modal>
      <Modal open={!!confirmLast} onClose={() => setConfirmLast(null)} title="Link this payment?" center>
        {confirmLast && last && (
          <div className="space-y-4">
            <div className="space-y-2 rounded-lg bg-neutral-50 p-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate"><span className="text-neutral-500">{walletName(confirmLast.source)} from </span><b>{confirmLast.sender_name ?? "unknown"}</b> <span className="text-neutral-400">· {timeAgo(confirmLast.received_at)}</span></span>
                <span className="tabular font-semibold">{confirmLast.amount == null ? "?" : rs(confirmLast.amount)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-neutral-500">to sale <b className="text-ink">#{last.id}</b></span>
                <span className="tabular font-semibold">{rs(last.total)}</span>
              </div>
            </div>
            {confirmLast.amount !== last.total && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">The amounts don't match. Only link it if you're sure this payment was for this sale.</p>}
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setConfirmLast(null)} className="py-2.5">Cancel</Button>
              <Button onClick={() => { const id = confirmLast.id; setConfirmLast(null); linkLast(id); }} variant="primary" className="py-2.5">Yes, link it</Button>
            </div>
          </div>
        )}
      </Modal>
      <ItemEditor item={newItem} newName={q.trim()} categories={cats.slice(1)} onClose={() => setNewItem(null)} onSaved={() => { setQ(""); load(); }} />
      <ItemEditor item={addStickers ? "new" : null} newName={EXTRA_ITEM} categories={cats.slice(1)} onClose={() => setAddStickers(false)} onSaved={() => load()} />
      <StockDialog item={stockItem} mode={stockMode} onClose={() => setStockItem(null)} onSaved={load} />
      <ItemEditor item={editing} categories={cats.slice(1)} onClose={() => setEditing(null)} onSaved={() => load()}
        onStock={(m) => { const i = editing; setEditing(null); setStockMode(m); setStockItem(i); }} />
      <ShiftFirst open={needShift} what="Items, prices and stock" onClose={() => setNeedShift(false)} />
    </div>
  );
}
