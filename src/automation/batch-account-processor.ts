/**
 * 批量账号处理器
 *
 * 本文件覆盖：构造与日志 / 停止控制、batch_login 与信号量包装、quick_batch_login；
 * BatchResult 那组类型在 ./batch/types.ts。
 *
 * 设计取舍（判定分支与日志文案保持既有行为不变）：
 *   1. 依赖注入：所有外部依赖统一收进构造函数第二参 `BatchProcessorDeps`，
 *      默认值是真实实现，单测可整体替身、完全离线。
 *   2. `accountRepo` 可不注入（默认 null），未注入时登录状态写库被跳过 —— 这是有意的离线设计。
 *   3. 本文件用的登录适配器没有 api_key/model/provider 参数，
 *      默认适配器会丢弃它们（见 makeDefaultLoginFn）。
 *   4. 时间戳统一用毫秒 `Date.now()`；等待统一走 `sleepImpl(毫秒)`。
 *   5. 耗时保留 1 位小数用 `toFixed(1)`（半数进位规则在 .05 边界上略有不同，耗时场景无影响）；
 *      空值打印成 "None" 字面量。
 *   6. 可空字段一律写成 `| null`。
 */

import { RetryHelper, errorMessage } from "../core/retry-helper.ts";
import { Semaphore, gatherSettled, sleep as defaultSleep } from "../core/semaphore.ts";
import {
  addFailed,
  addSkipped,
  addSuccess,
  batchDurationSeconds,
  createBatchResult,
  type BatchResult,
} from "./batch/types.ts";
import { autoGoogleLogin } from "./auto-google-login.ts";
import { AccountRepository } from "../db/account-repository.ts";
import type { Db } from "../db/connection.ts";

// ==================== 基础类型 ====================

/** 进度回调 */
export type ProgressCallback = (msg: string) => void;

/** 单个账号的处理结果（回调给编排层：成功 / 失败 / 因停止跳过） */
export type AccountDoneStatus = "success" | "failed" | "skipped";

/**
 * 单个账号结束时的回调。
 * 编排层用它同时做三件事：逐条目上报（任务历史）、精确进度、按结果收尾（登录成功后关窗）。
 */
export type AccountDoneCallback = (email: string, status: AccountDoneStatus, message: string) => void;

/** 账号字典 */
export type AccountDict = Record<string, unknown>;

// ==================== 注入接口（只声明实际用到的方法） ====================

/**
 * 配置读取接口。
 * 真实实现：core/config-manager.ts 的 `ConfigManager`（由组合根创建后注入，方法名一致）。
 */
export interface ConfigManagerLike {
  getLoginConcurrency(): number;
  getLoginMaxRetries(): number;
  getLoginRetryDelay(): number;
}

/**
 * 账号相关写库调用。
 * 真实实现：db/account-repository.ts 的 `AccountRepository`
 * （默认登录适配器把它透传给 auto-google-login 写 login_status）
 */
export type AccountRepoLike = Pick<AccountRepository, "updateLoginStatus">;

// ==================== 登录函数的注入签名 ====================

/** 批量处理器读取的登录结果字段 */
export interface BatchLoginResult {
  success: boolean;
  message: string;
  errorType?: string | null;
  totalSteps?: number | null;
}

/** 登录函数的签名 */
export type LoginFn = (args: {
  browserId: string;
  account: AccountDict;
  callback: ProgressCallback | null;
  apiKey: string | null;
  model: string | null;
  provider: string | null;
}) => Promise<BatchLoginResult>;

// ==================== 依赖集合 ====================

export interface BatchProcessorDeps {
  /** 配置（必填）：生产由组合根注入 ConfigManager，测试注入假对象；不再有默认单例兜底 */
  config: ConfigManagerLike;
  /**
   * 数据库连接。给了它就会自动构造 accountRepo，
   * 这是生产路径推荐的注入方式（没有进程级数据库单例，
   * 打开哪个库必须由调用方决定，所以不能在此处默认 openDb）。
   */
  db?: Db;
  /** 不给则由 `db` 构造；两者都不给时，账号表读写被跳过并在构造时告警 */
  accountRepo?: AccountRepoLike | null;
  /** 单位毫秒，默认 core/semaphore.ts 的 sleep */
  sleepImpl?: (ms: number) => Promise<void>;
  loginFn?: LoginFn;
}

// ==================== 默认实现 ====================

/** 空值（null / undefined）输出 "None" */
function toNoneText(value: unknown): string {
  return value === null || value === undefined ? "None" : String(value);
}

/**
 * 登录不可重试的错误类型。
 * 前三类是基础集合（stagehand_unavailable / no_api_key / browser_open_failed）；
 * 其余几类（人机验证、密码错误、需要两步验证、账号不存在 / 停用）重试也不会有
 * 不同结果，反而可能触发 Google 风控或锁号，所以也一并列入。
 */
const NON_RETRYABLE_ERRORS = [
  "stagehand_unavailable",
  "no_api_key",
  "browser_open_failed",
  "captcha_required",
  "wrong_password",
  "need_2fa",
  "security_challenge",
  "account_not_found",
  "account_disabled",
];

/**
 * 默认登录适配器做成**工厂**：它要把 accountRepo 透传给下游的登录函数。
 *
 * 登录函数需要写库（login_status），而仓储在这里是参数，
 * 所以必须显式传下去 —— 漏传会让登录状态永远不落库。
 */
function makeDefaultLoginFn(repo: AccountRepoLike | null): LoginFn {
  return async ({ browserId, account, callback }) =>
    // 登录函数没有 api_key/model/provider 参数（引擎侧读配置），故丢弃
    autoGoogleLogin(browserId, account, {
      callback,
      accountRepo: repo ?? undefined,
    });
}

// ==================== BatchAccountProcessor ====================

/**
 * 批量账号处理器
 *
 * 使用示例:
 *   const processor = new BatchAccountProcessor({ concurrency: 3 }, { config, db });
 *   const result = await processor.batchLogin(accounts, browserIds);
 */
export class BatchAccountProcessor {
  readonly concurrency: number;
  readonly retryHelper: RetryHelper;
  readonly callback: ProgressCallback | null;
  private readonly onAccountDone: AccountDoneCallback | null;

  private semaphore: Semaphore | null = null;
  private stopFlag = false;

  private readonly config: ConfigManagerLike;
  private readonly accountRepo: AccountRepoLike | null;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly loginFn: LoginFn;

  /**
   * @param options.concurrency 并发数，默认从配置读取（用 `or` 兜底，所以 0 也会回落到配置）
   * @param options.retryTimes  重试次数（默认 2）
   * @param options.callback    进度回调
   */
  constructor(
    options: {
      concurrency?: number | null;
      retryTimes?: number;
      callback?: ProgressCallback | null;
      /** 每个账号结束时回调（成功 / 失败 / 停止跳过）；不传则不做任何额外动作 */
      onAccountDone?: AccountDoneCallback | null;
    } = {},
    deps: BatchProcessorDeps,
  ) {
    this.config = deps.config;
    this.concurrency = options.concurrency ? options.concurrency : this.config.getLoginConcurrency();
    this.retryHelper = new RetryHelper({ maxRetries: options.retryTimes ?? 2, baseDelay: 2.0 });
    this.callback = options.callback ?? null;
    this.onAccountDone = options.onAccountDone ?? null;

    // 仓储：显式注入优先，其次由 deps.db 构造。没有时保持 null，
    // 但**不静默** —— 下面会打一条告警，避免 DB 相关分支被无声跳过。
    this.accountRepo =
      deps.accountRepo ?? (deps.db ? new AccountRepository(deps.db) : null);
    this.sleepImpl = deps.sleepImpl ?? defaultSleep;
    // 默认适配器必须拿到 accountRepo，否则下游 auto_google_login 的状态写库失效
    this.loginFn = deps.loginFn ?? makeDefaultLoginFn(this.accountRepo);

    // 没有仓储时登录状态写库会被跳过。这在离线测试里是有意为之，
    // 但生产路径下属于配置错误，必须让调用方看见。
    if (!this.accountRepo) {
      this.log(
        `⚠️ 未注入 accountRepo（也未提供 deps.db），` +
          `相关的数据库读写将被跳过；如果这不是测试环境，请注入 deps.db 或对应仓储`,
      );
    }
  }

 /** 日志输出 —— print + callback 两个通道 */
  private log(msg: string): void {
    process.stdout.write(`[BatchProcessor] ${msg}\n`);
    if (this.callback) this.callback(msg);
  }

 /** 停止处理 */
  stop(): void {
    this.stopFlag = true;
    this.log("收到停止信号");
  }

  /**
 * `async with self._semaphore:`。
   * batchLogin 在创建任务前会重建信号量，所以这里的 null 分支不可达。
   */
  private withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    const semaphore = this.semaphore;
    if (!semaphore) throw new Error("信号量未初始化");
    return semaphore.run(fn);
  }

  // ==================== 批量登录 ====================

  /**
 * 批量执行登录 
   *
   * @param accounts   账号列表，每个账号是 {email, password, secret_key, recovery_email}
   * @param browserIds 浏览器窗口 ID 列表（与账号一一对应）
   */
  async batchLogin(
    accounts: AccountDict[],
    browserIds: string[],
    options: {
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
      maxRetries?: number | null;
    } = {},
  ): Promise<BatchResult> {
    if (accounts.length !== browserIds.length) {
      throw new Error("账号数量与浏览器窗口数量不匹配");
    }

    const result = createBatchResult({ total: accounts.length });
    result.start_time = Date.now();
    this.stopFlag = false;
    this.semaphore = new Semaphore(this.concurrency);

    // 获取重试配置
    const retries = options.maxRetries || this.config.getLoginMaxRetries();

    this.log(
      `开始批量登录，共 ${accounts.length} 个账号，并发数 ${this.concurrency}，最大尝试 ${retries} 次`,
    );

    // 创建任务（先全部启动 Promise 再统一等待，并发由信号量控制）
    const tasks: Promise<void>[] = [];
    accounts.forEach((account, index) => {
      const browserId = browserIds[index];
      if (browserId === undefined) return; // zip 语义；长度已校验，不可达
      tasks.push(
        this.loginWithSemaphore(account, browserId, result, {
          apiKey: options.apiKey ?? null,
          model: options.model ?? null,
          provider: options.provider ?? null,
          maxRetries: options.maxRetries ?? null,
        }),
      );
    });

    // 并发执行
    await gatherSettled(tasks);

    result.end_time = Date.now();
    this.log(
      `批量登录完成: 成功 ${result.success_count}, ` +
        `失败 ${result.failed_count}, ` +
        `跳过 ${result.skipped_count}, ` +
        `耗时 ${batchDurationSeconds(result).toFixed(1)}s`,
    );

    return result;
  }

  /** 带信号量控制的登录任务（支持多次重试） */
  private async loginWithSemaphore(
    account: AccountDict,
    browserId: string,
    result: BatchResult,
    options: {
      apiKey: string | null;
      model: string | null;
      provider: string | null;
      maxRetries: number | null;
    },
  ): Promise<void> {
    const email = String(account["email"] ?? "unknown");

    // 同一个账号只回调一次：下面多个终止点都可能走到，重复回调会让进度多算、日志重复
    let reported = false;
    const report = (status: AccountDoneStatus, message: string): void => {
      if (reported) return;
      reported = true;
      this.onAccountDone?.(email, status, message);
    };

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
        report("skipped", "用户停止");
        return;
      }

      try {
        // 获取重试配置
        const retries = options.maxRetries || this.config.getLoginMaxRetries();
        const retryDelay = this.config.getLoginRetryDelay();

        this.log(`[${email}] 开始登录（最多尝试 ${retries} 次）...`);

        // 执行登录（带重试）
        let loginResult: BatchLoginResult | null = null;
        let lastError: string | null = null;
        // 逐次记录实际尝试次数：不可重试时提前结束，日志里反映真实次数
        let attempts = 0;

        for (let attempt = 1; attempt <= retries; attempt += 1) {
          if (this.stopFlag) {
            addSkipped(result, email, "用户停止");
            report("skipped", "用户停止");
            return;
          }

          if (attempt > 1) {
            this.log(`[${email}] 第 ${attempt}/${retries} 次尝试...`);
            await this.sleepImpl(retryDelay * 1000);
          }

          attempts = attempt;
          try {
            loginResult = await this.loginFn({
              browserId,
              account,
              callback: this.callback,
              apiKey: options.apiKey,
              model: options.model,
              provider: options.provider,
            });

            if (loginResult.success) {
              // 登录成功
              addSuccess(result, email, {
                browser_id: browserId,
                total_steps: loginResult.totalSteps,
                attempts: attempt,
              });
              this.log(`[${email}] ✅ 登录成功（第 ${attempt} 次尝试）`);
              report("success", "");
              return;
            }

            // 登录失败，记录错误
            lastError = loginResult.message;
            this.log(`[${email}] 第 ${attempt} 次尝试失败: ${loginResult.message}`);

            // 某些错误类型不需要重试
            if (loginResult.errorType && NON_RETRYABLE_ERRORS.includes(loginResult.errorType)) {
              this.log(`[${email}] 错误类型 ${loginResult.errorType} 不可重试`);
              break;
            }
          } catch (e) {
            lastError = errorMessage(e);
            this.log(`[${email}] 第 ${attempt} 次尝试异常: ${errorMessage(e)}`);
          }
        }

        // 所有尝试都失败
        if (loginResult) {
          addFailed(result, email, loginResult.message, loginResult.errorType ?? null);
          this.log(`[${email}] ❌ 登录失败（已尝试 ${attempts} 次）: ${loginResult.message}`);
          report("failed", loginResult.message);
        } else {
          const text = lastError || "未知错误";
          addFailed(result, email, text, "exception");
          this.log(`[${email}] ❌ 登录失败（已尝试 ${attempts} 次）: ${toNoneText(lastError)}`);
          report("failed", text);
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
        report("failed", errorMessage(e));
      }
    });
  }
}

// ==================== 便捷函数 ====================

/**
 * 快速批量登录
 * deps 必填（至少要有 config），便于测试注入。
 */
export async function quickBatchLogin(
  accounts: AccountDict[],
  browserIds: string[],
  options: {
    concurrency?: number;
    callback?: ProgressCallback | null;
    maxRetries?: number | null;
  } = {},
  deps: BatchProcessorDeps,
): Promise<BatchResult> {
  const processor = new BatchAccountProcessor(
    { concurrency: options.concurrency ?? 3, callback: options.callback ?? null },
    deps,
  );
  return processor.batchLogin(accounts, browserIds, { maxRetries: options.maxRetries ?? null });
}
