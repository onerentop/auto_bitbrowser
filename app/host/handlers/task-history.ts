/**
 * 任务历史 handler（本地新增能力）
 *
 * 列表 / 逐条目 / 导出只读；写入由 TaskRunner 收尾时统一落库（见 host/context.ts 的装配）。
 * 重跑（rerun）是唯一会启动新任务的动作：读该次运行的参数快照，重新调用对应的启动通道。
 */
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import { TASK_HISTORY_INVOKE, type TaskRunQuery } from "../../shared/channels/task-history.ts";
import { isAiTaskKind } from "../../shared/channels/ai-tasks.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import {
  TASK_HISTORY_DEFAULT_LIMIT,
  type TaskRunItemRow,
  type TaskRunRow,
} from "../../../src/db/task-history-repository.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { createAccountsHandlers } from "./accounts.ts";
import { createAiTasksHandlers } from "./ai-tasks.ts";
import { RERUNNABLE_ACCOUNT_ACTIONS, parseRunSnapshot } from "../../shared/logic/task-history.ts";

/** 列表/导出的条数上限（防止一次拉爆界面） */
const MAX_LIMIT = 1000;

/** 筛选文本的长度上限（类型 / 结果 / 账号 / 时间） */
const MAX_FILTER_LENGTH = 200;


function invalid(message: string): CodedError {
  return new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function clampLimit(value: unknown): number {
  if (value === undefined || value === null) return TASK_HISTORY_DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid("limit 必须是正整数");
  }
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function requireRunId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw invalid("runId 必须是正整数");
  }
  return value;
}

/** 可选的筛选文本：非空字符串（strip），过长直接拒绝 */
function optionalFilter(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw invalid(`${name} 必须是字符串`);
  const s = value.trim();
  if (!s) return undefined;
  if (s.length > MAX_FILTER_LENGTH) throw invalid(`${name} 过长（最多 ${MAX_FILTER_LENGTH} 字符）`);
  return s;
}

/** 解析列表筛选参数（缺省 = 不筛） */
export function parseRunQuery(value: unknown): TaskRunQuery {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("查询条件必须是对象");
  const o = value as Record<string, unknown>;
  const query: TaskRunQuery = {};
  if (o["limit"] !== undefined) query.limit = clampLimit(o["limit"]);
  const taskType = optionalFilter(o["taskType"], "taskType");
  const outcome = optionalFilter(o["outcome"], "outcome");
  const itemEmail = optionalFilter(o["itemEmail"], "itemEmail");
  const from = optionalFilter(o["from"], "from");
  const to = optionalFilter(o["to"], "to");
  if (taskType) query.taskType = taskType;
  if (outcome) query.outcome = outcome;
  if (itemEmail) query.itemEmail = itemEmail;
  if (from) query.from = from;
  if (to) query.to = to;
  return query;
}


export function createTaskHistoryHandlers(ctx: HostContext): HostHandlerTable {
  const repo = () => ctx.taskHistoryRepo();
  const accounts = () => createAccountsHandlers(ctx);
  const aiTasks = () => createAiTasksHandlers(ctx);

  /**
   * 用历史记录的参数快照重跑一次。
   *
   * 只认两类（其它类型没有重跑语义，报错而不是猜）：
   *   - AI 任务：快照 { kind, items, params } → aitasks/start
   *   - 账号批量：快照 { action, rows, options } → accounts/start
   */
  const rerun = (runId: unknown): TaskInfo => {
    const id = requireRunId(runId);
    const row = repo().getRun(id);
    if (!row) throw invalid(`任务记录不存在: ${id}`);
    const snapshot = parseRunSnapshot(row.params);
    if (!snapshot) throw invalid("该记录没有参数快照（旧记录或无需参数的任务），无法重跑");

    const type = String(row.task_type);

    // AI 任务的 task_type 形如 ai_replace_phone，快照里带 kind（replace_phone）
    const kind = snapshot["kind"];
    if (typeof kind === "string" && isAiTaskKind(kind)) {
      const start = aiTasks()["abb/aitasks/start"];
      if (!start) throw invalid("AI 任务通道未装配");
      return start(kind, snapshot["items"], snapshot["params"] ?? {}) as TaskInfo;
    }

    const action = snapshot["action"];
    if (typeof action === "string" && RERUNNABLE_ACCOUNT_ACTIONS.has(action)) {
      const start = accounts()["abb/accounts/start"];
      if (!start) throw invalid("账号任务通道未装配");
      return start(action, snapshot["rows"], snapshot["options"] ?? {}) as TaskInfo;
    }

    throw invalid(`该任务类型不支持重跑: ${type}`);
  };

  return {
    [TASK_HISTORY_INVOKE.taskHistoryList]: (query: unknown): TaskRunRow[] => repo().listRuns(parseRunQuery(query)),

    [TASK_HISTORY_INVOKE.taskHistoryItems]: (runId: unknown): TaskRunItemRow[] =>
      repo().listItems(requireRunId(runId)),

    [TASK_HISTORY_INVOKE.taskHistoryExport]: (limit: unknown): string => repo().exportText(clampLimit(limit)),

    [TASK_HISTORY_INVOKE.taskHistoryRerun]: (runId: unknown): TaskInfo => rerun(runId),
  };
}
