/**
 * 账号管理页 的后端 handler（账号列表 / 绑定解绑 / 批量任务）
 *
 * 通道一览（定义见 app/shared/channels/accounts.ts）：
 *   list / getDefaults / bindCandidates / bind / unbind / deleteOne  —— 同步查询或单条写库
 *   precheck / start                                                   —— 批量操作（start 启动后台任务）
 *
 * 批量操作全部走 ctx.tasks（全局单任务，重复启动抛 TASK_BUSY）；
 * 候选筛选 / 确认文案在 ./accounts/plan.ts，执行逻辑在 src/application/account-task-orchestrator.ts。
 * 依赖（批处理器、窗口操作）可通过第二参数注入，单测全部离线。
 */
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import {
  ACCOUNTS_ACTIONS,
  ACCOUNTS_INVOKE,
  type AccountListRow,
  type AccountsAction,
  type AccountsBindCandidates,
  type AccountsBindResult,
  type AccountsDefaults,
  type AccountsListResult,
  type AccountsPrecheckResult,
  type AccountsRunOptions,
  type AccountsUnbindResult,
  type SelectedRow,
} from "../../shared/channels/accounts.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { createLogProgressTracker, type TaskApi } from "../task-runner.ts";
import { planAction, staleLog, toPrecheckResult, type PlanEnv, type TaskSpec } from "./accounts/plan.ts";
import type { WindowLike } from "../../../src/application/account-manager-service.ts";
import {
  executeAccountWorkerTask,
  executeBatchBind,
  executeBatchDelete,
  workerFinishedLogLines,
  type LlmParams,
  type WorkerProcessor,
} from "../../../src/application/account-task-orchestrator.ts";
import { BatchAccountProcessor } from "../../../src/automation/batch-account-processor.ts";
import { deleteBrowserById } from "../../../src/ixbrowser/window.ts";
import type { ConfigManager } from "../../../src/core/config-manager.ts";
import { autoHealthCheck, type HealthCheckResult } from "../../../src/automation/auto-health-check.ts";
import { executeHealthCheck, healthCheckSummaryLine } from "../../../src/application/health-check.ts";

/** 窗口列表查询参数（ixBrowser 每次取前 500 个窗口） */
export const WINDOW_LIST_QUERY = { page: 1, limit: 500 } as const;

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
  /** 取窗口列表（每次取前 500 个），失败抛错 */
  listWindows?: () => Promise<WindowLike[]>;
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
  return { concurrency: c };
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

/** 默认批处理器工厂；必须注入 db，否则批处理器会跳过写库（导出供单测校验） */
export function createDefaultProcessor(
  ctx: HostContext,
  options: { concurrency: number; callback: (msg: string) => void },
): BatchAccountProcessor {
  return new BatchAccountProcessor(
    { concurrency: options.concurrency, callback: options.callback },
    {
      config: ctx.config(),
      db: ctx.db(),
    },
  );
}

// ==================== handler 工厂 ====================

export function createAccountsHandlers(ctx: HostContext, deps: AccountsHandlerDeps = {}): HostHandlerTable {
  // 以下全部惰性：工厂执行时不打开数据库、不读配置
  const repo = () => ctx.accountRepo();
  const listWindows = deps.listWindows ?? (async () => ctx.ix().getProfileList({ ...WINDOW_LIST_QUERY }));

  const createProcessor =
    deps.createProcessor ??
    ((options: { concurrency: number; callback: (msg: string) => void }): WorkerProcessor =>
      createDefaultProcessor(ctx, options));

  const closeBrowser = deps.closeBrowser ?? ((id: string) => ctx.ix().closeProfile(Number(id)));
  const deleteBrowser =
    deps.deleteBrowser ??
    (async (id: string) => ({ success: await deleteBrowserById({ client: ctx.ix(), log: ctx.log }, id) }));

  const planEnv = (busy: boolean): PlanEnv => ({ repo: repo(), busy, listWindows });

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
            llm: readLlmParams(ctx.config()),
            shouldStop: api.shouldStop,
            onStop: api.onStop,
            log: api.log,
            progressFromLog: createLogProgressTracker(total, api.progress),
            createProcessor,
            item: api.item,
          });
          for (const line of workerFinishedLogLines(result)) api.log(line);
          return result;
        });

      case "bind":
        return ctx.tasks.start("batch_bind", spec.label, async (api) => {
          const total = spec.matched.length;
          api.log(`开始批量绑定，共 ${total} 个账号...`);
          api.progress(0, total);
          const results = executeBatchBind({
            matchedPairs: spec.matched,
            shouldStop: api.shouldStop,
            // 设计取舍：检查写库返回值，false 计为失败（否则写库失败会被静默当作成功）
            bindAccount: (email, browserId) => repo().bindAccountToBrowser(email, browserId),
            // 执行时再查一次窗口归属，已被其他账号占用的记失败并跳过
            ownerOf: (browserId) => {
              const owner = repo().getAccountByBrowser(browserId);
              return owner ? String(owner["email"] ?? "") : null;
            },
            log: api.log,
            progress: (i) => api.progress(i, total),
            item: api.item,
          });
          api.log(`批量绑定完成: ${results.success_count}/${results.total}`);
          if (results.failed_count) api.log(`绑定失败: ${results.failed_count} 个`);
          if (spec.notMatchedCount) api.log(`未匹配: ${spec.notMatchedCount} 个`);
          return results;
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
              autoHealthCheck(browserId, account, { callback: api.log, accountRepo: repo() }));
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
    [ACCOUNTS_INVOKE.accountsList]: async (): Promise<AccountsListResult> => {
      const accounts = repo().getAllAccounts();

      // 窗口名称映射：ixBrowser 不可达时名称留空，不报错
      const nameMap = new Map<string, string>();
      let windowError: string | null = null;
      try {
        const windows = await listWindows();
        for (const w of windows) {
          const id = w.profile_id === null || w.profile_id === undefined ? "" : String(w.profile_id);
          if (id) nameMap.set(id, typeof w.name === "string" ? w.name : "");
        }
      } catch (error) {
        windowError = errorText(error);
      }

      const rows = accounts.map((a): AccountListRow => {
        const browserId = a.browser_profile_id ? String(a.browser_profile_id) : "";
        const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
        return {
          email: a.email,
          login_status: str(a.login_status),
          last_error: str(a["last_error"]),
          browser_profile_id: browserId,
          window_name: browserId ? (nameMap.get(browserId) ?? "") : "",
          updated_at: str(a.updated_at),
        };
      });
      return { rows, windowError };
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
      const available = windows
        .map((w) => ({
          profileId: w.profile_id === null || w.profile_id === undefined ? "" : String(w.profile_id),
          name: typeof w.name === "string" && w.name ? w.name : "未命名",
        }))
        .filter((w) => w.profileId && !boundByOthers.has(w.profileId));
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

    /** 解绑窗口：把账号的 browser_profile_id 置空 */
    [ACCOUNTS_INVOKE.accountsUnbind]: (email: unknown): AccountsUnbindResult => {
      const e = requireEmail(email);
      rejectIfBusy();
      const account = repo().getAccountByEmail(e);
      if (!account) throw invalid(`未找到账号: ${e}`);
      const browserId = account.browser_profile_id ? String(account.browser_profile_id) : "";
      if (!browserId) return { email: e, browserId: "" };
      if (!repo().bindAccountToBrowser(e, "")) throw new Error(`解绑窗口失败: ${e}`);
      return { email: e, browserId };
    },

    /** 删除单个账号（不动窗口） */
    [ACCOUNTS_INVOKE.accountsDeleteOne]: (email: unknown): boolean => {
      const e = requireEmail(email);
      rejectIfBusy();
      return repo().deleteAccount(e);
    },
  };
}
