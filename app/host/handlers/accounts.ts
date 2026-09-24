/**
 * 账号管理页 的后端 handler（账号列表 / 绑定窗口 / 批量任务）
 *
 * 通道一览（定义见 app/shared/channels/accounts.ts）：
 *   list / getDefaults / bindCandidates / bind / deleteOne  —— 同步查询或单条写库
 *   （账号数据的 get / add / update / import / exportText 在 handlers/account-data.ts，add / import 后自动绑定窗口）
 *   precheck / start                                                   —— 批量操作（start 启动后台任务）
 *
 * 批量操作全部走 ctx.tasks（全局单任务，重复启动抛 TASK_BUSY）；
 * 候选筛选 / 确认文案在 src/application/account-plan.ts，执行逻辑在 src/application/account-task-orchestrator.ts。
 * 依赖（批处理器、窗口操作）可通过第二参数注入，单测全部离线。
 */
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import {
  ACCOUNTS_ACTIONS,
  ACCOUNTS_INVOKE,
  type AccountsAction,
  type AccountsBindCandidates,
  type AccountsBindResult,
  type AccountsDefaults,
  type AccountsListResult,
  type AccountsPrecheckResult,
  type AccountsRunOptions,
  type SelectedRow,
} from "../../shared/channels/accounts.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import type { TaskApi } from "../task-runner.ts";
import { planAction, staleLog, toPrecheckResult, type PlanEnv, type TaskSpec } from "../../../src/application/account-plan.ts";
import type { WindowLike } from "../../../src/application/account-manager-service.ts";
import {
  createBatchProcessor,
  createIxWindowOps,
  executeAccountWorkerTask,
  executeBatchDelete,
  workerFinishedLogLines,
  type LlmParams,
  type WorkerProcessor,
  type WorkerProcessorOptions,
} from "../../../src/application/account-task-orchestrator.ts";
import type { ConfigManager } from "../../../src/core/config-manager.ts";
import {
  defaultHealthCheck,
  executeHealthCheck,
  healthCheckSummaryLine,
  type HealthCheckResult,
} from "../../../src/application/health-check.ts";
import { buildAccountRows } from "../../../src/application/account-list.ts";
import { rankBindCandidates } from "../../../src/application/window-binding.ts";
import { getGroupList } from "../../../src/ixbrowser/groups.ts";
import type { IxBrowserClient } from "../../../src/ixbrowser/client.ts";
import { BACKOFF_FACTOR, BASE_DELAY, MAX_RETRIES, isRetryableError } from "../../../src/ixbrowser/window.ts";
import { HOME_LIST_PAGE_SIZE } from "./home.ts";

/** 并发数范围（1-10） */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 10;

/** 单次请求最多处理的行数（防御性上限） */
export const MAX_ROWS = 100_000;

export interface AccountsHandlerDeps {
  /** 批处理器工厂 */
  createProcessor?: (options: { concurrency: number; callback: (msg: string) => void }) => WorkerProcessor;
  /** 关闭窗口 */
  closeBrowser?: (browserId: string) => Promise<unknown>;
  /** 删除窗口 */
  deleteBrowser?: (browserId: string) => Promise<{ success: boolean }>;
  /** 取全部窗口（默认 listAllWindows 翻页取全量），失败抛错 */
  listWindows?: () => Promise<WindowLike[]>;
  /** 取分组列表（默认 getGroupList，出错返回 []） */
  listGroups?: () => Promise<unknown[]>;
  /** 测试注入：跳过 ixBrowser 重试的真实等待（默认 listWindows / listGroups 用） */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 账号健康巡检的单账号判定（本地新增）。默认走 autoHealthCheck（真机连窗口只读判定），
   * 单测注入假实现以保持离线。
   */
  healthCheck?: (browserId: string, account: Record<string, unknown>) => Promise<HealthCheckResult>;
}

// ==================== 参数校验 ====================

function invalid(message: string): CodedError {
  return new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function requireEmail(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw invalid("email 必须是非空字符串");
  return value;
}

function requireAction(value: unknown): AccountsAction {
  if (typeof value !== "string" || !(ACCOUNTS_ACTIONS as readonly string[]).includes(value)) {
    throw invalid(`未知的操作: ${String(value)}`);
  }
  return value as AccountsAction;
}

function requireRows(value: unknown, action: AccountsAction): SelectedRow[] {
  if (!Array.isArray(value)) throw invalid("rows 必须是数组");
  if (value.length > MAX_ROWS) throw invalid(`rows 超过上限 ${MAX_ROWS}`);
  const parsed = value.map((r, i): SelectedRow => {
    if (r === null || typeof r !== "object") throw invalid(`rows[${i}] 必须是对象`);
    const o = r as Record<string, unknown>;
    if (typeof o["email"] !== "string") throw invalid(`rows[${i}].email 必须是字符串`);
    const browserId = o["browserId"] ?? "";
    if (typeof browserId !== "string") throw invalid(`rows[${i}].browserId 必须是字符串`);
    return { email: o["email"], browserId };
  });
  // 按 email 去重（保留首次出现），避免同一账号被重复处理
  const seen = new Set<string>();
  const rows = parsed.filter((r) => (seen.has(r.email) ? false : (seen.add(r.email), true)));
  // 单行操作必须恰好一行
  if ((action === "single_login" || action === "delete_one_with_window") && rows.length !== 1) {
    throw invalid(`${action} 需要恰好 1 行`);
  }
  return rows;
}

function requireOptions(value: unknown): AccountsRunOptions {
  if (value === null || typeof value !== "object") throw invalid("options 必须是对象");
  const o = value as Record<string, unknown>;
  const c = o["concurrency"];
  if (typeof c !== "number" || !Number.isInteger(c) || c < CONCURRENCY_MIN || c > CONCURRENCY_MAX) {
    throw invalid(`concurrency 必须是 ${CONCURRENCY_MIN}-${CONCURRENCY_MAX} 的整数`);
  }
  // 界面不传时按「登录成功后关窗」处理（失败的账号一律保留窗口，便于人工排查）
  const w = o["closeWindow"];
  if (w !== undefined && typeof w !== "boolean") throw invalid("closeWindow 必须是布尔值");
  return w === undefined ? { concurrency: c } : { concurrency: c, closeWindow: w };
}
function requireBrowserId(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) throw invalid("browserId 必须是数字字符串");
  return value.trim();
}

// ==================== 配置读取 ====================

/**
 * LLM 参数 —— 取自配置中的默认 provider：
 *   provider = getAiDefaultProvider()；无 provider 或 apiKey → 全部 null
 */
export function readLlmParams(config: Pick<ConfigManager, "getAiDefaultProvider" | "getAiProviderApiKey" | "getAiProviderModel">): LlmParams {
  const none: LlmParams = { apiKey: null, model: null, provider: null };
  try {
    const provider = config.getAiDefaultProvider();
    if (!provider) return none;
    const apiKey = config.getAiProviderApiKey(provider);
    if (!apiKey) return none;
    const model = config.getAiProviderModel(provider);
    return { apiKey, model: model || null, provider };
  } catch {
    return none;
  }
}

function clampConcurrency(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 3;
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, v));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 翻页上限（每页 HOME_LIST_PAGE_SIZE 个，足够覆盖任何实际规模；防止服务端异常时死循环） */
const MAX_WINDOW_PAGES = 100;

/**
 * 取 ixBrowser 全部窗口：按页取到「本页不满一页」为止。
 * 每页遇到可重试错误（连接断开 / 超时等，判定与退避同 window.ts）先重试，重试用完仍失败才抛错；
 * 不像 getBrowserList 那样静默返回部分数据——账号列表要区分「窗口不存在」与「窗口信息没取到」。
 */
export async function listAllWindows(
  client: Pick<IxBrowserClient, "getProfileList">,
  options: { sleep?: (ms: number) => Promise<void>; log?: (message: string) => void } = {},
): Promise<WindowLike[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchPage = async (page: number): Promise<WindowLike[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.getProfileList({ page, limit: HOME_LIST_PAGE_SIZE });
      } catch (error) {
        if (attempt >= MAX_RETRIES || !isRetryableError(errorText(error))) throw error;
        const delay = BASE_DELAY * BACKOFF_FACTOR ** attempt;
        options.log?.(`获取窗口列表第 ${page} 页失败: ${errorText(error)}，${delay.toFixed(1)}秒后重试...`);
        await sleep(delay * 1000);
      }
    }
  };
  const all: WindowLike[] = [];
  for (let page = 1; page <= MAX_WINDOW_PAGES; page++) {
    const data = await fetchPage(page);
    all.push(...data);
    if (data.length < HOME_LIST_PAGE_SIZE) break;
  }
  return all;
}

/** 默认批处理器工厂；必须注入 db，否则批处理器会跳过写库（导出供单测校验） */
export function createDefaultProcessor(
  ctx: HostContext,
  options: WorkerProcessorOptions,
): ReturnType<typeof createBatchProcessor> {
  return createBatchProcessor({ config: ctx.config(), db: ctx.db() }, options);
}

// ==================== handler 工厂 ====================

export function createAccountsHandlers(ctx: HostContext, deps: AccountsHandlerDeps = {}): HostHandlerTable {
  // 以下全部惰性：工厂执行时不打开数据库、不读配置
  const repo = () => ctx.accountRepo();
  const listWindows = deps.listWindows ?? (() => listAllWindows(ctx.ix(), { log: ctx.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) }));
  const listGroups =
    deps.listGroups ?? (() => getGroupList({ client: ctx.ix(), log: ctx.log, ...(deps.sleep ? { sleep: deps.sleep } : {}) }));

  const createProcessor =
    deps.createProcessor ??
    ((options: { concurrency: number; callback: (msg: string) => void }): WorkerProcessor =>
      createDefaultProcessor(ctx, options));

  const windowOps = createIxWindowOps({ client: () => ctx.ix(), log: ctx.log });
  const closeBrowser = deps.closeBrowser ?? windowOps.closeBrowser;
  const deleteBrowser = deps.deleteBrowser ?? windowOps.deleteBrowser;

  const planEnv = (busy: boolean): PlanEnv => ({ repo: repo(), busy });

  // ---------- 各类任务的执行体 ----------

  const runTask = (spec: TaskSpec, options: AccountsRunOptions): TaskInfo => {
    switch (spec.kind) {
      case "login":
        return ctx.tasks.start("login", spec.label, async (api: TaskApi) => {
          const total = spec.accounts.length;
          api.log(spec.startLog);
          api.progress(0, total);
          const result = await executeAccountWorkerTask({
            taskType: "login",
            accounts: spec.accounts,
            browserIds: spec.browserIds,
            concurrency: options.concurrency,
            closeWindow: options.closeWindow ?? true,
            closeBrowser,
            llm: readLlmParams(ctx.config()),
            shouldStop: api.shouldStop,
            onStop: api.onStop,
            log: api.log,
            progress: api.progress,
            createProcessor,
            item: api.item,
          });
          for (const line of workerFinishedLogLines(result)) api.log(line);
          return result;
        });

      case "delete":
        return ctx.tasks.start("batch_delete", spec.label, async (api) => {
          const total = spec.accounts.length;
          api.log(`开始批量删除，共 ${total + spec.staleEmails.length} 个账号...`);
          // 界面数据过期的账号：整条跳过（不删账号也不删窗口），计为失败
          for (const email of spec.staleEmails) {
            api.log(staleLog(email));
            // 与 executeBatchDelete 的失败条目同口径：过期账号也要上报条目，
            // 否则日志里的「失败 2」在任务历史里查不到，总数/失败数会对不上
            api.item(email, "失败", "数据已变化，请刷新后重试");
          }
          api.progress(0, total);
          // 先删账号，账号删除成功后再删窗口；deleteAccount 返回 false 计为失败（见 executeBatchDelete 注释）
          const results = await executeBatchDelete({
            accounts: spec.accounts,
            browserIds: spec.browserIds,
            withWindows: spec.withWindows,
            shouldStop: api.shouldStop,
            deleteAccount: (email) => repo().deleteAccount(email),
            closeBrowser,
            deleteBrowser,
            log: api.log,
            progress: (i) => api.progress(i, total),
            item: api.item,
          });
          results.total += spec.staleEmails.length;
          results.failed_count += spec.staleEmails.length;
          for (const email of spec.staleEmails) results.failed_list.push({ email, error: "数据已变化，请刷新后重试" });
          api.log(`批量删除完成: 删除账号 ${results.deleted_accounts}/${results.total}, 失败 ${results.failed_count}`);
          if (spec.withWindows) api.log(`已删除 ${results.deleted_windows} 个窗口`);
          return results;
        });

      // ---------- 账号健康巡检（本地新增：只读判定，不产生新登录会话） ----------
      case "health_check": {
        return ctx.tasks.start("health_check", spec.label, async (api) => {
          const total = spec.accounts.length;
          api.log(`开始健康巡检，共 ${total} 个账号（只读：不提交密码或验证码，不产生新登录会话）...`);
          api.progress(0, total);
          const check =
            deps.healthCheck ??
            ((browserId: string, account: Record<string, unknown>) =>
              defaultHealthCheck(browserId, account, { callback: api.log, accountRepo: repo() }));
          const summary = await executeHealthCheck({
            accounts: spec.accounts,
            browserIds: spec.browserIds,
            check,
            shouldStop: api.shouldStop,
            log: api.log,
            progress: (i) => api.progress(i, total),
            item: api.item,
          });
          api.log(healthCheckSummaryLine(summary));
          return summary;
        });
      }
    }
  };

  const rejectIfBusy = (): void => {
    // 单条写操作与批量任务互斥，任务运行中拒绝
    if (ctx.tasks.busy) throw new CodedError(ERROR_CODES.TASK_BUSY, "已有任务在执行中，请等待完成");
  };

  return {
    /**
     * 账号列表 + 窗口名 / 分组。分组与窗口列表并发请求，窗口列表翻页取全量（以前只取第 1 页 500 个）。
     * ixBrowser 不可达时窗口名留空、绑定了窗口的账号归「窗口信息获取失败」，不报错。
     * 不下发密码 / 密钥 / 辅助邮箱原文（见 buildAccountRows）。
     */
    [ACCOUNTS_INVOKE.accountsList]: async (): Promise<AccountsListResult> => {
      const accounts = repo().getAllAccounts();
      let windowError: string | null = null;
      const [groups, windows] = await Promise.all([
        listGroups(),
        listWindows().catch((error: unknown) => {
          windowError = errorText(error);
          return null;
        }),
      ]);
      return { ...buildAccountRows(accounts, groups, windows), windowError };
    },

    [ACCOUNTS_INVOKE.accountsGetDefaults]: (): AccountsDefaults => {
      let n: unknown = 3;
      try {
        n = ctx.config().getLoginConcurrency();
      } catch {
        // 配置读取失败时用默认值 3
      }
      return { loginConcurrency: clampConcurrency(n) };
    },

    [ACCOUNTS_INVOKE.accountsPrecheck]: async (action: unknown, rows: unknown): Promise<AccountsPrecheckResult> => {
      const a = requireAction(action);
      const r = requireRows(rows, a);
      return toPrecheckResult(await planAction(a, r, planEnv(ctx.tasks.busy)));
    },

    [ACCOUNTS_INVOKE.accountsStart]: async (action: unknown, rows: unknown, options: unknown): Promise<TaskInfo> => {
      const a = requireAction(action);
      const r = requireRows(rows, a);
      const o = requireOptions(options);
      if (ctx.tasks.busy) {
        const cur = ctx.tasks.current();
        throw new CodedError(ERROR_CODES.TASK_BUSY, `已有任务正在运行：${cur?.label ?? ""}，请等待完成或先停止`);
      }
      const plan = await planAction(a, r, planEnv(false));
      if (!plan.ok) throw invalid(plan.message);
      return runTask(plan.task, o);
    },

    [ACCOUNTS_INVOKE.accountsBindCandidates]: async (email: unknown): Promise<AccountsBindCandidates> => {
      const e = requireEmail(email);
      const account = repo().getAccountByEmail(e);
      if (!account) throw invalid(`未找到账号: ${e}`);
      const windows = await listWindows();
      // 排除已被**其它**账号绑定的窗口
      const boundByOthers = new Set(
        repo()
          .getAllAccounts()
          .filter((acc) => acc.browser_profile_id && acc.email !== e)
          .map((acc) => String(acc.browser_profile_id)),
      );
      const available = rankBindCandidates(
        e,
        windows
          .map((w) => ({
            profileId: w.profile_id === null || w.profile_id === undefined ? "" : String(w.profile_id),
            name: typeof w.name === "string" && w.name ? w.name : "未命名",
          }))
          .filter((w) => w.profileId && !boundByOthers.has(w.profileId)),
      );
      return {
        currentBrowserId: account.browser_profile_id ? String(account.browser_profile_id) : "",
        windowCount: windows.length,
        available,
      };
    },

    /**
     * 绑定到用户在下拉框中选中的窗口。
     * 窗口由界面下拉框显式选择，后端再校验该窗口未被其它账号绑定。
     */
    [ACCOUNTS_INVOKE.accountsBind]: (email: unknown, browserId: unknown): AccountsBindResult => {
      const e = requireEmail(email);
      const id = requireBrowserId(browserId);
      rejectIfBusy();
      const account = repo().getAccountByEmail(e);
      if (!account) throw invalid(`未找到账号: ${e}`);
      const owner = repo().getAccountByBrowser(id);
      if (owner && owner.email !== e) throw invalid(`窗口 ${id} 已被账号 ${owner.email} 绑定`);
      const previous = account.browser_profile_id ? String(account.browser_profile_id) : "";
      if (!repo().bindAccountToBrowser(e, id)) throw new Error(`绑定窗口失败: ${e} -> ${id}`);
      return { email: e, browserId: id, previousBrowserId: previous };
    },


    /** 删除单个账号（不动窗口） */
    [ACCOUNTS_INVOKE.accountsDeleteOne]: (email: unknown): boolean => {
      const e = requireEmail(email);
      rejectIfBusy();
      return repo().deleteAccount(e);
    },
  };
}
