import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Link from "next/link";
import HomePage from "../app/page";
import CourseDashboardPage from "../app/course/[id]/page";
import DiagnosticPage from "../app/course/[id]/diagnostic/page";
import PracticePage from "../app/course/[id]/practice/page";
import MockExamPage from "../app/course/[id]/mock/page";
import ReadinessPage from "../app/course/[id]/readiness/page";
import { getHostedClient } from "../lib/api-client";
import "../app/globals.css";

window.__EXAMFORGE_HOSTED__ = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? "",
  publishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
  turnstileSiteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "",
};

interface TurnstileApi {
  render: (element: HTMLElement, options: {
    sitekey: string;
    appearance: "interaction-only";
    callback: (token: string) => void;
  }) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}
declare global { interface Window { turnstile?: TurnstileApi } }

function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const client = getHostedClient();
    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (cancelled) return;
      if (sessionError) setError("Your browser session could not be restored. Reload to try again.");
      if (data.session) setReady(true);
      setChecking(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (ready || checking || !container.current) return;
    const sitekey = window.__EXAMFORGE_HOSTED__?.turnstileSiteKey;
    if (!sitekey) { setError("Anonymous sign-in is not configured for this beta."); return; }
    let cancelled = false;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(container.current, {
        sitekey, appearance: "interaction-only",
        callback: (token) => {
          setError(null);
          void getHostedClient().auth.signInAnonymously({ options: { captchaToken: token } }).then(({ error: signInError }) => {
            if (cancelled) return;
            if (signInError) {
              setError("Anonymous sign-in failed. Please retry the verification or reload this page.");
              if (widgetId.current) window.turnstile?.reset(widgetId.current);
            } else {
              setReady(true);
            }
          });
        },
      });
    };
    if (window.turnstile) render();
    else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = render;
      script.onerror = () => setError("Verification could not load. Check your connection and reload.");
      document.head.appendChild(script);
    }
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [checking, ready]);

  if (ready) return <>{children}</>;
  return (
    <div className="max-w-lg mx-auto bg-white border rounded-xl p-6 space-y-3">
      <h1 className="text-xl font-semibold">Prepare your private study space</h1>
      <p className="text-sm text-slate-600">
        ExamForge creates an anonymous identity for this browser. Study material and progress are stored in the
        hosted ExamForge database. Clearing site data or using another browser can make them inaccessible.
        This beta has no account recovery or backup.
      </p>
      {checking ? <p className="text-sm text-slate-500">Restoring browser session…</p> :
        <div ref={container} aria-label="Verify to start an anonymous session" />}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

function RoutedPage() {
  const path = window.location.pathname;
  if (path === "/") return <HomePage />;
  if (/^\/course\/[^/]+$/.test(path)) return <CourseDashboardPage />;
  if (/^\/course\/[^/]+\/diagnostic$/.test(path)) return <DiagnosticPage />;
  if (/^\/course\/[^/]+\/practice$/.test(path)) return <PracticePage />;
  if (/^\/course\/[^/]+\/mock$/.test(path)) return <MockExamPage />;
  if (/^\/course\/[^/]+\/readiness$/.test(path)) return <ReadinessPage />;
  return <p role="alert">Page not found. <Link href="/" className="underline">Return to material</Link></p>;
}

function App() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <Link href="/" className="font-semibold text-lg tracking-tight">Exam<span className="text-indigo-600">Forge</span></Link>
          <span className="text-xs text-slate-500 hidden sm:block">Material → Diagnostic → Practice → Mock Exam → Readiness</span>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">
        <AuthGate><RoutedPage /></AuthGate>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
