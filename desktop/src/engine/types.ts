/**
 * Stagehand Google Engine - 类型定义（Node 重写）
 * 对标 core/stagehand_engine/types.py
 *
 * 由脚本从 Python 源自动生成。两处刻意设计：
 *   1. 枚举用字符串字面量联合，取值与 Python Enum.value 一致
 *   2. dataclass 字段一律**必需**（Python 的"有默认值"不等于 TS 的"可选"），
 *      构造默认值由 createXxx() 提供——这样读取结果时无需 undefined 判断
 */

/** 登录状态枚举 */
export type LoginState = "logged_in" | "logged_out" | "need_password" | "need_2fa" | "need_recovery" | "wrong_password" | "account_not_found" | "account_disabled" | "captcha_required" | "security_challenge" | "unknown";
export const LoginStateValues = {
  LOGGED_IN: "logged_in",
  LOGGED_OUT: "logged_out",
  NEED_PASSWORD: "need_password",
  NEED_2FA: "need_2fa",
  NEED_RECOVERY: "need_recovery",
  WRONG_PASSWORD: "wrong_password",
  ACCOUNT_NOT_FOUND: "account_not_found",
  ACCOUNT_DISABLED: "account_disabled",
  CAPTCHA_REQUIRED: "captcha_required",
  SECURITY_CHALLENGE: "security_challenge",
  UNKNOWN: "unknown",
} as const;

/** 操作状态枚举 */
export type OperationStatus = "success" | "failed" | "partial" | "blocked" | "timeout" | "unknown" | "subscribed" | "verified" | "link_ready" | "ineligible" | "error";
export const OperationStatusValues = {
  SUCCESS: "success",
  FAILED: "failed",
  PARTIAL: "partial",
  BLOCKED: "blocked",
  TIMEOUT: "timeout",
  UNKNOWN: "unknown",
  SUBSCRIBED: "subscribed",
  VERIFIED: "verified",
  LINK_READY: "link_ready",
  INELIGIBLE: "ineligible",
  ERROR: "error",
} as const;

/** 两步验证方法 */
export type TwoFactorMethod = "totp" | "sms" | "email" | "prompt" | "backup_code" | "security_key" | "unknown";
export const TwoFactorMethodValues = {
  TOTP: "totp",
  SMS: "sms",
  EMAIL: "email",
  PROMPT: "prompt",
  BACKUP_CODE: "backup_code",
  SECURITY_KEY: "security_key",
  UNKNOWN: "unknown",
} as const;

/** 操作结果 */
export interface ActionResult {
  success: boolean;
  message: string;
  error: string | null;
  selector: string | null;
  method: string | null;
  duration_ms: number;
}

/** 构造 ActionResult，默认值对齐 Python dataclass */
export function createActionResult(overrides: Partial<ActionResult> = {}): ActionResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    selector: null,
    method: null,
    duration_ms: 0,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ActionResult;
}

/** 操作结果基类 */
export interface BaseOperationResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
}

/** 构造 BaseOperationResult，默认值对齐 Python dataclass */
export function createBaseOperationResult(overrides: Partial<BaseOperationResult> = {}): BaseOperationResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as BaseOperationResult;
}

/** 提取结果 */
export interface ExtractResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number;
}

/** 构造 ExtractResult，默认值对齐 Python dataclass */
export function createExtractResult(overrides: Partial<ExtractResult> = {}): ExtractResult {
  const base: Record<string, unknown> = {
    success: false,
    data: null,
    error: null,
    duration_ms: 0,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ExtractResult;
}

/** 踢出设备操作结果 */
export interface KickDevicesResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  devices_found: number;
  devices_kicked: number;
  devices_failed: number;
  kicked_devices: string[];
  failed_devices: string[];
}

/** 构造 KickDevicesResult，默认值对齐 Python dataclass */
export function createKickDevicesResult(overrides: Partial<KickDevicesResult> = {}): KickDevicesResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    devices_found: 0,
    devices_kicked: 0,
    devices_failed: 0,
    kicked_devices: [],
    failed_devices: [],
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as KickDevicesResult;
}

/** 登录操作结果 */
export interface LoginResult {
  success: boolean;
  status: OperationStatus;
  login_state: LoginState;
  message: string;
  error: string;
  error_type: string | null;
  account_email: string | null;
  need_2fa: boolean;
  two_fa_method: string | null;
  challenge_type: string | null;
  challenge_hint: string | null;
  can_retry: boolean;
  retry_delay_seconds: number;
  page_type: string | null;
  matched_keywords: string[];
  duration_ms: number;
}

/** 构造 LoginResult，默认值对齐 Python dataclass */
export function createLoginResult(overrides: Partial<LoginResult> = {}): LoginResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: "",
    error_type: null,
    account_email: null,
    need_2fa: false,
    two_fa_method: null,
    challenge_type: null,
    challenge_hint: null,
    can_retry: false,
    retry_delay_seconds: 0,
    page_type: null,
    matched_keywords: [],
    duration_ms: 0,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as LoginResult;
}

/** 修改验证器操作结果 */
export interface ModifyAuthenticatorResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  authenticator_name: string | null;
  secret_key: string | null;
  qr_code_url: string | null;
  operation: string;
  verified: boolean;
}

/** 构造 ModifyAuthenticatorResult，默认值对齐 Python dataclass */
export function createModifyAuthenticatorResult(overrides: Partial<ModifyAuthenticatorResult> = {}): ModifyAuthenticatorResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    authenticator_name: null,
    secret_key: null,
    qr_code_url: null,
    operation: "",
    verified: false,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ModifyAuthenticatorResult;
}

/** 修改手机号操作结果 (2SV 或恢复手机) */
export interface ModifyPhoneResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  operation_type: string;
  old_phone: string | null;
  new_phone: string | null;
  verification_sent: boolean;
  verification_code_used: string | null;
}

/** 构造 ModifyPhoneResult，默认值对齐 Python dataclass */
export function createModifyPhoneResult(overrides: Partial<ModifyPhoneResult> = {}): ModifyPhoneResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    operation_type: "",
    old_phone: null,
    new_phone: null,
    verification_sent: false,
    verification_code_used: null,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ModifyPhoneResult;
}

/** 导航结果 */
export interface NavigationResult {
  success: boolean;
  url: string;
  final_url: string | null;
  error_message: string | null;
  duration_ms: number;
}

/** 构造 NavigationResult，默认值对齐 Python dataclass */
export function createNavigationResult(overrides: Partial<NavigationResult> = {}): NavigationResult {
  const base: Record<string, unknown> = {
    success: false,
    url: "",
    final_url: null,
    error_message: null,
    duration_ms: 0,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as NavigationResult;
}

/** 观察结果 */
export interface ObserveResult {
  success: boolean;
  actions: Record<string, unknown>[];
  error: string | null;
  duration_ms: number;
}

/** 构造 ObserveResult，默认值对齐 Python dataclass */
export function createObserveResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  const base: Record<string, unknown> = {
    success: false,
    actions: [],
    error: null,
    duration_ms: 0,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ObserveResult;
}

/** 替换辅助邮箱操作结果 */
export interface ReplaceEmailResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  old_email: string | null;
  new_email: string | null;
  verification_sent: boolean;
  verification_code_used: string | null;
}

/** 构造 ReplaceEmailResult，默认值对齐 Python dataclass */
export function createReplaceEmailResult(overrides: Partial<ReplaceEmailResult> = {}): ReplaceEmailResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    old_email: null,
    new_email: null,
    verification_sent: false,
    verification_code_used: null,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ReplaceEmailResult;
}

/** 修改手机号操作结果 (2SV 或恢复手机) */
export interface ReplacePhoneResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  operation_type: string;
  old_phone: string | null;
  new_phone: string | null;
  verification_sent: boolean;
  verification_code_used: string | null;
}

/** 构造 ReplacePhoneResult，默认值对齐 Python dataclass */
export function createReplacePhoneResult(overrides: Partial<ReplacePhoneResult> = {}): ReplacePhoneResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    operation_type: "",
    old_phone: null,
    new_phone: null,
    verification_sent: false,
    verification_code_used: null,
  };
  // 跳过 undefined：Partial 允许显式传 undefined，但不应覆盖默认值
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ReplacePhoneResult;
}

/**
 * 修改密码操作结果。
 * 刻意**不带新密码**：新密码由调用方（automation 层）生成并持有，操作本身只负责把它填进去；
 * 回传密码只会让它多出现在日志 / 事件载荷里。
 */
export interface ChangePasswordResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  operation: string;
  /** 是否在页面上确认到「已更改」 */
  verified: boolean;
}

export function createChangePasswordResult(overrides: Partial<ChangePasswordResult> = {}): ChangePasswordResult {
  const base: Record<string, unknown> = {
    success: false,
    message: "",
    error: null,
    error_type: null,
    duration_ms: 0,
    can_retry: false,
    operation: "change_password",
    verified: false,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) base[k] = v;
  }
  return base as unknown as ChangePasswordResult;
}

