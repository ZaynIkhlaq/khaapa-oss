// Session token helper.

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const SESSION_COOKIE = "khaapa_session";
export const SESSION_HOURS = 24;
