import { useEffect } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth";

export default function Login() {
  const nav = useNavigate();
  const loc = useLocation();
  const [params] = useSearchParams();
  const { user } = useAuth();
  const error = params.get("error");

  useEffect(() => {
    if (user) nav((loc.state as any)?.from ?? "/pos", { replace: true });
  }, [user, nav, loc.state]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-neutral-50 px-4">
      <Link to="/" className="mb-8">
        <img src="/logo-wide.webp" alt="Khaapa" className="w-44" />
      </Link>
      <div className="rise w-full max-w-sm space-y-5 rounded-lg border border-line bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">Staff sign in</h1>
          <p className="mt-1 text-[13px] text-neutral-500">Use your school Google account. New accounts need an admin's approval before they can do anything.</p>
        </div>
        {error && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</p>}
        <a href="/api/auth/google" className="flex w-full items-center justify-center gap-2.5 rounded-md border border-line bg-white px-3 py-2.5 text-[13px] font-medium shadow-sm transition hover:bg-neutral-50 active:scale-[.99]">
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.2z" />
            <path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0 1 9.7 24c0-1.6.3-3.1.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z" />
            <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.1 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
          </svg>
          Continue with Google
        </a>
        <p className="text-center text-[12px] text-neutral-400">Sessions last 24 hours.</p>
      </div>
    </div>
  );
}
