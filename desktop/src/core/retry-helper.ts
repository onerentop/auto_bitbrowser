/**
 * 智能重试框架（Node 重写）
 * 对标 core/retry_helper.py（292 行主体 + 测试段）
 *
 * 移植差异（逐条说明，改动仅限语言层面，参数/文案/算法一律照搬）：
 *   1. `RetryHelper.execute_sync` **不移植**：Node 没有同步阻塞 sleep 的等价物
 *      （`Atomics.wait` 只能在 worker 里用），同步重试语义无法复刻。
 *      需要重试的地方一律走 `executeAsync`。
 *   2. `_is_retryable` 的语义差（重点）：
 *      Python 先按异常**类型**判定 `isinstance(e, RETRYABLE_EXCEPTIONS)`，
 *      类型清单为：TimeoutError / ConnectionError / ConnectionResetError / OSError
 *      （注意 ConnectionError、ConnectionResetError 都是 OSError 的子类，
 *        所以实际等价于「TimeoutError 或任意 OSError」）。
 *      JS 没有对应的异常类层次（网络错误统统是 `Error`，靠 `code` 字段区分），
 *      因此改成「可配置判定函数 + 默认实现」：
 *        默认实现 `defaultIsRetryable` 依次检查
 *          a. `error.code` ∈ RETRYABLE_ERROR_CODES（对应 Python 的 OSError 家族）
 *          b. `error.name` ∈ RETRYABLE_ERROR_NAMES（对应 TimeoutError/ConnectionError…）
 *          c. 错误消息关键词命中 NETWORK_KEYWORDS —— 这一条与 Python 第二段判定**逐字相同**
 *      构造参数 `isRetryable` 对应 Python 的 `retryable_exceptions`，传入即完全覆盖默认实现。
 *   3. `with_retry` / `with_retry_async` 两个装饰器 → 高阶函数 `withRetry(fn, options)`：
 *      TS 的 decorator 只能修饰 class 成员，修饰不了自由函数。
 *      两个 Python 装饰器在这里合并为一个（因为 execute_sync 没移植），
 *      `withRetryAsync` 作为同义导出保留，方便逐行对照 Python 调用点。
 *   4. `FailedTaskQueue` 由「类方法 + 类级状态」改为可实例化的类 + 默认单例
 *      `failedTaskQueue`，并导出与 Python 同名（camelCase 化）的模块级便捷函数委托给单例。
 *      Python 的 `threading.Lock` 无对应物（Node 单线程 + 这里全是同步操作），已省略。
 *      Python 在模块末尾 `FailedTaskQueue.load()` 自动加载；TS **不做 import 期副作用**，
 *      需要时显式调用 `failedTaskQueue.load()`。
 *   5. `print(...)` / 日志 → 注入的 `LogFn`（默认 `noopLog`），文案逐字保留。
 *      注意 Python 里 `RetryHelper.log_callback` 默认是 `print`（会打印到控制台），
 *      TS 默认静默；FailedTaskQueue 的 save/load 失败提示同理。
 *   6. `asyncio.sleep(delay)` → 可注入的 `sleepImpl(ms)`（默认 setTimeout），
 *      单测可传假 sleep 避免真等。**Python 的延迟单位是秒，sleepImpl 参数是毫秒**
 *      （与 engine/playwright-compat.ts 的约定一致），转换在调用点 `delay * 1000`。
 *   7. `LogFn` / `noopLog` 在本文件内声明，避免 core 层依赖上层模块。
 *
 * 保留的 Python 行为（看着可疑但没改）：
 *   - `_calculate_delay` **没有抖动（jitter）**，就是纯指数退避 + 上限截断。
 *   - `execute_async` 失败时返回的是**错误消息字符串**而不是错误对象。
 *   - `FailedTaskQueue.add` 命中已有任务时只 +1 重试次数并刷新时间，不追加新任务。
 *   - `FailedTaskQueue.load` 在文件不存在时**保持现有内存状态不变**（不清空）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ==================== 日志与 sleep 注入 ====================

/** 日志回调（对应 Python 的 log_callback / print） */
export type LogFn = (message: string) => void;

/** 默认静默日志 */
export const noopLog: LogFn = () => {};

/** sleep 实现，参数为**毫秒** */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise<void>((r) => setTimeout(r, ms));

// ==================== 基础路径 ====================

/**
 * 对应 Python 的 get_base_path()：
 *   打包态取 exe 目录，否则取 core/ 的上一级 —— 即仓库根。
 * Node 侧固定按源码位置推导：desktop/src/core → 上三级 = 仓库根。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASE_PATH = path.resolve(HERE, "..", "..", "..");

/** 与 Python 的 FailedTaskQueue.FAILED_TASKS_FILE 同名同位置 */
export const FAILED_TASKS_FILE = path.join(BASE_PATH, "failed_tasks.json");

// ==================== 重试判定 ====================

/** 可重试判定函数（对应 Python 的 retryable_exceptions 元组） */
export type RetryPredicate = (error: unknown) => boolean;

/**
 * 对应 Python `_is_retryable` 第二段：错误消息里的网络关键词。
 * 关键词清单与 Python 逐字一致，顺序不动。
 */
export const NETWORK_KEYWORDS = [
  "timeout",
  "connection",
  "network",
  "socket",
  "refused",
] as const;

/**
 * 对应 Python 的 OSError 家族（含 ConnectionError / ConnectionResetError）。
 * Node 的系统调用错误带 `code` 字段，用它替代 isinstance 判定。
 */
export const RETRYABLE_ERROR_CODES = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRINUSE",
  "EADDRNOTAVAIL",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
] as const;

/** 对应 Python 的 TimeoutError / ConnectionError / ConnectionResetError 类名 */
export const RETRYABLE_ERROR_NAMES = [
  "TimeoutError",
  "ConnectionError",
  "ConnectionResetError",
  "AbortError",
] as const;

/** 取错误文本：对应 Python 的 str(exception)（只有消息，不含类名） */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);
  try {
    return String(error);
  } catch {
    return "";
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === "object" && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/**
 * 默认可重试判定（对应 Python `_is_retryable` 的完整逻辑）。
 * a/b 两段替代 isinstance 检查，c 段与 Python 逐字一致。
 */
export function defaultIsRetryable(error: unknown): boolean {
  const code = errorCode(error);
  if (code && (RETRYABLE_ERROR_CODES as readonly string[]).includes(code)) return true;

  const name = errorName(error);
  if (name && (RETRYABLE_ERROR_NAMES as readonly string[]).includes(name)) return true;

  const msg = errorMessage(error).toLowerCase();
  return NETWORK_KEYWORDS.some((keyword) => msg.includes(keyword));
}

// ==================== RetryHelper ====================

/** Python `RetryHelper.__init__` 的默认值，单独导出便于对拍 */
export const DEFAULT_MAX_RETRIES = 3;
/** 单位：秒 */
export const DEFAULT_BASE_DELAY = 2.0;
export const DEFAULT_BACKOFF_FACTOR = 2.0;
/** 单位：秒 */
export const DEFAULT_MAX_DELAY = 60.0;

export interface RetryHelperOptions {
  /** 最大重试次数（总执行次数 = maxRetries + 1） */
  maxRetries?: number;
  /** 基础延迟，单位秒 */
  baseDelay?: number;
  /** 退避因子：delay = baseDelay * (backoffFactor ^ attempt) */
  backoffFactor?: number;
  /** 最大延迟，单位秒 */
  maxDelay?: number;
  /** 可重试判定，对应 Python 的 retryable_exceptions；传入即完全覆盖默认实现 */
  isRetryable?: RetryPredicate;
  /** 日志回调，对应 Python 的 log_callback（Python 默认 print，这里默认静默） */
  logCallback?: LogFn;
  /** sleep 实现（毫秒），测试可注入 */
  sleepImpl?: SleepFn;
}

/**
 * 执行结果，对应 Python 的 Tuple[bool, Any]：
 *   成功 → [true, result]；失败 → [false, errorMessage]
 */
export type RetryOutcome<T> =
  | readonly [success: true, result: T]
  | readonly [success: false, error: string];

/**
 * 重试助手
 * 对应 Python 的 RetryHelper（同步重试未移植，见文件头说明）
 */
export class RetryHelper {
  readonly maxRetries: number;
  readonly baseDelay: number;
  readonly backoffFactor: number;
  readonly maxDelay: number;
  readonly logCallback: LogFn;

  private readonly retryPredicate: RetryPredicate;
  private readonly sleep: SleepFn;

  constructor(options: RetryHelperOptions = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY;
    this.backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    this.maxDelay = options.maxDelay ?? DEFAULT_MAX_DELAY;
    this.retryPredicate = options.isRetryable ?? defaultIsRetryable;
    this.logCallback = options.logCallback ?? noopLog;
    this.sleep = options.sleepImpl ?? defaultSleep;
  }

  /**
   * 计算延迟（指数退避），单位秒。
   * 对应 Python `_calculate_delay`（Python 是下划线私有，这里公开以便单测对拍）。
   * 公式：min(baseDelay * backoffFactor ** attempt, maxDelay)，**无抖动**。
   */
  calculateDelay(attempt: number): number {
    const delay = this.baseDelay * Math.pow(this.backoffFactor, attempt);
    return Math.min(delay, this.maxDelay);
  }

  /** 判断错误是否可重试。对应 Python `_is_retryable` */
  isRetryable(error: unknown): boolean {
    return this.retryPredicate(error);
  }

  /**
   * 执行函数并自动重试。对应 Python `execute_async`。
   * Python 用 `asyncio.iscoroutinefunction` 区分同步/异步函数；
   * TS 里 `await` 对两者都成立，因此不需要分支。
   */
  async executeAsync<A extends unknown[], R>(
    func: (...args: A) => R | Promise<R>,
    ...args: A
  ): Promise<RetryOutcome<Awaited<R>>> {
    let lastError: unknown = undefined;
    let hasError = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = (await func(...args)) as Awaited<R>;
        return [true, result] as const;
      } catch (e) {
        lastError = e;
        hasError = true;

        if (attempt < this.maxRetries && this.isRetryable(e)) {
          const delay = this.calculateDelay(attempt);
          this.logCallback(
            `[重试] 第${attempt + 1}次失败: ${errorMessage(e).slice(0, 50)}... ` +
              `将在${delay.toFixed(1)}秒后重试 (${attempt + 1}/${this.maxRetries})`,
          );
          await this.sleep(delay * 1000);
        } else {
          break;
        }
      }
    }

    // 对应 Python: str(last_exception) if last_exception else "未知错误"
    // （Python 里异常对象恒为真值，只有一次都没执行时才会走 "未知错误"）
    const errMsg = hasError ? errorMessage(lastError) : "未知错误";
    return [false, errMsg] as const;
  }
}

// ==================== FailedTaskQueue ====================

/** 失败任务记录。字段名保持 snake_case，与 Python 写出的 JSON 完全一致 */
export interface FailedTask {
  id: string;
  type: string;
  context: Record<string, unknown>;
  failed_at: string;
  retry_count: number;
}

/** 与 Python `time.strftime("%Y-%m-%d %H:%M:%S")` 等价（本地时区） */
function formatTimestamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** 工厂：字段全必需，默认值在这里补齐 */
export function createFailedTask(
  overrides: Partial<FailedTask> & { id: string; type: string },
): FailedTask {
  return {
    id: overrides.id,
    type: overrides.type,
    context: overrides.context ?? {},
    failed_at: overrides.failed_at ?? formatTimestamp(),
    retry_count: overrides.retry_count ?? 0,
  };
}

export interface FailedTaskQueueOptions {
  /** 持久化文件路径，默认与 Python 一致（仓库根 / failed_tasks.json） */
  filePath?: string;
  /** 日志回调（Python 用 print） */
  logCallback?: LogFn;
  /** 时间戳生成，测试可注入 */
  now?: () => Date;
}

/**
 * 失败任务队列
 * 对应 Python 的 FailedTaskQueue（类方法 + 类级状态 → 实例 + 默认单例）
 */
export class FailedTaskQueue {
  readonly filePath: string;

  private tasks: FailedTask[] = [];
  private readonly logCallback: LogFn;
  private readonly now: () => Date;

  constructor(options: FailedTaskQueueOptions = {}) {
    this.filePath = options.filePath ?? FAILED_TASKS_FILE;
    this.logCallback = options.logCallback ?? noopLog;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 添加失败任务。
   * 已存在（id + type 均相同）时只把 retry_count +1 并刷新 failed_at，不追加新记录。
   */
  add(taskId: string, taskType: string, context: Record<string, unknown> | null = null): void {
    const failedAt = formatTimestamp(this.now());

    for (const t of this.tasks) {
      if (t.id === taskId && t.type === taskType) {
        t.retry_count += 1;
        t.failed_at = failedAt;
        return;
      }
    }

    this.tasks.push({
      id: taskId,
      type: taskType,
      context: context ?? {},
      failed_at: failedAt,
      retry_count: 0,
    });
  }

  /** 移除任务（成功后调用）。taskType 省略时移除该 id 的全部类型 */
  remove(taskId: string, taskType: string | null = null): void {
    this.tasks = this.tasks.filter(
      (t) => !(t.id === taskId && (taskType === null || t.type === taskType)),
    );
  }

  /** 获取所有失败任务（返回浅拷贝数组，与 Python 的 .copy() / 列表推导一致） */
  getAll(taskType: string | null = null): FailedTask[] {
    if (taskType) return this.tasks.filter((t) => t.type === taskType);
    return [...this.tasks];
  }

  /** 获取失败任务的 ID 列表 */
  getIds(taskType: string | null = null): string[] {
    return this.getAll(taskType).map((t) => t.id);
  }

  /** 获取失败任务数量 */
  count(taskType: string | null = null): number {
    return this.getAll(taskType).length;
  }

  /** 清空失败任务（可按类型） */
  clear(taskType: string | null = null): void {
    if (taskType) {
      this.tasks = this.tasks.filter((t) => t.type !== taskType);
    } else {
      this.tasks = [];
    }
  }

  /** 保存到文件（对应 json.dump(..., ensure_ascii=False, indent=2)，无结尾换行） */
  save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.tasks, null, 2), "utf-8");
    } catch (e) {
      this.logCallback(`[FailedTaskQueue] 保存失败: ${errorMessage(e)}`);
    }
  }

  /**
   * 从文件加载。
   * 文件不存在 → 保持现状不变（与 Python 一致）；读/解析失败 → 清空为 []。
   * 差异：Python 不校验 JSON 顶层类型（读到 dict 也会直接赋值），
   * TS 类型上不允许，非数组按「加载失败」处理并清空。
   */
  load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("failed_tasks.json 顶层不是数组");
      this.tasks = parsed as FailedTask[];
    } catch (e) {
      this.logCallback(`[FailedTaskQueue] 加载失败: ${errorMessage(e)}`);
      this.tasks = [];
    }
  }
}

/**
 * 默认单例，对应 Python 的类级状态。
 * 注意：Python 在模块末尾会自动 `FailedTaskQueue.load()`，TS 不做 import 期副作用，
 * 需要恢复历史失败任务时请显式调用 `failedTaskQueue.load()`。
 */
export const failedTaskQueue = new FailedTaskQueue();

// —— 与 Python 类方法同名（camelCase 化）的模块级便捷函数，全部委托给单例 ——

/** 对应 FailedTaskQueue.add */
export function add(
  taskId: string,
  taskType: string,
  context: Record<string, unknown> | null = null,
): void {
  failedTaskQueue.add(taskId, taskType, context);
}

/** 对应 FailedTaskQueue.remove */
export function remove(taskId: string, taskType: string | null = null): void {
  failedTaskQueue.remove(taskId, taskType);
}

/** 对应 FailedTaskQueue.get_all */
export function getAll(taskType: string | null = null): FailedTask[] {
  return failedTaskQueue.getAll(taskType);
}

/** 对应 FailedTaskQueue.get_ids */
export function getIds(taskType: string | null = null): string[] {
  return failedTaskQueue.getIds(taskType);
}

/** 对应 FailedTaskQueue.count */
export function count(taskType: string | null = null): number {
  return failedTaskQueue.count(taskType);
}

/** 对应 FailedTaskQueue.clear */
export function clear(taskType: string | null = null): void {
  failedTaskQueue.clear(taskType);
}

/** 对应 FailedTaskQueue.save */
export function save(): void {
  failedTaskQueue.save();
}

/** 对应 FailedTaskQueue.load */
export function load(): void {
  failedTaskQueue.load();
}

// ==================== withRetry（对应两个装饰器） ====================

export interface WithRetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  backoffFactor?: number;
  /** 以下三项是 Python 装饰器没有暴露的，TS 侧为可测性补上 */
  maxDelay?: number;
  isRetryable?: RetryPredicate;
  logCallback?: LogFn;
  sleepImpl?: SleepFn;
}

/**
 * 重试高阶函数，对应 Python 的 @with_retry / @with_retry_async。
 * 差异：TS 的 decorator 修饰不了自由函数，因此改为「包一层返回新函数」：
 *
 *   const safeFetch = withRetry(fetchSomething, { maxRetries: 3 });
 *   const value = await safeFetch(arg);
 *
 * 行为对齐 Python：成功返回结果，重试用尽后 `throw new Error(错误消息)`
 * （Python 是 `raise Exception(result)`，result 即错误消息字符串）。
 * 包装后的函数**恒为 async**（Python 的同步版依赖 execute_sync，未移植）。
 */
export function withRetry<A extends unknown[], R>(
  fn: (...args: A) => R | Promise<R>,
  options: WithRetryOptions = {},
): (...args: A) => Promise<Awaited<R>> {
  const helperOptions: RetryHelperOptions = {
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelay: options.baseDelay ?? DEFAULT_BASE_DELAY,
    backoffFactor: options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
    maxDelay: options.maxDelay ?? DEFAULT_MAX_DELAY,
  };
  if (options.isRetryable) helperOptions.isRetryable = options.isRetryable;
  if (options.logCallback) helperOptions.logCallback = options.logCallback;
  if (options.sleepImpl) helperOptions.sleepImpl = options.sleepImpl;

  return async (...args: A): Promise<Awaited<R>> => {
    const helper = new RetryHelper(helperOptions);
    const [success, value] = await helper.executeAsync(fn, ...args);
    if (success) return value;
    throw new Error(value);
  };
}

/**
 * `withRetry` 的同义导出，对应 Python 的 `with_retry_async`。
 * 两个 Python 装饰器在 Node 侧合并为同一个实现。
 */
export const withRetryAsync = withRetry;
