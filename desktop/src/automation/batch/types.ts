/**
 * 批量账号处理器 - 结果类型（Node 重写）
 * 对标 automation/batch_account_processor.py L95-226
 *
 * 移植说明：
 *   - Python 的 dataclass → TS 接口 + `createXxx()` 工厂（字段全必需，
 *     默认值由工厂提供，覆盖时跳过 undefined），与 engine/types.ts 的既有约定一致
 *   - Python 的 @property（success_rate / duration_seconds）→ 独立函数
 *     （TS 的 getter 无法挂在纯接口上）
 *   - Python 的实例方法（add_success / to_dict / calculate_family_slots）→ 独立函数，
 *     直接就地修改传入对象，与 Python 的副作用语义一致
 *   - 时间字段：Python 用 datetime，TS 用毫秒时间戳（number），null 表示未设置
 */

// ==================== BatchResult ====================

/** 单条处理结果（Python 侧是无类型的 dict） */
export interface BatchResultItem {
  email: string;
  status: "success" | "failed" | "skipped";
  data?: Record<string, unknown>;
  error?: string;
  error_type?: string | null;
  reason?: string;
}

/** 批量处理结果 —— 对标 BatchResult dataclass */
export interface BatchResult {
  total: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  results: BatchResultItem[];
  /** 毫秒时间戳；Python 侧是 datetime，None → null */
  start_time: number | null;
  end_time: number | null;
}

export function createBatchResult(
  overrides: Partial<BatchResult> & { total: number },
): BatchResult {
  const base: BatchResult = {
    total: overrides.total,
    success_count: 0,
    failed_count: 0,
    skipped_count: 0,
    results: [],
    start_time: null,
    end_time: null,
  };
  return applyOverrides(base, overrides);
}

/**
 * 成功率 —— 对标 BatchResult.success_rate
 * 注意分母是 success+failed，**不含 skipped**（照搬 Python）。
 */
export function batchSuccessRate(r: BatchResult): number {
  const processed = r.success_count + r.failed_count;
  return processed > 0 ? r.success_count / processed : 0;
}

/** 执行时长（秒） —— 对标 BatchResult.duration_seconds */
export function batchDurationSeconds(r: BatchResult): number {
  if (r.start_time !== null && r.end_time !== null) {
    return (r.end_time - r.start_time) / 1000;
  }
  return 0;
}

/** 添加成功结果 —— 对标 add_success() */
export function addSuccess(r: BatchResult, email: string, data?: Record<string, unknown>): void {
  r.success_count += 1;
  r.results.push({ email, status: "success", data: data ?? {} });
}

/** 添加失败结果 —— 对标 add_failed() */
export function addFailed(
  r: BatchResult,
  email: string,
  error: string,
  errorType: string | null = null,
): void {
  r.failed_count += 1;
  r.results.push({ email, status: "failed", error, error_type: errorType });
}

/** 添加跳过结果 —— 对标 add_skipped() */
export function addSkipped(r: BatchResult, email: string, reason: string): void {
  r.skipped_count += 1;
  r.results.push({ email, status: "skipped", reason });
}

/**
 * 转换为字典 —— 对标 to_dict()
 * success_rate 是**百分比字符串**（Python 的 f"{x:.1%}"，如 "66.7%"）。
 */
export function batchResultToDict(r: BatchResult): Record<string, unknown> {
  return {
    total: r.total,
    success_count: r.success_count,
    failed_count: r.failed_count,
    skipped_count: r.skipped_count,
    success_rate: formatPercent1(batchSuccessRate(r)),
    duration_seconds: batchDurationSeconds(r),
    results: r.results,
  };
}

/**
 * 复刻 Python 的 `f"{value:.1%}"`：先乘 100，再保留 1 位小数，最后加 %。
 * Python 的格式化用「四舍六入五成双」，JS 的 toFixed 对 .5 一律远离零，
 * 这里按 Python 的规则实现，避免边界值差一位。
 */
export function formatPercent1(value: number): string {
  const scaled = value * 100;
  return `${bankersRound(scaled, 1)}%`;
}

/** 银行家舍入到指定小数位，并保证输出固定位数（对齐 Python 的格式化） */
function bankersRound(value: number, digits: number): string {
  const factor = 10 ** digits;
  const shifted = value * factor;
  const floor = Math.floor(shifted);
  const diff = shifted - floor;

  let rounded: number;
  const EPS = 1e-9;
  if (Math.abs(diff - 0.5) < EPS) {
    // 恰好 .5：取偶
    rounded = floor % 2 === 0 ? floor : floor + 1;
  } else {
    rounded = Math.round(shifted);
  }
  return (rounded / factor).toFixed(digits);
}

// ==================== AccountMembershipRefreshResult ====================

/** 账号会员信息刷新结果 —— 对标 AccountMembershipRefreshResult dataclass */
export interface AccountMembershipRefreshResult {
  email: string;
  /** yes / no / family_yes / detection_failed / unknown */
  is_pro: string;
  /** regular / family / none / unknown */
  membership_type: string;
  pro_plan_name: string;
  /** manager / member / none / unknown */
  family_role: string;
  /** yes / no / unknown */
  has_family_group: string;
  family_manager_email: string;
  family_member_count: number;
  family_slots_left: number;
  account_country: string;
  error_message: string;
  success: boolean;
}

export function createAccountMembershipRefreshResult(
  overrides: Partial<AccountMembershipRefreshResult> & { email: string },
): AccountMembershipRefreshResult {
  const base: AccountMembershipRefreshResult = {
    email: overrides.email,
    is_pro: "unknown",
    membership_type: "unknown",
    pro_plan_name: "",
    family_role: "unknown",
    has_family_group: "unknown",
    family_manager_email: "",
    family_member_count: 0,
    family_slots_left: -1,
    account_country: "",
    error_message: "",
    success: false,
  };
  return applyOverrides(base, overrides);
}

/** 转换为字典 —— 对标 to_dict() */
export function membershipResultToDict(
  r: AccountMembershipRefreshResult,
): Record<string, unknown> {
  return {
    email: r.email,
    is_pro: r.is_pro,
    membership_type: r.membership_type,
    pro_plan_name: r.pro_plan_name,
    family_role: r.family_role,
    has_family_group: r.has_family_group,
    family_manager_email: r.family_manager_email,
    family_member_count: r.family_member_count,
    family_slots_left: r.family_slots_left,
    account_country: r.account_country,
    error_message: r.error_message,
    success: r.success,
  };
}

/**
 * 从 Pro 状态创建结果对象 —— 对标 from_pro_status() 类方法
 *
 * 推断规则照搬 Python（注释也一并保留）：
 *   yes        → regular / manager（普通 Pro 默认是管理员）
 *   family_yes → family  / member （家庭组 Pro 默认是成员）
 *   no         → none    / none
 *   其它       → unknown / unknown
 */
export function membershipFromProStatus(
  email: string,
  isPro: string,
): AccountMembershipRefreshResult {
  const result = createAccountMembershipRefreshResult({ email });
  result.is_pro = isPro;

  if (isPro === "yes") {
    result.membership_type = "regular";
    result.family_role = "manager";
  } else if (isPro === "family_yes") {
    result.membership_type = "family";
    result.family_role = "member";
  } else if (isPro === "no") {
    result.membership_type = "none";
    result.family_role = "none";
  } else {
    result.membership_type = "unknown";
    result.family_role = "unknown";
  }

  result.success = isPro === "yes" || isPro === "no" || isPro === "family_yes";
  return result;
}

/**
 * 计算剩余家庭组位置 —— 对标 calculate_family_slots()（就地修改）
 *
 * 只有「普通 Pro 且是管理员」才算得出剩余位；家庭组 Pro 与其它情况一律 -1。
 * `max(count, 1)` 是照搬 Python：成员数为 0 时按 1 算（管理员自己）。
 */
export function calculateFamilySlots(r: AccountMembershipRefreshResult): void {
  if (r.is_pro === "yes" && r.family_role === "manager") {
    r.family_slots_left = Math.max(0, 6 - Math.max(r.family_member_count, 1));
  } else if (r.is_pro === "family_yes") {
    r.family_slots_left = -1;
  } else {
    r.family_slots_left = -1;
  }
}

// ==================== 内部工具 ====================

/** 覆盖时跳过 undefined，等价于 Python 的「不传即取默认」 */
function applyOverrides<T extends object>(base: T, overrides: Partial<T>): T {
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}
