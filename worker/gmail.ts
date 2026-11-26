// Gmail connection for the payment inbox: token encryption, sync, and email parsing.
import type { Env } from "./index";

const b64e = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const b64d = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.TOKEN_KEY));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(env: Env, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(text));
  return `${b64e(iv)}.${b64e(new Uint8Array(ct))}`;
}
export async function decrypt(env: Env, enc: string): Promise<string> {
  const [iv, ct] = enc.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64d(iv) as BufferSource }, await key(env), b64d(ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

async function accessToken(env: Env, refresh: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const j = await r.json<{ access_token?: string; error?: string; error_description?: string }>();
  if (!r.ok || !j.access_token) throw new Error(`Google token refresh failed: ${j.error_description ?? j.error ?? r.status}`);
  return j.access_token;
}

function b64url(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function bodyText(payload: any): string {
  let plain = "", html = "";
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data) {
      if (p.mimeType === "text/plain") plain += b64url(p.body.data) + "\n";
      else if (p.mimeType === "text/html") html += b64url(p.body.data) + "\n";
    }
    (p.parts ?? []).forEach(walk);
  };
  walk(payload);
  if (plain.trim()) return plain;
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
}

export interface Parsed { amount: number | null; sender_name: string | null; reference: string | null; incoming: boolean }

// Tolerant parser for wallet notifications: NayaPay emails and SadaPay-style notifications (subject = notification
// title). The raw text is stored too, so this can be tightened once real samples are in and old rows re-parsed.
export function parsePayment(subject: string, text: string): Parsed {
  const all = `${subject}\n${text}`;
  const amt = all.match(/(?:Rs\.?|PKR)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = amt ? Math.round(parseFloat(amt[1].replace(/,/g, ""))) : null;
  // Must talk about money arriving, and must not be an OTP / verification / security mail.
  const notPayment = /\b(OTP|one[- ]time|PIN|verification|verify|password|login|sign[- ]?in|security)\b/i.test(subject);
  const incoming =
    amount !== null && !notPayment &&
    // NayaPay: subject "You got Rs. 490 from Ali Khan", body "Amount Received" / "Incoming Fund Transfer".
    // SadaPay: push notification such as "Ali Khan sent you Rs. 500" or "You've received Rs. 500 from Ali Khan".
    /\b(you(?:'ve| have)? (?:received|got)|received\s+(?:Rs|PKR)|received from|added to your (?:account|wallet)|credited|sent you|has sent|deposited|incoming (?:payment|(?:fund )?transfer)|money received|payment received|amount received)\b/i.test(all) &&
    !/\byou(?:'ve| have)? (?:sent|paid|transferred)\b/i.test(subject);
  const from =
    all.match(/(?:received|credited)[^\n]{0,60}?\bfrom\s+([A-Z][\w .'-]{1,60}?)(?=\s*(?:\n|\.|,| on | via | to | at |$))/i) ??
    all.match(/([A-Z][\w .'-]{1,60}?)\s+(?:has\s+)?sent you/i) ??
    all.match(/(?:Sender Name|Source Account Name|Sender|From)\s*[:\-]?\s*\n?\s*([A-Z][\w .'-]{1,60})/i);
  const ref = all.match(/(?:Transaction ID|Reference(?: No\.?| Number)?|Ref(?:erence)? ?#?|TID|RRN)\s*[:#\-]?\s*\n?\s*([A-Z0-9-]{6,40})/i);
  return { amount, sender_name: from ? from[1].trim() : null, reference: ref ? ref[1] : null, incoming };
}

export async function syncPayments(env: Env): Promise<{ added: number; checked: number }> {
  const conn = await env.DB.prepare("SELECT * FROM mail_connections ORDER BY id DESC LIMIT 1").first<{ id: number; refresh_token_enc: string; last_sync_at: string | null }>();
  if (!conn) return { added: 0, checked: 0 };
  try {
    const token = await accessToken(env, await decrypt(env, conn.refresh_token_enc));
    const auth = { Authorization: `Bearer ${token}` };
    // Look back a little past the last sync so nothing is missed; first sync covers 30 days.
    const since = conn.last_sync_at ? Math.floor(new Date(conn.last_sync_at).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - 30 * 86400;
    const q = `${env.PAYMENT_EMAIL_QUERY} after:${since}`;
    const ids: string[] = [];
    let page: string | undefined;
    for (let i = 0; i < 5; i++) {
      const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=${encodeURIComponent(q)}${page ? `&pageToken=${page}` : ""}`, { headers: auth });
      if (!list.ok) throw new Error(`Gmail list failed: ${list.status} ${(await list.text()).slice(0, 200)}`);
      const j = await list.json<{ messages?: { id: string }[]; nextPageToken?: string }>();
      ids.push(...(j.messages ?? []).map((m) => m.id));
      if (!(page = j.nextPageToken)) break;
    }
    let added = 0;
    // D1 allows at most 100 bound values per query, so check known ids in chunks.
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      const known = await env.DB.prepare(`SELECT gmail_id FROM payments WHERE gmail_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all<{ gmail_id: string }>();
      known.results.forEach((r) => have.add(r.gmail_id));
    }
    // Each email is one subrequest; Workers cap those per run. Take the oldest batch now and leave the window open
    // (last_sync_at unchanged) so the next minute's run picks up the rest.
    const todo = ids.filter((i) => !have.has(i)).reverse();
    const batch = todo.slice(0, 35);
    {
      for (const id of batch) {
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: auth });
        if (!res.ok) continue;
        const msg = await res.json<any>();
        const hdr = (n: string) => msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === n)?.value ?? "";
        const subject = hdr("subject");
        const text = bodyText(msg.payload).slice(0, 6000);
        const p = parsePayment(subject, text);
        if (!p.incoming) continue; // outgoing transfers, OTPs, marketing etc. are not stored
        const received = new Date(Number(msg.internalDate)).toISOString();
        const ins = await env.DB.prepare(
          "INSERT OR IGNORE INTO payments (gmail_id, received_at, amount, sender_name, reference, subject, snippet, raw_text) VALUES (?,?,?,?,?,?,?,?)",
        ).bind(id, received, p.amount, p.sender_name, p.reference, subject, msg.snippet ?? null, text).run();
        if (ins.meta.changes) added++;
      }
    }
    if (todo.length > batch.length) await env.DB.prepare("UPDATE mail_connections SET last_error = NULL WHERE id = ?").bind(conn.id).run();
    else await env.DB.prepare("UPDATE mail_connections SET last_sync_at = ?, last_error = NULL WHERE id = ?").bind(new Date().toISOString(), conn.id).run();
    return { added, checked: ids.length };
  } catch (e: any) {
    await env.DB.prepare("UPDATE mail_connections SET last_error = ? WHERE id = ?").bind(String(e.message ?? e).slice(0, 500), conn.id).run();
    throw e;
  }
}
