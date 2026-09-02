import { NextRequest, NextResponse } from "next/server";
import { getSessionView, startSession } from "@/lib/service";
import type { SessionKind } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json().catch(() => ({}))) as { kind?: string; conceptId?: string };
    const kind = body.kind as SessionKind;
    if (!["diagnostic", "practice", "mock"].includes(kind)) {
      return NextResponse.json({ error: "kind must be diagnostic, practice or mock" }, { status: 400 });
    }
    const session = startSession(id, kind, body.conceptId);
    const view = getSessionView(session.id);
    return NextResponse.json(view, { status: 201 });
  } catch (err) {
    const name = (err as Error).name;
    const status = name === "NotFoundError" ? 404 : name === "ConflictError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
