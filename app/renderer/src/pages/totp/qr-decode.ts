/**
 * 渲染层二维码识别（jsQR）
 *
 * 读图用 createImageBitmap(file) + OffscreenCanvas，不生成 blob: / file: URL
 * （index.html 的 CSP 是 img-src 'self' data:，blob: 图片会被拦）。
 *
 * 实现要点：
 *   - 只做「转灰度」这一步预处理；jsQR 内部本身按亮度（灰度）二值化，
 *     等价于这一步，因此不再额外做灰度重试。
 *   - 不做反色重试：用 inversionAttempts: "dontInvert"。
 *   - 有意偏差：jsQR 每张图只返回一个二维码。
 *   - 识别在渲染层异步逐张进行，不阻塞界面。
 */
import jsQR from "jsqr";

/** 识别图片中的二维码文本；没有二维码返回 null；图片无法解码时抛错 */
export async function decodeQrFromFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) return null;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("无法创建画布上下文");
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, width, height);
    const code = jsQR(image.data, width, height, { inversionAttempts: "dontInvert" });
    return code ? code.data : null;
  } finally {
    bitmap.close();
  }
}

/** 支持的图片扩展名（文件选择与拖放共用） */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".bmp", ".gif"];

/** <input type=file accept> 的值 */
export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.join(",");

export function isImageFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
