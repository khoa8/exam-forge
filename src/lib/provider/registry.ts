import type { MaterialProvider, ProviderOutput } from "./index";
import { DemoProvider } from "./demo";
import { GlmProvider, getGlmConfigFromEnv } from "./glm";
import type { SourceType } from "../types";

/**
 * Provider registry. Priority:
 *   1. EXAMFORGE_PROVIDER=demo  → always the deterministic demo provider.
 *   2. EXAMFORGE_PROVIDER=glm   → GLM adapter (fails hard if unavailable).
 *   3. auto (default)           → GLM if a key is configured, else demo; on any
 *                                 GLM failure, fall back to demo with a notice.
 */

export type ProviderMode = "auto" | "demo" | "glm";

export function getProviderMode(): ProviderMode {
  const raw = (process.env.EXAMFORGE_PROVIDER || "auto").toLowerCase();
  return raw === "glm" ? "glm" : raw === "demo" ? "demo" : "auto";
}

export function resolveProvider(): { provider: MaterialProvider; mode: ProviderMode; fallback?: MaterialProvider } {
  const mode = getProviderMode();
  if (mode === "demo") return { provider: new DemoProvider(), mode };
  const glmConfig = getGlmConfigFromEnv();
  if (glmConfig) {
    const glm = new GlmProvider(glmConfig);
    if (mode === "glm") return { provider: glm, mode };
    return { provider: glm, mode, fallback: new DemoProvider() };
  }
  if (mode === "glm") {
    throw new Error(
      "EXAMFORGE_PROVIDER=glm but no API key configured. Set EXAMFORGE_LLM_API_KEY (see .env.example) or use the demo provider.",
    );
  }
  return { provider: new DemoProvider(), mode };
}

export interface GenerationOutcome extends ProviderOutput {
  fallbackNotice?: string;
}

export async function generateWithFallback(text: string, sourceType: SourceType): Promise<GenerationOutcome> {
  const resolved = resolveProvider();
  try {
    const output = await resolved.provider.generate(text, sourceType);
    return output;
  } catch (err) {
    if (resolved.fallback) {
      const demoOutput = await resolved.fallback.generate(text, sourceType);
      return {
        ...demoOutput,
        fallbackNotice: `The configured LLM provider (${resolved.provider.name}) failed (${
          (err as Error).message
        }). The deterministic demo provider was used instead.`,
      };
    }
    throw err;
  }
}
