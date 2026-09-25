/**
 * AI 批量任务（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备 / 改密码）的执行逻辑
 * 每个账号执行前先只读检查登录（已登录直接执行，未登录才走登录流程，登录失败不执行）。
 *
 * 包含四部分：
 *   - buildAiTaskRows：窗口列表 + 数据库账号 → 平铺账号列表
 *   - invokeAiTask：按任务类型分派到对应的 automation 函数
 *   - describeOutcome：把执行结果转成行状态与文案
 *   - runAiTask：串行执行整批任务并上报进度 / 日志
 *
 * automation 函数与数据库 / ixBrowser 依赖全部可注入，便于离线测试。
 * 本文件不依赖 electron，也不依赖 app/host（任务操作面用本地最小接口描述）。
 */
import {
  AI_TASK_ITEM_STATUS,
  AI_TASK_KINDS,
  type AiTaskItemResult,
  type AiTaskKind,
  type AiTaskLoadResult,
  type AiTaskParams,
  type AiTaskRow,
  type AiTaskRunResult,
  type AiTaskStartItem,
} from "../../app/shared/channels/ai-tasks.ts";
import { buildBrowserList } from "../../app/shared/logic/home-list.ts";
import type { AccountRepository } from "../db/account-repository.ts";
import type { HistoryRepository } from "../db/history-repository.ts";
import type { IxBrowserClient } from "../ixbrowser/client.ts";
import { autoReplaceRecoveryPhone } from "../automation/auto-replace-recovery-phone.ts";
import { autoReplaceRecoveryEmail } from "../automation/auto-replace-recovery-email.ts";
import { autoModify2svPhone } from "../automation/auto-modify-2sv-phone.ts";
import { autoModifyAuthenticator } from "../automation/auto-modify-authenticator.ts";
import { autoKickDevices } from "../automation/auto-kick-devices.ts";
import { autoChangePassword } from "../automation/auto-change-password.ts";
import { autoGoogleLogin, checkGoogleLogin } from "../automation/auto-google-login.ts";

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ==================== 加载：平铺列表 ====================

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 平铺账号列表：
 *   - 分组名、行 key、分组统计与首页同一规则（直接复用 buildBrowserList）
 *   - email 取窗口名**原文**（不清洗）：执行前要与窗口当前名称逐字比对，也用它按 email 匹配数据库账号
 *   - 只从账号里取布尔值 / 登录状态 / 最后登录时间，**不带出密码、密钥、辅助邮箱原文**
 */
export function buildAiTaskRows(
  accounts: readonly unknown[],
  groups: readonly unknown[],
  browsers: readonly unknown[],
): Omit<AiTaskLoadResult, "error"> {
  const accountByEmail = new Map<string, Record<string, unknown>>();
  for (const raw of accounts) {
    const acc = asRecord(raw);
    if (acc && typeof acc["email"] === "string") accountByEmail.set(acc["email"], acc);
  }

  // buildBrowserList 与这里用同一个 asRecord 过滤，下标一一对应
  const records = browsers.map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
  const list = buildBrowserList(groups, records);
  const rows: AiTaskRow[] = list.browsers.map((node, i) => {
    const email = String(records[i]?.["name"] ?? "");
    const acc = accountByEmail.get(email);
    const lastLogin = acc?.["last_login_at"];
    return {
      key: node.key,
      profileId: node.profileId,
      email,
      groupId: node.groupId,
      groupName: node.groupName,
      inDb: acc !== undefined,
      hasRecoveryEmail: nonEmpty(acc?.["recovery_email"]),
      hasSecret: nonEmpty(acc?.["secret_key"]),
      loginStatus: typeof acc?.["login_status"] === "string" ? acc["login_status"] : "",
      lastLoginAt: nonEmpty(lastLogin) ? String(lastLogin) : null,
    };
  });
  return { rows, groups: list.groups, totalBrowsers: rows.length };
}

// ==================== 分派注册表 ====================

/** 5 个 automation 函数（可注入替身） */
export interface AiTaskAutomation {
  autoReplaceRecoveryPhone: typeof autoReplaceRecoveryPhone;
  autoReplaceRecoveryEmail: typeof autoReplaceRecoveryEmail;
  autoModify2svPhone: typeof autoModify2svPhone;
  autoModifyAuthenticator: typeof autoModifyAuthenticator;
  autoKickDevices: typeof autoKickDevices;
  autoChangePassword: typeof autoChangePassword;
  /** 执行前只读检查窗口是否已登录（不输入、不写库） */
  checkGoogleLogin: typeof checkGoogleLogin;
  /** 检查发现未登录时才调用的登录流程 */
  autoGoogleLogin: typeof autoGoogleLogin;
}

export const DEFAULT_AI_TASK_AUTOMATION: AiTaskAutomation = {
  autoReplaceRecoveryPhone,
  autoReplaceRecoveryEmail,
  autoModify2svPhone,
  autoModifyAuthenticator,
  autoKickDevices,
  autoChangePassword,
  checkGoogleLogin,
  autoGoogleLogin,
};

/** modify_auth 保存新密钥所需的依赖（不注入则 automation 不写库） */
export interface ModifyAuthDeps {
  accountRepo: AccountRepository;
  historyRepo: HistoryRepository;
  ixClient: IxBrowserClient;
  /** 「已修改密钥.txt」写入目录：数据根目录，而不是 process.cwd() / out/ */
  projectRoot: string;
}

/** change_password 写回本地所需的依赖；不注入则只改 Google 侧、不写本地 */
export interface ChangePasswordDeps {
  accountRepo: Pick<AccountRepository, "upsertAccount">;
  ixClient: Pick<IxBrowserClient, "getProfileInfo" | "updateProfile">;
  /**
   * op 日志回调（接到任务日志）。
   *
   * 不传的话 op 的**全部判定依据**（含「提交后页面: url=… 文本=…」「页面出现拒绝字样…」）
   * 会被静默丢弃：用户在界面上只看得到「无法确认密码是否已更改」，一个字的原因都没有 ——
   * 真机改密事故复盘时正是卡在这里，只能靠猜。
   */
  callback?: (msg: string) => void;
}

export interface AiTaskRunnerDeps {
  automation: AiTaskAutomation;
  /** 按 email 读数据库账号；无记录返回 null */
  getAccount: (email: string) => Record<string, unknown> | null;
  /** modify_auth 的依赖，惰性获取（只有该任务才需要） */
  modifyAuthDeps: () => ModifyAuthDeps;
  /** change_password 的写回依赖（数据库 + ixBrowser 窗口），惰性获取 */
  changePasswordDeps: () => ChangePasswordDeps;
  /**
   * 读取窗口当前名称（查不到返回 null）。提供时，每个账号执行前校验「窗口名 === email」，
   * 不一致则跳过（见 runAiTask）。生产环境由 handler 注入；不提供则不校验（仅供测试）。
   */
  getWindowName?: (profileId: number) => Promise<string | null>;
  /**
   * 执行前确认登录的写库与通知：登录结果经 accountRepo 写入登录状态，
   * 写完后调 changed（handler 用它广播 loginStatusChanged，账号页 / AI 任务页就地刷新）。
   */
  loginSink: {
    accountRepo: () => Pick<AccountRepository, "updateLoginStatus" | "upsertAccount">;
    changed: (email: string, status: string, lastError: string | null) => void;
  };
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
 * 按 kind 调用 automation 函数：
 *   replace_phone → close_after=false
 *   replace_email → 用默认参数
 *   modify_2sv    → 不传 close_after，取函数默认值 true：任务结束会关闭该窗口
 *   modify_auth   → 另注入 accountRepo / historyRepo / ixClient / projectRoot 以保存新密钥
 *   kick_devices  → 用默认参数
 * browser_id 一律取字符串形式的 profile_id。
 */
export async function invokeAiTask(
  kind: AiTaskKind,
  browserId: string,
  accountInfo: Record<string, unknown>,
  params: AiTaskParams,
  deps: Pick<AiTaskRunnerDeps, "automation" | "modifyAuthDeps" | "changePasswordDeps">,
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
    case "change_password": {
      const [ok, message] = await a.autoChangePassword(browserId, accountInfo, { ...deps.changePasswordDeps() });
      return { ok: Boolean(ok), message: textOf(message) };
    }
  }
}

/**
 * 结果 → 行状态与消息：
 *   automation 返回的结果**总是**带 message 键，所以缺省文案永远用不到 —— 空 message 就显示空。
 *   成功 / 失败都直接用 message。
 *   modify_auth 例外：成功固定「验证器已修改」，有新密钥时只显示前 8 位。
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
}

/**
 * 批处理任务的执行循环：
 *   - **串行执行**：逐个账号 await（没有并发选项）。
 *   - 每个账号开始前检查停止标志。
 *     停止只在账号之间生效：正在处理的账号无法中断，要等它结束。
 *   - accountInfo 以数据库为准：按 email 重新读取；无记录时为 {email}，
 *     这样 automation 打印横幅与保存密钥时都有 email 可用。
 *   - 每行状态：处理中 → 成功 / 失败 / 错误（异常）；并写日志 `[email] status: message`。
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
      // 数据安全：界面只传 (email, profileId)，数据可能已过期或被伪造；执行前重新读取窗口当前名称，
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

      // 执行前先**只读**检查窗口是否已登录该账号（真机 2026-09-25：数据库写已登录，窗口其实早已退出）：
      //   - 已登录 → 不走登录流程，直接执行后续步骤；库里状态过时才纠正并通知界面；
      //   - 未登录（或检查本身出错）→ 才用数据库账号信息登录。登录失败就不执行操作 ——
      //     否则操作页会被跳到登录页，报出含糊的「需要先登录账号」。
      let signedIn = false;
      try {
        signedIn = (await deps.automation.checkGoogleLogin(String(profileId), accountInfo, { callback: api.log })).signedIn;
      } catch {
        signedIn = false; // 检查出错交给登录流程（它第一步还会再检查一次）
      }

      let login: { success: boolean; message: string; loginStatus: string };
      if (signedIn) {
        login = { success: true, message: "已登录", loginStatus: "logged_in" };
        if (row && textOf(row["login_status"]) !== "logged_in") {
          deps.loginSink.accountRepo().updateLoginStatus(email, "logged_in");
          deps.loginSink.changed(email, "logged_in", null);
        }
      } else {
        try {
          login = await deps.automation.autoGoogleLogin(String(profileId), accountInfo, {
            callback: api.log,
            accountRepo: deps.loginSink.accountRepo(),
          });
        } catch (error) {
          // autoGoogleLogin 正常会把异常折成返回值；万一漏出来，也按「登录失败，未执行」处理
          login = { success: false, message: errText(error), loginStatus: "login_failed" };
        }
        // 写库只对数据库里有的账号生效；按写完后的库内值通知界面（与账号页显示的一致）
        if (row) {
          const after = deps.getAccount(email);
          deps.loginSink.changed(email, String(after?.["login_status"] ?? login.loginStatus), textOf(after?.["last_error"]) || null);
        }
      }

      if (!login.success) {
        status = AI_TASK_ITEM_STATUS.failed;
        message = `登录失败，未执行${def.taskName}：${login.message}`;
      } else if (api.shouldStop()) {
        // 登录耗时长（开窗 + 完整登录可达几十秒）：用户在这段时间点了停止，就不再执行会改账号的操作。
        // 下一轮循环开头的停止检查会结束整个任务。
        status = AI_TASK_ITEM_STATUS.failed;
        message = `已停止，未执行${def.taskName}`;
      } else {
        const outcome = await invokeAiTask(options.kind, String(profileId), accountInfo, options.params, deps);
        ({ status, message } = describeOutcome(options.kind, outcome));
        // 替换辅助邮箱成功：新邮箱写回数据库（真机 2026-09-25：原来只改了 Google 侧，库里还是旧邮箱）。
        // 写库失败不能静默——Google 侧已经改了，行状态判失败并说明，方便人工补录。
        const newEmail = (options.params.newEmail ?? "").trim();
        if (options.kind === "replace_email" && outcome.ok && newEmail && row) {
          if (!deps.loginSink.accountRepo().upsertAccount({ email, recovery_email: newEmail })) {
            status = AI_TASK_ITEM_STATUS.failed;
            message = `辅助邮箱已替换为 ${newEmail}，但写入数据库失败，请手动更新`;
          }
        }
      }
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
