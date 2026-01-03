import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import sharp from "sharp";

export type PageImage = {
  pageNumber: number;
  imagePath: string;
  width: number;
  height: number;
};

export type TileImage = {
  pageNumber: number;
  tileId: string;
  imagePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type TileOptions = {
  overlapRatio: number;
  overlapMinPx: number;
  overlapMaxPx: number;
};

const DEFAULT_DPI = 300;
const TILE_OUTPUT_FORMAT = "jpeg";
const TILE_OUTPUT_EXTENSION = ".jpg";
const TILE_JPEG_QUALITY = 85;
const DEFAULT_TILE_OPTIONS: TileOptions = {
  overlapRatio: 0.15,
  overlapMinPx: 200,
  overlapMaxPx: 400
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function imageExtensionForMime(mimeType: string) {
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/tiff") {
    return ".tif";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }
  return ".img";
}

async function runCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${command} failed (exit ${code}). ${stderr.trim() || stdout.trim()}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getImageSize(imagePath: string) {
  const { stdout } = await runCommand("sips", [
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    imagePath
  ]);
  const widthMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const heightMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  if (!widthMatch || !heightMatch) {
    throw new Error(`Unable to read image size for ${imagePath}.`);
  }
  return {
    width: Number(widthMatch[1]),
    height: Number(heightMatch[1])
  };
}

async function cropImage({
  sourcePath,
  outputPath,
  x,
  y,
  width,
  height,
  format,
  quality
}: {
  sourcePath: string;
  outputPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  format?: string;
  quality?: number;
}) {
  // sharpを使用して左上座標 (x, y) からクロップ
  let pipeline = sharp(sourcePath).extract({
    left: x,
    top: y,
    width,
    height
  });

  if (format === "jpeg") {
    pipeline = pipeline.jpeg({ quality: quality ?? 85 });
  } else if (format === "png") {
    pipeline = pipeline.png();
  }

  await pipeline.toFile(outputPath);
}

export async function renderPdfToPngPages({
  pdfBuffer,
  outputDir,
  dpi = DEFAULT_DPI
}: {
  pdfBuffer: Buffer;
  outputDir: string;
  dpi?: number;
}): Promise<PageImage[]> {
  await fs.mkdir(outputDir, { recursive: true });
  const pdfPath = path.join(outputDir, "source.pdf");
  await fs.writeFile(pdfPath, pdfBuffer);

  const prefix = path.join(outputDir, "page");
  await runCommand("pdftoppm", ["-png", "-r", String(dpi), pdfPath, prefix]);

  const files = await fs.readdir(outputDir);
  const pageFiles = files
    .filter((file) => file.startsWith("page-") && file.endsWith(".png"))
    .map((file) => {
      const match = file.match(/page-(\d+)\.png$/);
      return match ? { file, pageNumber: Number(match[1]) } : null;
    })
    .filter((entry): entry is { file: string; pageNumber: number } => !!entry)
    .sort((a, b) => a.pageNumber - b.pageNumber);

  const pages: PageImage[] = [];
  for (const entry of pageFiles) {
    const imagePath = path.join(outputDir, entry.file);
    const size = await getImageSize(imagePath);
    pages.push({
      pageNumber: entry.pageNumber,
      imagePath,
      width: size.width,
      height: size.height
    });
  }

  if (pages.length === 0) {
    throw new Error("No pages rendered from PDF.");
  }

  return pages;
}

export async function writeImagePage({
  imageBuffer,
  mimeType,
  outputDir,
  pageNumber = 1
}: {
  imageBuffer: Buffer;
  mimeType: string;
  outputDir: string;
  pageNumber?: number;
}): Promise<PageImage> {
  await fs.mkdir(outputDir, { recursive: true });
  const ext = imageExtensionForMime(mimeType);
  const imagePath = path.join(outputDir, `page-${pageNumber}${ext}`);
  await fs.writeFile(imagePath, imageBuffer);
  const size = await getImageSize(imagePath);
  return {
    pageNumber,
    imagePath,
    width: size.width,
    height: size.height
  };
}

export async function splitImageIntoTiles(
  page: PageImage,
  outputDir: string,
  options: TileOptions = DEFAULT_TILE_OPTIONS
): Promise<TileImage[]> {
  await fs.mkdir(outputDir, { recursive: true });
  const centerX = Math.round(page.width / 2);
  const centerY = Math.round(page.height / 2);
  const halfOverlapX = Math.min(
    clamp(
      Math.round(centerX * options.overlapRatio),
      options.overlapMinPx,
      options.overlapMaxPx
    ),
    centerX,
    page.width - centerX
  );
  const halfOverlapY = Math.min(
    clamp(
      Math.round(centerY * options.overlapRatio),
      options.overlapMinPx,
      options.overlapMaxPx
    ),
    centerY,
    page.height - centerY
  );

  const leftX = 0;
  const rightX = Math.max(0, centerX - halfOverlapX);
  const leftWidth = Math.min(centerX + halfOverlapX, page.width);
  const rightWidth = Math.max(0, page.width - rightX);
  const topY = 0;
  const bottomY = Math.max(0, centerY - halfOverlapY);
  const topHeight = Math.min(centerY + halfOverlapY, page.height);
  const bottomHeight = Math.max(0, page.height - bottomY);

  const tiles: TileImage[] = [];
  const tileSpecs = [
    {
      row: 0,
      col: 0,
      x: leftX,
      y: topY,
      width: leftWidth,
      height: topHeight
    },
    {
      row: 0,
      col: 1,
      x: rightX,
      y: topY,
      width: rightWidth,
      height: topHeight
    },
    {
      row: 1,
      col: 0,
      x: leftX,
      y: bottomY,
      width: leftWidth,
      height: bottomHeight
    },
    {
      row: 1,
      col: 1,
      x: rightX,
      y: bottomY,
      width: rightWidth,
      height: bottomHeight
    }
  ];

  for (const spec of tileSpecs) {
    const tileId = `r${spec.row + 1}c${spec.col + 1}`;
    const tilePath = path.join(
      outputDir,
      `page-${page.pageNumber}-tile-${tileId}${TILE_OUTPUT_EXTENSION}`
    );
    await cropImage({
      sourcePath: page.imagePath,
      outputPath: tilePath,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height,
      format: TILE_OUTPUT_FORMAT,
      quality: TILE_JPEG_QUALITY
    });
    tiles.push({
      pageNumber: page.pageNumber,
      tileId,
      imagePath: tilePath,
      x: spec.x,
      y: spec.y,
      width: spec.width,
      height: spec.height
    });
  }

  return tiles;
}
