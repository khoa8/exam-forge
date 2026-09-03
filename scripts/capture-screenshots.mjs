/**
 * Captures real screenshots of the running app for the README.
 * Usage: node scripts/capture-screenshots.mjs  (expects the app on localhost:3000)
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const OUT = "docs/screenshots";

/** Click and wait for SPA navigation, retrying while React hydration completes. */
async function clickAndNavigate(page, locator, urlPattern, attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    try {
      await locator.click({ timeout: 2000 });
      await page.waitForURL(urlPattern, { timeout: 4000 });
      return;
    } catch {
      // not hydrated yet or navigation still pending — retry
    }
  }
  throw new Error(`Navigation to ${urlPattern} failed after ${attempts} attempts`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  // 1. Home / material hub
  await page.goto(BASE + "/");
  await page.waitForSelector("text=Load bundled demo material");
  await page.screenshot({ path: `${OUT}/01-home.png`, fullPage: true });

  // 2. Load the bundled sample -> course dashboard
  await clickAndNavigate(page, page.getByRole("button", { name: /load bundled demo material/i }), /\/course\/crs_/);
  await page.waitForSelector("text=Concepts from your material");
  await page.screenshot({ path: `${OUT}/02-course-dashboard.png`, fullPage: true });

  // 3. Diagnostic with immediate feedback
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/);
  await page.waitForSelector("text=Question 1 of");
  // Answer the first question to capture the feedback state.
  const radio = page.getByRole("radio").first();
  if (await radio.isVisible().catch(() => false)) await radio.click();
  else {
    const tf = page.getByRole("button", { name: "True", exact: true });
    if (await tf.isVisible().catch(() => false)) await tf.click();
    else await page.getByPlaceholder(/type the term/i).fill("memory");
  }
  await page.getByRole("button", { name: /check answer/i }).click();
  await page.waitForSelector("text=/✓ Correct|✗ Incorrect|△ Partially/");
  await page.screenshot({ path: `${OUT}/03-diagnostic-feedback.png`, fullPage: true });

  // 4. Mock exam question
  const courseId = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`${BASE}/course/${courseId}/mock`);
  await page.getByRole("button", { name: /start mock exam/i }).click();
  await page.waitForURL(/session=/);
  await page.waitForSelector("text=Question 1 of");
  await page.screenshot({ path: `${OUT}/04-mock-exam.png`, fullPage: true });

  // 5. Answer all mock questions and capture results.
  for (let i = 1; i <= 12; i++) {
    const nav = page.getByRole("button", { name: `Go to question ${i}` });
    if (!(await nav.isVisible().catch(() => false))) break;
    await nav.click();
    const saved = await page.getByText(/Answer saved — first answers count/i).isVisible().catch(() => false);
    if (!saved) {
      const r = page.getByRole("radio").first();
      if (await r.isVisible().catch(() => false)) await r.click();
      else {
        const tf = page.getByRole("button", { name: "True", exact: true });
        if (await tf.isVisible().catch(() => false)) await tf.click();
        else if (await page.getByPlaceholder(/type the term/i).isVisible().catch(() => false))
          await page.getByPlaceholder(/type the term/i).fill("memory");
        else await page.getByPlaceholder(/write your explanation/i).fill("Memory involves encoding, storage and retrieval.");
      }
      await page.getByRole("button", { name: /save answer/i }).click();
      await page.waitForSelector("text=Answer saved — first answers count");
    }
  }
  await page.getByRole("button", { name: /submit exam & see results/i }).click();
  await page.waitForSelector("text=Mock exam results");
  await page.screenshot({ path: `${OUT}/05-mock-results.png`, fullPage: true });

  // 6. Readiness dashboard
  await page.getByRole("link", { name: /see readiness dashboard/i }).click();
  await page.waitForSelector("text=What to study next, in order");
  await page.screenshot({ path: `${OUT}/06-readiness.png`, fullPage: true });

  // 7. Practice picker
  const courseId2 = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`${BASE}/course/${courseId2}/practice`);
  await page.waitForSelector("text=Start practice →");
  await page.screenshot({ path: `${OUT}/07-practice-picker.png`, fullPage: true });

  // 8. Mobile layout of the dashboard
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(page.url().replace(/\/practice.*/, ""));
  await mobile.waitForSelector("text=Concepts from your material");
  await mobile.screenshot({ path: `${OUT}/08-mobile-dashboard.png`, fullPage: false });

  await browser.close();
  console.log("Screenshots written to", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
