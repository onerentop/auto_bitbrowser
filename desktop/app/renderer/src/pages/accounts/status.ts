/**
 * 账号管理页：状态文案 / 颜色 / 筛选 / 统计（纯函数，无 React 依赖，可直接单测）
 *
 * 状态文案与颜色沿用原有定义；
 * 筛选按单元格**显示文本**比对：先算文本再比对，
 * 保证 null / 未知状态等边角情况也有一致的处理。
 * Pro / Sub2API / 解锁状态三列及其筛选项已随对应功能按用户要求删除。
 */
import type { AccountListRow } from "../../../../shared/channels/accounts.ts";

export interface StatusView {
  text: string;
  color: string;
}

const GREY = "#888888";

const LOGIN_TEXT: Record<string, string> = {
  not_logged: "未登录",
  logging_in: "登录中",
  logged_in: "已登录",
  login_failed: "失败",
};
const LOGIN_COLOR: Record<string, string> = {
  not_logged: GREY,
  logging_in: "#2196F3",
  logged_in: "#4CAF50",
  login_failed: "#F44336",
};

function pick(map: Record<string, string>, key: string | null): string | undefined {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** 登录状态：失败且有错误时显示「失败: 前 20 字...」，悬停显示全文 */
export function loginView(row: Pick<AccountListRow, "login_status" | "last_error">): StatusView & { tooltip: string | null } {
  const status = row.login_status;
  const lastError = row.last_error ?? "";
  const color = pick(LOGIN_COLOR, status) ?? GREY;
  if (status === "login_failed" && lastError) {
    const short = lastError.length > 20 ? `${lastError.slice(0, 20)}...` : lastError;
    return { text: `失败: ${short}`, color, tooltip: `错误原因: ${lastError}` };
  }
  // mapping.get(status, status or "未登录")
  return { text: pick(LOGIN_TEXT, status) ?? (status || "未登录"), color, tooltip: null };
}

/** 筛选下拉（与登录相关的 4 项） */
export const FILTER_OPTIONS = ["全部", "未登录", "已登录", "登录失败"] as const;

export type FilterOption = (typeof FILTER_OPTIONS)[number];

/** 按显示文本判断一行是否可见 */
export function matchesFilter(row: AccountListRow, filter: FilterOption): boolean {
  switch (filter) {
    case "全部":
      return true;
    case "未登录":
      return loginView(row).text === "未登录";
    case "已登录":
      return loginView(row).text === "已登录";
    case "登录失败":
      return loginView(row).text.startsWith("失败");
  }
}

/** 底部统计：统计全部账号（不受筛选影响） */
export function computeStats(rows: readonly AccountListRow[]): { total: number; loggedIn: number } {
  let loggedIn = 0;
  for (const r of rows) {
    if (r.login_status === "logged_in") loggedIn += 1;
  }
  return { total: rows.length, loggedIn };
}

export function statsText(rows: readonly AccountListRow[]): string {
  const s = computeStats(rows);
  return `总计 ${s.total} 个 | 已登录 ${s.loggedIn}`;
}
