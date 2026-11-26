import { useSearchParams } from "react-router-dom";
import { Logo } from "../components/ui";

export default function Connected() {
  const [p] = useSearchParams();
  const ok = p.get("ok") === "1";
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="mb-8 flex items-center gap-2">
        <Logo className="h-8" />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-6 text-center shadow-sm">
        <div className={`mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full text-lg ${ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{ok ? "✓" : "!"}</div>
        <h1 className="text-lg font-semibold">{ok ? "Inbox connected" : "Could not connect"}</h1>
        <p className="mt-1 text-[13px] text-neutral-500">{p.get("msg")}</p>
        {ok && <p className="mt-3 text-[12px] text-neutral-400">Khaapa only reads NayaPay payment emails, and access is read-only. You can revoke it any time from your Google account.</p>}
      </div>
    </div>
  );
}
