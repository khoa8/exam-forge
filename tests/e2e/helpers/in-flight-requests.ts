import type { Page } from "@playwright/test";

/**
 * Hold answer submissions open until `release()` is called, so the in-flight state can be
 * inspected deterministically instead of racing a request that is usually a few tens of
 * milliseconds on loopback. `reached` resolves once the first POST has been intercepted.
 *
 * Shared by the accessibility and delayed-response specs: both need the same deterministic
 * "answer request still in flight" window.
 */
export async function holdAnswerRequests(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let posts = 0;
  await page.route("**/api/sessions/*/answer", async (route) => {
    posts += 1;
    reached();
    await gate;
    await route.continue();
  });
  return { reached: intercepted, release, posts: () => posts };
}
