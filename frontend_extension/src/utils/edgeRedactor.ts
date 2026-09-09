/**
 * Destructive canvas redaction engine.
 *
 * Ingests a raw viewport screenshot data URL plus a set of sensitive
 * bounding boxes (from domScraper's element harvesting) and permanently
 * overwrites each one with a solid black rectangle on an off-screen
 * canvas. The raw capture is never persisted and the ImageBitmap /
 * original data URL are dropped immediately after the redacted JPEG is
 * produced, satisfying the "raw screenshots never transmitted or saved"
 * invariant.
 */

import { pseudonymizer } from "./pseudonymizer";

export interface SensitiveRegion {
  /** Coordinates in normalized viewport units or captured image pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  reason?: string; // "face" | "signature" | "sensitive_text" | PII category
  coordinateSpace?: "normalized" | "css" | "image";
}

export interface RedactionResult {
  redactedImageB64: string; // JPEG, no data: prefix
  regionsRedacted: number;
  maskedEntityCount: number;
}

/**
 * Loads a data URL into an ImageBitmap without touching persistent storage.
 */
async function loadBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return await createImageBitmap(blob);
}

/**
 * Renders the source bitmap onto an off-screen canvas, paints solid black
 * rectangles over every sensitive region, and returns a base64 JPEG.
 *
 * The `sourceBitmap` reference is nulled out by the caller after this
 * resolves; we never keep a second copy of the unredacted pixels around.
 */
export async function redactCanvas(
  rawDataUrl: string,
  sensitiveRegions: SensitiveRegion[],
  _viewportWidth = window.innerWidth,
  _viewportHeight = window.innerHeight
): Promise<RedactionResult> {
  const bitmap = await loadBitmap(rawDataUrl);
  const bitmapWidth = bitmap.width;
  const bitmapHeight = bitmap.height;

  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bitmapWidth, bitmapHeight)
      : Object.assign(document.createElement("canvas"), {
          width: bitmapWidth,
          height: bitmapHeight,
        });

  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("edgeRedactor: unable to acquire 2D context");

  ctx.drawImage(bitmap, 0, 0);

  // Immediately release the raw decoded bitmap from memory once drawn.
  bitmap.close();

  ctx.fillStyle = "#000000";
  for (const region of sensitiveRegions) {
    let x = region.x;
    let y = region.y;
    let width = region.width;
    let height = region.height;

    if (region.coordinateSpace === "normalized") {
      x = (region.x / 1000) * bitmapWidth;
      y = (region.y / 1000) * bitmapHeight;
      width = (region.width / 1000) * bitmapWidth;
      height = (region.height / 1000) * bitmapHeight;
    } else if (region.coordinateSpace === "css") {
      const scaleX = bitmapWidth / Math.max(1, _viewportWidth);
      const scaleY = bitmapHeight / Math.max(1, _viewportHeight);
      x *= scaleX;
      y *= scaleY;
      width *= scaleX;
      height *= scaleY;
    }

    const padding = region.coordinateSpace === "image" ? 1 : 2;
    const left = Math.max(0, x - padding);
    const top = Math.max(0, y - padding);
    const right = Math.min(bitmapWidth, x + width + padding);
    const bottom = Math.min(bitmapHeight, y + height + padding);
    if (right > left && bottom > top) ctx.fillRect(left, top, right - left, bottom - top);
  }

  let redactedImageB64: string;
  if (canvas instanceof OffscreenCanvas) {
    const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    redactedImageB64 = await blobToBase64(outBlob);
  } else {
    redactedImageB64 = (canvas as HTMLCanvasElement)
      .toDataURL("image/jpeg", 0.85)
      .split(",")[1];
  }

  return {
    redactedImageB64,
    regionsRedacted: sensitiveRegions.length,
    maskedEntityCount: pseudonymizer.maskedEntityCount(),
  };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(new Error("edgeRedactor: failed to encode redacted blob"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Runs the shared PII regex set (see pseudonymizer.ts) over a plain text
 * string and returns the tokenized/bracketed version. Exposed here too so
 * callers redacting DOM text (not just canvas pixels) can share one code
 * path.
 */
export function redactText(rawText: string): string {
  return pseudonymizer.tokenize(rawText).maskedText;
}
