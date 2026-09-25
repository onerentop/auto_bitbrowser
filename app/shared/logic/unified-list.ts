/**
 * 账号 / 窗口「一体列表」的共享纯函数 —— 后端与渲染层共用
 *
 * 背景（R1）：账号页合并了原来的首页窗口列表，工具栏可在「账号 / 窗口」两个视角间切换。
 * 账号视角沿用 `src/application/account-list.ts#buildAccountRows`（行为不变）；
 * 窗口视角用 `home-list.ts#buildBrowserList` 的数据，再补一件账号侧才知道的事：
 * **每个窗口绑的是哪个账号**（反查 accounts.browser_profile_id），这样窗口视角才看得出
 * 「哪些窗口还没绑账号」——这是合并后新增的信息，原来两页分着看是看不到的。
 *
 * 纯 TS，不依赖 node / DOM / electron：Node 与浏览器两边都能跑。
 */
import type { HomeBrowserNode } from "../channels/home.ts";
import { filterBrowsers } from "./home-list.ts";

/** 窗口视角的一行：窗口信息 + 绑定它的账号邮箱 */
export interface UnifiedWindowRow extends HomeBrowserNode {
  /** 绑定该窗口的账号邮箱；没有账号绑定它为 null */
  boundEmail: string | null;
}

/** 账号表里用得到的两个字段（避免这里 import Node 侧的完整行类型） */
export interface AccountBinding {
  email: string;
  browser_profile_id?: string | null;
}

/**
 * 把「窗口 → 绑定账号邮箱」贴到窗口行上。
 *
 * - browser_profile_id 只在能解析成正整数时才算绑定（空串 / 非数字 / 0 一律视为未绑定）
 * - 同一窗口被多个账号绑定时取**先出现**的那个（正常数据不该出现；不猜、不报错）
 * - 行顺序与入参一致，不排序（排序交给表格）
 */
export function attachBoundEmails(
  windows: readonly HomeBrowserNode[],
  accounts: readonly AccountBinding[],
): UnifiedWindowRow[] {
  const byProfile = new Map<number, string>();
  for (const a of accounts) {
    const raw = a.browser_profile_id;
    const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!byProfile.has(id)) byProfile.set(id, a.email);
  }
  return windows.map((w) => ({
    ...w,
    boundEmail: w.profileId === null ? null : (byProfile.get(w.profileId) ?? null),
  }));
}

export interface UnifiedWindowQuery {
  /** null = 全部分组 */
  groupId: number | null;
  /** 搜索词：窗口ID 前缀 / 名称 / 备注 / 绑定账号，不区分大小写 */
  text: string;
  /** true = 只看没有绑定账号的窗口 */
  onlyUnbound: boolean;
}

/**
 * 窗口视角的筛选：在 `home-list.ts#filterBrowsers`（分组 + 窗口ID/名称/备注）之上，
 * 多认一个「绑定账号」维度，并支持只看未绑定。
 *
 * 有意复用 filterBrowsers 而不是重写一遍匹配规则：窗口侧的匹配口径只应该有一处。
 */
export function filterUnifiedWindows(
  rows: readonly UnifiedWindowRow[],
  query: UnifiedWindowQuery,
): readonly UnifiedWindowRow[] {
  const q = query.text.trim().toLowerCase();
  if (!q && query.groupId === null && !query.onlyUnbound) return rows;

  const inScope = (r: UnifiedWindowRow): boolean =>
    (query.groupId === null || r.groupId === query.groupId) && (!query.onlyUnbound || r.boundEmail === null);

  const matched = new Set<string>(filterBrowsers(rows, { groupId: query.groupId, text: query.text }).map((r) => r.key));
  if (q) {
    for (const r of rows) {
      if (r.boundEmail !== null && r.boundEmail.toLowerCase().includes(q)) matched.add(r.key);
    }
  }
  return rows.filter((r) => inScope(r) && matched.has(r.key));
}

export interface WindowViewSummary {
  total: number;
  unbound: number;
}

/** 窗口视角的计数：总数与未绑定账号数 */
export function windowViewSummary(rows: readonly UnifiedWindowRow[]): WindowViewSummary {
  let unbound = 0;
  for (const r of rows) if (r.boundEmail === null) unbound += 1;
  return { total: rows.length, unbound };
}

/** 工具栏那行文字（未绑定为 0 时不啰嗦） */
export function windowViewSummaryText(rows: readonly UnifiedWindowRow[]): string {
  const { total, unbound } = windowViewSummary(rows);
  return unbound > 0 ? `共 ${total} 个窗口（${unbound} 个未绑定账号）` : `共 ${total} 个窗口`;
}
