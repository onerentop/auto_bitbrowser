/**
 * 首页窗口列表的纯函数 —— 后端（组装列表）与渲染层（筛选 / 排序 / 勾选）共用
 *
 * 包含：
 *   - buildGroupOptions：构造「目标分组」下拉选项
 *   - buildBrowserList：平铺窗口列表 + 分组统计（**不含 2FA 密钥**）
 *   - filterBrowsers / compareBrowsers：分组筛选 + 搜索、列排序
 *   - reconcileChecked / selectionSummary / selectedProfileIds：勾选状态
 * 纯 TS，不依赖 node / DOM / electron：属于共享内核（app/shared），Node 与浏览器两边都能跑。
 */
import type {
  HomeBrowserList,
  HomeBrowserNode,
  HomeGroupCount,
  HomeGroupOption,
} from "../channels/home.ts";

/** 默认分组 ID（ixBrowser 固有分组） */
export const DEFAULT_GROUP_ID = 1;
export const DEFAULT_GROUP_LABEL = "默认分组";
export const UNGROUPED_NAME = "未分组";

/**
 * 被视为不可打印的字符：
 * Cc/Cf/Cs/Co/Cn（统称 \p{C}）、Zl、Zp，以及除 ASCII 空格外的 Zs。
 */
const NON_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu;

/** 去掉不可打印字符；空值返回 "" */
export function cleanText(text: unknown): string {
  if (text === null || text === undefined || text === "" || text === 0 || text === false) return "";
  return String(text).replace(NON_PRINTABLE, "");
}

/** 分组名兜底（:307 / :319）：清洗后为空或含替换字符 U+FFFD 时用 `分组 {gid}` */
function groupTitle(raw: unknown, gid: unknown): string {
  const title = cleanText(raw);
  if (!title || title.includes("\ufffd")) return `分组 ${String(gid)}`;
  return title;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 分组 ID 必须是有限整数；其余（缺失 / 字符串等）视为无效，跳过 */
function asGroupId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function defaultGroupOptions(): HomeGroupOption[] {
  return [{ id: DEFAULT_GROUP_ID, label: DEFAULT_GROUP_LABEL }];
}

/**
 * 目标分组下拉：
 *   - 结果里没有 id=1 时，最前面补一项「默认分组」
 *   - 每项显示 `{title} (ID: {gid})`
 */
export function buildGroupOptions(groups: readonly unknown[]): HomeGroupOption[] {
  const records = groups.map(asRecord).filter((g): g is Record<string, unknown> => g !== null);
  const options: HomeGroupOption[] = [];
  if (!records.some((g) => g["id"] === DEFAULT_GROUP_ID)) {
    options.push(...defaultGroupOptions());
  }
  for (const g of records) {
    const gid = asGroupId(g["id"]);
    if (gid === null) continue; // 分组 ID 缺失时直接跳过（选了也无法用）
    options.push({ id: gid, label: `${groupTitle(g["title"] ?? "", gid)} (ID: ${gid})` });
  }
  return options;
}

/** 窗口 ID：正整数（或可转成正整数的字符串）才有效 */
function asProfileId(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
}

/** 最近打开时间：正数秒才有效，0 / 缺失表示从未打开 */
function asOpenTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** 是否配置了 2FA 密钥：去掉空白后非空。**只判断有无，不把密钥带出去** */
function hasSecret(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\s+/g, "") !== "";
}

/**
 * 平铺窗口列表：
 *   - 分组名优先取 group-list；没有的分组用窗口自带的 group_name；都不行用 `分组 {gid}`
 *   - group_id 缺失 / 0 归到「未分组」（gid=0，名字固定）
 *   - 行顺序保持 ixBrowser 返回顺序（界面自己排序）
 *   - groups 只列有窗口的分组，按 gid 升序（筛选标签用）
 *   - 行 key：有 profileId 时用 `b:{profileId}`，刷新后同一窗口 key 不变（勾选可对应）；
 *     没有有效 profileId，或同一 profileId 重复出现时，退回 `b:{gid}:{序号}`（冒号个数不同，不会撞键）
 */
export function buildBrowserList(
  groups: readonly unknown[],
  browsers: readonly unknown[],
): Omit<HomeBrowserList, "error"> {
  const groupNames = new Map<number, string>();
  for (const raw of groups) {
    const g = asRecord(raw);
    if (!g) continue;
    const gid = asGroupId(g["id"]);
    if (gid === null) continue;
    groupNames.set(gid, groupTitle(g["title"] ?? "", gid));
  }
  groupNames.set(0, UNGROUPED_NAME);

  const counts = new Map<number, number>();
  const rows: HomeBrowserNode[] = [];
  const usedProfileIds = new Set<number>();
  let index = 0;
  for (const raw of browsers) {
    const b = asRecord(raw);
    if (!b) continue;
    // group_id 缺失或非数字时按 0（未分组）处理
    const gid = asGroupId(b["group_id"]) ?? 0;
    if (!groupNames.has(gid)) groupNames.set(gid, groupTitle(b["group_name"] ?? "", gid));
    counts.set(gid, (counts.get(gid) ?? 0) + 1);

    const profileId = asProfileId(b["profile_id"]);
    const seq = index++;
    let key: string;
    if (profileId !== null && !usedProfileIds.has(profileId)) {
      usedProfileIds.add(profileId);
      key = `b:${profileId}`;
    } else {
      key = `b:${gid}:${seq}`;
    }
    rows.push({
      key,
      profileId,
      name: cleanText(b["name"] ?? ""),
      note: cleanText(b["note"] ?? ""),
      groupId: gid,
      groupName: groupNames.get(gid) ?? `分组 ${gid}`,
      lastOpenTime: asOpenTime(b["last_open_time"]),
      hasTfa: hasSecret(b["tfa_secret"]),
    });
  }

  const groupCounts: HomeGroupCount[] = [...counts.keys()]
    .sort((a, b) => a - b)
    .map((gid) => ({ groupId: gid, groupName: groupNames.get(gid) ?? `分组 ${gid}`, count: counts.get(gid) ?? 0 }));
  return { browsers: rows, groups: groupCounts, totalBrowsers: rows.length };
}

/** 刷新完成日志 */
export function refreshSummary(list: Pick<HomeBrowserList, "groups" | "totalBrowsers">): string {
  return `列表刷新完成，共 ${list.groups.length} 个分组，${list.totalBrowsers} 个窗口`;
}

export interface BrowserQuery {
  /** null = 全部分组 */
  groupId: number | null;
  text: string;
}

/**
 * 分组筛选 + 搜索（叠加）：
 *   - 搜索词 trim + 不区分大小写，匹配窗口 ID 前缀、名称、备注（分组名不参与）
 *   - 没有任何条件时原样返回同一个数组（渲染层可据此少做一次复制）
 */
export function filterBrowsers(list: readonly HomeBrowserNode[], query: BrowserQuery): readonly HomeBrowserNode[] {
  const q = query.text.trim().toLowerCase();
  if (!q && query.groupId === null) return list;
  return list.filter((b) => {
    if (query.groupId !== null && b.groupId !== query.groupId) return false;
    if (!q) return true;
    return (
      (b.profileId !== null && String(b.profileId).startsWith(q)) ||
      b.name.toLowerCase().includes(q) ||
      b.note.toLowerCase().includes(q)
    );
  });
}

export type BrowserSortKey = "profileId" | "name" | "lastOpenTime";
export type SortOrder = "ascend" | "descend";

/**
 * 列排序比较函数，返回「最终顺序」（调用方不要再取反）。
 * 空值（无窗口 ID / 从未打开）不论升降序都排在最后；名称按本地化规则、不区分大小写、数字按数值比较。
 */
export function compareBrowsers(key: BrowserSortKey, a: HomeBrowserNode, b: HomeBrowserNode, order: SortOrder): number {
  if (key === "name") {
    const r = a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
    return order === "descend" ? -r : r;
  }
  const x = a[key];
  const y = b[key];
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return order === "descend" ? y - x : x - y;
}

/**
 * 给 antd Table 的 sorter 用：antd 降序时会把比较结果**取反**，而 compareBrowsers 返回的已是最终顺序，
 * 所以降序时预先取反一次抵消，保证空值无论升降序都排在最后。
 */
export function tableSorter(key: BrowserSortKey) {
  return (a: HomeBrowserNode, b: HomeBrowserNode, order?: SortOrder | null): number => {
    const r = compareBrowsers(key, a, b, order === "descend" ? "descend" : "ascend");
    return order === "descend" ? -r : r;
  };
}

/** 刷新后：去掉已不存在的行的勾选，其余保留（保持原顺序）；只看行 key，首页与 AI 任务页共用 */
export function reconcileChecked(checkedKeys: readonly string[], list: readonly { key: string }[]): string[] {
  const exists = new Set(list.map((b) => b.key));
  return checkedKeys.filter((k) => exists.has(k));
}

/** 勾选统计：total 为全部勾选数，hidden 为其中不在当前视图（被筛选 / 搜索隐藏）的数量 */
export function selectionSummary(
  checkedKeys: readonly string[],
  visible: readonly { key: string }[],
): { total: number; hidden: number } {
  const shown = new Set(visible.map((b) => b.key));
  const hidden = checkedKeys.filter((k) => !shown.has(k)).length;
  return { total: checkedKeys.length, hidden };
}

/** 勾选的窗口 ID（含被隐藏的）：按列表顺序，ID 无效的跳过，去重 */
export function selectedProfileIds(list: readonly HomeBrowserNode[], checkedKeys: readonly string[]): number[] {
  const checked = new Set(checkedKeys);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const b of list) {
    if (!checked.has(b.key) || b.profileId === null || seen.has(b.profileId)) continue;
    seen.add(b.profileId);
    ids.push(b.profileId);
  }
  return ids;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 最近打开时间显示：本地时间 `YYYY-MM-DD HH:mm`；从未打开显示 — */
export function formatOpenTime(seconds: number | null): string {
  if (seconds === null) return "—";
  const d = new Date(seconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
