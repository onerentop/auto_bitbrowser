/**
 * 人机验证打码的配置解析。
 *
 * 沿 `src/engine/stagehand-config.ts` 的「可注册来源」先例：engine 层不认识 ConfigManager，
 * 由宿主组合根启动时注册一次（`registerCaptchaConfigSource(() => ctx.config())`）。
 *
 * `resolveCaptchaConfig()` 返回 null 表示「不打码」——调用方据此**不发任何网络请求**：
 *   - 来源未注册（engine 单测 / 未接线）
 *   - provider 不是 capsolver（扩展位，但不假装支持）
 *   - enabled === false
 *   - api_key 为空
 *   - 读配置抛异常
 */

import type { CaptchaConfig } from "./types.ts";

/** 当前唯一支持的打码平台（扩展位：将来加 2captcha 等） */
export const CAPSOLVER_PROVIDER = "capsolver";

/** 默认轮次上限（单次登录最多几轮图片挑战） */
export const DEFAULT_CAPTCHA_MAX_ROUNDS = 3;

/** 默认单次打码请求超时（秒，配置里存秒，`CaptchaConfig.timeoutMs` 是毫秒） */
export const DEFAULT_CAPTCHA_TIMEOUT_SECONDS = 20;

/** ConfigManager 需要提供的最小读取能力（ConfigManager 本身即满足） */
export interface CaptchaConfigSource {
  get(key: string, defaultValue?: unknown): unknown;
}

let registeredSource: (() => CaptchaConfigSource | null) | null = null;

/**
 * 注册「配置来源」。传 null 取消注册。
 * 用工厂而不是实例：宿主的 ConfigManager 是惰性创建的，注册时不必立刻打开配置文件。
 */
export function registerCaptchaConfigSource(source: (() => CaptchaConfigSource | null) | null): void {
  registeredSource = source;
}

/** 取数值：数字直接收；数字字符串（配置手改过）也认；其余回落默认值 */
function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 解析打码配置。返回 null 一律表示「不打码、零请求」。
 *
 * @param source 显式来源（单测注入）；不传则用已注册的来源
 */
export function resolveCaptchaConfig(
  source: CaptchaConfigSource | null = registeredSource?.() ?? null,
): CaptchaConfig | null {
  if (!source) return null;
  try {
    const provider = String(source.get("captcha.provider", CAPSOLVER_PROVIDER) ?? CAPSOLVER_PROVIDER).trim();
    if (provider !== CAPSOLVER_PROVIDER) return null;

    const enabled = source.get("captcha.enabled", true);
    if (enabled === false) return null;

    const apiKey = String(source.get("captcha.api_key", "") ?? "").trim();
    if (!apiKey) return null;

    const maxRounds = Math.max(
      1,
      Math.floor(asNumber(source.get("captcha.max_rounds", DEFAULT_CAPTCHA_MAX_ROUNDS), DEFAULT_CAPTCHA_MAX_ROUNDS)),
    );
    const timeoutSeconds = asNumber(source.get("captcha.timeout", DEFAULT_CAPTCHA_TIMEOUT_SECONDS), DEFAULT_CAPTCHA_TIMEOUT_SECONDS);
    const timeoutMs = Math.max(1000, Math.round(timeoutSeconds * 1000));

    return { provider, apiKey, enabled: true, maxRounds, timeoutMs };
  } catch {
    return null;
  }
}

/** 密钥掩码：空串返回空串，否则 `****` + 后 4 位（日志里只能出现这个） */
export function maskCaptchaKey(key: string): string {
  if (!key) return "";
  return `****${key.slice(-4)}`;
}
