/**
 * 5 个 AI 批量任务页（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备） 的 IPC 通道与类型
 *
 * 命名 `abb/aitasks/动作`。每新增一个通道：常量登记在 AI_TASKS_INVOKE，
 * 参数与返回类型写在 AiTasksInvokeMap，后端实现在 app/host/handlers/ai-tasks.ts。
 * 本文件是纯 TS，不依赖 electron。
 *
 * 批量任务的参数、进度与结果都按 aitaskKind 区分，
 * 每类任务的文案与额外输入框见下表的 AI_TASK_KINDS。
 */
// 仅类型导入：ipc.ts 反向 import 本文件，type-only 不会形成运行时循环
import type { TaskInfo } from "../ipc.ts";

export const AI_TASKS_INVOKE = {
  /** 读取账号 + 分组 + 窗口，组成两级树 */
  aiTasksLoad: "abb/aitasks/load",
  /** 对选中账号串行执行某一种 AI 任务（后台任务） */
  aiTasksStart: "abb/aitasks/start",
} as const;

// ==================== 任务定义表 ====================

export type AiTaskKind =
  | "replace_phone"
  | "replace_email"
  | "modify_2sv"
  | "modify_auth"
  | "kick_devices"
  /** 修改密码（本地新增，F1）：新密码由系统自动生成，无额外输入 */
  | "change_password";

/** 额外输入框的参数键 */
export type AiTaskParamKey = "newPhone" | "newEmail";

export interface AiTaskExtraField {
  key: AiTaskParamKey;
  /** 标签（原版带冒号，如「新手机号:」，这里不含冒号，界面渲染时补） */
  label: string;
  placeholder: string;
}

export interface AiTaskKindDef {
  kind: AiTaskKind;
  /** 任务名：子类 _getTaskName() 的返回值，用于「{任务名} 配置」「开始{任务名}」 */
  taskName: string;
  /** 任务类型（TaskInfo.type / TaskFinishedEvent.type） */
  taskType: string;
  /** 每个账号开始时的「处理中」消息（各 Worker :45/:48 的 progressSignal 文案） */
  processingMessage: string;
  /** 额外输入框；无则 null（_addExtraConfig 未重写） */
  extraField: AiTaskExtraField | null;
}

/**
 * 每类任务固定的两条提示文案与额外输入框：
 */
export const AI_TASK_KINDS: Readonly<Record<AiTaskKind, AiTaskKindDef>> = {
  replace_phone: {
    kind: "replace_phone",
    taskName: "替换手机号",
    taskType: "ai_replace_phone",
    processingMessage: "正在替换手机号...",
    extraField: { key: "newPhone", label: "新手机号", placeholder: "请输入新手机号（可选，留空则移除手机）" },
  },
  replace_email: {
    kind: "replace_email",
    taskName: "替换辅助邮箱",
    taskType: "ai_replace_email",
    processingMessage: "正在替换辅助邮箱...",
    extraField: { key: "newEmail", label: "新辅助邮箱", placeholder: "请输入新辅助邮箱（可选，留空则移除）" },
  },
  modify_2sv: {
    kind: "modify_2sv",
    taskName: "修改2SV手机",
    taskType: "ai_modify_2sv",
    processingMessage: "正在修改 2SV 手机...",
    extraField: { key: "newPhone", label: "新 2SV 手机", placeholder: "请输入新的两步验证手机号" },
  },
  modify_auth: {
    kind: "modify_auth",
    taskName: "修改验证器",
    taskType: "ai_modify_auth",
    processingMessage: "正在修改身份验证器...",
    extraField: null,
  },
  kick_devices: {
    kind: "kick_devices",
    taskName: "踢出设备",
    taskType: "ai_kick_devices",
    processingMessage: "正在踢出设备...",
    extraField: null,
  },
  change_password: {
    kind: "change_password",
    taskName: "修改密码",
    taskType: "ai_change_password",
    processingMessage: "正在修改密码...",
    // 新密码由系统自动生成（用户只需勾账号），因此没有额外输入框
    extraField: null,
  },
};

export function isAiTaskKind(value: unknown): value is AiTaskKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AI_TASK_KINDS, value);
}

/** 全部 AI 任务类型（渲染层据此判断结束事件是否属于 AI 任务） */
export const AI_TASK_TYPES: readonly string[] = Object.values(AI_TASK_KINDS).map((d) => d.taskType);

/**
 * 状态筛选下拉，含遗留状态值，保留不清理。
 * value 为空串表示「全部」（不筛选）。
 */
export const AI_TASK_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "全部" },
  { value: "pending", label: "pending - 待处理" },
  { value: "link_ready", label: "link_ready - 链接就绪" },
  { value: "verified", label: "verified - 已验证" },
  { value: "subscribed", label: "subscribed - 已订阅" },
  { value: "ineligible", label: "ineligible - 不符合" },
  { value: "error", label: "error - 错误" },
];

/** 逐行状态字面量（各 Worker 的 progressSignal） */
export const AI_TASK_ITEM_STATUS = {
  processing: "处理中",
  success: "成功",
  failed: "失败",
  error: "错误",
} as const;

// ==================== 数据类型 ====================

/** 树的二级节点：一个窗口（name 视为 email） */
export interface AiTaskBrowserNode {
  /** 树内唯一键 */
  key: string;
  /** 窗口 ID；原始数据缺失或非法时为 null（无法执行任务） */
  profileId: number | null;
  /** 窗口名，即 email（:307） */
  name: string;
  /** 账号状态：匹配到数据库时取其 status，否则 "pending"（:310-312） */
  status: string;
  /** 是否匹配到数据库账号 */
  matched: boolean;
}

/** 树的一级节点：分组 */
export interface AiTaskGroupNode {
  key: string;
  groupId: number;
  groupName: string;
  browsers: AiTaskBrowserNode[];
}

export interface AiTaskLoadResult {
  groups: AiTaskGroupNode[];
  totalBrowsers: number;
 /** 加载失败原因（ 的 result['error']）；此时 groups 为空 */
  error: string | null;
}

/** start 的单个条目：界面只传 email 与窗口 ID，账号信息由后端按 email 从数据库重读 */
export interface AiTaskStartItem {
  email: string;
  profileId: number;
}

export type AiTaskParams = Partial<Record<AiTaskParamKey, string>>;

export interface AiTaskItemResult {
  email: string;
  profileId: number;
  status: string;
  message: string;
}

/** 任务返回值 */
export interface AiTaskRunResult {
  total: number;
  success_count: number;
  failed_count: number;
  results: AiTaskItemResult[];
}

// ==================== 通道 → 类型 ====================

export interface AiTasksInvokeMap {
  "abb/aitasks/load": { args: []; result: AiTaskLoadResult };
  "abb/aitasks/start": {
    args: [kind: AiTaskKind, items: AiTaskStartItem[], params: AiTaskParams, concurrency: number];
    result: TaskInfo;
  };
}
