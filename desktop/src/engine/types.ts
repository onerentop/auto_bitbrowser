/**
 * Stagehand Google Engine - 类型定义（Node 重写）
 * 对标 core/stagehand_engine/types.py
 *
 * 由脚本从 Python 源自动生成。两处刻意设计：
 *   1. 枚举用字符串字面量联合，取值与 Python Enum.value 一致
 *   2. dataclass 字段一律**必需**（Python 的"有默认值"不等于 TS 的"可选"），
 *      构造默认值由 createXxx() 提供——这样读取结果时无需 undefined 判断
 */

/** 家庭组角色 */
export type FamilyRole = "manager" | "member" | "none";
export const FamilyRoleValues = {
  MANAGER: "manager",
  MEMBER: "member",
  NONE: "none",
} as const;

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

/** Pro 订阅状态 */
export type ProStatus = "active" | "expired" | "free" | "trial" | "unknown";
export const ProStatusValues = {
  ACTIVE: "active",
  EXPIRED: "expired",
  FREE: "free",
  TRIAL: "trial",
  UNKNOWN: "unknown",
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    selector: overrides.selector ?? null,
    method: overrides.method ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    ...overrides,
  } as ActionResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    ...overrides,
  } as BaseOperationResult;
}

/** 开启家庭共享操作结果 */
export interface EnableSharingResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  was_already_enabled: boolean;
  sharing_enabled: boolean;
  family_created: boolean;
  member_count: number;
}

/** 构造 EnableSharingResult，默认值对齐 Python dataclass */
export function createEnableSharingResult(overrides: Partial<EnableSharingResult> = {}): EnableSharingResult {
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    was_already_enabled: overrides.was_already_enabled ?? false,
    sharing_enabled: overrides.sharing_enabled ?? false,
    family_created: overrides.family_created ?? false,
    member_count: overrides.member_count ?? 0,
    ...overrides,
  } as EnableSharingResult;
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
  return {
    success: overrides.success ?? false,
    data: overrides.data ?? null,
    error: overrides.error ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    ...overrides,
  } as ExtractResult;
}

/** 家庭组成员 */
export interface FamilyMember {
  email: string;
  name: string | null;
  role: FamilyRole;
  avatar_url: string | null;
}

/** 构造 FamilyMember，默认值对齐 Python dataclass */
export function createFamilyMember(overrides: Partial<FamilyMember> = {}): FamilyMember {
  return {
    email: overrides.email ?? "",
    name: overrides.name ?? null,
    role: overrides.role as FamilyRole,
    avatar_url: overrides.avatar_url ?? null,
    ...overrides,
  } as FamilyMember;
}

/** 家庭组状态检测结果 */
export interface FamilyStatusResult {
  has_family: boolean;
  role: FamilyRole;
  is_manager: boolean;
  member_count: number;
  members: FamilyMember[];
  sharing_enabled: boolean;
  can_share_subscription: boolean;
  family_name: string | null;
}

/** 构造 FamilyStatusResult，默认值对齐 Python dataclass */
export function createFamilyStatusResult(overrides: Partial<FamilyStatusResult> = {}): FamilyStatusResult {
  return {
    has_family: overrides.has_family ?? false,
    role: overrides.role as FamilyRole,
    is_manager: overrides.is_manager ?? false,
    member_count: overrides.member_count ?? 0,
    members: overrides.members ?? [],
    sharing_enabled: overrides.sharing_enabled ?? false,
    can_share_subscription: overrides.can_share_subscription ?? false,
    family_name: overrides.family_name ?? null,
    ...overrides,
  } as FamilyStatusResult;
}

/** 加入家庭组操作结果 */
export interface JoinFamilyResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  joined_as: FamilyRole;
  family_manager_email: string | null;
  inviter_email: string | null;
  member_count_after: number;
  already_in_family: boolean;
  invite_sent: boolean;
  invite_accepted: boolean;
}

/** 构造 JoinFamilyResult，默认值对齐 Python dataclass */
export function createJoinFamilyResult(overrides: Partial<JoinFamilyResult> = {}): JoinFamilyResult {
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    joined_as: overrides.joined_as as FamilyRole,
    family_manager_email: overrides.family_manager_email ?? null,
    inviter_email: overrides.inviter_email ?? null,
    member_count_after: overrides.member_count_after ?? 0,
    already_in_family: overrides.already_in_family ?? false,
    invite_sent: overrides.invite_sent ?? false,
    invite_accepted: overrides.invite_accepted ?? false,
    ...overrides,
  } as JoinFamilyResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    devices_found: overrides.devices_found ?? 0,
    devices_kicked: overrides.devices_kicked ?? 0,
    devices_failed: overrides.devices_failed ?? 0,
    kicked_devices: overrides.kicked_devices ?? [],
    failed_devices: overrides.failed_devices ?? [],
    ...overrides,
  } as KickDevicesResult;
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
  return {
    success: overrides.success ?? false,
    status: overrides.status as OperationStatus,
    login_state: overrides.login_state as LoginState,
    message: overrides.message ?? "",
    error: overrides.error ?? "",
    error_type: overrides.error_type ?? null,
    account_email: overrides.account_email ?? null,
    need_2fa: overrides.need_2fa ?? false,
    two_fa_method: overrides.two_fa_method ?? null,
    challenge_type: overrides.challenge_type ?? null,
    challenge_hint: overrides.challenge_hint ?? null,
    can_retry: overrides.can_retry ?? false,
    retry_delay_seconds: overrides.retry_delay_seconds ?? 0,
    page_type: overrides.page_type ?? null,
    matched_keywords: overrides.matched_keywords ?? [],
    duration_ms: overrides.duration_ms ?? 0,
    ...overrides,
  } as LoginResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    authenticator_name: overrides.authenticator_name ?? null,
    secret_key: overrides.secret_key ?? null,
    qr_code_url: overrides.qr_code_url ?? null,
    operation: overrides.operation ?? "",
    verified: overrides.verified ?? false,
    ...overrides,
  } as ModifyAuthenticatorResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    operation_type: overrides.operation_type ?? "",
    old_phone: overrides.old_phone ?? null,
    new_phone: overrides.new_phone ?? null,
    verification_sent: overrides.verification_sent ?? false,
    verification_code_used: overrides.verification_code_used ?? null,
    ...overrides,
  } as ModifyPhoneResult;
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
  return {
    success: overrides.success ?? false,
    url: overrides.url ?? "",
    final_url: overrides.final_url ?? null,
    error_message: overrides.error_message ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    ...overrides,
  } as NavigationResult;
}

/** OAuth 授权操作结果 */
export interface OAuthResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  service_name: string;
  service: string;
  authorized: boolean;
  redirect_url: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_in: number | null;
  oauth_email: string | null;
  account_id: string | null;
}

/** 构造 OAuthResult，默认值对齐 Python dataclass */
export function createOAuthResult(overrides: Partial<OAuthResult> = {}): OAuthResult {
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    service_name: overrides.service_name ?? "",
    service: overrides.service ?? "",
    authorized: overrides.authorized ?? false,
    redirect_url: overrides.redirect_url ?? null,
    access_token: overrides.access_token ?? null,
    refresh_token: overrides.refresh_token ?? null,
    expires_in: overrides.expires_in ?? null,
    oauth_email: overrides.oauth_email ?? null,
    account_id: overrides.account_id ?? null,
    ...overrides,
  } as OAuthResult;
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
  return {
    success: overrides.success ?? false,
    actions: overrides.actions ?? [],
    error: overrides.error ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    ...overrides,
  } as ObserveResult;
}

/** Pro 状态检测结果 */
export interface ProStatusResult {
  status: ProStatus;
  is_pro: boolean;
  is_family_member: boolean;
  family_manager_email: string | null;
  plan_name: string | null;
  storage_used: string | null;
  storage_total: string | null;
  expiry_date: string | null;
  confidence: number;
  method_used: string;
  raw_keywords: string[];
}

/** 构造 ProStatusResult，默认值对齐 Python dataclass */
export function createProStatusResult(overrides: Partial<ProStatusResult> = {}): ProStatusResult {
  return {
    status: overrides.status as ProStatus,
    is_pro: overrides.is_pro ?? false,
    is_family_member: overrides.is_family_member ?? false,
    family_manager_email: overrides.family_manager_email ?? null,
    plan_name: overrides.plan_name ?? null,
    storage_used: overrides.storage_used ?? null,
    storage_total: overrides.storage_total ?? null,
    expiry_date: overrides.expiry_date ?? null,
    confidence: overrides.confidence ?? 0,
    method_used: overrides.method_used ?? "",
    raw_keywords: overrides.raw_keywords ?? [],
    ...overrides,
  } as ProStatusResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    old_email: overrides.old_email ?? null,
    new_email: overrides.new_email ?? null,
    verification_sent: overrides.verification_sent ?? false,
    verification_code_used: overrides.verification_code_used ?? null,
    ...overrides,
  } as ReplaceEmailResult;
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
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    operation_type: overrides.operation_type ?? "",
    old_phone: overrides.old_phone ?? null,
    new_phone: overrides.new_phone ?? null,
    verification_sent: overrides.verification_sent ?? false,
    verification_code_used: overrides.verification_code_used ?? null,
    ...overrides,
  } as ReplacePhoneResult;
}

/** 解锁 403 操作结果 */
export interface UnlockResult {
  success: boolean;
  message: string;
  error: string | null;
  error_type: string | null;
  duration_ms: number;
  can_retry: boolean;
  was_locked: boolean;
  unlocked: boolean;
  verification_url: string | null;
  phone_used: string | null;
  sms_code_used: string | null;
  needs_manual: boolean;
  lock_reason: string | null;
}

/** 构造 UnlockResult，默认值对齐 Python dataclass */
export function createUnlockResult(overrides: Partial<UnlockResult> = {}): UnlockResult {
  return {
    success: overrides.success ?? false,
    message: overrides.message ?? "",
    error: overrides.error ?? null,
    error_type: overrides.error_type ?? null,
    duration_ms: overrides.duration_ms ?? 0,
    can_retry: overrides.can_retry ?? false,
    was_locked: overrides.was_locked ?? false,
    unlocked: overrides.unlocked ?? false,
    verification_url: overrides.verification_url ?? null,
    phone_used: overrides.phone_used ?? null,
    sms_code_used: overrides.sms_code_used ?? null,
    needs_manual: overrides.needs_manual ?? false,
    lock_reason: overrides.lock_reason ?? null,
    ...overrides,
  } as UnlockResult;
}

