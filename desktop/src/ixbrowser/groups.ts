/**
 * ixBrowser 分组列表 —— 对标 services/ix_api.py:686 get_group_list
 *
 * 容错语义照搬 Python：
 *   - 可重试错误（_is_retryable_error）按 BASE_DELAY * BACKOFF_FACTOR ** attempt 退避重试
 *   - 不可重试或重试耗尽 → 返回 []，**永不抛错**
 * Node 版 IxBrowserClient 出错时直接抛错，这里把 Python 的「返回 None」与「抛异常」两条分支
 * 合并处理（两者在 Python 里的结局相同：重试或返回 []）。
 * 额外容错：服务端 data 不是数组时也返回 []（Python 会原样返回，调用方 `or []` 兜底）。
 */
import type { IxBrowserClient } from "./client.ts";
import { BACKOFF_FACTOR, BASE_DELAY, MAX_RETRIES, isRetryableError } from "./window.ts";

export type IxGroupClient = Pick<IxBrowserClient, "getGroupList">;

export interface IxGroupDeps {
  client: IxGroupClient;
  /** 毫秒；测试注入可跳过真实等待 */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface GetGroupListOptions {
  page?: number;
  limit?: number;
  maxRetries?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function getGroupList(deps: IxGroupDeps, options: GetGroupListOptions = {}): Promise<unknown[]> {
  const page = options.page ?? 1;
  const limit = options.limit ?? 100;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const sleep = deps.sleep ?? realSleep;
  const log = deps.log ?? (() => {});

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await deps.client.getGroupList(page, limit);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      const msg = (error instanceof Error ? error.message : String(error)) || "Unknown error";
      if (attempt < maxRetries && isRetryableError(msg)) {
        const delay = BASE_DELAY * BACKOFF_FACTOR ** attempt;
        log(`获取分组列表异常: ${msg}，${delay.toFixed(1)}秒后重试...`);
        await sleep(delay * 1000);
        continue;
      }
      log(`获取分组列表异常: ${msg}`);
      return [];
    }
  }
  return [];
}
