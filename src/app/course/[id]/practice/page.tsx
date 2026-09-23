"use client";

import { apiFetch } from "@/lib/api-client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { RunnerGate } from "@/components/RunnerGate";
import { Stepper } from "@/components/Stepper";
import type { CourseOverview } from "@/lib/service";

export default function PracticePage() {
  return (
    <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
      <PracticeInner />
    </Suspense>
  );
}

function PracticeInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const sessionId = params.get("session");
  const [overview, setOverview] = useState<CourseOverview | null>(null);

  useEffect(() => {
    if (sessionId) return;
    apiFetch(`/api/courses/${id}`)
      .then((r) => r.json())
      .then((d) => setOverview(d as CourseOverview))
      .catch(() => undefined);
  }, [id, sessionId]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Targeted practice</h1>
        <Stepper courseId={id} current="practice" />
      </div>

      <RunnerGate
        courseId={id}
        kind="practice"
        sessionId={sessionId}
        intro={(start, starting) => (
          <div className="space-y-4">
            <p className="text-slate-700 max-w-2xl">
              Pick a topic — the weakest ones are listed first. Each practice run mixes question types and ends with
              an explanation grounded in your material.
            </p>
            {!overview ? (
              <p className="text-slate-500">Loading topics…</p>
            ) : (
              <div className="grid md:grid-cols-2 gap-3">
                {[...overview.concepts]
                  .sort((a, b) => b.mastery.reviewPriority - a.mastery.reviewPriority)
                  .map((c) => (
                    <button
                      key={c.id}
                      onClick={() => start(c.id)}
                      disabled={starting}
                      className="text-left bg-white border rounded-xl p-4 hover:border-indigo-400 space-y-1 disabled:opacity-50"
                    >
                      <div className="flex justify-between items-center">
                        <span className="font-medium">{c.name}</span>
                        <span
                          className={
                            "text-xs px-2 py-0.5 rounded-full " +
                            (c.mastery.status === "weak"
                              ? "bg-red-100 text-red-700"
                              : c.mastery.status === "developing"
                                ? "bg-amber-100 text-amber-800"
                                : c.mastery.status === "strong"
                                  ? "bg-green-100 text-green-800"
                                  : "bg-slate-100 text-slate-600")
                          }
                        >
                          {c.mastery.status}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 line-clamp-2">{c.description}</p>
                      <span className="text-xs text-indigo-600">
                        {starting ? "Preparing…" : "Start practice →"}
                      </span>
                    </button>
                  ))}
              </div>
            )}
            <Link href={`/course/${id}`} className="inline-block text-sm underline">
              Back to dashboard
            </Link>
          </div>
        )}
      />
    </div>
  );
}
