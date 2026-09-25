/**
 * AI 任务页（替换手机号等 6 个页面）平铺账号列表的纯函数 —— 渲染层用，node:test 直接测
 *
 * 包含：filterRows（分组 + 账号状态 + 只看本次失败 + 搜索）、rowSorter（表头排序）、
 * isSelectable / selectedItems（勾选 → 任务条目）、loginStatusLabel（登录状态文案）。
 * 任务结果的色调在渲染层 lib/list-tone.ts（aiItemTone）。
 * 勾选的「刷新后保留 / 隐藏计数」直接复用 home-list.ts 的 reconcileChecked / selectionSummary。
 * 纯 TS，不依赖 node / DOM / electron。
 */
import {
  AI_TASK_ITEM_STATUS,
  type AiTaskLoginFilter,
  type AiTaskRow,
  type AiTaskStartItem,
} from "../channels/ai-tasks.ts";
import type { LoginStatusChangedEvent } from "../channels/accounts.ts";

/** 任务推送的逐行结果（key 为 email） */
export interface RowRuntime {
  status: string;
  message: string;
}

export interface AiTaskRowQuery {
  /** null = 全部分组 */
  groupId: number | null;
  login: AiTaskLoginFilter;
  /** 只看本次任务结果为失败 / 错误的行 */
  failedOnly: boolean;
  text: string;
}

const LOGGED_IN = "logged_in";
const LOGIN_FAILED = "login_failed";

function matchLogin(row: AiTaskRow, login: AiTaskLoginFilter): boolean {
  switch (login) {
    case "all":
      return true;
    case "not_in_db":
      return !row.inDb;
    case "logged_in":
      return row.inDb && row.loginStatus === LOGGED_IN;
    case "login_failed":
      return row.inDb && row.loginStatus === LOGIN_FAILED;
    case "other":
      return row.inDb && row.loginStatus !== LOGGED_IN && row.loginStatus !== LOGIN_FAILED;
  }
}

/** 本次任务结果是否为失败 / 错误 */
export function isFailedRuntime(rt: RowRuntime | undefined): boolean {
  return rt !== undefined && (rt.status === AI_TASK_ITEM_STATUS.failed || rt.status === AI_TASK_ITEM_STATUS.error);
}

/**
 * 筛选（全部叠加）：分组、账号状态、只看本次失败、搜索（邮箱包含 / 窗口ID 前缀，不区分大小写）。
 * 没有任何条件时原样返回同一个数组。
 */
export function filterRows(
  rows: readonly AiTaskRow[],
  query: AiTaskRowQuery,
  runtime: Readonly<Record<string, RowRuntime>>,
): readonly AiTaskRow[] {
  const q = query.text.trim().toLowerCase();
  if (query.groupId === null && query.login === "all" && !query.failedOnly && !q) return rows;
  return rows.filter((r) => {
    if (query.groupId !== null && r.groupId !== query.groupId) return false;
    if (!matchLogin(r, query.login)) return false;
    if (query.failedOnly && !isFailedRuntime(runtime[r.email])) return false;
    if (!q) return true;
    return r.email.toLowerCase().includes(q) || (r.profileId !== null && String(r.profileId).startsWith(q));
  });
}

export type AiTaskSortKey = "email" | "profileId" | "lastLoginAt";

/**
 * 给 antd Table 的 sorter 用（antd 降序时会把结果取反，这里预先抵消）：
 * 空值（无窗口 ID / 没有最后登录时间）无论升降序都排在最后；邮箱不区分大小写。
 * last_login_at 形如 `2026-09-23 16:14:36`，按字符串比较即时间顺序。
 */
export function rowSorter(key: AiTaskSortKey) {
  return (a: AiTaskRow, b: AiTaskRow, order?: "ascend" | "descend" | null): number => {
    const desc = order === "descend";
    const x = a[key];
    const y = b[key];
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

/** 行能否勾选：需要有效的窗口 ID 与非空 email */
export function isSelectable(r: Pick<AiTaskRow, "profileId" | "email">): boolean {
  return r.profileId !== null && r.email.trim() !== "";
}

/** 勾选的行（含被筛选隐藏的）→ 任务条目：按列表顺序，不可勾选的跳过 */
export function selectedItems(rows: readonly AiTaskRow[], checkedKeys: readonly string[]): AiTaskStartItem[] {
  const checked = new Set(checkedKeys);
  const items: AiTaskStartItem[] = [];
  for (const r of rows) {
    if (!checked.has(r.key) || !isSelectable(r) || r.profileId === null) continue;
    items.push({ email: r.email, profileId: r.profileId });
  }
  return items;
}

/** 登录状态显示文案（与账号管理页一致：not_logged 为 schema 默认值「未登录」） */
export function loginStatusLabel(row: Pick<AiTaskRow, "inDb" | "loginStatus">): string {
  if (!row.inDb) return "不在数据库";
  if (row.loginStatus === LOGGED_IN) return "已登录";
  if (row.loginStatus === LOGIN_FAILED) return "登录失败";
  if (row.loginStatus === "not_logged") return "未登录";
  return row.loginStatus || "未知";
}

/**
 * 账号页手动设置了登录状态（abb/accounts/event/loginStatusChanged）后，就地改 AI 任务列表里对应的行。
 * 不在库的行没有登录状态可改，保持不动；一个都没命中时原样返回同一个数组。
 */
export function applyAiLoginStatusChange(rows: readonly AiTaskRow[], e: LoginStatusChangedEvent): readonly AiTaskRow[] {
  const hit = new Set(e.emails);
  let changed = false;
  const next = rows.map((r) => {
    if (!r.inDb || !hit.has(r.email)) return r;
    changed = true;
    return { ...r, loginStatus: e.status };
  });
  return changed ? next : rows;
}
