import { PrismaClient, type Prisma } from "@prisma/client";
import type { GeminiResult } from "./gemini";
import type { OcrTileSnapshot } from "./ocr";

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function saveGeminiResult(
  pageNumber: number,
  result: GeminiResult
) {
  if (result.circle_connected_texts.length > 0) {
    await prisma.circle_texts.createMany({
      data: result.circle_connected_texts.map((text) => ({
        connected_text: text,
        page_number: pageNumber
      }))
    });
  }

  if (result.single_road_texts.length > 0) {
    await prisma.single_road_texts.createMany({
      data: result.single_road_texts.map((text) => ({
        road_text: text,
        page_number: pageNumber
      }))
    });
  }
}

export async function saveTileOcrSnapshot(snapshot: OcrTileSnapshot) {
  const ocrData = snapshot as unknown as Prisma.InputJsonValue;
  await prisma.di_tile_ocr.create({
    data: {
      page_number: snapshot.pageNumber,
      tile_id: snapshot.tileId,
      ocr_data: ocrData
    }
  });
}
