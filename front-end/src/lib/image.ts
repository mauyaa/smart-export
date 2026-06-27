// Downscale + recompress a photo before upload.
// Targets ~1600px on the long edge, JPEG quality 0.85.
// Falls back to the original File on any failure.

const MAX_EDGE = 1600;
const QUALITY = 0.85;
const TARGET_TYPE = "image/jpeg";

export async function compressImage(file: File): Promise<File> {
  // Skip tiny files (already small) and non-images.
  if (!file.type.startsWith("image/")) return file;
  if (file.size < 500 * 1024) return file;

  try {
    const bitmap = await loadBitmap(file);
    const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement("canvas"), { width, height });

    const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as
      CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) return file;
    ctx.drawImage(bitmap as CanvasImageSource, 0, 0, width, height);

    const blob = await canvasToBlob(canvas, TARGET_TYPE, QUALITY);
    if (!blob || blob.size >= file.size) return file;

    const baseName = file.name.replace(/\.[^.]+$/, "") || "label";
    return new File([blob], `${baseName}.jpg`, { type: TARGET_TYPE, lastModified: Date.now() });
  } catch {
    return file;
  }
}

function fitWithin(w: number, h: number, max: number) {
  if (w <= max && h <= max) return { width: w, height: h };
  const ratio = w >= h ? max / w : max / h;
  return { width: Math.round(w * ratio), height: Math.round(h * ratio) };
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      /* fall through */
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob | null> {
  if ("convertToBlob" in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }
  return new Promise((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality),
  );
}
