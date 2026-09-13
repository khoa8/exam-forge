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

const HEADINGS_WITHOUT_DEFINITIONS = `# Plant Water Notes

## Osmosis
Osmosis moves water across a semipermeable membrane toward the region of higher solute concentration.

## Turgor
Turgor pressure keeps soft plant stems firm and upright while the plant stays hydrated.

## Wilting
Wilting begins when water loss outpaces root uptake and cells lose their rigidity.

## Xylem
Xylem conduits lift water from the roots to the leaves through transpiration pull.`;

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

test("material without assessable structure fails honestly without creating a course", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill(HEADINGS_WITHOUT_DEFINITIONS);
  await page.getByLabel("Course title (optional)").fill("Water Notes Probe");
  await page.getByRole("button", { name: "Create course" }).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 20_000 });
  // The rejection names the real limitation: not enough grounded assessment
  // structure to enter the learning loop (no Diagnostic-eligible questions).
  await expect(alert).toContainText(/enough grounded assessment structure/i);
  await expect(alert).toContainText(/Diagnostic/i);
  await expectStillOnHome(page);

  // The course was never persisted.
  await page.reload();
  await expect(page.getByRole("link", { name: "Water Notes Probe" })).toHaveCount(0);
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

test("failed DELETE shows an honest error, never a success notice", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Study material").fill(GOOD_TEXT);
  await page.getByLabel("Course title (optional)").fill("Failed Delete Probe");
  await page.getByRole("button", { name: "Create course" }).click();
  await page.waitForURL(/\/course\/crs_/);
  await page.goto("/");
  const item = page.locator("li", { has: page.getByRole("link", { name: "Failed Delete Probe" }) }).first();

  // Make the DELETE endpoint fail at the network boundary.
  await page.route("**/api/courses/*", async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Simulated delete failure" }) });
      return;
    }
    await route.continue();
  });

  await item.getByRole("button", { name: "Delete", exact: true }).click();
  await item.getByRole("button", { name: /Yes, delete/i }).click();

  const alert = page.getByRole("alert").filter({ hasText: /Simulated delete failure/ });
  await expect(alert).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  // The course remains listed because deletion did not happen.
  await expect(item).toBeVisible();

  // The UI remains usable: confirming again with the interception removed succeeds.
  await page.unroute("**/api/courses/*");
  await item.getByRole("button", { name: /Yes, delete/i }).click();
  await expect(page.getByRole("status")).toContainText(/Course deleted/i);
});
