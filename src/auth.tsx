import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import type { Shift, User } from "../shared/types";

interface OnCounter { id: number; started_at: string; user_id: number; user_name: string }
interface AuthState {
  user: User | null;
  shift: Shift | null;
  onCounter: OnCounter[];
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [onCounter, setOnCounter] = useState<OnCounter[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const d = await api("/api/me");
      setUser(d.user);
      setShift(d.shift);
      setOnCounter(d.on_counter ?? []);
    } catch (err) {
      // A dropped connection on a background refresh keeps the session; only the server saying no signs out.
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setShift(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-check every minute and when the tab comes back, so the shift state stays current without a reload.
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    const onFocus = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  const logout = async () => {
    await api("/api/logout", { method: "POST" });
    setUser(null);
    setShift(null);
  };

  return <Ctx.Provider value={{ user, shift, onCounter, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
