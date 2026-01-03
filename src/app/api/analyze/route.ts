import { NextResponse } from "next/server";
import { analyzeDocument } from "@/lib/analysis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function resolveMimeType(file: File) {
  if (file.type) {
    return file.type;
  }

  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (name.endsWith(".png")) {
    return "image/png";
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (name.endsWith(".webp")) {
    return "image/webp";
  }
  if (name.endsWith(".tif") || name.endsWith(".tiff")) {
    return "image/tiff";
  }
  if (name.endsWith(".gif")) {
    return "image/gif";
  }

  return "";
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing file." },
        { status: 400 }
      );
    }

    const mimeType = resolveMimeType(file).trim().toLowerCase();
    if (!mimeType) {
      return NextResponse.json(
        { error: "Unsupported file type." },
        { status: 400 }
      );
    }

    if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
      return NextResponse.json(
        { error: "Unsupported file type." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);

    const result = await analyzeDocument({
      fileBuffer,
      fileMimeType: mimeType
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
