import { NextRequest, NextResponse } from "next/server";
import { getCourseOverview } from "@/lib/service";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const overview = getCourseOverview(id);
    return NextResponse.json(overview);
  } catch (err) {
    const status = (err as Error).name === "NotFoundError" ? 404 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const deleted = db.deleteCourse(id);
  if (!deleted) return NextResponse.json({ error: "Course not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
