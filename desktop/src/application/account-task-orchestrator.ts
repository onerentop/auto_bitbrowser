/**
 * 账号任务编排执行器（Node 重写）
 *
 * 对标：
 *   application/account_task_orchestrator.py —— 批量登录 / 批量绑定 / 批量删除
 *   application/automation_engine_adapter.py:16-102 —— create_batch_processor / run_account_worker_task
 *     （仅登录分支）
 *
 * 与 Python 的差异：
 *   1. 依赖（批处理器、仓储、ixBrowser 回调）一律由调用方注入，本文件不触碰
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

// ==================== 批处理任务（adapter :30-102 + orchestrator :386-454） ====================

/** 账号批处理任务类型 */
export type WorkerTaskType = "login";

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
  llm: LlmParams;
}): Promise<Record<string, unknown>> {
  const { taskType, processor, llm } = params;
  const accounts = [...params.accounts];
  const browserIds = [...params.browserIds];

  if (taskType === "login") {
    const result = await processor.batchLogin(accounts, browserIds, { ...llm });
    return { type: "login", result: batchResultPayload(result) };
  }
  return { type: "unknown" };
}

/** 对标 execute_account_worker_task（:386-454） */
export async function executeAccountWorkerTask(params: {
  taskType: string;
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  concurrency: number;
  llm: LlmParams;
  shouldStop: () => boolean;
  /** 注册停止钩子（TaskApi.onStop） */
  onStop: (fn: () => void) => void;
  log: LogFn;
  /** 从日志解析进度（createLogProgressTracker 的返回值） */
  progressFromLog: LogFn;
  /** 对标 create_batch_processor(concurrency)；callback 即 processor_progress */
  createProcessor: (options: { concurrency: number; callback: LogFn }) => WorkerProcessor;
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
    llm: params.llm,
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
/**
 * 批处理任务结束时的日志行 —— 对标 gui/account_manager_interface.py:1383-1431 的 _onTaskFinished
 */
export function workerFinishedLogLines(result: Record<string, unknown>): string[] {
  const type = result["type"];
  const r = result["result"];
  if (type === "stopped") return [`任务已停止: ${String(result["task_type"] ?? "")}`];
  if (type === "login")
    return [`登录完成: 成功 ${num(r, "success_count")}, 失败 ${num(r, "failed_count")}, 跳过 ${num(r, "skipped_count")}`];
  return [];
}
