import { GoogleGenerativeAI } from "@google/generative-ai";
import type { OcrPagePayload } from "./ocr";
import { promises as fs } from "node:fs";
import path from "node:path";

export type GeminiResult = {
  circle_connected_texts: string[];
  single_road_texts: string[];
};

export type GeminiExtraction = {
  circle_road_pairs: {
    circle_id?: string;
    road_id?: string;
    circle_text?: string;
    road_text?: string;
  }[];
  single_road_ids: string[];
  single_road_texts: string[];
};

export type HyphenMergeResult = {
  merges: { fragment: string; merged_text: string }[];
};

const PROMPT = `あなたは設計図面を解析するAIです。以下のルールを必ず厳守してください。

- **図面内に存在する丸囲み文字・道路文字をなるべく全て抽出してください。見落としがないよう、画像全体を注意深く確認してください。**
- OCR候補リストに含まれていない文字を新たに生成・補完・修正してはいけません。
- 画像とAzure Document Intelligence（DI）のOCR結果を必ず詳細に見比べて判断してください。
- **丸に囲まれている数字（地点ID）と、その周辺にある道路文字（スペック）の対応関係を正しく特定することが最優先事項です。**
- 丸に囲まれていない文字でも、道路名/配管仕様/距離表記と**明確に判断できる**文字列のみ単体道路文字として抽出してください。
- **ハイフンで始まる/終わる断片（例: "-19M", "600 140-"）は道路文字の一部の可能性が高いので、必ずsingle_road_idsに含めてください（断片のままでOK）。**
- 出力は指定されたJSON形式のみとし、説明文やコメントは出力しないでください。
- すべての値は **文字列** として出力してください（数値も必ずダブルクォートで囲む）。
- OCR候補リストの各項目にはidとpolygonが付与されています。視覚的に確認した位置と一致する候補のidを選択してください。

この図面画像には、丸で囲まれた文字と、その付近（主に上部）に配置された道路文字が存在します。以下の処理を**丸文字を起点として**行ってください。

1. **丸文字の特定**: 
   画像内で「円」に完全に囲まれている数字（例：295）をすべて特定してください。
2. **関連する道路文字の特定（ペアリング）**: 
   各丸文字について、その**真上（垂直方向のズレが最小で、水平位置のズレが極めて小さい）**にある文字を1つだけ特定してください。
   - 丸文字の中心Xと道路文字の中心Xがほぼ一致していること
   - 道路文字の横幅が丸文字の直上に十分重なっていること
   - 丸文字からの垂直距離が最短であること
   - 斜め上や離れた文字は**採用しない**
   - 文字が「0SVP」のように一部欠けてOCRされている場合でも、全体として「130SVP」などの意味をなす単語であると画像から判断できる場合は、OCRリストの中から**最も完全な**文字列のidを選択してください。
3. **結合禁止**: 
   丸文字と、ペアとなる道路文字は結合せず、独立した文字列としてペアで出力してください。
4. **照合の徹底**: 
   抽出する文字列は、提供されたOCR候補リストに存在するものを優先してください。
5. **単体道路文字の扱い**: 
   どの丸文字とも明確な関連性がない道路文字は「単体の道路文字」として扱います。**迷った場合は出力しない**でください（ただしハイフン断片は必ず出力）。

出力は必ず以下のJSON形式のみで返してください。
{ 
  "circle_road_pairs": [ 
    { "circle_id": "r1c1-l12", "road_id": "r1c1-l35" } 
  ], 
  "single_road_ids": [] 
}`;

const HYPHEN_MERGE_PROMPT = `あなたは設計図面の画像を読み取るAIです。以下のルールを必ず守ってください。

- 入力として「ハイフン断片の一覧」を渡します。各断片が図面上でどの道路名の一部になっているか、画像を見て判断してください。
- 改行で分断されている場合は、同一の道路名として1行に結合して構いません。
- 画像に見える文字のみを使って結合してください。推測や想像で文字を追加しないでください。
- 見つからない場合は、その断片をそのまま返してください。
- 出力は指定されたJSON形式のみで返してください（説明文やコメントは不要）。

出力形式:
{
  "merges": [
    { "fragment": "-19M", "merged_text": "(CVQ) 600V150-19M" }
  ]
}
`;

const DEFAULT_MODEL = "gemini-3-pro-preview";
const DEFAULT_HYPHEN_MODEL = "gemini-2.5-flash";
const LOG_DIR = "logs";
const LOG_FILE = "di.log";

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }
  return new GoogleGenerativeAI(apiKey);
}

function resolveFallbackModel(primaryModelName: string) {
  const configured = process.env.GEMINI_FALLBACK_MODEL?.trim();
  if (configured) {
    return configured;
  }

  if (primaryModelName.startsWith("gemini-2.5")) {
    return "gemini-2.5-flash-lite";
  }

  return "";
}

function isOverloadedError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("503") ||
    message.includes("service unavailable") ||
    message.includes("overloaded")
  );
}

function stripJsonCodeFence(text: string) {
  const trimmed = text.trim();
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    return match[1].trim();
  }
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function appendGeminiLog(entry: Record<string, unknown>) {
  const rawResponse =
    typeof entry.rawResponse === "string" ? entry.rawResponse : "";
  const cleanedResponse =
    typeof entry.cleanedResponse === "string" ? entry.cleanedResponse : "";
  const logLines = [
    "---",
    `ts: ${entry.ts ?? ""}`,
    `pageNumber: ${entry.pageNumber ?? ""}`,
    `model: ${entry.model ?? ""}`,
    "rawResponse:",
    ...rawResponse.split(/\r?\n/),
    "cleanedResponse:",
    ...cleanedResponse.split(/\r?\n/),
    "---"
  ];
  const logBlock = `${logLines.join("\n")}\n`;
  try {
    const logDir = path.join(process.cwd(), LOG_DIR);
    await fs.mkdir(logDir, { recursive: true });
    const logPath = path.join(logDir, LOG_FILE);
    await fs.appendFile(logPath, logBlock, "utf8");
  } catch {
    // Logging failures should not block the main flow.
  }
  console.info(logBlock.trimEnd());
}

export function validateGeminiResult(value: unknown): GeminiResult {
  if (!value || typeof value !== "object") {
    throw new Error("Gemini output must be a JSON object.");
  }

  const obj = value as Record<string, unknown>;
  const hasConnected = Object.prototype.hasOwnProperty.call(
    obj,
    "circle_connected_texts"
  );
  const hasPairs = Object.prototype.hasOwnProperty.call(
    obj,
    "circle_road_pairs"
  );

  if (hasConnected && hasPairs) {
    throw new Error(
      "Gemini output must not include both circle_connected_texts and circle_road_pairs."
    );
  }

  if (!hasConnected && !hasPairs) {
    throw new Error("Gemini output is missing circle data.");
  }

  const allowedKeys = hasPairs
    ? ["circle_road_pairs", "single_road_texts"]
    : ["circle_connected_texts", "single_road_texts"];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Gemini output has unexpected key: ${key}`);
    }
  }

  const single = obj.single_road_texts;
  if (!Array.isArray(single)) {
    throw new Error("single_road_texts must be an array.");
  }
  const normalizedSingles: string[] = [];
  for (const item of single) {
    if (typeof item === "string") {
      normalizedSingles.push(item);
      continue;
    }
    if (typeof item === "number") {
      normalizedSingles.push(String(item));
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const candidate =
        record.text ?? record.value ?? record.content ?? record.label;
      if (typeof candidate === "string") {
        normalizedSingles.push(candidate);
        continue;
      }
      if (typeof candidate === "number") {
        normalizedSingles.push(String(candidate));
        continue;
      }
    }
    console.warn(
      "[Gemini] Dropping non-string single_road_texts entry:",
      item
    );
  }

  if (hasConnected) {
    const circle = obj.circle_connected_texts;
    if (!Array.isArray(circle)) {
      throw new Error("circle_connected_texts must be an array.");
    }
    for (const item of circle) {
      if (typeof item !== "string") {
        throw new Error("circle_connected_texts must contain only strings.");
      }
    }

    return {
      circle_connected_texts: circle,
      single_road_texts: normalizedSingles
    };
  }

  const pairs = obj.circle_road_pairs;
  if (!Array.isArray(pairs)) {
    throw new Error("circle_road_pairs must be an array.");
  }

  const connectedTexts: string[] = [];
  for (const pair of pairs) {
    if (!pair || typeof pair !== "object") {
      throw new Error("circle_road_pairs must contain objects.");
    }
    const record = pair as Record<string, unknown>;
    if (typeof record.circle_text !== "string") {
      throw new Error("circle_road_pairs.circle_text must be a string.");
    }
    if (typeof record.road_text !== "string") {
      throw new Error("circle_road_pairs.road_text must be a string.");
    }
    connectedTexts.push(`${record.circle_text} / ${record.road_text}`);
  }

  return {
    circle_connected_texts: connectedTexts,
    single_road_texts: normalizedSingles
  };
}

function normalizeSingleTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      normalized.push(item);
      continue;
    }
    if (typeof item === "number") {
      normalized.push(String(item));
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const candidate =
        record.text ?? record.value ?? record.content ?? record.label;
      if (typeof candidate === "string") {
        normalized.push(candidate);
        continue;
      }
      if (typeof candidate === "number") {
        normalized.push(String(candidate));
        continue;
      }
    }
    console.warn(
      "[Gemini] Dropping non-string single_road_texts entry:",
      item
    );
  }
  return normalized;
}

function splitConnectedText(text: string) {
  const parts = text.split("/");
  if (parts.length < 2) {
    return null;
  }
  const circle = parts[0].trim();
  const road = parts.slice(1).join("/").trim();
  if (!circle && !road) {
    return null;
  }
  return { circle, road };
}

export function validateGeminiExtraction(
  value: unknown
): GeminiExtraction {
  if (!value || typeof value !== "object") {
    throw new Error("Gemini output must be a JSON object.");
  }

  const obj = value as Record<string, unknown>;
  const allowedKeys = [
    "circle_road_pairs",
    "single_road_ids",
    "single_road_texts",
    "circle_connected_texts"
  ];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Gemini output has unexpected key: ${key}`);
    }
  }

  const circlePairs: GeminiExtraction["circle_road_pairs"] = [];
  if (Object.prototype.hasOwnProperty.call(obj, "circle_road_pairs")) {
    const pairs = obj.circle_road_pairs;
    if (!Array.isArray(pairs)) {
      throw new Error("circle_road_pairs must be an array.");
    }
    for (const pair of pairs) {
      if (!pair || typeof pair !== "object") {
        throw new Error("circle_road_pairs must contain objects.");
      }
      const record = pair as Record<string, unknown>;
      const circleId = record.circle_id;
      const roadId = record.road_id;
      const circleText = record.circle_text;
      const roadText = record.road_text;
      if (
        (typeof circleId === "string" && typeof roadId === "string") ||
        (typeof circleText === "string" && typeof roadText === "string")
      ) {
        circlePairs.push({
          circle_id: typeof circleId === "string" ? circleId : undefined,
          road_id: typeof roadId === "string" ? roadId : undefined,
          circle_text:
            typeof circleText === "string" ? circleText : undefined,
          road_text: typeof roadText === "string" ? roadText : undefined
        });
        continue;
      }
      throw new Error(
        "circle_road_pairs entries must include circle_id/road_id or circle_text/road_text."
      );
    }
  }

  if (Object.prototype.hasOwnProperty.call(obj, "circle_connected_texts")) {
    const connected = obj.circle_connected_texts;
    if (!Array.isArray(connected)) {
      throw new Error("circle_connected_texts must be an array.");
    }
    for (const item of connected) {
      if (typeof item !== "string") {
        throw new Error("circle_connected_texts must contain only strings.");
      }
      const split = splitConnectedText(item);
      if (split) {
        circlePairs.push({
          circle_text: split.circle,
          road_text: split.road
        });
      }
    }
  }

  const singleRoadIdsRaw = obj.single_road_ids;
  const singleRoadIds = Array.isArray(singleRoadIdsRaw)
    ? singleRoadIdsRaw.filter(
        (item): item is string => typeof item === "string"
      )
    : [];
  if (Array.isArray(singleRoadIdsRaw)) {
    for (const item of singleRoadIdsRaw) {
      if (typeof item !== "string") {
        console.warn(
          "[Gemini] Dropping non-string single_road_ids entry:",
          item
        );
      }
    }
  } else if (singleRoadIdsRaw !== undefined) {
    console.warn("[Gemini] single_road_ids must be an array.");
  }

  const singleRoadTexts = normalizeSingleTexts(obj.single_road_texts);

  return {
    circle_road_pairs: circlePairs,
    single_road_ids: singleRoadIds,
    single_road_texts: singleRoadTexts
  };
}

export function validateHyphenMergeResult(
  value: unknown
): HyphenMergeResult {
  if (!value || typeof value !== "object") {
    throw new Error("Hyphen merge output must be a JSON object.");
  }
  const obj = value as Record<string, unknown>;
  const allowedKeys = ["merges"];
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Hyphen merge output has unexpected key: ${key}`);
    }
  }
  const merges = obj.merges;
  if (!Array.isArray(merges)) {
    throw new Error("merges must be an array.");
  }
  for (const item of merges) {
    if (!item || typeof item !== "object") {
      throw new Error("merges must contain objects.");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.fragment !== "string") {
      throw new Error("merges.fragment must be a string.");
    }
    if (typeof record.merged_text !== "string") {
      throw new Error("merges.merged_text must be a string.");
    }
  }
  return { merges: merges as HyphenMergeResult["merges"] };
}

export async function analyzeHyphenMergeWithGemini({
  pageNumber,
  fragments,
  tiles,
  tileMimeType
}: {
  pageNumber: number;
  fragments: string[];
  tiles: { tileId: string; fileBuffer: Buffer }[];
  tileMimeType: string;
}): Promise<HyphenMergeResult> {
  const genAI = getClient();
  const configuredHyphenModel = process.env.GEMINI_HYPHEN_MODEL?.trim();
  const primaryModelName =
    configuredHyphenModel || DEFAULT_HYPHEN_MODEL;
  const fallbackModelName = resolveFallbackModel(primaryModelName);

  const fragmentsJson = JSON.stringify(fragments);
  const contentParts: Array<
    { text: string } | { inlineData: { data: string; mimeType: string } }
  > = [
    {
      text: `${HYPHEN_MERGE_PROMPT}\n\nPage number: ${pageNumber}\n\nFragments JSON:\n${fragmentsJson}`
    }
  ];

  for (const tile of tiles) {
    contentParts.push({ text: `Tile ${tile.tileId}` });
    contentParts.push({
      inlineData: {
        data: tile.fileBuffer.toString("base64"),
        mimeType: tileMimeType
      }
    });
  }

  const generateWithModel = async (modelName: string) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0
      }
    });

    return model.generateContent(contentParts);
  };

  const attemptGenerate = async (modelName: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await generateWithModel(modelName);
      } catch (error) {
        lastError = error;
        if (attempt < 1) {
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
    }
    throw lastError;
  };

  let result;
  let usedModelName = primaryModelName;
  try {
    result = await attemptGenerate(primaryModelName);
  } catch (error) {
    if (fallbackModelName && fallbackModelName !== primaryModelName) {
      usedModelName = fallbackModelName;
      result = await attemptGenerate(fallbackModelName);
    } else {
      throw error;
    }
  }

  const responseText = result.response.text();
  const cleanedText = stripJsonCodeFence(responseText);
  await appendGeminiLog({
    ts: new Date().toISOString(),
    pageNumber,
    model: usedModelName,
    task: "hyphen-merge",
    rawResponse: responseText,
    cleanedResponse: cleanedText
  });
  const parsed = JSON.parse(cleanedText);
  return validateHyphenMergeResult(parsed);
}

export async function analyzePageWithGemini({
  fileBuffer,
  fileMimeType,
  ocrPayload
}: {
  fileBuffer: Buffer;
  fileMimeType: string;
  ocrPayload: OcrPagePayload;
}): Promise<GeminiExtraction> {
  const genAI = getClient();
  const primaryModelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallbackModelName = resolveFallbackModel(primaryModelName);

  const ocrJson = JSON.stringify(ocrPayload);
  const filePart = {
    inlineData: {
      data: fileBuffer.toString("base64"),
      mimeType: fileMimeType
    }
  };

  const contentParts = [
    {
      text: `${PROMPT}\n\nPage number: ${ocrPayload.pageNumber}\n\nOCR JSON:\n${ocrJson}`
    },
    filePart
  ];

  const generateWithModel = async (modelName: string) => {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: 0
      }
    });

    return model.generateContent(contentParts);
  };

  let result;
  let usedModelName = primaryModelName;
  try {
    result = await generateWithModel(primaryModelName);
  } catch (error) {
    if (
      isOverloadedError(error) &&
      fallbackModelName &&
      fallbackModelName !== primaryModelName
    ) {
      usedModelName = fallbackModelName;
      result = await generateWithModel(fallbackModelName);
    } else {
      throw error;
    }
  }

  const responseText = result.response.text();
  const cleanedText = stripJsonCodeFence(responseText);
  await appendGeminiLog({
    ts: new Date().toISOString(),
    pageNumber: ocrPayload.pageNumber,
    model: usedModelName,
    rawResponse: responseText,
    cleanedResponse: cleanedText
  });
  const parsed = JSON.parse(cleanedText);

  return validateGeminiExtraction(parsed);
}
