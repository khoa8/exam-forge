import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

describe("Cloudflare local runtime with repository asset routing", () => {
  let scratch: string;
  let runtime: Unstable_DevWorker;
  const token = "a1".repeat(32); // Synthetic local-only maintenance token.

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "examforge-worker-test-"));
    writeFileSync(join(scratch, "index.html"), '<!doctype html><title>Synthetic SPA</title><script src="/app.js"></script>');
    writeFileSync(join(scratch, "app.js"), "/* Synthetic static asset */");
    writeFileSync(join(scratch, "_headers"), readFileSync("public/_headers", "utf8"));
    vi.stubEnv("WRANGLER_LOG_PATH", scratch);
    vi.stubEnv("WRANGLER_SEND_METRICS", "false");
    const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
    const script = transpileModule(readFileSync("src/worker/keepalive.ts", "utf8"), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText;
    // Scope a synthetic fetch to this compiled test module; no external requests.
    // The first Cron call succeeds, the next fails. Browser requests must not consume it.
    const stub = `
      let calls = 0;
      async function fetch(url, init) {
        calls++;
        const headers = new Headers(init.headers);
        if (String(url) !== "https://example.supabase.co/functions/v1/examforge-keepalive" ||
          init.method !== "POST" || headers.get("x-examforge-keepalive-token") !== "${token}" ||
          headers.has("authorization") || headers.has("apikey")) throw new Error("Synthetic request mismatch.");
        return Response.json(calls === 1 ? {ok:true} : {error:"Synthetic failure."}, {status:calls === 1 ? 200 : 503});
      }
    `;
    const scriptPath = join(scratch, "worker.js");
    writeFileSync(scriptPath, stub + script);
    config.main = scriptPath;
    config.assets.directory = scratch;
    config.$schema = resolve("node_modules/wrangler/config-schema.json");
    const configPath = join(scratch, "wrangler.json");
    writeFileSync(configPath, JSON.stringify(config));
    runtime = await unstable_dev(scriptPath, {
      config: configPath, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
      logLevel: "none", persist: false, envFiles: [],
      vars: { EXAMFORGE_SUPABASE_URL: "https://example.supabase.co", EXAMFORGE_KEEPALIVE_TOKEN: token },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, testScheduled: true },
    });
  });

  afterAll(async () => {
    await runtime?.stop();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("preserves shell, deep links, assets, headers and static method handling without maintenance calls", async () => {
    for (const path of ["/", "/course/synthetic/diagnostic", "/app.js"]) {
      for (const headers of [{}, { "Sec-Fetch-Mode": "navigate" }]) {
        const response = await runtime.fetch(`http://localhost${path}`, { headers });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        const text = await response.text();
        expect(text).toContain(path === "/app.js" ? "Synthetic static asset" : "Synthetic SPA");
      }
    }
    const post = await runtime.fetch("http://localhost/course/synthetic", { method: "POST" });
    expect(post.status).toBe(405);
    await post.body?.cancel();
  });

  it("reports successful and failed Cron outcomes from the real scheduled handler", async () => {
    const successResponse = await runtime.fetch("http://localhost/cdn-cgi/local/scheduled?format=json");
    expect(successResponse.status).toBe(200);
    const success = await successResponse.json() as { outcome: string };
    expect(success.outcome).toBe("ok");
    const failureResponse = await runtime.fetch("http://localhost/cdn-cgi/local/scheduled?format=json");
    expect(failureResponse.status).toBe(500);
    const failure = await failureResponse.json() as { outcome: string };
    expect(failure.outcome).not.toBe("ok");
  });
});
