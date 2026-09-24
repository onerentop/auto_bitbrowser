/**
 * 账号管理页任务完成后的提示框文案 —— 照搬 gui/account_manager_interface.py 各 finished 回调里的 _showInfo：
 *   - 批量绑定完成：_onBatchBindFinished（:1013）
 *   - 批量删除完成：_onBatchDeleteFinished（:1789-1792）
 * 只在任务成功结束时调用；失败 / 停止由全局任务坞提示。
 */
import type { TaskFinishedEvent } from "../../../../shared/ipc.ts";
import { DELETE_ACCOUNTS_ONLY_LABEL } from "../../../../shared/channels/accounts.ts";

export interface FinishedNotice {
  title: string;
  message: string;
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function num(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  return typeof v === "number" ? v : 0;
}

export function finishedNotice(e: Pick<TaskFinishedEvent, "type" | "label" | "outcome" | "result">): FinishedNotice | null {
  if (e.outcome !== "succeeded") return null;
  const r = obj(e.result);

  switch (e.type) {
    case "batch_bind":
      return { title: "绑定完成", message: `成功绑定 ${num(r, "success_count")}/${num(r, "total")} 个账号` };

    case "batch_delete": {
      const deletedAccounts = num(r, "deleted_accounts");
      if (e.label === DELETE_ACCOUNTS_ONLY_LABEL) {
        return { title: "删除完成", message: `已删除 ${deletedAccounts} 个账号` };
      }
      return { title: "删除完成", message: `已删除 ${deletedAccounts} 个账号\n已删除 ${num(r, "deleted_windows")} 个窗口` };
    }

    case "health_check":
      return {
        title: "巡检完成",
        message:
          `正常 ${num(r, "ok")} 个\n需要登录 ${num(r, "need_login")} 个\n` +
          `已停用 ${num(r, "suspended")} 个\n窗口异常 ${num(r, "window_error")} 个`,
      };

    default:
      return null;
  }
}
