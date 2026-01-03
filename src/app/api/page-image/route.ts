import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

const WORK_DIR = "tmp/di";
const PAGE_PREFIX = "page-";

function resolveContentType(fileName: string) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".tif" || ext === ".tiff") {
    return "image/tiff";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "application/octet-stream";
}

function isSafeDocumentId(value: string) {
  return /^[a-zA-Z0-9-]+$/.test(value);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get("document_id");
  const pageValue = searchParams.get("page");

  if (!documentId || !isSafeDocumentId(documentId)) {
    return NextResponse.json(
      { error: "Invalid document_id." },
      { status: 400 }
    );
  }

  const pageNumber = Number(pageValue);
  if (!pageValue || !Number.isInteger(pageNumber) || pageNumber < 1) {
    return NextResponse.json(
      { error: "Invalid page number." },
      { status: 400 }
    );
  }

  const pagesDir = path.join(
    process.cwd(),
    WORK_DIR,
    documentId,
    "pages"
  );

  let files: string[];
  try {
    files = await fs.readdir(pagesDir);
  } catch {
    return NextResponse.json(
      { error: "Page images not found." },
      { status: 404 }
    );
  }

  const pagePrefix = `${PAGE_PREFIX}${pageNumber}`;
  const matches = files
    .filter((file) => file.startsWith(pagePrefix))
    .sort();
  const fileName = matches[0];
  if (!fileName) {
    return NextResponse.json(
      { error: "Page image not found." },
      { status: 404 }
    );
  }

  const filePath = path.join(pagesDir, fileName);
  const buffer = await fs.readFile(filePath);
  const contentType = resolveContentType(fileName);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    }
  });
}

