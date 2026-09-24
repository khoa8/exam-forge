export interface HostedConfig {
  supabaseUrl: string;
  publishableKey: string;
  turnstileSiteKey: string;
}

const requiredHostedConfig = [
  { field: "supabaseUrl", env: "VITE_SUPABASE_URL" },
  { field: "publishableKey", env: "VITE_SUPABASE_PUBLISHABLE_KEY" },
  { field: "turnstileSiteKey", env: "VITE_TURNSTILE_SITE_KEY" },
] as const;

export function hostedConfigFromEnv(env: Record<string, string | undefined>): HostedConfig {
  return {
    supabaseUrl: env.VITE_SUPABASE_URL ?? "",
    publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
    turnstileSiteKey: env.VITE_TURNSTILE_SITE_KEY ?? "",
  };
}

export function invalidHostedConfigNames(config: Partial<HostedConfig> | undefined): string[] {
  return requiredHostedConfig.flatMap(({ field, env }) => {
    const value = config?.[field];
    if (typeof value !== "string" || !value.trim()) return [env];
    if (field === "supabaseUrl") {
      try {
        const url = new URL(value);
        if (!(["http:", "https:"].includes(url.protocol) && url.hostname)) return [env];
      } catch {
        return [env];
      }
    }
    return [];
  });
}
