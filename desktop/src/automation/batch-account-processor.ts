/**
 * 批量账号处理器（Node 重写）
 *
 * 对标 automation/batch_account_processor.py 的以下部分：
 *   L242-272   __init__ / _log / stop
 *   L273-427   batch_login / _login_with_semaphore
 *   L428-583   batch_oauth / _oauth_with_semaphore
 *   L584-657   batch_login_and_oauth
 *   L658-847   batch_unlock_403 / _unlock_with_semaphore
 *   L848-1007  batch_detect_pro / _detect_pro_with_semaphore
 *   L1425-1737 batch_refresh_membership_info / _refresh_membership_with_semaphore
 *   L1738-1750 _update_task_item_failed
 *   L2196-2260 quick_batch_login / quick_batch_oauth
 *
 * 不在本文件内（已在别处移植，这里直接复用）：
 *   L95-226    BatchResult / AccountMembershipRefreshResult → ./batch/types.ts
 *   L1008-1424 4 个页面检测方法                              → ./batch/pro-detection.ts
 *              （注意：这 4 个方法只被彼此调用，本文件涉及的行没有任何调用点，故不 import）
 *   L1751-2191 2 个 BrowserUse 检测方法                      → ./batch/membership-detect.ts
 *
 * 与 Python 的差异（全部为结构性差异，判定分支 / 日志文案 / 提示词逐字对齐）：
 *   1. 依赖注入：Python 到处直接调模块级 `DBManager.*` / `closeBrowser()` / `ConfigManager.*`，
 *      TS 侧统一收进构造函数第二参 `BatchProcessorDeps`，默认值是真实实现，
 *      单测可整体替身、完全离线。
 *   2. `DBManager.update_membership_info` 已移植为 `AccountRepository.updateMembershipInfo`，
 *      `AccountRepoLike.updateMembershipInfo` 为必需方法；但 `accountRepo` / `refreshTaskRepo`
 *      本身仍可不注入（默认 null），未注入时所有 DB 调用被跳过 —— 这是有意的离线设计。
 *   3. `Sub2APIClient.test_account_connection` 已移植为 `Sub2ApiClient.testAccountConnection`，
 *      `Sub2ApiClientLike.testAccountConnection` 为必需方法，
 *      「重新检测 403」整段与 Python 的 `if sub2api_client:` 控制流完全一致。
 *   4. `openBrowser()` 返回 `{success, msg, data.ws}`，Node 的 `IxBrowserClient.openProfile()`
 *      改为**抛异常**；catch 后映射到同一条 `browser_open_failed` 分支（文案不变）。
 *   5. Python 用 `async with async_playwright()` 连 CDP 只为拿到一个**并未被使用**的 page
 *      （check_pro_status_via_stagehand 只用 ws_endpoint）。TS 保留这次连接以保全
 *      「连接失败 → exception」与「拿不到页面 → no_context」两条分支，
 *      连接器走可注入的 CdpConnector（默认 playwright-core 惰性加载）。
 *   6. `auto_google_login` / `auto_antigravity_oauth` 的 Node 版没有 api_key/model/provider、
 *      proxy_allocator/auto_bind_proxy 参数，默认适配器会丢弃它们（见 defaultLoginFn/defaultOauthFn）；
 *      `auto_unlock_403` 的 Node 版有这些参数，照常透传。
 *      Node 版 OAuth 结果也没有 total_steps 字段 → data.total_steps 为 undefined。
 *   7. `datetime.now()` → `Date.now()`（毫秒）；`asyncio.sleep(秒)` → `sleepImpl(秒 * 1000)`。
 *   8. `f"{x:.1f}"` → `toFixed(1)`（半数进位规则在 .05 边界上与 Python 不同，耗时场景无影响）；
 *      Python 打印 `None` 的位置用 "None" 字面量还原。
 *   9. Python 的 `str | None` / `Optional[X]` 一律映射为 `| null`。
 */

import { RetryHelper, errorMessage } from "../core/retry-helper.ts";
import { configManager } from "../core/config-manager.ts";
import { Semaphore, gatherSettled, sleep as defaultSleep } from "../core/semaphore.ts";
import {
  addFailed,
  addSkipped,
  addSuccess,
  batchDurationSeconds,
  calculateFamilySlots,
  createBatchResult,
  membershipFromProStatus,
  membershipResultToDict,
  type BatchResult,
  type BatchResultItem,
} from "./batch/types.ts";
import {
  detectFamilyDetailsViaBrowserUse,
  extractAccountCountryViaBrowserUse,
} from "./batch/membership-detect.ts";
import {
  checkProStatusViaEngine,
  checkProStatusWithEngine,
} from "./pro-status-detector.ts";
import { autoGoogleLogin } from "./auto-google-login.ts";
import { autoAntigravityOauth } from "./auto-antigravity-oauth.ts";
import { autoUnlock403, type UnlockSmsClient } from "./auto-unlock-403.ts";
import { AccountRepository } from "../db/account-repository.ts";
import { AccountRefreshRepository } from "../db/account-refresh-repository.ts";
import type { Db } from "../db/connection.ts";
import { IxBrowserClient } from "../ixbrowser/client.ts";
import { Sub2ApiClient } from "../services/sub2api-client.ts";
import { SmsBusClient } from "../services/sms-bus-client.ts";
import { ProxySmartAllocator } from "../services/proxy-smart-allocator.ts";
import { BrowserUseEngine } from "../browseruse/engine.ts";
import { createPlaywrightConnector, type CdpConnector } from "../browseruse/playwright-cdp.ts";

// ==================== 基础类型 ====================

/** 进度回调 —— 对标 Python 的 `callback: Callable[[str], None]` */
export type ProgressCallback = (msg: string) => void;

/** 账号字典 —— Python 侧是无类型 Dict */
export type AccountDict = Record<string, unknown>;

/** batch_detect_pro / batch_refresh_membership_info 追加的统计摘要行 */
export interface BatchSummaryRow {
  _summary: true;
  pro_count: number;
  pro_regular_count: number;
  pro_family_count: number;
  non_pro_count: number;
}

// ==================== 注入接口（只声明 Python 实际用到的方法） ====================

/**
 * 对标模块级 `ConfigManager`。
 * 真实实现：core/config-manager.ts 的 `configManager` 单例（方法名一致）。
 */
export interface ConfigManagerLike {
  getLoginConcurrency(): number;
  getLoginMaxRetries(): number;
  getLoginRetryDelay(): number;
  getSmsBusToken(): string;
}

/**
 * 对标 `DBManager` 中与账号相关的调用。
 * 真实实现：db/account-repository.ts 的 `AccountRepository`
 *   get_account_by_email   → getAccountByEmail(email): AccountRow | null
 *   update_pro_status      → updateProStatus(email, isPro): boolean
 *   update_unlock_status   → updateUnlockStatus(email, status, validationUrl?): boolean
 *   update_membership_info → updateMembershipInfo({...})（字段名 snake_case）
 */
export interface AccountRepoLike {
  getAccountByEmail(email: string): Record<string, unknown> | null;
  updateProStatus(email: string, isPro: string): unknown;
  updateUnlockStatus(email: string, status: string, validationUrl?: string | null): unknown;
  updateMembershipInfo(fields: {
    email: string;
    is_pro: string;
    pro_plan_name: string;
    family_role: string;
    family_manager_email: string;
    has_family_group: string;
    family_member_count: number;
    family_slots_left: number;
    account_country: string;
    error_message: string | null;
  }): unknown;
}

/**
 * 对标 `DBManager` 中与刷新任务表相关的调用。
 * 真实实现：db/account-refresh-repository.ts 的 `AccountRefreshRepository`
 *   create_refresh_task              → createRefreshTask(taskMode, totalCount): number
 *   create_refresh_task_items        → createTaskItems(taskId, emails): void
 *   update_refresh_task_item_started → updateTaskItemStarted(taskId, email): void
 *   update_refresh_task_item         → updateTaskItem(taskId, email, status, result): void
 *   finish_refresh_task              → finishTask(taskId, status, successCount, failedCount): void
 */
export interface RefreshTaskRepoLike {
  createRefreshTask(taskMode: string, totalCount: number): number;
  createTaskItems(taskId: number, emails: string[]): void;
  updateTaskItemStarted(taskId: number, email: string): void;
  updateTaskItem(taskId: number, email: string, status: string, result: Record<string, unknown>): void;
  finishTask(taskId: number, status: string, successCount: number, failedCount: number): void;
}

/**
 * 对标 `services.ix_api` 的 openBrowser / closeBrowser。
 * 真实实现：ixbrowser/client.ts 的 `IxBrowserClient`
 *   openProfile(profileId, options?) → Promise<IxOpenResult>（失败抛异常）
 *   closeProfile(profileId)          → Promise<boolean>
 */
export interface IxBrowserClientLike {
  openProfile(profileId: number): Promise<{ ws: string }>;
  closeProfile(profileId: number): Promise<boolean>;
}

/**
 * 对标 `Sub2APIClient`。
 * 真实实现：services/sub2api-client.ts 的 `Sub2ApiClient`
 *   check_account_exists    → checkAccountExists(email): Promise<number | null>
 *   test_account_connection → testAccountConnection(accountId, modelId?)
 *   close                   → **Node 侧无会话可关**，可选
 */
export interface Sub2ApiClientLike {
  checkAccountExists(email: string): Promise<number | null>;
  testAccountConnection(
    accountId: number,
    modelId?: string,
  ): Promise<{ success: boolean; data?: Record<string, unknown> | null; error?: string | null }>;
  close?(): Promise<void>;
}

/**
 * 全程共用的 BrowserUse 引擎能力子集。
 * 真实实现：browseruse/engine.ts 的 `BrowserUseEngine`（签名逐个核对过）。
 * 同时结构上满足 pro-status-detector.ts 的 `ProDetectEngine`
 * 与 batch/membership-detect.ts 的 `MembershipDetectEngine`。
 */
export interface BatchBrowserUseEngine {
  connectCdp(wsEndpoint: string): Promise<void>;
  stop(closeBrowser?: boolean): Promise<void>;
  navigate(
    url: string,
    options?: { waitUntil?: string; timeoutMs?: number },
  ): Promise<{ success: boolean; error?: string | null }>;
  extract<T = Record<string, unknown>>(
    instruction: string,
    schema?: unknown,
    options?: { timeoutMs?: number; maxSteps?: number },
  ): Promise<{ success: boolean; data?: T | null; error?: string | null }>;
  getPageContent(): Promise<string>;
  getCurrentUrl(): Promise<string>;
}

// ==================== 三个 auto_* 流程的注入签名 ====================

/** 对标 `LoginResult` 中被批量处理器读取的字段 */
export interface BatchLoginResult {
  success: boolean;
  message: string;
  errorType?: string | null;
  totalSteps?: number | null;
}

/** 对标 `auto_google_login(...)` 的调用点（L379-386） */
export type LoginFn = (args: {
  browserId: string;
  account: AccountDict;
  callback: ProgressCallback | null;
  apiKey: string | null;
  model: string | null;
  provider: string | null;
}) => Promise<BatchLoginResult>;

/** 对标 `OAuthResult` 中被批量处理器读取的字段 */
export interface BatchOauthResult {
  success: boolean;
  message: string;
  errorType?: string | null;
  sub2apiAccountId?: number | null;
  /** Node 版 auto_antigravity_oauth 没有该字段，保留以对齐 Python 的 data.total_steps */
  totalSteps?: number | null;
}

/** 对标 `auto_antigravity_oauth(...)` 的调用点（L549-560） */
export type OauthFn = (args: {
  browserId: string;
  account: AccountDict;
  sub2apiClient: Sub2ApiClientLike;
  callback: ProgressCallback | null;
  apiKey: string | null;
  model: string | null;
  provider: string | null;
  skipLoginCheck: boolean;
  proxyAllocator: unknown;
  autoBindProxy: boolean;
}) => Promise<BatchOauthResult>;

/** 对标 `UnlockResult` 中被批量处理器读取的字段 */
export interface BatchUnlockResult {
  success: boolean;
  message: string;
  errorType?: string | null;
  phoneUsed?: string;
  attempts?: number;
}

/** 对标 `auto_unlock_403(...)` 的调用点（L812-824） */
export type UnlockFn = (args: {
  browserId: string;
  account: AccountDict;
  validationUrl: string;
  smsClient: UnlockSmsClient;
  countryId: number | null;
  projectId: number | null;
  maxRetries: number | null;
  callback: ProgressCallback | null;
  apiKey: string | null;
  model: string | null;
  provider: string | null;
}) => Promise<BatchUnlockResult>;

// ==================== 依赖集合 ====================

export interface BatchProcessorDeps {
  /** 默认 core/config-manager.ts 的 configManager 单例 */
  config?: ConfigManagerLike;
  /**
   * 数据库连接。给了它就会自动构造 accountRepo 与 refreshTaskRepo，
   * 这是生产路径推荐的注入方式（Node 侧没有 Python 那种 DBManager 全局单例，
   * 打开哪个库必须由调用方决定，所以不能在此处默认 openDb）。
   */
  db?: Db;
  /** 不给则由 `db` 构造；两者都不给时，账号表读写被跳过并在构造时告警 */
  accountRepo?: AccountRepoLike | null;
  /** 不给则由 `db` 构造；两者都不给时，刷新任务表相关调用被跳过并告警 */
  refreshTaskRepo?: RefreshTaskRepoLike | null;
  /** 默认 new IxBrowserClient() */
  ixClient?: IxBrowserClientLike;
  /** 单位毫秒，默认 core/semaphore.ts 的 sleep */
  sleepImpl?: (ms: number) => Promise<void>;
  loginFn?: LoginFn;
  oauthFn?: OauthFn;
  unlockFn?: UnlockFn;
  /** 对标 `Sub2APIClient()`，默认用配置里的 base_url / admin_token 构造 */
  createSub2ApiClient?: () => Sub2ApiClientLike;
  /** 对标 `SMSBusClient(token=...)` */
  createSmsClient?: (token: string) => UnlockSmsClient;
  /** 对标 `ProxySmartAllocator(sub2api_client)` */
  createProxyAllocator?: (sub2apiClient: Sub2ApiClientLike) => unknown;
  /** 对标 `BrowserUseEngine()`（未连接 CDP 的裸实例） */
  createBrowserUseEngine?: () => BatchBrowserUseEngine;
  /** 对标 `async_playwright().chromium.connect_over_cdp(...)` */
  cdpConnector?: CdpConnector;
}

// ==================== 默认实现 ====================

/** Python 的 `print(None)` 输出 "None"，这里还原它 */
function pyNone(value: unknown): string {
  return value === null || value === undefined ? "None" : String(value);
}

/** Pro 状态 → 展示文案（L979-983 / L1613-1617 是同一张表） */
const STATUS_TEXT_MAP: Record<string, string> = {
  yes: "Pro",
  family_yes: "Pro(家庭组)",
  no: "非Pro",
};

/** 登录不可重试的错误类型（L403-407，顺序照搬） */
const NON_RETRYABLE_ERRORS = ["stagehand_unavailable", "no_api_key", "browser_open_failed"];

/**
 * 三个默认适配器做成**工厂**：它们要把 accountRepo 透传给下游的 auto_* 流程。
 *
 * Python 侧 auto_google_login / auto_antigravity_oauth / auto_unlock_403 直接调
 * 全局 DBManager 写库（login_status / sub2api_status / unlock_status）；
 * Node 版把仓储做成了参数，所以这里必须显式传下去 —— 漏传会让这些状态永远不落库，
 * 进而使 batch_login_and_oauth 的「按 login_status 筛选」永远筛不出账号。
 */
function makeDefaultLoginFn(repo: AccountRepoLike | null): LoginFn {
  return async ({ browserId, account, callback }) =>
    // Node 版 auto_google_login 没有 api_key/model/provider 参数（引擎侧读配置），故丢弃
    autoGoogleLogin(browserId, account, {
      callback,
      accountRepo: repo as unknown as AccountRepository | undefined,
    });
}

function makeDefaultOauthFn(repo: AccountRepoLike | null): OauthFn {
  return async ({ browserId, account, sub2apiClient, callback, skipLoginCheck }) =>
    // Node 版 auto_antigravity_oauth 没有 api_key/model/provider 与代理分配参数，故丢弃；
    // 它要求的是具体类 Sub2ApiClient，这里做一次收窄断言（默认工厂给的就是真实实例）。
    autoAntigravityOauth(browserId, account, {
      sub2apiClient: sub2apiClient as unknown as Sub2ApiClient,
      callback,
      skipLoginCheck,
      accountRepo: repo as unknown as AccountRepository | undefined,
    });
}

function makeDefaultUnlockFn(repo: AccountRepoLike | null): UnlockFn {
  return async (args) =>
    autoUnlock403(args.browserId, args.account, {
      validationUrl: args.validationUrl,
      smsClient: args.smsClient,
      countryId: args.countryId,
      projectId: args.projectId,
      maxRetries: args.maxRetries,
      callback: args.callback,
      apiKey: args.apiKey,
      model: args.model,
      provider: args.provider,
      accountRepo: repo as unknown as AccountRepository | undefined,
    });
}

// ==================== BatchAccountProcessor ====================

/**
 * 批量账号处理器 —— 对标 BatchAccountProcessor（L228-241 的 docstring 示例同样适用）
 *
 * 使用示例:
 *   const processor = new BatchAccountProcessor({ concurrency: 3 });
 *   const result = await processor.batchLogin(accounts, browserIds);
 *   const oauth = await processor.batchOauth(accounts, browserIds, { sub2apiClient });
 */
export class BatchAccountProcessor {
  readonly concurrency: number;
  readonly retryHelper: RetryHelper;
  readonly callback: ProgressCallback | null;

  private semaphore: Semaphore | null = null;
  private stopFlag = false;

  private readonly config: ConfigManagerLike;
  private readonly accountRepo: AccountRepoLike | null;
  private readonly refreshTaskRepo: RefreshTaskRepoLike | null;
  private readonly ixClient: IxBrowserClientLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly loginFn: LoginFn;
  private readonly oauthFn: OauthFn;
  private readonly unlockFn: UnlockFn;
  private readonly createSub2ApiClient: () => Sub2ApiClientLike;
  private readonly createSmsClient: (token: string) => UnlockSmsClient;
  private readonly createProxyAllocator: (sub2apiClient: Sub2ApiClientLike) => unknown;
  private readonly createBrowserUseEngine: () => BatchBrowserUseEngine;
  private readonly cdpConnector: CdpConnector;

  /**
   * 对标 __init__（L242-260）
   *
   * @param options.concurrency 并发数，默认从配置读取（Python 用 `or`，所以 0 也会回落到配置）
   * @param options.retryTimes  重试次数（Python 默认 2）
   * @param options.callback    进度回调
   */
  constructor(
    options: {
      concurrency?: number | null;
      retryTimes?: number;
      callback?: ProgressCallback | null;
    } = {},
    deps: BatchProcessorDeps = {},
  ) {
    this.config = deps.config ?? configManager;
    this.concurrency = options.concurrency ? options.concurrency : this.config.getLoginConcurrency();
    this.retryHelper = new RetryHelper({ maxRetries: options.retryTimes ?? 2, baseDelay: 2.0 });
    this.callback = options.callback ?? null;

    // 仓储：显式注入优先，其次由 deps.db 构造。两者都没有时保持 null，
    // 但**不静默** —— 下面会打一条告警，避免 DB 相关分支被无声跳过。
    this.accountRepo =
      deps.accountRepo ?? (deps.db ? new AccountRepository(deps.db) : null);
    this.refreshTaskRepo =
      deps.refreshTaskRepo ?? (deps.db ? new AccountRefreshRepository(deps.db) : null);
    this.ixClient = deps.ixClient ?? new IxBrowserClient();
    this.sleepImpl = deps.sleepImpl ?? defaultSleep;
    // 默认适配器必须拿到 accountRepo，否则下游 auto_* 的状态写库全部失效
    this.loginFn = deps.loginFn ?? makeDefaultLoginFn(this.accountRepo);
    this.oauthFn = deps.oauthFn ?? makeDefaultOauthFn(this.accountRepo);
    this.unlockFn = deps.unlockFn ?? makeDefaultUnlockFn(this.accountRepo);
    this.createSub2ApiClient =
      deps.createSub2ApiClient ??
      (() =>
        new Sub2ApiClient({
          baseUrl: configManager.getSub2apiBaseUrl(),
          adminToken: configManager.getSub2apiToken(),
        }));
    this.createSmsClient = deps.createSmsClient ?? ((token: string) => new SmsBusClient({ token }));
    this.createProxyAllocator =
      deps.createProxyAllocator ??
      ((client: Sub2ApiClientLike) => new ProxySmartAllocator(client as unknown as Sub2ApiClient));
    this.createBrowserUseEngine = deps.createBrowserUseEngine ?? (() => new BrowserUseEngine());
    this.cdpConnector = deps.cdpConnector ?? createPlaywrightConnector();

    // 没有仓储时 Python 侧必走的写库/读库分支会被跳过（例如 batch_login_and_oauth
    // 的「按 login_status 筛选」会永远筛不出账号）。这在离线测试里是有意为之，
    // 但生产路径下属于配置错误，必须让调用方看见。
    if (!this.accountRepo || !this.refreshTaskRepo) {
      const missing: string[] = [];
      if (!this.accountRepo) missing.push("accountRepo");
      if (!this.refreshTaskRepo) missing.push("refreshTaskRepo");
      this.log(
        `⚠️ 未注入 ${missing.join(" / ")}（也未提供 deps.db），` +
          `相关的数据库读写将被跳过；如果这不是测试环境，请注入 deps.db 或对应仓储`,
      );
    }
  }

  /** 日志输出 —— 对标 _log（L262-266）：print + callback 两个通道 */
  private log(msg: string): void {
    process.stdout.write(`[BatchProcessor] ${msg}\n`);
    if (this.callback) this.callback(msg);
  }

  /** 停止处理 —— 对标 stop（L268-271） */
  stop(): void {
    this.stopFlag = true;
    this.log("收到停止信号");
  }

  /**
   * 对标 `async with self._semaphore:`。
   * 每个 batch_* 在创建任务前都会重建信号量，所以这里的 null 分支不可达。
   */
  private withSemaphore<T>(fn: () => Promise<T>): Promise<T> {
    const semaphore = this.semaphore;
    if (!semaphore) throw new Error("信号量未初始化");
    return semaphore.run(fn);
  }

  /** 对标 check_pro_status_via_browseruse 内部的「建引擎 + connect_cdp」 */
  private async connectProEngine(wsEndpoint: string): Promise<BatchBrowserUseEngine> {
    const engine = this.createBrowserUseEngine();
    await engine.connectCdp(wsEndpoint);
    return engine;
  }

  // ==================== 批量登录 ====================

  /**
   * 批量执行登录 —— 对标 batch_login（L273-334）
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

    // 创建任务（Python 先建协程再 gather，这里先全部启动 Promise 再统一等待，并发同样由信号量控制）
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

  /** 带信号量控制的登录任务（支持多次重试） —— 对标 _login_with_semaphore（L336-426） */
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

    if (this.stopFlag) {
      addSkipped(result, email, "用户停止");
      return;
    }

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
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

        for (let attempt = 1; attempt <= retries; attempt += 1) {
          if (this.stopFlag) {
            addSkipped(result, email, "用户停止");
            return;
          }

          if (attempt > 1) {
            this.log(`[${email}] 第 ${attempt}/${retries} 次尝试...`);
            await this.sleepImpl(retryDelay * 1000);
          }

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
          this.log(`[${email}] ❌ 登录失败（已尝试 ${retries} 次）: ${loginResult.message}`);
        } else {
          addFailed(result, email, lastError || "未知错误", "exception");
          this.log(`[${email}] ❌ 登录失败（已尝试 ${retries} 次）: ${pyNone(lastError)}`);
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
      }
    });
  }

  // ==================== 批量 OAuth ====================

  /**
   * 批量执行 OAuth —— 对标 batch_oauth（L428-511）
   *
   * @param options.skipLogin      是否跳过登录检查
   * @param options.autoBindProxy  是否自动绑定代理（默认 true）
   */
  async batchOauth(
    accounts: AccountDict[],
    browserIds: string[],
    options: {
      sub2apiClient?: Sub2ApiClientLike | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
      skipLogin?: boolean;
      autoBindProxy?: boolean;
    } = {},
  ): Promise<BatchResult> {
    if (accounts.length !== browserIds.length) {
      throw new Error("账号数量与浏览器窗口数量不匹配");
    }

    const skipLogin = options.skipLogin ?? false;
    const autoBindProxy = options.autoBindProxy ?? true;

    const result = createBatchResult({ total: accounts.length });
    result.start_time = Date.now();
    this.stopFlag = false;
    this.semaphore = new Semaphore(this.concurrency);

    this.log(`开始批量 OAuth，共 ${accounts.length} 个账号，并发数 ${this.concurrency}`);

    // 创建或使用传入的客户端
    // （Python 还会 await client._ensure_session() 预热 aiohttp 会话；Node 的 fetch 无会话可预热）
    let clientCreated = false;
    let sub2apiClient = options.sub2apiClient ?? null;
    if (sub2apiClient === null) {
      sub2apiClient = this.createSub2ApiClient();
      clientCreated = true;
    }

    // 创建代理智能分配器（如果启用）
    let proxyAllocator: unknown = null;
    if (autoBindProxy) {
      proxyAllocator = this.createProxyAllocator(sub2apiClient);
      this.log("代理智能分配器已启用");
    }

    try {
      // 创建任务
      const tasks: Promise<void>[] = [];
      accounts.forEach((account, index) => {
        const browserId = browserIds[index];
        if (browserId === undefined) return; // zip 语义；长度已校验，不可达
        tasks.push(
          this.oauthWithSemaphore(account, browserId, sub2apiClient as Sub2ApiClientLike, result, {
            apiKey: options.apiKey ?? null,
            model: options.model ?? null,
            provider: options.provider ?? null,
            skipLogin,
            proxyAllocator,
            autoBindProxy,
          }),
        );
      });

      // 并发执行
      await gatherSettled(tasks);
    } finally {
      if (clientCreated) await sub2apiClient.close?.();
    }

    result.end_time = Date.now();
    this.log(
      `批量 OAuth 完成: 成功 ${result.success_count}, ` +
        `失败 ${result.failed_count}, ` +
        `跳过 ${result.skipped_count}, ` +
        `耗时 ${batchDurationSeconds(result).toFixed(1)}s`,
    );

    return result;
  }

  /** 带信号量控制的 OAuth 任务 —— 对标 _oauth_with_semaphore（L513-582） */
  private async oauthWithSemaphore(
    account: AccountDict,
    browserId: string,
    sub2apiClient: Sub2ApiClientLike,
    result: BatchResult,
    options: {
      apiKey: string | null;
      model: string | null;
      provider: string | null;
      skipLogin: boolean;
      proxyAllocator: unknown;
      autoBindProxy: boolean;
    },
  ): Promise<void> {
    const email = String(account["email"] ?? "unknown");

    if (this.stopFlag) {
      addSkipped(result, email, "用户停止");
      return;
    }

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
        return;
      }

      try {
        // 检查是否已关联
        const dbAccount = this.accountRepo?.getAccountByEmail(email) ?? null;
        if (dbAccount && dbAccount["sub2api_status"] === "linked") {
          addSkipped(result, email, "已关联");
          this.log(`[${email}] 已关联 Sub2API，跳过`);
          return;
        }

        this.log(`[${email}] 开始 OAuth...`);

        // 执行 OAuth
        const oauthResult = await this.oauthFn({
          browserId,
          account,
          sub2apiClient,
          callback: this.callback,
          apiKey: options.apiKey,
          model: options.model,
          provider: options.provider,
          skipLoginCheck: options.skipLogin,
          proxyAllocator: options.proxyAllocator,
          autoBindProxy: options.autoBindProxy,
        });

        if (oauthResult.success) {
          addSuccess(result, email, {
            browser_id: browserId,
            sub2api_account_id: oauthResult.sub2apiAccountId,
            total_steps: oauthResult.totalSteps,
          });
          this.log(`[${email}] ✅ OAuth 成功`);
          // 成功时关闭浏览器窗口
          try {
            await this.ixClient.closeProfile(Number(browserId));
            this.log(`[${email}] 浏览器窗口已关闭`);
          } catch (e) {
            this.log(`[${email}] 关闭窗口失败: ${errorMessage(e)}`);
          }
        } else {
          addFailed(result, email, oauthResult.message, oauthResult.errorType ?? null);
          this.log(`[${email}] ❌ OAuth 失败: ${oauthResult.message}`);
          // 失败时不关闭浏览器，方便调试
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
      }
    });
  }

  // ==================== 登录 + OAuth ====================

  /**
   * 批量执行登录 + OAuth（先登录后 OAuth） —— 对标 batch_login_and_oauth（L584-656）
   * 返回 {login, oauth}
   */
  async batchLoginAndOauth(
    accounts: AccountDict[],
    browserIds: string[],
    options: {
      sub2apiClient?: Sub2ApiClientLike | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
      autoBindProxy?: boolean;
      maxRetries?: number | null;
    } = {},
  ): Promise<{ login: BatchResult; oauth: BatchResult }> {
    this.log("=== 阶段 1: 批量登录 ===");

    // 先执行登录
    const loginResult = await this.batchLogin(accounts, browserIds, {
      apiKey: options.apiKey ?? null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      maxRetries: options.maxRetries ?? null,
    });

    if (this.stopFlag) {
      return { login: loginResult, oauth: createBatchResult({ total: 0 }) };
    }

    // 筛选登录成功的账号
    const loggedInAccounts: AccountDict[] = [];
    const loggedInBrowserIds: string[] = [];

    accounts.forEach((account, index) => {
      const browserId = browserIds[index];
      if (browserId === undefined) return; // zip 语义
      const email = String(account["email"] ?? "");
      const dbAccount = this.accountRepo?.getAccountByEmail(email) ?? null;
      if (dbAccount && dbAccount["login_status"] === "logged_in") {
        loggedInAccounts.push(account);
        loggedInBrowserIds.push(browserId);
      }
    });

    this.log(`登录成功 ${loggedInAccounts.length} 个账号，继续 OAuth...`);

    if (loggedInAccounts.length === 0) {
      return { login: loginResult, oauth: createBatchResult({ total: 0 }) };
    }

    this.log("=== 阶段 2: 批量 OAuth ===");

    // 执行 OAuth（跳过登录检查，因为已经登录）
    const oauthResult = await this.batchOauth(loggedInAccounts, loggedInBrowserIds, {
      sub2apiClient: options.sub2apiClient ?? null,
      apiKey: options.apiKey ?? null,
      model: options.model ?? null,
      provider: options.provider ?? null,
      skipLogin: true,
      autoBindProxy: options.autoBindProxy ?? true,
    });

    return { login: loginResult, oauth: oauthResult };
  }

  // ==================== 批量 403 解锁 ====================

  /**
   * 批量解锁 403 账户 —— 对标 batch_unlock_403（L658-740）
   *
   * @param options.countryId 国家 ID（null = 自动选最便宜）
   * @param options.projectId 服务 ID（null = Google）
   */
  async batchUnlock403(
    accounts: AccountDict[],
    browserIds: string[],
    options: {
      smsToken?: string | null;
      countryId?: number | null;
      projectId?: number | null;
      maxRetries?: number | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
    } = {},
  ): Promise<BatchResult> {
    if (accounts.length !== browserIds.length) {
      throw new Error("账号数量与浏览器窗口数量不匹配");
    }

    const countryId = options.countryId ?? null;
    const projectId = options.projectId ?? null;
    const maxRetries = options.maxRetries ?? null;

    const result = createBatchResult({ total: accounts.length });
    result.start_time = Date.now();
    this.stopFlag = false;
    this.semaphore = new Semaphore(this.concurrency);

    this.log(`开始批量 403 解锁，共 ${accounts.length} 个账号，并发数 ${this.concurrency}`);

    // 显示 SMS-Bus 配置
    this.log(
      `SMS-Bus 配置: country_id=${pyNone(countryId)}, project_id=${pyNone(projectId)}, max_retries=${pyNone(maxRetries)}`,
    );

    // 创建 SMS-Bus 客户端
    let smsToken = options.smsToken ?? null;
    if (!smsToken) {
      smsToken = this.config.getSmsBusToken();
    }

    if (!smsToken) {
      this.log("❌ SMS-Bus Token 未配置");
      result.end_time = Date.now();
      return result;
    }

    // 使用 Sub2APIClient 重新获取 validation_url
    const sub2apiClient = this.createSub2ApiClient();
    const smsClient = this.createSmsClient(smsToken);
    try {
      // 创建任务
      const tasks: Promise<void>[] = [];
      accounts.forEach((account, index) => {
        const browserId = browserIds[index];
        if (browserId === undefined) return; // zip 语义；长度已校验，不可达
        tasks.push(
          this.unlockWithSemaphore(account, browserId, smsClient, result, {
            countryId,
            projectId,
            maxRetries,
            apiKey: options.apiKey ?? null,
            model: options.model ?? null,
            provider: options.provider ?? null,
            sub2apiClient, // 传递 Sub2API 客户端
          }),
        );
      });

      // 并发执行
      await gatherSettled(tasks);
    } finally {
      // 对标 Python 的 `async with` 退出；Node 客户端基于 fetch，通常无会话可关
      await sub2apiClient.close?.();
    }

    result.end_time = Date.now();
    this.log(
      `批量 403 解锁完成: 成功 ${result.success_count}, ` +
        `失败 ${result.failed_count}, ` +
        `跳过 ${result.skipped_count}, ` +
        `耗时 ${batchDurationSeconds(result).toFixed(1)}s`,
    );

    return result;
  }

  /** 带信号量控制的解锁任务 —— 对标 _unlock_with_semaphore（L742-846） */
  private async unlockWithSemaphore(
    account: AccountDict,
    browserId: string,
    smsClient: UnlockSmsClient,
    result: BatchResult,
    options: {
      countryId: number | null;
      projectId: number | null;
      maxRetries: number | null;
      apiKey: string | null;
      model: string | null;
      provider: string | null;
      sub2apiClient: Sub2ApiClientLike | null;
    },
  ): Promise<void> {
    const email = String(account["email"] ?? "unknown");
    let validationUrl = String(account["validation_url"] ?? "");

    if (this.stopFlag) {
      addSkipped(result, email, "用户停止");
      return;
    }

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
        return;
      }

      try {
        this.log(`[${email}] 开始解锁...`);

        // 重要：重新检测 403 获取最新的 validation_url
        // 因为旧的 validation_url 可能已过期或被访问过
        const sub2apiClient = options.sub2apiClient;
        if (sub2apiClient) {
          this.log(`[${email}] 重新检测 403 状态以获取新的验证链接...`);

          // 查找 Sub2API 账号 ID
          const accountId = await sub2apiClient.checkAccountExists(email);
          if (accountId) {
            // 测试连接获取最新的 validation_url
            const testResult = await sub2apiClient.testAccountConnection(accountId);
            const testData = testResult.data ?? {}; // 防止 data 为 None

            if (!testResult.success && testData["needs_unlock"]) {
              const newValidationUrl = String(testData["validation_url"] ?? "");
              if (newValidationUrl) {
                this.log(`[${email}] 获取到新的验证链接`);
                validationUrl = newValidationUrl;
                // 更新数据库中的 validation_url
                this.accountRepo?.updateUnlockStatus(email, "needs_unlock", validationUrl);
              } else {
                this.log(`[${email}] [!] 未获取到新的验证链接，使用数据库中的链接`);
              }
            } else if (testResult.success) {
              // 账号已不再是 403 状态
              this.log(`[${email}] ✅ 账号已不再需要解锁（403 已解除）`);
              this.accountRepo?.updateUnlockStatus(email, "unlocked");
              addSuccess(result, email, { skipped: true, reason: "已解锁" });
              return;
            } else {
              // 其他失败情况
              this.log(`[${email}] [!] 检测返回异常: ${pyNone(testResult.error)}，使用数据库中的链接`);
            }
          } else {
            this.log(`[${email}] [!] 未找到 Sub2API 账号，使用数据库中的验证链接`);
          }
        }

        // 检查是否有验证链接
        if (!validationUrl) {
          addSkipped(result, email, "无验证链接");
          this.log(`[${email}] 无验证链接，跳过`);
          return;
        }

        // 执行解锁
        const unlockResult = await this.unlockFn({
          browserId,
          account,
          validationUrl,
          smsClient,
          countryId: options.countryId,
          projectId: options.projectId,
          maxRetries: options.maxRetries,
          callback: this.callback,
          apiKey: options.apiKey,
          model: options.model,
          provider: options.provider,
        });

        if (unlockResult.success) {
          addSuccess(result, email, {
            browser_id: browserId,
            phone_used: unlockResult.phoneUsed,
            attempts: unlockResult.attempts,
          });
          this.log(`[${email}] ✅ 解锁成功`);
          // 成功时关闭浏览器窗口
          try {
            await this.ixClient.closeProfile(Number(browserId));
            this.log(`[${email}] 浏览器窗口已关闭`);
          } catch (e) {
            this.log(`[${email}] 关闭窗口失败: ${errorMessage(e)}`);
          }
        } else {
          addFailed(result, email, unlockResult.message, unlockResult.errorType ?? null);
          this.log(`[${email}] ❌ 解锁失败: ${unlockResult.message}`);
          // 失败时不关闭浏览器，方便调试
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
      }
    });
  }

  // ==================== 批量 Pro 检测 ====================

  /**
   * 批量检测 Google One Pro 会员状态 —— 对标 batch_detect_pro（L848-909）
   * 结果末尾会追加一条 `_summary` 统计行。
   */
  async batchDetectPro(accounts: AccountDict[], browserIds: string[]): Promise<BatchResult> {
    if (accounts.length !== browserIds.length) {
      throw new Error("账号数量与浏览器窗口数量不匹配");
    }

    const result = createBatchResult({ total: accounts.length });
    result.start_time = Date.now();
    this.stopFlag = false;
    this.semaphore = new Semaphore(this.concurrency);

    this.log(`开始批量检测 Pro 状态，共 ${accounts.length} 个账号，并发数 ${this.concurrency}`);

    // 创建任务
    const tasks: Promise<void>[] = [];
    accounts.forEach((account, index) => {
      const browserId = browserIds[index];
      if (browserId === undefined) return; // zip 语义；长度已校验，不可达
      tasks.push(this.detectProWithSemaphore(account, browserId, result));
    });

    // 并发执行
    await gatherSettled(tasks);

    result.end_time = Date.now();

    // 统计 Pro 和非 Pro 数量（Pro 包括普通 Pro 和家庭组 Pro）
    const proCount = countByIsPro(result, "yes");
    const familyProCount = countByIsPro(result, "family_yes");
    const nonProCount = countByIsPro(result, "no");

    this.log(
      `批量检测 Pro 完成: Pro ${proCount}, Pro(家庭组) ${familyProCount}, 非Pro ${nonProCount}, ` +
        `失败 ${result.failed_count}, ` +
        `跳过 ${result.skipped_count}, ` +
        `耗时 ${batchDurationSeconds(result).toFixed(1)}s`,
    );

    // 在结果中添加 Pro 统计
    pushSummary(result, {
      _summary: true,
      pro_count: proCount + familyProCount, // 总 Pro 数（用于兼容旧逻辑）
      pro_regular_count: proCount,
      pro_family_count: familyProCount,
      non_pro_count: nonProCount,
    });

    return result;
  }

  /** 带信号量控制的 Pro 检测任务 —— 对标 _detect_pro_with_semaphore（L911-1006） */
  private async detectProWithSemaphore(
    account: AccountDict,
    browserId: string,
    result: BatchResult,
  ): Promise<void> {
    const email = String(account["email"] ?? "unknown");

    if (this.stopFlag) {
      addSkipped(result, email, "用户停止");
      return;
    }

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
        return;
      }

      try {
        this.log(`[${email}] 开始检测 Pro 状态...`);

        // 打开浏览器（Python 检查 open_result["success"]，Node 版失败是抛异常）
        let wsEndpoint = "";
        try {
          const openResult = await this.ixClient.openProfile(Number(browserId));
          wsEndpoint = openResult.ws ?? "";
        } catch (e) {
          const errorMsg = errorMessage(e) || "打开浏览器失败";
          addFailed(result, email, errorMsg, "browser_open_failed");
          this.log(`[${email}] ❌ 打开浏览器失败: ${errorMsg}`);
          return;
        }

        if (!wsEndpoint) {
          addFailed(result, email, "无法获取 WebSocket 端点", "no_ws_endpoint");
          this.log(`[${email}] ❌ 无法获取 WebSocket 端点`);
          return;
        }

        // 连接浏览器并检测
        const connection = await this.cdpConnector.connect(wsEndpoint);
        try {
          // Python 在 contexts 为空时报 no_context；Node 连接器把「取页面」收敛成一步，
          // 拿不到 page 即对应该分支。
          if (!connection.page) {
            addFailed(result, email, "没有浏览器上下文", "no_context");
            this.log(`[${email}] ❌ 没有浏览器上下文`);
            return;
          }

          // 检测 Pro 状态（使用 Stagehand AI）
          // 注意：Python 的 check_pro_status_via_stagehand 只是转发到 BrowserUse 版本，
          // page 参数并未被使用，这里直接用等价的 checkProStatusViaEngine。
          this.log(`[${email}] 使用 Stagehand AI 检测...`);
          const proStatus = await checkProStatusViaEngine(
            wsEndpoint,
            email,
            (ws) => this.connectProEngine(ws),
            (msg) => this.log(`[${email}] ${msg}`),
          );

          if (proStatus !== null) {
            // 更新数据库
            this.accountRepo?.updateProStatus(email, proStatus);

            // 根据状态生成显示文本
            const statusText = STATUS_TEXT_MAP[proStatus] ?? proStatus;

            addSuccess(result, email, {
              browser_id: browserId,
              is_pro: proStatus,
            });
            this.log(`[${email}] ✅ Pro 状态: ${statusText}`);
          } else {
            // 检测失败时也要保存状态到数据库
            this.accountRepo?.updateProStatus(email, "detection_failed");
            addFailed(result, email, "检测失败", "detection_failed");
            this.log(`[${email}] ❌ 检测 Pro 状态失败`);
          }

          // 检测完成后关闭浏览器
          try {
            await this.ixClient.closeProfile(Number(browserId));
            this.log(`[${email}] 浏览器窗口已关闭`);
          } catch (e) {
            this.log(`[${email}] 关闭窗口失败: ${errorMessage(e)}`);
          }
        } finally {
          // 对标 `async with async_playwright()` 退出：断开 CDP 连接、释放驱动
          try {
            await connection.close();
          } catch {
            /* 断开失败不影响结果 */
          }
          try {
            await connection.dispose();
          } catch {
            /* 同上 */
          }
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
      }
    });
  }

  // ==================== 批量刷新会员信息 ====================

  /**
   * 批量刷新会员信息 —— 对标 batch_refresh_membership_info（L1425-1527）
   *
   * @param mode "pro_only" 仅检测 Pro 状态 / "full" 完整刷新（Pro + 家庭组详情 + 国家）
   */
  async batchRefreshMembershipInfo(
    accounts: AccountDict[],
    browserIds: string[],
    mode: string = "full",
  ): Promise<BatchResult> {
    if (accounts.length !== browserIds.length) {
      throw new Error("账号数量与浏览器窗口数量不匹配");
    }

    const result = createBatchResult({ total: accounts.length });
    result.start_time = Date.now();
    this.stopFlag = false;
    this.semaphore = new Semaphore(this.concurrency);

    const modeText = mode === "full" ? "完整刷新" : "Pro 检测";
    this.log(`开始批量${modeText}，共 ${accounts.length} 个账号，并发数 ${this.concurrency}`);

    // 如果是 full 模式，创建任务记录
    let taskId: number | null = null;
    if (mode === "full") {
      try {
        taskId = this.refreshTaskRepo?.createRefreshTask(mode, accounts.length) ?? null;
        if (taskId !== null) {
          const emails = accounts.map((a) => String(a["email"] ?? ""));
          this.refreshTaskRepo?.createTaskItems(taskId, emails);
          this.log(`创建刷新任务 #${taskId}`);
        }
      } catch (e) {
        this.log(`创建任务记录失败: ${errorMessage(e)}`);
        taskId = null;
      }
    }

    // 创建任务
    const tasks: Promise<void>[] = [];
    accounts.forEach((account, index) => {
      const browserId = browserIds[index];
      if (browserId === undefined) return; // zip 语义；长度已校验，不可达
      tasks.push(this.refreshMembershipWithSemaphore(account, browserId, mode, taskId, result));
    });

    // 并发执行
    await gatherSettled(tasks);

    result.end_time = Date.now();

    // 统计
    const proCount = countByIsPro(result, "yes");
    const familyProCount = countByIsPro(result, "family_yes");
    const nonProCount = countByIsPro(result, "no");

    this.log(
      `批量${modeText}完成: Pro ${proCount}, Pro(家庭组) ${familyProCount}, 非Pro ${nonProCount}, ` +
        `失败 ${result.failed_count}, 耗时 ${batchDurationSeconds(result).toFixed(1)}s`,
    );

    // 更新任务状态
    if (taskId) {
      try {
        this.refreshTaskRepo?.finishTask(
          taskId,
          !this.stopFlag ? "completed" : "stopped",
          result.success_count,
          result.failed_count,
        );
      } catch (e) {
        this.log(`更新任务状态失败: ${errorMessage(e)}`);
      }
    }

    // 添加统计摘要
    pushSummary(result, {
      _summary: true,
      pro_count: proCount + familyProCount,
      pro_regular_count: proCount,
      pro_family_count: familyProCount,
      non_pro_count: nonProCount,
    });

    return result;
  }

  /** 带信号量控制的会员信息刷新任务 —— 对标 _refresh_membership_with_semaphore（L1529-1736） */
  private async refreshMembershipWithSemaphore(
    account: AccountDict,
    browserId: string,
    mode: string,
    taskId: number | null,
    result: BatchResult,
  ): Promise<void> {
    const email = String(account["email"] ?? "unknown");

    if (this.stopFlag) {
      addSkipped(result, email, "用户停止");
      return;
    }

    await this.withSemaphore(async () => {
      if (this.stopFlag) {
        addSkipped(result, email, "用户停止");
        return;
      }

      // 标记任务明细开始
      if (taskId) {
        try {
          this.refreshTaskRepo?.updateTaskItemStarted(taskId, email);
        } catch {
          /* 忽略 */
        }
      }

      try {
        this.log(`[${email}] 开始刷新会员信息 (mode=${mode})...`);

        // 打开浏览器（Node 版失败是抛异常，映射到同一条 browser_open_failed 分支）
        let wsEndpoint = "";
        try {
          const openResult = await this.ixClient.openProfile(Number(browserId));
          wsEndpoint = openResult.ws ?? "";
        } catch (e) {
          const errorMsg = errorMessage(e) || "打开浏览器失败";
          addFailed(result, email, errorMsg, "browser_open_failed");
          this.log(`[${email}] ❌ 打开浏览器失败: ${errorMsg}`);
          this.updateTaskItemFailed(taskId, email, errorMsg);
          return;
        }

        if (!wsEndpoint) {
          addFailed(result, email, "无法获取 WebSocket 端点", "no_ws_endpoint");
          this.log(`[${email}] ❌ 无法获取 WebSocket 端点`);
          this.updateTaskItemFailed(taskId, email, "无法获取 WebSocket 端点");
          return;
        }

        // ========== 统一引擎管理：Step 1/2/3 共用同一个 BrowserUseEngine ==========
        // 关键修复：避免 Step 1 创建/销毁引擎后 SOCKS 代理失效
        // 原因：engine.stop() 调用 browser.close() 断开 CDP 连接，
        // 可能破坏浏览器的网络栈状态，导致后续 CDP 重连后 SOCKS 代理不可用

        if (mode === "full") {
          // Python 在这里检查 BROWSERUSE_ENGINE_AVAILABLE / BrowserUseEngine；
          // Node 侧引擎已移植，工厂始终存在，保留同文案兜底以防注入方给空值。
          const engineFactory = this.createBrowserUseEngine;
          if (!engineFactory) {
            throw new Error("BrowserUseEngine 不可用，无法进行 full 模式检测");
          }

          // 创建引擎实例并连接 CDP（全程共用）
          this.log(`[${email}] 创建 BrowserUseEngine（全程共用）...`);
          const engine = engineFactory();
          try {
            await engine.connectCdp(wsEndpoint);
            // Step 1: 检测 Pro 状态（使用共用引擎）
            this.log(`[${email}] Step 1: 检测 Pro 状态...`);
            let proStatus: string | null = await checkProStatusWithEngine(
              engine,
              email,
              (msg) => this.log(`[${email}] ${msg}`),
            );

            // 创建结果对象
            const refreshResult = membershipFromProStatus(
              email,
              proStatus ? proStatus : "detection_failed",
            );

            if (proStatus === null) {
              // 检测失败
              this.accountRepo?.updateProStatus(email, "detection_failed");
              addFailed(result, email, "检测失败", "detection_failed");
              this.log(`[${email}] ❌ 检测 Pro 状态失败`);
              this.updateTaskItemFailed(taskId, email, "检测失败");
            } else {
              // 检测成功
              const statusText = STATUS_TEXT_MAP[proStatus] ?? proStatus;
              this.log(`[${email}] ✅ Pro 状态: ${statusText}`);

              const detectOptions = {
                log: (msg: string) => this.log(msg),
                sleep: (seconds: number) => this.sleepImpl(seconds * 1000),
              };

              // Step 2: 检测家庭组详情（Pro 账号 + "no" 账号的反向验证）
              if (proStatus === "yes" || proStatus === "family_yes") {
                this.log(`[${email}] Step 2: 检测家庭组详情 (BrowserUseEngine)...`);
                await detectFamilyDetailsViaBrowserUse(engine, email, refreshResult, detectOptions);

                // ========== 关键协调：根据家庭组检测结果修正 is_pro ==========
                if (refreshResult.is_pro === "yes" && refreshResult.family_role === "member") {
                  this.log(`[${email}] ⚠️ 状态修正: is_pro 从 'yes' 修正为 'family_yes'（检测到家庭成员角色）`);
                  refreshResult.is_pro = "family_yes";
                  refreshResult.membership_type = "family";
                }
              } else if (proStatus === "no") {
                // ========== 反向验证 ==========
                this.log(`[${email}] Step 2 (反向验证): 检查是否实际为家庭组成员...`);
                await detectFamilyDetailsViaBrowserUse(engine, email, refreshResult, detectOptions);

                if (refreshResult.has_family_group === "yes" && refreshResult.family_role === "member") {
                  this.log(`[${email}] ⚠️ 反向验证修正: is_pro 从 'no' 修正为 'family_yes'`);
                  refreshResult.is_pro = "family_yes";
                  refreshResult.membership_type = "family";
                  proStatus = "family_yes";
                } else if (
                  refreshResult.has_family_group === "yes" &&
                  refreshResult.family_role === "manager"
                ) {
                  this.log(`[${email}] ⚠️ 反向验证修正: is_pro 从 'no' 修正为 'yes'`);
                  refreshResult.is_pro = "yes";
                  refreshResult.membership_type = "regular";
                  proStatus = "yes";
                } else {
                  this.log(`[${email}] 反向验证: 确认为非 Pro`);
                }
              }

              // Step 3: 提取账户国家（所有账号）
              this.log(`[${email}] Step 3: 提取账户国家 (BrowserUseEngine)...`);
              await extractAccountCountryViaBrowserUse(engine, email, refreshResult, detectOptions);

              // 计算剩余位置
              calculateFamilySlots(refreshResult);

              // Step 4: 写入数据库
              // （accountRepo 未注入时整段跳过写库，见文件头差异 2）
              this.accountRepo?.updateMembershipInfo({
                email,
                is_pro: refreshResult.is_pro,
                pro_plan_name: refreshResult.pro_plan_name,
                family_role: refreshResult.family_role,
                family_manager_email: refreshResult.family_manager_email,
                has_family_group: refreshResult.has_family_group,
                family_member_count: refreshResult.family_member_count,
                family_slots_left: refreshResult.family_slots_left,
                account_country: refreshResult.account_country,
                error_message: null,
              });

              addSuccess(result, email, membershipResultToDict(refreshResult));

              // 更新任务明细
              if (taskId) {
                try {
                  this.refreshTaskRepo?.updateTaskItem(
                    taskId,
                    email,
                    "success",
                    membershipResultToDict(refreshResult),
                  );
                } catch {
                  /* 忽略 */
                }
              }
            }
          } finally {
            await engine.stop(false);
          }
        } else {
          // pro_only 模式：使用独立引擎（向后兼容）
          this.log(`[${email}] Step 1: 检测 Pro 状态...`);
          const proStatus = await checkProStatusViaEngine(
            wsEndpoint,
            email,
            (ws) => this.connectProEngine(ws),
            (msg) => this.log(`[${email}] ${msg}`),
          );

          const refreshResult = membershipFromProStatus(
            email,
            proStatus ? proStatus : "detection_failed",
          );

          if (proStatus === null) {
            this.accountRepo?.updateProStatus(email, "detection_failed");
            addFailed(result, email, "检测失败", "detection_failed");
            this.log(`[${email}] ❌ 检测 Pro 状态失败`);
            this.updateTaskItemFailed(taskId, email, "检测失败");
          } else {
            const statusText = STATUS_TEXT_MAP[proStatus] ?? proStatus;
            this.log(`[${email}] ✅ Pro 状态: ${statusText}`);

            // pro_only 模式：仅更新 is_pro 字段
            this.accountRepo?.updateProStatus(email, refreshResult.is_pro);
            addSuccess(result, email, membershipResultToDict(refreshResult));
          }
        }

        // 检测完成后关闭浏览器
        try {
          await this.ixClient.closeProfile(Number(browserId));
          this.log(`[${email}] 浏览器窗口已关闭`);
        } catch (e) {
          this.log(`[${email}] 关闭窗口失败: ${errorMessage(e)}`);
        }
      } catch (e) {
        addFailed(result, email, errorMessage(e), "exception");
        this.log(`[${email}] ❌ 异常: ${errorMessage(e)}`);
        this.updateTaskItemFailed(taskId, email, errorMessage(e));
        // 尝试关闭浏览器
        try {
          await this.ixClient.closeProfile(Number(browserId));
        } catch {
          /* 忽略 */
        }
      }
    });
  }

  /** 更新任务明细为失败状态 —— 对标 _update_task_item_failed（L1738-1749） */
  private updateTaskItemFailed(taskId: number | null, email: string, errorMsg: string): void {
    if (taskId) {
      try {
        this.refreshTaskRepo?.updateTaskItem(taskId, email, "failed", { error_message: errorMsg });
      } catch {
        /* 忽略 */
      }
    }
  }
}

// ==================== 内部工具 ====================

/** 统计 `status === "success" && data.is_pro === X` 的条数（对标 L889-891 的三条 sum） */
function countByIsPro(result: BatchResult, isPro: string): number {
  return result.results.filter((r) => r.status === "success" && r.data?.["is_pro"] === isPro).length;
}

/**
 * 追加统计摘要行。
 * Python 直接往 results 里塞一个结构不同的 dict；TS 的 BatchResultItem 没有这种形状，
 * 故用一次断言写入（字段与 Python 完全一致）。
 */
function pushSummary(result: BatchResult, summary: BatchSummaryRow): void {
  result.results.push(summary as unknown as BatchResultItem);
}

// ==================== 便捷函数 ====================

/**
 * 快速批量登录 —— 对标 quick_batch_login（L2196-2217）
 * deps 是 Node 侧新增的可选参数（Python 无），便于测试注入。
 */
export async function quickBatchLogin(
  accounts: AccountDict[],
  browserIds: string[],
  options: {
    concurrency?: number;
    callback?: ProgressCallback | null;
    maxRetries?: number | null;
  } = {},
  deps: BatchProcessorDeps = {},
): Promise<BatchResult> {
  const processor = new BatchAccountProcessor(
    { concurrency: options.concurrency ?? 3, callback: options.callback ?? null },
    deps,
  );
  return processor.batchLogin(accounts, browserIds, { maxRetries: options.maxRetries ?? null });
}

/**
 * 快速批量 OAuth —— 对标 quick_batch_oauth（L2220-2239）
 * deps 是 Node 侧新增的可选参数（Python 无），便于测试注入。
 */
export async function quickBatchOauth(
  accounts: AccountDict[],
  browserIds: string[],
  options: {
    concurrency?: number;
    callback?: ProgressCallback | null;
  } = {},
  deps: BatchProcessorDeps = {},
): Promise<BatchResult> {
  const processor = new BatchAccountProcessor(
    { concurrency: options.concurrency ?? 3, callback: options.callback ?? null },
    deps,
  );
  return processor.batchOauth(accounts, browserIds);
}
