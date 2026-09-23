/**
 * 账号管理页：状态文案 / 颜色 / 筛选 / 统计（纯函数，无 React 依赖，可直接单测）
 *
 * 文案与颜色逐字照搬 gui/account_manager_interface.py:505-587；
 * 筛选照搬 _applyFilter（:591-636）——Python 按单元格**显示文本**比对，这里同样先算文本再比对，
 * 保证 null / 未知状态等边角情况与 Python 一致。
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

const PRO_TEXT: Record<string, string> = {
  unknown: "-",
  yes: "Pro",
  no: "非Pro",
  family_yes: "家庭",
  detection_failed: "检测失败",
};
const PRO_COLOR: Record<string, string> = {
  unknown: GREY,
  yes: "#4CAF50",
  no: "#F44336",
  family_yes: "#2196F3",
  detection_failed: "#FF9800",
};
/** :439-446 的悬停提示 */
const PRO_TOOLTIP: Record<string, string> = {
  unknown: "未检测 Pro 状态",
  yes: "普通 Pro 会员（自己订阅）",
  no: "非 Pro 会员",
  family_yes: "家庭组 Pro 会员（被邀请加入）",
  detection_failed: "Pro 检测失败（页面无法识别）",
};

const SUB2API_TEXT: Record<string, string> = {
  not_linked: "未关联",
  linking: "关联中",
  linked: "已关联",
  oauth_failed: "失败",
};
const SUB2API_COLOR: Record<string, string> = {
  not_linked: GREY,
  linking: "#2196F3",
  linked: "#4CAF50",
  oauth_failed: "#F44336",
};

const UNLOCK_TEXT: Record<string, string> = {
  none: "-",
  needs_unlock: "需解锁",
  unlocking: "解锁中",
  unlocked: "已解锁",
  unlock_failed: "失败",
};
const UNLOCK_COLOR: Record<string, string> = {
  none: GREY,
  needs_unlock: "#FF9800",
  unlocking: "#2196F3",
  unlocked: "#4CAF50",
  unlock_failed: "#F44336",
};

function pick(map: Record<string, string>, key: string | null): string | undefined {
  return key !== null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** 登录状态（:423-433）：失败且有错误时显示「失败: 前 20 字...」，悬停显示全文 */
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

/** Pro 状态（:525-545）：mapping.get(status, "-") */
export function proView(isPro: string | null): StatusView & { tooltip: string } {
  return {
    text: pick(PRO_TEXT, isPro) ?? "-",
    color: pick(PRO_COLOR, isPro) ?? GREY,
    tooltip: pick(PRO_TOOLTIP, isPro) ?? "未知状态",
  };
}

/** Sub2API 状态（:547-565）：mapping.get(status, status or "未关联") */
export function sub2apiView(status: string | null): StatusView {
  return { text: pick(SUB2API_TEXT, status) ?? (status || "未关联"), color: pick(SUB2API_COLOR, status) ?? GREY };
}

/** 解锁状态（:567-587）：mapping.get(status, status or "-") */
export function unlockView(status: string | null): StatusView {
  return { text: pick(UNLOCK_TEXT, status) ?? (status || "-"), color: pick(UNLOCK_COLOR, status) ?? GREY };
}

/** 筛选下拉的 14 项（:280-285） */
export const FILTER_OPTIONS = [
  "全部",
  "未登录",
  "已登录",
  "登录失败",
  "Pro会员",
  "Pro(家庭组)",
  "非Pro",
  "Pro检测失败",
  "未关联",
  "已关联",
  "OAuth失败",
  "需要解锁",
  "解锁失败",
  "已解锁",
] as const;

export type FilterOption = (typeof FILTER_OPTIONS)[number];

/** 对标 _applyFilter（:591-636）：按显示文本判断一行是否可见 */
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
    case "Pro会员": {
      const t = proView(row.is_pro).text;
      return t === "Pro" || t === "家庭";
    }
    case "Pro(家庭组)":
      return proView(row.is_pro).text === "家庭";
    case "非Pro":
      return proView(row.is_pro).text === "非Pro";
    case "Pro检测失败":
      return proView(row.is_pro).text === "检测失败";
    case "未关联":
      return sub2apiView(row.sub2api_status).text === "未关联";
    case "已关联":
      return sub2apiView(row.sub2api_status).text === "已关联";
    case "OAuth失败":
      return sub2apiView(row.sub2api_status).text === "失败";
    case "需要解锁":
      return unlockView(row.unlock_status).text === "需解锁";
    case "解锁失败":
      return unlockView(row.unlock_status).text === "失败";
    case "已解锁":
      return unlockView(row.unlock_status).text === "已解锁";
  }
}

/** 底部统计（:391-408 / :486）：统计全部账号（不受筛选影响） */
export function computeStats(rows: readonly AccountListRow[]): { total: number; loggedIn: number; linked: number } {
  let loggedIn = 0;
  let linked = 0;
  for (const r of rows) {
    if (r.login_status === "logged_in") loggedIn += 1;
    if (r.sub2api_status === "linked") linked += 1;
  }
  return { total: rows.length, loggedIn, linked };
}

export function statsText(rows: readonly AccountListRow[]): string {
  const s = computeStats(rows);
  return `总计 ${s.total} 个 | 已登录 ${s.loggedIn} | 已关联 ${s.linked}`;
}
