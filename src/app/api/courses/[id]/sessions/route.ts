import { NextRequest, NextResponse } from "next/server";
import { startSessionBodySchema } from "@/lib/schemas";
import { getSessionView, startSession } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Request parsing boundary: malformed client JSON is a 4xx, not a server error.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  // Shape/type validation boundary: reject wrong root shape or field types
  // before any service call.
  const parsed = startSessionBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body: expected 'kind' (diagnostic, practice or mock) and optional string 'conceptId'." },
      { status: 400 },
    );
  }
  try {
    const session = startSession(id, parsed.data.kind, parsed.data.conceptId);
    const view = getSessionView(session.id);
    return NextResponse.json(view, { status: 201 });
  } catch (err) {
    const name = (err as Error).name;
    const status = name === "NotFoundError" ? 404 : name === "ConflictError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
