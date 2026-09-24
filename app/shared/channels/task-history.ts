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

export const TASK_HISTORY_INVOKE = {
  /** 最近的任务运行列表（倒序） */
  taskHistoryList: "abb/taskhistory/list",
  /** 某次运行的逐条目结果 */
  taskHistoryItems: "abb/taskhistory/items",
  /** 导出为 CSV 文本 */
  taskHistoryExport: "abb/taskhistory/export",
} as const;

export interface TaskHistoryInvokeMap {
  "abb/taskhistory/list": { args: [limit?: number]; result: TaskRunRow[] };
  "abb/taskhistory/items": { args: [runId: number]; result: TaskRunItemRow[] };
  "abb/taskhistory/export": { args: [limit?: number]; result: string };
}
