import { useEffect, useRef, useState } from "react";
import { api, fmtTime, imgUrl, priceInput, rs } from "../api";
import { Button, Field, Input, Modal, Select, cx, toast } from "./ui";
import { CATEGORIES, canOperate, hasScope, type Item, type StockMove } from "../../shared/types";
import { useAuth } from "../auth";

// Item, stock and buy-price forms, opened wherever someone needs them (Counter long-press, Menu items, Stats)
// so nobody has to go to another page to fix something.

// Phone camera shots run 3-8 MB and the worker takes 5 MB max, so scale photos down to 1280 px JPEG before upload.
export async function shrinkImage(file: File, max = 1280): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1024 * 1024) {
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

// Shown instead of a form when someone who isn't on a shift tries to change something that needs one.
export function ShiftFirst({ open, what, onClose }: { open: boolean; what: string; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Start your shift first" center>
      <div className="space-y-4">
        <p className="text-sm text-neutral-600">{what} can only be changed during a shift. Start your shift, then you'll be able to do it.</p>
        <Button variant="primary" className="w-full" onClick={onClose}>OK</Button>
      </div>
    </Modal>
  );
}

// The item's stock at a glance with its own restock / write off / count buttons and recent movements. Lives at the
// top of the item editor when it's opened from the counter, replacing the separate Inventory page.
function StockPanel({ item, onStock }: { item: Item; onStock: (mode: StockMode) => void }) {
  const [moves, setMoves] = useState<StockMove[] | null>(null);
  const [showMoves, setShowMoves] = useState(false);
  useEffect(() => { setMoves(null); setShowMoves(false); }, [item.id]);
  useEffect(() => {
    if (showMoves && moves === null) api(`/api/stock-moves?item_id=${item.id}&limit=8`).then((d) => setMoves(d.moves)).catch(() => setMoves([]));
  }, [showMoves, moves, item.id]);
  const low = item.stock <= item.low_stock_at;
  return (
    <div className="rounded-lg border border-line bg-neutral-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-medium text-neutral-500">On the shelf</div>
          <div className={cx("tabular text-2xl font-semibold leading-tight", item.stock <= 0 ? "text-red-600" : low ? "text-amber-700" : "text-ink")}>{item.stock}</div>
        </div>
        <button type="button" onClick={() => setShowMoves((v) => !v)} className="text-[12px] font-medium text-neutral-500 hover:text-ink">{showMoves ? "Hide history" : "History"}</button>
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <Button type="button" onClick={() => onStock("restock")} className="py-2">Restock</Button>
        <Button type="button" onClick={() => onStock("waste")} className="py-2">Write off</Button>
        <Button type="button" onClick={() => onStock("count")} className="py-2">Count</Button>
      </div>
      {showMoves && (
        <ul className="mt-2.5 divide-y divide-line text-[12px]">
          {moves === null ? <li className="py-2 text-neutral-400">Loading…</li> : moves.length === 0 ? <li className="py-2 text-neutral-400">No stock changes yet.</li> : moves.map((m) => (
            <li key={m.id} className="flex items-center gap-2 py-1.5">
              <span className={cx("tabular w-8 shrink-0 text-right font-semibold", m.delta > 0 ? "text-emerald-700" : "text-neutral-700")}>{m.delta > 0 ? "+" : ""}{m.delta}</span>
              <span className="min-w-0 flex-1 truncate text-neutral-600">{m.reason}{m.note ? ` · ${m.note}` : ""} · {m.user_name}</span>
              <span className="shrink-0 text-neutral-400">{fmtTime(m.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const blank = { name: "", category: "Snacks", price: "", cost: "", stock: "0", low_stock_at: "5", visible: true, preorder: false };

export function ItemEditor({ item, newName, categories, onClose, onSaved, onStock }: {
  item: "new" | Item | null;
  newName?: string;
  categories?: string[];
  onClose: () => void;
  onSaved: (item: Item) => void;
  /** Show the stock panel (restock / write off / count) for an existing item instead of a raw stock field. */
  onStock?: (mode: StockMode) => void;
}) {
  const [f, setF] = useState(blank);
  const [file, setFile] = useState<File | null>(null);
  const [removeImg, setRemoveImg] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [customCat, setCustomCat] = useState(false);
  // Category is a fixed choice; only admins can start a new one.
  const admin = hasScope(useAuth().user, "admin");

  useEffect(() => {
    if (!item) return;
    setFile(null);
    setRemoveImg(false);
    setCustomCat(false);
    if (item === "new") setF({ ...blank, name: newName ?? "" });
    else setF({ name: item.name, category: item.category, price: String(item.price), cost: item.cost == null ? "" : String(item.cost), stock: String(item.stock), low_stock_at: String(item.low_stock_at), visible: !!item.visible, preorder: !!item.preorder });
  }, [item, newName]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("name", f.name); fd.set("category", f.category); fd.set("price", f.price || "0");
      fd.set("cost", f.cost); fd.set("low_stock_at", f.low_stock_at || "5"); fd.set("visible", f.visible ? "1" : "0"); fd.set("preorder", f.preorder ? "1" : "0");
      if (item === "new" || !onStock) fd.set("stock", f.stock || "0");
      if (file) fd.set("image", file);
      if (removeImg) fd.set("remove_image", "1");
      const d = item === "new" ? await api("/api/items", { method: "POST", body: fd }) : await api(`/api/items/${item.id}`, { method: "PUT", body: fd });
      toast(item === "new" ? `${f.name} added` : "Saved");
      onSaved(d.item);
      onClose();
    } catch (err: any) { toast(err.message, true); } finally { setBusy(false); }
  };

  const removeForGood = async () => {
    if (!item || item === "new" || !confirm(`Delete "${item.name}" for good? This can't be undone. Items that have been sold can only be archived.`)) return;
    try { await api(`/api/items/${item.id}/permanent`, { method: "DELETE" }); toast("Deleted"); onSaved(item); onClose(); } catch (err: any) { toast(err.message, true); }
  };

  const preview = file ? URL.createObjectURL(file) : !removeImg && item && item !== "new" ? imgUrl(item.image_key) : null;
  const cats = [...new Set([...CATEGORIES, ...(categories ?? []), ...(item && item !== "new" ? [item.category] : [])])];
  return (
    <Modal open={!!item} onClose={onClose} title={item === "new" ? "New item" : "Edit item"}>
      <form onSubmit={submit} className="space-y-3">
        {item && item !== "new" && onStock && <StockPanel item={item} onStock={onStock} />}
        <div className="flex items-start gap-3">
          <button type="button" onClick={() => fileRef.current?.click()} className="relative h-24 w-24 shrink-0 overflow-hidden rounded-xl bg-neutral-100 ring-1 ring-neutral-200 hover:ring-ink">
            {preview ? <img src={preview} className="h-full w-full object-cover" alt="" /> : <span className="grid h-full place-items-center text-xs text-neutral-500">+ Photo</span>}
          </button>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async (e) => { const picked = e.target.files?.[0]; setFile(picked ? await shrinkImage(picked) : null); setRemoveImg(false); }} />
          <div className="flex-1 space-y-2">
            <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus={item === "new"} /></Field>
            <Field label="Category">
              {customCat ? (
                <div className="flex gap-2">
                  <Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="New category" required autoFocus />
                  <Button type="button" onClick={() => { setCustomCat(false); setF({ ...f, category: cats[0] }); }}>Cancel</Button>
                </div>
              ) : (
                <Select value={f.category} onChange={(e) => (e.target.value === "__new" ? (setCustomCat(true), setF({ ...f, category: "" })) : setF({ ...f, category: e.target.value }))}>
                  {cats.map((c) => <option key={c} value={c}>{c}</option>)}
                  {admin && <option value="__new">+ New category…</option>}
                </Select>
              )}
            </Field>
            {preview && <button type="button" onClick={() => { setFile(null); setRemoveImg(true); }} className="text-xs text-neutral-500 hover:text-red-600">Remove photo</button>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Selling price (Rs)"><Input inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: priceInput(e.target.value) })} placeholder="e.g. 60 or 59.50" required /></Field>
          <Field label="Buy price (Rs)" hint={item === "new" ? "What we pay per unit" : "Applies from now on; past sales keep theirs"}><Input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: priceInput(e.target.value) })} placeholder="e.g. 4.17" /></Field>
          {(item === "new" || !onStock) && (<Field label={item === "new" ? "Opening stock" : "In stock"} hint={item === "new" ? undefined : "A change is logged as a correction"}><Input inputMode="numeric" value={f.stock} onChange={(e) => setF({ ...f, stock: e.target.value.replace(/\D/g, "") })} /></Field>)}
          <Field label="Low-stock alert at"><Input inputMode="numeric" value={f.low_stock_at} onChange={(e) => setF({ ...f, low_stock_at: e.target.value.replace(/\D/g, "") })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} />Show on public menu and counter</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.preorder} onChange={(e) => setF({ ...f, preorder: e.target.checked })} />Available for pre-order</label>
        {f.price !== "" && f.cost !== "" && <p className="text-xs text-neutral-500">Profit per unit: <b className="tabular text-ink">{rs(Math.round((Number(f.price) - Number(f.cost)) * 100) / 100)}</b>{Number(f.price) > 0 && ` (${Math.round(((Number(f.price) - Number(f.cost)) / Number(f.price)) * 100)}%)`}</p>}
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? "Saving…" : item === "new" ? "Add item" : "Save"}</Button>
        {item && item !== "new" && (
          <button type="button" onClick={removeForGood} className="w-full text-center text-xs text-neutral-400 hover:text-red-600">Delete permanently (only if it was never sold)</button>
        )}
      </form>
    </Modal>
  );
}

export type StockMode = "restock" | "waste" | "count";

export function StockDialog({ item, mode, onClose, onSaved }: { item: Item | null; mode: StockMode; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState("restock");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  // One save per tap: a slow network plus repeated taps once saved the same restock three times.
  const [busy, setBusy] = useState(false);
  const saving = useRef(false); // set synchronously, so even taps 20 ms apart can't both get through
  useEffect(() => { setAmount(""); setNote(""); setReason(mode === "waste" ? "waste" : mode === "count" ? "correction" : "restock"); }, [item, mode]);
  const count = mode === "count";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const body = count ? { set: n, reason: "correction", note } : { delta: reason === "waste" ? -Math.abs(n) : n, reason, note };
      await api(`/api/items/${item.id}/stock`, { json: body });
      toast("Stock updated");
      onSaved();
      onClose();
    } catch (err: any) { toast(err.message, true); } finally { saving.current = false; setBusy(false); }
  };

  return (
    <Modal open={!!item} onClose={onClose} title={count ? `Count ${item?.name}` : `Stock · ${item?.name}`}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-neutral-500">Currently <b className="tabular text-ink">{item?.stock}</b> in stock.</p>
        {count ? (
          <Field label="Actual count on the shelf" hint="The difference is logged as a correction."><Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus /></Field>
        ) : (
          <>
            <Field label="What happened">
              <Select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="restock">Restock (add)</option>
                <option value="waste">Waste / expired / damaged (remove)</option>
                <option value="correction">Correction (+/−)</option>
              </Select>
            </Field>
            <Field label={reason === "waste" ? "Quantity removed" : "Quantity"}><Input inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={reason === "correction" ? "e.g. -3 or 5" : "e.g. 24"} required autoFocus /></Field>
          </>
        )}
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bought from Metro, Rs 1,200" /></Field>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </form>
    </Modal>
  );
}

export function BuyPriceDialog({ item, onClose, onSaved }: { item: Item | null; onClose: () => void; onSaved: () => void }) {
  const { user, shift } = useAuth();
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setCost(item?.cost == null ? "" : String(item.cost)), [item]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!item || busy) return;
    setBusy(true);
    try {
      await api(`/api/items/${item.id}/cost`, { method: "PUT", json: { cost: cost === "" ? null : Number(cost) } });
      toast("Buy price saved");
      onSaved();
      onClose();
    } catch (err: any) { toast(err.message, true); } finally { setBusy(false); }
  };
  // Buy prices need an open shift (admins any time). Opened from somewhere that doesn't check (Stats), say so plainly
  // instead of letting the save fail.
  if (!canOperate(user, shift)) return <ShiftFirst open={!!item} what="Buy prices" onClose={onClose} />;
  return (
    <Modal open={!!item} onClose={onClose} title={`Buy price · ${item?.name}`}>
      <form onSubmit={save} className="space-y-3">
        <p className="text-sm text-neutral-500">Sells for <b className="tabular text-ink">{rs(item?.price)}</b>. A new buy price applies to sales from now on; past sales keep theirs.</p>
        <Field label="What we pay per unit (PKR)"><Input inputMode="decimal" value={cost} onChange={(e) => setCost(priceInput(e.target.value))} placeholder="e.g. 4.17 (empty if unknown)" autoFocus /></Field>
        <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </form>
    </Modal>
  );
}
