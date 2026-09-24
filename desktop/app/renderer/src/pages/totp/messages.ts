/**
 * TOTP 导入页的确认 / 完成文案
 */
import type { TotpEntry, TotpImportResult, TotpMatchStatus } from "../../../../shared/channels/totp.ts";

export interface SelectedForImport {
  entry: TotpEntry;
  status: TotpMatchStatus;
}

/** 确认导入文案 */
export function importConfirmMessage(selected: readonly SelectedForImport[]): string {
  const overwriteCount = selected.filter((r) => r.status === "has_secret").length;
  const newCount = selected.length - overwriteCount;
  // 检查是否有密码需要更新
  const passwordUpdateCount = selected.filter((r) => r.entry.kind === "text" && r.entry.password).length;

  let msg = `即将导入 ${selected.length} 个账号的 TOTP 密钥:\n\n`;
  msg += `  新增密钥: ${newCount} 个\n`;
  if (overwriteCount > 0) msg += `  覆盖已有: ${overwriteCount} 个\n`;
  if (passwordUpdateCount > 0) msg += `  同时更新密码: ${passwordUpdateCount} 个\n`;
  msg += "\n确定要继续吗？";
  return msg;
}

export interface FinishedNotice {
  level: "info" | "warning" | "error";
  title: string;
  message: string;
}

/** 完成汇总 */
export function importFinishedNotice(r: TotpImportResult): FinishedNotice {
  const failedCount = r.failed_list.length;
  const warningCount = r.warning_list.length;

  let msg = `成功导入 ${r.success_count}/${r.total_count} 个账号的 TOTP 密钥`;
  if (failedCount > 0) msg += `\n✗ 失败 ${failedCount} 个`;
  if (warningCount > 0) msg += `\n⚠ 警告 ${warningCount} 个（窗口更新失败）`;
  if (r.password_count > 0) msg += `\n已更新 ${r.password_count} 个密码`;
  if (r.bind_count > 0) msg += `\n已自动绑定 ${r.bind_count} 个窗口`;
  if (r.ix_update_count > 0) msg += `\n已更新 ${r.ix_update_count} 个窗口备注`;
  // 停止是本地新增的能力；停止时补一行说明
  if (r.skipped_count > 0) msg += `\n已停止，${r.skipped_count} 个未处理`;

  if (failedCount > 0) return { level: "error", title: "导入完成（有失败）", message: msg };
  if (warningCount > 0) return { level: "warning", title: "导入完成（有警告）", message: msg };
  return { level: "info", title: "导入完成", message: msg };
}

/** 任务结果是否是导入结果（跨进程传来的是 unknown） */
export function isImportResult(value: unknown): value is TotpImportResult {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return typeof o["success_count"] === "number" && Array.isArray(o["failed_list"]) && Array.isArray(o["warning_list"]);
}
