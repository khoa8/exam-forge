import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface HostedConfig {
  supabaseUrl: string;
  publishableKey: string;
  turnstileSiteKey: string;
}

declare global {
  interface Window {
    __EXAMFORGE_HOSTED__?: HostedConfig;
  }
}

let hostedClient: SupabaseClient | null = null;

export function isHosted(): boolean {
  return typeof window !== "undefined" && Boolean(window.__EXAMFORGE_HOSTED__);
}

export function getHostedClient(): SupabaseClient {
  const config = window.__EXAMFORGE_HOSTED__;
  if (!config) throw new Error("Hosted ExamForge is not configured.");
  if (!hostedClient) hostedClient = createClient(config.supabaseUrl, config.publishableKey);
  return hostedClient;
}

/** The local Next app keeps its existing same-origin API. The hosted SPA calls
 * the authenticated Supabase Edge Function with the browser's anonymous JWT. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!isHosted()) return fetch(path, init);
  const config = window.__EXAMFORGE_HOSTED__!;
  const client = getHostedClient();
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    return Response.json({ error: "Your browser session is unavailable. Reload to start a new anonymous session." }, { status: 401 });
  }
  const headers = new Headers(init?.headers);
  headers.set("apikey", config.publishableKey);
  headers.set("Authorization", `Bearer ${data.session.access_token}`);
  return fetch(`${config.supabaseUrl}/functions/v1/examforge${path}`, {
    ...init, headers, cache: "no-store",
  });
}
