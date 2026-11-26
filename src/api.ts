export class ApiError extends Error {
  status: number;
  data: any;
  constructor(msg: string, status: number, data?: any) {
    super(msg);
    this.status = status;
    this.data = data;
  }
}

// Double taps: while a change is on its way, the exact same change (same method, address and contents) isn't sent
// again; the second tap just waits for the first one's answer. The server has its own check too (worker: dedupe).
const inFlight = new Map<string, Promise<unknown>>();
const bodyKey = (b: BodyInit | null | undefined) =>
  b instanceof FormData ? JSON.stringify([...b.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `${v.name}:${v.size}`])) : typeof b === "string" ? b : "";

export function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const opts: RequestInit = { credentials: "same-origin", ...init };
  if (init?.json !== undefined) {
    opts.body = JSON.stringify(init.json);
    opts.headers = { "Content-Type": "application/json", ...(init.headers ?? {}) };
    opts.method = opts.method ?? "POST";
  }
  const method = (opts.method ?? "GET").toUpperCase();
  if (method === "GET") return send<T>(path, opts);
  const key = `${method} ${path} ${bodyKey(opts.body)}`;
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;
  const p = send<T>(path, opts).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function send<T>(path: string, opts: RequestInit): Promise<T> {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).error ?? res.statusText, res.status, data);
  return data as T;
}

// Rupees, with paisa only when there are any (Rs 60, Rs 4.17).
export const rs = (n: number | null | undefined) => `Rs ${Number(n ?? 0).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;

// Keeps a price field to digits and one decimal point, at most 2 decimals.
export const priceInput = (v: string) => {
  const [whole, ...rest] = v.replace(/[^\d.]/g, "").split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

export const imgUrl = (key: string | null | undefined) => (key ? `/api/img/${key}` : null);

export function timeAgo(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString("en-PK", { day: "numeric", month: "short" });
}

export function fmtTime(iso: string): string {
  const d = new Date(iso.endsWith("Z") ? iso : iso + "Z");
  return d.toLocaleString("en-PK", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

// wa.me wants the number in international form without "+" (03xx… → 923xx…).
export function waLink(number: string, text: string): string | null {
  let n = number.replace(/\D/g, "");
  if (n.startsWith("0")) n = "92" + n.slice(1);
  if (n.length < 11) return null;
  return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
}

export const fmtDay = (ymd: string) => new Date(ymd + "T00:00:00Z").toLocaleDateString("en-PK", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
