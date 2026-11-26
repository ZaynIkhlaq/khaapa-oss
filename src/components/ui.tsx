import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const v: Record<Variant, string> = {
    primary: "bg-accent text-white shadow-sm hover:bg-accent/90 disabled:bg-neutral-300",
    secondary: "bg-white border border-line shadow-sm text-ink hover:bg-neutral-50 disabled:text-neutral-400",
    ghost: "text-neutral-600 hover:bg-neutral-200/60 hover:text-ink",
    danger: "bg-red-50 text-red-700 border border-red-200 hover:bg-red-100",
  };
  return (
    <button
      className={cx("inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:active:scale-100", v[variant], className)}
      {...p}
    />
  );
}

// shadcn/ui-style button classes, for links that should look like buttons (landing page).
type BtnVariant = "default" | "outline" | "ghost";
type BtnSize = "sm" | "default" | "lg";
export function btn({ variant = "default", size = "default", className }: { variant?: BtnVariant; size?: BtnSize; className?: string } = {}) {
  const v: Record<BtnVariant, string> = {
    default: "bg-ink text-white shadow-sm hover:bg-ink/90",
    outline: "border border-line bg-white/80 text-ink shadow-sm backdrop-blur hover:bg-neutral-100",
    ghost: "text-neutral-600 hover:bg-neutral-100 hover:text-ink",
  };
  const s: Record<BtnSize, string> = { sm: "h-8 px-3 text-[13px]", default: "h-9 px-4 text-[14px]", lg: "h-10 px-6 text-[14px]" };
  // Pass a responsive display (e.g. "hidden sm:inline-flex") in className to override the default inline-flex.
  const display = className && /(^|\s)(hidden|flex|block)(\s|$)/.test(className) ? "" : "inline-flex";
  return cx(display, "items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2", v[variant], s[size], className);
}

export function Logo({ className }: { className?: string }) {
  return <img src="/logo.webp" alt="Khaapa" className={cx("w-auto shrink-0", className)} />;
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx("w-full min-h-9 rounded-md border border-line bg-white px-3 py-1.5 text-[13px] text-ink shadow-sm placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200", className)}
      {...p}
    />
  );
}

export function Select({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("w-full min-h-9 rounded-md border border-line bg-white px-3 py-1.5 text-[13px] shadow-sm focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-200", className)} {...p} />;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-neutral-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-lg border border-line bg-white", className)}>{children}</div>;
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "good" | "warn" | "bad" | "accent"; children: ReactNode }) {
  const t = {
    neutral: "bg-neutral-100 text-neutral-700",
    good: "bg-emerald-50 text-emerald-700",
    warn: "bg-amber-50 text-amber-800",
    bad: "bg-red-50 text-red-700",
    accent: "bg-accent-soft text-accent",
  }[tone];
  return <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium", t)}>{children}</span>;
}

// A bottom sheet on phones, a centred dialog from sm up; `center` keeps it a small centred dialog on phones too.
export function Modal({ open, onClose, title, children, wide, center }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean; center?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={cx("fixed inset-0 z-50 flex justify-center bg-ink/40", center ? "items-center p-4" : "items-end p-0 sm:items-center sm:p-4")} onClick={onClose}>
      <div className={cx("rise max-h-[92vh] w-full overflow-y-auto bg-white p-5 shadow-xl", center ? "max-w-sm rounded-xl" : cx("rounded-t-2xl sm:rounded-xl", wide ? "sm:max-w-2xl" : "sm:max-w-md"))} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[15px] font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-ink" aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500">{children}</div>;
}

export function Spinner() {
  return <div className="mx-auto my-12 h-6 w-6 animate-spin rounded-full border-2 border-neutral-300 border-t-ink" />;
}

// Pages through rows already in memory. Lists the server pages by cursor pass `more`/`onMore` to the Pager,
// which fetches the next batch once the last loaded page is reached.
export function usePaged<T>(rows: T[], size = 25, resetKey?: unknown) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(page, pages);
  return { shown: rows.slice((p - 1) * size, p * size), pager: { page: p, pages, size, total: rows.length, setPage } };
}

export function Pager({ page, pages, size, total, setPage, more, onMore, className }: { page: number; pages: number; size: number; total: number; setPage: (p: number) => void; more?: boolean; onMore?: () => Promise<unknown>; className?: string }) {
  const [busy, setBusy] = useState(false);
  if (pages <= 1 && !more) return null;
  const last = page >= pages;
  const next = async () => {
    if (last) {
      if (!onMore) return;
      setBusy(true);
      try { await onMore(); } finally { setBusy(false); }
    }
    setPage(page + 1);
  };
  return (
    <div className={cx("flex items-center justify-between gap-3 px-3 py-2 text-xs text-neutral-500 sm:px-4", className)}>
      <span className="tabular">{(page - 1) * size + 1}–{Math.min(page * size, total)} of {total}{more ? "+" : ""}</span>
      <div className="flex gap-2">
        <Button onClick={() => setPage(page - 1)} disabled={page <= 1} className="min-h-8 px-2.5">Previous</Button>
        <Button onClick={next} disabled={busy || (last && !more)} className="min-h-8 px-2.5">{busy ? "Loading…" : "Next"}</Button>
      </div>
    </div>
  );
}

// Tiny toast
let push: ((m: string, bad?: boolean) => void) | null = null;
export const toast = (m: string, bad = false) => push?.(m, bad);
export function Toaster() {
  const [items, setItems] = useState<{ id: number; m: string; bad: boolean }[]>([]);
  useEffect(() => {
    push = (m, bad = false) => {
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, m, bad }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 2600);
    };
    return () => { push = null; };
  }, []);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
      {items.map((t) => (
        <div key={t.id} className={cx("rise rounded-md px-3.5 py-2 text-[13px] font-medium shadow-lg", t.bad ? "bg-red-600 text-white" : "bg-ink text-white")}>{t.m}</div>
      ))}
    </div>
  );
}

export function ItemImage({ src, name, className }: { src: string | null; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} className={cx("object-cover", className)} />;
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0);
  return (
    <div className={cx("flex items-center justify-center text-2xl font-semibold", className)} style={{ background: `hsl(${hue} 45% 92%)`, color: `hsl(${hue} 40% 35%)` }}>
      {name.trim()[0]?.toUpperCase()}
    </div>
  );
}
