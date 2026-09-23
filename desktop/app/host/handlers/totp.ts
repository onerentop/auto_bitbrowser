/**
 * TOTP 密钥导入页 的后端 handler —— 对标 gui/import_totp_interface.py
 *
 * 纯逻辑在 src/application/totp-import.ts；这里只做参数校验、依赖装配与后台任务启动。
 * 导入可能耗时（逐个更新窗口备注），走 ctx.tasks 后台任务，避免触发主进程 30s 超时。
 */
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import {
  TOTP_IMPORT_TASK_TYPE,
  TOTP_INVOKE,
  TOTP_MAX_ITEMS,
  type TotpEntry,
  type TotpImportItem,
  type TotpMatchResult,
  type TotpParseTextResult,
  type TotpParseUrisResult,
  type TotpUriItem,
} from "../../shared/channels/totp.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import {
  entriesFromUris,
  importFinishedLogLines,
  matchTotpEntries,
  parseTotpText,
  runTotpImport,
  type TotpImportDeps,
} from "../../../src/application/totp-import.ts";
import { getBrowserList } from "../../../src/ixbrowser/window.ts";

/** 文本模式输入上限（字符数），防止误粘贴超大文本 */
const MAX_TEXT_LENGTH = 2_000_000;

// ==================== 参数校验 ====================

function invalid(message: string): CodedError {
  return new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${name} 必须是数组`);
  if (value.length > TOTP_MAX_ITEMS) throw invalid(`${name} 超过上限 ${TOTP_MAX_ITEMS}`);
  return value;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function requireUriItems(value: unknown): TotpUriItem[] {
  return requireArray(value, "items").map((raw, i) => {
    const o = requireObject(raw, `items[${i}]`);
    const uri = o["uri"];
    if (uri !== null && typeof uri !== "string") throw invalid(`items[${i}].uri 必须是字符串或 null`);
    if (typeof o["source"] !== "string") throw invalid(`items[${i}].source 必须是字符串`);
    return { uri, source: o["source"] };
  });
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw invalid("text 必须是字符串");
  if (value.length > MAX_TEXT_LENGTH) throw invalid(`text 超过上限 ${MAX_TEXT_LENGTH} 个字符`);
  return value;
}

function requireMatchEntries(value: unknown): Array<Pick<TotpEntry, "email">> {
  return requireArray(value, "entries").map((raw, i) => {
    const o = requireObject(raw, `entries[${i}]`);
    const email = o["email"];
    if (email !== null && typeof email !== "string") throw invalid(`entries[${i}].email 必须是字符串或 null`);
    return { email };
  });
}

function requireImportItems(value: unknown): TotpImportItem[] {
  const list = requireArray(value, "items");
  if (list.length === 0) throw invalid("items 不能为空");
  return list.map((raw, i) => {
    const o = requireObject(raw, `items[${i}]`);
    const email = o["email"];
    const secret = o["secret"];
    const kind = o["kind"];
    const password = o["password"];
    if (typeof email !== "string" || email.trim() === "") throw invalid(`items[${i}].email 必须是非空字符串`);
    if (typeof secret !== "string" || secret.trim() === "") throw invalid(`items[${i}].secret 必须是非空字符串`);
    if (kind !== "qr" && kind !== "text") throw invalid(`items[${i}].kind 必须是 "qr" 或 "text"`);
    if (password !== undefined && password !== null && typeof password !== "string") {
      throw invalid(`items[${i}].password 必须是字符串`);
    }
    const item: TotpImportItem = { email, secret, kind };
    // 密码只对文本导入生效（:130），二维码条目带的密码直接丢弃
    if (kind === "text" && typeof password === "string" && password) item.password = password;
    return item;
  });
}

// ==================== handler 工厂 ====================

export interface TotpHandlerDeps {
  /** 测试注入：替换窗口列表 / 备注更新 */
  listWindows?: TotpImportDeps["listWindows"];
  updateProfileNote?: TotpImportDeps["updateProfileNote"];
}

export function createTotpHandlers(ctx: HostContext, deps: TotpHandlerDeps = {}): HostHandlerTable {
  const repo = () => ctx.accountRepo();
  // 对标 :86-102 的分页 get_profile_list(page, limit=100)；getBrowserList 失败时返回已取到的部分
  const listWindows =
    deps.listWindows ?? (() => getBrowserList({ client: ctx.ix(), log: ctx.log }, { fetchAll: true, limit: 100 }));
  // 对标 update_profile(int(profile_id), note=note)；只传 note，不写 tfa_secret（以 Python 为准）。
  // 有意偏差：Python 的 update_profile 对网络类错误有重试，客户端 updateProfile 没有，失败即计为警告。
  const updateProfileNote = deps.updateProfileNote ?? ((id: number, note: string) => ctx.ix().updateProfile(id, { note }));

  return {
    [TOTP_INVOKE.totpParseUris]: (items: unknown): TotpParseUrisResult => entriesFromUris(requireUriItems(items)),

    [TOTP_INVOKE.totpParseText]: (text: unknown): TotpParseTextResult => parseTotpText(requireText(text)),

    [TOTP_INVOKE.totpMatch]: (entries: unknown): TotpMatchResult =>
      matchTotpEntries(requireMatchEntries(entries), repo().getAllAccounts()),

    [TOTP_INVOKE.totpImport]: (items: unknown): TaskInfo => {
      const list = requireImportItems(items);
      return ctx.tasks.start(TOTP_IMPORT_TASK_TYPE, `导入 TOTP 密钥（${list.length} 个）`, async (api) => {
        api.progress(0, list.length);
        const result = await runTotpImport(list, {
          getAllAccounts: () => repo().getAllAccounts(),
          upsertAccount: (fields) => repo().upsertAccount(fields),
          listWindows,
          updateProfileNote,
          log: api.log,
          progress: api.progress,
          item: api.item,
          shouldStop: api.shouldStop,
        });
        for (const line of importFinishedLogLines(result)) api.log(line);
        return result;
      });
    },
  };
}
