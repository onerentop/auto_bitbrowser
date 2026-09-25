/**
 * 账号管理页：登录状态的文字 / 色调 / 失败原因（纯函数，无 React 依赖，可直接单测）
 *
 * tone 是列表统一色调（lib/list-tone.ts）：决定行首状态条与状态圆点的颜色。
 * 失败原因原样给出，界面单行省略、悬停看全文（components/StatusDot.tsx）。
 * 筛选 / 计数 / 排序在 app/shared/logic/account-list.ts。
 */
import type { AccountListRow } from "../../../../shared/channels/accounts.ts";
import { accountLoginTone, type ListTone } from "../../lib/list-tone.ts";

export interface StatusView {
  text: string;
  tone: ListTone;
  /** 仅登录失败且有错误信息时给出 */
  reason: string | null;
}

const LOGIN_TEXT: Record<string, string> = {
  not_logged: "未登录",
  logging_in: "登录中",
  logged_in: "已登录",
  login_failed: "失败",
};

function pick<T>(map: Record<string, T>, key: string | null): T | undefined {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function loginView(row: Pick<AccountListRow, "login_status" | "last_error">): StatusView {
  const status = row.login_status;
  const reason = status === "login_failed" && row.last_error ? row.last_error : null;
  return { text: pick(LOGIN_TEXT, status) ?? (status || "未登录"), tone: accountLoginTone(status), reason };
}
