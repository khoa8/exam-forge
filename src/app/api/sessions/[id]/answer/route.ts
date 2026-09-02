import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/service";
import { answerValueSchema } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = (await req.json()) as { questionId?: string; answer?: unknown };
    if (!body.questionId) {
      return NextResponse.json({ error: "questionId is required" }, { status: 400 });
    }
    const parsedAnswer = answerValueSchema.safeParse(body.answer);
    if (!parsedAnswer.success) {
      return NextResponse.json({ error: "Invalid answer format" }, { status: 400 });
    }
    const result = answerQuestion(id, body.questionId, parsedAnswer.data);
    return NextResponse.json(result);
  } catch (err) {
    const name = (err as Error).name;
    const status = name === "NotFoundError" ? 404 : name === "ConflictError" ? 409 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
