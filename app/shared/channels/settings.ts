/**
 * 设置页（配置 / 代理） 的 IPC 通道与类型（账号数据已迁到账号管理页，见 channels/accounts.ts）
 *
 * 命名 `abb/settings/动作`。每新增一个通道：
 *   1. 在 SETTINGS_INVOKE 里登记常量
 *   2. 在 SettingsInvokeMap 里写参数元组与返回类型
 *   3. 在 app/host/handlers/settings.ts 里实现
 * ipc.ts 会把这里的通道并入总表；类型检查保证三处一致。
 * 本文件是纯 TS，不依赖 electron。
 *
 * 常量键统一带 settings 前缀：IPC.invoke 是各领域常量展开合并的，
 * 键名重复会静默覆盖，前缀避免与「账号管理」「首页」的通道键撞名。
 */

export const SETTINGS_INVOKE = {
  // ---------- 配置 ----------
 /** 读取设置快照 */
  settingsLoad: "abb/settings/load",
 /** 保存设置快照，只落盘一次 */
  settingsSave: "abb/settings/save",
 /** 立即写入 data_dir */
  settingsSetDataDir: "abb/settings/setDataDir",
 /** 测试 AI 提供商连接 */
  settingsTestAi: "abb/settings/testAi",
  /** 只读主题（启动时 theme-init 用）：只返回 { theme }，不把密钥带到渲染层 */
  settingsGetTheme: "abb/settings/getTheme",
  // ---------- 代理 ----------
  settingsProxiesList: "abb/settings/proxiesList",
  settingsProxiesAdd: "abb/settings/proxiesAdd",
  settingsProxiesUpdate: "abb/settings/proxiesUpdate",
  settingsProxiesDelete: "abb/settings/proxiesDelete",
  settingsProxiesImport: "abb/settings/proxiesImport",
  settingsProxiesBindings: "abb/settings/proxiesBindings",
  settingsProxiesUnbind: "abb/settings/proxiesUnbind",
  /** 连通性检测：经代理出网并回读出站 IP */
  settingsProxiesCheck: "abb/settings/proxiesCheck",
} as const;

// ==================== 配置 ====================

export type AiProviderName = "gemini" | "anthropic";
export const AI_PROVIDERS: readonly AiProviderName[] = ["gemini", "anthropic"];

export type SettingsThemeValue = "auto" | "light" | "dark";
export const SETTINGS_THEMES: readonly SettingsThemeValue[] = ["auto", "light", "dark"];

/** 设置快照 */
export interface SettingsSnapshotDto {
  ai_default_provider: string;
  gemini_api_key: string;
  gemini_base_url: string;
  gemini_model: string;
  anthropic_api_key: string;
  anthropic_base_url: string;
  anthropic_model: string;
  ai_max_steps: number;
  gmail_imap_email: string;
  gmail_imap_password: string;
  timeout_page_load: number;
  timeout_status_check: number;
  timeout_iframe_wait: number;
  delay_after_login: number;
  delay_after_offer: number;
  delay_after_save: number;
  proxy_max_windows_per_ip: number;
  default_thread_count: number;
  theme: string;
  data_dir: string;
  data_separator: string;
}

export type SettingsNumberField =
  | "ai_max_steps"
  | "timeout_page_load"
  | "timeout_status_check"
  | "timeout_iframe_wait"
  | "delay_after_login"
  | "delay_after_offer"
  | "delay_after_save"
  | "proxy_max_windows_per_ip"
  | "default_thread_count";

/** 数值字段的 [最小, 最大, 默认] */
export const SETTINGS_NUMBER_RANGES: Readonly<Record<SettingsNumberField, readonly [number, number, number]>> = {
  ai_max_steps: [5, 50, 25], // :264-266
  timeout_page_load: [10, 120, 30], // :320-322
  timeout_status_check: [5, 60, 20], // :325-327
  timeout_iframe_wait: [5, 60, 15], // :330-332
  delay_after_login: [1, 30, 3], // :344-346
  delay_after_offer: [1, 30, 8], // :349-351
  delay_after_save: [1, 60, 18], // :354-356
  proxy_max_windows_per_ip: [1, 100, 3], // :368-370
  default_thread_count: [1, 20, 3], // :387-389
};

/**
 * 把数值字段夹紧到 SpinBox 范围内。
 * 静默夹紧：config.json 里的越界值载入界面后变成边界值，
 * 保存时写回的是夹紧后的值（否则后端校验会拒绝整份配置）。
 */
export function clampSettingsNumber(field: SettingsNumberField, value: number): number {
  const [min, max] = SETTINGS_NUMBER_RANGES[field];
  return Math.min(max, Math.max(min, value));
}

/** 对快照里的全部数值字段做 clampSettingsNumber，其余字段原样返回 */
export function clampSettingsNumbers<T extends Record<SettingsNumberField, number>>(snapshot: T): T {
  const out = { ...snapshot };
  for (const key of Object.keys(SETTINGS_NUMBER_RANGES) as SettingsNumberField[]) {
    (out as Record<SettingsNumberField, number>)[key] = clampSettingsNumber(key, snapshot[key]);
  }
  return out;
}

/** 测试连接的界面输入（原样，未回退） */
export interface TestAiInput {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** 测试连接结果（bool, str, dict） */
export interface TestAiResultDto {
  success: boolean;
  message: string;
 /** true = 解析后仍无 API Key，未发请求（ 的 warning 分支） */
  missingKey: boolean;
  details: {
    provider?: string;
    model?: string;
    response_time_ms?: number;
    response_preview?: string;
    error?: string;
  };
}

// ==================== 代理 ====================

export type ProxyTypeName = "socks5" | "http" | "https";
export const PROXY_TYPES: readonly ProxyTypeName[] = ["socks5", "http", "https"];

/** 代理编辑输入 */
export interface ProxyInputDto {
  proxy_type: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

/** 代理列表的一行：DataStore 的代理 + 使用统计 */
export interface ProxyListItemDto extends ProxyInputDto {
  /** 列表下标（编辑 / 删除按下标） */
  index: number;
  /** host:port（写操作时用于核对下标没有漂移） */
  key: string;
  used_count: number;
  max_count: number;
  is_full: boolean;
  /** 使用统计里的 proxy_id，没有匹配统计时为 null */
  proxy_id: number | null;
  /** 最近一次连通性检测（本地时间串）；从未检测为 null */
  last_check_at: string | null;
  /** true=可达 / false=不可达 / null=未检测 */
  last_check_ok: boolean | null;
  /** 不可达原因 */
  last_check_error: string | null;
  /** 经该代理出网的 IP */
  outbound_ip: string | null;
}

/** 一次连通性检测的结果（按 host:port 与列表行对应） */
export interface ProxyCheckResultDto {
  index: number;
  key: string;
  ok: boolean;
  outbound_ip: string | null;
  error: string | null;
}

/** 写操作定位一条代理：下标 + 期望的 host:port */
export interface ProxyRefDto {
  index: number;
  key: string;
}

/** 代理绑定的窗口（proxy_window_bindings 一行） */
export interface ProxyBindingDto {
  id: number | null;
  proxy_id: number | null;
  browser_id: string;
  email: string | null;
  bound_at: string | null;
}

// ==================== 批量导入 ====================

/** 批量导入结果（代理页与账号管理页共用） */
export interface ImportResultDto {
  success_count: number;
  fail_count: number;
}

export interface SettingsInvokeMap {
  "abb/settings/load": { args: []; result: SettingsSnapshotDto };
  "abb/settings/save": { args: [snapshot: SettingsSnapshotDto]; result: SettingsSnapshotDto };
  "abb/settings/setDataDir": { args: [path: string]; result: string };
  "abb/settings/testAi": { args: [input: TestAiInput]; result: TestAiResultDto };
  "abb/settings/getTheme": { args: []; result: { theme: string } };
  "abb/settings/proxiesList": { args: []; result: ProxyListItemDto[] };
  "abb/settings/proxiesAdd": { args: [proxy: ProxyInputDto]; result: boolean };
  "abb/settings/proxiesUpdate": { args: [ref: ProxyRefDto, proxy: ProxyInputDto]; result: boolean };
  "abb/settings/proxiesDelete": { args: [refs: ProxyRefDto[]]; result: number };
  "abb/settings/proxiesImport": { args: [text: string]; result: ImportResultDto };
  "abb/settings/proxiesBindings": { args: [proxyId: number]; result: ProxyBindingDto[] };
  "abb/settings/proxiesUnbind": { args: [browserId: string]; result: boolean };
  "abb/settings/proxiesCheck": { args: [refs: ProxyRefDto[]]; result: ProxyCheckResultDto[] };
}
