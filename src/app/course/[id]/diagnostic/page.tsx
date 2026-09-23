"use client";

import { apiFetch } from "@/lib/api-client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { RunnerGate } from "@/components/RunnerGate";
import { Stepper } from "@/components/Stepper";

export default function DiagnosticPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const sessionId = params.get("session");
  const [info, setInfo] = useState<{ title: string; concepts: number } | null>(null);

  useEffect(() => {
    if (sessionId) return;
    apiFetch(`/api/courses/${id}`)
      .then((r) => r.json())
      .then((d) => setInfo({ title: d.course?.title ?? "", concepts: d.concepts?.length ?? 0 }))
      .catch(() => undefined);
  }, [id, sessionId]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">Diagnostic quiz</h1>
        <Stepper courseId={id} current="diagnostic" />
      </div>

      <RunnerGate
        courseId={id}
        kind="diagnostic"
        sessionId={sessionId}
        intro={(start, starting) => (
          <div className="bg-white border rounded-xl p-6 space-y-4 max-w-2xl">
            <p className="text-slate-700 leading-relaxed">
              A short quiz with one question per major concept, drawn directly from your material. It calibrates
              which topics are <span className="font-medium">strong</span> and which are{" "}
              <span className="font-medium">weak</span>, so practice can target what actually needs work.
            </p>
            <ul className="text-sm text-slate-600 list-disc pl-5 space-y-1">
              <li>{info ? `Up to ${Math.min(info.concepts, 8)} questions across ${info.concepts} concepts.` : "One question per major concept."}</li>
              <li>Feedback and a grounded explanation after every answer.</li>
              <li>Your first answer counts — no retries, so the estimate stays honest.</li>
            </ul>
            <div className="flex gap-3">
              <button
                onClick={() => start()}
                disabled={starting}
                className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-60"
              >
                {starting ? "Preparing questions…" : "Start diagnostic"}
              </button>
              <Link href={`/course/${id}`} className="px-5 py-2.5 rounded-lg border font-medium hover:bg-slate-50">
                Cancel
              </Link>
            </div>
          </div>
        )}
      />
    </div>
  );
}
