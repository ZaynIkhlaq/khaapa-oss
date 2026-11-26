import { useEffect, useState } from "react";
import { api } from "../api";
import { Badge, Button, Card, cx, toast } from "./ui";
import { PICK_CAP, PICK_DAYS, PICK_TIMES, PICKS_MIN, pickEndFor, pickMinutesFor, type Slot, type SlotPick, type User } from "../../shared/types";

type BlockKey = string;
type Props = { meId: number; isHr: boolean; open: boolean; people: User[]; picks: SlotPick[]; target: number; onTarget: (userId: number) => void; onChange: () => void; weekStart: string; oneOffs: Slot[]; present: Set<number> };
type CellProps = { blockKey: BlockKey; others: SlotPick[]; extra: Slot[]; present: Set<number>; targetAway: boolean; on: boolean; open: boolean; isHr: boolean; onFlip: (k: BlockKey) => void; onPerson: (userId: number) => void; targetId: number };

const blockKey = (weekday: number, start: string): BlockKey => `${weekday}|${start}`;
const unkey = (k: BlockKey) => ({ weekday: Number(k.split("|")[0]), start: k.split("|")[1] });
const firstName = (name: string) => name.split(" ")[0];

function clock(min: number) {
  const h = Math.floor(min / 60);
  return `${h % 12 || 12}:${String(min % 60).padStart(2, "0")}`;
}

// Formats e.g. "8:40 - 9:40", "12:40 - 2:00", "3:40 - 5:00".
function timeLabel(start: string) {
  const [sh, sm] = start.split(":").map(Number);
  const end = pickEndFor(start);
  const [eh, em] = end.split(":").map(Number);
  return `${clock(sh * 60 + sm)} - ${clock(eh * 60 + em)}`;
}

function blockLabel(k: BlockKey) {
  const p = unkey(k);
  return `${PICK_DAYS[p.weekday - 1].slice(0, 3)} ${timeLabel(p.start)}`;
}

function groupByBlock(picks: SlotPick[]) {
  const groups = new Map<BlockKey, SlotPick[]>();
  for (const p of picks) {
    const k = blockKey(p.weekday, p.start);
    const list = groups.get(k);
    if (list) {
      list.push(p);
      continue;
    }
    groups.set(k, [p]);
  }
  return groups;
}

function saveLabel(left: number, changed: boolean, saving: boolean, whose: string) {
  if (saving) {
    return "Saving...";
  }
  if (left > 0) {
    return `Pick ${left} more`;
  }
  if (changed) {
    return `Save ${whose} slots`;
  }
  return "Saved";
}

function cellTone(on: boolean, full: boolean, open: boolean) {
  if (on) {
    return "border-emerald-500 bg-emerald-50";
  }
  if (!open) {
    return "border-line";
  }
  if (full) {
    return "cursor-not-allowed border-line bg-neutral-100 text-neutral-400";
  }
  return "cursor-pointer border-line hover:bg-neutral-50";
}

function Person({ p, away, isHr, onPerson }: { p: SlotPick; away: boolean; isHr: boolean; onPerson: (userId: number) => void }) {
  if (away) {
    return <span className="truncate text-neutral-400 line-through" title={`${p.user_name}: not on this slot this week (swapped or removed)`}>{firstName(p.user_name)}</span>;
  }
  if (!isHr) {
    return <span className="truncate" title={p.user_name}>{firstName(p.user_name)}</span>;
  }
  const pick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onPerson(p.user_id);
  };
  return (
    <button onClick={pick} className="truncate text-left hover:text-emerald-700 hover:underline" title={`Edit ${p.user_name}'s slots this week`}>
      {firstName(p.user_name)}
    </button>
  );
}

function FullTag({ show }: { show: boolean }) {
  if (!show) {
    return null;
  }
  return <span>full</span>;
}

function OnTag({ show, away, label }: { show: boolean; away: boolean; label: string }) {
  if (!show) {
    return null;
  }
  if (away) {
    return <span className="truncate font-medium text-neutral-400 line-through" title="Not on this slot this week (swapped or removed)">{label}</span>;
  }
  return <span className="truncate font-medium text-emerald-800">{label}</span>;
}

const dateFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "UTC", day: "numeric", month: "short" });

const DAY = 86400_000;
const addWeekday = (week: string, weekday: number) => new Date(Date.parse(week + "T00:00:00Z") + (weekday - 1) * DAY).toISOString().slice(0, 10);
const addWeek = (week: string) => addWeekday(week, 8);
// Monday of the current week, Pakistan time.
function thisMonday() {
  const today = new Date(Date.now() + 5 * 3600_000);
  return new Date(Date.parse(today.toISOString().slice(0, 10) + "T00:00:00Z") - ((today.getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
}

// One-off slots overlapping a block on its date in the shown week.
function blockOneOffs(oneOffs: Slot[], weekStart: string, k: BlockKey) {
  const p = unkey(k);
  const date = new Date(Date.parse(weekStart + "T00:00:00Z") + (p.weekday - 1) * 86400_000).toISOString().slice(0, 10);
  const from = Date.parse(`${date}T${p.start}:00+05:00`);
  const to = from + pickMinutesFor(p.start) * 60_000;
  return oneOffs.filter((s) => Date.parse(s.starts_at) < to && Date.parse(s.ends_at) > from);
}

function OneOff({ s, isHr, onPerson }: { s: Slot; isHr?: boolean; onPerson?: (userId: number) => void }) {
  const day = dateFmt.format(new Date(Date.parse(s.starts_at) + 5 * 3600_000));
  if (isHr && onPerson) {
    return (
      <span className="truncate text-amber-700" title={`${s.user_name}: this week only (${day})`}>
        <button onClick={(e) => { e.stopPropagation(); onPerson(s.user_id); }} className="hover:text-amber-900 hover:underline">
          {firstName(s.user_name)}
        </button>{" "}
        · {day}
      </span>
    );
  }
  return <span className="truncate text-amber-700" title={`${s.user_name}: this week only (${day})`}>{firstName(s.user_name)} · {day}</span>;
}

function Cell({ blockKey: k, others, extra, present, targetAway, on, open, isHr, onFlip, onPerson, targetId, onLabel }: CellProps & { onLabel: string }) {
  const isTargetInExtra = extra.some((s) => s.user_id === targetId);
  const activeForTarget = on || isTargetInExtra;

  // Count the people actually on this block in the shown week, as the calendar has them.
  const userIds = new Set<number>();
  for (const p of others) {
    if (present.has(p.id)) userIds.add(p.user_id);
  }
  for (const s of extra) userIds.add(s.user_id);
  if (on && targetId && !targetAway) userIds.add(targetId);

  const taken = userIds.size;
  const full = taken >= PICK_CAP || others.length >= PICK_CAP;
  const tabIndex = full || !open ? -1 : 0;
  const title = `${blockLabel(k)}, ${taken}/${PICK_CAP}${full ? ", full" : ""}`;
  const flip = () => {
    if (open && (!full || on)) {
      onFlip(k);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") {
      return;
    }
    e.preventDefault();
    flip();
  };
  return (
    <div
      role="button"
      tabIndex={tabIndex}
      aria-pressed={activeForTarget}
      aria-disabled={full || !open}
      onClick={flip}
      onKeyDown={onKey}
      title={title}
      className={cx("flex min-h-[52px] flex-col gap-0.5 rounded-md border px-1.5 py-1 transition", cellTone(activeForTarget, full, open))}
    >
      <div className="flex items-center justify-between text-[10px] text-neutral-400 tabular">
        <span>{taken}/{PICK_CAP}</span>
        <FullTag show={full && !activeForTarget} />
      </div>
      <OnTag show={activeForTarget} away={targetAway && !isTargetInExtra} label={onLabel} />
      {others.map((p) => <Person key={p.id} p={p} away={!present.has(p.id)} isHr={isHr} onPerson={onPerson} />)}
      {extra
        .filter((s) => s.user_id !== targetId && !others.some((o) => o.user_id === s.user_id && present.has(o.id)))
        .map((s) => <OneOff key={s.id} s={s} isHr={isHr} onPerson={onPerson} />)}
    </div>
  );
}

function Missing({ people, onPerson }: { people: User[]; onPerson: (userId: number) => void }) {
  if (people.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2 text-[12px]">
      <span className="text-neutral-500">Not picked yet:</span>
      {people.map((u) => (
        <button key={u.id} onClick={() => onPerson(u.id)} title={`Pick slots for ${u.name}`}>
          <Badge tone="warn">{u.name}</Badge>
        </button>
      ))}
    </div>
  );
}

function OpenToggle({ isHr, open, onChange }: { isHr: boolean; open: boolean; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!isHr) {
    return null;
  }
  const toggle = async () => {
    if (open && !confirm("Close slot picking? Nobody can pick or change slots until you open it again. Slots already picked stay.")) {
      return;
    }
    setBusy(true);
    try {
      await api("/api/slot-picks/open", { method: "PUT", json: { open: !open } });
      toast(open ? "Slot picking closed" : "Slot picking is open");
    } catch (err: any) {
      toast(err.message, true);
    }
    setBusy(false);
    onChange();
  };
  return <Button onClick={toggle} disabled={busy}>{open ? "Close picking" : "Open picking"}</Button>;
}

type SaveBarProps = { canPick: boolean; over: boolean; locked: boolean; left: number; changed: boolean; saving: boolean; whose: string; onSave: () => void };

function SaveBar({ canPick, over, locked, left, changed, saving, whose, onSave }: SaveBarProps) {
  if (over) {
    return <Badge>This week is over</Badge>;
  }
  if (locked) {
    return <Badge tone="good">Saved. Only HR can change them</Badge>;
  }
  if (!canPick) {
    return <Badge tone="warn">Closed until HR opens it</Badge>;
  }
  return <Button variant="primary" onClick={onSave} disabled={saving || left !== 0 || !changed}>{saveLabel(left, changed, saving, whose)}</Button>;
}

function ClearButton({ show, name, onClear }: { show: boolean; name: string; onClear: () => void }) {
  if (!show) {
    return null;
  }
  return <Button variant="danger" onClick={onClear}>Clear {firstName(name)}'s slots</Button>;
}

export default function WeeklyPicks({ meId, isHr, open, people, picks, target: chosen, onTarget: setTarget, onChange, weekStart, oneOffs, present }: Props) {
  const target = isHr ? chosen : meId;
  const mineKey = picks.filter((p) => p.user_id === target).map((p) => blockKey(p.weekday, p.start)).sort().join(",");
  const [sel, setSel] = useState<BlockKey[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setSel(mineKey.split(",").filter(Boolean)), [mineKey, target]);

  const self = target === meId;
  const targetName = people.find((u) => u.id === target)?.name ?? "";
  const whose = self ? "my" : `${firstName(targetName)}'s`;
  // Once someone saves their picks they're set: only HR and admins change them after that.
  const locked = !isHr && mineKey !== "";
  const over = addWeek(weekStart) <= thisMonday();
  const canPick = !over && (isHr || (open && !locked));

  const groups = groupByBlock(picks);
  const changed = [...sel].sort().join(",") !== mineKey;
  const left = Math.max(PICKS_MIN - sel.length, 0);
  const picked = new Set([
    ...picks.map((p) => p.user_id),
    ...oneOffs.map((s) => s.user_id),
  ]);
  const missing = isHr ? people.filter((u) => !picked.has(u.id)) : [];

  const flip = (k: BlockKey) => {
    if (sel.includes(k)) {
      setSel(sel.filter((x) => x !== k));
      return;
    }
    setSel([...sel, k]);
  };
  const save = async () => {
    if (!isHr && !confirm(`Save ${sel.map(blockLabel).join(", ")}? After this only HR can change your slots.`)) {
      return;
    }
    setSaving(true);
    try {
      await api("/api/slot-picks", { method: "PUT", json: { user_id: target, week: weekStart, picks: sel.map(unkey) } });
      toast(self ? "Your slots for this week are saved" : `${targetName}'s slots for this week are saved`);
    } catch (err: any) {
      toast(err.message, true);
    }
    setSaving(false);
    onChange();
  };
  const clear = async () => {
    if (!confirm(`Clear ${targetName}'s slots for the week of ${weekLabel}? They'll need to pick at least ${PICKS_MIN} again.`)) {
      return;
    }
    try {
      await api(`/api/slot-picks/${target}?week=${weekStart}`, { method: "DELETE" });
      toast("Cleared");
      onChange();
    } catch (err: any) {
      toast(err.message, true);
    }
  };
  const others = (k: BlockKey) => (groups.get(k) || []).filter((p) => p.user_id !== target);
  const weekLabel = dateFmt.format(new Date(weekStart + "T00:00:00Z"));
  const started = (k: BlockKey) => {
    const p = unkey(k);
    return Date.parse(`${addWeekday(weekStart, p.weekday)}T${p.start}:00+05:00`) <= Date.now();
  };
  const targetAway = (k: BlockKey) => (groups.get(k) || []).some((p) => p.user_id === target && !present.has(p.id));

  return (
    <div id="weekly-slots" className="scroll-mt-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">Slots for the week of {weekLabel}{self ? "" : ` · ${targetName}`}</div>
            <div className="text-[12px] text-neutral-500">
              Pick at least {PICKS_MIN} slots, Monday to Friday. Up to {PICK_CAP} people per slot. They're for this week
              only: pick again for the next week (choose a day in that week on the calendar).
              {oneOffs.length ? <span className="text-amber-700"> Amber: one-off or swapped slots that week.</span> : null}
              <span className="text-neutral-400"> Struck through: off that week.</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SaveBar canPick={canPick} over={over} locked={locked} left={left} changed={changed} saving={saving} whose={whose} onSave={save} />
            <ClearButton show={!self && mineKey !== ""} name={targetName} onClear={clear} />
            <OpenToggle isHr={isHr} open={open} onChange={onChange} />
          </div>
        </div>
        <div className="overflow-x-auto p-3">
          <table className="w-full min-w-[560px] table-fixed border-separate border-spacing-1 text-[12px]">
            <thead>
              <tr>
                <th className="w-24" />
                {PICK_DAYS.map((d) => <th key={d} className="pb-1 text-left font-medium text-neutral-500">{d.slice(0, 3)}</th>)}
              </tr>
            </thead>
            <tbody>
              {PICK_TIMES.map((t) => (
                <tr key={t}>
                  <td className="whitespace-nowrap pr-2 align-top text-[11px] text-neutral-400 tabular">{timeLabel(t)}</td>
                  {PICK_DAYS.map((d, i) => (
                    <td key={d} className="align-top">
                      <Cell blockKey={blockKey(i + 1, t)} others={others(blockKey(i + 1, t))} extra={blockOneOffs(oneOffs, weekStart, blockKey(i + 1, t))} present={present} targetAway={targetAway(blockKey(i + 1, t))} on={sel.includes(blockKey(i + 1, t))} open={canPick && !started(blockKey(i + 1, t))} isHr={isHr} onFlip={flip} onPerson={setTarget} targetId={target} onLabel={self ? "You" : firstName(targetName)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Missing people={missing} onPerson={setTarget} />
      </Card>
    </div>
  );
}
