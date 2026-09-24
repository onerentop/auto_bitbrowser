/**
 * 账号管理页平铺列表的纯函数（渲染层用，node:test 直接测）
 *
 * filterAccounts：分组 + 登录状态 + 搜索（邮箱 / 窗口ID 前缀 / 窗口名）叠加；
 * accountSorter：给 antd Table 的 sorter，空值无论升降序都在最后。
 * 勾选的「刷新后保留 / 隐藏计数」复用 home-list.ts 的 reconcileChecked / selectionSummary（行 key 为 email）。
 * 纯 TS，不依赖 node / DOM / electron。
 */
import type { AccountListRow } from "../channels/accounts.ts";

export type AccountLoginFilter = "all" | "logged_in" | "not_logged" | "login_failed";

export const ACCOUNT_LOGIN_FILTERS: ReadonlyArray<{ value: AccountLoginFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "logged_in", label: "已登录" },
  { value: "not_logged", label: "未登录" },
  { value: "login_failed", label: "登录失败" },
];

export interface AccountQuery {
  /** null = 全部分组 */
  groupId: number | null;
  login: AccountLoginFilter;
  text: string;
}

/** 登录状态筛选：未登录 = 空 / not_logged（「登录中」只在「全部」里） */
export function matchLogin(status: string | null, login: AccountLoginFilter): boolean {
  switch (login) {
    case "all":
      return true;
    case "logged_in":
      return status === "logged_in";
    case "login_failed":
      return status === "login_failed";
    case "not_logged":
      return status === null || status === "" || status === "not_logged";
  }
}

/** 叠加筛选；没有任何条件时原样返回同一个数组 */
export function filterAccounts(rows: readonly AccountListRow[], q: AccountQuery): readonly AccountListRow[] {
  const text = q.text.trim().toLowerCase();
  if (q.groupId === null && q.login === "all" && !text) return rows;
  return rows.filter((r) => {
    if (q.groupId !== null && r.group_id !== q.groupId) return false;
    if (!matchLogin(r.login_status, q.login)) return false;
    if (!text) return true;
    return (
      r.email.toLowerCase().includes(text) ||
      (r.browser_profile_id !== "" && r.browser_profile_id.startsWith(text)) ||
      r.window_name.toLowerCase().includes(text)
    );
  });
}

/** 登录状态计数（分段按钮上显示数量；统计全部行，不受其它筛选影响） */
export function countLogin(rows: readonly AccountListRow[]): Record<AccountLoginFilter, number> {
  const out: Record<AccountLoginFilter, number> = { all: rows.length, logged_in: 0, not_logged: 0, login_failed: 0 };
  for (const r of rows) {
    if (matchLogin(r.login_status, "logged_in")) out.logged_in += 1;
    else if (matchLogin(r.login_status, "login_failed")) out.login_failed += 1;
    else if (matchLogin(r.login_status, "not_logged")) out.not_logged += 1;
  }
  return out;
}

export type AccountSortKey = "email" | "windowId" | "lastLogin";

function sortValue(r: AccountListRow, key: AccountSortKey): string | number | null {
  switch (key) {
    case "email":
      return r.email;
    case "windowId":
      return r.browser_profile_id === "" ? null : Number(r.browser_profile_id);
    case "lastLogin":
      // last_login_at 形如 `2026-09-23 16:14:36`，按字符串比较即时间顺序
      return r.last_login_at;
  }
}

/**
 * 给 antd Table 的 sorter：antd 降序时会把结果取反，这里预先抵消，
 * 保证空值（未绑定窗口 / 从未登录）无论升降序都排在最后。
 */
export function accountSorter(key: AccountSortKey) {
  return (a: AccountListRow, b: AccountListRow, order?: "ascend" | "descend" | null): number => {
    const desc = order === "descend";
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    let r: number;
    if (x === null && y === null) r = 0;
    else if (x === null) r = 1;
    else if (y === null) r = -1;
    else {
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), undefined, { sensitivity: "base", numeric: true });
      r = desc ? -cmp : cmp;
    }
    return desc ? -r : r;
  };
}
