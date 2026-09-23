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
  /** 读取「创建参数配置」卡片的两个输入框（对标 home_interface.py:468 _loadConfigToUI） */
  homeGetConfig: "abb/home/getConfig",
  /** 写回两个输入框（对标 home_interface.py:481 saveConfig；这里改为失焦时写回） */
  homeSaveConfig: "abb/home/saveConfig",
  /** 目标分组下拉选项（对标 home_interface.py:227 refreshGroupList） */
  homeListGroups: "abb/home/listGroups",
  /** 分组 + 窗口两级树（对标 home_interface.py:34 BrowserLoadWorker + :295 _populateBrowserTree） */
  homeListBrowsers: "abb/home/listBrowsers",
  /** 批量打开选中窗口（后台任务；原版 :446 为 TODO 桩） */
  homeOpenBrowsers: "abb/home/openBrowsers",
  /** 批量删除选中窗口（后台任务；原版 :456 为 TODO 桩） */
  homeDeleteBrowsers: "abb/home/deleteBrowsers",
} as const;

// ==================== 数据类型 ====================

/** 「创建参数配置」两个输入框，对应配置键 last_used_template_id / window_name_prefix */
export interface HomeConfig {
  templateId: string;
  namePrefix: string;
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

/** 窗口树的二级节点 */
export interface HomeBrowserNode {
  /** 树内唯一键 */
  key: string;
  /** 窗口 ID；原始数据缺失或非法时为 null（无法打开 / 删除） */
  profileId: number | null;
  name: string;
  /** 2FA 验证码：与原版一致恒为空（home_interface.py:355） */
  tfaCode: string;
  note: string;
}

/** 窗口树的一级节点（分组） */
export interface HomeGroupNode {
  key: string;
  groupId: number;
  groupName: string;
  browsers: HomeBrowserNode[];
}

export interface HomeBrowserTree {
  groups: HomeGroupNode[];
  totalBrowsers: number;
  /** 加载过程中的错误（对标 BrowserLoadWorker 的 result['error']） */
  error: string | null;
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
} as const;

// ==================== 通道 → 类型 ====================

export interface HomeInvokeMap {
  "abb/home/getConfig": { args: []; result: HomeConfig };
  "abb/home/saveConfig": { args: [patch: HomeConfigPatch]; result: HomeConfig };
  "abb/home/listGroups": { args: []; result: HomeGroupListResult };
  "abb/home/listBrowsers": { args: []; result: HomeBrowserTree };
  "abb/home/openBrowsers": { args: [profileIds: number[]]; result: TaskInfo };
  "abb/home/deleteBrowsers": { args: [profileIds: number[]]; result: TaskInfo };
}
