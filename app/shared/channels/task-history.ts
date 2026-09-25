/**
 * 任务历史（批量任务运行结果）的 IPC 通道与类型
 *
 * 本地新增能力：批量任务结果不再只打在界面日志里（关掉就没了），而是持久化保存。
 *
 * 行类型在这里**单独声明**，而不 import `src/db/task-history-repository.ts`：
 * 那份实现属于 Node 侧（引用 node:sqlite），渲染层引它会把 Node 依赖拖进 web 编译图。
 * 两边的结构必须保持一致 —— 改一处要同步改另一处（有测试覆盖落库与读取行为）。
 *
 * 通道命名沿用既有约定：第二段全小写（`abb/taskhistory/...`）。
 */
import type { TaskInfo } from "../ipc.ts";

export interface TaskRunRow {
  id: number;
  task_type: string;
  label: string | null;
  outcome: string | null;
  started_at: string | null;
  finished_at: string | null;
  total: number;
  success_count: number;
  failed_count: number;
  error: string | null;
  /** 启动参数快照的 JSON 文本；旧记录（或无参数任务）为 null */
  params: string | null;
  [key: string]: unknown;
}

export interface TaskRunItemRow {
  id: number;
  run_id: number;
  item_key: string | null;
  status: string | null;
  message: string | null;
  [key: string]: unknown;
}

/** 任务历史列表的筛选条件（全部由后端在 SQL 里应用） */
export interface TaskRunQuery {
  limit?: number;
  /** 任务类型，如 login / ai_replace_phone */
  taskType?: string;
  /** 结果：succeeded / failed / stopped */
  outcome?: string;
  /** 按条目（账号）模糊匹配 */
  itemEmail?: string;
  /** 起始时间下限（含），本地时间串 */
  from?: string;
  /** 结束时间上限（含） */
  to?: string;
}

export const TASK_HISTORY_INVOKE = {
  /** 任务运行列表（倒序，可按类型 / 结果 / 时间 / 账号筛选） */
  taskHistoryList: "abb/taskhistory/list",
  /** 某次运行的逐条目结果 */
  taskHistoryItems: "abb/taskhistory/items",
  /** 导出为 CSV 文本 */
  taskHistoryExport: "abb/taskhistory/export",
  /**
   * 按历史记录重跑：用该次运行的参数快照重新启动同类型任务。
   * 只支持有参数快照、且类型可重跑的记录（AI 任务 / login / health_check / 删除），其它报错。
   */
  taskHistoryRerun: "abb/taskhistory/rerun",
} as const;

export interface TaskHistoryInvokeMap {
  "abb/taskhistory/list": { args: [query?: TaskRunQuery]; result: TaskRunRow[] };
  "abb/taskhistory/items": { args: [runId: number]; result: TaskRunItemRow[] };
  "abb/taskhistory/export": { args: [limit?: number]; result: string };
  "abb/taskhistory/rerun": { args: [runId: number]; result: TaskInfo };
}
