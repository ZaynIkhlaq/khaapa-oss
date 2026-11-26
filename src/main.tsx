import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import "./index.css";
import { AuthProvider, useAuth } from "./auth";
import { Logo, Spinner, Toaster } from "./components/ui";
import Shell from "./components/Shell";
import Public from "./pages/Public";
import Preorder from "./pages/Preorder";
import Mcp from "./pages/Mcp";
import Orders from "./pages/Orders";
import Attendance from "./pages/Attendance";
import Login from "./pages/Login";
import Pos from "./pages/Pos";
import Stats from "./pages/Stats";
import Items from "./pages/Items";
import Sales from "./pages/Sales";
import Team from "./pages/Team";
import Activity from "./pages/Activity";
import Shifts from "./pages/Shifts";
import Payments from "./pages/Payments";
import Connected from "./pages/Connected";
import Codes from "./pages/Codes";
import Schedule from "./pages/Schedule";
import { hasScope, type Scope, type User } from "../shared/types";

function Pending() {
  const { user, logout, refresh } = useAuth();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4">
      <div className="mb-8 flex items-center gap-2">
        <Logo className="h-8" />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-line bg-white p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold">Waiting for approval</h1>
        <p className="mt-1 text-[13px] text-neutral-500">You're signed in as {user?.email}. HR or an admin needs to approve your account before you can use the counter or see anything.</p>
        <div className="mt-4 flex justify-center gap-2">
          <button onClick={() => refresh()} className="min-h-9 rounded-md bg-accent px-3 text-[13px] font-medium text-white">Check again</button>
          <button onClick={() => logout()} className="min-h-9 rounded-md border border-line px-3 text-[13px] font-medium">Sign out</button>
        </div>
      </div>
    </div>
  );
}

function homeFor(_u: User) {
  return "/pos";
}

function Guard({ scope }: { scope?: Scope }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return <Spinner />;
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  }
  if (!user.approved) {
    return <Pending />;
  }
  if (scope && !hasScope(user, scope)) {
    return <Navigate to={homeFor(user)} replace />;
  }
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Public />} />
          <Route path="/login" element={<Login />} />
          <Route path="/preorder" element={<Preorder />} />
          <Route path="/mcp" element={<Mcp />} />
          <Route path="/connected" element={<Connected />} />
          <Route element={<Guard />}>
            <Route path="/inventory" element={<Navigate to="/pos" replace />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/shifts" element={<Shifts />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/activity" element={<Activity />} />
          </Route>
          <Route element={<Guard />}>
            <Route path="/pos" element={<Pos />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/items" element={<Items />} />
          </Route>
          <Route element={<Guard scope="hr" />}>
            <Route path="/team" element={<Team />} />
            <Route path="/attendance" element={<Attendance />} />
          </Route>
          <Route element={<Guard scope="admin" />}>
            <Route path="/codes" element={<Codes />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster />
    </AuthProvider>
  </StrictMode>,
);
