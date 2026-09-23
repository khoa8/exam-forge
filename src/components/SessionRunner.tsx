"use client";

import { apiFetch } from "@/lib/api-client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { AnswerValue, ClientQuestion, GradeResult } from "@/lib/types";
import type { SessionView } from "@/lib/service";

/**
 * Shared session runner for diagnostic, practice and mock exams.
 *
 * First saved answer counts (no retry until the score improves) — the same rule
 * is enforced server-side. Diagnostic and practice reveal feedback immediately
 * after each save; mock exams defer all feedback until the exam is submitted.
 */

interface Props {
  initialView: SessionView;
  courseId: string;
}

export function SessionRunner({ initialView, courseId }: Props) {
  const [view, setView] = useState<SessionView>(initialView);
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<AnswerValue | null>(initialGiven(initialView, initialView.questions[0]?.id));
  // Grading feedback belongs to the question whose answer produced it. A save response can
  // land after the learner moved on (the navigator stays usable while a request is in
  // flight), and question-specific state must never be rendered under another question.
  const [feedback, setFeedback] = useState<{ questionId: string; result: GradeResult } | null>(null);
  const [busy, setBusy] = useState(false);
  // `questionId: null` marks a session-level error (finishing); a save error stays owned by
  // its question and reappears when the learner returns to it.
  const [error, setError] = useState<{ message: string; questionId: string | null } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const navRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const submitRef = useRef<HTMLButtonElement>(null);
  // The question currently on screen, readable from async response handlers. It is updated
  // in `goTo` — the only navigation path — rather than in an effect, so a response that
  // resolves in the same tick as a navigation still sees the question the learner moved to.
  const displayedQuestionIdRef = useRef<string | undefined>(initialView.questions[0]?.id);
  // A saved mock answer locks its question, so the control the learner just activated
  // stops being focusable. Hand focus to the next action instead of letting it fall back
  // to <body>. Consumed by the effect below once the refreshed view has been committed.
  const focusNextActionAfterSave = useRef(false);

  const questions = view.questions;
  const finished = view.session.status === "completed";
  const isMock = view.session.kind === "mock";
  const isDiagnostic = view.session.kind === "diagnostic";
  const current: ClientQuestion | undefined = questions[index];
  const isLast = index === questions.length - 1;
  const total = questions.length;
  const answeredCount = view.answeredCount;
  const currentSaved = current ? Boolean(view.givenAnswers[current.id]) : false;
  const currentRevealed = current && !isMock ? view.revealed[current.id] : undefined;
  const currentFeedback = current && feedback?.questionId === current.id ? feedback.result : null;
  const effectiveFeedback = currentFeedback ?? currentRevealed ?? null;
  const visibleError = error && (error.questionId === null || error.questionId === current?.id) ? error.message : null;
  const currentWithheld = current ? view.withheldQuestionIds.includes(current.id) : false;
  // Exactly one polite announcement per save. When grading feedback is rendered it is the
  // announcement, so the saved-answer notice stays visual-only; mock exams defer feedback
  // until submission, so there the saved-answer notice is the announcement.
  const announcesFeedback = effectiveFeedback !== null && !isMock;

  // Keep keyboard/screen-reader context on the question card whenever the runner appears
  // or moves to another question. Mounting the runner replaces the intro's start control
  // (and a finished runner is replaced by the results view), so without this the focused
  // control disappears and focus falls back to <body>. A passive refresh of the session
  // view does not change `index` and therefore never steals focus.
  useEffect(() => {
    cardRef.current?.focus();
  }, [index]);

  // Restore keyboard context after a mock answer is saved: continue at the next
  // unanswered question, or at the submit control once every question is answered.
  useEffect(() => {
    if (!focusNextActionAfterSave.current) return;
    focusNextActionAfterSave.current = false;
    const nextUnanswered = view.questions.findIndex((q) => !view.givenAnswers[q.id]);
    if (nextUnanswered < 0) submitRef.current?.focus();
    else navRefs.current[nextUnanswered]?.focus();
  }, [view]);

  async function saveAnswer() {
    if (!current || !draft || busy || currentSaved) return;
    const answeredQuestionId = current.id;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sessions/${view.session.id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: answeredQuestionId, answer: draft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit answer");
      }
      const data = (await res.json()) as { grade: GradeResult | null };
      if (data.grade) setFeedback({ questionId: answeredQuestionId, result: data.grade });
      const refreshed = (await (await apiFetch(`/api/sessions/${view.session.id}`)).json()) as SessionView;
      // Hand focus on only when the saved question is still the one on screen. If the
      // learner navigated away, the control they activated is gone and focus already moved
      // to the new question card, so this response must not move it again.
      if (
        isMock &&
        refreshed.givenAnswers[answeredQuestionId] &&
        displayedQuestionIdRef.current === answeredQuestionId
      ) {
        focusNextActionAfterSave.current = true;
      }
      setView(refreshed);
    } catch (err) {
      setError({ message: (err as Error).message, questionId: answeredQuestionId });
    } finally {
      setBusy(false);
    }
  }

  function goTo(newIndex: number) {
    displayedQuestionIdRef.current = questions[newIndex]?.id;
    setIndex(newIndex);
    setDraft(initialGiven(view, questions[newIndex]?.id));
  }

  async function finish() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/sessions/${view.session.id}/finish`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to finish session");
      }
      setView((await res.json()) as SessionView);
    } catch (err) {
      setError({ message: (err as Error).message, questionId: null });
    } finally {
      setBusy(false);
    }
  }

  if (finished) {
    return <Finished view={view} courseId={courseId} />;
  }

  const allAnswered = questions.length > 0 && questions.every((q) => Boolean(view.givenAnswers[q.id]));

  return (
    <div className="space-y-6">
      {/* Progress */}
      <div>
        <div className="flex items-center justify-between text-sm text-slate-600 mb-2">
          <span>
            Question {index + 1} of {total} · {answeredCount}/{total} saved
          </span>
          <span className="capitalize font-medium">
            {isMock ? "Mock exam" : view.session.kind}
          </span>
        </div>
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-600 rounded-full transition-all"
            style={{ width: `${Math.round((answeredCount / Math.max(total, 1)) * 100)}%` }}
          />
        </div>
      </div>

      {current && (
        <div
          ref={cardRef}
          tabIndex={-1}
          role="group"
          aria-label="Current question"
          className="bg-white border rounded-xl p-5 sm:p-6 space-y-5 focus:outline-hidden focus-visible:outline-2 focus-visible:outline-indigo-600"
        >
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full uppercase tracking-wide font-medium">{current.type}</span>
            {current.conceptName ? <span>Topic: {current.conceptName}</span> : null}
            <span className="ml-auto">{current.difficulty}</span>
          </div>

          {current.type === "truefalse" ? <p className="text-lg leading-relaxed">{current.statement}</p> : null}
          <p className="whitespace-pre-line text-lg leading-relaxed">{current.prompt}</p>

          <AnswerInput
            question={current}
            disabled={busy || currentSaved}
            value={currentSaved ? (view.givenAnswers[current.id] ?? null) : draft}
            onChange={(v) => {
              setDraft(v);
              setFeedback(null);
            }}
          />

          {currentSaved && (
            <p className="text-xs text-slate-500" role={announcesFeedback ? undefined : "status"}>
              Answer saved — first answers count, so this question is locked.
            </p>
          )}
          {currentWithheld && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
              This question is part of your active mock exam, so it stays locked here until you submit that exam.
            </p>
          )}
          {visibleError && (
            <p className="text-sm text-red-600" role="alert">
              {visibleError}
            </p>
          )}

          {announcesFeedback && effectiveFeedback ? <FeedbackPanel result={effectiveFeedback} /> : null}

          <div className="flex flex-wrap gap-3 justify-between items-center">
            <div className="flex gap-2">
              <button
                onClick={() => goTo(Math.max(index - 1, 0))}
                disabled={index === 0 || busy}
                className="px-4 py-2 rounded-lg border font-medium disabled:opacity-40"
              >
                ← Back
              </button>
              {!isMock && (
                <button
                  onClick={() => goTo(Math.min(index + 1, total - 1))}
                  disabled={isLast || busy}
                  className="px-4 py-2 rounded-lg border font-medium disabled:opacity-40"
                >
                  Skip →
                </button>
              )}
            </div>

            {isMock ? (
              <button
                // See "Check answer": the in-flight state must not disable the focused
                // control. Once saved the question is locked, and focus is handed to the
                // next action by the effect above.
                onClick={() => void saveAnswer()}
                disabled={!draft || currentSaved}
                aria-disabled={busy}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 aria-disabled:opacity-40"
              >
                {currentSaved ? "Saved ✓" : "Save answer"}
              </button>
            ) : effectiveFeedback ? (
              <button
                onClick={() => {
                  if (isDiagnostic) {
                    if (allAnswered) {
                      void finish();
                    } else {
                      const nextIdx = questions.findIndex((q, i) => i > index && !view.givenAnswers[q.id]);
                      if (nextIdx >= 0) {
                        goTo(nextIdx);
                      } else {
                        const firstUnanswered = questions.findIndex((q) => !view.givenAnswers[q.id]);
                        goTo(firstUnanswered >= 0 ? firstUnanswered : 0);
                      }
                    }
                  } else {
                    if (isLast) void finish();
                    else {
                      const nextIdx = questions.findIndex((q, i) => i > index && !view.givenAnswers[q.id]);
                      goTo(nextIdx >= 0 ? nextIdx : index + 1);
                    }
                  }
                }}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
              >
                {isDiagnostic
                  ? allAnswered
                    ? "Finish"
                    : questions.findIndex((q, i) => i > index && !view.givenAnswers[q.id]) >= 0
                      ? "Next question →"
                      : "Next unanswered →"
                  : isLast
                    ? "Finish"
                    : "Next question →"}
              </button>
            ) : (
              <button
                // Not natively disabled while the request is in flight: disabling the
                // control the learner just activated drops keyboard focus to <body>. The
                // button stays focusable and reports the temporary unavailability through
                // aria-disabled instead — which is not decoration, because `saveAnswer`'s
                // busy guard really does ignore activation until the request settles.
                onClick={() => void saveAnswer()}
                disabled={!draft || currentSaved}
                aria-disabled={busy}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-40 aria-disabled:opacity-40"
              >
                Check answer
              </button>
            )}
          </div>
        </div>
      )}

      {/* Question navigator */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Question navigator">
        {questions.map((q, i) => (
          <button
            key={q.id}
            ref={(el) => {
              navRefs.current[i] = el;
            }}
            onClick={() => goTo(i)}
            aria-current={i === index ? "step" : undefined}
            className={
              "w-9 h-9 rounded-lg text-sm font-medium border " +
              (i === index
                ? "bg-slate-800 text-white border-slate-800"
                : view.givenAnswers[q.id]
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "bg-white hover:bg-slate-50")
            }
            aria-label={`Go to question ${i + 1}`}
          >
            {i + 1}
          </button>
        ))}
      </div>

      {isMock && (
        <div className="border rounded-xl bg-white p-4">
          <button
            ref={submitRef}
            onClick={() => void finish()}
            disabled={busy || !allAnswered}
            className="w-full px-4 py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-40"
          >
            Submit exam &amp; see results
          </button>
          <p className="text-xs text-slate-500 mt-2 text-center">
            {allAnswered
              ? `All ${total} answers saved. Submit to grade the exam — feedback appears after submission.`
              : `Answer all ${total} questions to submit (${total - answeredCount} left). Feedback is shown after submission.`}
          </p>
        </div>
      )}

      {!isMock && allAnswered && (
        <div className="border rounded-xl bg-white p-4 text-center">
          <button
            onClick={() => void finish()}
            disabled={busy}
            className="px-6 py-3 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 disabled:opacity-40"
          >
            Finish &amp; see summary
          </button>
        </div>
      )}
    </div>
  );
}

function initialGiven(view: SessionView, questionId: string | undefined): AnswerValue | null {
  if (!questionId) return null;
  return view.givenAnswers[questionId] ?? null;
}

/**
 * Keyboard model for the custom radio groups.
 *
 * `role="radio"` inside `role="radiogroup"` promises the WAI-ARIA radio-group keyboard
 * behaviour: exactly one option is in the tab order (roving tabindex) and the arrow keys
 * move the selection. Tab and Space/Enter keep working; the roving tabindex only removes
 * the redundant per-option tab stops.
 */
function radioKeyDown(
  event: React.KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
  refs: { current: (HTMLButtonElement | null)[] },
  select: (index: number) => void,
) {
  const delta =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (delta === 0 || count === 0) return;
  event.preventDefault();
  const next = (index + delta + count) % count;
  refs.current[next]?.focus();
  select(next);
}

function AnswerInput({
  question,
  value,
  onChange,
  disabled,
}: {
  question: ClientQuestion;
  value: AnswerValue | null;
  onChange: (v: AnswerValue) => void;
  disabled: boolean;
}) {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const truthRefs = useRef<(HTMLButtonElement | null)[]>([]);

  if (question.type === "mcq" && question.options) {
    const options = question.options;
    const selectedIndex = options.findIndex((opt) => value?.type === "option" && value.optionId === opt.id);
    return (
      <div className="space-y-2" role="radiogroup" aria-label="Answer options">
        {options.map((opt, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={opt.id}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (selectedIndex < 0 && i === 0) ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange({ type: "option", optionId: opt.id })}
              onKeyDown={(e) =>
                radioKeyDown(e, i, options.length, optionRefs, (next) =>
                  onChange({ type: "option", optionId: options[next].id }),
                )
              }
              className={
                "w-full text-left px-4 py-3 rounded-lg border transition-colors " +
                (selected ? "border-indigo-600 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300")
              }
            >
              <span
                aria-hidden="true"
                className={"inline-block w-5 mr-2 font-medium " + (selected ? "text-indigo-600" : "text-slate-500")}
              >
                {selected ? "●" : "○"}
              </span>
              {opt.text}
            </button>
          );
        })}
      </div>
    );
  }
  if (question.type === "truefalse") {
    const values = [true, false];
    const selectedIndex = values.findIndex((v) => value?.type === "boolean" && value.value === v);
    return (
      <div className="flex gap-3" role="radiogroup" aria-label="True or false">
        {values.map((v, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={String(v)}
              ref={(el) => {
                truthRefs.current[i] = el;
              }}
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (selectedIndex < 0 && i === 0) ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange({ type: "boolean", value: v })}
              onKeyDown={(e) =>
                radioKeyDown(e, i, values.length, truthRefs, (next) => onChange({ type: "boolean", value: values[next] }))
              }
              className={
                "px-6 py-2.5 rounded-lg border font-medium " +
                (selected ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white hover:border-slate-300")
              }
            >
              {v ? "True" : "False"}
            </button>
          );
        })}
      </div>
    );
  }
  if (question.type === "short") {
    return (
      <input
        type="text"
        disabled={disabled}
        value={value?.type === "text" ? value.text : ""}
        onChange={(e) => onChange({ type: "text", text: e.target.value })}
        placeholder="Type the term…"
        aria-label="Your answer"
        className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:border-indigo-500"
      />
    );
  }
  return (
    <textarea
      disabled={disabled}
      rows={5}
      value={value?.type === "text" ? value.text : ""}
      onChange={(e) => onChange({ type: "text", text: e.target.value })}
      placeholder="Write your explanation in your own words…"
      aria-label="Your explanation"
      className="w-full px-4 py-2.5 rounded-lg border border-slate-300 focus:border-indigo-500"
    />
  );
}

export function FeedbackPanel({ result }: { result: GradeResult }) {
  return (
    <div
      role="status"
      className={
        "rounded-lg border p-4 space-y-2 " +
        (result.correct ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50")
      }
    >
      <p className={"font-semibold " + (result.correct ? "text-green-800" : "text-red-700")}>
        {result.correct ? "✓ Correct" : result.score > 0 && result.score < 1 ? "△ Partially correct" : "✗ Incorrect"}
      </p>
      <p className="text-sm leading-relaxed">{result.feedback}</p>
      {result.evidence.length > 0 && (
        <blockquote className="text-sm border-l-4 border-slate-300 pl-3 text-slate-600 italic">
          “{result.evidence[0].quote}”
          {result.evidence[0].section && <span className="not-italic"> — section: {result.evidence[0].section}</span>}
        </blockquote>
      )}
      {!result.correct && result.modelAnswer && (
        <p className="text-sm">
          <span className="font-medium">Model answer: </span>
          {result.modelAnswer}
        </p>
      )}
    </div>
  );
}

function Finished({ view, courseId }: { view: SessionView; courseId: string }) {
  const summary = view.summary;
  const kind = view.session.kind;
  const withheldCount = view.withheldQuestionIds.length;
  const scorePct = summary ? Math.round(summary.score * 100) : 0;
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Finishing or submitting replaces the runner, so the control that was activated is
  // gone. Focus the results heading instead of letting focus fall back to <body>.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const nextCta =
    kind === "diagnostic" ? (
      <Link
        href={`/course/${courseId}/practice`}
        className="px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
      >
        Practice your weakest topic →
      </Link>
    ) : kind === "practice" ? (
      <Link
        href={`/course/${courseId}`}
        className="px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
      >
        Back to dashboard
      </Link>
    ) : (
      <Link
        href={`/course/${courseId}/readiness`}
        className="px-4 py-2.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700"
      >
        See readiness dashboard →
      </Link>
    );

  return (
    <div className="space-y-6">
      <div className="bg-white border rounded-xl p-6 space-y-3">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold">
          {kind === "mock" ? "Mock exam results" : kind === "diagnostic" ? "Diagnostic complete" : "Practice complete"}
        </h2>
        {summary && (
          <div className="flex flex-wrap gap-6 items-center">
            <div className="text-4xl font-bold text-indigo-700">{scorePct}%</div>
            <div className="text-sm text-slate-600">
              {summary.correct}/{summary.totalQuestions} fully correct · {summary.answered}/{summary.totalQuestions} answered
              <br />
              <span className="text-xs">Internal estimate for this session — not a real exam score.</span>
            </div>
          </div>
        )}
        {summary && summary.perConcept.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-2">
            {summary.perConcept.map((c) => (
              <div key={c.conceptId} className="flex justify-between text-sm border rounded-lg px-3 py-2">
                <span>{c.conceptName}</span>
                <span className={c.correct === c.attempts ? "text-green-700" : "text-amber-700"}>
                  {c.correct}/{c.attempts}
                </span>
              </div>
            ))}
          </div>
        )}
        {withheldCount > 0 && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
            Feedback for {withheldCount} question{withheldCount > 1 ? "s" : ""} is hidden while your mock exam is in
            progress. Submit the mock exam to see the full results here.
          </p>
        )}
        <div className="pt-2">{nextCta}</div>
      </div>

      {view.review && (
        <div className="space-y-4">
          <h3 className="font-semibold text-lg">
            {withheldCount > 0 ? "Review questions" : "Review every question"}
          </h3>
          {view.review.map((item, i) => (
            <div key={item.question.id} className="bg-white border rounded-xl p-4 space-y-3">
              <p className="text-xs text-slate-500">
                Question {i + 1} · {item.question.conceptName} · {item.question.type}
              </p>
              <p className="whitespace-pre-line">{item.question.prompt}</p>
              {item.question.type === "truefalse" && <p className="text-sm">{item.question.statement}</p>}
              {item.result ? (
                <FeedbackPanel result={item.result} />
              ) : (
                <p className="text-sm text-slate-500">You did not answer this question.</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
