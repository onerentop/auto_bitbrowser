/**
 * 账号页「任务」抽屉（TaskPanel）的纯逻辑 —— 渲染层用，node:test 直接测
 *
 * 把「选中账号 → 执行任务」收敛到一个地方，任务表是唯一的真相：顺序、分组、名称、说明、
 * 需不需要窗口 ID、是否破坏性。界面只按表渲染，不再各处硬编码按钮文案。
 *
 * 两类任务的差别集中在这里：
 *   - runner: "account"：账号级动作（批量登录 / 健康巡检 / 删除），走后端 abb/accounts/start，
 *     一次提交一批账号，由后端并发池处理，只需要 email（+ 运行时选项）。
 *   - runner: "ai"：AI 任务（6 种），走 abb/aiTasks/start，**逐个账号顺序执行**，每个条目还要
 *     带上该账号绑定的窗口 ID；没有有效窗口的账号会被跳过。
 *
 * 纯 TS，不依赖 node / DOM / electron。
 */
import {
  AI_TASK_ITEM_STATUS,
  AI_TASK_KINDS,
  type AiTaskExtraField,
  type AiTaskKind,
  type AiTaskParams,
  type AiTaskStartItem,
} from "../channels/ai-tasks.ts";

/** 面板里的任务 id：账号动作沿用 AccountsAction 的名字；AI 任务沿用 AiTaskKind */
export type TaskPanelId = "login" | "health_check" | "delete" | "delete_with_windows" | AiTaskKind;

export interface TaskPanelTaskDef {
  id: TaskPanelId;
  /** 界面上的名称 */
  label: string;
  /** 一句话说明会对勾选账号做什么（用户视角） */
  description: string;
  /** account = 后端并发池批量执行；ai = 逐个账号顺序执行（需要窗口 ID） */
  runner: "account" | "ai";
  /** AI 任务的额外输入（账号动作没有，用运行时选项代替） */
  extraField: AiTaskExtraField | null;
  /** 会删数据 / 换掉凭据的操作，界面上要红色提示并二次确认 */
  danger: boolean;
}

/** 全部任务（界面顺序即此顺序） */
export const TASK_PANEL_TASKS: readonly TaskPanelTaskDef[] = [
  {
    id: "login",
    label: "批量登录",
    description: "打开每个账号绑定的窗口并登录；失败的保留窗口，方便手动过验证码。",
    runner: "account",
    extraField: null,
    danger: false,
  },
  {
    id: "health_check",
    label: "健康巡检",
    description: "只读检查每个账号在窗口里的登录状态，不提交密码、不产生新登录会话。",
    runner: "account",
    extraField: null,
    danger: false,
  },
  {
    id: "replace_phone",
    label: AI_TASK_KINDS.replace_phone.taskName,
    description: "把辅助手机号换成下面填写的号码；留空则移除原手机号。",
    runner: "ai",
    extraField: AI_TASK_KINDS.replace_phone.extraField,
    danger: false,
  },
  {
    id: "replace_email",
    label: AI_TASK_KINDS.replace_email.taskName,
    description: "把辅助邮箱换成下面填写的地址；留空则移除原辅助邮箱。",
    runner: "ai",
    extraField: AI_TASK_KINDS.replace_email.extraField,
    danger: false,
  },
  {
    id: "modify_2sv",
    label: AI_TASK_KINDS.modify_2sv.taskName,
    description: "把两步验证（2SV）手机改成下面填写的号码。",
    runner: "ai",
    extraField: AI_TASK_KINDS.modify_2sv.extraField,
    danger: false,
  },
  {
    id: "modify_auth",
    label: AI_TASK_KINDS.modify_auth.taskName,
    description: "重新绑定身份验证器，新密钥保存到数据库和窗口的 2FA 设置。",
    runner: "ai",
    extraField: null,
    danger: false,
  },
  {
    id: "kick_devices",
    label: AI_TASK_KINDS.kick_devices.taskName,
    description: "让账号退出除本机以外的所有已登录设备。",
    runner: "ai",
    extraField: null,
    danger: false,
  },
  {
    id: "change_password",
    label: AI_TASK_KINDS.change_password.taskName,
    description: "换成系统随机生成的新密码；Google 侧改成功后才写入数据库和窗口。",
    runner: "ai",
    extraField: null,
    danger: true,
  },
  {
    id: "delete",
    label: "删除账号",
    description: "只删除数据库里的账号记录，不删浏览器窗口。",
    runner: "account",
    extraField: null,
    danger: true,
  },
  {
    id: "delete_with_windows",
    label: "删除账号+窗口",
    description: "删除账号记录，并删掉它绑定的浏览器窗口（不可恢复）。",
    runner: "account",
    extraField: null,
    danger: true,
  },
];

/** 界面的分组（标题 + 该组里的任务 id） */
export const TASK_PANEL_GROUPS: readonly { title: string; ids: readonly TaskPanelId[] }[] = [
  { title: "账号操作", ids: ["login", "health_check"] },
  {
    title: "Google 账号修改（逐个执行，需要窗口）",
    ids: ["replace_phone", "replace_email", "modify_2sv", "modify_auth", "kick_devices", "change_password"],
  },
  { title: "删除", ids: ["delete", "delete_with_windows"] },
];

/** 按 id 取任务定义（id 只来自本表，取不到就是编程错误） */
export function taskPanelDef(id: TaskPanelId): TaskPanelTaskDef {
  const def = TASK_PANEL_TASKS.find((t) => t.id === id);
  if (!def) throw new Error(`未知的任务: ${id}`);
  return def;
}

export function isTaskPanelId(value: unknown): value is TaskPanelId {
  return typeof value === "string" && TASK_PANEL_TASKS.some((t) => t.id === value);
}

/** 面板里的一行：只取账号页列表里用得上的字段（窗口 ID 在列表里是字符串） */
export interface PanelAccountRow {
  email: string;
  /** 未绑定时为空串（"-" 也视为未绑定） */
  browser_profile_id: string;
}

/** 解析「浏览器窗口 ID」：只接受正整数字符串，其余（空 / "-" / 0 / 负数 / 超长）都算未绑定 */
function parseProfileId(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export interface PanelAiItems {
  items: AiTaskStartItem[];
  /** 没有有效窗口 ID、会被跳过的账号数 */
  skipped: number;
}

/**
 * 勾选的账号 → AI 任务条目：按列表顺序，没有有效窗口 ID 的跳过（计数给界面提示）。
 * 同一 (email, 窗口 ID) 只保留一次（后端也会去重，这里保持一致）。
 */
export function aiItemsFromAccounts(rows: readonly PanelAccountRow[]): PanelAiItems {
  const items: AiTaskStartItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows) {
    const profileId = parseProfileId(r.browser_profile_id);
    if (profileId === null) {
      skipped++;
      continue;
    }
    const dedupeKey = `${r.email}\u0000${profileId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push({ email: r.email, profileId });
  }
  return { items, skipped };
}

/**
 * 额外输入 → 任务参数：只有带额外输入的任务产出参数，值去首尾空白。
 * 留空是合法输入（例如「替换手机号」留空 = 移除手机号），所以空串照样传。
 */
export function aiParamsFor(def: TaskPanelTaskDef, value: string): AiTaskParams {
  return def.extraField ? { [def.extraField.key]: value.trim() } : {};
}

/** 逐账号结果的一行 */
export interface TaskResultRow {
  email: string;
  status: string;
  message: string;
}

/**
 * 累加一条条目事件。状态与消息都没变时返回同一个对象，避免无谓的重渲染
 * （任务运行时同一账号会连续推「处理中」）。
 */
export function upsertResult(
  prev: Readonly<Record<string, TaskResultRow>>,
  e: { key: string; status: string; message: string },
): Record<string, TaskResultRow> {
  const old = prev[e.key];
  if (old && old.status === e.status && old.message === e.message) return prev as Record<string, TaskResultRow>;
  return { ...prev, [e.key]: { email: e.key, status: e.status, message: e.message } };
}

export interface TaskResultCounts {
  total: number;
  ok: number;
  failed: number;
  unfinished: number;
}

/**
 * 结果计数：成功 / 失败（含错误）/ 未完成；unfinished 用减法且不为负
 * （条目事件比预期多时也不显示负数）。
 */
export function countResults(
  results: Readonly<Record<string, TaskResultRow>>,
  total: number,
): TaskResultCounts {
  let ok = 0;
  let failed = 0;
  for (const r of Object.values(results)) {
    if (r.status === AI_TASK_ITEM_STATUS.success) ok++;
    else if (r.status === AI_TASK_ITEM_STATUS.failed || r.status === AI_TASK_ITEM_STATUS.error) failed++;
  }
  return { total, ok, failed, unfinished: Math.max(0, total - ok - failed) };
}

/** 结果摘要文案：成功必显示，失败 / 未完成只在有数时显示 */
export function taskSummaryText(c: TaskResultCounts): string {
  if (c.total === 0) return "还没有执行任务";
  const parts = [`成功 ${c.ok}`];
  if (c.failed > 0) parts.push(`失败 ${c.failed}`);
  if (c.unfinished > 0) parts.push(`未完成 ${c.unfinished}`);
  return `本次共 ${c.total} 个账号：${parts.join(" · ")}`;
}
