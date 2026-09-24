/**
 * 标准 otpauth:// URI 解析
 *
 * 有意偏差：没有用 WHATWG `URL`，而是用 compat.ts 里的 urlsplit / parse_qs / unquote 实现。
 * 原因：差异集中在三处 —— URL 对非特殊 scheme 的 host / path 处理不同、不保留空值参数
 * （digits= 空值时应取默认 6，用 URL 会得到 "" 再 int 报错）、非法 host 直接抛 TypeError；
 * 改用 URL 会让对拍夹具失败。
 */
import type { OTPAccount } from "./migration-decoder.ts";
import { parseQs, toInt, unquote, urlSplit } from "./compat.ts";

function first(params: Map<string, string[]>, key: string, fallback: string): string {
  const list = params.get(key);
  return list && list.length > 0 ? (list[0] as string) : fallback;
}

/** 解析 otpauth://totp/Label?secret=...&issuer=...；scheme 不是 otpauth 返回 null；digits/counter 非整数抛错 */
export function parseStandardOtpauthUri(uri: string): OTPAccount | null {
  const parsed = urlSplit(uri);
  if (parsed.scheme !== "otpauth") return null;

  const otpType = parsed.netloc; // totp or hotp

  // 提取标签（可能包含 issuer:name）
  const label = unquote(parsed.path.replace(/^\/+/, ""));

  const params = parseQs(parsed.query);
  const secret = first(params, "secret", "");
  let issuer = first(params, "issuer", "");
  const algorithm = first(params, "algorithm", "SHA1").toUpperCase();
  const digits = toInt(first(params, "digits", "6"));
  const counter = toInt(first(params, "counter", "0"));

  // 从标签中提取 issuer 和 name
  let name: string;
  if (label.includes(":")) {
    const idx = label.indexOf(":");
    if (!issuer) issuer = label.slice(0, idx);
    name = label.slice(idx + 1);
  } else {
    name = label;
  }

  return {
    secret: secret.toUpperCase(),
    name,
    issuer,
    algorithm,
    digits,
    otp_type: otpType,
    counter,
  };
}
