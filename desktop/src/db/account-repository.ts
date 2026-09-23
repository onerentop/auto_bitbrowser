/**
 * 账号仓储（Node 重写）
 * 对标 services/repositories/account_repository.py
 *
 * POC 范围：只实现读取类方法 + 一个写入方法，用于与 Python 对拍。
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

  /** 对标 get_all_accounts() */
  getAllAccounts(): AccountRow[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY email").all() as AccountRow[];
  }

  /** 对标 get_account_by_email() */
  getAccountByEmail(email: string): AccountRow | null {
    const row = this.db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
    return (row as AccountRow) ?? null;
  }

  /** 对标 get_accounts_by_status() */
  getAccountsByStatus(status: string): AccountRow[] {
    return this.db
      .prepare("SELECT * FROM accounts WHERE status = ? ORDER BY email")
      .all(status) as AccountRow[];
  }

  /** 对标 get_accounts_by_login_status() */
  getAccountsByLoginStatus(status: string): AccountRow[] {
    return this.db
      .prepare("SELECT * FROM accounts WHERE login_status = ? ORDER BY email")
      .all(status) as AccountRow[];
  }

  /** 对标 get_account_by_browser() */
  getAccountByBrowser(browserProfileId: string): AccountRow | null {
    const row = this.db
      .prepare("SELECT * FROM accounts WHERE browser_profile_id = ?")
      .get(browserProfileId);
    return (row as AccountRow) ?? null;
  }

  /** 对标 get_unbound_accounts() */
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
   * 插入或更新账号。对标 upsert_account()。
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
          // 空串在 last_* 两列按 Python 的行为落成 NULL
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
   * 更新登录状态。对标 update_login_status()。
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
   * 更新 Pro 状态。对标 update_pro_status()。
   * is_pro 取值：yes / family_yes / no / unknown
   */
  updateProStatus(email: string, isPro: string): boolean {
    try {
      const info = this.db
        .prepare("UPDATE accounts SET is_pro = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?")
        .run(isPro, email);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_pro_status 失败: ${error}`);
      return false;
    }
  }

  /** 更新家庭组共享开关。对标 update_family_sharing_enabled() */
  updateFamilySharingStatus(email: string, enabled: boolean): boolean {
    try {
      const info = this.db
        .prepare(
          "UPDATE accounts SET family_sharing_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
        )
        .run(enabled ? "yes" : "no", email);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_family_sharing_status 失败: ${error}`);
      return false;
    }
  }

  /** 更新家庭成员数。对标 update_family_member_count() */
  updateFamilyMemberCount(email: string, count: number): boolean {
    try {
      const info = this.db
        .prepare(
          "UPDATE accounts SET family_member_count = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
        )
        .run(count, email);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_family_member_count 失败: ${error}`);
      return false;
    }
  }

  /**
   * 更新账号会员信息（刷新家庭组信息专用）。对标 update_membership_info()。
   *
   * 一次性覆盖 9 个字段，并把 family_info_refreshed_at / updated_at 刷成 CURRENT_TIMESTAMP。
   * 参数用单个对象承载（字段名保持 snake_case，与 Python 位置参数一一对应）。
   */
  updateMembershipInfo(fields: {
    /** 账号邮箱 */
    email: string;
    /** Pro 状态 (yes/no/family_yes/detection_failed) */
    is_pro: string;
    /** Pro 计划名称 */
    pro_plan_name: string;
    /** 家庭组角色 (manager/member/none/unknown) */
    family_role: string;
    /** 家庭组管理员邮箱 */
    family_manager_email: string;
    /** 是否有家庭组 (yes/no/unknown) */
    has_family_group: string;
    /** 家庭成员数量 */
    family_member_count: number;
    /** 剩余家庭组位置 */
    family_slots_left: number;
    /** 账户所属国家 */
    account_country: string;
    /** 刷新错误信息 */
    error_message: string | null;
  }): boolean {
    try {
      const info = this.db
        .prepare(
          `UPDATE accounts SET
                        is_pro = ?,
                        pro_plan_name = ?,
                        family_role = ?,
                        family_manager_email = ?,
                        has_family_group = ?,
                        family_member_count = ?,
                        family_slots_left = ?,
                        account_country = ?,
                        family_info_refresh_error = ?,
                        family_info_refreshed_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE email = ?`,
        )
        .run(
          fields.is_pro,
          fields.pro_plan_name,
          fields.family_role,
          fields.family_manager_email,
          fields.has_family_group,
          fields.family_member_count,
          fields.family_slots_left,
          fields.account_country,
          fields.error_message,
          fields.email,
        );
      const affected = Number(info.changes ?? 0);

      if (affected > 0) {
        console.log(
          `[DB] 更新会员信息: ${fields.email} -> is_pro=${fields.is_pro}, role=${fields.family_role}`,
        );
      }
      return affected > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_membership_info 失败: ${error}`);
      return false;
    }
  }

  /**
   * 更新解锁状态。对标 update_unlock_status()。
   * validation_url 只在传入时才写入（动态拼字段，与 Python 一致）。
   */
  updateUnlockStatus(email: string, status: string, validationUrl?: string | null): boolean {
    try {
      const fields = ["unlock_status = ?", "updated_at = CURRENT_TIMESTAMP"];
      const values: (string | null)[] = [status];
      if (validationUrl !== undefined && validationUrl !== null) {
        fields.push("validation_url = ?");
        values.push(validationUrl);
      }
      values.push(email);
      const info = this.db
        .prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE email = ?`)
        .run(...values);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_unlock_status 失败: ${error}`);
      return false;
    }
  }

  /** 更新 Sub2API 关联状态。对标 update_sub2api_status()，可选字段动态拼。 */
  updateSub2apiStatus(
    email: string,
    status: string,
    accountId?: number | null,
    sessionId?: string | null,
  ): boolean {
    try {
      const fields = ["sub2api_status = ?", "updated_at = CURRENT_TIMESTAMP"];
      const values: (string | number | null)[] = [status];
      if (accountId !== undefined && accountId !== null) {
        fields.push("sub2api_account_id = ?");
        values.push(accountId);
      }
      if (sessionId !== undefined && sessionId !== null) {
        fields.push("sub2api_session_id = ?");
        values.push(sessionId);
      }
      values.push(email);
      const info = this.db
        .prepare(`UPDATE accounts SET ${fields.join(", ")} WHERE email = ?`)
        .run(...values);
      return Number(info.changes ?? 0) > 0;
    } catch (error) {
      console.error(`[DB ERROR] update_sub2api_status 失败: ${error}`);
      return false;
    }
  }

  /** 总数 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    return row.n;
  }
}
