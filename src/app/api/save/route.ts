import { NextResponse } from "next/server";
import { saveGeminiResult } from "@/lib/db";
import { validateGeminiResult } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { error: "Request body must be a JSON object." },
        { status: 400 }
      );
    }

    const pageNumber = (body as { page_number?: number }).page_number;

    if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber)) {
      return NextResponse.json(
        { error: "page_number must be an integer." },
        { status: 400 }
      );
    }

    const { page_number: _pageNumber, ...geminiPayload } =
      body as Record<string, unknown>;
    const geminiResult = validateGeminiResult(geminiPayload);
    await saveGeminiResult(pageNumber, geminiResult);

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
