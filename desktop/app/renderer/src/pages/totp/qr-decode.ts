/**
 * 渲染层二维码识别 —— 替代 core/totp_extractor/qr_scanner.py 的 pyzbar 部分
 *
 * 读图用 createImageBitmap(file) + OffscreenCanvas，不生成 blob: / file: URL
 * （index.html 的 CSP 是 img-src 'self' data:，blob: 图片会被拦）。
 *
 * 与 Python 的对应：
 *   - scan_qr_from_image（:81-83）只做了「转灰度」这一步预处理；jsQR 内部本身按亮度（灰度）二值化，
 *     等价于这一步，因此不再额外做灰度重试。
 *   - Python 没有反色重试，这里用 inversionAttempts: "dontInvert" 保持一致（Python 有的才做）。
 *   - 有意偏差：jsQR 每张图只返回一个二维码，pyzbar 会返回图中全部二维码。
 *   - 有意偏差：Python 在 UI 线程同步识别，界面会卡住；这里异步逐张识别，不阻塞界面。
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

/** 支持的图片扩展名（对标文件对话框过滤器与拖放判断 :634 / :1037） */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg", ".bmp", ".gif"];

/** <input type=file accept> 的值 */
export const IMAGE_ACCEPT = IMAGE_EXTENSIONS.join(",");

export function isImageFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
