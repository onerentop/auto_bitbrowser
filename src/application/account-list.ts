/**
 * 账号管理页的列表组装（纯函数，可单测）
 *
 * 输入：数据库账号行 + ixBrowser 分组列表 + 窗口列表（取失败时为 null）。
 * 输出：平铺行 + 分组统计。
 *   - 窗口名、分组名与首页同一规则（复用 buildBrowserList）
 *   - 账号没绑定窗口 → 伪分组「未绑定窗口」；绑定的窗口找不到 → 「窗口不存在」（窗口列表取失败时为「窗口信息获取失败」）
 *   - 密码明文随列表下发（用户要求直接显示并可复制）；2FA 密钥与辅助邮箱原文仍不下发
 *   - note：窗口备注（ixBrowser 里的那份，与首页同一份）；未绑定或窗口不存在时为空串
 *   - same_name_windows：与邮箱同名的窗口个数（≥2 时界面提示需要人工确认绑定）
 */
import {
  MISSING_WINDOW_GROUP_ID,
  UNBOUND_GROUP_ID,
  type AccountGroupCount,
  type AccountListRow,
} from "../../app/shared/channels/accounts.ts";
import type { HomeBrowserNode } from "../../app/shared/channels/home.ts";
import { buildBrowserList } from "../../app/shared/logic/home-list.ts";
import { sameNameWindowCounts, windowNameKey } from "./window-binding.ts";

export const UNBOUND_GROUP_NAME = "未绑定窗口";
export const MISSING_WINDOW_GROUP_NAME = "窗口不存在";
export const WINDOW_UNKNOWN_GROUP_NAME = "窗口信息获取失败";

function nonEmpty(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 真实分组按 ID 升序，伪分组（负数）排最后：-1 在 -2 前 */
function groupOrder(a: number, b: number): number {
  if (a >= 0 && b >= 0) return a - b;
  if (a >= 0) return -1;
  if (b >= 0) return 1;
  return b - a;
}

export function buildAccountRows(
  accounts: readonly Record<string, unknown>[],
  groups: readonly unknown[],
  windows: readonly unknown[] | null,
): { rows: AccountListRow[]; groups: AccountGroupCount[] } {
  // 窗口 ID → 窗口节点（重复 ID 取第一个）
  const nodeById = new Map<string, HomeBrowserNode>();
  if (windows) {
    for (const node of buildBrowserList(groups, windows).browsers) {
      if (node.profileId === null) continue;
      const id = String(node.profileId);
      if (!nodeById.has(id)) nodeById.set(id, node);
    }
  }

  // 与邮箱同名的窗口个数（窗口列表取失败时全为 0）
  const sameNames = windows ? sameNameWindowCounts(windows) : new Map<string, number>();

  const counts = new Map<number, { name: string; count: number }>();
  const rows = accounts.map((a): AccountListRow => {
    const browserId = a["browser_profile_id"] ? String(a["browser_profile_id"]) : "";
    let groupId: number;
    let groupName: string;
    let windowName = "";
    let note = "";
    if (!browserId) {
      groupId = UNBOUND_GROUP_ID;
      groupName = UNBOUND_GROUP_NAME;
    } else {
      const node = nodeById.get(browserId);
      if (node) {
        groupId = node.groupId;
        groupName = node.groupName;
        windowName = node.name;
        note = node.note;
      } else {
        groupId = MISSING_WINDOW_GROUP_ID;
        groupName = windows ? MISSING_WINDOW_GROUP_NAME : WINDOW_UNKNOWN_GROUP_NAME;
      }
    }
    const c = counts.get(groupId);
    if (c) c.count += 1;
    else counts.set(groupId, { name: groupName, count: 1 });

    return {
      email: String(a["email"] ?? ""),
      login_status: str(a["login_status"]),
      last_error: str(a["last_error"]),
      browser_profile_id: browserId,
      window_name: windowName,
      group_id: groupId,
      group_name: groupName,
      has_password: nonEmpty(a["password"]),
      has_recovery_email: nonEmpty(a["recovery_email"]),
      has_secret: nonEmpty(a["secret_key"]),
      password: nonEmpty(a["password"]) ? String(a["password"]) : "",
      note,
      last_login_at: nonEmpty(a["last_login_at"]) ? String(a["last_login_at"]) : null,
      same_name_windows: sameNames.get(windowNameKey(a["email"])) ?? 0,
      updated_at: str(a["updated_at"]),
    };
  });

  const groupCounts = [...counts.entries()]
    .sort(([a], [b]) => groupOrder(a, b))
    .map(([groupId, v]) => ({ groupId, groupName: v.name, count: v.count }));
  return { rows, groups: groupCounts };
}
