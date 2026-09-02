import { NextRequest, NextResponse } from "next/server";
import { getSessionView } from "@/lib/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json(getSessionView(id));
  } catch (err) {
    const status = (err as Error).name === "NotFoundError" ? 404 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
