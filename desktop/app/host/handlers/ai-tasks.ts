/**
 * 5 个 AI 批量任务页（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备） 的后端 handler
 *
 * - load：读取账号 + 分组 + 窗口，只读，做成普通请求（理由同 home.ts 的 listBrowsers：
 *   ixBrowser 是本机服务，正常每页 <1s，只有服务挂死时才会撞上主进程 30s 超时）
 * - start：逐个账号跑 AI 自动化，耗时不定，必须走后台任务
 * 执行逻辑见 src/application/ai-task-runner.ts。
 */
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import type { TaskInfo } from "../../shared/ipc.ts";
import { CodedError, ERROR_CODES } from "../../shared/envelope.ts";
import {
  AI_TASK_KINDS,
  isAiTaskKind,
  type AiTaskKind,
  type AiTaskLoadResult,
  type AiTaskParams,
  type AiTaskStartItem,
} from "../../shared/channels/ai-tasks.ts";
import { getBrowserInfo, getBrowserList } from "../../../src/ixbrowser/window.ts";
import { getGroupList } from "../../../src/ixbrowser/groups.ts";
import { HistoryRepository } from "../../../src/db/history-repository.ts";
import {
  DEFAULT_AI_TASK_AUTOMATION,
  buildAiTaskTree,
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

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  concurrency: number;
}

/**
 * 校验 start 的参数 (kind, items, params, concurrency)：
 *   - kind 必须在 AI_TASK_KINDS 内
 *   - items 非空数组；每项 {email: 非空字符串, profileId: 正整数}；按 (email, profileId) 去重保序
 *   - params 普通对象，只允许该 kind 的额外输入键，值为字符串且长度 ≤ 200
 *   - concurrency 为 1-10 的整数（对标 SpinBox setRange(1, 10)，ai_task_interface.py:148）
 */
export function parseStartArgs(args: unknown[]): ParsedStartArgs {
  if (args.length !== 4) throw invalid("需要 4 个参数：任务种类、账号列表、参数对象、并发数");
  const [rawKind, rawItems, rawParams, rawConcurrency] = args;

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
    // 对标子类 _getTaskConfig 的 .strip()
    params[def.extraField.key] = value.trim();
  }

  if (
    typeof rawConcurrency !== "number" ||
    !Number.isInteger(rawConcurrency) ||
    rawConcurrency < 1 ||
    rawConcurrency > 10
  ) {
    throw invalid("并发数必须是 1-10 的整数");
  }

  return { kind, items, params, concurrency: rawConcurrency };
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
    /**
     * 对标 AITaskLoadWorker.run（ai_task_interface.py:41-85）+ _populateTree（:272-334）。
     * 任何一步抛错都返回 error 字段（对应 :78-85），不抛异常。
     */
    "abb/aitasks/load": async (...args: unknown[]): Promise<AiTaskLoadResult> => {
      if (args.length > 0) throw invalid("该通道不接受参数");
      try {
        const accounts = ctx.accountRepo().getAllAccounts();
        const deps = { client: ctx.ix(), log: ctx.log };
        const groups = await getGroupList(deps);
        const browsers = await getBrowserList(deps, { fetchAll: true });
        return { ...buildAiTaskTree(accounts, groups, browsers), error: null };
      } catch (error) {
        return { groups: [], totalBrowsers: 0, error: errText(error) };
      }
    },

    "abb/aitasks/start": (...args: unknown[]): TaskInfo => {
      const parsed = parseStartArgs(args);
      const def = AI_TASK_KINDS[parsed.kind];

      // modify_auth 的保存依赖：同一任务内只建一次。
      // HistoryRepository 不会自动建表，对标 database.py:580 add_authenticator_modification 前的 init_*_table()。
      let authDeps: ModifyAuthDeps | null = null;
      const modifyAuthDeps = (): ModifyAuthDeps => {
        if (!authDeps) {
          const historyRepo = new HistoryRepository(ctx.db());
          historyRepo.initTable("authenticator");
          authDeps = {
            accountRepo: ctx.accountRepo(),
            historyRepo,
            ixClient: ctx.ix(),
            // 「已修改密钥.txt」写到数据根目录，而不是 out/ 下
            projectRoot: ctx.dataRoot,
          };
        }
        return authDeps;
      };


      return ctx.tasks.start(def.taskType, `${def.taskName}（${parsed.items.length} 个账号）`, (api) =>
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
          }),
          // 执行前按窗口 ID 重新读取窗口名，校验与 email 一致（防止用 A 的密码操作 B 的窗口）
          getWindowName: options.getWindowName ?? (async (profileId) => {
            const info = await getBrowserInfo({ client: ctx.ix(), log: api.log }, profileId);
            return info ? String(info.name ?? "") : null;
          }),
        }),
      );
    },
  };
}
