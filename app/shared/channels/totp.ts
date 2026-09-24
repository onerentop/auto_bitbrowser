/**
 * TOTP 密钥导入页 的 IPC 通道与类型
 *
 * 命名 `abb/totp/动作`。每新增一个通道：常量登记在 TOTP_INVOKE，
 * 参数与返回类型写在 TotpInvokeMap，后端实现在 app/host/handlers/totp.ts。
 * 本文件是纯 TS，不依赖 electron。
 *
 */
// 仅类型导入：ipc.ts 反向 import 本文件，type-only 不会形成运行时循环
import type { TaskInfo } from "../ipc.ts";

export const TOTP_INVOKE = {
 /** 二维码文本 → TOTP 条目（652 里 extract_totp_secrets_from_image 拿到文本之后的部分） */
  totpParseUris: "abb/totp/parseUris",
 /** 文本模式解析（552-619） */
  totpParseText: "abb/totp/parseText",
 /** 与数据库账号匹配（708-751） */
  totpMatch: "abb/totp/match",
 /** 导入选中条目（后台任务，56-196） */
  totpImport: "abb/totp/import",
} as const;

/** 导入任务的 task type */
export const TOTP_IMPORT_TASK_TYPE = "import_totp";

/** 单次请求的条目上限（防止渲染层误传超大数组） */
export const TOTP_MAX_ITEMS = 5000;

// ==================== 数据类型 ====================

/** 条目来源：二维码（OTPAccount）或文本（TextOTPAccount） */
export type TotpEntryKind = "qr" | "text";

/**
 * 解析出的一条 TOTP 记录（ / TextOTPAccount 在界面上用到的字段）。
 * - email：OTPAccount.get_email() 的结果（可能为 null）；文本导入为原样邮箱（:47-49，不转小写）
 * - name：账号名称；表格「提取邮箱」列在 email 为空时显示它（:784）
 * - issuer：表格「来源」列（:788，空时显示 "-"）；文本导入固定为「文本导入」
 * - source：条目出自哪张图片（文件名）或「文本导入」，只用于日志
 * - password：仅文本导入有
 */
export interface TotpEntry {
  kind: TotpEntryKind;
  email: string | null;
  name: string;
  secret: string;
  issuer: string;
  source: string;
  password?: string;
}

/** parseUris 的一项输入：一张图片识别出的二维码文本；uri 为 null 表示没识别到二维码 */
export interface TotpUriItem {
  uri: string | null;
  source: string;
}

/** parseUris 的单张图片结果（用于逐图写日志，:667-679） */
export interface TotpUriItemResult {
  source: string;
  count: number;
  errors: string[];
}

export interface TotpParseUrisResult {
  entries: TotpEntry[];
  /** 所有错误的平铺列表 */
  errors: string[];
  items: TotpUriItemResult[];
}

/** 文本模式的一行错误（ 的 (i, line, reason)） */
export interface TotpTextErrorLine {
  line: number;
  content: string;
  reason: string;
}

export interface TotpParseTextResult {
  entries: TotpEntry[];
  errorLines: TotpTextErrorLine[];
  /** 解析过程日志（已去掉用于空行的 "\n" 前缀） */
  logs: string[];
}

/** 匹配状态（203-207） */
export type TotpMatchStatus = "can_import" | "has_secret" | "no_match";

export const TOTP_STATUS_TEXT: Readonly<Record<TotpMatchStatus, string>> = {
  can_import: "可导入",
  has_secret: "已有",
  no_match: "未匹配",
};

export const TOTP_STATUS_COLORS: Readonly<Record<TotpMatchStatus, string>> = {
  can_import: "#4CAF50",
  has_secret: "#FF9800",
  no_match: "#888888",
};

/** 与入参 entries 按下标一一对应的匹配结果 */
export interface TotpMatchRow {
  status: TotpMatchStatus;
  /** 匹配到的数据库账号邮箱（库里的原始大小写）；未匹配为 null */
  matchedEmail: string | null;
  /**
 * 当前密钥展示值（:807-817）：前 8 位，超过 8 位追加 "..." 
   * 匹配到但无密钥为 ""；未匹配为 null。不向渲染层下发完整密钥。
   */
  currentSecret: string | null;
}

export interface TotpMatchCounts {
  can_import: number;
  has_secret: number;
  no_match: number;
}

export interface TotpMatchResult {
  rows: TotpMatchRow[];
  counts: TotpMatchCounts;
}

/**
 * 导入请求的一项：界面只传解析出的数据，账号匹配在任务内按数据库当前状态重做。
 * password 只在 kind === "text" 时生效（:130 isinstance(otp_acc, TextOTPAccount)）。
 */
export interface TotpImportItem {
  email: string;
  secret: string;
  kind: TotpEntryKind;
  password?: string;
}

/** 导入结果 */
export interface TotpImportResult {
  success_count: number;
  total_count: number;
  password_count: number;
  bind_count: number;
  ix_update_count: number;
  failed_list: Array<{ email: string; error: string }>;
  warning_list: Array<{ email: string; warning: string }>;
  /** 因停止而未处理的条目数 */
  skipped_count: number;
}

// ==================== 通道 → 类型 ====================

export interface TotpInvokeMap {
  "abb/totp/parseUris": { args: [items: TotpUriItem[]]; result: TotpParseUrisResult };
  "abb/totp/parseText": { args: [text: string]; result: TotpParseTextResult };
  "abb/totp/match": { args: [entries: Array<Pick<TotpEntry, "email">>]; result: TotpMatchResult };
  "abb/totp/import": { args: [items: TotpImportItem[]]; result: TaskInfo };
}
