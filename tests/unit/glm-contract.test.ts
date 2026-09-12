import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GlmProvider, getGlmRawConfigFromEnv, validateGlmConfig } from "@/lib/provider/glm";
import { getProviderMode, generateWithFallback, resolveProvider } from "@/lib/provider/registry";
import { SAMPLE_MATERIAL } from "@/sample/material";
import { ProviderError } from "@/lib/provider";

/**
 * Deterministic provider contract tests: request mapping, response/failure
 * handling and configuration validation — all against a local HTTP stub, so
 * normal CI needs no external provider, key or network.
 */

const KEY = "test-key-not-real";

const SOURCE = `Photosynthesis is the process by which plants convert light energy into chemical energy. Chlorophyll is the green pigment that absorbs light in plant leaves. Cellular respiration is the process by which cells release energy stored in glucose.`;

function groundedResponse() {
  const PHOTO_QUOTE = "Photosynthesis is the process by which plants convert light energy into chemical energy.";
  const CHLORO_QUOTE = "Chlorophyll is the green pigment that absorbs light in plant leaves.";
  const RESPIRATION_QUOTE = "Cellular respiration is the process by which cells release energy stored in glucose.";
  return {
    title: "Plant Biology",
    concepts: [
      { name: "Photosynthesis", description: PHOTO_QUOTE, evidenceQuote: PHOTO_QUOTE, importance: 1 },
      { name: "Chlorophyll", description: CHLORO_QUOTE, evidenceQuote: CHLORO_QUOTE, importance: 0.8 },
      { name: "Cellular respiration", description: RESPIRATION_QUOTE, evidenceQuote: RESPIRATION_QUOTE, importance: 0.7 },
    ],
    questions: [
      {
        conceptName: "Photosynthesis",
        type: "mcq",
        prompt: "According to the material, what is Photosynthesis?",
        options: [
          "process by which cells release energy stored in glucose",
          "process by which plants convert light energy into chemical energy",
          "green pigment that absorbs light in plant leaves",
        ],
        correctOption: 1,
        evidenceQuote: PHOTO_QUOTE,
        difficulty: "easy",
      },
      {
        conceptName: "Chlorophyll",
        type: "truefalse",
        prompt: "According to the material, is this statement true or false?",
        statement: CHLORO_QUOTE,
        correctAnswer: true,
        evidenceQuote: CHLORO_QUOTE,
        difficulty: "easy",
      },
      {
        conceptName: "Cellular respiration",
        type: "short",
        prompt: "Fill in the blank according to the material.",
        modelAnswer: "Cellular respiration",
        acceptedAnswers: ["Cellular respiration"],
        evidenceQuote: RESPIRATION_QUOTE,
        difficulty: "medium",
      },
    ],
  };
}

interface StubOptions {
  status?: number;
  body?: string;
  delayMs?: number;
}

let server: Server | null = null;
let lastRequest: { url?: string; method?: string; auth?: string; json?: unknown } = {};

beforeEach(() => {
  server = null;
  lastRequest = {};
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function startStub(options: StubOptions): Promise<string> {
  await new Promise<void>((resolve) => {
    server = createServer((req: IncomingMessage, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        lastRequest = {
          url: req.url,
          method: req.method,
          auth: req.headers.authorization,
          json: raw ? JSON.parse(raw) : undefined,
        };
        const respond = () => {
          res.writeHead(options.status ?? 200, { "Content-Type": "application/json" });
          res.end(options.body ?? JSON.stringify({ choices: [{ message: { content: JSON.stringify(groundedResponse()) } }] }));
        };
        if (options.delayMs) setTimeout(respond, options.delayMs);
        else respond();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function providerAt(baseUrl: string, timeoutMs: string | number = 5000): GlmProvider {
  return new GlmProvider({ apiKey: KEY, baseUrl, model: "glm-test", timeoutMs });
}

describe("GLM adapter request mapping", () => {
  it("sends the model, system prompt and nonce-wrapped untrusted material to the configured endpoint", async () => {
    const baseUrl = await startStub({});
    const output = await providerAt(baseUrl).generate(SOURCE, "paste");

    expect(lastRequest.method).toBe("POST");
    expect(lastRequest.url).toBe("/chat/completions");
    expect(lastRequest.auth).toBe(`Bearer ${KEY}`);
    const body = lastRequest.json as { model: string; messages: { role: string; content: string }[] };
    expect(body.model).toBe("glm-test");
    expect(body.messages[0].role).toBe("system");
    const userContent = body.messages[1].content;
    expect(userContent).toContain("BEGIN UNTRUSTED STUDY MATERIAL");
    expect(userContent).toContain("END OF UNTRUSTED STUDY MATERIAL");
    expect(userContent).toContain(SOURCE.slice(0, 40));
    // Valid output is mapped and grounded.
    expect(output.provider).toBe("glm:glm-test");
    expect(output.questions).toHaveLength(3);
  }, 15_000);

  it("keeps the API key out of provider error messages", async () => {
    const baseUrl = await startStub({ status: 500, body: "{}" });
    const err = await providerAt(baseUrl).generate(SOURCE, "paste").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).message).not.toContain(KEY);
  }, 15_000);

  it("rejects malformed JSON model responses", async () => {
    const baseUrl = await startStub({ body: JSON.stringify({ choices: [{ message: { content: '{ "broken": json,,, }' } }] }) });
    await expect(providerAt(baseUrl).generate(SOURCE, "paste")).rejects.toThrow(/not valid JSON/i);
  }, 15_000);

  it("rejects empty responses", async () => {
    const baseUrl = await startStub({ body: JSON.stringify({ choices: [{ message: { content: "" } }] }) });
    await expect(providerAt(baseUrl).generate(SOURCE, "paste")).rejects.toThrow(/empty response/i);
    const emptyChoices = await startStub({ body: JSON.stringify({ choices: [] }) });
    await expect(providerAt(emptyChoices).generate(SOURCE, "paste")).rejects.toThrow(/empty response/i);
  }, 15_000);

  it("reports timeouts as provider errors", async () => {
    const baseUrl = await startStub({ delayMs: 3000 });
    await expect(providerAt(baseUrl, 1000).generate(SOURCE, "paste")).rejects.toThrow(/timed out after 1000ms/i);
  }, 15_000);
});

describe("provider configuration validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.EXAMFORGE_LLM_API_KEY;
    delete process.env.GLM_API_KEY;
    delete process.env.EXAMFORGE_LLM_BASE_URL;
    delete process.env.EXAMFORGE_LLM_MODEL;
    delete process.env.EXAMFORGE_LLM_TIMEOUT_MS;
    delete process.env.EXAMFORGE_PROVIDER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null config when no key is configured", () => {
    expect(getGlmRawConfigFromEnv()).toBeNull();
  });

  it("validates base URL, model and timeout with actionable errors", () => {
    expect(() => validateGlmConfig({ apiKey: KEY, baseUrl: "not a url", model: "m", timeoutMs: "30000" })).toThrow(
      /EXAMFORGE_LLM_BASE_URL.*absolute http\(s\) URL/,
    );
    expect(() => validateGlmConfig({ apiKey: KEY, baseUrl: "ftp://example.com", model: "m", timeoutMs: "30000" })).toThrow(
      /protocol must be http or https/,
    );
    expect(() => validateGlmConfig({ apiKey: KEY, baseUrl: "https://example.com", model: "  ", timeoutMs: "30000" })).toThrow(
      /EXAMFORGE_LLM_MODEL is empty/,
    );
    expect(() => validateGlmConfig({ apiKey: KEY, baseUrl: "https://example.com", model: "m", timeoutMs: "soon" })).toThrow(
      /EXAMFORGE_LLM_TIMEOUT_MS.*integer between 1000 and 300000/,
    );
    expect(() => validateGlmConfig({ apiKey: KEY, baseUrl: "https://example.com", model: "m", timeoutMs: 200 })).toThrow(
      /EXAMFORGE_LLM_TIMEOUT_MS.*integer between 1000 and 300000/,
    );
    // Valid configuration is normalized; the key never appears in error paths.
    const ok = validateGlmConfig({ apiKey: KEY, baseUrl: "https://example.com/api/v4/", model: " m1 ", timeoutMs: "2500" });
    expect(ok).toEqual({ apiKey: KEY, baseUrl: "https://example.com/api/v4", model: "m1", timeoutMs: 2500 });
  });

  it("rejects an invalid provider mode with an actionable error", () => {
    process.env.EXAMFORGE_PROVIDER = "gpt4";
    expect(getProviderMode).toThrow(/Invalid EXAMFORGE_PROVIDER "gpt4"/);
    expect(() => resolveProvider()).toThrow(/use one of: auto, demo, glm/);
  });

  it("falls back to demo with an actionable notice when auto-mode GLM config is invalid", async () => {
    process.env.EXAMFORGE_LLM_API_KEY = KEY;
    process.env.EXAMFORGE_LLM_TIMEOUT_MS = "not-a-number";
    const outcome = await generateWithFallback(SAMPLE_MATERIAL, "bundled");
    expect(outcome.provider).toBe("demo");
    expect(outcome.fallbackNotice).toMatch(/EXAMFORGE_LLM_TIMEOUT_MS/);
    expect(outcome.questions.length).toBeGreaterThan(10);
  }, 30_000);

  it("fails loudly instead of falling back when forced glm config is invalid", async () => {
    process.env.EXAMFORGE_PROVIDER = "glm";
    process.env.EXAMFORGE_LLM_API_KEY = KEY;
    process.env.EXAMFORGE_LLM_TIMEOUT_MS = "not-a-number";
    const err = await generateWithFallback(SAMPLE_MATERIAL, "bundled").catch((e: Error) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(/EXAMFORGE_LLM_TIMEOUT_MS/);
    expect((err as Error).message).not.toContain(KEY);
  }, 30_000);
});
