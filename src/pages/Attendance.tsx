import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDay, fmtTime, rs } from "../api";
import { Badge, Button, Card, Input, Spinner, cx, toast } from "../components/ui";
import { REPORT_AT, type Attendance as A } from "../../shared/types";

// Attendance = shift start/end. A shift left open longer than this is treated as a forgotten "end shift".
const MAX_SHIFT_H = 12;
const RANGES = [7, 14, 30] as const;

const ms = (iso: string) => Date.parse(/Z|[+-]\d\d:\d\d$/.test(iso) ? iso : iso.replace(" ", "T") + "Z");
const pkDay = (iso: string) => new Date(ms(iso) + 5 * 3600_000).toISOString().slice(0, 10);
const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)}m` : `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`.replace(/ 0m$/, ""));

function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(from + "T00:00:00Z"); t <= Date.parse(to + "T00:00:00Z"); t += 86400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

type Person = {
  id: number; name: string; shifts: number; hours: number; days: Set<string>; byDay: Map<string, number>;
  sales: number; last: string | null; assigned: number; attended: number; missed: number; missedDays: Set<string>; open: boolean;
};

function build(raw: A) {
  // Skip any row with an unreadable time rather than breaking the whole page.
  const ok = (...t: (string | null)[]) => t.every((x) => x === null || !Number.isNaN(ms(x)));
  const d = { ...raw, shifts: raw.shifts.filter((s) => ok(s.started_at, s.ended_at)), slots: raw.slots.filter((s) => ok(s.starts_at, s.ends_at)) };
  const now = ms(d.now);
  const days = daysBetween(d.from, d.today);
  const people = new Map<number, Person>();
  const get = (id: number, name: string) => {
    let p = people.get(id);
    if (!p) people.set(id, (p = { id, name, shifts: 0, hours: 0, days: new Set(), byDay: new Map(), sales: 0, last: null, assigned: 0, attended: 0, missed: 0, missedDays: new Set(), open: false }));
    return p;
  };
  const forgotten: A["shifts"] = [];
  const spans = d.shifts.map((s) => {
    const start = ms(s.started_at);
    const rawEnd = s.ended_at ? ms(s.ended_at) : now;
    const end = Math.min(rawEnd, start + MAX_SHIFT_H * 3600_000);
    if (rawEnd - start > MAX_SHIFT_H * 3600_000) forgotten.push(s);
    return { s, start, end, h: Math.max(0, end - start) / 3600_000 };
  });
  for (const { s, h } of spans) {
    const day = pkDay(s.started_at);
    if (day < d.from) continue;
    const p = get(s.user_id, s.user_name);
    p.shifts++; p.hours += h; p.days.add(day); p.byDay.set(day, (p.byDay.get(day) ?? 0) + h); p.sales += s.sales_total;
    if (!p.last || s.started_at > p.last) p.last = s.started_at;
    if (!s.ended_at) p.open = true;
  }
  // A slot counts as attended if the person had a shift overlapping it at all.
  for (const sl of d.slots) {
    if (pkDay(sl.starts_at) < d.from) continue;
    const a = ms(sl.starts_at), b = ms(sl.ends_at);
    const p = get(sl.user_id, sl.user_name);
    p.assigned++;
    const hit = spans.some((x) => x.s.user_id === sl.user_id && x.start < b && x.end > a);
    if (hit) p.attended++;
    else if (b < now) { p.missed++; p.missedDays.add(pkDay(sl.starts_at)); }
  }
  const perDay = days.map((day) => {
    let hours = 0; const who = new Set<string>();
    for (const p of people.values()) { const h = p.byDay.get(day) ?? 0; if (h > 0) { hours += h; who.add(p.name); } }
    return { day, hours, who: [...who] };
  });
  const list = [...people.values()].filter((p) => p.shifts > 0 || p.assigned > 0).sort((x, y) => y.hours - x.hours || x.name.localeCompare(y.name));
  const onNow = d.shifts.filter((s) => !s.ended_at && now - ms(s.started_at) <= MAX_SHIFT_H * 3600_000);
  return { days, perDay, list, onNow, forgotten };
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="tabular mt-1 text-xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-neutral-500">{sub}</div>}
    </Card>
  );
}

function DayBars({ perDay, today }: { perDay: { day: string; hours: number; who: string[] }[]; today: string }) {
  const max = Math.max(1, ...perDay.map((d) => d.hours));
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold">Hours on the counter per day</h2>
        <span className="text-xs text-neutral-400">hover a bar for who was there</span>
      </div>
      <div className="flex h-36 items-end gap-1">
        {perDay.map((d) => (
          <div key={d.day} title={`${fmtDay(d.day)}: ${hrs(d.hours)}${d.who.length ? ` · ${d.who.join(", ")}` : " · nobody"}`} className="group flex h-full flex-1 flex-col items-center justify-end">
            {d.hours > 0 && <span className="tabular mb-1 text-[10px] text-neutral-500">{d.who.length}</span>}
            <div className={cx("w-full rounded-t-[4px] transition group-hover:opacity-80", d.hours ? "bg-accent" : "bg-neutral-200", d.day === today && "ring-2 ring-accent/30")} style={{ height: `${Math.max(d.hours ? 4 : 2, (d.hours / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-neutral-400">
        <span>{fmtDay(perDay[0].day)}</span><span>number above a bar = people who showed up</span><span>{fmtDay(perDay[perDay.length - 1].day)}</span>
      </div>
    </Card>
  );
}

// Person × day grid: darker = more hours. A red outline marks a day with a missed slot.
function Grid({ list, days, today }: { list: Person[]; days: string[]; today: string }) {
  const max = Math.max(1, ...list.flatMap((p) => [...p.byDay.values()]));
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[13px] font-semibold">Who was there</h2>
        <span className="flex items-center gap-3 text-xs text-neutral-400">
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-accent/20" />short</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm bg-accent" />long</span>
          <span className="flex items-center gap-1"><span className="h-3 w-3 rounded-sm ring-2 ring-inset ring-red-400" />missed a slot</span>
        </span>
      </div>
      {list.length === 0 ? <p className="p-8 text-center text-sm text-neutral-400">No shifts in this period.</p> : (
        <div className="overflow-x-auto p-4">
          <table className="border-separate border-spacing-[3px] text-xs">
            <thead>
              <tr>
                <th />
                {days.map((d) => (
                  <th key={d} className={cx("w-7 min-w-7 text-center font-normal", d === today ? "text-accent" : "text-neutral-400")}>
                    <div>{new Date(d + "T00:00:00Z").toLocaleDateString("en-PK", { weekday: "narrow", timeZone: "UTC" })}</div>
                    <div className="tabular">{d.slice(8)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap pr-3 text-[13px] font-medium">{p.name}</td>
                  {days.map((d) => {
                    const h = p.byDay.get(d) ?? 0;
                    const missed = p.missedDays.has(d);
                    return (
                      <td key={d} title={`${p.name}, ${fmtDay(d)}: ${h ? hrs(h) : "not in"}${missed ? " · missed a slot" : ""}`}
                        className={cx("h-7 w-7 rounded-[4px]", !h && "bg-neutral-100", missed && "ring-2 ring-inset ring-red-400")}
                        style={h ? { background: `rgb(92 47 128 / ${0.2 + 0.8 * (h / max)})` } : undefined} />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type Report = { day: string; slots: number; missed: number; off_slot: number; created_at: string };
type Reports = { reports: Report[]; report_at: string; today: string };

const reportUrl = (day: string) => `/api/attendance/reports/${day}.csv`;
const pkToday = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
const atLabel = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

// Fetches the CSV first so a server error shows as a message instead of a broken file.
async function downloadReport(day: string) {
  const res = await fetch(reportUrl(day), { credentials: "same-origin" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast(`Couldn't make the ${day} report: ${(body as any).error ?? res.statusText}`, true);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `khaapa-attendance-${day}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Download({ day }: { day: string }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    await downloadReport(day).catch((e) => toast(e.message, true));
    setBusy(false);
  };
  return <Button onClick={go} disabled={busy || !day} className="min-h-8 shrink-0 px-2.5 text-[12px]">{busy ? "Preparing..." : "Download CSV"}</Button>;
}

// Saved days with their counts; tapping one picks it for the single Download button above.
function ReportList({ d, error, pick, onPick }: { d: Reports | null; error: string; pick: string; onPick: (day: string) => void }) {
  if (error) {
    return <p className="px-4 py-3 text-[12px] text-red-600">Couldn't load saved reports: {error}. You can still download any day above.</p>;
  }
  if (!d) {
    return <p className="px-4 py-3 text-[12px] text-neutral-400">Loading saved reports...</p>;
  }
  if (d.reports.length === 0) {
    return <p className="px-4 py-3 text-[12px] text-neutral-400">No saved reports yet. The first one is saved today at {atLabel(d.report_at)}.</p>;
  }
  return (
    <ul className="max-h-80 divide-y divide-line overflow-y-auto text-[13px]">
      {d.reports.map((r) => (
        <li key={r.day}>
          <button onClick={() => onPick(r.day)} className={cx("flex w-full flex-wrap items-center gap-1.5 px-4 py-2 text-left hover:bg-neutral-50", r.day === pick && "bg-accent-soft")}>
            {fmtDay(r.day)}
            <span className="text-[12px] text-neutral-500">{r.slots} slot{r.slots === 1 ? "" : "s"}</span>
            {r.missed ? <Badge tone="bad">{r.missed} missed</Badge> : null}
            {r.off_slot ? <Badge tone="warn">{r.off_slot} off-slot</Badge> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

// One CSV per day (opens in Excel): every slot, attended or missed, and shifts started outside the person's own slot.
// Always shown: picking a day and downloading works even if the saved list fails to load.
function DailyReports() {
  const [d, setD] = useState<Reports | null>(null);
  const [error, setError] = useState("");
  const [pick, setPick] = useState(pkToday());
  useEffect(() => {
    api<Reports>("/api/attendance/reports").then(setD).catch((e) => setError(e.message));
  }, []);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">Daily attendance reports (CSV)</h2>
          <p className="text-[12px] text-neutral-500">Saved every day at {atLabel(REPORT_AT)} Pakistan time. Flags missed slots, late starts and shifts outside the person's own slot.</p>
        </div>
        <div className="flex items-center gap-2">
          <Input type="date" value={pick} max={pkToday()} onChange={(e) => setPick(e.target.value)} className="h-8 w-auto text-[12px]" />
          <Download day={pick} />
        </div>
      </div>
      <ReportList d={d} error={error} pick={pick} onPick={setPick} />
    </Card>
  );
}

export default function Attendance() {
  const [range, setRange] = useState<(typeof RANGES)[number]>(14);
  const [d, setD] = useState<A | null>(null);
  useEffect(() => {
    setD(null);
    const load = () => api<A>(`/api/attendance?days=${range}`).then(setD).catch((e) => toast(e.message, true));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [range]);
  const v = useMemo(() => (d ? build(d) : null), [d]);
  const endShift = async (id: number, name: string) => {
    if (!confirm(`End ${name}'s shift now?`)) return;
    try { await api("/api/shifts/end", { json: { shift_id: id } }); toast("Shift ended"); setRange((r) => r); setD(await api<A>(`/api/attendance?days=${range}`)); } catch (e: any) { toast(e.message, true); }
  };

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Attendance</h1>
          <p className="text-sm text-neutral-500">From shift start and end, checked against the slots on the <Link to="/schedule" className="underline decoration-neutral-300">Schedule</Link>. A slot counts as attended if the person was on shift at any point during it.</p>
        </div>
        <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5 text-[12px] font-medium">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)} className={cx("rounded px-2.5 py-1", range === r ? "bg-white shadow-sm" : "text-neutral-500")}>{r} days</button>
          ))}
        </div>
      </div>

      <DailyReports />

      {!d || !v ? <Spinner /> : (() => {
        const totalH = v.list.reduce((s, p) => s + p.hours, 0);
        const assigned = v.list.reduce((s, p) => s + p.assigned, 0);
        const attended = v.list.reduce((s, p) => s + p.attended, 0);
        const missed = v.list.reduce((s, p) => s + p.missed, 0);
        const showed = v.list.filter((p) => p.shifts > 0).length;
        return (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="On shift now" value={`${v.onNow.length}`} sub={v.onNow.length ? v.onNow.map((s) => s.user_name).join(", ") : "Nobody on the counter"} />
              <Tile label="Hours covered" value={hrs(totalH)} sub={`${d.shifts.filter((s) => pkDay(s.started_at) >= d.from).length} shifts in ${range} days`} />
              <Tile label="People who came" value={`${showed}`} sub={`of ${d.users.length} active accounts`} />
              <Tile label="Slots attended" value={assigned ? `${Math.round((attended / assigned) * 100)}%` : "–"} sub={assigned ? `${attended} of ${assigned} · ${missed} missed` : "No slots assigned yet"} />
            </div>

            {v.forgotten.filter((s) => !s.ended_at).map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
                <span>{s.user_name} started a shift {fmtTime(s.started_at)} and never ended it. Counted as {MAX_SHIFT_H}h.</span>
                <Button onClick={() => endShift(s.id, s.user_name)} className="min-h-8 shrink-0 px-2.5">End it now</Button>
              </div>
            ))}

            <DayBars perDay={v.perDay} today={d.today} />
            <Grid list={v.list} days={v.days} today={d.today} />

            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-neutral-500">
                    <th className="px-4 py-2 font-medium">Person</th>
                    <th className="px-2 py-2 text-right font-medium">Days in</th>
                    <th className="px-2 py-2 text-right font-medium">Shifts</th>
                    <th className="px-2 py-2 text-right font-medium">Hours</th>
                    <th className="px-2 py-2 text-right font-medium">Avg shift</th>
                    <th className="px-2 py-2 text-right font-medium">Slots</th>
                    <th className="px-2 py-2 text-right font-medium">Sold</th>
                    <th className="px-4 py-2 text-right font-medium">Last in</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {v.list.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-2 font-medium">{p.name} {p.open && <Badge tone="good">On shift</Badge>}</td>
                      <td className="tabular px-2 py-2 text-right">{p.days.size}</td>
                      <td className="tabular px-2 py-2 text-right">{p.shifts}</td>
                      <td className="tabular px-2 py-2 text-right font-medium">{p.hours ? hrs(p.hours) : "–"}</td>
                      <td className="tabular px-2 py-2 text-right text-neutral-600">{p.shifts ? hrs(p.hours / p.shifts) : "–"}</td>
                      <td className="tabular px-2 py-2 text-right">
                        {p.assigned ? <span className={cx(p.missed ? "text-red-600" : "text-emerald-700")}>{p.attended}/{p.assigned}</span> : <span className="text-neutral-400">–</span>}
                      </td>
                      <td className="tabular px-2 py-2 text-right text-neutral-600">{p.sales ? rs(p.sales) : "–"}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-right text-xs text-neutral-500">{p.last ? fmtTime(p.last) : "–"}</td>
                    </tr>
                  ))}
                  {v.list.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-sm text-neutral-400">Nobody has started a shift in this period.</td></tr>}
                </tbody>
              </table>
            </Card>
          </>
        );
      })()}
    </div>
  );
}
