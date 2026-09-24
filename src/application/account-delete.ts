/**
 * 设置页「账号数据」的删除选中：按邮箱删除账号，并删除数据库里绑定的 ixBrowser 窗口。
 *
 * 规则与账号管理页的批量删除一致（见 executeBatchDelete）：
 *   - 窗口只看数据库绑定（browser_profile_id）；未绑定的账号只删账号，ixBrowser 里的同名窗口不动；
 *   - 先删账号，删成功才关闭并删除窗口；
 *   - 库里没删掉（含库里本来就没有该账号）计为失败，任务历史条目记「失败」。
 */
import type { AccountRepository } from "../db/account-repository.ts";
import { dbBrowserId } from "./account-plan.ts";
import { executeBatchDelete, type BatchDeleteResults, type LogFn, type WindowOps } from "./account-task-orchestrator.ts";

export async function deleteAccountsByEmail(params: {
  emails: readonly string[];
  repo: Pick<AccountRepository, "getAccountByEmail" | "deleteAccount">;
  windowOps: WindowOps;
  shouldStop: () => boolean;
  log: LogFn;
  progress: (current: number) => void;
  /** 逐条目结果（任务历史用） */
  item?: (key: string, status: string, message: string) => void;
}): Promise<BatchDeleteResults> {
  const { repo } = params;
  // 库里没有的账号按 { email } 传入、窗口 ID 为空：deleteAccount 返回 false，计为失败
  const accounts = params.emails.map((email) => repo.getAccountByEmail(email) ?? { email });
  return executeBatchDelete({
    accounts,
    browserIds: accounts.map(dbBrowserId),
    withWindows: true,
    shouldStop: params.shouldStop,
    deleteAccount: (email) => repo.deleteAccount(email),
    closeBrowser: params.windowOps.closeBrowser,
    deleteBrowser: params.windowOps.deleteBrowser,
    log: params.log,
    progress: params.progress,
    ...(params.item ? { item: params.item } : {}),
  });
}

/** 任务结束时的汇总日志 */
export function deleteAccountsFinishedLine(r: BatchDeleteResults): string {
  return (
    `删除完成: 已删除 ${r.deleted_accounts} 个账号` +
    (r.deleted_windows > 0 ? `，${r.deleted_windows} 个窗口` : "") +
    (r.failed_count > 0 ? `，失败 ${r.failed_count} 个` : "")
  );
}
