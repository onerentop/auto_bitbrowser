/**
 * 设置页「账号数据 / 代理」的纯函数：批量导入解析、预览格式化、导出文本、导入保存规则
 *
 *
 * 纯 TS、无 Node / DOM 依赖：渲染层（实时预览、导出下载）与后端 handler（导入时再次校验）共用。
 */

// ==================== 通用：逐行解析 ====================

export type LineParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ParsedImportRow<T> {
  /** 预览表的序号（从 1 开始） */
  no: number;
  /** strip 后的原始行 */
  line: string;
  result: LineParseResult<T>;
}

/**
 * 按 \n 切行、每行 strip，跳过空行与 # 开头的行，再逐行解析。
 */
export function parseImportText<T>(text: string, parseLine: (line: string) => LineParseResult<T>): ParsedImportRow<T>[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  return lines.map((line, i) => ({ no: i + 1, line, result: parseLine(line) }));
}

/** 有效 / 无效计数（沿用「有效: x | 无效: y」的展示口径） */
export function countImportRows<T>(rows: ParsedImportRow<T>[]): { valid: number; invalid: number } {
  let valid = 0;
  for (const r of rows) if (r.result.ok) valid += 1;
  return { valid, invalid: rows.length - valid };
}

/** 无效行在预览里的显示：超过 50 字符截断 */
export function truncateInvalidLine(line: string): string {
  return line.length > 50 ? `${line.slice(0, 50)}...` : line;
}

// ==================== 账号 ====================

export interface ImportedAccount {
  email: string;
  password: string;
  recovery_email: string;
  secret_key: string;
}

export const ACCOUNT_IMPORT_FORMAT_HINT = "邮箱----密码----辅助邮箱----2FA密钥 （后两项可选）";
export const ACCOUNT_PREVIEW_COLUMNS = ["邮箱", "密码", "辅助邮箱", "2FA密钥"] as const;

/** 解析账号导入行：至少需要 邮箱----密码 */
export function parseAccountImportLine(line: string): LineParseResult<ImportedAccount> {
  const parts = line.split("----");
  if (parts.length < 2) {
    return { ok: false, error: "格式错误：至少需要 邮箱----密码" };
  }

  const email = (parts[0] ?? "").trim();
  const password = (parts[1] ?? "").trim();
  const recovery = parts.length > 2 ? (parts[2] ?? "").trim() : "";
  const secret = parts.length > 3 ? (parts[3] ?? "").trim() : "";

  if (!email.includes("@") || !email.includes(".")) {
    return { ok: false, error: "邮箱格式无效" };
  }
  if (!password) {
    return { ok: false, error: "密码不能为空" };
  }
  return { ok: true, data: { email, password, recovery_email: recovery, secret_key: secret } };
}

/** 账号预览行：密码固定显示 ******，密钥超过 8 位截断 */
export function formatAccountPreviewRow(data: ImportedAccount): [string, string, string, string] {
  const secret = data.secret_key;
  return [data.email, "******", data.recovery_email, secret.length > 8 ? `${secret.slice(0, 8)}...` : secret];
}

/** upsert 入参（与 AccountRepository.upsertAccount 的字段子集一致；undefined = 不更新） */
export interface AccountUpsertFields {
  email: string;
  password?: string;
  recovery_email?: string;
  secret_key?: string;
  status?: string;
}

/**
 * 导入保存规则：
 *   已存在：更新密码；辅助邮箱 / 2FA 只在非空时更新（空值传 None = 不动）
 *   不存在：插入，status = pending
 */
export function buildAccountImportUpsert(data: ImportedAccount, exists: boolean): AccountUpsertFields {
  if (exists) {
    const fields: AccountUpsertFields = { email: data.email, password: data.password };
    if (data.recovery_email) fields.recovery_email = data.recovery_email;
    if (data.secret_key) fields.secret_key = data.secret_key;
    return fields;
  }
  return {
    email: data.email,
    password: data.password,
    recovery_email: data.recovery_email,
    secret_key: data.secret_key,
    status: "pending",
  };
}

/** 新增账号的校验：邮箱非空且含 @ */
export function isValidNewAccountEmail(email: string): boolean {
  return !!email && email.includes("@");
}

export interface ExportableAccount {
  email: string;
  password: string;
  recovery_email: string;
  secret_key: string;
}

/**
 * 导出的文件内容：
 * 第一行 `分隔符="----"`，之后每行 email----password----recovery----secret，每行以 \n 结尾。
 */
export function buildAccountExportText(accounts: ExportableAccount[]): string {
  let out = '分隔符="----"\n';
  for (const a of accounts) {
    out += `${a.email}----${a.password}----${a.recovery_email}----${a.secret_key}\n`;
  }
  return out;
}

// ==================== 代理 ====================

export interface ImportedProxy {
  proxy_type: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

export const PROXY_IMPORT_FORMAT_HINT = "host:port:user:pass 或 host:port （无认证）";
export const PROXY_PREVIEW_COLUMNS = ["类型", "主机", "端口", "用户名"] as const;

/**
 * 解析代理导入行（host:port[:username:password]）。
 * 端口只接受 ASCII 0-9，全角 / 上标数字一律拒绝。
 */
export function parseProxyImportLine(line: string): LineParseResult<ImportedProxy> {
  const parts = line.split(":");
  if (parts.length < 2) {
    return { ok: false, error: "格式错误：至少需要 host:port" };
  }

  const host = (parts[0] ?? "").trim();
  const port = (parts[1] ?? "").trim();
  const username = parts.length > 2 ? (parts[2] ?? "").trim() : "";
  const password = parts.length > 3 ? (parts[3] ?? "").trim() : "";

  if (!host) {
    return { ok: false, error: "主机不能为空" };
  }
  if (!/^[0-9]+$/.test(port)) {
    return { ok: false, error: "端口必须是数字" };
  }
  return { ok: true, data: { proxy_type: "socks5", host, port, username, password } };
}

/** 代理预览行：类型为空时显示 socks5，用户名为空时显示 (无) */
export function formatProxyPreviewRow(data: ImportedProxy): [string, string, string, string] {
  return [data.proxy_type || "socks5", data.host, data.port, data.username || "(无)"];
}

/** 代理的身份键 host:port（与 ProxyRepository.saveAllProxies 一致） */
export function proxyKey(p: { host: string; port: string }): string {
  return `${p.host}:${p.port}`;
}

/**
 * 按 host:port 去重：后出现的覆盖先出现的，位置保留首次出现处。
 * 同一批里第二次出现的 key 在库里已存在，走 UPDATE 覆盖
 * type/username/password，库里最终只有一行、值取最后一次。
 */
export function dedupeProxiesByKey<T extends { host: string; port: string }>(proxies: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const p of proxies) byKey.set(proxyKey(p), p);
  return [...byKey.values()];
}
