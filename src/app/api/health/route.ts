import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deliberately minimal: readiness probing only. No local paths, provider
// configuration details or material-derived information are exposed here.
export async function GET() {
  return NextResponse.json({ ok: true });
}
