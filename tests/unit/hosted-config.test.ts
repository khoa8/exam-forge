import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { hostedConfigFromEnv, invalidHostedConfigNames } from "@/lib/hosted-config";

const validEnv = {
  VITE_SUPABASE_URL: "https://example.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "synthetic-public-test-key",
  VITE_TURNSTILE_SITE_KEY: "synthetic-site-key",
};

describe("hosted public configuration", () => {
  it("accepts all required values", () => {
    expect(invalidHostedConfigNames(hostedConfigFromEnv(validEnv))).toEqual([]);
  });

  it.each(Object.keys(validEnv) as Array<keyof typeof validEnv>)("rejects absent, empty and whitespace-only %s", (name) => {
    for (const value of [undefined, "", "  \t  "]) {
      const config = hostedConfigFromEnv({ ...validEnv, [name]: value });
      expect(invalidHostedConfigNames(config)).toEqual([name]);
    }
  });

  it("rejects a Supabase URL that cannot initialize the client", () => {
    expect(invalidHostedConfigNames(hostedConfigFromEnv({ ...validEnv, VITE_SUPABASE_URL: "not-a-url" })))
      .toEqual(["VITE_SUPABASE_URL"]);
  });

  it("reports multiple invalid names without exposing values", () => {
    const canary = "synthetic-key-do-not-print";
    const names = invalidHostedConfigNames(hostedConfigFromEnv({
      ...validEnv,
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: " ",
      VITE_TURNSTILE_SITE_KEY: canary,
    }));
    expect(names).toEqual(["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY"]);
    expect(names.join(", ")).not.toContain(canary);
  });

  it("rejects invalid configuration through the real hosted build command", () => {
    const result = spawnSync("npm", ["run", "build:hosted"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        VITE_SUPABASE_URL: "",
        VITE_SUPABASE_PUBLISHABLE_KEY: "",
        VITE_TURNSTILE_SITE_KEY: "",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    for (const name of Object.keys(validEnv)) expect(output).toContain(name);
    expect(output).not.toContain(validEnv.VITE_SUPABASE_PUBLISHABLE_KEY);
    expect(output).not.toContain(validEnv.VITE_TURNSTILE_SITE_KEY);
  });
});
