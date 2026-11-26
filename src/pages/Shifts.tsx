import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtTime, rs } from "../api";
import { useAuth } from "../auth";
import { Badge, Card, Pager, Spinner, toast, usePaged } from "../components/ui";
import { hasScope, type Shift } from "../../shared/types";

function dur(a: string, b: string | null) {
  const ms = new Date((b ?? new Date().toISOString()).replace(/Z?$/, "Z")).getTime() - new Date(a.replace(/Z?$/, "Z")).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function Shifts() {
  const { user, refresh } = useAuth();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const load = () => api("/api/shifts?limit=100").then((d) => setShifts(d.shifts));
  useEffect(() => { load(); }, []);
  const { shown, pager } = usePaged(shifts ?? []);

  const end = async (s: Shift) => {
    if (!confirm(`End ${s.user_name}'s shift?`)) return;
    try { await api("/api/shifts/end", { json: { shift_id: s.id } }); toast("Shift ended"); load(); refresh(); } catch (e: any) { toast(e.message, true); }
  };

  return (
    <div className="space-y-6 p-4 md:px-6 md:py-6">
      <div>
        <h1 className="text-xl font-semibold">Shifts</h1>
        <p className="text-sm text-neutral-500">Who was on the counter, for how long, and what they sold.{hasScope(user, "hr") && <> Charts and slot attendance are on <Link to="/attendance" className="underline decoration-neutral-300">Attendance</Link>.</>}</p>
      </div>
      {shifts === null ? <Spinner /> : shifts.length === 0 ? <p className="py-12 text-center text-neutral-400">No shifts yet. Start one from the sidebar.</p> : (
        <Card className="divide-y divide-line">
          {shown.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">{s.user_name}{!s.ended_at && <Badge tone="good">On counter</Badge>}</div>
                <div className="text-xs text-neutral-500">{fmtTime(s.started_at)} → {s.ended_at ? fmtTime(s.ended_at) : "now"} · {dur(s.started_at, s.ended_at)}</div>
              </div>
              <div className="text-right">
                <div className="tabular font-semibold">{rs(s.sales_total)}</div>
                <div className="text-xs text-neutral-500">{s.sales_count} sales</div>
              </div>
              {!s.ended_at && (user?.role === "admin" || hasScope(user, "hr") || user?.id === s.user_id) && (
                <button onClick={() => end(s)} className="text-xs text-red-600 hover:underline">End</button>
              )}
            </div>
          ))}
          <Pager {...pager} />
        </Card>
      )}
    </div>
  );
}
