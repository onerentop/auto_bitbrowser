/**
 * 辅助邮箱池仓储
 *
 * 管理 3 张表：
 *   recovery_email_pool        邮箱池（email 唯一）
 *   recovery_email_daily_usage 每日用量（recovery_email + usage_date 联合唯一）
 *   account_recovery_binding   账号与辅助邮箱的绑定关系（email 主键）
 *
 * 异常处理：读失败返回空集合，写失败返回 false。
 */
import type { Db } from "./connection.ts";

export interface RecoveryEmailPoolRow {
  id: number;
  email: string;
  imap_password: string | null;
  /** SQLite 存 INTEGER，1=启用 */
  is_enabled: number;
  created_at: string | null;
  note: string | null;
}

export interface AccountRecoveryBindingRow {
  email: string;
  bound_recovery_email: string | null;
  bound_at: string | null;
  status: string | null;
}

export class RecoveryEmailRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

 /** 一次性建 3 张表。，不吞异常。 */
  initTables(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS recovery_email_pool (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          imap_password TEXT,
          is_enabled INTEGER DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          note TEXT
        )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS recovery_email_daily_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          recovery_email TEXT NOT NULL,
          usage_date TEXT NOT NULL,
          bind_count INTEGER DEFAULT 0,
          UNIQUE(recovery_email, usage_date)
        )`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS account_recovery_binding (
          email TEXT PRIMARY KEY,
          bound_recovery_email TEXT,
          bound_at TIMESTAMP,
          status TEXT DEFAULT 'unbound'
        )`,
    );
  }

  // ---------- recovery_email_pool ----------

  /** 按 created_at 倒序 */
  getPool(): RecoveryEmailPoolRow[] {
    try {
      return this.db
        .prepare("SELECT * FROM recovery_email_pool ORDER BY created_at DESC")
        .all() as unknown as RecoveryEmailPoolRow[];
    } catch (error) {
      console.error(`[DB] get_recovery_email_pool 失败: ${error}`);
      return [];
    }
  }

 /** 。冲突时只更新 imap_password 与 note */
  addToPool(email: string, imapPassword: string, note: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO recovery_email_pool (email, imap_password, note)
           VALUES (?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             imap_password = excluded.imap_password,
             note = excluded.note`,
        )
        .run(email, imapPassword, note);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] add_recovery_email_to_pool 失败: ${error}`);
      return false;
    }
  }

  removeFromPool(email: string): boolean {
    try {
      this.db.prepare("DELETE FROM recovery_email_pool WHERE email = ?").run(email);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] remove_recovery_email_from_pool 失败: ${error}`);
      return false;
    }
  }

 /** 。注意库里存的是 INTEGER */
  updateEnabled(email: string, isEnabled: boolean | number): boolean {
    try {
      const flag = typeof isEnabled === "boolean" ? (isEnabled ? 1 : 0) : isEnabled;
      this.db
        .prepare("UPDATE recovery_email_pool SET is_enabled = ? WHERE email = ?")
        .run(flag, email);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] update_recovery_email_enabled 失败: ${error}`);
      return false;
    }
  }

  // ---------- recovery_email_daily_usage ----------

  /** 返回 { recovery_email: bind_count } */
  getDailyUsage(usageDate: string): Record<string, number> {
    try {
      const rows = this.db
        .prepare(
          "SELECT recovery_email, bind_count FROM recovery_email_daily_usage WHERE usage_date = ?",
        )
        .all(usageDate) as { recovery_email: string; bind_count: number }[];
      const out: Record<string, number> = {};
      for (const r of rows) out[r.recovery_email] = r.bind_count;
      return out;
    } catch (error) {
      console.error(`[DB] get_recovery_email_daily_usage 失败: ${error}`);
      return {};
    }
  }

 /** 首次插入 1，冲突则 bind_count + 1 */
  incrementUsage(recoveryEmail: string, usageDate: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO recovery_email_daily_usage (recovery_email, usage_date, bind_count)
           VALUES (?, ?, 1)
           ON CONFLICT(recovery_email, usage_date) DO UPDATE SET
             bind_count = bind_count + 1`,
        )
        .run(recoveryEmail, usageDate);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] increment_recovery_email_usage 失败: ${error}`);
      return false;
    }
  }

  /** 返回删除行数 */
  resetDailyUsage(usageDate: string): number {
    try {
      const info = this.db
        .prepare("DELETE FROM recovery_email_daily_usage WHERE usage_date = ?")
        .run(usageDate);
      return Number(info.changes ?? 0);
    } catch (error) {
      console.error(`[DB ERROR] reset_recovery_email_daily_usage 失败: ${error}`);
      return 0;
    }
  }

 /** 把用量直接顶到上限，标记今日不可用 */
  setUsageFull(recoveryEmail: string, usageDate: string, limit: number): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO recovery_email_daily_usage (recovery_email, usage_date, bind_count)
           VALUES (?, ?, ?)
           ON CONFLICT(recovery_email, usage_date) DO UPDATE SET
             bind_count = ?`,
        )
        .run(recoveryEmail, usageDate, limit, limit);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] set_recovery_email_usage_full 失败: ${error}`);
      return false;
    }
  }

  // ---------- account_recovery_binding ----------

  getBinding(email: string): AccountRecoveryBindingRow | null {
    try {
      const row = this.db
        .prepare("SELECT * FROM account_recovery_binding WHERE email = ?")
        .get(email);
      return (row as unknown as AccountRecoveryBindingRow) ?? null;
    } catch (error) {
      console.error(`[DB] get_account_recovery_binding 失败: ${error}`);
      return null;
    }
  }

  /** bound_at 强制 CURRENT_TIMESTAMP */
  setBinding(email: string, boundRecoveryEmail: string | null, status: string): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO account_recovery_binding (email, bound_recovery_email, bound_at, status)
           VALUES (?, ?, CURRENT_TIMESTAMP, ?)
           ON CONFLICT(email) DO UPDATE SET
             bound_recovery_email = excluded.bound_recovery_email,
             bound_at = CURRENT_TIMESTAMP,
             status = excluded.status`,
        )
        .run(email, boundRecoveryEmail, status);
      return true;
    } catch (error) {
      console.error(`[DB ERROR] set_account_recovery_binding 失败: ${error}`);
      return false;
    }
  }

  /** 返回 { email: row } */
  getAllBindings(): Record<string, AccountRecoveryBindingRow> {
    try {
      const rows = this.db
        .prepare("SELECT * FROM account_recovery_binding")
        .all() as unknown as AccountRecoveryBindingRow[];
      const out: Record<string, AccountRecoveryBindingRow> = {};
      for (const r of rows) out[r.email] = r;
      return out;
    } catch (error) {
      console.error(`[DB] get_all_account_recovery_bindings 失败: ${error}`);
      return {};
    }
  }
}