import { useEffect, useState, useCallback, createContext, useContext, type ReactNode } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Modal, Spinner, cx, toast } from "./ui";
import { hasScope, SLOTS_CHANGED, type NotificationsData, type ShiftRequest, type SlotSwap } from "../../shared/types";

interface NotificationsContextType {
  data: NotificationsData;
  loading: boolean;
  unreadCount: number;
  refresh: () => Promise<void>;
  open: boolean;
  setOpen: (o: boolean) => void;
}

const emptyData: NotificationsData = {
  swaps: [],
  shift_requests: [],
  my_shift_request: null,
};

const NotificationsContext = createContext<NotificationsContextType>({
  data: emptyData,
  loading: false,
  unreadCount: 0,
  refresh: async () => {},
  open: false,
  setOpen: () => {},
});

const timeFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short" });

function fmtSlotRange(starts: string, ends: string) {
  const dStart = new Date(starts.endsWith("Z") ? starts : starts + "Z");
  const dEnd = new Date(ends.endsWith("Z") ? ends : ends + "Z");
  return `${dayFmt.format(dStart)} · ${timeFmt.format(dStart)} - ${timeFmt.format(dEnd)}`;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [data, setData] = useState<NotificationsData>(emptyData);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!user) return;
    try {
      const res = await api<NotificationsData>("/api/notifications");
      setData(res);
    } catch {
      // ignore background poll errors
    }
  }, [user?.id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const incomingPendingSwaps = data.swaps.filter((s) => s.to_user_id === user?.id && s.status === "pending").length;
  const pendingShiftReqs = user && (hasScope(user, "hr") || hasScope(user, "admin")) ? data.shift_requests.length : 0;
  const unreadCount = incomingPendingSwaps + pendingShiftReqs;

  return (
    <NotificationsContext.Provider value={{ data, loading, unreadCount, refresh, open, setOpen }}>
      {children}
      <NotificationsModal open={open} onClose={() => setOpen(false)} />
    </NotificationsContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationsContext);

export function NotificationBellButton({ className }: { className?: string }) {
  const { unreadCount, setOpen } = useNotifications();

  return (
    <button
      onClick={() => setOpen(true)}
      aria-label="Notifications"
      className={cx(
        "relative grid h-9 w-9 place-items-center rounded-md text-neutral-600 transition hover:bg-neutral-200/50 hover:text-ink active:scale-95",
        className
      )}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>
      {unreadCount > 0 && (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white shadow-sm ring-2 ring-white animate-pulse">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

export function NotificationsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, refresh: refreshAuth } = useAuth();
  const { data, refresh } = useNotifications();
  const [busyId, setBusyId] = useState<string | null>(null);

  const isHrOrAdmin = hasScope(user, "hr") || hasScope(user, "admin");
  const incomingSwaps = data.swaps.filter((s) => s.to_user_id === user?.id && s.status === "pending");
  const outgoingSwaps = data.swaps.filter((s) => s.from_user_id === user?.id);
  const shiftRequests = isHrOrAdmin ? data.shift_requests : [];

  const [tab, setTab] = useState<"swaps" | "shifts">("swaps");

  useEffect(() => {
    if (incomingSwaps.length === 0 && shiftRequests.length > 0) {
      setTab("shifts");
    } else {
      setTab("swaps");
    }
  }, [open, incomingSwaps.length, shiftRequests.length]);

  const acceptSwap = async (swap: SlotSwap) => {
    setBusyId(`swap-${swap.id}`);
    try {
      await api(`/api/slot-swaps/${swap.id}/accept`, { method: "POST" });
      toast(`Slot swap with ${swap.from_user_name} accepted!`);
      window.dispatchEvent(new Event(SLOTS_CHANGED));
      await refresh();
      await refreshAuth();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusyId(null);
    }
  };

  const declineSwap = async (swap: SlotSwap) => {
    setBusyId(`swap-${swap.id}`);
    try {
      await api(`/api/slot-swaps/${swap.id}/decline`, { method: "POST" });
      toast("Slot swap declined");
      await refresh();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusyId(null);
    }
  };

  const approveShift = async (req: ShiftRequest) => {
    setBusyId(`shift-${req.id}`);
    try {
      await api(`/api/shift-requests/${req.id}/approve`, { method: "POST" });
      toast(`Approved ${req.user_name}'s shift. Their shift is now started!`);
      await refresh();
      await refreshAuth();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusyId(null);
    }
  };

  const rejectShift = async (req: ShiftRequest) => {
    setBusyId(`shift-${req.id}`);
    try {
      await api(`/api/shift-requests/${req.id}/reject`, { method: "POST" });
      toast("Shift request rejected");
      await refresh();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusyId(null);
    }
  };

  const totalActionable = incomingSwaps.length + shiftRequests.length;

  return (
    <Modal open={open} onClose={onClose} title="Notifications & Requests" wide>
      <div className="space-y-4">
        {/* Navigation tabs if HR/Admin or if both categories exist */}
        {isHrOrAdmin && (
          <div className="flex border-b border-line gap-2 text-[13px] font-medium">
            <button
              onClick={() => setTab("swaps")}
              className={cx(
                "pb-2.5 px-1 border-b-2 flex items-center gap-1.5 transition",
                tab === "swaps" ? "border-accent text-accent font-semibold" : "border-transparent text-neutral-500 hover:text-ink"
              )}
            >
              Slot Swaps
              {incomingSwaps.length > 0 && (
                <span className="rounded-full bg-accent px-1.5 py-0.2 text-[10px] text-white">
                  {incomingSwaps.length}
                </span>
              )}
            </button>
            <button
              onClick={() => setTab("shifts")}
              className={cx(
                "pb-2.5 px-1 border-b-2 flex items-center gap-1.5 transition",
                tab === "shifts" ? "border-accent text-accent font-semibold" : "border-transparent text-neutral-500 hover:text-ink"
              )}
            >
              Shift Approvals (HR)
              {shiftRequests.length > 0 && (
                <span className="rounded-full bg-accent px-1.5 py-0.2 text-[10px] text-white">
                  {shiftRequests.length}
                </span>
              )}
            </button>
          </div>
        )}

        {/* Tab 1: Slot Swaps */}
        {tab === "swaps" && (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
            {/* Incoming Requests */}
            {incomingSwaps.length > 0 ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    Incoming Swap Requests ({incomingSwaps.length})
                  </h4>
                </div>
                {incomingSwaps.map((s) => (
                  <div key={s.id} className="rounded-xl border border-line bg-white p-3.5 shadow-sm space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-accent-soft text-accent font-bold flex items-center justify-center text-xs">
                          {s.from_user_name[0]?.toUpperCase()}
                        </div>
                        <div>
                          <div className="text-[13px] font-semibold text-ink">
                            {s.from_user_name} <span className="font-normal text-neutral-500">wants to swap slots</span>
                          </div>
                          <div className="text-[11px] text-neutral-400">
                            Requested {new Date(s.created_at.endsWith("Z") ? s.created_at : s.created_at + "Z").toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" })}
                          </div>
                        </div>
                      </div>
                      <Badge tone="warn">Pending your reply</Badge>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px] bg-neutral-50/70 p-2.5 rounded-lg border border-neutral-100">
                      <div>
                        <span className="font-medium text-neutral-500 block mb-0.5">They give you:</span>
                        <div className="font-semibold text-ink flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                          {fmtSlotRange(s.from_slot_start, s.from_slot_end)}
                        </div>
                      </div>
                      <div>
                        <span className="font-medium text-neutral-500 block mb-0.5">They get your slot:</span>
                        <div className="font-semibold text-ink flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-accent shrink-0" />
                          {fmtSlotRange(s.to_slot_start, s.to_slot_end)}
                        </div>
                      </div>
                    </div>

                    {s.note && (
                      <p className="text-[12px] text-neutral-600 bg-amber-50/50 p-2 rounded border border-amber-100/60 italic">
                        "{s.note}"
                      </p>
                    )}

                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="primary"
                        onClick={() => acceptSwap(s)}
                        disabled={busyId === `swap-${s.id}`}
                        className="flex-1"
                      >
                        {busyId === `swap-${s.id}` ? "Swapping…" : "Okay / Accept"}
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => declineSwap(s)}
                        disabled={busyId === `swap-${s.id}`}
                        className="flex-1"
                      >
                        Decline
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Outgoing Requests History / Updates */}
            {outgoingSwaps.length > 0 && (
              <div className="space-y-2 pt-2">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                  Your Swap Requests
                </h4>
                {outgoingSwaps.map((s) => (
                  <div key={s.id} className="rounded-lg border border-line p-3 text-[12px] bg-white flex items-center justify-between gap-2">
                    <div className="space-y-0.5">
                      <div className="font-medium text-ink">
                        Swap request to <span className="font-semibold">{s.to_user_name}</span>
                      </div>
                      <div className="text-neutral-500 text-[11px]">
                        Offered: {fmtSlotRange(s.from_slot_start, s.from_slot_end)}
                      </div>
                    </div>
                    <div>
                      {s.status === "pending" && <Badge tone="warn">Pending</Badge>}
                      {s.status === "accepted" && <Badge tone="good">Accepted</Badge>}
                      {s.status === "declined" && <Badge tone="bad">Declined</Badge>}
                      {s.status === "cancelled" && <Badge tone="neutral">Cancelled</Badge>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {incomingSwaps.length === 0 && outgoingSwaps.length === 0 && (
              <div className="py-8 text-center text-sm text-neutral-500">
                No active slot swap requests at the moment.
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Shift Approvals (HR / Admin) */}
        {tab === "shifts" && isHrOrAdmin && (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
            {shiftRequests.length > 0 ? (
              shiftRequests.map((req) => (
                <div key={req.id} className="rounded-xl border border-line bg-white p-3.5 shadow-sm space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-semibold text-ink">
                        {req.user_name} <span className="font-normal text-neutral-500">wants to start a shift</span>
                      </div>
                      <div className="text-[11px] text-neutral-400">
                        Requested {new Date(req.created_at.endsWith("Z") ? req.created_at : req.created_at + "Z").toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" })} · No slot scheduled
                      </div>
                    </div>
                    <Badge tone="warn">Needs HR approval</Badge>
                  </div>

                  {req.note && (
                    <div className="text-[12px] bg-neutral-50 p-2 rounded border border-neutral-100 text-neutral-700">
                      <b>Note:</b> {req.note}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1">
                    <Button
                      variant="primary"
                      onClick={() => approveShift(req)}
                      disabled={busyId === `shift-${req.id}`}
                      className="flex-1"
                    >
                      {busyId === `shift-${req.id}` ? "Approving…" : "Approve & Start Shift"}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => rejectShift(req)}
                      disabled={busyId === `shift-${req.id}`}
                      className="flex-1"
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-sm text-neutral-500">
                No pending shift approval requests.
              </div>
            )}
          </div>
        )}

        {/* User's own shift request status banner if any */}
        {data.my_shift_request && (
          <div className="rounded-lg border border-line bg-neutral-50/70 p-3 text-[12px]">
            <span className="font-semibold text-ink">Your recent shift request: </span>
            {data.my_shift_request.status === "pending" && (
              <span className="text-amber-700 font-medium">Pending approval from Admin/HR...</span>
            )}
            {data.my_shift_request.status === "approved" && (
              <span className="text-emerald-700 font-medium">Approved by {data.my_shift_request.reviewed_by_name ?? "Admin"}!</span>
            )}
            {data.my_shift_request.status === "rejected" && (
              <span className="text-red-700 font-medium">Rejected.</span>
            )}
          </div>
        )}

        <div className="pt-2 flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
