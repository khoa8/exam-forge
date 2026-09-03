/** UX probe: exercises error/empty/responsive states and reports what it finds. */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:3000";

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const findings = [];

  // 1. Nonexistent course -> friendly error?
  await page.goto(BASE + "/course/crs_doesnotexist");
  await page.waitForTimeout(1500);
  const hasError = await page.getByText(/not found/i).isVisible().catch(() => false);
  findings.push(`unknown course page shows error: ${hasError}`);

  // 2. Empty state on fresh profile is covered by the e2e test; here check the
  //    paste validation path.
  await page.goto(BASE + "/");
  await page.waitForSelector("text=Create course");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForTimeout(600);
  findings.push(`short-paste shows validation error: ${await page.getByText(/at least 80 characters/i).isVisible().catch(() => false)}`);

  // 3. Paste a small honest-but-poor material -> quality warning + no crash.
  await page.getByRole("button", { name: "Create course" }).click();
  await page.getByPlaceholder(/paste lecture notes/i).fill(
    "Water is wet. Ice is cold. Fire is hot. Rain falls down. Snow is white. Hail is ice.",
  );
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/course\/crs_/, { timeout: 15_000 });
  await page.waitForSelector("text=Concepts from your material", { timeout: 15_000 });
  const poorNote = await page.getByText(/Only \d+ concepts|could not reliably identify/i).isVisible().catch(() => false);
  findings.push(`poor material surfaces honest quality note: ${poorNote}`);

  // 4. Practice on this poor course — does it still work?
  await page.getByRole("link", { name: "Practice", exact: true }).first().click();
  await page.waitForTimeout(1000);
  const practiceButtons = await page.getByRole("button", { name: /start practice/i }).count();
  findings.push(`poor course offers ${practiceButtons} practice topics`);

  // 5. Diagnostic on poor course end-to-end.
  await page.goto(page.url().replace(/\/practice.*/, "/diagnostic"));
  await page.waitForTimeout(800);
  const startBtn = page.getByRole("button", { name: /start diagnostic/i });
  if (await startBtn.isVisible().catch(() => false)) {
    await startBtn.click();
    try {
      await page.waitForSelector("text=/Question 1 of|No questions available|No practice/", { timeout: 10_000 });
      const body = await page.textContent("body");
      findings.push(
        `poor-course diagnostic: ${/Question 1 of/.test(body ?? "") ? "started" : (body ?? "").match(/No questions[^.]*/)?.[0] ?? "unclear"}`,
      );
    } catch {
      findings.push("poor-course diagnostic: TIMEOUT — possible broken state");
    }
  }

  // 6. Keyboard accessibility on an MCQ.
  await page.goto(BASE + "/");
  await page.waitForSelector("text=Load bundled demo material");
  await page.getByRole("button", { name: /load bundled demo material/i }).click();
  await page.waitForURL(/\/course\/crs_/, { timeout: 20_000 });
  await page.getByRole("link", { name: "Diagnostic" }).click();
  await page.getByRole("button", { name: /start diagnostic/i }).click();
  await page.waitForURL(/session=/, { timeout: 20_000 });
  await page.waitForSelector("text=Question 1 of", { timeout: 20_000 });
  const radio = page.getByRole("radio").first();
  if (await radio.isVisible().catch(() => false)) {
    await radio.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(300);
    const selected = await page.getByRole("radio", { checked: true }).count();
    findings.push(`keyboard space toggles MCQ option: ${selected > 0}`);
  }

  console.log(findings.join("\n"));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
