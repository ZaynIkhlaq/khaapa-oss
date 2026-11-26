import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { StartShiftDialog } from "./StartShift";
import { useAuth } from "../auth";
import { api } from "../api";
import { Button, Logo, cx, toast } from "./ui";
import { NotificationsProvider, NotificationBellButton } from "./NotificationsModal";
import { SHIFT_MINUTES, SCOPES, hasScope, type Scope, type User } from "../../shared/types";

type NavItem = { to: string; label: string; icon: string; scope?: Scope };
const nav: NavItem[] = [
  { to: "/pos", label: "Counter", icon: "M3 3h18v4H3zM5 7v14h14V7M9 11h6" },
  { to: "/schedule", label: "Schedule", icon: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4" },
  { to: "/stats", label: "Stats", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { to: "/orders", label: "Pre-orders", icon: "M6 2h12v20l-3-2-3 2-3-2-3 2zM9 7h6M9 11h6M9 15h3" },
  { to: "/sales", label: "Sales", icon: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5" },
  { to: "/payments", label: "Payments", icon: "M2 7h20v10H2zM2 11h20M6 15h4" },
  { to: "/shifts", label: "Shifts", icon: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2" },
  { to: "/activity", label: "Log", icon: "M12 8v4l3 3M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" },
  { to: "/attendance", label: "Attendance", icon: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4M8 15l2 2 4-4", scope: "hr" },
  { to: "/team", label: "Team", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75", scope: "hr" },
  { to: "/items", label: "Menu items", icon: "M4 6h16M4 12h16M4 18h10" },
  { to: "/codes", label: "Coupons", icon: "M3 9V5h18v4a3 3 0 0 0 0 6v4H3v-4a3 3 0 0 0 0-6zM10 5v14", scope: "admin" },
];

function allowed(n: NavItem, user: User | null) {
  if (n.scope) {
    return hasScope(user, n.scope);
  }
  return true;
}

function scopeNames(user: User | null) {
  if (!user) {
    return "";
  }
  return SCOPES.filter((s) => user.scopes.includes(s.key)).map((s) => s.label).join(", ") || "User";
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const { user, shift, logout, refresh } = useAuth();
  const nav_ = useNavigate();
  const items = nav.filter((n) => allowed(n, user));
  const cashier = true; // everyone approved can start a shift

  const [starting, setStarting] = useState(false);
  // Minutes left before the shift closes itself; when it runs out, reload so the app knows the shift ended.
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!shift) { setLeft(null); return; }
    const end = Date.parse(shift.started_at.endsWith("Z") ? shift.started_at : shift.started_at + "Z") + SHIFT_MINUTES * 60_000;
    const tick = () => {
      const m = Math.ceil((end - Date.now()) / 60_000);
      setLeft(Math.max(0, m));
      if (m <= 0) { refresh(); toast(`Your shift ended after ${SHIFT_MINUTES} minutes. Start a new one if you're staying.`); }
    };
    tick();
    const t = setInterval(tick, 20_000);
    return () => clearInterval(t);
  }, [shift?.id]);
  const toggleShift = async () => {
    if (!shift) return setStarting(true);
    try {
      if (!confirm("End your shift at the counter?")) return;
      await api("/api/shifts/end", { json: {} });
      toast("Shift ended");
      await refresh();
    } catch (err: any) { toast(err.message, true); }
  };

  // Phones get the same sidebar as desktop, sliding in from the left. It closes on navigation, Escape or a tap outside.
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", esc);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = ""; };
  }, [drawer]);

  const sidebar = (
    <>
      <div className="flex items-center justify-between px-5 py-5">
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-8" />
        </Link>
        <NotificationBellButton />
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3">
            {items.map((n) => (
              <NavLink key={n.to} to={n.to} className={({ isActive }) => cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium", isActive ? "bg-accent-soft text-accent" : "text-neutral-600 hover:bg-neutral-200/40 hover:text-ink")}>
                <Icon d={n.icon} />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-line p-4">
            <div className="mb-3">
              <div className="text-[13px] font-semibold">{user?.name}</div>
              <div className="truncate text-[12px] text-neutral-500">{user?.email ?? `@${user?.username}`} · {scopeNames(user)}</div>
            </div>
            {cashier && (
              <Button onClick={toggleShift} variant={shift ? "danger" : "primary"} className="w-full">
                {shift ? `End shift${left != null ? ` · ${left}m left` : ""}` : "Start shift"}
              </Button>
            )}
            <div className="mt-2 text-right text-xs">
              <button onClick={async () => { await logout(); nav_("/login"); }} className="text-neutral-500 hover:text-ink">Sign out</button>
            </div>
          </div>
    </>
  );

  return (
    <NotificationsProvider>
    <div className="min-h-dvh md:flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden w-56 shrink-0 border-r border-line bg-neutral-50/60 md:sticky md:top-0 md:flex md:h-dvh md:flex-col">
        {sidebar}
      </aside>

      {/* Sidebar (phones): same content, slides in */}
      {drawer && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setDrawer(false)} />
          <aside className="slide-in absolute inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col bg-neutral-50 shadow-xl">
            {sidebar}
          </aside>
        </div>
      )}

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-white/90 px-3 py-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-1.5">
        <button onClick={() => setDrawer(true)} aria-label="Open menu" className="grid h-9 w-9 place-items-center rounded-md text-neutral-700 hover:bg-neutral-100">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <Link to="/" className="flex items-center gap-2">
          <Logo className="h-7" />
        </Link>
        </div>
        <div className="flex items-center gap-2">
          <NotificationBellButton />
          {cashier && (
            <button onClick={toggleShift} className={cx("rounded-md px-2.5 py-1 text-[12px] font-medium", shift ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-600")}>
              {shift ? `● On counter${left != null ? ` · ${left}m` : ""}` : "Start shift"}
            </button>
          )}
        </div>
      </header>

      <main className="min-w-0 flex-1">{children}</main>


      <StartShiftDialog open={starting} onClose={() => setStarting(false)} />
    </div>
  </NotificationsProvider>
  );
}
