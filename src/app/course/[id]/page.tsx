"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { MasteryBar } from "@/components/MasteryBar";
import type { CourseOverview } from "@/lib/service";

export default function CourseDashboardPage() {
  const { id } = useParams<{ id: string }>();
  const [overview, setOverview] = useState<CourseOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load course");
        setOverview(data as CourseOverview);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  async function startSession(kind: "diagnostic" | "practice" | "mock", conceptId?: string) {
    setStarting(kind + (conceptId ?? ""));
    setError(null);
    try {
      const res = await fetch(`/api/courses/${id}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, conceptId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start session");
      const page = kind === "diagnostic" ? "diagnostic" : kind === "practice" ? "practice" : "mock";
      window.location.href = `/course/${id}/${page}?session=${data.session.id}`;
    } catch (err) {
      setError((err as Error).message);
      setStarting(null);
    }
  }

  if (error && !overview) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-xl p-6">
        <p className="text-red-700">{error}</p>
        <Link href="/" className="text-sm underline mt-2 inline-block">
          Back to material hub
        </Link>
      </div>
    );
  }
  if (!overview) return <p className="text-slate-500">Loading course…</p>;

  const { course, readiness, concepts } = overview;
  const hasAttempts = readiness.coverage > 0;
  const nextAction = readiness.nextAction;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-bold">{course.title}</h1>
          <span className="text-xs text-slate-500">
            {concepts.length} concepts · {overview.questionCount} questions · provider: {course.providerUsed}
          </span>
        </div>
        <Stepper courseId={course.id} current="material" />
      </div>

      {course.quality.notes.length > 0 && (
        <div className="border rounded-xl bg-white p-4 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Material & extraction notes</p>
          <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
            {course.quality.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Next action */}
      <section className="bg-indigo-600 text-white rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-indigo-200 font-medium">Next study action</p>
          <p className="text-lg font-semibold mt-1">{nextAction.message}</p>
        </div>
        <button
          onClick={() => {
            const kind = nextAction.kind === "practice" ? "practice" : nextAction.kind === "mock" || nextAction.kind === "review" ? "mock" : "diagnostic";
            void startSession(kind, nextAction.conceptId);
          }}
          disabled={starting !== null}
          className="px-5 py-2.5 rounded-lg bg-white text-indigo-700 font-semibold hover:bg-indigo-50 disabled:opacity-60"
        >
          {starting !== null
            ? "Preparing…"
            : nextAction.kind === "diagnostic"
              ? "Start diagnostic"
              : nextAction.kind === "practice"
                ? "Start practice"
                : nextAction.kind === "mock"
                  ? "Start mock exam"
                  : "Review topics"}
        </button>
      </section>

      {/* Readiness snapshot */}
      <section className="grid sm:grid-cols-3 gap-4">
        <div className="bg-white border rounded-xl p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Readiness estimate</p>
          <p className="text-3xl font-bold mt-1">{hasAttempts ? `${readiness.readiness}%` : "—"}</p>
          <p className="text-xs text-slate-500 mt-1">
            Internal heuristic estimate — not a prediction of a real exam score.
          </p>
        </div>
        <div className="bg-white border rounded-xl p-5">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Material coverage</p>
          <p className="text-3xl font-bold mt-1">{Math.round(readiness.coverage * 100)}%</p>
          <p className="text-xs text-slate-500 mt-1">Share of concepts you have been tested on.</p>
        </div>
        <div className="bg-white border rounded-xl p-5 flex flex-col justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Weak topics</p>
            <p className="text-3xl font-bold mt-1">{readiness.weak.length}</p>
          </div>
          <Link href={`/course/${course.id}/readiness`} className="text-sm text-indigo-600 hover:underline">
            View readiness details →
          </Link>
        </div>
      </section>

      {/* Concepts */}
      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Concepts from your material</h2>
        <div className="grid md:grid-cols-2 gap-3">
          {concepts.map((c) => (
            <div key={c.id} className="bg-white border rounded-xl p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium">{c.name}</h3>
                <span className="text-xs text-slate-400 shrink-0">
                  {c.mastery.attempts > 0 ? `${c.mastery.attempts} attempt${c.mastery.attempts > 1 ? "s" : ""}` : ""}
                </span>
              </div>
              <MasteryBar mastery={c.mastery.mastery} status={c.mastery.status} confidence={c.mastery.confidence} />
              <p className="text-sm text-slate-600">{c.description}</p>
              <details className="text-xs text-slate-500">
                <summary className="cursor-pointer hover:text-slate-700">Source evidence</summary>
                <blockquote className="border-l-2 border-slate-300 pl-2 mt-1 italic">
                  “{c.evidence[0]?.quote}”
                </blockquote>
              </details>
              <button
                onClick={() => void startSession("practice", c.id)}
                disabled={starting !== null}
                className="text-xs text-indigo-600 hover:underline disabled:opacity-40"
              >
                {starting === "practice" + c.id ? "Preparing…" : "Practice this topic →"}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Sessions */}
      {overview.sessions.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-semibold text-lg">Study sessions</h2>
          <ul className="bg-white border rounded-xl divide-y">
            {overview.sessions.slice(0, 8).map((s) => (
              <li key={s.id} className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                <span className="capitalize font-medium w-24">{s.kind}</span>
                <span className={s.status === "completed" ? "text-green-700" : "text-amber-700"}>
                  {s.status === "completed" ? "completed" : "in progress"}
                </span>
                <span className="text-slate-500 text-xs">
                  {new Date(s.createdAt).toLocaleString()} · {s.totalQuestions} questions
                </span>
                {s.status === "active" && (
                  <Link
                    href={`/course/${course.id}/${s.kind === "mock" ? "mock" : s.kind}?session=${s.id}`}
                    className="ml-auto text-indigo-600 hover:underline"
                  >
                    Resume →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
