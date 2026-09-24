/**
 * 账号健康巡检的批量编排
 *
 * 与 executeBatchBind / executeBatchDelete 同一层级与风格：纯编排 + 注入依赖，单测全部离线。
 * 真正的只读判定在 src/automation/auto-health-check.ts，这里只负责逐个调用、计数、上报逐条目。
 */
import {
  autoHealthCheck,
  type AutoHealthCheckOptions,
  type HealthCheckResult,
  type HealthStatus,
} from "../automation/auto-health-check.ts";

export type { HealthCheckResult };

/** 默认的单账号判定：真机连窗口只读判定（handler 不直连 automation，经这里调用） */
export function defaultHealthCheck(
  browserId: string,
  account: Record<string, unknown>,
  options: AutoHealthCheckOptions,
): Promise<HealthCheckResult> {
  return autoHealthCheck(browserId, account, options);
}

export type AccountDict = Record<string, unknown>;
export type LogFn = (message: string) => void;

/** 逐账号的巡检结论 */
export interface HealthCheckItemOutcome {
  email: string;
  browserId: string;
  status: HealthStatus;
  message: string;
}

export interface HealthCheckSummary {
  total: number;
  ok: number;
  need_login: number;
  suspended: number;
  window_error: number;
  results: HealthCheckItemOutcome[];
}

/** 结论 → 界面口径的条目状态（与 AI_TASK_ITEM_STATUS 一致，任务历史据此统计成功 / 失败） */
const ITEM_STATUS: Record<HealthStatus, string> = {
  ok: "成功",
  need_login: "失败",
  suspended: "失败",
  window_error: "错误",
};

/** 结论 → 日志里的中文标签 */
const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "正常",
  need_login: "需要登录",
  suspended: "已停用",
  window_error: "窗口异常",
};

function emailOf(account: AccountDict): string {
  const v = account["email"];
  return v === null || v === undefined ? "" : String(v);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function executeHealthCheck(params: {
  accounts: readonly AccountDict[];
  browserIds: readonly string[];
  /** 单个账号的只读判定（真机为 autoHealthCheck；单测注入假实现） */
  check: (browserId: string, account: AccountDict) => Promise<HealthCheckResult>;
  shouldStop: () => boolean;
  log: LogFn;
  progress: (current: number) => void;
  /** 逐条目结果（任务历史用） */
  item?: (key: string, status: string, message: string) => void;
}): Promise<HealthCheckSummary> {
  const { accounts, browserIds, check, shouldStop, log, progress } = params;
  const summary: HealthCheckSummary = {
    total: accounts.length,
    ok: 0,
    need_login: 0,
    suspended: 0,
    window_error: 0,
    results: [],
  };

  for (let index = 0; index < accounts.length; index++) {
    if (shouldStop()) {
      log(`[用户操作] 任务已停止，剩余 ${accounts.length - index} 个账号未巡检`);
      break;
    }
    const account = accounts[index] as AccountDict;
    const email = emailOf(account);
    const raw = index < browserIds.length ? browserIds[index] : "";
    const browserId = raw === null || raw === undefined ? "" : String(raw);

    let result: HealthCheckResult;
    if (!browserId) {
      // 没绑窗口就没法只读探测：算窗口异常（不是账号异常），并且不去连引擎
      result = {
        status: "window_error",
        message: "未绑定窗口",
        url: "",
        reason: "账号未绑定浏览器窗口",
      };
      log(`[${index + 1}/${accounts.length}] ${email}: 未绑定窗口，跳过巡检`);
    } else {
      try {
        result = await check(browserId, account);
      } catch (error) {
        result = {
          status: "window_error",
          message: `窗口打不开: ${errText(error)}`,
          url: "",
          reason: errText(error),
        };
      }
    }

    summary[result.status] += 1;
    summary.results.push({ email, browserId, status: result.status, message: result.message });
    log(`[${index + 1}/${accounts.length}] ${email}: ${STATUS_LABEL[result.status]}（${result.message}）`);
    params.item?.(email, ITEM_STATUS[result.status], result.message);
    progress(index + 1);
  }

  return summary;
}

/** 完成日志里的汇总行 */
export function healthCheckSummaryLine(summary: HealthCheckSummary): string {
  return (
    `巡检完成: 正常 ${summary.ok}，需要登录 ${summary.need_login}，` +
    `已停用 ${summary.suspended}，窗口异常 ${summary.window_error}`
  );
}
