/**
 * 任务历史 handler（本地新增能力）
 *
 * 只读：列表、逐条目、导出 CSV。写入由 TaskRunner 收尾时统一落库（见 host/context.ts 的装配）。
 */
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import { TASK_HISTORY_INVOKE } from "../../shared/channels/task-history.ts";
import {
  TASK_HISTORY_DEFAULT_LIMIT,
  type TaskRunItemRow,
  type TaskRunRow,
} from "../../../src/db/task-history-repository.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";

/** 列表/导出的条数上限（防止一次拉爆界面） */
const MAX_LIMIT = 1000;

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

export function createTaskHistoryHandlers(ctx: HostContext): HostHandlerTable {
  const repo = () => ctx.taskHistoryRepo();

  return {
    [TASK_HISTORY_INVOKE.taskHistoryList]: (limit: unknown): TaskRunRow[] => repo().listRuns(clampLimit(limit)),

    [TASK_HISTORY_INVOKE.taskHistoryItems]: (runId: unknown): TaskRunItemRow[] =>
      repo().listItems(requireRunId(runId)),

    [TASK_HISTORY_INVOKE.taskHistoryExport]: (limit: unknown): string => repo().exportText(clampLimit(limit)),
  };
}
