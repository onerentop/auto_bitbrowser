/**
 * 账号任务编排执行器（Node 重写）
 *
 * 对标：
 *   application/account_task_orchestrator.py —— 除家庭组加入（execute_batch_join_family /
 *     execute_single_join_family）外的全部方法
 *   application/automation_engine_adapter.py:16-102 —— create_sub2api_client /
 *     create_batch_processor / run_account_worker_task
 *
 * 与 Python 的差异：
 *   1. 依赖（批处理器、Sub2API 客户端、仓储、ixBrowser 回调）一律由调用方注入，本文件不触碰
 *      全局单例，也不 import app/ 层；后台任务外壳（TaskRunner）在 app/host/handlers/accounts.ts。
 *   2. Python 用 new_event_loop + run_until_complete 把协程跑在线程里；这里直接 async。
 *   3. Python 在 processor_progress 里「收到日志时才发现 should_stop 并调 processor.stop()」；
 *      这里保留该逻辑，同时通过 onStop 钩子在用户点停止的那一刻立即调 processor.stop()。
 *   4. 日志解析进度（:417-424）由调用方传入 progressFromLog（app/host/task-runner.ts 的
 *      createLogProgressTracker 逐字照搬了该规则），避免 src → app 的反向依赖。
 *   5. 结果里的超长字符串（例如页面文本）截断到 MAX_RESULT_STRING，字段名不变。
 */
import { batchResultToDict, type BatchResult } from "../automation/batch/types.ts";

export type AccountDict = Record<string, unknown>;
export type LogFn = (message: string) => void;

/** 结果中单个字符串的最大长度（超出截断并加省略号） */
export const MAX_RESULT_STRING = 500;

// ==================== 结果骨架（照搬 :20-80） ====================

export interface BatchBindResults {
  total: number;
  success_count: number;
  failed_count: number;
  failed_list: Array<{ email: string; error: string }>;
}

export interface BatchDeleteResults {
  total: number;
  deleted_accounts: number;
  deleted_windows: number;
  failed_count: number;
  failed_list: Array<{ email: string; error: string }>;
}

export interface EnableFamilySharingResults {
  total: number;
  success_count: number;
  already_enabled_count: number;
  family_created_count: number;
  failed_count: number;
  failed_list: Array<{ email: string; error: string }>;
}

export interface Detect403Results {
  total: number;
  needs_unlock: number;
  accounts: string[];
}

export interface StoppedResult {
  type: "stopped";
  task_type: string;
  message: string;
}

/** 对标 create_batch_bind_results（:21-28） */
export function createBatchBindResults(total: number): BatchBindResults {
  return { total, success_count: 0, failed_count: 0, failed_list: [] };
}

/** 对标 create_batch_delete_results（:31-39） */
export function createBatchDeleteResults(total: number): BatchDeleteResults {
  return { total, deleted_accounts: 0, deleted_windows: 0, failed_count: 0, failed_list: [] };
}

/** 对标 create_enable_family_sharing_results（:53-62） */
export function createEnableFamilySharingResults(total: number): EnableFamilySharingResults {
  return {
    total,
    success_count: 0,
    already_enabled_count: 0,
    family_created_count: 0,
    failed_count: 0,
    failed_list: [],
  };
}

/** 对标 create_detect_403_results（:65-71） */
export function createDetect403Results(total: number): Detect403Results {
  return { total, needs_unlock: 0, accounts: [] };
}

/** 对标 create_stopped_result（:74-80） */
export function createStoppedResult(taskType: string): StoppedResult {
  return { type: "stopped", task_type: taskType, message: "用户停止任务" };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emailOf(account: AccountDict): string {
  const v = account["email"];
  return v === null || v === undefined ? "" : String(v);
}

// ==================== 开启家庭共享（:170-230） ====================

/** 对标 run_enable_family_sharing 返回值中被读取的字段 */
export interface EnableSharingOutcome {
  success: boolean;
  message: string;
  wasAlreadyEnabled?: boolean;
  familyCreated?: boolean;
}

export type EnableSharingFn = (account: AccountDict, browserId: string, callback: LogFn) => Promise<EnableSharingOutcome>;

/** 对标 execute_enable_family_sharing（:170-230） */
export async function executeEnableFamilySharing(params: {
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  shouldStop: () => boolean;
  log: LogFn;
  progress: (current: number) => void;
  runEnableSharing: EnableSharingFn;
}): Promise<EnableFamilySharingResults> {
  const { accounts, browserIds, shouldStop, log, progress } = params;
  const results = createEnableFamilySharingResults(accounts.length);
  const total = accounts.length;
  const n = Math.min(accounts.length, browserIds.length);

  for (let index = 0; index < n; index++) {
    if (shouldStop()) {
      log("用户停止任务");
      break;
    }
    const account = accounts[index] as AccountDict;
    const browserId = browserIds[index] as string;
    const email = emailOf(account);
    log(`[${index + 1}/${total}] 开启共享: ${email}`);

    try {
      const r = await params.runEnableSharing(account, browserId, log);
      if (r.success) {
        if (r.wasAlreadyEnabled) {
          results.already_enabled_count += 1;
          log(`✅ ${email} 已开启共享（跳过）`);
        } else {
          results.success_count += 1;
          if (r.familyCreated) {
            results.family_created_count += 1;
            log(`✅ ${email} 成功创建家庭组并开启共享`);
          } else {
            log(`✅ ${email} 成功开启家庭共享`);
          }
        }
      } else {
        results.failed_count += 1;
        results.failed_list.push({ email, error: r.message || "未知错误" });
        log(`❌ ${email} 开启失败: ${r.message}`);
      }
    } catch (error) {
      results.failed_count += 1;
      results.failed_list.push({ email, error: errorText(error) });
      log(`❌ ${email} 异常: ${errorText(error)}`);
    }

    progress(index + 1);
  }
  return results;
}

// ==================== 批量绑定（:233-259） ====================

/**
 * 对标 execute_batch_bind（:233-259）
 *
 * 与 Python 的有意偏差：
 *   1. bindAccount 返回 false（数据库未写入）时计为失败 —— Python 不检查 bind_account_to_browser 的返回值，
 *      会把写库失败当成成功计数。
 *   2. 提供 ownerOf 时，每条执行前再查一次窗口当前归属；已被其他账号占用则记失败并跳过，
 *      避免预检与执行之间数据变化导致同一窗口绑给两个账号。
 */
export function executeBatchBind(params: {
  matchedPairs: ReadonlyArray<readonly [string, string]>;
  shouldStop: () => boolean;
  bindAccount: (email: string, browserId: string) => boolean | void;
  /** 查询窗口当前绑定的账号邮箱（未绑定返回 null）；对标 getAccountByBrowser */
  ownerOf?: (browserId: string) => string | null;
  log: LogFn;
  progress: (current: number) => void;
}): BatchBindResults {
  const { matchedPairs, shouldStop, log, progress } = params;
  const results = createBatchBindResults(matchedPairs.length);
  const fail = (email: string, error: string): void => {
    results.failed_count += 1;
    results.failed_list.push({ email, error });
    log(`绑定失败: ${email} - ${error}`);
  };
  for (let index = 0; index < matchedPairs.length; index++) {
    if (shouldStop()) {
      log("用户停止任务");
      break;
    }
    const [email, browserId] = matchedPairs[index] as readonly [string, string];
    try {
      const owner = params.ownerOf?.(browserId) ?? null;
      if (owner && owner !== email) {
        fail(email, `窗口 ${browserId} 已被账号 ${owner} 绑定`);
      } else if (params.bindAccount(email, browserId) === false) {
        fail(email, "写入数据库失败");
      } else {
        results.success_count += 1;
        log(`绑定: ${email} -> ${browserId}`);
      }
    } catch (error) {
      fail(email, errorText(error));
    }
    progress(index + 1);
  }
  return results;
}

// ==================== 批量删除（:262-309） ====================

/** ixBrowser 窗口 ID 必须是纯数字字符串 */
export function isValidWindowId(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * 对标 execute_batch_delete（:262-309）
 *
 * 与 Python 的有意偏差：
 *   1. 顺序改为「先删账号，账号删除成功后再关闭 / 删除窗口」。Python 先删窗口再删账号，
 *      账号删除失败时会留下指向已删除窗口的账号记录；反过来最多留下一个孤立窗口。
 *   2. deleteAccount 返回 false（库里没删掉）时计为失败，不计入 deleted_accounts，也不删窗口。
 *   3. 窗口 ID 不是纯数字字符串时不调用 closeBrowser / deleteBrowser，只记日志。
 */
export async function executeBatchDelete(params: {
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  withWindows: boolean;
  shouldStop: () => boolean;
  deleteAccount: (email: string) => boolean | void;
  closeBrowser: (browserId: string) => Promise<unknown> | unknown;
  deleteBrowser: (browserId: string) => Promise<{ success: boolean }> | { success: boolean };
  log: LogFn;
  progress: (current: number) => void;
}): Promise<BatchDeleteResults> {
  const { accounts, browserIds, withWindows, shouldStop, log, progress } = params;
  const results = createBatchDeleteResults(accounts.length);

  for (let index = 0; index < accounts.length; index++) {
    if (shouldStop()) {
      log("用户停止任务");
      break;
    }
    const email = emailOf(accounts[index] as AccountDict);
    const browserId = index < browserIds.length ? (browserIds[index] as string) : "";

    let accountDeleted = false;
    try {
      if (params.deleteAccount(email) === false) {
        results.failed_count += 1;
        results.failed_list.push({ email, error: "数据库中未删除该账号" });
        log(`删除 ${email} 失败: 数据库中未删除该账号`);
      } else {
        accountDeleted = true;
        results.deleted_accounts += 1;
        log(`已删除: ${email}`);
      }
    } catch (error) {
      results.failed_count += 1;
      results.failed_list.push({ email, error: errorText(error) });
      log(`删除 ${email} 失败: ${errorText(error)}`);
    }

    if (accountDeleted && withWindows && browserId) {
      if (!isValidWindowId(browserId)) {
        log(`窗口 ID 非法，跳过删除窗口: ${browserId}`);
      } else {
        try {
          await params.closeBrowser(browserId);
        } catch {
          // 照搬 Python：关闭失败忽略
        }
        try {
          const r = await params.deleteBrowser(browserId);
          if (r && r.success) results.deleted_windows += 1;
        } catch {
          // 照搬 Python：删除窗口失败忽略
        }
      }
    }
    progress(index + 1);
  }
  return results;
}

// ==================== 403 检测（:312-383） ====================

/** Sub2API 客户端中本编排用到的方法（真实实现：src/services/sub2api-client.ts） */
export interface Sub2ApiForOrchestrator {
  checkAccountExists(email: string): Promise<number | null>;
  testAccountConnection(
    accountId: number,
    modelId?: string,
  ): Promise<{ success: boolean; data?: Record<string, unknown> | null; error?: string | null }>;
  close?(): Promise<void>;
}

/** 403 检测需要写库的方法（真实实现：AccountRepository） */
export interface Detect403Repo {
  updateSub2apiStatus(email: string, status: string, accountId?: number | null): unknown;
  updateUnlockStatus(email: string, status: string, validationUrl?: string | null): unknown;
}

/** 对标 execute_detect_403（:312-383） */
export async function executeDetect403(params: {
  accounts: readonly AccountDict[];
  shouldStop: () => boolean;
  log: LogFn;
  progress: (current: number) => void;
  createSub2ApiClient: () => Sub2ApiForOrchestrator;
  repo: Detect403Repo;
}): Promise<Detect403Results> {
  const { shouldStop, log, progress, repo } = params;
  const client = params.createSub2ApiClient();
  try {
    const accountsToCheck = params.accounts.filter((a) => a["sub2api_status"] === "linked");
    if (accountsToCheck.length === 0) return createDetect403Results(0);

    const total = accountsToCheck.length;
    const needsUnlockAccounts: string[] = [];

    for (let index = 0; index < accountsToCheck.length; index++) {
      if (shouldStop()) {
        log("用户停止任务");
        break;
      }
      const account = accountsToCheck[index] as AccountDict;
      const email = emailOf(account);
      let accountId: unknown = account["sub2api_account_id"];

      if (!accountId) {
        log(`[${email}] 缺少 account_id，正在查询...`);
        accountId = await client.checkAccountExists(email);
        if (accountId) {
          repo.updateSub2apiStatus(email, "linked", Number(accountId));
          log(`[${email}] 已获取 account_id: ${String(accountId)}`);
        } else {
          log(`[${email}] 在 Sub2API 中未找到，修正状态为未关联`);
          repo.updateSub2apiStatus(email, "not_linked");
          progress(index + 1);
          continue;
        }
      }

      log(`[${email}] 检测中...`);
      const response = await client.testAccountConnection(Number(accountId));
      if (!response.success) {
        const data = response.data ?? {};
        if (data["needs_unlock"]) {
          const validationUrl = typeof data["validation_url"] === "string" ? data["validation_url"] : "";
          repo.updateUnlockStatus(email, "needs_unlock", validationUrl);
          needsUnlockAccounts.push(email);
          log(`[${email}] 需要解锁`);
        } else {
          // Python 打印 None 的位置还原为 "None"
          log(`[${email}] 检测失败: ${response.error ?? "None"}`);
        }
      } else {
        log(`[${email}] 正常`);
      }
      progress(index + 1);
    }

    return { total, needs_unlock: needsUnlockAccounts.length, accounts: needsUnlockAccounts };
  } finally {
    // 对标 `async with ... as client` 的退出
    await client.close?.().catch(() => {});
  }
}

// ==================== 批处理任务（adapter :30-102 + orchestrator :386-454） ====================

/** 账号批处理任务类型 */
export type WorkerTaskType =
  | "login"
  | "oauth"
  | "login_and_oauth"
  | "unlock_403"
  | "refresh_membership_info"
  | "detect_pro";

/** LLM 参数（Python 侧均为 None，由下游 use_config 读取配置；这里由调用方从配置读出后传入） */
export interface LlmParams {
  apiKey: string | null;
  model: string | null;
  provider: string | null;
}

/** BatchAccountProcessor 中本编排用到的方法（结构类型，真实实现即可直接满足） */
export interface WorkerProcessor {
  batchLogin(
    accounts: AccountDict[],
    browserIds: string[],
    options?: { apiKey?: string | null; model?: string | null; provider?: string | null; maxRetries?: number | null },
  ): Promise<BatchResult>;
  batchOauth(
    accounts: AccountDict[],
    browserIds: string[],
    options?: {
      sub2apiClient?: Sub2ApiForOrchestrator | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
      skipLogin?: boolean;
      autoBindProxy?: boolean;
    },
  ): Promise<BatchResult>;
  batchLoginAndOauth(
    accounts: AccountDict[],
    browserIds: string[],
    options?: {
      sub2apiClient?: Sub2ApiForOrchestrator | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
      autoBindProxy?: boolean;
      maxRetries?: number | null;
    },
  ): Promise<{ login: BatchResult; oauth: BatchResult }>;
  batchUnlock403(
    accounts: AccountDict[],
    browserIds: string[],
    options?: {
      smsToken?: string | null;
      countryId?: number | null;
      projectId?: number | null;
      maxRetries?: number | null;
      apiKey?: string | null;
      model?: string | null;
      provider?: string | null;
    },
  ): Promise<BatchResult>;
  batchRefreshMembershipInfo(accounts: AccountDict[], browserIds: string[], mode?: string): Promise<BatchResult>;
  stop(): void;
}

/** 把 BatchResult 转成 Python to_dict() 的形状，并截断超长字符串 */
export function batchResultPayload(result: BatchResult): Record<string, unknown> {
  return truncateLongStrings(batchResultToDict(result)) as Record<string, unknown>;
}

/** 递归截断超长字符串（结果要跨进程传给界面，避免页面文本等大字段） */
export function truncateLongStrings(value: unknown, max = MAX_RESULT_STRING): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}…` : value;
  if (Array.isArray(value)) return value.map((v) => truncateLongStrings(v, max));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = truncateLongStrings(v, max);
    return out;
  }
  return value;
}

/** 对标 AutomationEngineAdapter.run_account_worker_task（adapter :30-104） */
export async function runAccountWorkerTask(params: {
  taskType: string;
  processor: WorkerProcessor;
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  autoBindProxy: boolean;
  smsToken: string | null;
  countryId: number | null;
  projectId: number | null;
  maxRetries: number | null;
  llm: LlmParams;
  createSub2ApiClient: () => Sub2ApiForOrchestrator;
}): Promise<Record<string, unknown>> {
  const { taskType, processor, autoBindProxy, llm } = params;
  const accounts = [...params.accounts];
  const browserIds = [...params.browserIds];

  // 对标 `async with create_sub2api_client() as client`
  const withClient = async <T>(fn: (client: Sub2ApiForOrchestrator) => Promise<T>): Promise<T> => {
    const client = params.createSub2ApiClient();
    try {
      return await fn(client);
    } finally {
      await client.close?.().catch(() => {});
    }
  };

  if (taskType === "login") {
    const result = await processor.batchLogin(accounts, browserIds, { ...llm });
    return { type: "login", result: batchResultPayload(result) };
  }
  if (taskType === "oauth") {
    const result = await withClient((client) =>
      processor.batchOauth(accounts, browserIds, { sub2apiClient: client, autoBindProxy, ...llm }),
    );
    return { type: "oauth", result: batchResultPayload(result) };
  }
  if (taskType === "login_and_oauth") {
    const results = await withClient((client) =>
      processor.batchLoginAndOauth(accounts, browserIds, { sub2apiClient: client, autoBindProxy, ...llm }),
    );
    return {
      type: "login_and_oauth",
      login_result: batchResultPayload(results.login),
      oauth_result: batchResultPayload(results.oauth),
    };
  }
  if (taskType === "unlock_403") {
    const result = await processor.batchUnlock403(accounts, browserIds, {
      smsToken: params.smsToken,
      countryId: params.countryId,
      projectId: params.projectId,
      maxRetries: params.maxRetries,
      ...llm,
    });
    return { type: "unlock_403", result: batchResultPayload(result) };
  }
  if (taskType === "refresh_membership_info") {
    // 照搬 adapter :86-87：mode 固定 full
    const result = await processor.batchRefreshMembershipInfo(accounts, browserIds, "full");
    return { type: "refresh_membership_info", result: batchResultPayload(result) };
  }
  if (taskType === "detect_pro") {
    // 照搬 adapter :95-102：detect_pro 内部转发到 pro_only 模式的刷新
    const result = await processor.batchRefreshMembershipInfo(accounts, browserIds, "pro_only");
    return { type: "detect_pro", result: batchResultPayload(result) };
  }
  return { type: "unknown" };
}

/** 对标 execute_account_worker_task（:386-454） */
export async function executeAccountWorkerTask(params: {
  taskType: string;
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  concurrency: number;
  smsToken: string | null;
  countryId: number | null;
  projectId: number | null;
  maxRetries: number | null;
  autoBindProxy: boolean;
  llm: LlmParams;
  shouldStop: () => boolean;
  /** 注册停止钩子（TaskApi.onStop） */
  onStop: (fn: () => void) => void;
  log: LogFn;
  /** 从日志解析进度（createLogProgressTracker 的返回值） */
  progressFromLog: LogFn;
  /** 对标 create_batch_processor(concurrency)；callback 即 processor_progress */
  createProcessor: (options: { concurrency: number; callback: LogFn }) => WorkerProcessor;
  createSub2ApiClient: () => Sub2ApiForOrchestrator;
}): Promise<Record<string, unknown>> {
  const { taskType, shouldStop, log } = params;
  let processor: WorkerProcessor | null = null;
  let stopLogged = false;

  // 对标 processor_progress（:406-424）
  const processorProgress = (message: string): void => {
    log(message);
    if (shouldStop()) {
      processor?.stop();
      if (!stopLogged) {
        stopLogged = true;
        log("用户停止任务");
      }
    }
    params.progressFromLog(message);
  };

  processor = params.createProcessor({ concurrency: params.concurrency, callback: processorProgress });
  const p = processor;
  params.onStop(() => p.stop());

  if (shouldStop()) return { ...createStoppedResult(taskType) };
  const result = await runAccountWorkerTask({
    taskType,
    processor: p,
    accounts: params.accounts,
    browserIds: params.browserIds,
    autoBindProxy: params.autoBindProxy,
    smsToken: params.smsToken,
    countryId: params.countryId,
    projectId: params.projectId,
    maxRetries: params.maxRetries,
    llm: params.llm,
    createSub2ApiClient: params.createSub2ApiClient,
  });
  if (shouldStop()) return { ...createStoppedResult(taskType) };
  return result;
}

// ==================== 完成日志（照搬界面层的 finished 处理） ====================

function num(obj: unknown, key: string): number {
  if (obj === null || typeof obj !== "object") return 0;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : 0;
}

function summaryRow(result: unknown): Record<string, unknown> {
  const list = result && typeof result === "object" ? (result as Record<string, unknown>)["results"] : null;
  if (!Array.isArray(list)) return {};
  const row = list.find((x) => x && typeof x === "object" && (x as Record<string, unknown>)["_summary"]);
  return (row as Record<string, unknown> | undefined) ?? {};
}

/**
 * 批处理任务结束时的日志行 —— 对标 gui/account_manager_interface.py:1383-1431 的 _onTaskFinished
 */
export function workerFinishedLogLines(result: Record<string, unknown>): string[] {
  const type = result["type"];
  const r = result["result"];
  if (type === "stopped") return [`任务已停止: ${String(result["task_type"] ?? "")}`];
  if (type === "login")
    return [`登录完成: 成功 ${num(r, "success_count")}, 失败 ${num(r, "failed_count")}, 跳过 ${num(r, "skipped_count")}`];
  if (type === "oauth")
    return [`OAuth 完成: 成功 ${num(r, "success_count")}, 失败 ${num(r, "failed_count")}, 跳过 ${num(r, "skipped_count")}`];
  if (type === "login_and_oauth") {
    const lr = result["login_result"];
    const or = result["oauth_result"];
    return [
      "登录+OAuth 完成",
      `   登录: 成功 ${num(lr, "success_count")}, 失败 ${num(lr, "failed_count")}`,
      `   OAuth: 成功 ${num(or, "success_count")}, 失败 ${num(or, "failed_count")}`,
    ];
  }
  if (type === "unlock_403")
    return [`403 解锁完成: 成功 ${num(r, "success_count")}, 失败 ${num(r, "failed_count")}, 跳过 ${num(r, "skipped_count")}`];
  if (type === "detect_pro" || type === "refresh_membership_info") {
    const s = summaryRow(r);
    const head = type === "detect_pro" ? "Pro 检测完成" : "会员信息刷新完成";
    return [
      `${head}: Pro ${num(s, "pro_regular_count")}, Pro(家庭组) ${num(s, "pro_family_count")}, 非Pro ${num(s, "non_pro_count")}, 失败 ${num(r, "failed_count")}`,
    ];
  }
  return [];
}
