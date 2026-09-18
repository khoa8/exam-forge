"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Stepper } from "@/components/Stepper";
import { MasteryBar } from "@/components/MasteryBar";
import { MockProtectionNotice } from "@/components/MockProtectionNotice";
import type { CourseOverview } from "@/lib/service";

export default function ReadinessPage() {
  const { id } = useParams<{ id: string }>();
  const [overview, setOverview] = useState<CourseOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/courses/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load course");
        setOverview(data as CourseOverview);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

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
  if (!overview) return <p className="text-slate-500">Loading readiness…</p>;

  const { readiness, course } = overview;
  const ordered = [...readiness.concepts].sort((a, b) => b.reviewPriority - a.reviewPriority);
  const conceptName = (conceptId: string) => overview.concepts.find((c) => c.id === conceptId)?.name ?? conceptId;

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Readiness &amp; next study plan</h1>
        <Stepper courseId={id} current="readiness" />
      </div>

      <section className="grid sm:grid-cols-3 gap-4">
        <div className="bg-white border rounded-xl p-5 sm:col-span-1">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">Readiness estimate</p>
          <p className="text-5xl font-bold mt-2 text-indigo-700">{readiness.coverage > 0 ? `${readiness.readiness}%` : "—"}</p>
          <div className="h-2 bg-slate-100 rounded-full overflow-hidden mt-3">
            <div className="h-full bg-indigo-600 rounded-full" style={{ width: `${readiness.readiness}%` }} />
          </div>
          <p className="text-xs text-slate-500 mt-2">{readiness.disclaimer}</p>
        </div>
        <div className="bg-white border rounded-xl p-5 sm:col-span-2 space-y-3">
          <p className="text-xs uppercase tracking-wide text-slate-500 font-medium">What to study next, in order</p>
          {readiness.weak.length > 0 && (
            <div>
              <p className="text-sm font-medium text-red-700">1. Weak topics — practice these first</p>
              <p className="text-sm text-slate-600">
                {readiness.weak.map((w) => conceptName(w.conceptId)).join(", ")}
              </p>
            </div>
          )}
          {readiness.untested.length > 0 && (
            <div>
              <p className="text-sm font-medium text-slate-700">
                {readiness.weak.length > 0 ? "2" : "1"}. Untested topics — take the diagnostic or practice them
              </p>
              <p className="text-sm text-slate-600">
                {readiness.untested.map((u) => conceptName(u.conceptId)).join(", ")}
              </p>
            </div>
          )}
          {readiness.strong.length > 0 && (
            <div>
              <p className="text-sm font-medium text-green-700">
                {readiness.weak.length + (readiness.untested.length > 0 ? 1 : 0) + 1}. Strong topics — keep warm with
                occasional review
              </p>
              <p className="text-sm text-slate-600">{readiness.strong.map((s) => conceptName(s.conceptId)).join(", ")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <Link
              href={`/course/${id}/practice`}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
            >
              Practice weak topic
            </Link>
            <Link
              href={`/course/${id}/mock`}
              className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-slate-50"
            >
              Take mock exam
            </Link>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Concept mastery (highest review priority first)</h2>
        <MockProtectionNotice active={overview.activeSession?.kind === "mock"} />
        <div className="bg-white border rounded-xl divide-y">
          {ordered.map((m) => (
            <div key={m.conceptId} className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="font-medium">{conceptName(m.conceptId)}</span>
                <span className="text-xs text-slate-500">
                  {m.attempts} attempt{m.attempts === 1 ? "" : "s"} · {m.correct} correct
                  {m.lastSeen ? ` · last seen ${new Date(m.lastSeen).toLocaleDateString()}` : ""}
                </span>
              </div>
              <MasteryBar mastery={m.mastery} status={m.status} confidence={m.confidence} />
              {m.nextReviewInDays !== null && (
                <p className="text-xs text-slate-500">
                  {m.nextReviewInDays === 0
                    ? "Recommended review: today"
                    : `Recommended next review: in ${m.nextReviewInDays} day${m.nextReviewInDays === 1 ? "" : "s"}`}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Session history</h2>
        {overview.sessions.length === 0 ? (
          <p className="text-sm text-slate-500">No sessions yet — take the diagnostic first.</p>
        ) : (
          <ul className="bg-white border rounded-xl divide-y">
            {overview.sessions.map((s) => (
              <li key={s.id} className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                <span className="capitalize font-medium w-24">{s.kind}</span>
                <span className={s.status === "completed" ? "text-green-700" : "text-amber-700"}>
                  {s.status === "completed" ? "completed" : "in progress"}
                </span>
                <span className="text-slate-500 text-xs">{new Date(s.createdAt).toLocaleString()}</span>
                {s.status === "active" && (
                  <Link
                    href={`/course/${id}/${s.kind === "mock" ? "mock" : s.kind}?session=${s.id}`}
                    className="ml-auto text-indigo-600 hover:underline"
                  >
                    Resume →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-slate-500">
        Mastery, readiness and review priority are simple heuristics over your answers in this app (recent answers
        count more). They are internal study signals for “{course.title}” only — they do not predict your real exam
        grade.
      </p>
    </div>
  );
}
