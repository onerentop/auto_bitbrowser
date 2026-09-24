/**
 * 账号管理页：登录状态文案 / 颜色（纯函数，无 React 依赖，可直接单测）
 *
 * color 是 antd Tag 的语义色名（success / processing / error / default），实际色值由主题令牌决定，深浅色都可读。
 * 筛选 / 计数 / 排序在 app/shared/logic/account-list.ts。
 */
import type { AccountListRow } from "../../../../shared/channels/accounts.ts";

export type LoginTagColor = "success" | "processing" | "error" | "default";

export interface StatusView {
  text: string;
  color: LoginTagColor;
}

const LOGIN_TEXT: Record<string, string> = {
  not_logged: "未登录",
  logging_in: "登录中",
  logged_in: "已登录",
  login_failed: "失败",
};
const LOGIN_COLOR: Record<string, LoginTagColor> = {
  not_logged: "default",
  logging_in: "processing",
  logged_in: "success",
  login_failed: "error",
};

function pick<T>(map: Record<string, T>, key: string | null): T | undefined {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** 登录状态：失败且有错误时显示「失败: 前 20 字...」，悬停显示全文 */
export function loginView(row: Pick<AccountListRow, "login_status" | "last_error">): StatusView & { tooltip: string | null } {
  const status = row.login_status;
  const lastError = row.last_error ?? "";
  const color = pick(LOGIN_COLOR, status) ?? "default";
  if (status === "login_failed" && lastError) {
    const short = lastError.length > 20 ? `${lastError.slice(0, 20)}...` : lastError;
    return { text: `失败: ${short}`, color, tooltip: `错误原因: ${lastError}` };
  }
  // mapping.get(status, status or "未登录")
  return { text: pick(LOGIN_TEXT, status) ?? (status || "未登录"), color, tooltip: null };
}
