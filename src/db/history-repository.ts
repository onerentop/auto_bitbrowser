/**
 * 历史记录仓储
 *
 * 6 类历史表高度同构（init/get/add/clear），每组只差表名与字段名，
 * 因此这里用配置表驱动，行为与既有的逐条实现一致：
 *   - 建表：id AUTOINCREMENT + email NOT NULL + 值列 + 时间列 + UNIQUE(email)
 *   - 读取：返回 { [email]: { ...值列, [时间列]: ... } }
 *   - 写入：ON CONFLICT(email) DO UPDATE，时间列强制刷成 CURRENT_TIMESTAMP
 *   - 异常：全部吞掉，get 返回 {}，clear 返回 0
 */
import type { Db } from "./connection.ts";

/** 一类历史表的结构定义 */
interface HistorySpec {
  table: string;
  valueColumns: readonly string[];
  /** 时间列名——注意各表不同：modified_at / verified_at / bound_at */
  timeColumn: string;
  label: string;
}

/** 6 类历史表的结构定义，值列 / 时间列按实际表核对 */
export const HISTORY_SPECS = {
  phone: {
    table: "phone_modification_history",
    valueColumns: ["new_phone"],
    timeColumn: "modified_at",
    label: "手机号修改",
  },
  email: {
    table: "email_modification_history",
    valueColumns: ["new_recovery_email"],
    timeColumn: "modified_at",
    label: "邮箱修改",
  },
  sv2Phone: {
    table: "sv2_phone_modification_history",
    valueColumns: ["new_phone"],
    timeColumn: "modified_at",
    label: "2SV手机修改",
  },
  authenticator: {
    table: "authenticator_modification_history",
    valueColumns: ["new_secret"],
    timeColumn: "modified_at",
    label: "验证器修改",
  },
  sheerid: {
    table: "sheerid_verification_history",
    valueColumns: ["verification_id", "verification_result", "message"],
    timeColumn: "verified_at",
    label: "SheerID验证",
  },
  bindCard: {
    table: "bind_card_history",
    valueColumns: ["card_number"],
    timeColumn: "bound_at",
    label: "绑卡",
  },
} as const satisfies Record<string, HistorySpec>;

export type HistoryKind = keyof typeof HISTORY_SPECS;

/** get 返回值：{ [email]: { 值列..., 时间列 } } */
export type HistoryMap = Record<string, Record<string, unknown>>;

export class HistoryRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private spec(kind: HistoryKind): HistorySpec {
    return HISTORY_SPECS[kind];
  }

  /**
 * 建表。*_table。
   * init 不吞异常，异常交给调用方处理。
   */
  initTable(kind: HistoryKind): void {
    const s = this.spec(kind);
    // sheerid 的值列可为 NULL，其余表的值列是 NOT NULL
    const nullable = kind === "sheerid";
    const cols = s.valueColumns
      .map((c) => `${c} TEXT${nullable ? "" : " NOT NULL"}`)
      .join(",\n          ");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${s.table} (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          ${cols},
          ${s.timeColumn} TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(email)
        )`,
    );
  }

  /** 读取全部记录，返回 { email: {...} }。异常时返回 {}。 */
  getHistory(kind: HistoryKind): HistoryMap {
    const s = this.spec(kind);
    try {
      const cols = ["email", ...s.valueColumns, s.timeColumn].join(", ");
      const rows = this.db
        .prepare(`SELECT ${cols} FROM ${s.table}`)
        .all() as Record<string, unknown>[];

      const out: HistoryMap = {};
      for (const row of rows) {
        const email = row["email"] as string;
        const value: Record<string, unknown> = {};
        for (const c of s.valueColumns) value[c] = row[c];
        value[s.timeColumn] = row[s.timeColumn];
        out[email] = value;
      }
      return out;
    } catch (error) {
      console.error(`[DB] get ${s.table} 失败: ${error}`);
      return {};
    }
  }

  /**
 * 插入或更新一条记录。*。
   * 时间列不接受外部传入，强制 CURRENT_TIMESTAMP。
   */
  add(kind: HistoryKind, email: string, values: Record<string, string | null>): void {
    const s = this.spec(kind);
    try {
      const insertCols = ["email", ...s.valueColumns, s.timeColumn].join(", ");
      const placeholders = ["?", ...s.valueColumns.map(() => "?"), "CURRENT_TIMESTAMP"].join(", ");
      const updates = [
        ...s.valueColumns.map((c) => `${c} = excluded.${c}`),
        `${s.timeColumn} = CURRENT_TIMESTAMP`,
      ].join(",\n            ");

      const params: (string | null)[] = [email, ...s.valueColumns.map((c) => values[c] ?? null)];

      this.db
        .prepare(
          `INSERT INTO ${s.table} (${insertCols})
           VALUES (${placeholders})
           ON CONFLICT(email) DO UPDATE SET
            ${updates}`,
        )
        .run(...params);
    } catch (error) {
      console.error(`[DB ERROR] add ${s.label} 失败: ${error}`);
    }
  }

  /** 清空表，返回删除行数。异常返回 0。 */
  clear(kind: HistoryKind): number {
    const s = this.spec(kind);
    try {
      const info = this.db.prepare(`DELETE FROM ${s.table}`).run();
      return Number(info.changes ?? 0);
    } catch (error) {
      console.error(`[DB ERROR] clear ${s.label} 失败: ${error}`);
      return 0;
    }
  }

  // ---- 便捷包装：每类历史表的具名方法 ----

  getPhoneModificationHistory(): HistoryMap {
    return this.getHistory("phone");
  }
  addPhoneModification(email: string, newPhone: string): void {
    this.add("phone", email, { new_phone: newPhone });
  }

  getEmailModificationHistory(): HistoryMap {
    return this.getHistory("email");
  }
  addEmailModification(email: string, newRecoveryEmail: string): void {
    this.add("email", email, { new_recovery_email: newRecoveryEmail });
  }

  get2svPhoneModificationHistory(): HistoryMap {
    return this.getHistory("sv2Phone");
  }
  add2svPhoneModification(email: string, newPhone: string): void {
    this.add("sv2Phone", email, { new_phone: newPhone });
  }

  getAuthenticatorModificationHistory(): HistoryMap {
    return this.getHistory("authenticator");
  }
  addAuthenticatorModification(email: string, newSecret: string): void {
    this.add("authenticator", email, { new_secret: newSecret });
  }

  getSheeridVerificationHistory(): HistoryMap {
    return this.getHistory("sheerid");
  }
  addSheeridVerification(
    email: string,
    verificationId: string | null,
    verificationResult: string | null,
    message: string | null = null,
  ): void {
    this.add("sheerid", email, {
      verification_id: verificationId,
      verification_result: verificationResult,
      message,
    });
  }

  getBindCardHistory(): HistoryMap {
    return this.getHistory("bindCard");
  }
  addBindCardHistory(email: string, cardNumber: string): void {
    this.add("bindCard", email, { card_number: cardNumber });
  }
}