"use client";

import { useEffect, useRef, useState } from "react";

type HighlightPoint = {
  x: number;
  y: number;
};

type HighlightKind = "circle" | "road" | "single";

type Highlight = {
  text: string;
  kind: HighlightKind;
  polygon: HighlightPoint[];
  tile_id: string;
};

type PageResult = {
  page_number: number;
  page_width: number;
  page_height: number;
  circle_connected_texts: string[];
  single_road_texts: string[];
  highlights: Highlight[];
};

type AnalyzeResponse = {
  document_id: string;
  debug_output_dir: string;
  pages: PageResult[];
};

type GroupedItem = {
  text: string;
  count: number;
};

const NORMALIZE_PATTERN =
  /[\s\-–—ー/\\.,:;()\[\]{}'\"""''·・]/g;

const normalizeText = (text: string) =>
  text.normalize("NFKC").toUpperCase().replace(NORMALIZE_PATTERN, "");

const groupByNormalized = (items: string[]): GroupedItem[] => {
  const grouped = new Map<string, GroupedItem>();
  for (const text of items) {
    const key = normalizeText(text);
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      grouped.set(key, { text, count: 1 });
    }
  }
  return Array.from(grouped.values());
};

const highlightPalette: Record<
  HighlightKind,
  { fill: string; stroke: string }
> = {
  circle: {
    fill: "rgba(255, 140, 0, 0.3)",
    stroke: "rgba(255, 140, 0, 0.85)"
  },
  road: {
    fill: "rgba(255, 140, 0, 0.3)",
    stroke: "rgba(255, 140, 0, 0.85)"
  },
  single: {
    fill: "rgba(30, 136, 229, 0.28)",
    stroke: "rgba(30, 136, 229, 0.85)"
  }
};

function drawHighlights(
  ctx: CanvasRenderingContext2D,
  page: PageResult,
  scaleX: number,
  scaleY: number
) {
  if (!page.highlights || page.highlights.length === 0) {
    return;
  }

  ctx.lineWidth = 2;
  for (const highlight of page.highlights) {
    if (highlight.polygon.length === 0) {
      continue;
    }
    const colors = highlightPalette[highlight.kind];
    ctx.beginPath();
    highlight.polygon.forEach((point, index) => {
      const x = point.x * scaleX;
      const y = point.y * scaleY;
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.strokeStyle = colors.stroke;
    ctx.fill();
    ctx.stroke();
  }
}

function drawPageOverlay(canvas: HTMLCanvasElement, page: PageResult) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scaleX = page.page_width
    ? canvas.width / page.page_width
    : 1;
  const scaleY = page.page_height
    ? canvas.height / page.page_height
    : 1;

  drawHighlights(ctx, page, scaleX, scaleY);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const pdfCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const overlayCanvasRefs = useRef(new Map<number, HTMLCanvasElement>());

  const setPdfCanvas =
    (pageNumber: number) => (node: HTMLCanvasElement | null) => {
      if (node) {
        pdfCanvasRefs.current.set(pageNumber, node);
      } else {
        pdfCanvasRefs.current.delete(pageNumber);
      }
    };

  const setOverlayCanvas =
    (pageNumber: number) => (node: HTMLCanvasElement | null) => {
      if (node) {
        overlayCanvasRefs.current.set(pageNumber, node);
      } else {
        overlayCanvasRefs.current.delete(pageNumber);
      }
    };

  useEffect(() => {
    if (!result) {
      return;
    }

    let cancelled = false;

    const renderImages = async () => {
      const documentId = result.document_id;
      if (!documentId) {
        return;
      }

      await Promise.all(
        result.pages.map(
          (page) =>
            new Promise<void>((resolve) => {
              const image = new Image();
              image.onload = () => {
                if (cancelled) {
                  resolve();
                  return;
                }
                const canvas = pdfCanvasRefs.current.get(page.page_number);
                if (!canvas) {
                  resolve();
                  return;
                }
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                  resolve();
                  return;
                }
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

                const overlay = overlayCanvasRefs.current.get(
                  page.page_number
                );
                if (overlay) {
                  overlay.width = canvas.width;
                  overlay.height = canvas.height;
                  drawPageOverlay(overlay, page);
                }
                resolve();
              };
              image.onerror = () => {
                resolve();
              };
              image.src = `/api/page-image?document_id=${documentId}&page=${page.page_number}`;
            })
        )
      );
    };

    renderImages().catch((err) => {
      if (!cancelled) {
        setError(
          err instanceof Error
            ? err.message
            : "Image render failed."
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [result]);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setResult(null);

    if (!file) {
      setError("PDFまたは画像ファイルを選択してください。");
      return;
    }

    const formData = new FormData();
    formData.append("file", file, file.name);

    setBusy(true);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload.error || "Analysis failed.");
        return;
      }

      setResult(payload as AnalyzeResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-4xl px-6 pb-16 pt-12">
      <h1 className="mb-3 text-[2.1rem]">図面抽出</h1>
      <p className="mb-6 text-[#3a342d]">
        PDFまたは画像の図面をアップロードして、丸囲み文字、直上の道路名、
        単独の道路名を抽出します。
      </p>

      <form
        onSubmit={onSubmit}
        className="grid gap-4 rounded-2xl border border-[#e2d8cc] bg-white p-5 shadow-[0_20px_40px_rgba(31,29,26,0.08)]"
      >
        <input
          type="file"
          accept="application/pdf,image/*"
          className="rounded-xl border border-dashed border-[#c1b4a4] bg-[#faf6f1] p-4"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-[#2b3b2f] px-5 py-3 text-base text-[#f7f1e8] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "解析中..." : "解析する"}
        </button>
      </form>

      {busy && (
        <div className="mt-4 rounded-xl border border-[#f2d28b] bg-[#fff4da] px-4 py-3">
          ファイルを処理しています...
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-xl border border-[#f2b1a6] bg-[#ffe4e0] px-4 py-3 text-[#6b1f1f]">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-8 grid gap-5">
          {result.pages.map((page) => {
            const groupedCircle = groupByNormalized(
              page.circle_connected_texts
            );
            const groupedSingle = groupByNormalized(page.single_road_texts);

            return (
              <section
                className="rounded-xl border border-[#e2d8cc] bg-white p-4"
                key={page.page_number}
              >
                <h2 className="mb-2 text-xl font-semibold">
                  Page {page.page_number}
                </h2>
                <div className="my-3 max-h-[80vh] max-w-4xl overflow-hidden rounded-xl border border-[#e2d8cc] bg-[#fdfaf6] p-3">
                  <div className="relative inline-block max-h-[80vh] max-w-4xl">
                    <canvas
                      ref={setPdfCanvas(page.page_number)}
                      className="block max-h-[80vh] max-w-full"
                    />
                    <canvas
                      ref={setOverlayCanvas(page.page_number)}
                      className="pointer-events-none absolute inset-0 h-full w-full"
                    />
                  </div>
                </div>
                <div className="grid gap-4">
                  <div>
                    <strong className="text-sm font-semibold">
                      丸囲みと結合した道路名
                    </strong>
                    <ul className="mt-2 grid gap-2 pl-5">
                      {groupedCircle.length === 0 && <li>なし</li>}
                      {groupedCircle.map((item, index) => (
                        <li
                          key={`${page.page_number}-circle-${index}`}
                          className="flex items-center gap-2 break-words leading-relaxed"
                        >
                          <span>{item.text}</span>
                          {item.count > 1 && (
                            <span className="rounded-full border border-[#d6e2c8] bg-[#eff4e8] px-2 py-0.5 text-xs text-[#3a4a33]">
                              x{item.count}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <strong className="text-sm font-semibold">
                      単独の道路名
                    </strong>
                    <ul className="mt-2 grid gap-2 pl-5">
                      {groupedSingle.length === 0 && <li>なし</li>}
                      {groupedSingle.map((item, index) => (
                        <li
                          key={`${page.page_number}-single-${index}`}
                          className="flex items-center gap-2 break-words leading-relaxed"
                        >
                          <span>{item.text}</span>
                          {item.count > 1 && (
                            <span className="rounded-full border border-[#d6e2c8] bg-[#eff4e8] px-2 py-0.5 text-xs text-[#3a4a33]">
                              x{item.count}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
