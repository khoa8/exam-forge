"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { RunnerGate } from "@/components/RunnerGate";
import { Stepper } from "@/components/Stepper";

export default function MockExamPage() {
  return (
    <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
      <MockInner />
    </Suspense>
  );
}

function MockInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const sessionId = params.get("session");
  const [info, setInfo] = useState<{ title: string; questionCount: number } | null>(null);

  useEffect(() => {
    if (sessionId) return;
    fetch(`/api/courses/${id}`)
      .then((r) => r.json())
      .then((d) => setInfo({ title: d.course?.title ?? "", questionCount: d.questionCount ?? 0 }))
      .catch(() => undefined);
  }, [id, sessionId]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Mock exam</h1>
        <Stepper courseId={id} current="mock" />
      </div>

      <RunnerGate
        courseId={id}
        kind="mock"
        sessionId={sessionId}
        intro={(start, starting) => (
          <div className="bg-white border rounded-xl p-6 space-y-4 max-w-2xl">
            <p className="text-slate-700 leading-relaxed">
              A short exam sampled across all concepts of <span className="font-medium">{info?.title || "your material"}</span>{" "}
              with mixed question types. Unlike the diagnostic, feedback is withheld until you submit — just like a
              real exam, so the result reflects what you actually know today.
            </p>
            <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
              <li>Up to 8 questions, balanced across concepts.</li>
              <li>Graded consistently by the same engine as practice.</li>
              <li>After submission: per-topic breakdown and a full review with explanations.</li>
              <li>First answers count — treat it as a dress rehearsal, not a quiz.</li>
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => start()}
                disabled={starting}
                className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-60"
              >
                {starting ? "Assembling exam…" : "Start mock exam"}
              </button>
              <Link href={`/course/${id}`} className="px-5 py-2.5 rounded-lg border font-medium hover:bg-slate-50">
                Cancel
              </Link>
            </div>
            {info && info.questionCount < 4 && (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                This course has few questions ({info.questionCount}). The mock exam will be short.
              </p>
            )}
          </div>
        )}
      />
    </div>
  );
}
