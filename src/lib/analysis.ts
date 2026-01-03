import { promises as fs } from "node:fs";
import path from "node:path";
import { saveGeminiResult, saveTileOcrSnapshot } from "./db";
import {
  analyzeHyphenMergeWithGemini,
  analyzePageWithGemini
} from "./gemini";
import {
  appendOcrLog,
  buildTileOcrPayload,
  buildTileOcrSnapshot,
  type OcrLineCandidate,
  runOcr
} from "./ocr";
import {
  renderPdfToPngPages,
  splitImageIntoTiles,
  writeImagePage
} from "./tiles";

export type PageResult = {
  page_number: number;
  page_width: number;
  page_height: number;
  circle_connected_texts: string[];
  single_road_texts: string[];
  highlights: Highlight[];
};

export type AnalyzeResponse = {
  document_id: string;
  debug_output_dir: string;
  pages: PageResult[];
};

export type HighlightKind = "circle" | "road" | "single";

export type HighlightPoint = {
  x: number;
  y: number;
};

export type Highlight = {
  text: string;
  kind: HighlightKind;
  polygon: HighlightPoint[];
  tile_id: string;
};


const WORK_DIR = "tmp/di";
const TILE_MIME_TYPE = "image/jpeg";

function assertSupportedMimeType(mimeType: string) {
  if (!mimeType) {
    throw new Error("File mime type is missing.");
  }

  if (mimeType !== "application/pdf" && !mimeType.startsWith("image/")) {
    throw new Error(`Unsupported file type: ${mimeType}`);
  }
}

async function preparePageImages(
  fileBuffer: Buffer,
  mimeType: string,
  workDir: string
) {
  const pagesDir = path.join(workDir, "pages");
  if (mimeType === "application/pdf") {
    return renderPdfToPngPages({
      pdfBuffer: fileBuffer,
      outputDir: pagesDir
    });
  }

  const page = await writeImagePage({
    imageBuffer: fileBuffer,
    mimeType,
    outputDir: pagesDir,
    pageNumber: 1
  });
  return [page];
}

const SPACE_PATTERN = /\s+/g;
const TRAILING_PUNCT_PATTERN = /[.,:;]+$/;

function normalizeFragmentKey(text: string) {
  return text
    .trim()
    .replace(SPACE_PATTERN, "")
    .replace(TRAILING_PUNCT_PATTERN, "");
}

function isHyphenFragment(text: string) {
  const trimmed = text.trim();
  return {
    starts: trimmed.startsWith("-"),
    ends: trimmed.endsWith("-")
  };
}

function buildCandidateMap(lines: OcrLineCandidate[]) {
  const map = new Map<string, OcrLineCandidate>();
  for (const line of lines) {
    map.set(line.id, line);
  }
  return map;
}

function addHighlight({
  highlights,
  candidate,
  kind,
  tileId,
  offsetX,
  offsetY
}: {
  highlights: Highlight[];
  candidate: OcrLineCandidate | undefined;
  kind: HighlightKind;
  tileId: string;
  offsetX: number;
  offsetY: number;
}) {
  if (!candidate || candidate.polygon.length === 0) {
    return;
  }

  highlights.push({
    text: candidate.text,
    kind,
    tile_id: tileId,
    polygon: candidate.polygon.map((point) => ({
      x: point.x + offsetX,
      y: point.y + offsetY
    }))
  });
}

function applyHyphenMerges(
  singleTexts: string[],
  merges: { fragment: string; merged_text: string }[]
) {
  if (singleTexts.length === 0) {
    return singleTexts;
  }

  if (merges.length === 0) {
    return singleTexts;
  }

  const mergeMap = new Map<string, string>();
  const normalizedMap = new Map<string, string>();
  for (const merge of merges) {
    mergeMap.set(merge.fragment, merge.merged_text);
    const normalizedKey = normalizeFragmentKey(merge.fragment);
    if (normalizedKey && !normalizedMap.has(normalizedKey)) {
      normalizedMap.set(normalizedKey, merge.merged_text);
    }
  }

  const mergeLogs: string[] = [];
  const output = singleTexts.map((text) => {
    const frag = isHyphenFragment(text);
    if (!frag.starts && !frag.ends) {
      return text;
    }
    const direct = mergeMap.get(text);
    if (direct) {
      if (direct !== text) {
        mergeLogs.push(`"${text}" -> "${direct}"`);
      }
      return direct;
    }
    const normalizedKey = normalizeFragmentKey(text);
    if (normalizedKey) {
      const normalized = normalizedMap.get(normalizedKey);
      if (normalized) {
        if (normalized !== text) {
          mergeLogs.push(`"${text}" -> "${normalized}"`);
        }
        return normalized;
      }
    }
    return text;
  });

  if (mergeLogs.length > 0) {
    console.info(
      `[HyphenMerge] merged ${mergeLogs.length} fragments\n${mergeLogs.join("\n")}`
    );
  }

  return output;
}

export async function analyzeDocument({
  fileBuffer,
  fileMimeType
}: {
  fileBuffer: Buffer;
  fileMimeType: string;
}): Promise<AnalyzeResponse> {
  const documentId = crypto.randomUUID();
  const normalizedMimeType = fileMimeType.trim().toLowerCase();

  assertSupportedMimeType(normalizedMimeType);

  const workDir = path.join(process.cwd(), WORK_DIR, documentId);
  await fs.mkdir(workDir, { recursive: true });
  const pages = await preparePageImages(
    fileBuffer,
    normalizedMimeType,
    workDir
  );

  if (pages.length === 0) {
    throw new Error("No pages available for analysis.");
  }

  const results: PageResult[] = [];

  for (const page of pages) {
    const tilesDir = path.join(
      workDir,
      "tiles",
      `page-${page.pageNumber}`
    );
    const tiles = await splitImageIntoTiles(page, tilesDir);
    if (tiles.length === 0) {
      throw new Error(`No tiles generated for page ${page.pageNumber}.`);
    }

    const aggregated = {
      circle_connected_texts: [] as string[],
      single_road_texts: [] as string[]
    };
    const aggregatedSingles: string[] = [];
    const tileInputs: { tileId: string; fileBuffer: Buffer }[] = [];
    const pageHighlights: Highlight[] = [];

    for (const tile of tiles) {
      const tileBuffer = await fs.readFile(tile.imagePath);
      tileInputs.push({ tileId: tile.tileId, fileBuffer: tileBuffer });
      const ocrResult = await runOcr(tileBuffer);
      const ocrPayload = buildTileOcrPayload(
        ocrResult,
        page.pageNumber,
        tile.tileId
      );
      const ocrSnapshot = buildTileOcrSnapshot(
        ocrResult,
        page.pageNumber,
        tile.tileId
      );
      await saveTileOcrSnapshot(ocrSnapshot);
      await appendOcrLog(ocrSnapshot);

      const geminiResult = await analyzePageWithGemini({
        fileBuffer: tileBuffer,
        fileMimeType: TILE_MIME_TYPE,
        ocrPayload
      });

      const lineMap = buildCandidateMap(ocrPayload.lines);
      for (const pair of geminiResult.circle_road_pairs) {
        const circleCandidate = pair.circle_id
          ? lineMap.get(pair.circle_id)
          : undefined;
        const roadCandidate = pair.road_id
          ? lineMap.get(pair.road_id)
          : undefined;
        const circleText = circleCandidate?.text ?? pair.circle_text;
        const roadText = roadCandidate?.text ?? pair.road_text;
        if (circleText && roadText) {
          aggregated.circle_connected_texts.push(
            `${circleText} / ${roadText}`
          );
        }
        addHighlight({
          highlights: pageHighlights,
          candidate: circleCandidate,
          kind: "circle",
          tileId: tile.tileId,
          offsetX: tile.x,
          offsetY: tile.y
        });
        addHighlight({
          highlights: pageHighlights,
          candidate: roadCandidate,
          kind: "road",
          tileId: tile.tileId,
          offsetX: tile.x,
          offsetY: tile.y
        });
      }

      for (const id of geminiResult.single_road_ids) {
        const candidate = lineMap.get(id);
        if (candidate?.text) {
          aggregatedSingles.push(candidate.text);
        }
        addHighlight({
          highlights: pageHighlights,
          candidate,
          kind: "single",
          tileId: tile.tileId,
          offsetX: tile.x,
          offsetY: tile.y
        });
      }

      if (geminiResult.single_road_texts.length > 0) {
        aggregatedSingles.push(...geminiResult.single_road_texts);
      }
    }

    const hyphenFragments = aggregatedSingles.filter((text) => {
      const frag = isHyphenFragment(text);
      return frag.starts || frag.ends;
    });
    if (hyphenFragments.length > 0) {
      const uniqueFragments = Array.from(new Set(hyphenFragments));
      const mergedByFragment = new Map<string, string>();
      const mergedByNormalized = new Map<string, string>();
      const pickBetter = (current: string | undefined, next: string) => {
        if (!current) {
          return next;
        }
        return next.length > current.length ? next : current;
      };

      for (const tile of tileInputs) {
        try {
          const hyphenMerge = await analyzeHyphenMergeWithGemini({
            pageNumber: page.pageNumber,
            fragments: uniqueFragments,
            tiles: [tile],
            tileMimeType: TILE_MIME_TYPE
          });
          for (const merge of hyphenMerge.merges) {
            mergedByFragment.set(
              merge.fragment,
              pickBetter(mergedByFragment.get(merge.fragment), merge.merged_text)
            );
            const normalizedKey = normalizeFragmentKey(merge.fragment);
            if (normalizedKey) {
              mergedByNormalized.set(
                normalizedKey,
                pickBetter(
                  mergedByNormalized.get(normalizedKey),
                  merge.merged_text
                )
              );
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[HyphenMerge] tile ${tile.tileId} failed: ${message}`
          );
        }
      }

      const combinedMerges = Array.from(mergedByFragment.entries()).map(
        ([fragment, merged_text]) => ({
          fragment,
          merged_text
        })
      );
      for (const fragment of uniqueFragments) {
        if (mergedByFragment.has(fragment)) {
          continue;
        }
        const normalizedKey = normalizeFragmentKey(fragment);
        if (!normalizedKey) {
          continue;
        }
        const merged_text = mergedByNormalized.get(normalizedKey);
        if (merged_text) {
          combinedMerges.push({ fragment, merged_text });
        }
      }

      aggregated.single_road_texts = applyHyphenMerges(
        aggregatedSingles,
        combinedMerges
      );
    } else {
      aggregated.single_road_texts = aggregatedSingles;
    }
    await saveGeminiResult(page.pageNumber, aggregated);

    results.push({
      page_number: page.pageNumber,
      page_width: page.width,
      page_height: page.height,
      circle_connected_texts: aggregated.circle_connected_texts,
      single_road_texts: aggregated.single_road_texts,
      highlights: pageHighlights
    });
  }

  return {
    document_id: documentId,
    debug_output_dir: workDir,
    pages: results
  };
}
