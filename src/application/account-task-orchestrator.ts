/**
 * 账号任务编排执行器（Node 重写）
 *
 * 负责批量登录 / 批量删除。
 *
 * 设计取舍：
 *   1. 依赖（批处理器、仓储、ixBrowser 回调）一律由调用方注入，本文件不触碰
 *      全局单例，也不 import app/ 层；后台任务外壳（TaskRunner）在 app/host/handlers/accounts.ts。
 *   2. 批量处理直接跑在 async 函数里，不额外开线程。
 *   3. 日志回调里保留 should_stop 兜底检查，同时通过 onStop 钩子
 *      在用户点停止的那一刻立即调 processor.stop()。
 *   4. 逐条目 / 进度 / 关窗都由批处理器的逐账号回调（onAccountDone）驱动，
 *      不再从日志文本猜进度；需要收尾动作时由调用方注入 closeBrowser。
 *   5. 结果里的超长字符串（例如页面文本）截断到 MAX_RESULT_STRING，字段名不变。
 */
import { batchResultToDict, type BatchResult } from "../automation/batch/types.ts";
import {
  BatchAccountProcessor,
  type AccountDoneCallback,
  type AccountDoneStatus,
  type BatchProcessorDeps,
} from "../automation/batch-account-processor.ts";
import type { IxBrowserClient } from "../ixbrowser/client.ts";
import { deleteBrowserById, type IxWindowClient } from "../ixbrowser/window.ts";

export type AccountDict = Record<string, unknown>;
export type LogFn = (message: string) => void;

/** 结果中单个字符串的最大长度（超出截断并加省略号） */
export const MAX_RESULT_STRING = 500;

// ==================== 结果骨架 ====================

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

/** 批量删除结果骨架 */
export function createBatchDeleteResults(total: number): BatchDeleteResults {
  return { total, deleted_accounts: 0, deleted_windows: 0, failed_count: 0, failed_list: [] };
}


/** 任务被停止时的结果骨架 */
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

// ==================== 批量删除 ====================

/** ixBrowser 窗口 ID 必须是纯数字字符串 */
export function isValidWindowId(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * 批量删除
 *
 * 设计取舍：
 *   1. 顺序是「先删账号，账号删除成功后再关闭 / 删除窗口」。
 *      先删窗口的话，账号删除失败时会留下指向已删除窗口的账号记录；当前顺序最多留下一个孤立窗口。
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
  /** 逐条目结果（任务历史用） */
  item?: (key: string, status: string, message: string) => void;
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
        params.item?.(email, "失败", "数据库中未删除该账号");
      } else {
        accountDeleted = true;
        results.deleted_accounts += 1;
        log(`已删除: ${email}`);
        params.item?.(email, "成功", "");
      }
    } catch (error) {
      results.failed_count += 1;
      results.failed_list.push({ email, error: errorText(error) });
      log(`删除 ${email} 失败: ${errorText(error)}`);
      params.item?.(email, "失败", errorText(error));
    }

    if (accountDeleted && withWindows && browserId) {
      if (!isValidWindowId(browserId)) {
        log(`窗口 ID 非法，跳过删除窗口: ${browserId}`);
      } else {
        try {
          await params.closeBrowser(browserId);
        } catch {
          // 关闭失败忽略
        }
        try {
          const r = await params.deleteBrowser(browserId);
          if (r && r.success) results.deleted_windows += 1;
        } catch {
          // 删除窗口失败忽略
        }
      }
    }
    progress(index + 1);
  }
  return results;
}

/** 批量删除用到的窗口操作 */
export interface WindowOps {
  closeBrowser: (browserId: string) => Promise<unknown>;
  deleteBrowser: (browserId: string) => Promise<{ success: boolean }>;
}

/**
 * 批量删除的默认窗口操作（账号管理页与设置页共用同一套）。
 * client 传取客户端的函数：真正删窗口时才创建 ixBrowser 客户端，handler 工厂保持惰性。
 * 删除走 deleteBrowserById（可重试错误按退避重试，失败返回 false）。
 */
export function createIxWindowOps(deps: {
  client: () => IxWindowClient & Pick<IxBrowserClient, "closeProfile">;
  log?: LogFn;
  sleep?: (ms: number) => Promise<void>;
}): WindowOps {
  return {
    closeBrowser: (id) => deps.client().closeProfile(Number(id)),
    deleteBrowser: async (id) => ({
      success: await deleteBrowserById(
        {
          client: deps.client(),
          ...(deps.log ? { log: deps.log } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        },
        id,
      ),
    }),
  };
}

// ==================== 批处理任务 ====================

/** 账号批处理任务类型 */
export type WorkerTaskType = "login";

/** LLM 参数（由调用方从配置读出后传入；未配置时为 null） */
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

/**
 * 创建批处理器的选项（handler 的默认工厂与单测替身都按这个形状实现）：
 * callback 收日志，onAccountDone 收逐账号结束事件（进度 / 条目 / 关窗都靠它）。
 */
export interface WorkerProcessorOptions {
  concurrency: number;
  callback: LogFn;
  onAccountDone?: AccountDoneCallback;
}

/** 默认批处理器工厂；必须注入 db，否则批处理器会跳过写库 */
export function createBatchProcessor(
  deps: Pick<BatchProcessorDeps, "config"> & { db: NonNullable<BatchProcessorDeps["db"]> },
  options: WorkerProcessorOptions,
): BatchAccountProcessor {
  return new BatchAccountProcessor(
    { concurrency: options.concurrency, callback: options.callback, onAccountDone: options.onAccountDone ?? null },
    { config: deps.config, db: deps.db },
  );
}
/** 把 BatchResult 转成普通对象（字段名不变），并截断超长字符串 */
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

/** 按任务类型把一批账号交给批处理器执行，返回可跨进程传输的结果 */
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

/** 批处理器回调的状态 → 界面 / 任务历史口径 */
const ACCOUNT_ITEM_STATUS: Record<AccountDoneStatus, string> = {
  success: "成功",
  failed: "失败",
  skipped: "跳过",
};

/**
 * 执行账号 worker 任务：创建批处理器、注册停止钩子、汇总结果。
 *
 * 逐条目、进度、关窗三件事都在这里由批处理器的逐账号回调统一驱动：
 *   - 逐条目：`item(email, 成功|失败|跳过, message)`（任务历史只保留最终一条）
 *   - 进度：成功 + 失败累加（跳过没真正处理，不计入），所以进度与账号数严格对应
 *   - 关窗：closeWindow 为真时只关**成功**账号的窗口；失败 / 跳过保留窗口，便于人工排查
 * 关窗走注入的 closeBrowser（ixBrowser closeProfile），此时登录引擎已关闭，不会互相干扰。
 */
export async function executeAccountWorkerTask(params: {
  taskType: string;
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  concurrency: number;
  llm: LlmParams;
  /** 登录成功后是否关闭该账号的窗口；失败与跳过一律保留 */
  closeWindow?: boolean;
  /** 关窗实现；不传则不关窗 */
  closeBrowser?: (browserId: string) => Promise<unknown> | unknown;
  shouldStop: () => boolean;
  /** 注册停止钩子（TaskApi.onStop） */
  onStop: (fn: () => void) => void;
  log: LogFn;
  /** 精确进度回调（成功 + 失败累加） */
  progress?: (current: number, total: number) => void;
  /** 创建批处理器；callback 为日志回调，onAccountDone 为逐账号结束回调 */
  createProcessor: (options: WorkerProcessorOptions) => WorkerProcessor;
  /** 逐条目结果上报（任务历史用） */
  item?: (key: string, status: string, message: string) => void;
}): Promise<Record<string, unknown>> {
  const { taskType, shouldStop, log } = params;
  let processor: WorkerProcessor | null = null;
  let stopLogged = false;
  let done = 0;
  const total = params.accounts.length;

  // 关窗要按账号找窗口：以数据库下发的 browserIds 与 accounts 一一对应（编排层的既有约定）
  const browserIdByEmail = new Map<string, string>();
  params.accounts.forEach((account, index) => {
    const id = params.browserIds[index];
    if (id) browserIdByEmail.set(emailOf(account), id);
  });

  const onAccountDone: AccountDoneCallback = (email, status, message) => {
    params.item?.(email, ACCOUNT_ITEM_STATUS[status], message);
    if (status === "skipped") return;
    done += 1;
    params.progress?.(Math.min(done, total), total);
    if (status !== "success" || !params.closeWindow) return;
    const browserId = browserIdByEmail.get(email);
    if (!browserId || !params.closeBrowser) return;
    try {
      // 关窗失败只记日志，不影响登录结果与进度
      void Promise.resolve(params.closeBrowser(browserId)).catch((e: unknown) =>
        log(`关闭窗口失败: ${browserId} ${errorText(e)}`),
      );
      log(`已关闭窗口 ${browserId}: ${email}`);
    } catch (e) {
      log(`关闭窗口失败: ${browserId} ${errorText(e)}`);
    }
  };

  // 进度回调：转发日志，并在收到日志时兜底检查停止请求
  const processorProgress = (message: string): void => {
    log(message);
    if (shouldStop()) {
      processor?.stop();
      if (!stopLogged) {
        stopLogged = true;
        log("用户停止任务");
      }
    }
  };

  processor = params.createProcessor({
    concurrency: params.concurrency,
    callback: processorProgress,
    onAccountDone,
  });
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

// ==================== 完成日志 ====================

function num(obj: unknown, key: string): number {
  if (obj === null || typeof obj !== "object") return 0;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "number" ? v : 0;
}
/**
 * 批处理任务结束时的日志行
 */
export function workerFinishedLogLines(result: Record<string, unknown>): string[] {
  const type = result["type"];
  const r = result["result"];
  if (type === "stopped") return [`任务已停止: ${String(result["task_type"] ?? "")}`];
  if (type === "login")
    return [`登录完成: 成功 ${num(r, "success_count")}, 失败 ${num(r, "failed_count")}, 跳过 ${num(r, "skipped_count")}`];
  return [];
}

