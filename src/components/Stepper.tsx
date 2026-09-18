import Link from "next/link";

const STEPS = [
  { key: "material", label: "Material", href: (courseId: string) => `/course/${courseId}` },
  { key: "diagnostic", label: "Diagnostic", href: (courseId: string) => `/course/${courseId}/diagnostic` },
  { key: "practice", label: "Practice", href: (courseId: string) => `/course/${courseId}/practice` },
  { key: "mock", label: "Mock Exam", href: (courseId: string) => `/course/${courseId}/mock` },
  { key: "readiness", label: "Readiness", href: (courseId: string) => `/course/${courseId}/readiness` },
] as const;

export function Stepper({ courseId, current }: { courseId: string; current: string }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <nav aria-label="Study workflow" className="flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
      {STEPS.map((step, i) => {
        const isCurrent = i === currentIdx;
        const isDone = i < currentIdx;
        return (
          <span key={step.key} className="flex items-center gap-x-1">
            {i > 0 && (
              <span aria-hidden="true" className="text-slate-300 mx-1">
                →
              </span>
            )}
            <Link
              href={step.href(courseId)}
              aria-current={isCurrent ? "step" : undefined}
              className={
                "px-3 py-1.5 rounded-full font-medium transition-colors " +
                (isCurrent
                  ? "bg-indigo-600 text-white"
                  : isDone
                    ? "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200")
              }
            >
              {isDone ? "✓ " : ""}
              {step.label}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
