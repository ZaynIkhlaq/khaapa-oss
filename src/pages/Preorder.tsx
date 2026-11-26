import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDay, imgUrl, rs, waLink } from "../api";
import { Button, Field, Input, ItemImage, Logo, Spinner, cx, toast } from "../components/ui";
import type { PreorderSettings } from "../../shared/types";

type PItem = { id: number; name: string; category: string; price: number; image_key: string | null };
type Placed = { id: number; token: string; code: string; total: number; pickup_on: string; lines: { name: string; qty: number; unit_price: number }[] };

function Stepper({ qty, onChange }: { qty: number; onChange: (n: number) => void }) {
  if (qty === 0) return <Button onClick={() => onChange(1)} className="min-h-8 px-3">Add</Button>;
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onChange(qty - 1)} className="grid h-8 w-8 place-items-center rounded-md border border-line text-lg leading-none hover:bg-neutral-50" aria-label="Less">−</button>
      <span className="tabular w-6 text-center text-sm font-semibold">{qty}</span>
      <button onClick={() => onChange(qty + 1)} className="grid h-8 w-8 place-items-center rounded-md border border-line text-lg leading-none hover:bg-neutral-50" aria-label="More">+</button>
    </div>
  );
}

// Phone screenshots can be several MB; shrink to a readable JPEG before uploading.
async function shrink(file: File): Promise<Blob> {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

function Done({ order, settings, name }: { order: Placed; settings: PreorderSettings; name: string }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const base = `Hi Khaapa, I paid for pre-order ${order.code} (${rs(order.total)}, pickup ${fmtDay(order.pickup_on)}). Name: ${name}.`;
  const plainWa = settings.whatsapp ? waLink(settings.whatsapp, `${base} Sending my payment screenshot.`) : null;
  const copy = async (v: string) => { await navigator.clipboard.writeText(v); toast("Copied"); };
  // Both wallets run side by side; show whichever numbers the admins filled in.
  const accounts = [
    { app: "NayaPay", number: settings.nayapay_number, name: settings.nayapay_name },
    { app: "SadaPay", number: settings.sadapay_number, name: settings.sadapay_name },
  ].filter((a) => a.number);

  // One tap: pick the screenshot, it uploads, then WhatsApp opens with a message that links to it.
  const sendProof = async (file: File | undefined) => {
    if (!file) return;
    setSending(true);
    try {
      const fd = new FormData();
      fd.set("token", order.token);
      fd.set("image", await shrink(file), "screenshot.jpg");
      const d = await api(`/api/public/preorders/${order.id}/proof`, { method: "POST", body: fd });
      setSent(true);
      const wa = settings.whatsapp ? waLink(settings.whatsapp, `${base} Payment screenshot: ${d.url}`) : null;
      if (wa) window.location.href = wa;
    } catch (err: any) { toast(err.message, true); } finally { setSending(false); }
  };
  return (
    <div className="rise mx-auto max-w-md space-y-5 px-5 py-10">
      <div>
        <div className="text-[13px] font-medium text-emerald-700">Order placed</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Order {order.code}</h1>
        <p className="mt-1 text-sm text-neutral-500">Pickup {fmtDay(order.pickup_on)} at the Khaapa counter.</p>
      </div>
      <div className="rounded-lg border border-line">
        <ul className="divide-y divide-line text-sm">
          {order.lines.map((l) => (
            <li key={l.name} className="flex justify-between px-4 py-2"><span>{l.qty}× {l.name}</span><span className="tabular">{rs(l.qty * l.unit_price)}</span></li>
          ))}
        </ul>
        <div className="flex justify-between border-t border-line px-4 py-2.5 font-semibold"><span>Total</span><span className="tabular">{rs(order.total)}</span></div>
      </div>
      <ol className="space-y-4 text-sm">
        <li>
          <div className="font-semibold">1. Send {rs(order.total)} on {accounts.length ? accounts.map((a) => a.app).join(" or ") : "NayaPay or SadaPay"}</div>
          {accounts.length ? accounts.map((a) => (
            <div key={a.app} className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-4 py-3">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{a.app}</div>
                <div className="tabular text-base font-semibold">{a.number}</div>
                {a.name && <div className="text-xs text-neutral-500">{a.name}</div>}
              </div>
              <Button onClick={() => copy(a.number)} className="min-h-8 px-3">Copy</Button>
            </div>
          )) : <p className="mt-1 text-neutral-500">Ask us on WhatsApp for the account number.</p>}
          <p className="mt-1.5 text-xs text-neutral-500">Put <b className="text-ink">{order.code}</b> in the payment note.</p>
        </li>
        <li>
          <div className="font-semibold">2. Send us the screenshot</div>
          <label className={cx("mt-2 flex min-h-11 w-full cursor-pointer items-center justify-center rounded-md px-3 text-[14px] font-medium text-white shadow-sm", sending ? "bg-neutral-400" : "bg-[#1f9d55] hover:bg-[#1a8a4a]")}>
            {sending ? "Uploading…" : sent ? "Screenshot sent ✓ Send again" : "Pick screenshot and send on WhatsApp"}
            <input type="file" accept="image/*" className="hidden" disabled={sending} onChange={(e) => sendProof(e.target.files?.[0])} />
          </label>
          <p className="mt-1.5 text-xs text-neutral-500">
            It goes straight to us{settings.whatsapp ? ` and opens a WhatsApp chat with ${settings.whatsapp}` : ""}.
            {plainWa && <> Prefer to attach it yourself? <a href={plainWa} target="_blank" rel="noreferrer" className="underline">Open WhatsApp</a>.</>}
          </p>
        </li>
        <li>
          <div className="font-semibold">3. We confirm and keep it for you</div>
          <p className="mt-1 text-neutral-500">Someone checks the payment and confirms on WhatsApp. Show {order.code} at the counter to collect.</p>
        </li>
      </ol>
      <Link to="/" className="block text-center text-[13px] text-neutral-500 hover:text-ink">Back to the menu</Link>
    </div>
  );
}

export default function Preorder() {
  const [data, setData] = useState<{ items: PItem[]; settings: PreorderSettings; today: string; tomorrow: string } | null>(null);
  const [cart, setCart] = useState<Record<number, number>>({});
  const [form, setForm] = useState({ name: "", phone: "", pickup: "tomorrow", note: "" });
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<Placed | null>(null);

  useEffect(() => { api("/api/public/preorder").then(setData).catch(() => setData({ items: [], settings: { nayapay_number: "", nayapay_name: "", sadapay_number: "", sadapay_name: "", whatsapp: "" }, today: "", tomorrow: "" })); }, []);

  const lines = useMemo(() => (data?.items ?? []).filter((i) => cart[i.id] > 0).map((i) => ({ ...i, qty: cart[i.id] })), [data, cart]);
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const setQty = (id: number, n: number) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(50, n)) }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await api("/api/public/preorders", { json: { ...form, items: lines.map((l) => ({ item_id: l.id, qty: l.qty })) } });
      setPlaced(d.order);
      window.scrollTo(0, 0);
    } catch (err: any) { toast(err.message, true); } finally { setBusy(false); }
  };

  return (
    <div className="min-h-dvh pb-28">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <Link to="/" className="flex items-center gap-2.5"><Logo className="h-7" /></Link>
          <Link to="/" className="text-[13px] font-medium text-neutral-500 hover:text-ink">Menu</Link>
        </div>
      </header>

      {!data ? <Spinner /> : placed ? <Done order={placed} settings={data.settings} name={form.name} /> : (
        <div className="mx-auto max-w-3xl px-5">
          <section className="py-8">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pre-order</h1>
            <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-neutral-500">Pick what you want, pay on NayaPay or SadaPay, send us the screenshot on WhatsApp. We keep it for you at the counter.</p>
          </section>

          {data.items.length === 0 ? <p className="py-12 text-center text-sm text-neutral-500">Nothing to pre-order right now. Check back soon.</p> : (
            <form onSubmit={submit} className="space-y-8">
              <ul className="divide-y divide-line rounded-lg border border-line">
                {data.items.map((i) => (
                  <li key={i.id} className="flex items-center gap-3 p-3">
                    <ItemImage src={imgUrl(i.image_key)} name={i.name} className="h-14 w-14 shrink-0 rounded-md" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium">{i.name}</div>
                      <div className="tabular text-[13px] text-neutral-500">{rs(i.price)}</div>
                    </div>
                    <Stepper qty={cart[i.id] ?? 0} onChange={(n) => setQty(i.id, n)} />
                  </li>
                ))}
              </ul>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Your name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoComplete="name" /></Field>
                <Field label="WhatsApp number"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required inputMode="tel" placeholder="03xx xxxxxxx" autoComplete="tel" /></Field>
                <Field label="Pickup">
                  <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-[13px] font-medium">
                    {(["today", "tomorrow"] as const).map((p) => (
                      <button type="button" key={p} onClick={() => setForm({ ...form, pickup: p })} className={cx("flex-1 rounded px-3 py-1.5", form.pickup === p ? "bg-white shadow-sm" : "text-neutral-500")}>
                        {p === "today" ? "Today" : "Tomorrow"} <span className="font-normal text-neutral-400">{fmtDay(p === "today" ? data.today : data.tomorrow)}</span>
                      </button>
                    ))}
                  </div>
                </Field>
                <Field label="Note (optional)"><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="e.g. after 2pm" /></Field>
              </div>

              <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/95 backdrop-blur">
                <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-3 pb-[max(env(safe-area-inset-bottom),12px)]">
                  <div>
                    <div className="text-xs text-neutral-500">{lines.reduce((s, l) => s + l.qty, 0)} items</div>
                    <div className="tabular text-lg font-semibold">{rs(total)}</div>
                  </div>
                  <Button type="submit" variant="primary" disabled={busy || lines.length === 0} className="min-h-11 px-5 text-[14px]">{busy ? "Placing…" : "Place order"}</Button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
