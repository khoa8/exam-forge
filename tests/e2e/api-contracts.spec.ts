import { expect, test } from "@playwright/test";

/**
 * Honest API failure contracts at the request boundary:
 *  - malformed client JSON is a 4xx with a safe error body, never a 500;
 *  - malformed requests mutate no state (no course/attempt is created).
 */

test("malformed JSON to POST /api/courses returns 400 without creating a course", async ({ request }) => {
  const before = await request.get("/api/courses");
  const beforeBody = (await before.json()) as { courses: unknown[] };

  const res = await request.post("/api/courses", {
    headers: { "Content-Type": "application/json" },
    data: Buffer.from("{ this is not valid json", "utf-8"),
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/valid JSON/i);
  // No stack traces or parser internals are leaked.
  expect(JSON.stringify(body)).not.toMatch(/SyntaxError|position \d+|stack/i);

  const after = await request.get("/api/courses");
  const afterBody = (await after.json()) as { courses: unknown[] };
  expect(afterBody.courses.length).toBe(beforeBody.courses.length);
});

test("malformed JSON to POST /api/sessions/[id]/answer returns 400", async ({ request }) => {
  const res = await request.post("/api/sessions/ses_missing/answer", {
    headers: { "Content-Type": "application/json" },
    data: Buffer.from("not json at all", "utf-8"),
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { error: string };
  expect(body.error).toMatch(/valid JSON/i);
  expect(JSON.stringify(body)).not.toMatch(/SyntaxError|position \d+|stack/i);
});
