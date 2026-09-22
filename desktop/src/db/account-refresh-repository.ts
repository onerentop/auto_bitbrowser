/**
 * 账号刷新任务仓储（Node 重写）
 * 对标 services/repositories/account_refresh_repository.py
 *
 * 两张表：account_refresh_tasks（任务）+ account_refresh_task_items（明细）
 *
 * 时间字段的重要差异：Python 侧用 datetime.now() 作为**参数**传入，
 * 而不是 SQL 的 CURRENT_TIMESTAMP。sqlite3 适配器会把它序列化成
 * "YYYY-MM-DD HH:MM:SS.ffffff"（本地时间，含微秒）。
 * 这里用 nowLiteral() 生成同格式字符串，保证两侧写入的数据可互读。
 *
 * 本仓储不吞异常（与 Python 一致，失败会直接抛出）。
 */
import type { Db } from "./connection.ts";

/**
 * 生成与 Python datetime.now() 等价的字面量：本地时间 + 微秒。
 * 例：2026-09-23 05:31:07.123456
 */
export function nowLiteral(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const micro = `${p(d.getMilliseconds(), 3)}000`;
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${micro}`
  );
}

/** 单条明细的刷新结果 */
export interface RefreshItemResult {
  error_message?: string | null;
  is_pro?: string | null;
  pro_plan_name?: string | null;
  family_role?: string | null;
  family_manager_email?: string | null;
  has_family_group?: string | null;
  family_member_count?: number | null;
  family_slots_left?: number | null;
  account_country?: string | null;
}

export interface RefreshTaskRow {
  id: number;
  task_type: string | null;
  task_mode: string | null;
  status: string | null;
  total_count: number | null;
  progress_current: number | null;
  progress_percent: number | null;
  success_count: number | null;
  failed_count: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string | null;
  [key: string]: unknown;
}

export interface RefreshTaskItemRow {
  id: number;
  task_id: number;
  email: string;
  status: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  [key: string]: unknown;
}

export class AccountRefreshRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 创建刷新任务，返回 task_id。
   * 注意 task_type 在 Python 侧被硬编码为 "family_info_refresh"。
   */
  createRefreshTask(taskMode: string, totalCount: number): number {
    const info = this.db
      .prepare(
        `INSERT INTO account_refresh_tasks
         (task_type, task_mode, status, total_count, started_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run("family_info_refresh", taskMode, totalCount, nowLiteral());
    return Number(info.lastInsertRowid);
  }

  /** 批量创建明细，初始状态 pending。Python 侧是逐条 INSERT，这里用事务包住提速。 */
  createTaskItems(taskId: number, emails: string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO account_refresh_task_items (task_id, email, status)
       VALUES (?, ?, 'pending')`,
    );
    this.db.exec("BEGIN");
    try {
      for (const email of emails) stmt.run(taskId, email);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 标记明细开始执行 */
  updateTaskItemStarted(taskId: number, email: string): void {
    this.db
      .prepare(
        `UPDATE account_refresh_task_items SET
           status = 'running',
           started_at = ?
         WHERE task_id = ? AND email = ?`,
      )
      .run(nowLiteral(), taskId, email);
  }

  /** 写入明细结果。11 个字段的绑定顺序与 Python 完全一致。 */
  updateTaskItem(taskId: number, email: string, status: string, result: RefreshItemResult): void {
    this.db
      .prepare(
        `UPDATE account_refresh_task_items SET
           status = ?,
           error_message = ?,
           is_pro = ?,
           pro_plan_name = ?,
           family_role = ?,
           family_manager_email = ?,
           has_family_group = ?,
           family_member_count = ?,
           family_slots_left = ?,
           account_country = ?,
           finished_at = ?
         WHERE task_id = ? AND email = ?`,
      )
      .run(
        status,
        result.error_message ?? null,
        result.is_pro ?? null,
        result.pro_plan_name ?? null,
        result.family_role ?? null,
        result.family_manager_email ?? null,
        result.has_family_group ?? null,
        result.family_member_count ?? null,
        result.family_slots_left ?? null,
        result.account_country ?? null,
        nowLiteral(),
        taskId,
        email,
      );
  }

  /**
   * 更新任务进度。
   * 百分比在应用侧算：total_count 为 0 时取 0，读不到任务时 total_count 兜底为 1（与 Python 一致）。
   */
  updateTaskProgress(
    taskId: number,
    progressCurrent: number,
    successCount: number,
    failedCount: number,
  ): void {
    const row = this.db
      .prepare("SELECT total_count FROM account_refresh_tasks WHERE id = ?")
      .get(taskId) as { total_count: number } | undefined;
    const totalCount = row ? row.total_count : 1;
    const progressPercent = totalCount > 0 ? (progressCurrent / totalCount) * 100 : 0;

    this.db
      .prepare(
        `UPDATE account_refresh_tasks SET
           progress_current = ?,
           progress_percent = ?,
           success_count = ?,
           failed_count = ?
         WHERE id = ?`,
      )
      .run(progressCurrent, progressPercent, successCount, failedCount, taskId);
  }

  /** 收尾任务：进度强制拉满（progress_current = total_count, percent = 100.0） */
  finishTask(taskId: number, status: string, successCount: number, failedCount: number): void {
    this.db
      .prepare(
        `UPDATE account_refresh_tasks SET
           status = ?,
           success_count = ?,
           failed_count = ?,
           progress_current = total_count,
           progress_percent = 100.0,
           finished_at = ?
         WHERE id = ?`,
      )
      .run(status, successCount, failedCount, nowLiteral(), taskId);
  }

  getTaskById(taskId: number): RefreshTaskRow | null {
    const row = this.db
      .prepare("SELECT * FROM account_refresh_tasks WHERE id = ?")
      .get(taskId);
    return (row as RefreshTaskRow) ?? null;
  }

  getTaskItems(taskId: number): RefreshTaskItemRow[] {
    return this.db
      .prepare("SELECT * FROM account_refresh_task_items WHERE task_id = ? ORDER BY id")
      .all(taskId) as RefreshTaskItemRow[];
  }

  getRecentTasks(limit = 10): RefreshTaskRow[] {
    return this.db
      .prepare("SELECT * FROM account_refresh_tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit) as RefreshTaskRow[];
  }
}