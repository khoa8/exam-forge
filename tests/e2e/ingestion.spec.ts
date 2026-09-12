import { expect, test, type Page } from "@playwright/test";
import { buildEmptyPdf, buildTextPdf } from "./helpers/fixture-pdfs";

/**
 * Browser coverage for supported material paths:
 *   paste success / too short / unstructured honest failure
 *   text-PDF success / scanned-like PDF honest failure
 * plus deliberate, cancellable course deletion.
 * All content below is original, redistributable fixture text.
 */

const GOOD_TEXT = `# Plant Energy Notes
Photosynthesis is the process by which plants convert light energy into chemical energy.
Chlorophyll is the green pigment that absorbs light in plant leaves.
Cellular respiration is the process by which cells release energy stored in glucose.
The Calvin cycle is the set of chemical reactions that fix carbon dioxide into glucose.
Stomata are small pores on the underside of leaves that exchange gases.
Transpiration is the movement of water through a plant and its evaporation from leaves.`;

const UNSTRUCTURED_TEXT =
  "This is a little story about my ordinary day. I woke up late in the morning. " +
  "Then I had some coffee at the kitchen table. After that, I went outside for a short walk " +
  "near the old canal. It was calm and quiet there, and I enjoyed it a lot.";

async function expectStillOnHome(page: Page) {
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("adaptive exam coach");
}

test("paste ingestion creates a grounded course", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill(GOOD_TEXT);
  await page.getByLabel("Course title (optional)").fill("Plant Energy");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/course\/crs_/);
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
  await expect(page.getByText("Photosynthesis").first()).toBeVisible();
});

test("short paste fails honestly without creating a course", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill("Too short.");
  await page.getByRole("button", { name: "Create course" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByRole("alert").first()).toContainText(/at least 80 characters/i);
  await expectStillOnHome(page);
});

test("unstructured material fails honestly without fabricating concepts", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill(UNSTRUCTURED_TEXT);
  await page.getByRole("button", { name: "Create course" }).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(/concepts/i);
  await expectStillOnHome(page);
});

test("text-based PDF ingestion succeeds", async ({ page }) => {
  await page.goto("/");
  const pdf = buildTextPdf([
    "Photosynthesis is the process by which plants convert light energy into chemical energy.",
    "Chlorophyll is the green pigment that absorbs light in plant leaves.",
    "Cellular respiration is the process by which cells release energy stored in glucose.",
    "The Calvin cycle is the set of chemical reactions that fix carbon dioxide into glucose.",
    "Stomata are small pores on the underside of leaves that exchange gases.",
    "Transpiration is the movement of water through a plant and its evaporation from leaves.",
  ]);
  await page.getByLabel("PDF file to upload").setInputFiles({
    name: "plant-energy.pdf",
    mimeType: "application/pdf",
    buffer: pdf,
  });
  await page.getByRole("button", { name: "Upload PDF" }).click();
  await page.waitForURL(/\/course\/crs_/);
  await expect(page.getByRole("heading", { name: "Concepts from your material" })).toBeVisible();
});

test("scanned-like PDF fails honestly with no fabricated course", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("PDF file to upload").setInputFiles({
    name: "scanned.pdf",
    mimeType: "application/pdf",
    buffer: buildEmptyPdf(),
  });
  await page.getByRole("button", { name: "Upload PDF" }).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(alert).toContainText(/scanned or image-based|OCR/i);
  await expectStillOnHome(page);
});

test("course deletion is deliberate and cancellable", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill(GOOD_TEXT);
  await page.getByLabel("Course title (optional)").fill("Deletion Probe");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.goto("/");
  const item = page.locator("li", { has: page.getByRole("link", { name: "Deletion Probe" }) }).first();

  // First click only asks for confirmation.
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(item.getByRole("button", { name: /Yes, delete/i })).toBeVisible();
  await expect(item.getByRole("button", { name: "Cancel" })).toBeVisible();

  // Cancellation deletes nothing.
  await item.getByRole("button", { name: "Cancel" }).click();
  await expect(item.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await expect(item).toBeVisible();

  // Confirming removes the course and says so honestly.
  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await item.getByRole("button", { name: /Yes, delete/i }).click();
  await expect(page.getByRole("status")).toContainText(/Course deleted/i);
  await expect(page.getByRole("link", { name: "Deletion Probe" })).toHaveCount(0);
});
