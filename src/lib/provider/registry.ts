import type { MaterialProvider, ProviderOutput } from "./index";
import { ProviderError } from "./index";
import { DemoProvider } from "./demo";
import { GlmProvider, getGlmRawConfigFromEnv } from "./glm";
import type { SourceType } from "../types";

/**
 * Provider registry. Mode contract (EXAMFORGE_PROVIDER):
 *   1. demo → always the deterministic demo provider (no key, no network).
 *   2. glm  → the GLM adapter is REQUIRED: it must be configured with a key and
 *             must succeed; failures surface as actionable errors instead of
 *             silently substituting demo content.
 *   3. auto (default) → GLM if a key is configured, else demo; on any GLM
 *             failure (unavailable, misconfigured, rejected output) fall back
 *             to demo with a visible notice.
 * Invalid EXAMFORGE_PROVIDER values are rejected with an actionable error rather
 * than silently falling back to auto.
 */

export type ProviderMode = "auto" | "demo" | "glm";

export function getProviderMode(): ProviderMode {
  const raw = (process.env.EXAMFORGE_PROVIDER || "auto").trim().toLowerCase();
  if (raw === "glm") return "glm";
  if (raw === "demo") return "demo";
  if (raw === "auto" || raw === "") return "auto";
  throw new ProviderError(`Invalid EXAMFORGE_PROVIDER "${process.env.EXAMFORGE_PROVIDER}" — use one of: auto, demo, glm.`);
}

export function resolveProvider(): { provider: MaterialProvider; mode: ProviderMode; fallback?: MaterialProvider } {
  const mode = getProviderMode();
  if (mode === "demo") return { provider: new DemoProvider(), mode };
  const glmConfig = getGlmRawConfigFromEnv();
  if (glmConfig) {
    const glm = new GlmProvider(glmConfig);
    if (mode === "glm") return { provider: glm, mode };
    return { provider: glm, mode, fallback: new DemoProvider() };
  }
  if (mode === "glm") {
    throw new ProviderError(
      "EXAMFORGE_PROVIDER=glm but no API key configured. Set EXAMFORGE_LLM_API_KEY (see .env.example) or use EXAMFORGE_PROVIDER=demo.",
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
