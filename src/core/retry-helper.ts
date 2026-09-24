/**
 * 智能重试框架
 *
 * 设计取舍（改动仅限语言层面，参数/文案/算法一律保留）：
 *   1. 只提供异步重试 `executeAsync`：Node 没有同步阻塞 sleep 的等价物
 *      （`Atomics.wait` 只能在 worker 里用），同步重试语义无法复刻。
 *      需要重试的地方一律走 `executeAsync`。
 *   2. `isRetryable` 判定（重点）：JS 没有异常类层次（网络错误统统是 `Error`，
 *      靠 `code` 字段区分），因此改成「可配置判定函数 + 默认实现」：
 *        默认实现 `defaultIsRetryable` 依次检查
 *          a. `error.code` ∈ RETRYABLE_ERROR_CODES（连接类错误码）
 *          b. `error.name` ∈ RETRYABLE_ERROR_NAMES（TimeoutError / ConnectionError…）
 *          c. 错误消息关键词命中 NETWORK_KEYWORDS
 *      构造参数 `isRetryable` 即判定函数，传入即完全覆盖默认实现。
 *   3. `withRetry(fn, options)` 是高阶函数，不是装饰器：
 *      TS 的 decorator 只能修饰 class 成员，修饰不了自由函数。
 *      `withRetryAsync` 作为同义导出保留。
 *   4. 日志 → 注入的 `LogFn`，默认 `noopLog`（静默），文案逐字保留。
 *   5. `sleep(delay)` → 可注入的 `sleepImpl(ms)`（默认 setTimeout），
 *      单测可传假 sleep 避免真等。**延迟单位是秒，sleepImpl 参数是毫秒**
 *      （与 engine/playwright-compat.ts 的约定一致），转换在调用点 `delay * 1000`。
 *   6. `LogFn` / `noopLog` 在本文件内声明，避免 core 层依赖上层模块。
 *
 * 已知行为（看着可疑但没改）：
 *   - `calculateDelay` **没有抖动（jitter）**，就是纯指数退避 + 上限截断。
 *   - `executeAsync` 失败时返回的是**错误消息字符串**而不是错误对象。
 */

// ==================== 日志与 sleep 注入 ====================

/** 日志回调 */
export type LogFn = (message: string) => void;

/** 默认静默日志 */
export const noopLog: LogFn = () => {};

/** sleep 实现，参数为**毫秒** */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = (ms) => new Promise<void>((r) => setTimeout(r, ms));

// ==================== 重试判定 ====================

/** 可重试判定函数 */
export type RetryPredicate = (error: unknown) => boolean;

/**
 * 错误消息里的网络关键词：命中即视为可重试。
 * 清单顺序不动。
 */
export const NETWORK_KEYWORDS = [
  "timeout",
  "connection",
  "network",
  "socket",
  "refused",
] as const;

/**
 * 可重试的错误码：Node 的系统调用错误带 `code` 字段（连接重置、超时、DNS 失败等）。
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

/** 可重试的错误类名（含 AbortError 等） */
export const RETRYABLE_ERROR_NAMES = [
  "TimeoutError",
  "ConnectionError",
  "ConnectionResetError",
  "AbortError",
] as const;

/** 取错误文本（只有消息，不含类名） */
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
 * 默认可重试判定：先看错误码，再看错误类名，最后看消息关键词。
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

/** 默认最大重试次数，单独导出便于测试覆盖 */
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
  /** 可重试判定函数；传入即完全覆盖默认实现 */
  isRetryable?: RetryPredicate;
  /** 日志回调（默认静默） */
  logCallback?: LogFn;
  /** sleep 实现（毫秒），测试可注入 */
  sleepImpl?: SleepFn;
}

/**
 * 执行结果：
 *   成功 → [true, result]；失败 → [false, errorMessage]
 */
export type RetryOutcome<T> =
  | readonly [success: true, result: T]
  | readonly [success: false, error: string];

/**
 * 重试助手（只支持异步重试，见文件头说明）
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
   * 公开以便单测直接验证。
   * 公式：min(baseDelay * backoffFactor ** attempt, maxDelay)，**无抖动**。
   */
  calculateDelay(attempt: number): number {
    const delay = this.baseDelay * Math.pow(this.backoffFactor, attempt);
    return Math.min(delay, this.maxDelay);
  }

  /** 判断错误是否可重试 */
  isRetryable(error: unknown): boolean {
    return this.retryPredicate(error);
  }

  /**
   * 执行函数并自动重试。
   * `await` 对同步函数与异步函数都成立，因此不需要区分两者。
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

    // 一次都没执行过时（lastError 为 undefined）走 "未知错误"
    const errMsg = hasError ? errorMessage(lastError) : "未知错误";
    return [false, errMsg] as const;
  }
}

// ==================== withRetry（重试高阶函数） ====================

export interface WithRetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  backoffFactor?: number;
  /** 以下三项为可测性补上 */
  maxDelay?: number;
  isRetryable?: RetryPredicate;
  logCallback?: LogFn;
  sleepImpl?: SleepFn;
}

/**
 * 重试高阶函数（包一层返回新函数 —— TS 的 decorator 修饰不了自由函数）：
 *
 *   const safeFetch = withRetry(fetchSomething, { maxRetries: 3 });
 *   const value = await safeFetch(arg);
 *
 * 行为：成功返回结果，重试用尽后 `throw new Error(错误消息)`。
 * 包装后的函数**恒为 async**。
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
 * `withRetry` 的同义导出。
 */
export const withRetryAsync = withRetry;
