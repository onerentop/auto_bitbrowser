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
 * 批量操作一律走「预检 → 确认 → 启动后台任务」两段式：
 *   - precheck：后端按同样的前置校验 / 候选筛选 / 确认文案生成提示，不启动任何东西
 *   - start：   后端重新做一遍同样的筛选（防止两次调用之间数据变化），然后启动后台任务
 */
import type { TaskInfo } from "../ipc.ts";
import type { ImportResultDto } from "./settings.ts";

/** 「删除选中」（只删账号、不删窗口）任务的 label；渲染层据此区分删除完成提示的两种文案（:1789-1792） */
export const DELETE_ACCOUNTS_ONLY_LABEL = "删除选中";

export const ACCOUNTS_INVOKE = {
 /** 账号列表 + 窗口名称映射（。:367） */
  accountsList: "abb/accounts/list",
 /** 页面默认选项（并发数，:298 的 get_login_concurrency） */
  accountsGetDefaults: "abb/accounts/getDefaults",
  /** 批量操作预检：返回拒绝原因或需要依次确认的文案 */
  accountsPrecheck: "abb/accounts/precheck",
  /** 启动批量操作（后台任务） */
  accountsStart: "abb/accounts/start",
 /** 为「绑定 / 重新绑定窗口」列出可选窗口（。:1543） */
  accountsBindCandidates: "abb/accounts/bindCandidates",
  /** 绑定账号到指定窗口（有任务在跑时抛 TASK_BUSY） */
  accountsBind: "abb/accounts/bind",
 /** 删除单个账号，不删窗口（。:1631；有任务在跑时抛 TASK_BUSY） */
  accountsDeleteOne: "abb/accounts/deleteOne",
  // ---------- 账号数据（从设置页迁来） ----------
  /** 按邮箱取账号原文（编辑弹窗用） */
  accountsGet: "abb/accounts/get",
  /** 添加账号（新增 status=pending） */
  accountsAdd: "abb/accounts/add",
  /** 编辑账号（不改状态） */
  accountsUpdate: "abb/accounts/update",
  /** 批量导入（后端重新解析文本，整批一个事务） */
  accountsImport: "abb/accounts/import",
  /** 导出选中：后端生成导出文本 */
  accountsExportText: "abb/accounts/exportText",
} as const;

// ==================== 数据类型 ====================

/**
 * 列表一行（字段名与 accounts 表列名一致）。
 * **只下发有 / 无与登录状态**，不下发密码 / 2FA 密钥 / 辅助邮箱原文（编辑时用 abb/accounts/get 单独取）。
 */
export interface AccountListRow {
  email: string;
  login_status: string | null;
  last_error: string | null;
  /** 未绑定时为空串 */
  browser_profile_id: string;
  /** 由 browser_profile_id 映射；ixBrowser 不可达或未找到时为空串 */
  window_name: string;
  /** 窗口所在分组；未绑定窗口 / 窗口不存在时为下面的伪分组 */
  group_id: number;
  group_name: string;
  has_password: boolean;
  has_recovery_email: boolean;
  has_secret: boolean;
  last_login_at: string | null;
  /** 与邮箱同名的窗口个数（窗口名去空白、不区分大小写；窗口列表取失败时为 0）；≥2 说明需要人工确认绑定 */
  same_name_windows: number;
  updated_at: string | null;
}

/** 伪分组：账号没有绑定窗口 */
export const UNBOUND_GROUP_ID = -1;
/** 伪分组：绑定的窗口在 ixBrowser 里找不到（或窗口列表取失败） */
export const MISSING_WINDOW_GROUP_ID = -2;

/** 分组标签的一项 */
export interface AccountGroupCount {
  groupId: number;
  groupName: string;
  count: number;
}

export interface AccountsListResult {
  rows: AccountListRow[];
  /** 真实分组按 ID 升序，伪分组（未绑定 / 窗口不存在）排最后；只列有账号的分组 */
  groups: AccountGroupCount[];
  /** 取窗口列表失败的原因；成功为 null */
  windowError: string | null;
}

export interface AccountsDefaults {
  /** 并发数默认值（ConfigManager.getLoginConcurrency） */
  loginConcurrency: number;
}

/**
 * 批量操作种类
 * 已按用户要求删除：OAuth（批量 / 单个 / 一键登录+OAuth）、检测 Pro、刷新家庭组、开启共享、检测 403、批量解锁 403
 */
export type AccountsAction =
 /** 行内 / 右键「登录」（。:801） */
  | "single_login"
  | "login"
  /** 删除选中（仅账号） */
  | "delete"
  /** 删除选中 + 窗口 */
  | "delete_with_windows"
 /** 右键「删除账号和窗口」（。:1649） */
  | "delete_one_with_window"
  /**
   * 账号健康巡检（本地新增）：只读访问 myaccount.google.com 判断
   * 每个账号在窗口里的会话状态，不提交密码或验证码，因此不产生新登录会话。
   */
  | "health_check";

export const ACCOUNTS_ACTIONS: readonly AccountsAction[] = [
  "single_login",
  "login",
  "delete",
  "delete_with_windows",
  "delete_one_with_window",
  "health_check",
];

/** 健康巡检任务的 type（与 ctx.tasks.start 的第一个参数一致，渲染层据此识别完成事件） */
export const HEALTH_CHECK_TASK_TYPE = "health_check";


/** 勾选的一行：邮箱 + 表格里显示的窗口 ID（ 的 (email, browser_id)） */
export interface SelectedRow {
  email: string;
  /** 未绑定为空串（"-" 也视为未绑定） */
  browserId: string;
}

/** 页面上的选项（「自动绑定代理」只服务 OAuth，已随 OAuth 删除） */
export interface AccountsRunOptions {
  /** 并发数 1-10 */
  concurrency: number;
}

export interface ConfirmStep {
  title: string;
  message: string;
}

/** 预检结果：拒绝（ 提示）或一串待确认的对话框 */
export type AccountsPrecheckResult =
  | { ok: false; level: "info" | "warning" | "error"; title: string; message: string }
  | {
      ok: true;
      /** 依次弹出的确认框；为空表示无需确认直接启动 */
      confirms: ConfirmStep[];
      /** 预检阶段应写入日志的行 */
      logs: string[];
      /** 将要处理的账号数 */
      total: number;
    };

export interface BindWindowOption {
  profileId: string;
  name: string;
  /** 窗口名与账号邮箱相同（去空白、不区分大小写）；这类选项排在最前 */
  sameName: boolean;
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

/**
 * 导入 / 添加账号后自动按窗口名绑定的结果（规则见 src/application/window-binding.ts）：
 * 窗口名（去空白、不区分大小写）= 邮箱，且恰好一个未被占用的同名窗口才绑定；同名多个不猜。
 */
export interface AutoBindSummary {
  /** 绑定成功的账号数 */
  bound: number;
  /** 有多个同名窗口、需要手动选择的账号 */
  ambiguous: Array<{ email: string; windowIds: string[] }>;
  /** 没找到同名（且未被占用）窗口的账号 */
  notFound: string[];
  /** 写库失败的账号 */
  failed: string[];
  /** 本来就已绑定、没动的账号数 */
  alreadyBound: number;
  /** 没执行自动绑定的原因（取窗口列表失败 / 有任务正在执行），可直接展示；执行了为 null */
  error: string | null;
}

/** 批量导入结果 + 自动绑定结果 */
export interface AccountsImportResult extends ImportResultDto {
  bind: AutoBindSummary;
}

/** 编辑弹窗 / 添加 / 编辑用的账号原文（只在编辑时按邮箱单独取，列表里不下发） */
export interface AccountDetail {
  email: string;
  password: string;
  recovery_email: string;
  secret_key: string;
}

/** 导出：后端生成文本（含原文，这是导出的用途）；count 为实际导出的账号数 */
export interface AccountsExportResult {
  text: string;
  count: number;
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
  "abb/accounts/deleteOne": { args: [email: string]; result: boolean };
  "abb/accounts/get": { args: [email: string]; result: AccountDetail };
  "abb/accounts/add": { args: [account: AccountDetail]; result: AutoBindSummary };
  "abb/accounts/update": { args: [account: AccountDetail]; result: boolean };
  "abb/accounts/import": { args: [text: string]; result: AccountsImportResult };
  "abb/accounts/exportText": { args: [emails: string[]]; result: AccountsExportResult };
}
