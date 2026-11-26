import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Card, Field, Input, Modal, Spinner, cx, toast } from "../components/ui";
import WeeklyPicks from "../components/WeeklyPicks";
import { SwapModal } from "../components/SwapModal";
import { hasScope, SLOTS_CHANGED, PICK_TIMES, PICKS_MIN, pickEndFor, type Slot, type SlotPick, type User } from "../../shared/types";

type NextSlot = Pick<Slot, "id" | "starts_at" | "ends_at" | "note">;
type Data = { slots: Slot[]; next: NextSlot | null };
type Form = { date: string; start: string; end: string; note: string; people: number[] };
type Placed = { s: Slot; top: number; bottom: number; col: number; cols: number };

const DAY = 86400_000;
const PK = 5 * 3600_000;
const HOUR_PX = 40;
const pkDate = (ms: number) => new Date(ms + PK).toISOString().slice(0, 10);
const toUtc = (date: string, time: string) => new Date(`${date}T${time}:00+05:00`).toISOString();
const dayStart = (date: string) => Date.parse(`${date}T00:00:00+05:00`);
const timeFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short" });
const monthFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "UTC", month: "long", year: "numeric" });
const time = (iso: string) => timeFmt.format(new Date(iso));
const range = (s: { starts_at: string; ends_at: string }) => `${time(s.starts_at)} - ${time(s.ends_at)}`;
const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 || h === 24 ? "am" : "pm"}`;
const pad = (n: number) => String(n).padStart(2, "0");

function mondayOf(date: string) {
  const d = new Date(date + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}

function addDays(date: string, n: number) {
  return new Date(Date.parse(date + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}

function addMonths(month: string, n: number) {
  const d = new Date(month + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}

const monthOf = (date: string) => date.slice(0, 8) + "01";

// Weeks (Monday first) covering the month.
function monthGrid(month: string) {
  const start = mondayOf(month);
  const last = addDays(addMonths(month, 1), -1);
  const end = addDays(mondayOf(last), 7);
  const days: string[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) {
    days.push(d);
  }
  return days;
}

// Minutes since local midnight of `date`, clipped to the day.
function minutesIn(date: string, iso: string) {
  const m = (Date.parse(iso) - dayStart(date)) / 60000;
  return Math.min(1440, Math.max(0, m));
}

const overlapsDay = (s: Slot, date: string) => Date.parse(s.starts_at) < dayStart(date) + DAY && Date.parse(s.ends_at) > dayStart(date);

// Greedy column layout: overlapping slots sit side by side, each cluster split evenly.
function layout(slots: Slot[], date: string): Placed[] {
  const items = slots
    .map((s) => ({ s, top: minutesIn(date, s.starts_at), bottom: minutesIn(date, s.ends_at), col: 0, cols: 1 }))
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.s.user_name.localeCompare(b.s.user_name));
  let cluster: Placed[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    cluster.forEach((p) => (p.cols = colEnds.length));
    cluster = [];
    colEnds = [];
  };
  for (const p of items) {
    if (p.top >= clusterEnd) {
      close();
    }
    let col = colEnds.findIndex((end) => end <= p.top);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(p.bottom);
    } else {
      colEnds[col] = p.bottom;
    }
    p.col = col;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  close();
  return items;
}

function NextCard({ next }: { next: NextSlot | null }) {
  if (!next) {
    return null;
  }
  const day = dayFmt.format(new Date(pkDate(Date.parse(next.starts_at)) + "T00:00:00Z"));
  const note = next.note ? <div className="mt-0.5 text-xs text-emerald-800">{next.note}</div> : null;
  return (
    <Card className="border-emerald-200 bg-emerald-50 px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-700">Your next slot</div>
      <div className="mt-0.5 text-[14px] font-semibold text-emerald-900">{day}, {range(next)}</div>
      {note}
    </Card>
  );
}

function MonthCalendar({ month, setMonth, day, today, counts, onPick }: { month: string; setMonth: (m: string) => void; day: string; today: string; counts: Map<string, number>; onPick: (d: string) => void }) {
  const cells = monthGrid(month);
  const inMonth = month.slice(0, 7);
  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <button onClick={() => setMonth(addMonths(month, -1))} className="grid size-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-ink" aria-label="Previous month">‹</button>
        <div className="text-[13px] font-semibold">{monthFmt.format(new Date(month + "T00:00:00Z"))}</div>
        <button onClick={() => setMonth(addMonths(month, 1))} className="grid size-7 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-ink" aria-label="Next month">›</button>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-neutral-400">
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <div key={d} className="py-1">{d}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d) => {
          const n = counts.get(d) ?? 0;
          const selected = d === day;
          const isToday = d === today;
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              title={n ? `${n} slot${n === 1 ? "" : "s"}` : undefined}
              className={cx(
                "tabular flex h-9 flex-col items-center justify-center rounded-md text-[12px] transition",
                d.slice(0, 7) !== inMonth && "text-neutral-300",
                selected ? "bg-accent text-white" : isToday ? "bg-accent-soft font-semibold text-accent" : "hover:bg-neutral-100",
              )}
            >
              <span className="leading-none">{Number(d.slice(8))}</span>
              <span className={cx("mt-1 h-1 rounded-full", n ? "w-1" : "w-0", n > 2 && "w-3", selected ? "bg-white" : "bg-accent/60")} />
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function DayTimeline({ date, today, slots, meId, canEdit, onOpen, onEmpty }: { date: string; today: string; slots: Slot[]; meId: number; canEdit: boolean; onOpen: (s: Slot) => void; onEmpty: (hour: number) => void }) {
  const now = useNow();
  const placed = layout(slots, date);
  let first = 8;
  let last = 20;
  for (const p of placed) {
    first = Math.min(first, Math.floor(p.top / 60));
    last = Math.max(last, Math.ceil(p.bottom / 60));
  }
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const y = (min: number) => ((min - first * 60) / 60) * HOUR_PX;
  const nowMin = (now - dayStart(date)) / 60000;
  const showNow = date === today && nowMin >= first * 60 && nowMin <= last * 60;
  return (
    <div className="relative flex select-none" style={{ height: hours.length * HOUR_PX + 8 }}>
      <div className="w-12 shrink-0">
        {[...hours, last].map((h) => (
          <div key={h} className="absolute -translate-y-1/2 pl-3 text-[11px] text-neutral-400 tabular" style={{ top: (h - first) * HOUR_PX + 4 }}>{hourLabel(h)}</div>
        ))}
      </div>
      <div className="relative mr-3 flex-1" style={{ marginTop: 4 }}>
        {hours.map((h) => (
          <div
            key={h}
            onClick={canEdit ? () => onEmpty(h) : undefined}
            className={cx("absolute inset-x-0 border-t border-line", canEdit && "cursor-pointer hover:bg-neutral-50")}
            style={{ top: (h - first) * HOUR_PX, height: HOUR_PX }}
          />
        ))}
        <div className="absolute inset-x-0 border-t border-line" style={{ top: hours.length * HOUR_PX }} />
        {placed.map((p) => {
          const mine = p.s.user_id === meId;
          const h = Math.max(y(p.bottom) - y(p.top), 18);
          const tall = h >= 34;
          return (
            <button
              key={p.s.id}
              onClick={() => onOpen(p.s)}
              title={`${p.s.user_name}, ${range(p.s)}${p.s.note ? ` · ${p.s.note}` : ""}`}
              className={cx(
                "absolute flex flex-col justify-start overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-left text-[12px] leading-tight transition hover:brightness-95",
                mine ? "border-emerald-500 bg-emerald-50 text-emerald-900" : "border-accent bg-accent-soft text-accent",
              )}
              style={{ top: y(p.top) + 1, height: h - 2, left: `calc(${(p.col / p.cols) * 100}% + 2px)`, width: `calc(${100 / p.cols}% - 4px)` }}
            >
              <div className="truncate font-medium">{p.s.user_name}{mine ? " (you)" : ""}</div>
              {tall ? <div className="truncate text-[11px] opacity-75">{range(p.s)}</div> : null}
            </button>
          );
        })}
        {showNow ? (
          <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: y(nowMin) }}>
            <span className="-ml-1 size-2 rounded-full bg-red-500" />
            <span className="h-px flex-1 bg-red-500" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SlotAction({ slot, canEdit, onDelete }: { slot: Slot; canEdit: boolean; onDelete: (s: Slot) => void }) {
  if (!canEdit) {
    return null;
  }
  return <Button variant="danger" className="w-full" onClick={() => onDelete(slot)}>Remove slot</Button>;
}

function SlotModal({ slot, meId, canEdit, onClose, onDelete, onSwap }: { slot: Slot | null; meId: number; canEdit: boolean; onClose: () => void; onDelete: (s: Slot) => void; onSwap: (s: Slot) => void }) {
  if (!slot) {
    return null;
  }
  const day = dayFmt.format(new Date(pkDate(Date.parse(slot.starts_at)) + "T00:00:00Z"));
  const isFutureActive = Date.parse(slot.ends_at) > Date.now();
  return (
    <Modal open onClose={onClose} title={slot.user_name}>
      <div className="space-y-3 text-[13px]">
        <div className="flex items-center gap-2">
          <span className="text-neutral-600">{day}, {range(slot)}</span>
          {slot.user_id === meId ? <Badge tone="good">You</Badge> : null}
        </div>
        {slot.note ? <p className="text-neutral-500">{slot.note}</p> : null}
        {isFutureActive && (
          <Button
            variant="primary"
            className="w-full"
            onClick={() => onSwap(slot)}
          >
            {slot.user_id === meId ? "Swap this slot" : `Request swap with ${slot.user_name.split(" ")[0]}`}
          </Button>
        )}
        <SlotAction slot={slot} canEdit={canEdit} onDelete={onDelete} />
      </div>
    </Modal>
  );
}

function PeoplePicker({ people, picked, onChange }: { people: User[]; picked: number[]; onChange: (ids: number[]) => void }) {
  const [q, setQ] = useState("");
  const shown = people.filter((u) => u.name.toLowerCase().includes(q.toLowerCase()));
  const flip = (id: number) => {
    if (picked.includes(id)) {
      onChange(picked.filter((x) => x !== id));
      return;
    }
    onChange([...picked, id]);
  };
  return (
    <Field label={`People (${picked.length} picked)`}>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" />
      <ul className="mt-2 max-h-48 divide-y divide-line overflow-y-auto rounded-md border border-line">
        {shown.map((u) => (
          <li key={u.id}>
            <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[13px]">
              <input type="checkbox" checked={picked.includes(u.id)} onChange={() => flip(u.id)} />
              {u.name}
            </label>
          </li>
        ))}
      </ul>
    </Field>
  );
}

function AddModal({ form, setForm, people, onSave }: { form: Form | null; setForm: (f: Form | null) => void; people: User[]; onSave: (e: React.FormEvent) => void }) {
  if (!form) {
    return null;
  }
  return (
    <Modal open onClose={() => setForm(null)} title="Assign a slot">
      <form onSubmit={onSave} className="space-y-3">
        <Field label="Day">
          <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">
            <Input
              type="time"
              value={form.start}
              onChange={(e) => {
                const start = e.target.value;
                const end = PICK_TIMES.includes(start) ? pickEndFor(start) : form.end;
                setForm({ ...form, start, end });
              }}
              required
            />
          </Field>
          <Field label="To"><Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} required /></Field>
        </div>
        <PeoplePicker people={people} picked={form.people} onChange={(people) => setForm({ ...form, people })} />
        <Field label="Note" hint="Optional, e.g. counter, restock run">
          <Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
        <Button type="submit" variant="primary" className="w-full">Assign</Button>
      </form>
    </Modal>
  );
}

const SYNC_MS = 15_000;

export default function Schedule() {
  const { user, refresh } = useAuth();
  const today = pkDate(Date.now());
  const [day, setDay] = useState(today);
  const [month, setMonth] = useState(monthOf(today));
  const [monthOpen, setMonthOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [people, setPeople] = useState<User[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState<Slot | null>(null);
  const [picks, setPicks] = useState<{ picks: SlotPick[]; open: boolean } | null>(null);
  const [target, setTarget] = useState(user?.id ?? 0);
  const [swapOpen, setSwapOpen] = useState(false);
  const [swapMySlotId, setSwapMySlotId] = useState<number | null>(null);
  const [swapTheirSlotId, setSwapTheirSlotId] = useState<number | null>(null);
  const [swapUserId, setSwapUserId] = useState<number | null>(null);
  const canEdit = hasScope(user, "hr");

  // Fetch the visible month grid, stretched to include the selected day if it sits outside it.
  const grid = monthGrid(month);
  const dayWeek = mondayOf(day);
  const fromDay = dayWeek < grid[0] ? dayWeek : grid[0];
  const toDay = addDays(dayWeek > grid[grid.length - 1] ? addDays(dayWeek, 6) : grid[grid.length - 1], 1);
  const load = () => {
    const from = toUtc(fromDay, "00:00");
    const to = toUtc(toDay, "00:00");
    return api<Data>(`/api/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(setData);
  };
  const loadPicks = () => api<{ picks: SlotPick[]; open: boolean }>(`/api/slot-picks?week=${dayWeek}`).then(setPicks);
  // Any change on this page reloads the calendar and the weekly grid together.
  const reloadAll = () => {
    loadPicks();
    load();
    refresh();
  };
  // Stay in step with changes made elsewhere (HR on another phone, someone picking their slots).
  useEffect(() => {
    load();
    loadPicks();
    const sync = () => {
      if (document.visibilityState === "visible") {
        load();
        loadPicks();
      }
    };
    const t = setInterval(sync, SYNC_MS);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener(SLOTS_CHANGED, sync);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener(SLOTS_CHANGED, sync);
    };
  }, [fromDay, toDay, dayWeek]);
  useEffect(() => {
    if (!canEdit) {
      return;
    }
    api("/api/users").then((d) => setPeople((d.users as User[]).filter((u) => u.approved && u.active)));
  }, [canEdit]);

  if (!user || !data || !picks) {
    return <Spinner />;
  }

  const pick = (d: string) => {
    setDay(d);
    setMonth(monthOf(d));
  };
  const counts = new Map<string, number>();
  for (const d of grid) {
    counts.set(d, data.slots.filter((s) => overlapsDay(s, d)).length);
  }
  const daySlots = data.slots.filter((s) => overlapsDay(s, day));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) {
      return;
    }
    try {
      const d = await api("/api/slots", { json: { user_ids: form.people, starts_at: toUtc(form.date, form.start), ends_at: toUtc(form.date, form.end), note: form.note } });
      toast(d.created === 1 ? "Slot assigned" : `${d.created} slots assigned`);
      setForm(null);
      reloadAll();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const remove = async (s: Slot) => {
    if (!confirm(`Remove ${s.user_name}'s slot (${range(s)})?`)) {
      return;
    }
    try {
      await api(`/api/slots/${s.id}`, { method: "DELETE" });
      toast("Removed");
      setOpen(null);
      reloadAll();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const assign = (start = PICK_TIMES[0], end = pickEndFor(PICK_TIMES[0])) => setForm({ date: day, start, end, note: "", people: [] });
  // A tap on an hour starts at that hour's weekly block when there is one.
  const assignAt = (h: number) => {
    const slotStart = PICK_TIMES.find((t) => Number(t.split(":")[0]) === h);
    if (slotStart) {
      assign(slotStart, pickEndFor(slotStart));
      return;
    }
    assign(`${pad(h)}:00`, `${pad(Math.min(h + 2, 23))}:${h + 2 > 23 ? "59" : "00"}`);
  };
  const triggerSwap = (s: Slot) => {
    setOpen(null);
    if (s.user_id === user.id) {
      setSwapMySlotId(s.id);
      setSwapTheirSlotId(null);
      setSwapUserId(null);
    } else {
      setSwapMySlotId(null);
      setSwapTheirSlotId(s.id);
      setSwapUserId(s.user_id);
    }
    setSwapOpen(true);
  };

  const openGeneralSwap = () => {
    setSwapMySlotId(null);
    setSwapTheirSlotId(null);
    setSwapUserId(null);
    setSwapOpen(true);
  };

  const addButton = canEdit ? <Button variant="primary" onClick={() => assign()}>Assign slot</Button> : null;
  const weekStart = dayWeek;
  // The grid shows the selected week's picks as the calendar has them: a pick counts only where its own slot is still
  // there, and anything else that week (one-offs, swapped slots) shows in amber.
  const pickOwner = new Map(picks.picks.map((p) => [p.id, p.user_id]));
  const weekSlots = data.slots.filter((s) => pkDate(Date.parse(s.starts_at)) >= weekStart && pkDate(Date.parse(s.starts_at)) < addDays(weekStart, 5));
  const ownPick = (s: Slot) => !!s.pick_id && pickOwner.get(s.pick_id) === s.user_id;
  const oneOffs = weekSlots.filter((s) => !ownPick(s));
  const present = new Set(weekSlots.filter(ownPick).map((s) => s.pick_id as number));
  const weekly = <WeeklyPicks meId={user.id} isHr={canEdit} open={picks.open} people={people} picks={picks.picks} target={target} onTarget={setTarget} onChange={reloadAll} weekStart={weekStart} oneOffs={oneOffs} present={present} />;
  const needsPicks = picks.open && weekStart >= mondayOf(today) && picks.picks.filter((p) => p.user_id === user.id).length < PICKS_MIN;
  const summary = daySlots.length === 0 ? "Nobody scheduled" : `${daySlots.length} slot${daySlots.length === 1 ? "" : "s"}`;

  return (
    <div className="space-y-4 p-4 md:px-6 md:py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Schedule</h1>
          <p className="text-sm text-neutral-500">Who's on, and when. Times are Pakistan time.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={openGeneralSwap}>Swap slot</Button>
          {addButton}
        </div>
      </div>
      {needsPicks && weekly}
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_272px]">
        <div className="space-y-3 md:col-start-2 md:row-start-1">
          <NextCard next={data.next} />
          <div className={cx(!monthOpen && "hidden", "md:block")}>
            <MonthCalendar month={month} setMonth={setMonth} day={day} today={today} counts={counts} onPick={pick} />
          </div>
        </div>
        <Card className="md:col-start-1 md:row-start-1">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                {dayFmt.format(new Date(day + "T00:00:00Z"))}
                {day === today ? <Badge tone="accent">Today</Badge> : null}
              </div>
              <div className="text-[12px] text-neutral-500">{summary}</div>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" className="px-2 md:hidden" onClick={() => setMonthOpen(!monthOpen)} aria-label="Show month">
                {monthOpen ? "Hide month" : "Month"}
              </Button>
              <Button className="px-2.5" onClick={() => pick(addDays(day, -1))} aria-label="Previous day">‹</Button>
              <Button onClick={() => pick(today)} disabled={day === today}>Today</Button>
              <Button className="px-2.5" onClick={() => pick(addDays(day, 1))} aria-label="Next day">›</Button>
            </div>
          </div>
          <div className="py-3">
            <DayTimeline date={day} today={today} slots={daySlots} meId={user.id} canEdit={canEdit} onOpen={setOpen} onEmpty={assignAt} />
          </div>
        </Card>
      </div>
      {!needsPicks && weekly}
      <SlotModal slot={open} meId={user.id} canEdit={canEdit} onClose={() => setOpen(null)} onDelete={remove} onSwap={triggerSwap} />
      <AddModal form={form} setForm={setForm} people={people} onSave={save} />
      <SwapModal
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        preselectedMySlotId={swapMySlotId}
        preselectedTheirSlotId={swapTheirSlotId}
        preselectedUserId={swapUserId}
        onSwapped={reloadAll}
      />
    </div>
  );
}
