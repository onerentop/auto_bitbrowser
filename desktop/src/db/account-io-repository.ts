/**
 * 账号导入导出与综合查询仓储
 */
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./connection.ts";
import { buildAccountLine, parseAccountLine } from "../core/data-parser.ts";

/** 状态 → 文件名映射（导入导出共用） */
export const STATUS_FILES: Record<string, string> = {
  link_ready: "sheerIDlink.txt",
  verified: "已验证未绑卡.txt",
  subscribed: "已绑卡号.txt",
  ineligible: "无资格号.txt",
  error: "超时或其他错误.txt",
};

/** 额外导出的待验证文件（不参与导入） */
export const PENDING_FILE = "有资格待验证号.txt";

/** upsert 回调签名 */
export type UpsertCallback = (account: {
  email: string;
  password: string | null;
  recoveryEmail: string | null;
  secretKey: string | null;
  verificationLink: string | null;
  status: string;
}) => void;

export interface ComprehensiveAccountRow {
  email: string;
  password: string | null;
  recovery_email: string | null;
  secret_key: string | null;
  verification_link: string | null;
  status: string | null;
  message: string | null;
  updated_at: string | null;
  phone_modified: boolean;
  phone_new: string | null;
  phone_modified_at: string | null;
  email_modified: boolean;
  email_new: string | null;
  email_modified_at: string | null;
  sv2_phone_modified: boolean;
  sv2_phone_new: string | null;
  sv2_phone_modified_at: string | null;
  auth_modified: boolean;
  auth_new_secret: string | null;
  auth_modified_at: string | null;
  sheerid_verified: boolean;
  sheerid_id: string | null;
  sheerid_result: string | null;
  sheerid_message: string | null;
  sheerid_verified_at: string | null;
  bind_card: boolean;
  bind_card_number: string | null;
  bind_card_at: string | null;
}

export class AccountIoRepository {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * 从状态文本文件导入账号，返回处理条数。
   * 逐文件 try/catch，单个文件出错不影响其余。
   */
  importFromStatusFiles(baseDir: string, upsert: UpsertCallback): number {
    let count = 0;

    for (const [status, filename] of Object.entries(STATUS_FILES)) {
      const filePath = path.join(baseDir, filename);
      if (!fs.existsSync(filePath)) continue;

      try {
        const lines = fs
          .readFileSync(filePath, "utf8")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith("#"));

        for (const line of lines) {
          const parsed = parseAccountLine(line);
          if (!parsed.email) continue;
          upsert({
            email: parsed.email,
            password: parsed.password,
            recoveryEmail: parsed.recovery,
            secretKey: parsed.secret,
            verificationLink: parsed.link,
            status,
          });
          count += 1;
        }
      } catch (error) {
        console.error(`从 ${filename} 导入时出错: ${error}`);
      }
    }

    return count;
  }

  /**
   * 把数据库账号按状态导出为文本文件。
   *
   * 两条易错规则：
   *   - status 为 running / processing 的记录整条跳过
   *   - link_ready 的记录：有链接时写入 sheerIDlink.txt（链接在行首），
   *     同时**无条件**再写一份到"有资格待验证号.txt"
   */
  exportAccountsToStatusFiles(baseDir: string): boolean {
    try {
      const rows = this.db.prepare("SELECT * FROM accounts").all() as Record<string, unknown>[];

      const data: Record<string, string[]> = {};
      for (const s of Object.keys(STATUS_FILES)) data[s] = [];
      const pending: string[] = [];

      for (const row of rows) {
        const status = row["status"] as string | null;
        if (status === "running" || status === "processing") continue;

        const accountLine = buildAccountLine({
          email: row["email"] as string,
          password: row["password"] as string | null,
          recovery: row["recovery_email"] as string | null,
          secret: row["secret_key"] as string | null,
        });

        if (status === "link_ready") {
          const link = row["verification_link"] as string | null;
          if (link) data["link_ready"]?.push(`${link}----${accountLine}`);
          pending.push(accountLine);
        } else if (status && status in data) {
          data[status]?.push(accountLine);
        }
      }

      for (const [status, filename] of Object.entries(STATUS_FILES)) {
        const lines = data[status] ?? [];
        fs.writeFileSync(
          path.join(baseDir, filename),
          lines.map((l) => l + "\n").join(""),
          "utf8",
        );
      }

      fs.writeFileSync(
        path.join(baseDir, PENDING_FILE),
        pending.map((l) => l + "\n").join(""),
        "utf8",
      );

      return true;
    } catch (error) {
      console.error(`[DB ERROR] export_to_files 失败: ${error}`);
      return false;
    }
  }

  /**
   * 综合账户数据：accounts 左连 6 张历史表。
   * 注意 *_modified / sheerid_verified 是派生布尔值（源列是否非 NULL）。
   */
  getComprehensiveAccountData(): ComprehensiveAccountRow[] {
    const rows = this.db
      .prepare(
        `SELECT
            a.email, a.password, a.recovery_email, a.secret_key,
            a.verification_link, a.status, a.message, a.updated_at,
            p.new_phone as phone_new,
            p.modified_at as phone_modified_at,
            e.new_recovery_email as email_new,
            e.modified_at as email_modified_at,
            sv.new_phone as sv2_phone_new,
            sv.modified_at as sv2_phone_modified_at,
            auth.new_secret as auth_new_secret,
            auth.modified_at as auth_modified_at,
            sh.verification_id as sheerid_id,
            sh.verification_result as sheerid_result,
            sh.message as sheerid_message,
            sh.verified_at as sheerid_verified_at,
            bc.card_number as bind_card_number,
            bc.bound_at as bind_card_at
          FROM accounts a
          LEFT JOIN phone_modification_history p ON a.email = p.email
          LEFT JOIN email_modification_history e ON a.email = e.email
          LEFT JOIN sv2_phone_modification_history sv ON a.email = sv.email
          LEFT JOIN authenticator_modification_history auth ON a.email = auth.email
          LEFT JOIN sheerid_verification_history sh ON a.email = sh.email
          LEFT JOIN bind_card_history bc ON a.email = bc.email
          ORDER BY a.updated_at DESC`,
      )
      .all() as Record<string, unknown>[];

    return rows.map((r) => ({
      email: r["email"] as string,
      password: (r["password"] ?? null) as string | null,
      recovery_email: (r["recovery_email"] ?? null) as string | null,
      secret_key: (r["secret_key"] ?? null) as string | null,
      verification_link: (r["verification_link"] ?? null) as string | null,
      status: (r["status"] ?? null) as string | null,
      message: (r["message"] ?? null) as string | null,
      updated_at: (r["updated_at"] ?? null) as string | null,
      phone_modified: r["phone_new"] != null,
      phone_new: (r["phone_new"] ?? null) as string | null,
      phone_modified_at: (r["phone_modified_at"] ?? null) as string | null,
      email_modified: r["email_new"] != null,
      email_new: (r["email_new"] ?? null) as string | null,
      email_modified_at: (r["email_modified_at"] ?? null) as string | null,
      sv2_phone_modified: r["sv2_phone_new"] != null,
      sv2_phone_new: (r["sv2_phone_new"] ?? null) as string | null,
      sv2_phone_modified_at: (r["sv2_phone_modified_at"] ?? null) as string | null,
      auth_modified: r["auth_new_secret"] != null,
      auth_new_secret: (r["auth_new_secret"] ?? null) as string | null,
      auth_modified_at: (r["auth_modified_at"] ?? null) as string | null,
      sheerid_verified: r["sheerid_result"] != null,
      sheerid_id: (r["sheerid_id"] ?? null) as string | null,
      sheerid_result: (r["sheerid_result"] ?? null) as string | null,
      sheerid_message: (r["sheerid_message"] ?? null) as string | null,
      sheerid_verified_at: (r["sheerid_verified_at"] ?? null) as string | null,
      bind_card: r["bind_card_number"] != null,
      bind_card_number: (r["bind_card_number"] ?? null) as string | null,
      bind_card_at: (r["bind_card_at"] ?? null) as string | null,
    }));
  }
}