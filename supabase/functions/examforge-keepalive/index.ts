import { createClient } from "@supabase/supabase-js";

function json(data: unknown, status: number) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
  });
}

Deno.serve(async (request) => {
  const path = new URL(request.url).pathname;
  if (path !== "/examforge-keepalive" && path !== "/functions/v1/examforge-keepalive") {
    return json({ error: "Not found." }, 404);
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  // This is server-to-server only; no browser CORS or learner JWT bypass.
  if (request.headers.has("origin")) return json({ error: "Origin is not allowed." }, 403);

  const expected = Deno.env.get("EXAMFORGE_KEEPALIVE_TOKEN");
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
    return json({ error: "Keepalive maintenance configuration is incomplete." }, 503);
  }
  const supplied = request.headers.get("x-examforge-keepalive-token");
  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) return json({ error: "Unauthorized." }, 401);

  // Compare fixed-size digests, avoiding a comparison of the token's prefix.
  const encoder = new TextEncoder();
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
  ]);
  const expectedBytes = new Uint8Array(expectedHash);
  const suppliedBytes = new Uint8Array(suppliedHash);
  let difference = 0;
  for (let i = 0; i < expectedBytes.length; i++) difference |= expectedBytes[i] ^ suppliedBytes[i];
  if (difference !== 0) return json({ error: "Unauthorized." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const secretKey = Deno.env.get("EXAMFORGE_SECRET_KEY");
  if (!url?.trim() || !secretKey?.trim()) {
    return json({ error: "Keepalive database configuration is incomplete." }, 503);
  }
  try {
    // Create privileged access only after dedicated maintenance authorization.
    const client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "Cache-Control": "no-cache" } },
    });
    const { data, error } = await client.from("ef_courses").select("id").limit(1).retry(false)
      .abortSignal(AbortSignal.timeout(10_000));
    if (error || !Array.isArray(data)) throw new Error();
    // [] is successful database activity. Never return IDs, counts or DB errors.
    return json({ ok: true }, 200);
  } catch {
    console.error("ExamForge keepalive: database query failed; check Supabase database configuration and availability.");
    return json({ error: "Keepalive database query failed." }, 503);
  }
});
