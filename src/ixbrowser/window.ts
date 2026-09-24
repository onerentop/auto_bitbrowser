/**
 * ixBrowser 窗口高层封装
 *
 * 覆盖：窗口列表 / 窗口详情 / 按邮箱找窗口 / 按 ID 打开 / 按 ID 删除 / 下一个窗口名。
 *
 * 设计取舍：
 *   - IxBrowserClient 在出错时直接抛错，这里把「抛错」折算成「返回 null + message」，
 *     重试判定（isRetryableError）、退避（BASE_DELAY * BACKOFF_FACTOR ** attempt）、
 *     最终返回值（null / [] / false）逐条保持既定行为。
 *   - 不维护可重置的全局客户端：每次请求都是独立 fetch，没有需要重建的连接状态。
 *   - 输出走注入的 log。
 */
import type { IxBrowserClient } from "./client.ts";
import type { IxProfile } from "./types.ts";

export const MAX_RETRIES = 3;
export const BASE_DELAY = 1.0;
export const BACKOFF_FACTOR = 2.0;

export const RETRYABLE_ERRORS: readonly string[] = [
  "socket disconnected",
  "tls connection",
  "connection refused",
  "connection reset",
  "network",
  "timeout",
  "process not found",
  "econnrefused",
  "econnreset",
  "etimedout",
];

export function isRetryableError(errorMsg: string | null | undefined): boolean {
  if (!errorMsg) return false;
  const lower = errorMsg.toLowerCase();
  return RETRYABLE_ERRORS.some((k) => lower.includes(k));
}

/** 本模块用到的客户端方法子集（便于测试注入） */
export type IxWindowClient = Pick<IxBrowserClient, "getProfileList" | "openProfile" | "deleteProfile">;

export interface IxWindowDeps {
  client: IxWindowClient;
  /** 毫秒；测试注入可跳过真实等待 */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function errorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  return msg || "Unknown error";
}

/**
 * 通用重试壳：每个窗口操作函数共用的「尝试 N 次」循环。
 * 返回 { ok: true, value } 或 { ok: false }（失败时上层折算成 null / false）。
 */
async function withRetry<T>(
  deps: IxWindowDeps,
  maxRetries: number,
  failLabel: string,
  op: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? (() => {});
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return { ok: true, value: await op() };
    } catch (error) {
      const msg = errorMessage(error);
      if (attempt < maxRetries && isRetryableError(msg)) {
        const delay = BASE_DELAY * BACKOFF_FACTOR ** attempt;
        log(`${failLabel}: ${msg}，${delay.toFixed(1)}秒后重试...`);
        await sleep(delay * 1000);
        continue;
      }
      log(`${failLabel}: ${msg}`);
      return { ok: false };
    }
  }
  return { ok: false };
}

export interface GetBrowserListOptions {
  page?: number;
  limit?: number;
  /** 0 = 全部 */
  groupId?: number;
  /** 是否自动翻页取全量（默认 true） */
  fetchAll?: boolean;
  maxRetries?: number;
}

/**
 * 窗口列表：自动翻页，某页失败时返回已取到的部分（不抛错）。
 * 翻页终止条件：失败 / 空页 / 本页条数 < limit。
 */
export async function getBrowserList(deps: IxWindowDeps, options: GetBrowserListOptions = {}): Promise<IxProfile[]> {
  const limit = options.limit ?? 100;
  const groupId = options.groupId ?? 0;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;

  const fetchPage = async (p: number): Promise<IxProfile[] | null> => {
    const r = await withRetry(deps, maxRetries, "获取列表失败", () =>
      deps.client.getProfileList({ page: p, limit, groupId }),
    );
    return r.ok ? r.value : null;
  };

  if (options.fetchAll === false) {
    return (await fetchPage(options.page ?? 1)) ?? [];
  }

  const all: IxProfile[] = [];
  let page = 1;
  for (;;) {
    const data = await fetchPage(page);
    if (data === null) break; // 获取失败，返回已获取的数据
    if (data.length === 0) break;
    all.push(...data);
    if (data.length < limit) break;
    page += 1;
  }
  return all;
}

/** 查不到或失败返回 null */
export async function getBrowserInfo(
  deps: IxWindowDeps,
  profileId: number,
  maxRetries = MAX_RETRIES,
): Promise<IxProfile | null> {
  const r = await withRetry(deps, maxRetries, "获取窗口信息失败", () =>
    deps.client.getProfileList({ profileId }),
  );
  if (!r.ok || r.value.length === 0) return null;
  return r.value[0] ?? null;
}

/** 空值 / 0 / 非数字一律视为无效 */
function toProfileId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const n = Number(value);
  return Number.isInteger(n) && n !== 0 ? n : null;
}

/** cookies_backup=False, load_profile_info_page=False */
export async function openBrowserById(
  deps: IxWindowDeps,
  profileId: number | string,
  maxRetries = MAX_RETRIES,
): Promise<boolean> {
  const id = toProfileId(profileId);
  if (id === null) return false;
  const r = await withRetry(deps, maxRetries, "窗口打开失败", () =>
    deps.client.openProfile(id, { cookiesBackup: false, loadProfileInfoPage: false }),
  );
  return r.ok;
}

export async function deleteBrowserById(
  deps: IxWindowDeps,
  profileId: number | string,
  maxRetries = MAX_RETRIES,
): Promise<boolean> {
  const id = toProfileId(profileId);
  if (id === null) return false;
  const r = await withRetry(deps, maxRetries, "窗口删除失败", () => deps.client.deleteProfile(id));
  return r.ok;
}

/** `{prefix}_{最大序号+1}` */
export async function getNextWindowName(deps: IxWindowDeps, prefix: string): Promise<string> {
  const browsers = await getBrowserList(deps, { limit: 1000 });
  let maxNum = 0;
  const pattern = `${prefix}_`;
  for (const b of browsers) {
    const name = b.name ?? "";
    if (name.startsWith(pattern)) {
      const suffix = name.slice(pattern.length);
      // 只接受首尾空白与正负号包裹的整数，拒绝小数与空串
      if (/^\s*[+-]?\d+\s*$/.test(suffix)) {
        const num = Number.parseInt(suffix.trim(), 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return `${prefix}_${maxNum + 1}`;
}
