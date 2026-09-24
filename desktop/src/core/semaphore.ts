/**
 * 并发闸门
 *
 * Node 没有内置的计数信号量，这里实现一个最小的版本，用来控制并发。
 *
 * 语义：
 *   - 初始计数为 n，acquire() 在计数为 0 时挂起，release() 唤醒**最早等待**的那个（FIFO）
 *   - 不可重入，也不做超时
 *
 * 另配一个 `gatherSettled()`：等全部结束后统一返回每条结果，异常不打断其它任务。
 */

export class Semaphore {
  private permits: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore 的许可数必须是正整数，收到: ${permits}`);
    }
    this.permits = permits;
  }

  /** 当前可用许可数 */
  get available(): number {
    return this.permits;
  }

  /** 当前排队等待的数量 */
  get pending(): number {
    return this.waiters.length;
  }

  /** 获取一个许可；无许可时挂起（FIFO 排队） */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 释放一个许可；有等待者时直接把许可交给最早的那个 */
  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits += 1;
  }

  /**
   * 包一层「取许可 → 执行 → 释放」：无论 fn 是否抛错都会释放许可。
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** gatherSettled 的单条结果 */
export type SettledResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/**
 * 对应 `asyncio.gather(*tasks, return_exceptions=True)`：
 * 等所有任务结束，异常被收集而不是抛出，顺序与入参一致。
 */
export async function gatherSettled<T>(tasks: Promise<T>[]): Promise<SettledResult<T>[]> {
  const settled = await Promise.allSettled(tasks);
  return settled.map((s) =>
    s.status === "fulfilled"
      ? ({ ok: true, value: s.value } as const)
      : ({ ok: false, error: s.reason } as const),
  );
}

/** 等待指定毫秒数 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
