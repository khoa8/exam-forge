import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/service";
import { submitAnswerBodySchema } from "@/lib/schemas";

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
  // Shape/type validation boundary (canonical answerValueSchema included):
  // reject wrong root shape or field types before any service call.
  const parsed = submitAnswerBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request body: expected string 'questionId' and a valid 'answer'." },
      { status: 400 },
    );
  }
  try {
    const result = answerQuestion(id, parsed.data.questionId, parsed.data.answer);
    return NextResponse.json(result);
  } catch (err) {
    const name = (err as Error).name;
    const status = name === "NotFoundError" ? 404 : name === "ConflictError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
