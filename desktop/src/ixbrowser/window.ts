/**
 * ixBrowser 窗口高层封装 —— 对标 services/ix_window.py
 *
 * 移植范围：get_browser_list / get_browser_info / find_browser_by_email /
 * open_browser_by_id / delete_browser_by_id / get_next_window_name。
 *
 * 与 Python 的对应关系：
 *   - Python 的 IXBrowserClient 出错时返回 None 并把原因放在 client.message；
 *     Node 版 IxBrowserClient 直接抛错。这里把「抛错」折算成 Python 的「返回 None + message」，
 *     重试判定（_is_retryable_error）、退避（BASE_DELAY * BACKOFF_FACTOR ** attempt）、
 *     最终返回值（None / [] / False）逐条照搬。
 *   - _reset_client()：Python 丢弃全局单例以重建 TCP 连接；Node 客户端每次请求都是独立 fetch，
 *     没有可重置的状态，因此省略。
 *   - print → 注入的 log。
 */
import type { IxBrowserClient } from "./client.ts";
import type { IxProfile } from "./types.ts";

export const MAX_RETRIES = 3;
export const BASE_DELAY = 1.0;
export const BACKOFF_FACTOR = 2.0;

/** 对标 RETRYABLE_ERRORS */
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

/** 对标 _is_retryable_error */
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
 * 通用重试壳：对标 Python 每个函数里重复的 for attempt 循环。
 * 返回 { ok: true, value } 或 { ok: false }（对应 Python 的 return None / False）。
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
 * 对标 get_browser_list：自动翻页，某页失败时返回已取到的部分（不抛错）。
 * 翻页终止条件与 Python 一致：失败 / 空页 / 本页条数 < limit。
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

/** 对标 get_browser_info：查不到或失败返回 null */
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

/** 对标 find_browser_by_email：按 name 或 username 精确匹配，未找到返回 null */
export async function findBrowserByEmail(deps: IxWindowDeps, email: string): Promise<number | null> {
  if (!email) return null;
  const browsers = await getBrowserList(deps, { limit: 1000 });
  for (const b of browsers) {
    if (b.name === email || b.username === email) return b.profile_id ?? null;
  }
  return null;
}

/** Python 的 `int(profile_id) if profile_id else None`：空值 / 0 / 非数字一律视为无效 */
function toProfileId(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const n = Number(value);
  return Number.isInteger(n) && n !== 0 ? n : null;
}

/** 对标 open_browser_by_id（cookies_backup=False, load_profile_info_page=False） */
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

/** 对标 delete_browser_by_id */
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

/** 对标 get_next_window_name：`{prefix}_{最大序号+1}` */
export async function getNextWindowName(deps: IxWindowDeps, prefix: string): Promise<string> {
  const browsers = await getBrowserList(deps, { limit: 1000 });
  let maxNum = 0;
  const pattern = `${prefix}_`;
  for (const b of browsers) {
    const name = b.name ?? "";
    if (name.startsWith(pattern)) {
      const suffix = name.slice(pattern.length);
      // Python int() 接受首尾空白与正负号，拒绝小数与空串
      if (/^\s*[+-]?\d+\s*$/.test(suffix)) {
        const num = Number.parseInt(suffix.trim(), 10);
        if (num > maxNum) maxNum = num;
      }
    }
  }
  return `${prefix}_${maxNum + 1}`;
}
