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

  /** 总数 */
  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
    return row.n;
  }
}
