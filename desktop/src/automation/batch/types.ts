/**
 * 批量账号处理器 - 结果类型
 * （AccountMembershipRefreshResult 已随会员刷新功能一并移除，这里只有 BatchResult）
 *
 * 设计说明：
 *   - 接口 + `createXxx()` 工厂（字段全必需，默认值由工厂提供，
 *     覆盖时跳过 undefined），与 engine/types.ts 的既有约定一致
 *   - success_rate / duration_seconds 是独立函数（TS 的 getter 无法挂在纯接口上）
 *   - add_success / to_dict 这类实例方法同样是独立函数，
 *     直接就地修改传入对象（副作用语义）
 *   - 时间字段统一用毫秒时间戳（number），null 表示未设置
 */

// ==================== BatchResult ====================

/** 单条处理结果 */
export interface BatchResultItem {
  email: string;
  status: "success" | "failed" | "skipped";
  data?: Record<string, unknown>;
  error?: string;
  error_type?: string | null;
  reason?: string;
}

/** 批量处理结果 */
export interface BatchResult {
  total: number;
  success_count: number;
  failed_count: number;
  skipped_count: number;
  results: BatchResultItem[];
  /** 毫秒时间戳；null 表示未设置 */
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
 * 成功率
 * 注意分母是 success+failed，**不含 skipped**。
 */
export function batchSuccessRate(r: BatchResult): number {
  const processed = r.success_count + r.failed_count;
  return processed > 0 ? r.success_count / processed : 0;
}

/** 执行时长（秒） */
export function batchDurationSeconds(r: BatchResult): number {
  if (r.start_time !== null && r.end_time !== null) {
    return (r.end_time - r.start_time) / 1000;
  }
  return 0;
}

/** 添加成功结果 */
export function addSuccess(r: BatchResult, email: string, data?: Record<string, unknown>): void {
  r.success_count += 1;
  r.results.push({ email, status: "success", data: data ?? {} });
}

/** 添加失败结果 */
export function addFailed(
  r: BatchResult,
  email: string,
  error: string,
  errorType: string | null = null,
): void {
  r.failed_count += 1;
  r.results.push({ email, status: "failed", error, error_type: errorType });
}

/** 添加跳过结果 */
export function addSkipped(r: BatchResult, email: string, reason: string): void {
  r.skipped_count += 1;
  r.results.push({ email, status: "skipped", reason });
}

/**
 * 转换为字典
 * success_rate 是**百分比字符串**，如 "66.7%"。
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
 * 百分比格式化：先乘 100，再保留 1 位小数，最后加 %。
 * 标准格式化用「四舍六入五成双」，JS 的 toFixed 对 .5 一律远离零，
 * 这里按银行家舍入实现，避免边界值差一位。
 */
export function formatPercent1(value: number): string {
  const scaled = value * 100;
  return `${bankersRound(scaled, 1)}%`;
}

/** 银行家舍入到指定小数位，并保证输出固定位数 */
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

// ==================== 内部工具 ====================

/** 覆盖时跳过 undefined，等价于「不传即取默认」 */
function applyOverrides<T extends object>(base: T, overrides: Partial<T>): T {
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (base as unknown as Record<string, unknown>)[k] = v;
  }
  return base;
}
