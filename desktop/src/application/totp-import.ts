/**
 * TOTP 密钥导入的纯逻辑
 *
 *   - entriesFromUris   二维码文本 → 条目（识别部分交给渲染层）
 *   - parseTotpText     文本模式解析
 *   - matchTotpEntries  与数据库账号匹配
 *   - runTotpImport     导入执行
 *   - importFinishedLogLines  完成日志
 *
 * 不依赖 electron / 数据库连接：仓储、窗口列表、窗口更新全部注入，便于离线单测。
 */
import type {
  TotpEntry,
  TotpImportItem,
  TotpImportResult,
  TotpMatchCounts,
  TotpMatchResult,
  TotpMatchRow,
  TotpParseTextResult,
  TotpParseUrisResult,
  TotpTextErrorLine,
  TotpUriItem,
} from "../../app/shared/channels/totp.ts";
import { extractTotpSecretsFromContents, getOtpEmail } from "../core/totp-extractor/index.ts";
import { toInt } from "../core/totp-extractor/compat.ts";

/** 文本导入条目的 issuer / source（TextOTPAccount.issuer 默认值，:44） */
export const TEXT_IMPORT_ISSUER = "文本导入";

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ==================== 二维码文本 → 条目 ====================

/**
 * 逐张图片提取二维码里的 TOTP 密钥。
 * uri 为 null 表示该图片没识别到二维码 → 返回「未在图片中找到 QR 码」。
 * 有意偏差：jsQR 每张图只识别一个二维码，一张图里有多个码时只会取到其中一个。
 */
export function entriesFromUris(items: readonly TotpUriItem[]): TotpParseUrisResult {
  const entries: TotpEntry[] = [];
  const errors: string[] = [];
  const perItem: TotpParseUrisResult["items"] = [];
  for (const item of items) {
    const r = extractTotpSecretsFromContents(item.uri === null ? [] : [item.uri]);
    for (const acc of r.accounts) {
      entries.push({
        kind: "qr",
        email: getOtpEmail(acc),
        name: acc.name,
        secret: acc.secret,
        issuer: acc.issuer,
        source: item.source,
      });
    }
    errors.push(...r.errors);
    perItem.push({ source: item.source, count: r.accounts.length, errors: r.errors });
  }
  return { entries, errors, items: perItem };
}

// ==================== 文本解析 ====================

/**
 * 文本模式解析：
 *   - 整段先 strip，再按 "\n" 分行；每行 strip，空行跳过（# 注释行不做特殊处理）
 *   - 按 "----" 拆分，少于 3 段 → 「格式错误：字段不足」
 *   - 邮箱为空或不含 @ → 「邮箱格式无效: {email}」
 *   - 密钥为空 → 「密钥为空」
 *   - 密钥转大写；邮箱原样保留（不转小写）
 *   - 错误日志最多列 5 行，超出时追加「... 等 N 行错误」
 * 文本为空时返回空结果、不写日志（界面层会先拦下「请先粘贴账号信息」）。
 */
export function parseTotpText(rawText: string): TotpParseTextResult {
  const text = rawText.trim();
  if (!text) return { entries: [], errorLines: [], logs: [] };

  const lines = text.split("\n");
  const entries: TotpEntry[] = [];
  const errorLines: TotpTextErrorLine[] = [];
  const logs: string[] = [`开始解析文本，共 ${lines.length} 行...`];

  lines.forEach((raw, idx) => {
    const i = idx + 1;
    const line = raw.trim();
    if (!line) return;

    // 解析格式：邮箱----密码----密钥
    const parts = line.split("----");
    if (parts.length < 3) {
      errorLines.push({ line: i, content: line, reason: "格式错误：字段不足" });
      return;
    }
    const email = (parts[0] ?? "").trim();
    const password = (parts[1] ?? "").trim();
    const secret = (parts[2] ?? "").trim();

    if (!email || !email.includes("@")) {
      errorLines.push({ line: i, content: line, reason: `邮箱格式无效: ${email}` });
      return;
    }
    if (!secret) {
      errorLines.push({ line: i, content: line, reason: "密钥为空" });
      return;
    }

    entries.push({
      kind: "text",
      email,
      name: email, // TextOTPAccount.__post_init__：name 为空时取 email
      secret: secret.toUpperCase(), // 密钥通常大写
      issuer: TEXT_IMPORT_ISSUER,
      source: TEXT_IMPORT_ISSUER,
      password,
    });
    logs.push(`  解析成功: ${email}`);
  });

  // 报告解析错误（最多列 5 行，超出时追加汇总行）
  if (errorLines.length > 0) {
    logs.push(`解析错误 ${errorLines.length} 行:`);
    for (const e of errorLines.slice(0, 5)) logs.push(`  第 ${e.line} 行: ${e.reason}`);
    if (errorLines.length > 5) logs.push(`  ... 等 ${errorLines.length} 行错误`);
  }
  return { entries, errorLines, logs };
}

// ==================== 匹配 ====================

/** 匹配所需的账号字段 */
export interface MatchAccount {
  email: string;
  secret_key?: string | null;
  [key: string]: unknown;
}

/** 当前密钥展示：前 8 位 + "..."；无密钥为 "" */
export function secretPreview(secret: string | null | undefined): string {
  const s = secret ?? "";
  if (!s) return "";
  return s.length > 8 ? `${s.slice(0, 8)}...` : s;
}

/** 以 email 小写建索引；同名时后者覆盖前者 */
export function buildEmailMap<T extends { email: string }>(accounts: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const acc of accounts) map.set(String(acc.email).toLowerCase(), acc);
  return map;
}

/**
 * 与数据库账号匹配：
 *   email 为空 / 不在库里 → no_match；库里有且 secret_key 非空 → has_secret；否则 can_import
 */
export function matchTotpEntries(
  entries: ReadonlyArray<Pick<TotpEntry, "email">>,
  accounts: readonly MatchAccount[],
): TotpMatchResult {
  const map = buildEmailMap(accounts);
  const counts: TotpMatchCounts = { can_import: 0, has_secret: 0, no_match: 0 };
  const rows = entries.map((entry): TotpMatchRow => {
    const email = entry.email;
    const acc = email ? map.get(email.toLowerCase()) : undefined;
    let row: TotpMatchRow;
    if (!acc) {
      row = { status: "no_match", matchedEmail: null, currentSecret: null };
    } else {
      const current = acc.secret_key ?? "";
      row = {
        status: current ? "has_secret" : "can_import",
        matchedEmail: acc.email,
        currentSecret: secretPreview(current),
      };
    }
    counts[row.status] += 1;
    return row;
  });
  return { rows, counts };
}

// ==================== 导入执行 ====================

/** 导入用到的账号字段 */
export interface ImportAccount extends MatchAccount {
  password?: string | null;
  recovery_email?: string | null;
  browser_profile_id?: string | null;
}

export interface TotpImportDeps {
  /** 读取数据库当前全部账号（任务内重新匹配，保证以数据库当前状态为准） */
  getAllAccounts: () => readonly ImportAccount[];
  /** 写入账号字段；返回 false 表示写库失败 */
  upsertAccount: (fields: { email: string; secret_key?: string; password?: string; browser_profile_id?: string }) => boolean;
  /** 全量窗口列表（内部分页拉取） */
  listWindows: () => Promise<ReadonlyArray<{ name?: string | null; profile_id?: number | string | null; id?: number | string | null }>>;
  /** 只写 ixBrowser 窗口的 tfa_secret（**备注不碰**），返回是否成功 */
  updateProfile: (profileId: number, fields: { tfa_secret: string }) => Promise<boolean>;
  log: (message: string) => void;
  progress: (current: number, total: number) => void;
  item?: (key: string, status: string, message: string) => void;
  shouldStop?: () => boolean;
}

/**
 * 导入执行：
 *   1. 分页取 ixBrowser 窗口，建立 name.lower() → profile_id 映射
 *   2. 写入 secret_key；仅文本导入且带密码时同时更新密码
 *   3. 账号没有 browser_profile_id 时按窗口名（= 邮箱）自动绑定
 *   4. 更新窗口的 tfa_secret；**不再写备注** —— 备注是用户自己的笔记区，自动化写入会覆盖它
 *
 * 设计取舍：
 *   - 数据安全：界面只传 {email, secret, kind, password?}，任务内按数据库当前状态重新匹配；
 *     库里已不存在的账号记为失败「数据库中未找到该账号」
 *   - upsert 返回 false 时计为失败 / 警告（忽略返回值会让写库失败被静默计成成功）
 *   - 支持停止：在条目之间检查全局任务坞的停止请求；
 *     停止时剩余条目不处理，计入 skipped_count
 */
export async function runTotpImport(items: readonly TotpImportItem[], deps: TotpImportDeps): Promise<TotpImportResult> {
  const { log } = deps;

  // 1. 获取所有 ixBrowser 窗口
  const profileMap = new Map<string, number | string>();
  try {
    log("正在获取 ixBrowser 窗口列表...");
    const profiles = await deps.listWindows();
    for (const p of profiles) {
      const name = p.name ?? "";
      const pid = p.profile_id || p.id;
      if (name && pid) profileMap.set(name.toLowerCase(), pid);
    }
    if (profileMap.size > 0) log(`  获取到 ${profileMap.size} 个窗口`);
  } catch (e) {
    log(`  ⚠ 获取窗口列表失败: ${errorText(e)}`);
  }

  // 任务内重新匹配（以数据库当前状态为准）
  const dbMap = buildEmailMap(deps.getAllAccounts());

  let successCount = 0;
  let ixUpdateCount = 0;
  let bindCount = 0;
  let passwordCount = 0;
  const totalCount = items.length;
  const failedList: TotpImportResult["failed_list"] = [];
  const warningList: TotpImportResult["warning_list"] = [];
  let skipped = 0;

  for (let i = 0; i < items.length; i++) {
    // 在条目之间响应全局任务坞的停止请求
    if (deps.shouldStop?.()) {
      skipped = items.length - i;
      log(`已停止，剩余 ${skipped} 个账号未处理`);
      break;
    }

    const req = items[i] as TotpImportItem;
    const dbAccount = dbMap.get(req.email.toLowerCase());
    const email = dbAccount ? dbAccount.email : req.email;
    const secret = req.secret;
    let hasWarning = false;
    let warningMsg = "";

    try {
      if (!dbAccount) throw new Error("数据库中未找到该账号");

      // 准备更新参数（:127）
      const update: { email: string; secret_key: string; password?: string } = { email, secret_key: secret };
      // 如果是文本导入且有密码，同时更新密码
      if (req.kind === "text" && req.password) {
        update.password = req.password;
        passwordCount += 1;
      }

      // 更新数据库
      if (!deps.upsertAccount(update)) throw new Error("数据库写入失败");
      log(`  [数据库] 密钥已写入: ${email}`);
      successCount += 1;

      // 获取或查找 profile_id（:140）
      let profileId: number | string | null | undefined = dbAccount.browser_profile_id;

      // 如果没有绑定窗口，尝试通过邮箱名称匹配
      if (!profileId) {
        const matchedPid = profileMap.get(email.toLowerCase());
        if (matchedPid) {
          profileId = matchedPid;
          try {
            if (!deps.upsertAccount({ email, browser_profile_id: String(profileId) })) {
              throw new Error("数据库写入失败");
            }
            log(`  [绑定] 已自动绑定窗口: ${profileId}`);
            bindCount += 1;
          } catch (e) {
            hasWarning = true;
            warningMsg = `绑定窗口失败: ${errorText(e)}`;
          }
        }
      }

      // 只更新 ixBrowser 窗口的 tfa_secret —— **备注（note）一律不碰**。
      // 备注是用户自己的笔记区（真机实测用户会在里面手写历史密码），而原实现会用
      // `email----password----recovery_email----secret` 整条重建备注，把用户手写的内容清掉。
      // 另外 tfa_secret 必须写：真机验证（2026-09-24）发现只写 note 时窗口的 tfa_secret 一直为空。
      if (profileId) {
        try {
          log("  [窗口] 正在写入 2FA 密钥...");
          const pid = typeof profileId === "number" ? profileId : toInt(profileId);
          if (await deps.updateProfile(pid, { tfa_secret: secret })) {
            log("  [窗口] 2FA 密钥写入成功");
            ixUpdateCount += 1;
          } else {
            hasWarning = true;
            warningMsg = "更新窗口 2FA 密钥返回失败";
            log("  [窗口] ⚠ 2FA 密钥写入失败");
          }
        } catch (e) {
          hasWarning = true;
          warningMsg = `更新窗口 2FA 密钥失败: ${errorText(e)}`;
          log(`  [窗口] ⚠ ${warningMsg}`);
        }
      }

      // 记录最终结果
      if (hasWarning) {
        log(`⚠ 完成: ${email} (有警告)`);
        deps.item?.(email, "成功", warningMsg);
        warningList.push({ email, warning: warningMsg });
      } else {
        log(`✓ 完成: ${email}`);
        deps.item?.(email, "成功", "");
      }
    } catch (e) {
      const msg = errorText(e);
      log(`✗ 导入失败 ${email}: ${msg}`);
      deps.item?.(email, "失败", msg);
      failedList.push({ email, error: msg });
    }

    // 发送进度（:193）
    deps.progress(i + 1, totalCount);
  }

  return {
    success_count: successCount,
    total_count: totalCount,
    password_count: passwordCount,
    bind_count: bindCount,
    ix_update_count: ixUpdateCount,
    failed_list: failedList,
    warning_list: warningList,
    skipped_count: skipped,
  };
}

/** 完成日志：成功 / 失败 / 跳过计数与明细 */
export function importFinishedLogLines(r: TotpImportResult): string[] {
  const lines: string[] = [];
  lines.push("=".repeat(40));
  lines.push(`导入完成: 成功 ${r.success_count}/${r.total_count}`);
  if (r.failed_list.length > 0) {
    lines.push(`失败 ${r.failed_list.length} 个:`);
    for (const item of r.failed_list) lines.push(`  ✗ ${item.email}: ${item.error}`);
  }
  if (r.warning_list.length > 0) {
    lines.push(`警告 ${r.warning_list.length} 个 (密钥已导入，但窗口更新失败):`);
    for (const item of r.warning_list) lines.push(`  ⚠ ${item.email}: ${item.warning}`);
  }
  if (r.password_count > 0) lines.push(`已更新 ${r.password_count} 个密码`);
  if (r.bind_count > 0) lines.push(`已自动绑定 ${r.bind_count} 个窗口`);
  if (r.ix_update_count > 0) lines.push(`已更新 ${r.ix_update_count} 个窗口备注`);
  lines.push("=".repeat(40));
  return lines;
}
