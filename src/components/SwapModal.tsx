import { useEffect, useState, useMemo } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Badge, Button, Field, Input, Modal, Spinner, cx, toast } from "./ui";
import type { Slot } from "../../shared/types";

interface ActiveSlotUser extends Slot {
  user_name: string;
}

interface ActiveSlotsResponse {
  my_slots: Slot[];
  other_slots: ActiveSlotUser[];
}

interface SwapModalProps {
  open: boolean;
  onClose: () => void;
  preselectedMySlotId?: number | null;
  preselectedTheirSlotId?: number | null;
  preselectedUserId?: number | null;
  onSwapped?: () => void;
}

const timeFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", weekday: "short", day: "numeric", month: "short" });

function formatSlotLabel(s: { starts_at: string; ends_at: string }) {
  const dStart = new Date(s.starts_at.endsWith("Z") ? s.starts_at : s.starts_at + "Z");
  const dEnd = new Date(s.ends_at.endsWith("Z") ? s.ends_at : s.ends_at + "Z");
  return `${dayFmt.format(dStart)} · ${timeFmt.format(dStart)} – ${timeFmt.format(dEnd)}`;
}

export function SwapModal({
  open,
  onClose,
  preselectedMySlotId,
  preselectedTheirSlotId,
  preselectedUserId,
  onSwapped,
}: SwapModalProps) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mySlots, setMySlots] = useState<Slot[]>([]);
  const [otherSlots, setOtherSlots] = useState<ActiveSlotUser[]>([]);

  const [selectedMySlotId, setSelectedMySlotId] = useState<number | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [selectedTheirSlotId, setSelectedTheirSlotId] = useState<number | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [note, setNote] = useState("");

  // Fetch active slots when modal opens
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<ActiveSlotsResponse>("/api/slot-swaps/active-slots")
      .then((data) => {
        setMySlots(data.my_slots || []);
        setOtherSlots(data.other_slots || []);

        // Initialize selections
        if (preselectedMySlotId && (data.my_slots || []).some((s) => s.id === preselectedMySlotId)) {
          setSelectedMySlotId(preselectedMySlotId);
        } else if ((data.my_slots || []).length > 0) {
          setSelectedMySlotId(data.my_slots[0].id);
        } else {
          setSelectedMySlotId(null);
        }

        if (preselectedUserId) {
          setSelectedUserId(preselectedUserId);
        }

        if (preselectedTheirSlotId && (data.other_slots || []).some((s) => s.id === preselectedTheirSlotId)) {
          setSelectedTheirSlotId(preselectedTheirSlotId);
          const found = data.other_slots.find((s) => s.id === preselectedTheirSlotId);
          if (found) setSelectedUserId(found.user_id);
        }
      })
      .catch((err) => {
        toast(err.message, true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open, preselectedMySlotId, preselectedTheirSlotId, preselectedUserId]);

  // Unique list of other members with active slots
  const membersWithSlots = useMemo(() => {
    const map = new Map<number, { id: number; name: string; slotCount: number }>();
    for (const slot of otherSlots) {
      const existing = map.get(slot.user_id);
      if (existing) {
        existing.slotCount += 1;
      } else {
        map.set(slot.user_id, { id: slot.user_id, name: slot.user_name, slotCount: 1 });
      }
    }
    return Array.from(map.values());
  }, [otherSlots]);

  // Filter members by search input
  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase().replace(/^@/, "");
    if (!q) return membersWithSlots;
    return membersWithSlots.filter((m) => m.name.toLowerCase().includes(q));
  }, [membersWithSlots, memberSearch]);

  // Active slots for the selected member
  const theirAvailableSlots = useMemo(() => {
    if (!selectedUserId) return [];
    return otherSlots.filter((s) => s.user_id === selectedUserId);
  }, [otherSlots, selectedUserId]);

  // Auto-select their slot if there's only one
  useEffect(() => {
    if (selectedUserId && theirAvailableSlots.length === 1 && !selectedTheirSlotId) {
      setSelectedTheirSlotId(theirAvailableSlots[0].id);
    }
  }, [selectedUserId, theirAvailableSlots, selectedTheirSlotId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMySlotId) {
      toast("Please select one of your upcoming active slots to trade", true);
      return;
    }
    if (!selectedTheirSlotId) {
      toast("Please select an active slot from another member to swap with", true);
      return;
    }

    setSubmitting(true);
    try {
      await api("/api/slot-swaps", {
        json: {
          my_slot_id: selectedMySlotId,
          their_slot_id: selectedTheirSlotId,
          note: note.trim() || undefined,
        },
      });

      const selectedMember = membersWithSlots.find((m) => m.id === selectedUserId);
      toast(
        `Swap request sent to ${selectedMember?.name ?? "the member"}! They will receive a notification to confirm.`
      );
      onSwapped?.();
      onClose();
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setSubmitting(false);
    }
  };

  const selectedMemberObj = membersWithSlots.find((m) => m.id === selectedUserId);

  return (
    <Modal open={open} onClose={onClose} title="Swap Active Shift Slot" wide>
      {loading ? (
        <Spinner />
      ) : mySlots.length === 0 ? (
        <div className="space-y-4 py-3 text-[13px]">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3.5 text-amber-900">
            <p className="font-semibold mb-1">No upcoming slots to swap</p>
            <p className="text-amber-800 text-[12px]">
              You can only swap slots that haven't ended yet. You have no upcoming slots.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 text-[13px]">
          <p className="text-neutral-500 text-[12px]">
            Trade one of your upcoming slots with another member's upcoming slot, any day or week. Slots that have ended can't be swapped.
            They will receive an in-app notification to accept or decline.
          </p>

          {/* Section 1: Choose my slot */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600">
              1. Your slot to give away ({mySlots.length} active)
            </label>
            <div className="grid gap-2 max-h-36 overflow-y-auto pr-1">
              {mySlots.map((s) => {
                const isSelected = selectedMySlotId === s.id;
                return (
                  <div
                    key={s.id}
                    onClick={() => setSelectedMySlotId(s.id)}
                    className={cx(
                      "flex cursor-pointer items-center justify-between rounded-lg border p-2.5 transition",
                      isSelected
                        ? "border-accent bg-accent-soft/40 text-accent font-medium shadow-xs"
                        : "border-line bg-white hover:bg-neutral-50 text-neutral-700"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="mySlot"
                        checked={isSelected}
                        onChange={() => setSelectedMySlotId(s.id)}
                        className="text-accent focus:ring-accent"
                      />
                      <span>{formatSlotLabel(s)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Section 2: Choose user to swap with */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600">
              2. Select / Mention team member
            </label>
            <div className="relative">
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Type member name or @mention..."
                className="pl-8"
              />
              <span className="absolute left-2.5 top-2.5 text-neutral-400 font-medium">@</span>
            </div>

            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pt-1">
              {filteredMembers.map((m) => {
                const isSelected = selectedUserId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      setSelectedUserId(m.id);
                      setSelectedTheirSlotId(null);
                    }}
                    className={cx(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition border",
                      isSelected
                        ? "border-accent bg-accent text-white font-medium"
                        : "border-line bg-neutral-50 text-neutral-700 hover:bg-neutral-100"
                    )}
                  >
                    <span>@{m.name}</span>
                    <span
                      className={cx(
                        "rounded-full px-1 text-[10px]",
                        isSelected ? "bg-white/20 text-white" : "bg-neutral-200 text-neutral-600"
                      )}
                    >
                      {m.slotCount}
                    </span>
                  </button>
                );
              })}
              {filteredMembers.length === 0 && (
                <p className="text-xs text-neutral-400 py-1">No members found with upcoming slots.</p>
              )}
            </div>
          </div>

          {/* Section 3: Select their slot */}
          {selectedUserId && (
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-600">
                3. Choose @{selectedMemberObj?.name}'s active slot to take
              </label>
              {theirAvailableSlots.length === 0 ? (
                <p className="text-xs text-neutral-500 italic">This member has no upcoming slots.</p>
              ) : (
                <div className="grid gap-2 max-h-36 overflow-y-auto pr-1">
                  {theirAvailableSlots.map((s) => {
                    const isSelected = selectedTheirSlotId === s.id;
                    return (
                      <div
                        key={s.id}
                        onClick={() => setSelectedTheirSlotId(s.id)}
                        className={cx(
                          "flex cursor-pointer items-center justify-between rounded-lg border p-2.5 transition",
                          isSelected
                            ? "border-emerald-600 bg-emerald-50/60 text-emerald-800 font-medium shadow-xs"
                            : "border-line bg-white hover:bg-neutral-50 text-neutral-700"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="radio"
                            name="theirSlot"
                            checked={isSelected}
                            onChange={() => setSelectedTheirSlotId(s.id)}
                            className="text-emerald-600 focus:ring-emerald-600"
                          />
                          <span>{formatSlotLabel(s)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Section 4: Optional Note */}
          <Field label="Note / Message (Optional)" hint="Give a quick reason to the member for this swap request">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Can we trade? I have an exam / doctor appointment"
            />
          </Field>

          {/* Action buttons */}
          <div className="flex gap-2 pt-2">
            <Button type="button" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || !selectedMySlotId || !selectedTheirSlotId}
              className="flex-1"
            >
              {submitting ? "Sending Request…" : "Send Swap Request"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
