import {
  AzureKeyCredential,
  DocumentAnalysisClient,
  type AnalyzeResult,
  type Point2D
} from "@azure/ai-form-recognizer";
import { promises as fs } from "node:fs";
import path from "node:path";

export type OcrPagePayload = {
  pageNumber: number;
  lines: OcrLineCandidate[];
  tileId?: string;
};

export type OcrPoint = {
  x: number;
  y: number;
};

export type OcrLineCandidate = {
  id: string;
  text: string;
  polygon: OcrPoint[];
};

export type OcrTileSnapshot = {
  pageNumber: number;
  tileId: string;
  unit: string | null;
  width: number | null;
  height: number | null;
  content: string;
  lines: { content: string; polygon: Point2D[] }[];
  words: { content: string; polygon: Point2D[] }[];
};

const OCR_LOG_DIR = "logs";
const OCR_LOG_FILE = "di-ocr.log";

function getClient() {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

  if (!endpoint || !key) {
    throw new Error("Azure Document Intelligence settings are missing.");
  }

  return new DocumentAnalysisClient(endpoint, new AzureKeyCredential(key));
}

export async function runOcr(
  fileBuffer: Buffer,
  modelId = "prebuilt-layout"
): Promise<AnalyzeResult> {
  const client = getClient();
  const poller = await client.beginAnalyzeDocument(modelId, fileBuffer);
  const result = await poller.pollUntilDone();

  if (!result) {
    throw new Error("OCR returned no result.");
  }

  return result;
}

function extractLineTexts(
  page: NonNullable<AnalyzeResult["pages"]>[number],
  content: string
) {
  const lines = (page.lines || [])
    .map((line) => line.content)
    .filter((line): line is string => typeof line === "string");

  if (lines.length > 0) {
    return lines;
  }

  const spans = page.spans || [];
  const pageText = spans
    .map((span) => content.slice(span.offset, span.offset + span.length))
    .join("");

  return pageText ? [pageText] : [];
}

function buildLineCandidates({
  lines,
  idPrefix
}: {
  lines: NonNullable<AnalyzeResult["pages"]>[number]["lines"];
  idPrefix: string;
}): OcrLineCandidate[] {
  if (!lines || lines.length === 0) {
    return [];
  }

  return lines
    .map((line, index) => ({
      id: `${idPrefix}-l${index}`,
      text: line.content?.trim() ?? "",
      polygon: (line.polygon || []).map((point) => ({
        x: point.x,
        y: point.y
      }))
    }))
    .filter((line) => line.text.length > 0);
}

export function buildPageOcrPayload(
  ocrResult: AnalyzeResult,
  pageNumber: number
): OcrPagePayload {
  const page = ocrResult.pages?.find(
    (candidate) => candidate.pageNumber === pageNumber
  );

  if (!page) {
    throw new Error(`OCR page ${pageNumber} not found.`);
  }

  const content = ocrResult.content || "";
  const candidates = buildLineCandidates({
    lines: page.lines,
    idPrefix: `page-${pageNumber}`
  });
  const lines =
    candidates.length > 0
      ? candidates
      : extractLineTexts(page, content).map((text, index) => ({
          id: `page-${pageNumber}-f${index}`,
          text,
          polygon: []
        }));

  return {
    pageNumber,
    lines
  };
}

export function buildTileOcrPayload(
  ocrResult: AnalyzeResult,
  pageNumber: number,
  tileId: string
): OcrPagePayload {
  const page = ocrResult.pages?.[0];

  if (!page) {
    throw new Error("OCR returned no page for tile.");
  }

  const content = ocrResult.content || "";
  const candidates = buildLineCandidates({
    lines: page.lines,
    idPrefix: tileId
  });
  const lines =
    candidates.length > 0
      ? candidates
      : extractLineTexts(page, content).map((text, index) => ({
          id: `${tileId}-f${index}`,
          text,
          polygon: []
        }));

  return {
    pageNumber,
    lines,
    tileId
  };
}

export function buildTileOcrSnapshot(
  ocrResult: AnalyzeResult,
  pageNumber: number,
  tileId: string
): OcrTileSnapshot {
  const page = ocrResult.pages?.[0];
  if (!page) {
    throw new Error("OCR returned no page for tile.");
  }

  const lines = (page.lines || []).map((line) => ({
    content: line.content,
    polygon: line.polygon ? [...line.polygon] : []
  }));
  const words = (page.words || []).map((word) => ({
    content: word.content,
    polygon: word.polygon ? [...word.polygon] : []
  }));

  return {
    pageNumber,
    tileId,
    unit: page.unit ?? null,
    width: page.width ?? null,
    height: page.height ?? null,
    content: ocrResult.content || "",
    lines,
    words
  };
}

export async function appendOcrLog(snapshot: OcrTileSnapshot) {
  const entry = {
    ts: new Date().toISOString(),
    ...snapshot
  };
  const logLine = `${JSON.stringify(entry)}\n`;
  try {
    const logDir = path.join(process.cwd(), OCR_LOG_DIR);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, OCR_LOG_FILE);
    await fs.appendFile(logPath, logLine, "utf8");
  } catch {
    // Logging failures should not block the main flow.
  }
  console.info(
    `[DI OCR] page ${snapshot.pageNumber} tile ${snapshot.tileId} lines ${snapshot.lines.length} words ${snapshot.words.length}`
  );
}
