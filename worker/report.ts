// Daily attendance report: every slot of the day (attended or missed) and every shift started outside the person's
// own slot, as a CSV that opens in Excel. The minute cron stores it once it's past REPORT_AT Pakistan time.

import { REPORT_AT } from "../shared/types";

export { REPORT_AT };
const PK = 5 * 3600_000;
const DAY = 86400_000;
const MAX_SHIFT = 12 * 3600_000; // a shift left open longer counts as forgotten, same as the Attendance page

type SlotRow = { user_id: number; user_name: string; starts_at: string; ends_at: string; note: string | null };
type ShiftRow = { id: number; user_id: number; user_name: string; started_at: string; ended_at: string | null };
type Line = { name: string; slot: string; start: string; end: string; status: string; flag: string; at: number };
export type Report = { csv: string; slots: number; missed: number; off_slot: number };

export const pkToday = (now = Date.now()) => new Date(now + PK).toISOString().slice(0, 10);
export const pkClock = (now = Date.now()) => new Date(now + PK).toISOString().slice(11, 16);
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+05:00`);

function clock(ms: number) {
  const d = new Date(ms + PK);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function buildReport(db: D1Database, day: string, now = Date.now()): Promise<Report> {
  const from = dayStart(day);
  const to = from + DAY;
  const [slots, shifts] = await db.batch([
    db.prepare("SELECT s.user_id, u.name AS user_name, s.starts_at, s.ends_at, s.note FROM slots s JOIN users u ON u.id = s.user_id WHERE s.starts_at >= ? AND s.starts_at < ? ORDER BY s.starts_at")
      .bind(new Date(from).toISOString(), new Date(to).toISOString()),
    db.prepare("SELECT s.id, s.user_id, u.name AS user_name, s.started_at, s.ended_at FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.started_at >= ? AND s.started_at < ? ORDER BY s.started_at")
      .bind(new Date(from).toISOString(), new Date(to).toISOString()),
  ]);
  const slotRows = slots.results as SlotRow[];
  const spans = (shifts.results as ShiftRow[]).map((s) => {
    const start = Date.parse(s.started_at);
    const end = Math.min(s.ended_at ? Date.parse(s.ended_at) : now, start + MAX_SHIFT);
    return { s, start, end };
  });

  const lines: Line[] = [];
  let missed = 0;
  for (const sl of slotRows) {
    const a = Date.parse(sl.starts_at);
    const b = Date.parse(sl.ends_at);
    const slot = `${clock(a)} - ${clock(b)}`;
    const hit = spans.filter((x) => x.s.user_id === sl.user_id && x.start < b && x.end > a);
    if (hit.length) {
      const first = hit[0];
      const late = first.start - a > 10 * 60_000;
      lines.push({ name: sl.user_name, slot, start: clock(first.start), end: first.s.ended_at ? clock(first.end) : "still on", status: late ? "Attended (late)" : "Attended", flag: late ? `LATE ${Math.round((first.start - a) / 60_000)} min` : "", at: a });
      continue;
    }
    if (a > now) {
      lines.push({ name: sl.user_name, slot, start: "", end: "", status: "Not started yet", flag: "", at: a });
      continue;
    }
    missed++;
    lines.push({ name: sl.user_name, slot, start: "", end: "", status: "Missed", flag: "MISSED SLOT", at: a });
  }

  // Shifts that don't touch any of the person's own slots that day: they came at a time that isn't theirs.
  let offSlot = 0;
  for (const x of spans) {
    const own = slotRows.filter((sl) => sl.user_id === x.s.user_id);
    const inSlot = own.some((sl) => x.start < Date.parse(sl.ends_at) && x.end > Date.parse(sl.starts_at));
    if (inSlot) continue;
    offSlot++;
    const theirs = own.map((sl) => `${clock(Date.parse(sl.starts_at))} - ${clock(Date.parse(sl.ends_at))}`).join("; ");
    lines.push({
      name: x.s.user_name, slot: theirs || "(no slot today)", start: clock(x.start), end: x.s.ended_at ? clock(x.end) : "still on",
      status: "Shift outside own slot", flag: theirs ? "NOT THEIR SLOT" : "NO SLOT TODAY", at: x.start,
    });
  }

  lines.sort((p, q) => p.name.localeCompare(q.name) || p.at - q.at);
  const head = ["Date", "Name", "Slot", "Shift start", "Shift end", "Status", "Flag"];
  const rows = lines.map((l) => [day, l.name, l.slot, l.start, l.end, l.status, l.flag]);
  const summary = [[], ["Summary"], ["Slots", slotRows.length], ["Missed", missed], ["Shifts outside own slot", offSlot], ["Made at", `${pkToday(now)} ${clock(now)} (Pakistan time)`]];
  // The BOM makes Excel read it as UTF-8.
  const csv = "﻿" + [head, ...rows, ...summary].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return { csv, slots: slotRows.length, missed, off_slot: offSlot };
}

// Minute cron: once it's past REPORT_AT, store today's report if it isn't there yet.
export async function storeDailyReport(db: D1Database, now = Date.now()) {
  if (pkClock(now) < REPORT_AT) return;
  const day = pkToday(now);
  if (await db.prepare("SELECT 1 FROM attendance_reports WHERE day = ?").bind(day).first()) return;
  const r = await buildReport(db, day, now);
  await db.prepare("INSERT OR IGNORE INTO attendance_reports (day, csv, slots, missed, off_slot) VALUES (?,?,?,?,?)").bind(day, r.csv, r.slots, r.missed, r.off_slot).run();
}
