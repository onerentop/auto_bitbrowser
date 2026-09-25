/**
 * 6 个 AI 批量任务页（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备 / 改密码）的后端 handler
 *
 * - start：逐个账号跑 AI 自动化，耗时不定，必须走后台任务
 * 执行逻辑见 src/application/ai-task-runner.ts。
 */
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { IPC, type TaskInfo } from "../../shared/ipc.ts";
import { MANUAL_LOGIN_STATUSES, type ManualLoginStatus } from "../../shared/channels/accounts.ts";
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import {
  AI_TASK_KINDS,
  isAiTaskKind,
  type AiTaskKind,
  type AiTaskParams,
  type AiTaskStartItem,
} from "../../shared/channels/ai-tasks.ts";
import { getBrowserInfo } from "../../../src/ixbrowser/window.ts";
import {
  DEFAULT_AI_TASK_AUTOMATION,
  runAiTask,
  type AiTaskAutomation,
  type ModifyAuthDeps,
  type ChangePasswordDeps,
} from "../../../src/application/ai-task-runner.ts";

/** 单次批量上限：防止误传超大数组 */
const MAX_ITEMS = 10_000;
/** 额外参数（新手机号 / 新辅助邮箱）长度上限 */
const MAX_PARAM_LENGTH = 200;
/** email 长度上限（RFC 5321 为 254，这里放宽） */
const MAX_EMAIL_LENGTH = 320;

function invalid(message: string): CodedError {
  return new CodedError(ERROR_CODES.INVALID_ARGUMENT, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface ParsedStartArgs {
  kind: AiTaskKind;
  items: AiTaskStartItem[];
  params: AiTaskParams;
}

/**
 * 校验 start 的参数 (kind, items, params)：
 *   - kind 必须在 AI_TASK_KINDS 内
 *   - items 非空数组；每项 {email: 非空字符串, profileId: 正整数}；按 (email, profileId) 去重保序
 *   - params 普通对象，只允许该 kind 的额外输入键，值为字符串且长度 ≤ 200
 * （没有并发数参数：任务一直是逐个账号顺序执行）
 */
export function parseStartArgs(args: unknown[]): ParsedStartArgs {
  if (args.length !== 3) throw invalid("需要 3 个参数：任务种类、账号列表、参数对象");
  const [rawKind, rawItems, rawParams] = args;

  if (!isAiTaskKind(rawKind)) throw invalid(`不支持的任务种类: ${String(rawKind)}`);
  const kind = rawKind;
  const def = AI_TASK_KINDS[kind];

  if (!Array.isArray(rawItems)) throw invalid("账号列表必须是数组");
  if (rawItems.length === 0) throw invalid("账号列表不能为空");
  if (rawItems.length > MAX_ITEMS) throw invalid(`一次最多处理 ${MAX_ITEMS} 个账号`);
  const items: AiTaskStartItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) throw invalid("账号条目必须是对象");
    const email = raw["email"];
    const profileId = raw["profileId"];
    if (typeof email !== "string" || email.trim() === "") throw invalid("账号条目缺少 email");
    if (email.length > MAX_EMAIL_LENGTH) throw invalid("email 过长");
    if (typeof profileId !== "number" || !Number.isSafeInteger(profileId) || profileId <= 0) {
      throw invalid(`非法的窗口 ID: ${String(profileId)}`);
    }
    const dedupeKey = `${email}\u0000${profileId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push({ email, profileId });
  }

  if (!isPlainObject(rawParams)) throw invalid("参数必须是对象");
  const params: AiTaskParams = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (!def.extraField || key !== def.extraField.key) throw invalid(`${def.taskName}不支持参数: ${key}`);
    if (typeof value !== "string") throw invalid(`参数 ${key} 必须是字符串`);
    if (value.length > MAX_PARAM_LENGTH) throw invalid(`参数 ${key} 过长（最多 ${MAX_PARAM_LENGTH} 字符）`);
    // 参数值 strip
    params[def.extraField.key] = value.trim();
  }

  return { kind, items, params };
}

export interface AiTasksHandlerOptions {
  /** 测试注入：替换 5 个 automation 函数 */
  automation?: AiTaskAutomation;
  /** 测试注入：替换窗口名读取（生产环境走 ixBrowser getBrowserInfo） */
  getWindowName?: (profileId: number) => Promise<string | null>;
}

export function createAiTasksHandlers(ctx: HostContext, options: AiTasksHandlerOptions = {}): HostHandlerTable {
  const automation = options.automation ?? DEFAULT_AI_TASK_AUTOMATION;

  return {
    "abb/aitasks/start": (...args: unknown[]): TaskInfo => {
      const parsed = parseStartArgs(args);
      const def = AI_TASK_KINDS[parsed.kind];

      // modify_auth 的保存依赖：同一任务内只建一次。
      // 历史仓储由组合根提供（首次取用时建表），handler 不直接创建仓储。
      let authDeps: ModifyAuthDeps | null = null;
      const modifyAuthDeps = (): ModifyAuthDeps => {
        if (!authDeps) {
          authDeps = {
            accountRepo: ctx.accountRepo(),
            historyRepo: ctx.historyRepo(),
            ixClient: ctx.ix(),
            // 「已修改密钥.txt」写到数据根目录，而不是 out/ 下
            projectRoot: ctx.dataRoot,
          };
        }
        return authDeps;
      };


      return ctx.tasks.start(
        def.taskType,
        `${def.taskName}（${parsed.items.length} 个账号）`,
        (api) =>
          runAiTask(api, parsed, {
          automation,
          getAccount: (email) => ctx.accountRepo().getAccountByEmail(email),
          modifyAuthDeps,
          // change_password 的写回依赖（数据库 + ixBrowser 窗口）+ 把 op 日志接到任务日志：
          // 没有 callback 时，「提交后页面: …」这类判定依据到不了界面，真机只能靠猜（事故教训）
          changePasswordDeps: (): ChangePasswordDeps => ({
            accountRepo: ctx.accountRepo(),
            ixClient: ctx.ix(),
            callback: api.log,
            // 新密码提交前先落到数据根目录的「已修改密码.txt」（与「已修改密钥.txt」同级）
            projectRoot: ctx.dataRoot,
          }),
          // 执行前按窗口 ID 重新读取窗口名，校验与 email 一致（防止用 A 的密码操作 B 的窗口）
          getWindowName: options.getWindowName ?? (async (profileId) => {
            const info = await getBrowserInfo({ client: ctx.ix(), log: api.log }, profileId);
            return info ? String(info.name ?? "") : null;
          }),
          // 执行前确认登录：结果写库，并广播给账号页 / AI 任务页就地刷新（同手动设置登录状态的事件）
          loginSink: {
            accountRepo: () => ctx.accountRepo(),
            changed: (email, status, lastError) => {
              if (!(MANUAL_LOGIN_STATUSES as readonly string[]).includes(status)) return;
              ctx.emit(IPC.event.accountsLoginStatusChanged, {
                emails: [email],
                status: status as ManualLoginStatus,
                lastError,
              });
            },
          },
          }),
        // 启动参数快照（重跑用）：只含账号与用户填的参数，不含任何凭据
        { kind: parsed.kind, items: parsed.items, params: parsed.params },
      );
    },
  };
}
