import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../../src/worker/keepalive";

const { createClientSpy } = vi.hoisted(() => ({ createClientSpy: vi.fn() }));
vi.mock("@supabase/supabase-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@supabase/supabase-js")>();
  return {
    ...actual,
    createClient: (...args: Parameters<typeof actual.createClient>) => {
      createClientSpy(...args);
      return actual.createClient(...args);
    },
  };
});

// Synthetic credentials only; exercise the real SDK's PostgREST request.
const token = "a1".repeat(32);
const projectUrl = "https://example.supabase.co";
const databaseKey = "sb_secret_synthetic_private_key";
const workerEnv = { EXAMFORGE_SUPABASE_URL: projectUrl, EXAMFORGE_KEEPALIVE_TOKEN: token };
let env: Record<string, string | undefined>;
let handler: (request: Request) => Promise<Response>;
let outbound = vi.fn<typeof fetch>();

async function loadFunction(name = "examforge-keepalive") {
  // Dynamic path keeps Deno-only entrypoints out of the app's TS program.
  const entrypoint = `../../supabase/functions/${name}/index.ts`;
  await import(entrypoint);
}

function request(init: RequestInit = {}, path = "/functions/v1/examforge-keepalive") {
  return new Request(`${projectUrl}${path}`, {
    method: "POST", headers: { "X-ExamForge-Keepalive-Token": token }, ...init,
  });
}

beforeEach(() => {
  vi.resetModules();
  createClientSpy.mockClear();
  env = {
    SUPABASE_URL: projectUrl, EXAMFORGE_SECRET_KEY: databaseKey,
    EXAMFORGE_KEEPALIVE_TOKEN: token,
    EXAMFORGE_PUBLISHABLE_KEY: "sb_publishable_synthetic_public_key",
    EXAMFORGE_ALLOWED_ORIGINS: "https://exam.kohalabs.com,https://examforge-beta.ka-labs.workers.dev",
  };
  outbound = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([]));
  vi.stubGlobal("fetch", outbound);
  vi.stubGlobal("Deno", {
    env: { get: (name: string) => env[name] },
    serve: (fn: typeof handler) => { handler = fn; },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dedicated maintenance function", () => {
  it.each([{ rows: [] }, { rows: [{ id: "synthetic-private-course-id" }] }])("makes one real SDK DB read and hides result $rows", async ({ rows }) => {
    await loadFunction();
    outbound.mockResolvedValue(Response.json(rows));
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(createClientSpy).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0];
    const query = new URL(String(url));
    expect(query.pathname).toBe("/rest/v1/ef_courses");
    expect([...query.searchParams]).toEqual([["select", "id"], ["limit", "1"]]);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("apikey")).toBe(databaseKey);
    expect(new Headers(init?.headers).get("cache-control")).toBe("no-cache");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([undefined, "", "wrong", "b2".repeat(32)])("rejects token %s before privileged access", async (supplied) => {
    await loadFunction();
    const response = await handler(request({ headers: supplied === undefined ? {} : { "X-ExamForge-Keepalive-Token": supplied } }));
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"Unauthorized."}');
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " ", "too-short", "A1".repeat(32)])("fails closed for configured token %s", async (configured) => {
    env.EXAMFORGE_KEEPALIVE_TOKEN = configured;
    await loadFunction();
    const response = await handler(request({ headers: configured ? { "X-ExamForge-Keepalive-Token": configured } : {} }));
    expect(response.status).toBe(503);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["SUPABASE_URL", "EXAMFORGE_SECRET_KEY"])("rejects incomplete %s", async (name) => {
    env[name] = " ";
    await loadFunction();
    expect((await handler(request())).status).toBe(503);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("rejects learner JWTs, browser origins, other methods and paths without querying", async () => {
    await loadFunction();
    expect((await handler(request({ headers: { Authorization: "Bearer synthetic-user-jwt" } }))).status).toBe(401);
    for (const origin of ["https://exam.kohalabs.com", "https://examforge-beta.ka-labs.workers.dev", "https://unlisted.example"]) {
      expect((await handler(request({ headers: { "X-ExamForge-Keepalive-Token": token, Origin: origin } }))).status).toBe(403);
    }
    for (const method of ["GET", "OPTIONS", "DELETE"]) expect((await handler(request({ method }))).status).toBe(405);
    expect((await handler(request({}, "/functions/v1/examforge-keepalive/other"))).status).toBe(404);
    expect(createClientSpy).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each(["rejected", "network", "invalid-response", "timeout"])("sanitizes DB failure: %s", async (mode) => {
    await loadFunction();
    const sensitive = `synthetic-private-db-error ${token} ${databaseKey}`;
    if (mode === "rejected") outbound.mockResolvedValue(Response.json({ message: sensitive, code: "XX000" }, { status: 500 }));
    if (mode === "network") outbound.mockRejectedValue(new Error(sensitive));
    if (mode === "invalid-response") outbound.mockResolvedValue(Response.json(null));
    if (mode === "timeout") outbound.mockRejectedValue(new DOMException(sensitive, "AbortError"));
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"Keepalive database query failed."}');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(token);
    expect(createClientSpy).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledTimes(1);
  });
});

describe("scheduled Worker", () => {
  it("awaits verified success using only the narrow token", async () => {
    let resolve!: (response: Response) => void;
    outbound.mockImplementation(() => new Promise((done) => { resolve = done; }));
    let completed = false;
    const pending = worker.scheduled(undefined, workerEnv).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    resolve(Response.json({ ok: true }));
    await pending;
    expect(outbound).toHaveBeenCalledTimes(1);
    const [url, init] = outbound.mock.calls[0];
    expect(String(url)).toBe(`${projectUrl}/functions/v1/examforge-keepalive`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-examforge-keepalive-token")).toBe(token);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("apikey")).toBe(false);
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(console.info).toHaveBeenCalledWith("ExamForge keepalive: database query succeeded.");
  });

  it.each([undefined, "", " ", "wrong", "b2".repeat(31)])("rejects missing/invalid token %s without networking", async (value) => {
    await expect(worker.scheduled(undefined, { ...workerEnv, EXAMFORGE_KEEPALIVE_TOKEN: value })).rejects.toThrow("configure EXAMFORGE_KEEPALIVE_TOKEN");
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "http://example.com", "https://user:password@example.com", "https://example.com/wrong", "https://example.com?key=secret", "https://example.com#fragment"])("rejects unsafe project origin %s", async (value) => {
    await expect(worker.scheduled(undefined, { ...workerEnv, EXAMFORGE_SUPABASE_URL: value })).rejects.toThrow("configure EXAMFORGE_SUPABASE_URL");
    expect(outbound).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503, 302, 204])("rejects HTTP %s without reading sensitive error bodies", async (status) => {
    const response = new Response(status === 204 ? null : `synthetic-private-error ${token}`, { status });
    const read = vi.spyOn(response, "json");
    outbound.mockResolvedValue(response);
    await expect(worker.scheduled(undefined, workerEnv)).rejects.toThrow(`maintenance HTTP ${status}`);
    expect(read).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it.each(["html", "json-invalid", "false", "extra-data"])("rejects false success %s", async (mode) => {
    const response = mode === "html" ? new Response("SPA shell") : mode === "json-invalid" ? new Response("broken", { headers: { "Content-Type": "application/json" } }) :
      Response.json(mode === "false" ? { ok: false } : { ok: true, rows: ["private"] });
    outbound.mockResolvedValue(response);
    await expect(worker.scheduled(undefined, workerEnv)).rejects.toThrow("invalid maintenance response");
    expect(console.info).not.toHaveBeenCalled();
  });

  it.each(["network", "timeout"])("rejects and sanitizes %s failure", async (mode) => {
    outbound.mockRejectedValue(mode === "network" ? new Error(`private-network-error ${token}`) : new DOMException(token, "AbortError"));
    await expect(worker.scheduled(undefined, workerEnv)).rejects.toThrow("network request failed or timed out");
    expect(console.info).not.toHaveBeenCalled();
  });

  it("propagates a function DB failure through the complete scheduled path", async () => {
    await loadFunction();
    const databaseFetch = vi.fn(async () => Response.json({ message: "synthetic-private-db-error" }, { status: 500 }));
    outbound.mockImplementation(async (url, init) => {
      if (String(url).includes("/functions/v1/")) return handler(new Request(url, init));
      return databaseFetch();
    });
    await expect(worker.scheduled(undefined, workerEnv)).rejects.toThrow("maintenance HTTP 503");
    expect(databaseFetch).toHaveBeenCalledTimes(1);
    expect(console.info).not.toHaveBeenCalled();
  });
});

describe("unchanged learner API boundary", () => {
  it.each(["https://exam.kohalabs.com", "https://examforge-beta.ka-labs.workers.dev"])("preserves health and CORS for %s without DB access", async (origin) => {
    await loadFunction("examforge");
    const response = await handler(new Request(`${projectUrl}/functions/v1/examforge/api/health`, { headers: { Origin: origin } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(outbound).not.toHaveBeenCalled();
    const options = await handler(new Request(`${projectUrl}/functions/v1/examforge/api/courses`, { method: "OPTIONS", headers: { Origin: origin } }));
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("rejects unlisted origins and absent/bad user JWTs without database access", async () => {
    await loadFunction("examforge");
    const apiUrl = `${projectUrl}/functions/v1/examforge/api/courses`;
    expect((await handler(new Request(apiUrl, { headers: { Origin: "https://unlisted.example" } }))).status).toBe(403);
    expect((await handler(new Request(apiUrl))).status).toBe(401);
    expect(outbound).not.toHaveBeenCalled();
    outbound.mockResolvedValue(Response.json({ message: "synthetic-invalid-jwt" }, { status: 401 }));
    expect((await handler(new Request(apiUrl, { headers: { Authorization: "Bearer synthetic-invalid-jwt" } }))).status).toBe(401);
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(String(outbound.mock.calls[0][0])).toContain("/auth/v1/user");
    expect(createClientSpy).toHaveBeenCalledTimes(1); // Only the public auth client.
  });

  it("keeps JWT verification on the learner function and exact Auth URLs", () => {
    const config = readFileSync("supabase/config.toml", "utf8");
    expect(config).toMatch(/\[functions\.examforge\]\s+verify_jwt = true/);
    expect(config).toMatch(/\[functions\.examforge-keepalive\]\s+verify_jwt = false/);
    expect(config).toContain('site_url = "https://exam.kohalabs.com"');
    expect(config).toContain("additional_redirect_urls = []");
  });
});
