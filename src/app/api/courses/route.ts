import { NextRequest, NextResponse } from "next/server";
import { ingestPdf, ingestText } from "@/lib/ingest";
import { createCourse } from "@/lib/service";
import { SAMPLE_MATERIAL, SAMPLE_MATERIAL_TITLE } from "@/sample/material";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT_LENGTH = 200_000;

export async function GET() {
  const courses = db.listCourses().map((c) => ({
    id: c.id,
    title: c.title,
    sourceType: c.sourceType,
    createdAt: c.createdAt,
    providerUsed: c.providerUsed,
    quality: JSON.parse(c.qualityJson) as { level: string; notes: string[] },
  }));
  return NextResponse.json({ courses });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";

    let text = "";
    let title: string | undefined;
    let sourceType: "bundled" | "paste" | "pdf" = "paste";
    let warnings: string[] = [];

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      title = (form.get("title") as string) || undefined;
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "No PDF file provided." }, { status: 400 });
      }
      if (file.size > 20 * 1024 * 1024) {
        return NextResponse.json({ error: "PDF is larger than 20 MB." }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const ingested = await ingestPdf(buffer);
      text = ingested.text;
      warnings = ingested.warnings;
      sourceType = "pdf";
      if (!title) title = file.name.replace(/\.pdf$/i, "");
    } else {
      // Request parsing boundary: malformed client JSON is a 4xx, not a server error.
      let body: { sample?: boolean; text?: string; title?: string };
      try {
        body = (await req.json()) as { sample?: boolean; text?: string; title?: string };
      } catch {
        return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
      }
      if (body.sample) {
        text = SAMPLE_MATERIAL;
        sourceType = "bundled";
        title = title || SAMPLE_MATERIAL_TITLE;
      } else {
        text = (body.text ?? "").toString();
        title = body.title || undefined;
      }
    }

    if (!text || text.trim().length < 80) {
      // Surface the ingestion warning when it explains the failure (for example a
      // scanned PDF with no extractable text) instead of a generic message.
      const detail =
        sourceType === "pdf" && warnings.length > 0
          ? warnings.join(" ")
          : "Please provide at least 80 characters of study material.";
      return NextResponse.json({ error: detail }, { status: 400 });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH);
      warnings.push(`Material was truncated to ${MAX_TEXT_LENGTH} characters.`);
    }

    const ingested = ingestText(text);
    const warnings2 = [...warnings, ...ingested.warnings];

    const { courseId, course, conceptCount, questionCount } = await createCourse({
      text: ingested.text,
      sourceType,
      ingestionWarnings: warnings2,
      title,
    });

    return NextResponse.json({ courseId, course, conceptCount, questionCount }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create course.";
    console.error("[POST /api/courses]", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
