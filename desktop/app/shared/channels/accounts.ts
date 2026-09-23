/**
 * 账号管理页 的 IPC 通道与类型
 *
 * 命名 `abb/accounts/动作`。每新增一个通道：
 *   1. 在 ACCOUNTS_INVOKE 里登记常量
 *   2. 在 AccountsInvokeMap 里写参数元组与返回类型
 *   3. 在 app/host/handlers/accounts.ts 里实现
 * ipc.ts 会把这里的通道并入总表；类型检查保证三处一致。
 * 本文件是纯 TS，不依赖 electron。
 *
 * 对标 gui/account_manager_interface.py（AccountManagerInterface）。
 * 批量操作一律走「预检 → 确认 → 启动后台任务」两段式：
 *   - precheck：后端按 Python 的前置校验 / 候选筛选 / 确认文案生成提示，不启动任何东西
 *   - start：   后端重新做一遍同样的筛选（防止两次调用之间数据变化），然后启动后台任务
 */
import type { TaskInfo } from "../ipc.ts";

/** 「删除选中」（只删账号、不删窗口）任务的 label；渲染层据此区分删除完成提示的两种文案（:1789-1792） */
export const DELETE_ACCOUNTS_ONLY_LABEL = "删除选中";

export const ACCOUNTS_INVOKE = {
  /** 账号列表 + 窗口名称映射（对标 _loadData，:367） */
  accountsList: "abb/accounts/list",
  /** 页面默认选项（并发数，对标 :298 的 get_login_concurrency） */
  accountsGetDefaults: "abb/accounts/getDefaults",
  /** 批量操作预检：返回拒绝原因或需要依次确认的文案 */
  accountsPrecheck: "abb/accounts/precheck",
  /** 启动批量操作（后台任务） */
  accountsStart: "abb/accounts/start",
  /** 为「绑定 / 重新绑定窗口」列出可选窗口（对标 _bindBrowser，:1543） */
  accountsBindCandidates: "abb/accounts/bindCandidates",
  /** 绑定账号到指定窗口（有任务在跑时抛 TASK_BUSY） */
  accountsBind: "abb/accounts/bind",
  /** 解绑窗口（对标 _unbindBrowser，:1600；有任务在跑时抛 TASK_BUSY） */
  accountsUnbind: "abb/accounts/unbind",
  /** 删除单个账号，不删窗口（对标 _deleteSingleAccount，:1631；有任务在跑时抛 TASK_BUSY） */
  accountsDeleteOne: "abb/accounts/deleteOne",
} as const;

// ==================== 数据类型 ====================

/** 表格一行（字段名与 accounts 表列名一致） */
export interface AccountListRow {
  email: string;
  login_status: string | null;
  last_error: string | null;
  is_pro: string | null;
  /** 未绑定时为空串 */
  browser_profile_id: string;
  /** 由 browser_profile_id 映射；ixBrowser 不可达或未找到时为空串 */
  window_name: string;
  sub2api_status: string | null;
  unlock_status: string | null;
  updated_at: string | null;
}

export interface AccountsListResult {
  rows: AccountListRow[];
  /** 取窗口列表失败的原因（对标 :385 的「获取窗口列表失败」日志）；成功为 null */
  windowError: string | null;
}

export interface AccountsDefaults {
  /** 并发数默认值（ConfigManager.getLoginConcurrency） */
  loginConcurrency: number;
}

/** 批量操作种类 */
export type AccountsAction =
  /** 行内 / 右键「登录」（对标 _singleLogin，:801） */
  | "single_login"
  /** 行内 / 右键「OAuth」（对标 _singleOAuth，:815） */
  | "single_oauth"
  | "login"
  | "oauth"
  | "login_and_oauth"
  | "batch_bind"
  | "detect_pro"
  | "refresh_membership_info"
  | "enable_family_sharing"
  | "detect_403"
  | "unlock_403"
  /** 删除选中（仅账号） */
  | "delete"
  /** 删除选中 + 窗口 */
  | "delete_with_windows"
  /** 右键「删除账号和窗口」（对标 _deleteAccountWithWindow，:1649） */
  | "delete_one_with_window";

export const ACCOUNTS_ACTIONS: readonly AccountsAction[] = [
  "single_login",
  "single_oauth",
  "login",
  "oauth",
  "login_and_oauth",
  "batch_bind",
  "detect_pro",
  "refresh_membership_info",
  "enable_family_sharing",
  "detect_403",
  "unlock_403",
  "delete",
  "delete_with_windows",
  "delete_one_with_window",
];

/** 勾选的一行：邮箱 + 表格里显示的窗口 ID（对标 _getSelectedRows 的 (email, browser_id)） */
export interface SelectedRow {
  email: string;
  /** 未绑定为空串（"-" 也视为未绑定） */
  browserId: string;
}

/** 页面上的选项 */
export interface AccountsRunOptions {
  /** 并发数 1-10 */
  concurrency: number;
  /** 自动绑定代理 */
  autoBindProxy: boolean;
}

export interface ConfirmStep {
  title: string;
  message: string;
}

/** 预检结果：拒绝（对标 InfoBar 提示）或一串待确认的对话框（对标 MessageBox） */
export type AccountsPrecheckResult =
  | { ok: false; level: "info" | "warning" | "error"; title: string; message: string }
  | {
      ok: true;
      /** 依次弹出的确认框；为空表示无需确认直接启动 */
      confirms: ConfirmStep[];
      /** 预检阶段应写入日志的行（Python 在界面日志区打印的内容） */
      logs: string[];
      /** 将要处理的账号数 */
      total: number;
    };

export interface BindWindowOption {
  profileId: string;
  name: string;
}

export interface AccountsBindCandidates {
  /** 账号当前绑定的窗口 ID（未绑定为空串） */
  currentBrowserId: string;
  /** ixBrowser 返回的窗口总数 */
  windowCount: number;
  /** 未被**其它**账号绑定的窗口 */
  available: BindWindowOption[];
}

export interface AccountsBindResult {
  email: string;
  browserId: string;
  /** 绑定前的窗口 ID（空串表示原先未绑定） */
  previousBrowserId: string;
}

export interface AccountsUnbindResult {
  email: string;
  /** 被解绑的窗口 ID；原本就未绑定时为空串 */
  browserId: string;
}

// ==================== 通道 → 类型 ====================

export interface AccountsInvokeMap {
  "abb/accounts/list": { args: []; result: AccountsListResult };
  "abb/accounts/getDefaults": { args: []; result: AccountsDefaults };
  "abb/accounts/precheck": { args: [action: AccountsAction, rows: SelectedRow[]]; result: AccountsPrecheckResult };
  "abb/accounts/start": {
    args: [action: AccountsAction, rows: SelectedRow[], options: AccountsRunOptions];
    result: TaskInfo;
  };
  "abb/accounts/bindCandidates": { args: [email: string]; result: AccountsBindCandidates };
  "abb/accounts/bind": { args: [email: string, browserId: string]; result: AccountsBindResult };
  "abb/accounts/unbind": { args: [email: string]; result: AccountsUnbindResult };
  "abb/accounts/deleteOne": { args: [email: string]; result: boolean };
}
