import { createClient } from "@supabase/supabase-js";
import { HostedDb } from "../../../src/lib/hosted-db.ts";
import {
  HostedService,
  HostedConflictError,
  HostedMaterialNotViableError,
  HostedNotFoundError,
} from "../../../src/lib/hosted-service.ts";
import { ingestText } from "../../../src/lib/ingest.ts";
import { createCourseBodySchema, startSessionBodySchema, submitAnswerBodySchema } from "../../../src/lib/schemas.ts";
import { SAMPLE_MATERIAL, SAMPLE_MATERIAL_TITLE } from "../../../src/sample/material.ts";

const url = Deno.env.get("SUPABASE_URL");
const publishableKey = Deno.env.get("EXAMFORGE_PUBLISHABLE_KEY");
const secretKey = Deno.env.get("EXAMFORGE_SECRET_KEY");
const allowedOrigins = new Set((Deno.env.get("EXAMFORGE_ALLOWED_ORIGINS") ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
if (!url || !publishableKey || !secretKey) throw new Error("ExamForge database configuration is incomplete.");

function responseHeaders(origin: string | null) {
  const headers: Record<string, string> = {
    "Cache-Control": "private, no-store, max-age=0",
    Vary: "Origin, Authorization",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && allowedOrigins.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
  }
  return headers;
}

function json(data: unknown, status: number, origin: string | null) {
  return Response.json(data, { status, headers: responseHeaders(origin) });
}

async function parseJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 500_000) throw new Error("REQUEST_TOO_LARGE");
  if (!request.body) throw new Error("INVALID_JSON");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 500_000) {
      await reader.cancel();
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(merged)); } catch { throw new Error("INVALID_JSON"); }
}

const authClient = createClient(url, publishableKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (request) => {
  const origin = request.headers.get("origin");
  if (origin && !allowedOrigins.has(origin)) return json({ error: "Origin is not allowed." }, 403, origin);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders(origin) });
  const path = new URL(request.url).pathname.split("/examforge")[1] ?? "";
  if (request.method === "GET" && path === "/api/health") return json({ ok: true }, 200, origin);

  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return json({ error: "Your browser session is missing. Reload to start a new anonymous session." }, 401, origin);
  const { data: authData, error: authError } = await authClient.auth.getUser(bearer);
  if (authError || !authData.user) return json({ error: "Your browser session expired. Reload to sign in again." }, 401, origin);
  const service = new HostedService(new HostedDb(url, secretKey, authData.user.id));

  try {
    if (path === "/api/courses" && request.method === "GET") {
      return json({ courses: await service.listCourses() }, 200, origin);
    }
    if (path === "/api/courses" && request.method === "POST") {
      const body = await parseJson(request);
      const parsed = createCourseBodySchema.safeParse(body);
      if (!parsed.success || (body && typeof body === "object" && "sourceType" in body &&
        !["paste", "pdf"].includes(String((body as Record<string, unknown>).sourceType)))) {
        return json({ error: "Invalid course request." }, 400, origin);
      }
      const sourceType = parsed.data.sample ? "bundled" :
        (body as Record<string, unknown>).sourceType === "pdf" ? "pdf" : "paste";
      let text = parsed.data.sample ? SAMPLE_MATERIAL : parsed.data.text ?? "";
      const title = parsed.data.sample ? SAMPLE_MATERIAL_TITLE : parsed.data.title;
      if (title && title.length > 200) return json({ error: "Course title must be 200 characters or fewer." }, 400, origin);
      if (text.trim().length < 80) return json({ error: "Please provide at least 80 characters of study material." }, 400, origin);
      const warnings: string[] = [];
      if (parsed.data.truncated) warnings.push("Material was truncated to 200000 characters during PDF extraction.");
      if (text.length > 200_000) {
        text = text.slice(0, 200_000);
        warnings.push("Material was truncated to 200000 characters.");
      }
      if (sourceType === "pdf") warnings.push("Text was extracted in your browser. Figures, tables and columns may not survive extraction.");
      const ingested = ingestText(text);
      const created = await service.createCourse({
        text: ingested.text, sourceType, title, ingestionWarnings: [...warnings, ...ingested.warnings],
      });
      return json(created, 201, origin);
    }
    const courseMatch = path.match(/^\/api\/courses\/([^/]+)$/);
    if (courseMatch) {
      const courseId = decodeURIComponent(courseMatch[1]);
      if (request.method === "GET") return json(await service.getCourseOverview(courseId), 200, origin);
      if (request.method === "DELETE") {
        const deleted = await service.deleteCourse(courseId);
        return deleted ? json({ ok: true }, 200, origin) : json({ error: "Course not found" }, 404, origin);
      }
    }
    const startMatch = path.match(/^\/api\/courses\/([^/]+)\/sessions$/);
    if (startMatch && request.method === "POST") {
      const parsed = startSessionBodySchema.safeParse(await parseJson(request));
      if (!parsed.success) return json({ error: "Invalid session request." }, 400, origin);
      const session = await service.startSession(decodeURIComponent(startMatch[1]), parsed.data.kind, parsed.data.conceptId);
      return json(await service.getSessionView(session.id), 201, origin);
    }
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && request.method === "GET") {
      return json(await service.getSessionView(decodeURIComponent(sessionMatch[1])), 200, origin);
    }
    const answerMatch = path.match(/^\/api\/sessions\/([^/]+)\/answer$/);
    if (answerMatch && request.method === "POST") {
      const parsed = submitAnswerBodySchema.safeParse(await parseJson(request));
      if (!parsed.success) return json({ error: "Invalid answer request." }, 400, origin);
      return json(await service.answerQuestion(decodeURIComponent(answerMatch[1]), parsed.data.questionId, parsed.data.answer), 200, origin);
    }
    const finishMatch = path.match(/^\/api\/sessions\/([^/]+)\/finish$/);
    if (finishMatch && request.method === "POST") {
      return json(await service.finishSession(decodeURIComponent(finishMatch[1])), 200, origin);
    }
    return json({ error: "Not found" }, 404, origin);
  } catch (error) {
    if ((error as Error).message === "REQUEST_TOO_LARGE") return json({ error: "Request is too large." }, 413, origin);
    if ((error as Error).message === "INVALID_JSON") return json({ error: "Request body must be valid JSON." }, 400, origin);
    if (error instanceof HostedNotFoundError) return json({ error: error.message }, 404, origin);
    if (error instanceof HostedConflictError) return json({ error: error.message }, 409, origin);
    if (error instanceof HostedMaterialNotViableError) return json({ error: error.message }, 422, origin);
    if (/at most 10 courses per browser identity/i.test((error as Error).message)) {
      return json({ error: "This beta allows up to 10 courses in one browser. Delete a course to add another." }, 409, origin);
    }
    // Never log learner material, answers, evidence or raw database errors.
    console.error("ExamForge request failed", (error as Error).name);
    return json({ error: "ExamForge could not complete this request. Please try again." }, 500, origin);
  }
});
