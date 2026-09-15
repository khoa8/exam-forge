import { NextRequest, NextResponse } from "next/server";
import { finishSession } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(finishSession(id));
  } catch (err) {
    const name = (err as Error).name;
    const status = name === "NotFoundError" ? 404 : name === "ConflictError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
