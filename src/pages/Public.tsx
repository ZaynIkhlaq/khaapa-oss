import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, imgUrl, rs } from "../api";
import { ItemImage, Logo, Spinner, btn, cx } from "../components/ui";
import { SHOP_PLACE, type PublicItem } from "../../shared/types";

export default function Public() {
  const [items, setItems] = useState<PublicItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [cat, setCat] = useState<string>("All");
  const [q, setQ] = useState("");

  useEffect(() => {
    const load = () => api("/api/public/items").then((d) => { setItems(d.items); setOpen(d.open); }).catch(() => setItems([]));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const cats = useMemo(() => ["All", ...Array.from(new Set((items ?? []).map((i) => i.category)))], [items]);
  const shown = (items ?? []).filter((i) => (cat === "All" || i.category === cat) && i.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="relative min-h-dvh pb-20 sm:pb-0">
      {/* Top bar: logo left; on phones only "Staff login" on the right (pre-order is the big button below and the
          sticky bar), from sm up the open status and Pre-order join it. Nothing here may wrap. */}
      <header className="absolute inset-x-0 top-0 z-20">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-5 py-4">
          <span />
          <nav className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            <Link to="/preorder" className={btn({ size: "sm", className: "hidden sm:inline-flex" })}>Pre-order</Link>
            <Link to="/login" className={btn({ variant: "ghost", size: "sm" })}>Staff login</Link>
          </nav>
        </div>
      </header>

      {/* Hero: the stamp, big and gently floating, over slow drifting brand glows. */}
      <section className="relative isolate overflow-hidden border-b border-line bg-neutral-50">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="glow glow-a -left-24 -top-24 h-[28rem] w-[28rem] bg-accent/40" />
          <div className="glow glow-b -right-20 top-10 h-[24rem] w-[24rem] bg-brand/35" />
          <div className="glow glow-c bottom-[-10rem] left-1/3 h-[26rem] w-[26rem] bg-[#e3c1d3]" />
          <div className="dot-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]" />
        </div>
        <div className="mx-auto flex max-w-3xl flex-col items-center px-5 pb-14 pt-24 text-center sm:pb-20 sm:pt-28">
          <img src="/logo-wide.webp" alt="Khaapa" className="float h-40 w-auto drop-shadow-[0_18px_30px_rgba(92,47,128,0.25)] sm:h-60 lg:h-72" />
          <OpenStatus open={open} className="mt-8 inline-flex" />
          <h1 className="mt-4 text-[32px] font-semibold leading-[1.1] tracking-tight sm:text-5xl">The student-run tuck shop at {SHOP_PLACE.name}.</h1>
          <p className="mt-4 max-w-lg text-balance text-[15px] leading-relaxed text-neutral-600 sm:text-base">Snacks and drinks with a live menu, prices and stock. Pre-order for today or tomorrow.</p>
          <div className="mt-8 flex w-full flex-col gap-2.5 sm:w-auto sm:flex-row">
            <Link to="/preorder" className={btn({ size: "lg" })}>Pre-order</Link>
            <a href="#menu" className={btn({ variant: "outline", size: "lg" })}>See the menu</a>
          </div>
        </div>
      </section>

      <div id="menu" className="sticky top-0 z-10 scroll-mt-0 border-b border-line bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-2 px-5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
          <div className="flex min-w-0 gap-1 overflow-x-auto">
            {cats.map((c) => (
              <button key={c} onClick={() => setCat(c)} className={cx("whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition", cat === c ? "bg-accent-soft text-accent" : "text-neutral-500 hover:text-ink")}>
                {c}
              </button>
            ))}
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the menu" className="order-first w-full rounded-md border border-line px-3 py-2 text-[14px] focus:border-neutral-400 focus:outline-none sm:order-none sm:ml-auto sm:w-52 sm:py-1.5 sm:text-[13px]" />
          <Link to="/preorder" className={btn({ size: "sm", className: "hidden shrink-0 sm:inline-flex" })}>Pre-order</Link>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] px-5 py-6">
        {items === null ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-neutral-500">Nothing here yet.</p>
        ) : (
          (cat === "All" ? cats.slice(1).map((c) => ({ c, list: shown.filter((i) => i.category === c) })) : [{ c: cat, list: shown }]).filter((g) => g.list.length).map((g) => (
          <section key={g.c} className="mb-10">
            <h2 className="mb-4 text-[15px] font-semibold">{g.c} <span className="ml-1 text-[13px] font-normal text-neutral-400">{g.list.length}</span></h2>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {g.list.map((i) => (
              <li key={i.id} className={cx("rise group", i.availability === "out" && "opacity-50")}>
                <div className="relative aspect-square overflow-hidden rounded-lg border border-line bg-neutral-50">
                  <ItemImage src={imgUrl(i.image_key)} name={i.name} className="h-full w-full" />
                  {i.availability !== "in" && (
                    <span className={cx("absolute left-2 top-2 rounded-md px-1.5 py-0.5 text-[11px] font-medium", i.availability === "out" ? "bg-ink text-white" : "bg-white text-amber-700 ring-1 ring-line")}>
                      {i.availability === "out" ? "Sold out" : "Few left"}
                    </span>
                  )}
                </div>
                <div className="mt-2.5 flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[14px] font-medium leading-tight">{i.name}</div>
                    <div className="mt-0.5 text-[12px] text-neutral-500">{i.category}</div>
                  </div>
                  <div className="tabular shrink-0 text-[14px] font-medium">{rs(i.price)}</div>
                </div>
              </li>
            ))}
          </ul>
          </section>
          ))
        )}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-white/90 p-3 pb-[max(env(safe-area-inset-bottom),12px)] backdrop-blur sm:hidden">
        <Link to="/preorder" className={btn({ size: "lg", className: "w-full" })}>Pre-order</Link>
      </div>

      <footer className="border-t border-line bg-neutral-50">
        <div className="mx-auto grid max-w-[1600px] gap-8 px-5 py-10 text-[13px] text-neutral-500 sm:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <Logo className="h-6" />
            </div>
            <p className="mt-2 leading-relaxed">The student-run tuck shop at {SHOP_PLACE.name}, {SHOP_PLACE.campus}.</p>
          </div>
          <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">Find us</h3>
            <ul className="mt-2 space-y-1.5">
              <li>{SHOP_PLACE.name}, {SHOP_PLACE.campus}</li>
              <li><Link to="/preorder" className="hover:text-ink">Pre-order for today or tomorrow</Link></li>
              <li><Link to="/login" className="hover:text-ink">Staff login</Link></li>
            </ul>
          </div>
          {SHOP_PLACE.lat != null && SHOP_PLACE.lng != null && <div>
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-neutral-400">Map</h3>
            <iframe
              title={`Map of ${SHOP_PLACE.name}, ${SHOP_PLACE.campus}`}
              src={`https://maps.google.com/maps?q=${SHOP_PLACE.lat},${SHOP_PLACE.lng}&z=17&output=embed`}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              className="mt-2 h-44 w-full rounded-lg border border-line bg-white"
            />
            <a href={`https://www.google.com/maps/search/?api=1&query=${SHOP_PLACE.lat},${SHOP_PLACE.lng}`} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block hover:text-ink">Open in Google Maps</a>
          </div>}
        </div>
        <div className="mx-auto max-w-[1600px] px-5 pb-6 text-[12px] text-neutral-400">
          © {new Date().getFullYear()} Khaapa · {SHOP_PLACE.name}, {SHOP_PLACE.campus} · prices in PKR
        </div>
      </footer>
    </div>
  );
}

function OpenStatus({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={cx("items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[13px] font-medium", open ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-500", className ?? "inline-flex")}>
      <span className={cx("h-1.5 w-1.5 rounded-full", open ? "bg-emerald-500" : "bg-neutral-300")} />
      {open ? "Open now" : "Closed"}
    </span>
  );
}
