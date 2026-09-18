/**
 * Honest notice shown while a mock exam is active.
 *
 * Course-level mastery/readiness exclude the questions an unsubmitted mock protects, so
 * those signals legitimately change until the mock is submitted. The notice keeps that
 * visible instead of letting concepts silently look untested.
 */
export function MockProtectionNotice({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2" role="status">
      A mock exam is in progress. Its questions are excluded from mastery and readiness here until you submit it.
    </p>
  );
}
