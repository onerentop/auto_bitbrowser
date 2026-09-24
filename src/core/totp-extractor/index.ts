/**
 * TOTP 密钥提取模块统一入口
 *
 * 二维码识别本身（图片 → 二维码文本）由渲染层 jsQR 完成；这里只负责「拿到二维码文本之后」的部分。
 */
import { parseOtpauthMigrationUri, type OTPAccount } from "./migration-decoder.ts";
import { parseStandardOtpauthUri } from "./otpauth-uri.ts";

export {
  decodeMigrationPayload,
  getOtpEmail,
  parseOtpauthMigrationUri,
  parseOtpParameters,
  readLengthDelimited,
  readVarint,
  type OTPAccount,
} from "./migration-decoder.ts";
export { parseStandardOtpauthUri } from "./otpauth-uri.ts";

/** 图片里没识别到二维码时的错误文案 */
export const NO_QR_FOUND = "未在图片中找到 QR 码";

export interface ExtractResult {
  accounts: OTPAccount[];
  errors: string[];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 从二维码文本列表提取 TOTP 账号：
 * 逐个解析二维码文本（otpauth-migration:// 或 otpauth://），单条失败不影响其余。
 */
export function extractTotpSecretsFromContents(contents: readonly string[]): ExtractResult {
  if (contents.length === 0) return { accounts: [], errors: [NO_QR_FOUND] };

  const accounts: OTPAccount[] = [];
  const errors: string[] = [];
  for (const content of contents) {
    try {
      if (content.startsWith("otpauth-migration://")) {
        // Google Authenticator 迁移格式
        accounts.push(...parseOtpauthMigrationUri(content));
      } else if (content.startsWith("otpauth://")) {
        // 标准 OTP URI
        const account = parseStandardOtpauthUri(content);
        if (account) accounts.push(account);
      } else {
        // 按码点截断到 50 个字符
        errors.push(`未知的 QR 码格式: ${Array.from(content).slice(0, 50).join("")}...`);
      }
    } catch (e) {
      errors.push(`解析 QR 码失败: ${errorText(e)}`);
    }
  }
  return { accounts, errors };
}
