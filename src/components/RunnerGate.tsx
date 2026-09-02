"use client";

import { useCallback, useEffect, useState } from "react";
import { SessionRunner } from "@/components/SessionRunner";
import type { SessionView } from "@/lib/service";

/**
 * Gate shared by the diagnostic/practice/mock pages:
 * - with ?session=<id>: load that session and render the runner;
 * - without: render the page's intro and start a session on demand.
 */

interface Props {
  courseId: string;
  kind: "diagnostic" | "practice" | "mock";
  sessionId: string | null;
  intro: (start: (conceptId?: string) => void, starting: boolean) => React.ReactNode;
}

export function RunnerGate({ courseId, kind, sessionId, intro }: Props) {
  const [view, setView] = useState<SessionView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    const res = await fetch(`/api/sessions/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load session");
    setView(data as SessionView);
  }, []);

  useEffect(() => {
    if (sessionId) void load(sessionId).catch((err) => setError((err as Error).message));
  }, [sessionId, load]);

  const start = useCallback(
    async (conceptId?: string) => {
      setStarting(true);
      setError(null);
      try {
        const res = await fetch(`/api/courses/${courseId}/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, conceptId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to start session");
        setView(data as SessionView);
        // Keep the session in the URL so reloads and back-navigation restore it.
        const url = new URL(window.location.href);
        url.searchParams.set("session", data.session.id);
        window.history.replaceState(null, "", url.toString());
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setStarting(false);
      }
    },
    [courseId, kind],
  );

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 space-y-2">
        <p className="text-red-700">{error}</p>
        <button onClick={() => setError(null)} className="text-sm underline">
          Try again
        </button>
      </div>
    );
  }

  if (view) return <SessionRunner initialView={view} courseId={courseId} />;
  return <>{intro((cid) => void start(cid), starting)}</>;
}
