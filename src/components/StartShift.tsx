import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Button, Field, Input, Modal, Spinner, toast } from "./ui";
import { SHIFT_MINUTES, canOperate, type ShiftRequest } from "../../shared/types";

// Starting a shift hands someone the counter, cash and stock, so they confirm it first.
export function StartShiftDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [requestNote, setRequestNote] = useState("");
  const [pendingRequestId, setPendingRequestId] = useState<number | null>(null);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [rejectedMessage, setRejectedMessage] = useState<string | null>(null);

  // Reset state when dialog is opened
  useEffect(() => {
    if (!open) {
      setNeedsApproval(false);
      setRequestNote("");
      setPendingRequestId(null);
      setWaitingApproval(false);
      setRejectedMessage(null);
      return;
    }

    // Check if user already has an active pending shift request
    api("/api/notifications")
      .then((data: any) => {
        if (data.my_shift_request && data.my_shift_request.status === "pending") {
          setPendingRequestId(data.my_shift_request.id);
          setWaitingApproval(true);
        }
      })
      .catch(() => {});
  }, [open]);

  // Polling while waiting for Admin/HR approval
  useEffect(() => {
    if (!open || !waitingApproval) return;

    const interval = setInterval(async () => {
      try {
        // Check if shift has started
        const meRes = await api<{ shift: any }>("/api/me");
        if (meRes.shift) {
          clearInterval(interval);
          setWaitingApproval(false);
          await refresh();
          toast("Shift approved by Admin/HR! You are on the counter.");
          onClose();
          return;
        }

        // Check if shift request was rejected
        const notifRes = await api<{ my_shift_request: ShiftRequest | null }>("/api/notifications");
        if (notifRes.my_shift_request) {
          if (notifRes.my_shift_request.status === "approved") {
            clearInterval(interval);
            setWaitingApproval(false);
            await refresh();
            toast("Shift approved by Admin/HR! You are on the counter.");
            onClose();
          } else if (notifRes.my_shift_request.status === "rejected") {
            clearInterval(interval);
            setWaitingApproval(false);
            setRejectedMessage("Your request to start an unscheduled shift was rejected by Admin/HR.");
          }
        }
      } catch {
        // ignore background poll errors
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [open, waitingApproval, refresh, onClose]);

  const start = async () => {
    setBusy(true);
    setRejectedMessage(null);
    try {
      await api("/api/shifts/start", { json: {} });
      await refresh();
      toast("Shift started. You're on the counter");
      onClose();
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 403 || err.data?.needs_approval)) {
        setNeedsApproval(true);
      } else {
        toast(err.message, true);
      }
    } finally {
      setBusy(false);
    }
  };

  const sendApprovalRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; request_id: number }>("/api/shift-requests", {
        json: { note: requestNote.trim() || undefined },
      });
      setPendingRequestId(res.request_id);
      setWaitingApproval(true);
      setNeedsApproval(false);
      toast("Request sent to Admin and HR!");
    } catch (err: any) {
      toast(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={waitingApproval ? "Waiting for Approval" : needsApproval ? "Approval Required" : "Start your shift?"}>
      {waitingApproval ? (
        <div className="space-y-4 text-sm text-center py-4">
          <div className="relative mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
            <svg className="animate-spin h-7 w-7 text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <div className="space-y-1">
            <h4 className="font-semibold text-ink text-base">Request Sent to Admin & HR</h4>
            <p className="text-neutral-600 text-[13px] max-w-sm mx-auto">
              You don't have a scheduled slot right now. A notification has been sent to Admin and HR for approval.
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[12px] text-neutral-600 max-w-sm mx-auto">
            Once approved, your shift will <b>start automatically</b> and you'll be placed on the counter. You can keep this open or close it.
          </div>
          <div className="pt-2">
            <Button onClick={onClose} className="w-full">
              Close (Will notify when approved)
            </Button>
          </div>
        </div>
      ) : rejectedMessage ? (
        <div className="space-y-4 text-sm py-2">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3.5 text-red-900 text-[13px]">
            <p className="font-semibold mb-1">Shift Request Declined</p>
            <p>{rejectedMessage}</p>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : needsApproval ? (
        <form onSubmit={sendApprovalRequest} className="space-y-4 text-sm">
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-900 space-y-1">
            <p className="font-semibold">No slot scheduled at this time</p>
            <p className="text-amber-800 text-[12px]">
              You don't have an active slot scheduled right now. To start a shift outside your scheduled slots,
              send a request to Admin & HR for approval.
            </p>
          </div>

          <Field label="Note / Reason for unscheduled shift (optional)" hint="e.g. Covering for someone, rush hour, etc.">
            <Input
              value={requestNote}
              onChange={(e) => setRequestNote(e.target.value)}
              placeholder="Why are you starting a shift right now?"
            />
          </Field>

          <div className="flex gap-2 pt-2">
            <Button type="button" onClick={() => setNeedsApproval(false)} className="flex-1">
              Back
            </Button>
            <Button type="submit" variant="primary" disabled={busy} className="flex-1">
              {busy ? "Sending…" : "Request Admin/HR Approval"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-neutral-600">
            {user?.name?.split(" ")[0] ?? "You"}, you're about to take over the counter. Once your shift starts you can:
          </p>
          <ul className="space-y-1.5 text-neutral-700">
            {[
              "Ring up sales at the counter, cash and online",
              "Edit items at the counter (press and hold): prices, restock, write-offs and counts",
              "Add and edit menu items and prices",
              "Handle pre-orders and link online payments",
            ].map((t) => (
              <li key={t} className="flex gap-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {t}
              </li>
            ))}
          </ul>
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
            <b>Everything you do is logged</b> under your name with the time. Until you end your shift, you're responsible for the
            counter, the cash and the stock. Your shift <b>ends automatically after {SHIFT_MINUTES} minutes</b>; start a new one if
            you're staying, or tap <b>End shift</b> when you leave.
          </div>
          <div className="flex gap-2">
            <Button onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button variant="primary" onClick={start} disabled={busy} className="flex-1">
              {busy ? "Starting…" : "I understand, start shift"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Shown on pages where actions need a shift, to anyone who hasn't started one (admins never see it).
export function ShiftNotice({ what }: { what: string }) {
  const { user, shift } = useAuth();
  const [open, setOpen] = useState(false);
  if (canOperate(user, shift)) return null;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[12px] leading-snug text-amber-900 sm:text-[13px]"
      >
        <span>You're not on shift. Start your shift to {what}. Everything you do is logged under your name.</span>
        <span className="shrink-0 font-semibold underline">Start shift</span>
      </button>
      <StartShiftDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
