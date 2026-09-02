import { NextResponse } from "next/server";
import { getProviderMode } from "@/lib/provider/registry";
import { dbFilePath } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    providerMode: getProviderMode(),
    llmConfigured: Boolean(process.env.EXAMFORGE_LLM_API_KEY || process.env.GLM_API_KEY),
    dbPath: dbFilePath().replace(process.cwd(), "."),
  });
}
