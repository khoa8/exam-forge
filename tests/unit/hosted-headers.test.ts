import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted static anti-framing policy", () => {
  it("ships a catch-all Workers Static Assets rule through Vite's public directory", () => {
    const wrangler = JSON.parse(readFileSync(resolve("wrangler.jsonc"), "utf8"));
    const vite = readFileSync(resolve("vite.hosted.config.ts"), "utf8");
    const headers = readFileSync(resolve("public/_headers"), "utf8");
    expect(wrangler.assets.directory).toBe("./dist-hosted");
    expect(wrangler.assets.not_found_handling).toBe("single-page-application");
    expect(vite).toContain('outDir: "dist-hosted"');
    expect(vite).not.toMatch(/publicDir\s*:/);
    expect(headers).toMatch(/^\/\*\s*$/m);
    expect(headers).toMatch(/^\s+Content-Security-Policy: frame-ancestors 'none'\s*$/m);
    expect(headers).toMatch(/^\s+X-Frame-Options: DENY\s*$/m);
  });
});
