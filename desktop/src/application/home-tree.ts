/**
 * 首页窗口树的纯函数 —— 后端（构树）与渲染层（过滤 / 勾选）共用
 *
 * 包含：
 *   - buildGroupOptions：构造分组下拉选项
 *   - buildBrowserTree：构造窗口树
 *   - filterBrowserTree：按关键词过滤窗口树
 *   - selectAllVisible：全选当前可见项
 *   - selectedProfileIds：取得勾选的窗口 ID
 * 纯 TS，不依赖 node / DOM / electron，便于单测与渲染层直接引用。
 */
import type {
  HomeBrowserNode,
  HomeGroupNode,
  HomeGroupOption,
} from "../../app/shared/channels/home.ts";

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

export interface BuiltBrowserTree {
  groups: HomeGroupNode[];
  totalBrowsers: number;
}

/**
 * 构建分组树：
 *   - 分组名优先取 group-list；没有的分组用窗口自带的 group_name；都不行用 `分组 {gid}`
 *   - group_id 缺失 / 0 归到「未分组」（gid=0，且 0 的名字固定为「未分组」）
 *   - group-list 里的分组即使没有窗口也保留（数量 0），与原版一致
 *   - 按 gid 升序
 */
export function buildBrowserTree(groups: readonly unknown[], browsers: readonly unknown[]): BuiltBrowserTree {
  const groupNames = new Map<number, string>();
  for (const raw of groups) {
    const g = asRecord(raw);
    if (!g) continue;
    const gid = asGroupId(g["id"]);
    if (gid === null) continue;
    groupNames.set(gid, groupTitle(g["title"] ?? "", gid));
  }
  groupNames.set(0, UNGROUPED_NAME);

  const grouped = new Map<number, HomeBrowserNode[]>();
  for (const gid of groupNames.keys()) grouped.set(gid, []);

  // 行 key：有 profileId 时用 `b:{profileId}`，刷新后同一窗口 key 不变（勾选 / 展开状态可对应）；
  // 没有有效 profileId，或同一 profileId 重复出现时，退回 `b:{gid}:{序号}`（冒号个数不同，不会与前者撞键）。
  // BrowserListCard 靠 "b:" 前缀区分窗口行，取选中 ID 看的是节点的 profileId 而非 key，两者都不受影响。
  let index = 0;
  const usedProfileIds = new Set<number>();
  for (const raw of browsers) {
    const b = asRecord(raw);
    if (!b) continue;
    // group_id 缺失或非数字时按 0（未分组）处理
    const gid = asGroupId(b["group_id"]) ?? 0;
    let list = grouped.get(gid);
    if (!list) {
      list = [];
      grouped.set(gid, list);
      groupNames.set(gid, groupTitle(b["group_name"] ?? "", gid));
    }
    const profileId = asProfileId(b["profile_id"]);
    const seq = index++;
    let key: string;
    if (profileId !== null && !usedProfileIds.has(profileId)) {
      usedProfileIds.add(profileId);
      key = `b:${profileId}`;
    } else {
      key = `b:${gid}:${seq}`;
    }
    list.push({
      key,
      profileId,
      name: cleanText(b["name"] ?? ""),
      tfaCode: "", // 2FA 初始为空（:355）
      note: cleanText(b["note"] ?? ""),
    });
  }

  const result: HomeGroupNode[] = [];
  let total = 0;
  for (const gid of [...grouped.keys()].sort((a, b) => a - b)) {
    const list = grouped.get(gid) ?? [];
    total += list.length;
    result.push({
      key: `g:${gid}`,
      groupId: gid,
      groupName: groupNames.get(gid) ?? `分组 ${gid}`,
      browsers: list,
    });
  }
  return { groups: result, totalBrowsers: total };
}

/** 分组节点显示文本（:333）：`📁 {分组名} ({数量})`，数量是分组内窗口总数（不随搜索变化） */
export function groupLabel(group: HomeGroupNode): string {
  return `📁 ${group.groupName} (${group.browsers.length})`;
}

/** 刷新完成日志（:363） */
export function refreshSummary(groups: readonly HomeGroupNode[]): string {
  const total = groups.reduce((n, g) => n + g.browsers.length, 0);
  return `列表刷新完成，共 ${groups.length} 个分组，${total} 个窗口`;
}

export interface FilteredTree {
  /** 可见的分组（browsers 只含可见窗口） */
  groups: HomeGroupNode[];
  /** 过滤后仍然勾选的窗口 key（被隐藏的自动取消勾选） */
  checkedKeys: string[];
}

/**
 * 搜索过滤：
 *   - 搜索词 lower + strip；只匹配名称与备注，不区分大小写
 *   - 被隐藏的窗口取消勾选
 *   - 搜索词非空且分组内无可见窗口 → 整组隐藏；搜索词为空时全部可见（包括空分组）
 */
export function filterBrowserTree(
  groups: readonly HomeGroupNode[],
  searchText: string,
  checkedKeys: readonly string[],
): FilteredTree {
  const q = searchText.toLowerCase().trim();
  const checked = new Set(checkedKeys);
  const visible: HomeGroupNode[] = [];
  const keep: string[] = [];

  for (const g of groups) {
    const kids = q
      ? g.browsers.filter((b) => b.name.toLowerCase().includes(q) || b.note.toLowerCase().includes(q))
      : g.browsers;
    for (const b of kids) if (checked.has(b.key)) keep.push(b.key);
    if (q && kids.length === 0) continue;
    visible.push(kids === g.browsers ? g : { ...g, browsers: kids });
  }
  return { groups: visible, checkedKeys: keep };
}

/** 全选 / 取消全选：只作用于可见窗口 */
export function selectAllVisible(
  visibleGroups: readonly HomeGroupNode[],
  checkedKeys: readonly string[],
  checked: boolean,
): string[] {
  const visibleKeys = visibleGroups.flatMap((g) => g.browsers.map((b) => b.key));
  if (checked) return [...new Set([...checkedKeys, ...visibleKeys])];
  const drop = new Set(visibleKeys);
  return checkedKeys.filter((k) => !drop.has(k));
}

/** 选中的窗口 ID：只取可见且勾选的窗口；ID 无效的跳过，去重保序 */
export function selectedProfileIds(
  visibleGroups: readonly HomeGroupNode[],
  checkedKeys: readonly string[],
): number[] {
  const checked = new Set(checkedKeys);
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const g of visibleGroups) {
    for (const b of g.browsers) {
      if (!checked.has(b.key) || b.profileId === null || seen.has(b.profileId)) continue;
      seen.add(b.profileId);
      ids.push(b.profileId);
    }
  }
  return ids;
}
