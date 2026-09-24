/**
 * 2FA 验证码用例（首页按窗口 ID、账号页按邮箱）
 *
 * 密钥只在后端：首页 handler 用 extractTfaSecrets 从 ixBrowser 窗口取「窗口 ID → 密钥」，
 * 账号页 handler 从数据库取「邮箱 → secret_key」（登录实际用的就是它）。
 * 界面按 ID / 邮箱来要验证码，这里只返回验证码与本周期结束时间，**绝不返回密钥**。
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

/** 按邮箱算验证码的结果（账号页用）：codes 只含能算出码的邮箱 */
export interface EmailTfaCodesResult {
  codes: Record<string, string>;
  /** 密钥非法（不是 base32）的邮箱 */
  invalid: string[];
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

/** 本周期结束时间（毫秒时间戳） */
function periodEndsAt(nowMs: number): number {
  return (Math.floor(nowMs / TFA_PERIOD_MS) + 1) * TFA_PERIOD_MS;
}

/**
 * 逐键算码的公共实现：没有密钥的键不出现在结果里，密钥非法的进 invalid。
 * 键统一按字符串存（窗口 ID 与邮箱共用这一段）。
 */
function computeInto<T extends string | number>(
  secrets: ReadonlyMap<T, string>,
  keys: readonly T[],
  nowMs: number,
): { codes: Record<string, string>; invalid: T[] } {
  const codes: Record<string, string> = {};
  const invalid: T[] = [];
  for (const key of keys) {
    const secret = secrets.get(key);
    if (secret === undefined) continue;
    try {
      codes[String(key)] = generateTotp(secret, nowMs);
    } catch {
      invalid.push(key);
    }
  }
  return { codes, invalid };
}

/** 按窗口 ID 算当前验证码（首页用）；没有密钥的窗口不出现在结果里，密钥非法的进 invalid */
export function computeTfaCodes(
  secrets: ReadonlyMap<number, string>,
  profileIds: readonly number[],
  nowMs: number,
): TfaCodesResult {
  const { codes, invalid } = computeInto(secrets, profileIds, nowMs);
  // 界面按数字窗口 ID 取值；键在运行时本来就是字符串
  return { codes: codes as Record<number, string>, invalid, periodEndsAt: periodEndsAt(nowMs) };
}

/**
 * 按邮箱算当前验证码（账号页用）。
 * 密钥来自数据库 accounts.secret_key —— 登录实际用的就是它；窗口里的 tfa_secret 只是一份副本。
 */
export function computeEmailTfaCodes(
  secrets: ReadonlyMap<string, string>,
  emails: readonly string[],
  nowMs: number,
): EmailTfaCodesResult {
  const { codes, invalid } = computeInto(secrets, emails, nowMs);
  return { codes, invalid, periodEndsAt: periodEndsAt(nowMs) };
}
