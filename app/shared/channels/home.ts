/**
 * 首页（ixBrowser 窗口管理） 的 IPC 通道与类型
 *
 * 命名 `abb/home/动作`。每新增一个通道：
 *   1. 在 HOME_INVOKE 里登记常量
 *   2. 在 HomeInvokeMap 里写参数元组与返回类型
 *   3. 在 app/host/handlers/home.ts 里实现
 * ipc.ts 会把这里的通道并入总表；类型检查保证三处一致。
 * 本文件是纯 TS，不依赖 electron。
 */
// 仅类型导入：ipc.ts 反向 import 本文件，type-only 不会形成运行时循环
import type { TaskInfo } from "../ipc.ts";

export const HOME_INVOKE = {
  /** 读取「创建参数配置」卡片的两个输入框 */
  homeGetConfig: "abb/home/getConfig",
  /** 写回两个输入框（改为失焦时写回） */
  homeSaveConfig: "abb/home/saveConfig",
  /** 目标分组下拉选项 */
  homeListGroups: "abb/home/listGroups",
  /** 平铺窗口列表 + 分组统计（不含 2FA 密钥） */
  homeListBrowsers: "abb/home/listBrowsers",
  /** 按窗口 ID 取当前 2FA 验证码（密钥只在后端，界面只拿验证码） */
  homeTfaCodes: "abb/home/tfaCodes",
  /** 批量打开选中窗口（后台任务；原版 :446 为 TODO 桩） */
  homeOpenBrowsers: "abb/home/openBrowsers",
  /** 批量删除选中窗口（后台任务；原版 :456 为 TODO 桩） */
  homeDeleteBrowsers: "abb/home/deleteBrowsers",
  /** 按模板窗口批量创建窗口（后台任务；原版 :427 为 TODO 桩） */
  homeCreateBrowsers: "abb/home/createBrowsers",
} as const;

// ==================== 数据类型 ====================

/** 「创建参数」三个字段，对应配置键 last_used_template_id / window_name_prefix / create_target_group_id */
export interface HomeConfig {
  templateId: string;
  namePrefix: string;
  /** 创建窗口的目标分组；null = 沿用模板窗口的分组 */
  groupId: number | null;
}

/** 写回时只传需要改的字段 */
export type HomeConfigPatch = Partial<HomeConfig>;

/** 目标分组下拉的一项：label 形如 `{title} (ID: {gid})` */
export interface HomeGroupOption {
  id: number;
  label: string;
}

export interface HomeGroupListResult {
  options: HomeGroupOption[];
  /** 获取失败时的原因（此时 options 只有「默认分组」） */
  error: string | null;
}

/** 平铺列表的一行（窗口） */
export interface HomeBrowserNode {
  /** 行键：有效且不重复的窗口 ID 为 `b:{id}`，否则 `b:{gid}:{序号}` */
  key: string;
  /** 窗口 ID；原始数据缺失或非法时为 null（无法打开 / 删除） */
  profileId: number | null;
  name: string;
  note: string;
  groupId: number;
  groupName: string;
  /** 最近打开时间（秒级时间戳）；从未打开为 null */
  lastOpenTime: number | null;
  /** 窗口是否配置了 2FA 密钥（密钥本身不下发） */
  hasTfa: boolean;
}

/** 分组筛选标签的一项：只列有窗口的分组 */
export interface HomeGroupCount {
  groupId: number;
  groupName: string;
  count: number;
}

export interface HomeBrowserList {
  browsers: HomeBrowserNode[];
  /** 按分组 ID 升序 */
  groups: HomeGroupCount[];
  totalBrowsers: number;
  /** 加载过程中的错误 */
  error: string | null;
}

/** 一次最多取多少个窗口的验证码 */
export const MAX_TFA_CODE_IDS = 1000;

/** 2FA 验证码：codes 只含能算出码的窗口；invalid 为密钥非法的窗口；其余视为没有密钥 */
export interface HomeTfaCodes {
  codes: Record<number, string>;
  invalid: number[];
  /** 本 30 秒周期结束的时间（毫秒时间戳），届时验证码会变 */
  periodEndsAt: number;
}

/** 打开 / 删除任务的返回值 */
export interface HomeBatchResult {
  total: number;
  success_count: number;
  failed_count: number;
  failed_ids: number[];
}

/** 任务类型（TaskInfo.type / TaskFinishedEvent.type） */
export const HOME_TASK_TYPES = {
  open: "home_open_browsers",
  delete: "home_delete_browsers",
  create: "home_create_browsers",
} as const;

/** 一次最多创建多少个窗口（防误操作；名字与分组都会真的落到 ixBrowser） */
export const MAX_CREATE_COUNT = 20;

/** 「根据模板创建窗口」的入参 */
export interface HomeCreateSpec {
  /** 模板窗口 ID（必填，正整数） */
  templateId: number;
  /** 创建个数，1..MAX_CREATE_COUNT */
  count: number;
  /** 名称前缀；空串表示用模板窗口的名字 */
  namePrefix: string;
  /** 目标分组；null / 省略表示沿用模板窗口的分组 */
  groupId?: number | null;
}

/** 创建结果：逐窗口的成败与最终名字 */
export interface HomeCreateResult {
  total: number;
  success_count: number;
  failed_count: number;
  created: Array<{ profile_id: number; name: string }>;
  failed_names: string[];
}

// ==================== 通道 → 类型 ====================

export interface HomeInvokeMap {
  "abb/home/getConfig": { args: []; result: HomeConfig };
  "abb/home/saveConfig": { args: [patch: HomeConfigPatch]; result: HomeConfig };
  "abb/home/listGroups": { args: []; result: HomeGroupListResult };
  "abb/home/listBrowsers": { args: []; result: HomeBrowserList };
  "abb/home/tfaCodes": { args: [profileIds: number[]]; result: HomeTfaCodes };
  "abb/home/openBrowsers": { args: [profileIds: number[]]; result: TaskInfo };
  "abb/home/deleteBrowsers": { args: [profileIds: number[]]; result: TaskInfo };
  "abb/home/createBrowsers": { args: [spec: HomeCreateSpec]; result: TaskInfo };
}
