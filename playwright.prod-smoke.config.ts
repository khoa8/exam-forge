import { defineConfig } from "@playwright/test";
import { e2eServerEnv } from "./tests/e2e/helpers/e2e-env";

/**
 * Production smoke suite: verifies the production build starts, serves the
 * health endpoint, loads the home page and can enter the real learning path
 * with the bundled demo. Run via `npm run test:smoke:prod` (which builds
 * first). Uses its own loopback-only server on a dedicated port and a
 * disposable database, like the canonical browser suite.
 */

const PORT = 3200;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/prod-smoke.spec.ts",
  timeout: 60_000,
  retries: 1,
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx next start --hostname 127.0.0.1 -p ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    env: e2eServerEnv(),
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
