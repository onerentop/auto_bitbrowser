/**
 * AI 批量任务（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备）的执行逻辑
 *
 * 对标：
 *   - buildAiTaskTree ← gui/ai_task_interface.py:49-68（AITaskLoadWorker.run）+ :272-334（_populateTree）
 *   - invokeAiTask    ← application/automation_engine_adapter.py:152-239（分派注册表）
 *   - describeOutcome ← 各子类 Worker._run_task 里的成功 / 失败文案
 *   - runAiTask       ← 各子类 Worker._run_task 的循环 + ai_task_interface.py:404-433 的日志
 *
 * automation 函数与数据库 / ixBrowser 依赖全部可注入，便于离线测试。
 * 本文件不依赖 electron，也不依赖 app/host（任务操作面用本地最小接口描述）。
 */
import {
  AI_TASK_ITEM_STATUS,
  AI_TASK_KINDS,
  type AiTaskBrowserNode,
  type AiTaskGroupNode,
  type AiTaskItemResult,
  type AiTaskKind,
  type AiTaskParams,
  type AiTaskRunResult,
  type AiTaskStartItem,
} from "../../app/shared/channels/ai-tasks.ts";
import { cleanText, UNGROUPED_NAME } from "./home-tree.ts";
import type { AccountRepository } from "../db/account-repository.ts";
import type { HistoryRepository } from "../db/history-repository.ts";
import type { IxBrowserClient } from "../ixbrowser/client.ts";
import { autoReplaceRecoveryPhone } from "../automation/auto-replace-recovery-phone.ts";
import { autoReplaceRecoveryEmail } from "../automation/auto-replace-recovery-email.ts";
import { autoModify2svPhone } from "../automation/auto-modify-2sv-phone.ts";
import { autoModifyAuthenticator } from "../automation/auto-modify-authenticator.ts";
import { autoKickDevices } from "../automation/auto-kick-devices.ts";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ==================== 加载：两级树 ====================

/** 分组 ID 只认整数；其余视为无效 */
function asGroupId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 窗口 ID：正整数（或可转成正整数的字符串）才有效 */
function asProfileId(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

export interface BuiltAiTaskTree {
  groups: AiTaskGroupNode[];
  totalBrowsers: number;
}

/**
 * 构建「分组 → 窗口」两级树。
 *   - 分组名（:60-68）：去掉不可打印字符，为空时用 `分组 {gid}`；另加 0 号「未分组」
 *   - 分组归属（:280-284）：b.get('group_id', 0) or 0
 *   - 只列出有窗口的分组，按 gid 升序（:287）；group-list 里没有的 gid 显示 `分组 {gid}`（:289）
 *   - 窗口名即 email（:307）；按 email 匹配数据库账号，未匹配时状态为 pending（:310-312）
 * 状态筛选在渲染层做（对应 :315-316），这里返回全部窗口。
 */
export function buildAiTaskTree(
  accounts: readonly unknown[],
  groups: readonly unknown[],
  browsers: readonly unknown[],
): BuiltAiTaskTree {
  // :53-54 {acc['email']: acc}
  const accountByEmail = new Map<string, Record<string, unknown>>();
  for (const raw of accounts) {
    const acc = asRecord(raw);
    if (acc && typeof acc["email"] === "string") accountByEmail.set(acc["email"], acc);
  }

  const groupNames = new Map<number, string>();
  for (const raw of groups) {
    const g = asRecord(raw);
    if (!g) continue;
    const gid = asGroupId(g["id"]);
    if (gid === null) continue;
    const title = cleanText(String(g["title"] ?? ""));
    groupNames.set(gid, title || `分组 ${gid}`);
  }
  groupNames.set(0, UNGROUPED_NAME);

  const grouped = new Map<number, AiTaskBrowserNode[]>();
  const usedProfileIds = new Set<number>();
  let seq = 0;
  for (const raw of browsers) {
    const b = asRecord(raw);
    if (!b) continue;
    const gid = asGroupId(b["group_id"]) ?? 0;
    let list = grouped.get(gid);
    if (!list) {
      list = [];
      grouped.set(gid, list);
    }
    const email = String(b["name"] ?? "");
    const profileId = asProfileId(b["profile_id"]);
    const index = seq++;
    // 行 key 规则与首页一致（src/application/home-tree.ts:108-132）
    let key: string;
    if (profileId !== null && !usedProfileIds.has(profileId)) {
      usedProfileIds.add(profileId);
      key = `b:${profileId}`;
    } else {
      key = `b:${gid}:${index}`;
    }
    const acc = accountByEmail.get(email);
    // Python: acc_info.get('status', 'pending')；数据库里 status 为 NULL 时显示为空
    const status = acc ? (acc["status"] === null || acc["status"] === undefined ? "" : String(acc["status"])) : "pending";
    list.push({ key, profileId, name: email, status, matched: acc !== undefined });
  }

  const result: AiTaskGroupNode[] = [];
  let total = 0;
  for (const gid of [...grouped.keys()].sort((a, b) => a - b)) {
    const list = grouped.get(gid) ?? [];
    total += list.length;
    result.push({ key: `g:${gid}`, groupId: gid, groupName: groupNames.get(gid) ?? `分组 ${gid}`, browsers: list });
  }
  return { groups: result, totalBrowsers: total };
}

// ==================== 分派注册表 ====================

/** 5 个 automation 函数（可注入替身） */
export interface AiTaskAutomation {
  autoReplaceRecoveryPhone: typeof autoReplaceRecoveryPhone;
  autoReplaceRecoveryEmail: typeof autoReplaceRecoveryEmail;
  autoModify2svPhone: typeof autoModify2svPhone;
  autoModifyAuthenticator: typeof autoModifyAuthenticator;
  autoKickDevices: typeof autoKickDevices;
}

export const DEFAULT_AI_TASK_AUTOMATION: AiTaskAutomation = {
  autoReplaceRecoveryPhone,
  autoReplaceRecoveryEmail,
  autoModify2svPhone,
  autoModifyAuthenticator,
  autoKickDevices,
};

/** modify_auth 保存新密钥所需的依赖（不注入则 automation 不写库） */
export interface ModifyAuthDeps {
  accountRepo: AccountRepository;
  historyRepo: HistoryRepository;
  ixClient: IxBrowserClient;
  /** 「已修改密钥.txt」写入目录：数据根目录，而不是 process.cwd() / out/ */
  projectRoot: string;
}

export interface AiTaskRunnerDeps {
  automation: AiTaskAutomation;
  /** 按 email 读数据库账号；无记录返回 null */
  getAccount: (email: string) => Record<string, unknown> | null;
  /** modify_auth 的依赖，惰性获取（只有该任务才需要） */
  modifyAuthDeps: () => ModifyAuthDeps;
  /**
   * 读取窗口当前名称（查不到返回 null）。提供时，每个账号执行前校验「窗口名 === email」，
   * 不一致则跳过（见 runAiTask）。生产环境由 handler 注入；不提供则不校验（仅供测试）。
   */
  getWindowName?: (profileId: number) => Promise<string | null>;
}

/** 窗口与账号对应关系已变化（跳过，不执行任何操作） */
class WindowMismatchError extends Error {}

/** 各 automation 函数返回形状不同（元组 / 带属性的元组），统一成这个形状 */
export interface AiTaskOutcome {
  ok: boolean;
  message: string;
  extra?: Record<string, unknown>;
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * 按 kind 调用 automation 函数，参数照搬 automation_engine_adapter.py：
 *   replace_phone → :225-239，close_after=False（replacephone_interface.py:56）
 *   replace_email → :204-222
 *   modify_2sv    → :168-185，不传 close_after，取函数默认值 True：任务结束会关闭该窗口（与 Python 一致）
 *   modify_auth   → :188-201，另注入 accountRepo / historyRepo / ixClient / projectRoot 以保存新密钥
 *   kick_devices  → :152-165
 * browser_id 一律 str(profile_id)。
 */
export async function invokeAiTask(
  kind: AiTaskKind,
  browserId: string,
  accountInfo: Record<string, unknown>,
  params: AiTaskParams,
  deps: Pick<AiTaskRunnerDeps, "automation" | "modifyAuthDeps">,
): Promise<AiTaskOutcome> {
  const a = deps.automation;
  switch (kind) {
    case "replace_phone": {
      const [ok, message] = await a.autoReplaceRecoveryPhone(browserId, accountInfo, params.newPhone ?? "", {
        closeAfter: false,
      });
      return { ok: Boolean(ok), message: textOf(message) };
    }
    case "replace_email": {
      const [ok, message, errorType] = await a.autoReplaceRecoveryEmail(browserId, accountInfo, params.newEmail ?? "");
      return { ok: Boolean(ok), message: textOf(message), extra: { error_type: errorType ?? null } };
    }
    case "modify_2sv": {
      const [ok, message] = await a.autoModify2svPhone(browserId, accountInfo, params.newPhone ?? "");
      return { ok: Boolean(ok), message: textOf(message) };
    }
    case "modify_auth": {
      const [ok, message, secret] = await a.autoModifyAuthenticator(browserId, accountInfo, { ...deps.modifyAuthDeps() });
      return { ok: Boolean(ok), message: textOf(message), extra: { totp_secret: secret ?? null } };
    }
    case "kick_devices": {
      const result = await a.autoKickDevices(browserId, accountInfo);
      const [ok, message] = result;
      return { ok: Boolean(ok), message: textOf(message), extra: { kicked_count: Number(result.kickedCount ?? 0) || 0 } };
    }
  }
}

/**
 * 结果 → 行状态与消息（照搬各 Worker 的 progressSignal）：
 *   各 Worker 写的是 result.get('message', '替换失败') 之类，但 adapter 返回的 dict **总是**带 message 键
 *   （automation_engine_adapter.py:152-222），所以缺省文案在 Python 里永远用不到 —— 空 message 就显示空。
 *   这里照搬：成功 / 失败都直接用 message。
 *   modify_auth 例外：成功固定「验证器已修改」，有新密钥时只显示前 8 位（modifyauth_interface.py:52-59）。
 */
export function describeOutcome(kind: AiTaskKind, outcome: AiTaskOutcome): { status: string; message: string } {
  if (!outcome.ok) {
    return { status: AI_TASK_ITEM_STATUS.failed, message: outcome.message };
  }
  if (kind === "modify_auth") {
    const secret = textOf(outcome.extra?.["totp_secret"]);
    let msg = "验证器已修改";
    if (secret) msg += ` (新密钥: ${secret.slice(0, 8)}...)`;
    return { status: AI_TASK_ITEM_STATUS.success, message: msg };
  }
  return { status: AI_TASK_ITEM_STATUS.success, message: outcome.message };
}

// ==================== 批量执行 ====================

/** 任务操作面（app/host/task-runner.ts TaskApi 的子集） */
export interface AiTaskApi {
  log(message: string): void;
  progress(current: number, total: number): void;
  item(key: string, status: string, message: string): void;
  shouldStop(): boolean;
}

export interface RunAiTaskOptions {
  kind: AiTaskKind;
  items: readonly AiTaskStartItem[];
  params: AiTaskParams;
  /** 并发数：只记录不使用，见 runAiTask 注释 */
  concurrency: number;
}

/**
 * 对标各子类 Worker._run_task：
 *   - **串行执行**：Python 5 个 Worker 都是 `for acc in self.accounts` 逐个 await，
 *     从不读取 config['concurrent']。这里照搬，concurrency 只写进日志。
 *   - 每个账号开始前检查停止标志（:42-43 `if self._shouldStop: break`）。
 *     停止只在账号之间生效：正在处理的账号无法中断，要等它结束。
 *   - accountInfo 以数据库为准：按 email 重新读取；无记录时为 {email}
 *     （Python 是 account_info={}，这里补上 email，automation 打印横幅与保存密钥要用）。
 *   - 每行状态：处理中 → 成功 / 失败 / 错误（异常）；并写日志 `[email] status: message`（:426）。
 */
export async function runAiTask(
  api: AiTaskApi,
  options: RunAiTaskOptions,
  deps: AiTaskRunnerDeps,
): Promise<AiTaskRunResult> {
  const def = AI_TASK_KINDS[options.kind];
  const items = options.items;
  const total = items.length;
  const results: AiTaskItemResult[] = [];
  let success = 0;

  const report = (email: string, status: string, message: string): void => {
    api.item(email, status, message);
    api.log(`[${email}] ${status}: ${message}`);
  };

  // :382
  api.log(`开始为 ${total} 个账号执行${def.taskName}...`);
  api.log(`并发数: ${options.concurrency}（与原版一致，按顺序逐个执行）`);
  api.progress(0, total);

  for (let i = 0; i < total; i++) {
    if (api.shouldStop()) {
      api.log(`[用户操作] ${def.taskName}任务已停止，剩余 ${total - i} 个账号未处理`);
      break;
    }
    const { email, profileId } = items[i] as AiTaskStartItem;
    report(email, AI_TASK_ITEM_STATUS.processing, def.processingMessage);

    let status: string;
    let message: string;
    try {
      // 数据安全（有意偏差）：Python 的 email 就是树上窗口的名称，二者天然绑定（:307）。
      // 这里界面只传 (email, profileId)，数据可能已过期或被伪造；执行前重新读取窗口当前名称，
      // 不等于 email 就跳过，绝不拿 A 账号的密码去操作 B 账号的窗口。
      if (deps.getWindowName) {
        const currentName = await deps.getWindowName(profileId);
        if (currentName !== email) {
          throw new WindowMismatchError(
            currentName === null
              ? `窗口 ${profileId} 不存在或无法读取，已跳过（请重新加载数据）`
              : `窗口 ${profileId} 当前名称为「${currentName}」，与账号不一致，已跳过（请重新加载数据）`,
          );
        }
      }
      const row = deps.getAccount(email);
      const accountInfo: Record<string, unknown> = row ? { ...row } : { email };
      const outcome = await invokeAiTask(options.kind, String(profileId), accountInfo, options.params, deps);
      ({ status, message } = describeOutcome(options.kind, outcome));
    } catch (error) {
      status = error instanceof WindowMismatchError ? AI_TASK_ITEM_STATUS.failed : AI_TASK_ITEM_STATUS.error;
      message = errText(error);
    }
    if (status === AI_TASK_ITEM_STATUS.success) success += 1;
    report(email, status, message);
    results.push({ email, profileId, status, message });
    api.progress(i + 1, total);
  }

  // :432
  api.log(`✅ ${def.taskName}任务完成`);
  return { total, success_count: success, failed_count: results.length - success, results };
}
