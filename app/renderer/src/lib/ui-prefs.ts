/**
 * 界面偏好（存 localStorage 的纯 UI 设置）的解析，以及分页页码夹取
 *
 * 纯函数、不碰 DOM：读写 localStorage 由调用方做，这里只把读到的字符串变成合法值。
 */

/** 列表每页条数的可选值（所有列表一致） */
export const PAGE_SIZES = [20, 50, 100, 200] as const;
/** 列表默认每页条数 */
export const DEFAULT_PAGE_SIZE = 50;

/** localStorage 键：某个列表的每页条数（按列表分别记，如 abb/accounts/pageSize） */
export function pageSizeKey(list: string): string {
  return `abb/${list}/pageSize`;
}
/** localStorage 键：侧栏是否收起（"1" = 收起） */
export const SIDER_COLLAPSED_KEY = "abb/shell/siderCollapsed";

/** 每页条数：必须是可选值之一（严格十进制整数写法），否则回落默认 */
export function parsePageSize(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/** 侧栏收起：只有 "1" 表示收起 */
export function parseCollapsed(raw: string | null): boolean {
  return raw === "1";
}

/** 页码夹到 [1, 总页数]；没有数据时为 1 */
export function clampPage(page: number, total: number, pageSize: number): number {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), pages);
}

/** 账号页的视角：账号行 / 窗口行 */
export type AccountView = "accounts" | "windows";
/** localStorage 键：账号页当前视角 */
export const ACCOUNT_VIEW_KEY = "abb/accounts/view";

/** 账号页视角：只认 "windows"，其余（含 null / 脏值）回落账号视角 */
export function parseAccountView(raw: string | null): AccountView {
  return raw === "windows" ? "windows" : "accounts";
}

/** localStorage 键：任务结束时是否发系统通知（"0" = 关闭） */
export const NOTIFY_FINISH_KEY = "abb/notify/finish";

/**
 * 任务结束通知开关：只有显式写过 "0" 才算关闭。
 * 默认开（没写过时也开）：这是「关窗后还能知道任务跑完没有」的基础能力；
 * 纯界面偏好，与任务本身无关，因此不进 config.json。
 */
export function parseNotifyEnabled(raw: string | null): boolean {
  return raw !== "0";
}
