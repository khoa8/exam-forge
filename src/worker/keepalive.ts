interface KeepaliveEnv {
  EXAMFORGE_SUPABASE_URL?: string;
  EXAMFORGE_KEEPALIVE_TOKEN?: string;
}

// Assets-first routing serves matched assets/navigation directly. Other requests
// can reach this fallback; delegate them unchanged to Static Assets too.
const worker = {
  fetch(request: Request, env: { ASSETS: { fetch(request: Request): Promise<Response> } }): Promise<Response> {
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: unknown, env: KeepaliveEnv): Promise<void> {
    let project: URL;
    try {
      project = new URL(env.EXAMFORGE_SUPABASE_URL ?? "");
      if (project.protocol !== "https:" || project.username || project.password ||
        project.pathname !== "/" || project.search || project.hash) throw new Error();
    } catch {
      throw new Error("ExamForge keepalive: configure EXAMFORGE_SUPABASE_URL as an HTTPS project origin.");
    }
    const token = env.EXAMFORGE_KEEPALIVE_TOKEN;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error("ExamForge keepalive: configure EXAMFORGE_KEEPALIVE_TOKEN as 32 random bytes in lowercase hex.");
    }

    let response: Response;
    try {
      response = await fetch(new URL("/functions/v1/examforge-keepalive", project), {
        method: "POST",
        headers: { "X-ExamForge-Keepalive-Token": token },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("ExamForge keepalive: network request failed or timed out; check Supabase availability.");
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`ExamForge keepalive: maintenance HTTP ${response.status}; check function deployment, matching token and database configuration.`);
    }
    try {
      if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new Error();
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Object.keys(body).length !== 1 ||
        !("ok" in body) || body.ok !== true) throw new Error();
    } catch {
      throw new Error("ExamForge keepalive: invalid maintenance response; verify the deployed function endpoint.");
    } finally {
      await response.body?.cancel().catch(() => {});
    }
    console.info("ExamForge keepalive: database query succeeded.");
  },
};

export default worker;
