/**
 * 账号仓储
 *
 * 范围：读取类方法 + 必要的写入方法。
 */
import type { Db } from "./connection.ts";

export interface AccountRow {
  email: string;
  password: string | null;
  recovery_email: string | null;
  secret_key: string | null;
  status: string | null;
  login_status: string | null;
  is_pro: string | null;
  browser_profile_id: string | null;
  sub2api_status: string | null;
  unlock_status: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

export class AccountRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 在一个事务里执行 fn：成功则提交，fn 抛错则回滚后原样抛出。
   * 仓储只提供事务原语，不关心里面做什么（批量导入等由用例层决定）。
   */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAllAccounts(): AccountRow[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY email").all() as AccountRow[];
  }

  getAccountByEmail(email: string): AccountRow | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
    return (row as AccountRow) ?? null;
  }

  getAccountsByStatus(status: string): AccountRow[] {
    return this.db
      .prepare("SELECT * FROM accounts WHERE status = ? ORDER BY email")
      .all(status) as AccountRow[];
  }

  getAccountsByLoginStatus(status: string): AccountRow[] {
    return this.db
      .prepare("SELECT * FROM accounts WHERE login_status = ? ORDER BY email")
      .all(status) as AccountRow[];
  }

  getAccountByBrowser(browserProfileId: string): AccountRow | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE browser_profile_id = ?")
      .get(browserProfileId);
    return (row as AccountRow) ?? null;
  }

  getUnboundAccounts(): AccountRow[] {
    return this.db
      .prepare(
        "SELECT * FROM accounts WHERE browser_profile_id IS NULL OR browser_profile_id = '' ORDER BY email",
      )
      .all() as AccountRow[];
  }

  /** 按状态分组统计，用于快速核对总量 */
  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM accounts GROUP BY status")
      .all() as { status: string | null; n: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status ?? "(null)"] = r.n;
    return out;
  }

  /**
   * 插入或更新账号。
   *
   * 关键语义：已存在的记录**只更新传入的非 null 字段**，
   * 这样调用方可以只改一个字段（如只换 secret_key）而不覆盖其它数据。
   * 新记录插入时 status 默认 "pending"、sheerid_steps 默认 0。
   */
  upsertAccount(fields: {
    email: string;
    password?: string | null;
    recovery_email?: string | null;
    secret_key?: string | null;
    link?: string | null;
    status?: string | null;
    message?: string | null;
    sheerid_steps?: number | null;
    last_failed_step?: string | null;
    last_error?: string | null;
    browser_profile_id?: string | null;
  }): boolean {
    const email = fields.email;
    if (!email) {
      console.error("[DB] upsert_account: email 为空，跳过");
      return false;
    }

    try {
      const exists = this.db.prepare("SELECT email FROM accounts WHERE email = ?").get(email);

      // 字段名映射：入参键 → 库表列
      const columnMap: [keyof typeof fields, string][] = [
        ["password", "password"],
        ["recovery_email", "recovery_email"],
        ["secret_key", "secret_key"],
        ["link", "verification_link"],
        ["status", "status"],
        ["message", "message"],
        ["sheerid_steps", "sheerid_steps"],
        ["last_failed_step", "last_failed_step"],
        ["last_error", "last_error"],
        ["browser_profile_id", "browser_profile_id"],
      ];

      if (exists) {
        const sets: string[] = [];
        const values: (string | number | null)[] = [];
        for (const [key, column] of columnMap) {
          const v = fields[key];
          if (v === undefined || v === null) continue; // 未传即不动
          sets.push(`${column} = ?`);
          // 空串在 last_* 两列落成 NULL
          values.push(
            (column === "last_failed_step" || column === "last_error") && v === "" ? null : v,
          );
        }
        if (sets.length > 0) {
          sets.push("updated_at = CURRENT_TIMESTAMP");
          values.push(email);
          this.db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE email = ?`).run(...values);
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO accounts (
               email, password, recovery_email, secret_key,
               verification_link, status, message, sheerid_steps,
               last_failed_step, last_error, browser_profile_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            email,
            fields.password ?? null,
            fields.recovery_email ?? null,
            fields.secret_key ?? null,
            fields.link ?? null,
            fields.status ?? "pending",
            fields.message ?? null,
            fields.sheerid_steps ?? 0,
            fields.last_failed_step ?? null,
            fields.last_error ?? null,
            fields.browser_profile_id ?? null,
          );
      }
      return true;
    } catch (error) {
      console.error(`[DB ERROR] upsert_account 失败，email: ${email}, 错误: ${error}`);
      return false;
    }
  }

  /**
   * 更新登录状态。
   * 三分支语义：logged_in 会顺带刷新 last_login_at 并清空 last_error；
   * 带 last_error 时写入错误；否则只改状态。均刷新 updated_at。
   */
  updateLoginStatus(email: string, status: string, lastError?: string | null): boolean {
    try {
      let info;
      if (status === "logged_in") {
        info = this.db
          .prepare(
            "UPDATE accounts SET login_status = ?, last_login_at = CURRENT_TIMESTAMP, " +
              "last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
          )
          .run(status, email);
      } else if (lastError !== undefined && lastError !== null) {
        info = this.db
          .prepare(
            "UPDATE accounts SET login_status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
          )
          .run(status, lastError, email);
      } else {
        info = this.db
          .prepare(
            "UPDATE accounts SET login_status = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
          )
          .run(status, email);
      }
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_login_status 失败: ${error}`);
      return false;
    }
  }

  /**
   * 只写一条「最近发现的问题」（例如健康巡检发现窗口打不开），**不动** login_status。
   *
   * 为什么不能直接用 updateLoginStatus：它对 `logged_in` 会顺带把 last_error 清成 NULL，
   * 于是「账号状态是已登录、但窗口有问题」这种情况根本写不进消息。
   * message 传 null 表示清空（巡检发现只是需要登录时，清掉上一次的错误，避免误导）。
   */
  setLastError(email: string, message: string | null): boolean {
    try {
      const info = this.db
        .prepare("UPDATE accounts SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
        .run(message, email);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] set_last_error 失败: ${error}`);
      return false;
    }
  }

  /**
   * 手动设置登录状态（用户在账号页操作，批量、一个事务）：
   * 写 login_status 与 last_error，刷新 updated_at；**不动 last_login_at**（手动设置不算真的登录过）。
   * 返回真正改到的邮箱（不存在的邮箱跳过），按传入顺序。出错时整批回滚并抛出。
   */
  setLoginStatusManual(emails: readonly string[], status: string, lastError: string | null): string[] {
    const stmt = this.db.prepare(
      "UPDATE accounts SET login_status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
    );
    return this.transaction(() => {
      const changed: string[] = [];
      for (const email of emails) {
        if (Number(stmt.run(status, lastError, email).changes ?? 0) > 0) changed.push(email);
      }
      return changed;
    });
  }

 /** 按邮箱删除账号。删到行返回 true，出错返回 false */
  deleteAccount(email: string): boolean {
    try {
      const info = this.db.prepare("DELETE FROM accounts WHERE email = ?").run(email);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB] 删除账号失败: ${error}`);
      return false;
    }
  }

  /**
   * 绑定账号到浏览器窗口。
   * 传空字符串即解绑（GUI 的解绑操作也是这样调用的）。
   */
  bindAccountToBrowser(email: string, browserProfileId: string): boolean {
    try {
      const info = this.db
        .prepare("UPDATE accounts SET browser_profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
        .run(browserProfileId, email);
      const affected = Number(info.changes ?? 0);
      if (affected > 0) console.log(`[DB] 绑定账号到窗口: ${email} -> ${browserProfileId}`);
      return affected > 0;
    } catch (error) {
      console.error(`[DB ERROR] bind_account_to_browser 失败: ${error}`);
      return false;
    }
  }

  /** 总数 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    return row.n;
  }
}
