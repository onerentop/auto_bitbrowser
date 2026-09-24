/**
 * 首页 2FA 验证码用例
 *
 * 密钥只在后端：handler 每次刷新列表时用 extractTfaSecrets 缓存「窗口 ID → 密钥」，
 * 界面按窗口 ID 来要验证码，computeTfaCodes 只返回验证码与本周期结束时间，**绝不返回密钥**。
 * 算法复用引擎的 generateTotp（30 秒周期、6 位、HMAC-SHA1，密钥里的空白先去掉）。
 */
import { generateTotp } from "../engine/totp.ts";

export const TFA_PERIOD_MS = 30_000;

export interface TfaCodesResult {
  /** 能算出码的窗口：ID → 6 位验证码 */
  codes: Record<number, string>;
  /** 密钥非法（不是 base32）的窗口 ID */
  invalid: number[];
  /** 本周期结束时间（毫秒时间戳），届时验证码会变 */
  periodEndsAt: number;
}

function asProfileId(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** 从 ixBrowser 窗口原始数据里取「窗口 ID → 密钥（去空白）」；没有 ID 或密钥为空的跳过 */
export function extractTfaSecrets(browsers: readonly unknown[]): Map<number, string> {
  const secrets = new Map<number, string>();
  for (const raw of browsers) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const b = raw as Record<string, unknown>;
    const id = asProfileId(b["profile_id"]);
    const secret = typeof b["tfa_secret"] === "string" ? b["tfa_secret"].replace(/\s+/g, "") : "";
    if (id === null || secret === "") continue;
    secrets.set(id, secret);
  }
  return secrets;
}

/** 按窗口 ID 算当前验证码；没有密钥的窗口不出现在结果里，密钥非法的进 invalid */
export function computeTfaCodes(
  secrets: ReadonlyMap<number, string>,
  profileIds: readonly number[],
  nowMs: number,
): TfaCodesResult {
  const codes: Record<number, string> = {};
  const invalid: number[] = [];
  for (const id of profileIds) {
    const secret = secrets.get(id);
    if (secret === undefined) continue;
    try {
      codes[id] = generateTotp(secret, nowMs);
    } catch {
      invalid.push(id);
    }
  }
  return { codes, invalid, periodEndsAt: (Math.floor(nowMs / TFA_PERIOD_MS) + 1) * TFA_PERIOD_MS };
}
