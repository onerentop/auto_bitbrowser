/**
 * 批量任务运行结果历史（任务级 + 逐条目）
 *
 * 这是**本地新增能力**：以前的批量任务结果只打在界面日志里，关掉就没了。
 *
 * 为什么单独建表：既有的 `account_refresh_tasks` / `account_refresh_task_items` 语义是
 * 「刷新家庭组信息的任务」，与「任意批量任务的运行结果」混用会让两边含义都变模糊。
 *
 * 记录时机：`TaskRunner` 在任务收尾（成功 / 失败 / 停止）时把记录交给这里落库；
 * 写库失败由调用方兜住，绝不影响任务本身的结果。
 */
import type { Db } from "./connection.ts";

/** 一个条目的结果 */
export interface TaskRunItemRecord {
  key: string;
  status: string;
  message: string;
}

/** 一次任务运行的记录（由 TaskRunner 在收尾时组装） */
export interface TaskRunRecord {
  taskType: string;
  label: string;
  /** TaskOutcome：succeeded / failed / stopped */
  outcome: string;
  startedAt: number;
  finishedAt: number;
  items: readonly TaskRunItemRecord[];
  error: string | null;
  /** 启动参数快照（重跑用）；无则 null */
  params?: unknown;
}

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
  /** 启动参数快照的 JSON 文本；旧记录为 null */
  params: string | null;
  [key: string]: unknown;
}

/** 任务历史列表的筛选条件（都可选；limit 默认 TASK_HISTORY_DEFAULT_LIMIT） */
export interface TaskRunQuery {
  limit?: number;
  taskType?: string;
  outcome?: string;
  /** 按条目 key（邮箱）模糊匹配：筛出「涉及这个账号」的运行 */
  itemEmail?: string;
  /** 起始时间下限（含），本地时间串前缀比较 */
  from?: string;
  /** 结束时间上限（含） */
  to?: string;
}

export interface TaskRunItemRow {
  id: number;
  run_id: number;
  item_key: string | null;
  status: string | null;
  message: string | null;
  [key: string]: unknown;
}

/** 各 Worker 写入的逐条状态字面量（与 AI_TASK_ITEM_STATUS 一致） */
const SUCCESS_STATUS = "成功";
const FAILED_STATUSES: readonly string[] = ["失败", "错误"];

/** 默认最多返回多少条任务 */
export const TASK_HISTORY_DEFAULT_LIMIT = 100;

/**
 * 毫秒时间戳 → 可读时间串（存库用，取**本地**时间）。
 *
 * 有意与其它表不一致：其它表的时间列走 SQLite `CURRENT_TIMESTAMP`（UTC），任务历史按本地时间存，
 * 是为了界面上不需要换算就能读。两边都是原样显示，所以同一次操作在「账号更新时间」和
 * 「任务结束时间」上会差一个时区。
 */
function toStamp(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** CSV 单元格：含逗号 / 引号 / 换行时用双引号包裹并转义 */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 启动参数 → 存库文本；没有参数或序列化失败时写 null（重跑按钮据此禁用） */
function toParamsJson(params: unknown): string | null {
  if (params === undefined || params === null) return null;
  try {
    return JSON.stringify(params);
  } catch {
    return null;
  }
}

/**
 * LIKE 模式的字面量转义：`\` / `%` / `_` 都是 LIKE 的元字符，用户输入要按字面匹配。
 * 配套 SQL 里的 `ESCAPE '\'`；不转义时 `_` 会匹配任意单字符、`%` 匹配任意长度，
 * 按邮箱搜历史时会多命中一批无关记录。
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class TaskHistoryRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /** 落库一次运行，返回 run id */
  record(record: TaskRunRecord): number {
    const items = record.items ?? [];
    const successCount = items.filter((i) => i.status === SUCCESS_STATUS).length;
    const failedCount = items.filter((i) => FAILED_STATUSES.includes(i.status)).length;

    // 任务级 + 逐条目一起提交：中途失败时不能留下「有统计、没条目」的半条运行
    this.db.exec("BEGIN");
    try {
      const info = this.db
        .prepare(
          `INSERT INTO task_run_history
             (task_type, label, outcome, started_at, finished_at, total, success_count, failed_count, error, params)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.taskType,
          record.label,
          record.outcome,
          toStamp(record.startedAt),
          toStamp(record.finishedAt),
          items.length,
          successCount,
          failedCount,
          record.error,
          toParamsJson(record.params),
        );

      const runId = Number((info as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0);
      if (items.length > 0) {
        const insert = this.db.prepare(
          "INSERT INTO task_run_items (run_id, item_key, status, message) VALUES (?, ?, ?, ?)",
        );
        for (const item of items) insert.run(runId, item.key, item.status, item.message);
      }
      this.db.exec("COMMIT");
      return runId;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 任务运行列表（倒序），支持按类型 / 结果 / 时间段 / 账号（条目）筛选。
   * 筛选全部在 SQL 里做（界面只给条件），时间按 started_at 的本地时间串比较。
   */
  listRuns(query: TaskRunQuery = {}): TaskRunRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.taskType) {
      where.push("h.task_type = ?");
      args.push(query.taskType);
    }
    if (query.outcome) {
      where.push("h.outcome = ?");
      args.push(query.outcome);
    }
    if (query.from) {
      where.push("h.started_at >= ?");
      args.push(query.from);
    }
    if (query.to) {
      where.push("h.started_at <= ?");
      args.push(query.to);
    }
    if (query.itemEmail) {
      where.push(
        "EXISTS (SELECT 1 FROM task_run_items i WHERE i.run_id = h.id AND i.item_key LIKE ? ESCAPE '\\')",
      );
      args.push(`%${escapeLike(query.itemEmail)}%`);
    }
    const limit = query.limit ?? TASK_HISTORY_DEFAULT_LIMIT;
    const sql =
      `SELECT * FROM task_run_history h` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY h.id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit) as TaskRunRow[];
  }

  /** 单次运行（含 params 快照）；不存在返回 null */
  getRun(runId: number): TaskRunRow | null {
    const row = this.db.prepare("SELECT * FROM task_run_history WHERE id = ?").get(runId);
    return (row as TaskRunRow) ?? null;
  }


  /** 某次运行的逐条目结果 */
  listItems(runId: number): TaskRunItemRow[] {
    return this.db
      .prepare("SELECT * FROM task_run_items WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as TaskRunItemRow[];
  }

  /**
   * 导出为 CSV 文本（一次 JOIN，逐条目一行；任务级字段随行重复，方便直接丢进表格工具）。
   */
  exportText(limit: number = TASK_HISTORY_DEFAULT_LIMIT): string {
    const rows = this.db
      .prepare(
        `SELECT h.id AS run_id, h.task_type, h.label, h.outcome, h.started_at, h.finished_at,
                h.total, h.success_count, h.failed_count, h.error,
                i.item_key, i.status AS item_status, i.message AS item_message
           FROM task_run_history h
           LEFT JOIN task_run_items i ON i.run_id = h.id
          WHERE h.id IN (SELECT id FROM task_run_history ORDER BY id DESC LIMIT ?)
          ORDER BY h.id DESC, i.id ASC`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    const header = [
      "run_id",
      "任务类型",
      "标签",
      "结果",
      "开始时间",
      "结束时间",
      "总数",
      "成功",
      "失败",
      "账号",
      "条目状态",
      "条目消息",
      "错误",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          r["run_id"],
          r["task_type"],
          r["label"],
          r["outcome"],
          r["started_at"],
          r["finished_at"],
          r["total"],
          r["success_count"],
          r["failed_count"],
          r["item_key"],
          r["item_status"],
          r["item_message"],
          r["error"],
        ]
          .map(csvCell)
          .join(","),
      );
    }
    return lines.join("\n");
  }
}
