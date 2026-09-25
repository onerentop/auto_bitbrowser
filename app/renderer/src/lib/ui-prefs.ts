/**
 * 界面偏好（存 localStorage 的纯 UI 设置）的解析，以及分页页码夹取
 *
 * 纯函数、不碰 DOM：读写 localStorage 由调用方做，这里只把读到的字符串变成合法值。
 */

/** 账号表每页条数的可选值 */
export const ACCOUNT_PAGE_SIZES = [20, 50, 100, 200] as const;
/** 账号表默认每页条数 */
export const DEFAULT_ACCOUNT_PAGE_SIZE = 50;

/** localStorage 键：账号表每页条数 */
export const ACCOUNT_PAGE_SIZE_KEY = "abb/accounts/pageSize";
/** localStorage 键：侧栏是否收起（"1" = 收起） */
export const SIDER_COLLAPSED_KEY = "abb/shell/siderCollapsed";

/** 每页条数：必须是可选值之一（严格十进制整数写法），否则回落默认 */
export function parsePageSize(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return DEFAULT_ACCOUNT_PAGE_SIZE;
  const n = Number(raw);
  return (ACCOUNT_PAGE_SIZES as readonly number[]).includes(n) ? n : DEFAULT_ACCOUNT_PAGE_SIZE;
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
