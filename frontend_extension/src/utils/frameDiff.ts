/**
 * 16x16 canvas perceptual hashing / diffing engine.
 *
 * Used to throttle continuous inference: a new capture is only sent to the
 * backend if its downscaled 16x16 luminance signature differs from the
 * previous capture by at least 3% Mean Absolute Difference (MAD). This
 * keeps CPU/network usage low on pages with animations, blinking cursors,
 * or ticking clocks that would otherwise trigger constant re-analysis.
 */

const GRID_SIZE = 16;
const CHANGE_THRESHOLD = 0.03; // 3%

let previousLuminance: Float32Array | null = null;
let offscreenCanvas: OffscreenCanvas | HTMLCanvasElement | null = null;

function getCanvas(): OffscreenCanvas | HTMLCanvasElement {
  if (offscreenCanvas) return offscreenCanvas;
  if (typeof OffscreenCanvas !== "undefined") {
    offscreenCanvas = new OffscreenCanvas(GRID_SIZE, GRID_SIZE);
  } else {
    const c = document.createElement("canvas");
    c.width = GRID_SIZE;
    c.height = GRID_SIZE;
    offscreenCanvas = c;
  }
  return offscreenCanvas;
}

/**
 * Downscales an ImageBitmap (from a captured screenshot) to a 16x16
 * grayscale luminance signature.
 */
async function computeLuminanceSignature(bitmap: ImageBitmap): Promise<Float32Array> {
  const canvas = getCanvas();
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("frameDiff: unable to acquire 2D context");

  ctx.clearRect(0, 0, GRID_SIZE, GRID_SIZE);
  ctx.drawImage(bitmap, 0, 0, GRID_SIZE, GRID_SIZE);

  const { data } = ctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE);
  const luminance = new Float32Array(GRID_SIZE * GRID_SIZE);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Standard relative luminance weights.
    luminance[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return luminance;
}

function meanAbsoluteDifference(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  // Normalize against the maximum possible per-pixel difference (255) and pixel count.
  return sum / (a.length * 255);
}

export interface FrameDiffResult {
  shouldProcess: boolean;
  deltaPct: number;
}

/**
 * Compares a new screenshot bitmap against the last processed frame.
 * Always updates internal state to the new frame regardless of the result,
 * so subsequent calls diff against the most recent capture.
 */
export async function shouldProcessFrame(bitmap: ImageBitmap): Promise<FrameDiffResult> {
  const currentSignature = await computeLuminanceSignature(bitmap);

  if (!previousLuminance) {
    previousLuminance = currentSignature;
    return { shouldProcess: true, deltaPct: 1.0 }; // first frame always processes
  }

  const delta = meanAbsoluteDifference(previousLuminance, currentSignature);
  previousLuminance = currentSignature;

  return {
    shouldProcess: delta >= CHANGE_THRESHOLD,
    deltaPct: delta,
  };
}

export function resetFrameDiffState(): void {
  previousLuminance = null;
}

/**
 * Generic debounce helper used for DOM mutation / scroll listeners
 * (800ms per the client resource throttling policy).
 */
export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  waitMs = 800
): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: Args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
