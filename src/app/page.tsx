"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface CourseListItem {
  id: string;
  title: string;
  sourceType: string;
  createdAt: string;
  providerUsed: string;
  quality: { level: string; notes: string[] };
}

export default function HomePage() {
  const router = useRouter();
  const [courses, setCourses] = useState<CourseListItem[] | null>(null);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadCourses = useCallback(async () => {
    const res = await fetch("/api/courses");
    const data = await res.json();
    setCourses(data.courses);
  }, []);

  useEffect(() => {
    void loadCourses();
  }, [loadCourses]);

  async function createCourse(init: () => Promise<Response>, label: string) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      const res = await init();
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create course");
      router.push(`/course/${data.courseId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  }

  function loadSample() {
    void createCourse(async () => fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sample: true }),
    }), "sample");
  }

  function submitPaste() {
    if (pasteText.trim().length < 80) {
      setError("Please paste at least 80 characters of study material.");
      return;
    }
    void createCourse(async () => fetch("/api/courses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: pasteText, title: pasteTitle || undefined }),
    }), "paste");
  }

  function submitPdf() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a PDF file first.");
      return;
    }
    void createCourse(async () => {
      const form = new FormData();
      form.append("file", file);
      return fetch("/api/courses", { method: "POST", body: form });
    }, "pdf");
  }

  async function deleteCourse(id: string) {
    setBusy("delete-" + id);
    await fetch(`/api/courses/${id}`, { method: "DELETE" });
    setConfirmDeleteId(null);
    setNotice("Course deleted, including its material and progress.");
    setBusy(null);
    void loadCourses();
  }

  return (
    <div className="space-y-8">
      <section className="text-center space-y-3 py-6">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
          Turn study material into an <span className="text-indigo-600">adaptive exam coach</span>
        </h1>
        <p className="text-slate-600 max-w-2xl mx-auto">
          ExamForge extracts the key concepts from your material, diagnoses your weak topics with a short quiz,
          gives grounded explanations, and builds a study plan — active recall first, no PDF chat.
        </p>
      </section>

      <section className="grid md:grid-cols-3 gap-4">
        <button
          onClick={loadSample}
          disabled={busy !== null}
          className="text-left bg-white border-2 border-indigo-200 hover:border-indigo-400 rounded-xl p-5 space-y-2 disabled:opacity-50 transition-colors"
        >
          <span className="text-xs font-medium uppercase tracking-wide text-indigo-600">No setup needed</span>
          <h2 className="font-semibold text-lg">
            {busy === "sample" ? "Loading sample…" : "Load bundled demo material"}
          </h2>
          <p className="text-sm text-slate-600">
            “Introduction to Human Memory” — a ready-made course that runs fully offline. Best first step.
          </p>
        </button>

        <div className="bg-white border rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-lg">Paste your material</h2>
          <input
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="Title (optional)"
            aria-label="Course title (optional)"
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
          />
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste lecture notes or Markdown. Headings and definitions like “X is …” produce the best questions."
            aria-label="Study material"
            rows={4}
            className="w-full px-3 py-2 rounded-lg border border-slate-300 text-sm"
          />
          <button
            onClick={submitPaste}
            disabled={busy !== null}
            className="w-full px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40"
          >
            {busy === "paste" ? "Extracting concepts…" : "Create course"}
          </button>
        </div>

        <div className="bg-white border rounded-xl p-5 space-y-3">
          <h2 className="font-semibold text-lg">Upload a PDF</h2>
          <p className="text-sm text-slate-600">Text-based PDFs only — scanned PDFs need OCR, which is not supported yet.</p>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            aria-label="PDF file to upload"
            className="w-full text-sm file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-slate-100 file:font-medium"
          />
          <button
            onClick={submitPdf}
            disabled={busy !== null}
            className="w-full px-4 py-2 rounded-lg bg-slate-800 text-white font-medium hover:bg-slate-900 disabled:opacity-40"
          >
            {busy === "pdf" ? "Extracting text…" : "Upload PDF"}
          </button>
        </div>
      </section>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded-lg px-4 py-3" role="status">
          {notice}
        </p>
      )}

      <p className="text-xs text-slate-500 max-w-3xl mx-auto text-center">
        Privacy note: your material and progress stay on this machine. If you configure an external LLM provider
        (see <code className="text-slate-600">.env.example</code>), pasted or uploaded material is sent to that
        provider for generation; without a key, everything runs locally with the deterministic demo provider.
      </p>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Your courses</h2>
        {courses === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : courses.length === 0 ? (
          <p className="text-sm text-slate-500 border rounded-xl bg-white px-4 py-6 text-center">
            No courses yet — load the bundled demo material above to try the full loop.
          </p>
        ) : (
          <ul className="space-y-2">
            {courses.map((c) => (
              <li key={c.id} className="bg-white border rounded-xl px-4 py-3 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-0">
                  <Link href={`/course/${c.id}`} className="font-medium hover:text-indigo-700 truncate block">
                    {c.title}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {c.sourceType} · created {new Date(c.createdAt).toLocaleString()} · provider: {c.providerUsed} ·
                    extraction quality: {c.quality.level}
                  </p>
                </div>
                <Link
                  href={`/course/${c.id}`}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
                >
                  Open
                </Link>
                {confirmDeleteId === c.id ? (
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-slate-600">Delete this course and all its progress?</span>
                    <button
                      onClick={() => void deleteCourse(c.id)}
                      disabled={busy !== null}
                      className="px-3 py-1.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-40"
                    >
                      {busy === "delete-" + c.id ? "Deleting…" : "Yes, delete"}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      disabled={busy !== null}
                      className="px-3 py-1.5 rounded-lg border text-sm hover:bg-slate-50 disabled:opacity-40"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(c.id)}
                    disabled={busy !== null}
                    className="px-3 py-1.5 rounded-lg border text-sm hover:bg-slate-50 disabled:opacity-40"
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
