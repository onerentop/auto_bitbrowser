/**
 * ixBrowser Local API — 类型定义
 *
 * 规格来源：ixBrowser 本地服务的实际响应（已逐条核对）
 * 关键事实：
 *   - 全部接口都是 POST，包括"查询列表"
 *   - 无任何认证（无 token / header / 签名）
 *   - 统一响应信封 { error: {code, message, time}, data: ... }
 */

/** 默认服务地址 */
export const IX_DEFAULT_HOST = "127.0.0.1";
export const IX_DEFAULT_PORT = 53200;
/** 默认超时 20s，可配置但默认值不变 */
export const IX_DEFAULT_TIMEOUT_MS = 20_000;

/** 成功码 */
export const IX_CODE_SUCCESS = 0;
/** 客户端侧构造的意外错误码（非服务端返回） */
export const IX_CODE_UNEXPECTED = 1;
/** 实测：窗口不存在 */
export const IX_CODE_PROFILE_NOT_FOUND = 2007;

/** 响应信封 */
export interface IxEnvelope<T = unknown> {
  error?: { code?: number; message?: string; time?: number };
  data?: T;
}

/**
 * 窗口对象。
 * 类型陷阱（实测）：proxy_port 是字符串；tag_id/tag_name 空值是空串而非 null。
 */
export interface IxProfile {
  profile_id: number;
  name: string;
  note: string;
  site_url: string;
  color: string;
  username: string;
  password: string;
  tfa_secret: string;
  last_open_time: number;
  group_id: number;
  group_name: string;
  tag_id: number | string;
  tag_name: string;
  proxy_mode: number;
  proxy_id: number;
  proxy_type: string;
  proxy_ip: string;
  /** 注意是字符串 */
  proxy_port: string;
  real_ip: string;
  cache_path: string;
}

/** profile-list 的原始返回 */
export interface IxProfileListData {
  total: number;
  data: IxProfile[];
}

/** profile-open 的返回。字段名由消费代码反推，未实测（调用会真的拉起浏览器） */
export interface IxOpenResult {
  /** CDP WebSocket 端点，形如 ws://127.0.0.1:<port>/devtools/browser/<uuid> */
  ws: string;
  /** 127.0.0.1:<port> */
  debugging_address: string;
  /** chromedriver 可执行文件绝对路径 */
  webdriver: string;
  pid: number;
  profile_id: number;
}

/** 代理配置。本项目只用到前 5 个字段，且刻意不设置 proxy_mode（保留既有行为） */
export interface IxProxyConfig {
  proxy_type?: "direct" | "http" | "https" | "socks5" | "ssh";
  proxy_ip?: string;
  proxy_port?: string | number;
  proxy_user?: string;
  proxy_password?: string;
  /** 1=流量包 2=自定义 3=已购 4=URL提取 */
  proxy_mode?: number;
  proxy_id?: number;
  [key: string]: unknown;
}

/** 窗口列表查询参数 */
export interface IxProfileListQuery {
  page?: number;
  limit?: number;
  /** 传了它就是按 ID 精确查，page/limit 会被服务端忽略 */
  profileId?: number;
  groupId?: number;
  tagId?: number;
  /** 注意：发给服务端的键名是 name，不是 keyword */
  keyword?: string;
}

/** 打开窗口的可选参数 */
export interface IxOpenOptions {
  loadExtensions?: boolean;
  loadProfileInfoPage?: boolean;
  cookiesBackup?: boolean;
  /** 仅当非 null/undefined 才发送——传 null 会导致服务端 cookie 加载失败 */
  cookie?: string;
  startupArgs?: string[];
  disableExtensionWelcomePage?: boolean;
}
