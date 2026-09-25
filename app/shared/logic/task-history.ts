/**
 * 任务历史面板（设置页「任务历史」标签）的纯逻辑 —— 渲染层与 host 共用，node:test 直接测
 *
 * 这里只放「能重跑吗」「筛选条件怎么算」这类可测的判断；SQL 与 IO 在
 * src/db/task-history-repository.ts 与 app/host/handlers/task-history.ts。
 * 纯 TS，不依赖 node / DOM / electron / dayjs（时间用内置 Date 拼字符串）。
 */
import { AI_TASK_KINDS, isAiTaskKind } from "../channels/ai-tasks.ts";
import type { TaskRunRow } from "../channels/task-history.ts";

/**
 * 账号类批量任务里可以重跑的动作（与 accounts handler start 的动作名一致）。
 * 其余动作（删除单条 / 打开窗口等）没有重跑语义，报错而不是猜。
 */
export const RERUNNABLE_ACCOUNT_ACTIONS: ReadonlySet<string> = new Set(["login", "health_check", "batch_delete"]);

/** 参数快照 → 对象；缺失或非法返回 null（此时不允许重跑） */
export function parseRunSnapshot(params: string | null): Record<string, unknown> | null {
  if (!params) return null;
  try {
    const value: unknown = JSON.parse(params);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 这条历史能不能重跑：能则返回 null，不能则返回**给用户看的原因**（按钮上做 tooltip）。
 * 判定与后端 abb/taskhistory/rerun 保持一致（这里的规则是从快照里认类型）。
 */
export function rerunBlockReason(row: Pick<TaskRunRow, "params" | "task_type">): string | null {
  const snapshot = parseRunSnapshot(row.params);
  if (!snapshot) return "这条记录没有参数快照（旧记录或无需参数的任务），无法重跑";
  const kind = snapshot["kind"];
  if (typeof kind === "string" && isAiTaskKind(kind)) return null;
  const action = snapshot["action"];
  if (typeof action === "string" && RERUNNABLE_ACCOUNT_ACTIONS.has(action)) return null;
  return `该任务类型不支持重跑：${row.task_type}`;
}

/** 任务类型的中文名（AI 任务取 AI_TASK_KINDS，其余本表登记；未登记的原样返回） */
const TASK_TYPE_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.values(AI_TASK_KINDS).map((d) => [d.taskType, d.taskName])),
  login: "批量登录",
  health_check: "健康巡检",
  batch_delete: "批量删除",
  batch_open: "批量打开窗口",
  window_open: "打开窗口",
  totp_import: "导入 TOTP 密钥",
  window_delete: "删除窗口",
};

export function taskTypeLabel(type: string): string {
  return TASK_TYPE_LABELS[type] ?? type;
}

/** 类型筛选的下拉项：从已加载的记录里取出现过的类型（按名称去重后排序） */
export function taskTypeOptions(runs: readonly Pick<TaskRunRow, "task_type">[]): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of runs) {
    if (!seen.has(r.task_type)) seen.set(r.task_type, taskTypeLabel(r.task_type));
  }
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label, "zh"));
}

/** 结果的固定三项（与 task_run_history.outcome 一致） */
export const TASK_HISTORY_OUTCOMES: readonly { value: string; label: string }[] = [
  { value: "succeeded", label: "成功" },
  { value: "failed", label: "失败" },
  { value: "stopped", label: "已停止" },
];

/** 本地时间串（与数据库里 finished_at 的格式一致，可直接比较） */
export function formatLocalStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export type TaskHistoryRangeKey = "all" | "today" | "7d" | "30d";

export const TASK_HISTORY_RANGES: readonly { value: TaskHistoryRangeKey; label: string }[] = [
  { value: "all", label: "全部时间" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

/**
 * 快捷时间范围 → 查询用的上下限（本地时间串，含端）。
 * 用内置 Date 拼字符串，不引 dayjs（本项目没装，antd 的 DatePicker 也就没在用）。
 */
export function rangeBounds(key: TaskHistoryRangeKey, now: Date): { from?: string; to?: string } {
  if (key === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (key === "7d") start.setDate(start.getDate() - 6);
  if (key === "30d") start.setDate(start.getDate() - 29);
  return { from: formatLocalStamp(start), to: formatLocalStamp(now) };
}
