/**
 * AI 任务页的树形数据纯函数（渲染层）
 *
 * 三个纯函数的职责：
 *   - filterByStatus   状态筛选
 *   - selectedItems    取出勾选的账号
 *   - statusTone       逐行状态对应的底色
 */
import type { AiTaskGroupNode, AiTaskStartItem } from "../../../../shared/channels/ai-tasks.ts";
import { AI_TASK_ITEM_STATUS } from "../../../../shared/channels/ai-tasks.ts";

/** 过滤后的分组：browsers 只含可见窗口，totalInGroup 保留原数量（分组标题用） */
export interface VisibleGroup extends AiTaskGroupNode {
  totalInGroup: number;
}

/**
 * 状态筛选：statusFilter 为空串表示「全部」。
 * 分组即使没有可见窗口也保留，分组标题的数量是分组内窗口总数。
 */
export function filterByStatus(groups: readonly AiTaskGroupNode[], statusFilter: string): VisibleGroup[] {
  return groups.map((g) => ({
    ...g,
    totalInGroup: g.browsers.length,
    browsers: statusFilter ? g.browsers.filter((b) => b.status === statusFilter) : g.browsers,
  }));
}

/** 可见账号数（「共 N 个账号」，:331-333） */
export function countVisible(groups: readonly VisibleGroup[]): number {
  return groups.reduce((n, g) => n + g.browsers.length, 0);
}

/** 窗口行能否勾选：需要有效的窗口 ID 与非空名称（email） */
export function isSelectable(b: { profileId: number | null; name: string }): boolean {
  return b.profileId !== null && b.name.trim() !== "";
}

/** 勾选且可见的账号 → 任务条目（只传 email 与窗口 ID，账号信息由后端从数据库重读） */
export function selectedItems(groups: readonly VisibleGroup[], checkedKeys: readonly string[]): AiTaskStartItem[] {
  const checked = new Set(checkedKeys);
  const items: AiTaskStartItem[] = [];
  for (const g of groups) {
    for (const b of g.browsers) {
      if (!checked.has(b.key) || !isSelectable(b) || b.profileId === null) continue;
      items.push({ email: b.name, profileId: b.profileId });
    }
  }
  return items;
}

/** 只保留仍然可见的勾选项 */
export function pruneChecked(groups: readonly VisibleGroup[], checkedKeys: readonly string[]): string[] {
  const visible = new Set(groups.flatMap((g) => g.browsers.map((b) => b.key)));
  return checkedKeys.filter((k) => visible.has(k));
}

export type StatusTone = "success" | "error" | "warning";

/** 成功绿；失败 / 错误红；其他（处理中等）黄 */
export function statusTone(status: string): StatusTone {
  if (status === AI_TASK_ITEM_STATUS.success) return "success";
  if (status === AI_TASK_ITEM_STATUS.failed || status === AI_TASK_ITEM_STATUS.error) return "error";
  return "warning";
}

/** 行底色（半透明，明暗主题都可读），与上面三种色调一一对应 */
export const TONE_BACKGROUND: Readonly<Record<StatusTone, string>> = {
  success: "rgba(82, 196, 26, 0.18)",
  error: "rgba(255, 77, 79, 0.18)",
  warning: "rgba(250, 219, 20, 0.22)",
};
