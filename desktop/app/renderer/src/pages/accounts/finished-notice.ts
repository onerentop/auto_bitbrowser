/**
 * 账号管理页任务完成后的提示框文案 —— 照搬 gui/account_manager_interface.py 各 finished 回调里的 _showInfo：
 *   - 批量绑定完成：_onBatchBindFinished（:1013）
 *   - 检测 403 完成：_onDetect403Finished（:1196-1205）
 *   - 批量删除完成：_onBatchDeleteFinished（:1789-1792）
 *   - 开启共享完成：_onEnableFamilySharingFinished（:2190-2208）
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

    case "detect_403": {
      const total = num(r, "total");
      const needsUnlock = num(r, "needs_unlock");
      if (needsUnlock > 0) {
        const accounts = Array.isArray(r["accounts"]) ? r["accounts"].map(String) : [];
        return {
          title: "检测完成",
          message:
            `共检测 ${total} 个已关联账号\n` +
            `发现 ${needsUnlock} 个需要解锁\n\n` +
            `账号: ${accounts.slice(0, 5).join(", ")}` +
            (needsUnlock > 5 ? `\n...等 ${needsUnlock} 个` : ""),
        };
      }
      return { title: "检测完成", message: `共检测 ${total} 个账号，无需解锁` };
    }

    case "batch_delete": {
      const deletedAccounts = num(r, "deleted_accounts");
      if (e.label === DELETE_ACCOUNTS_ONLY_LABEL) {
        return { title: "删除完成", message: `已删除 ${deletedAccounts} 个账号` };
      }
      return { title: "删除完成", message: `已删除 ${deletedAccounts} 个账号\n已删除 ${num(r, "deleted_windows")} 个窗口` };
    }

    case "enable_family_sharing": {
      const familyCreated = num(r, "family_created_count");
      let msg = "开启家庭共享完成\n\n";
      msg += `成功: ${num(r, "success_count")}\n`;
      if (familyCreated > 0) msg += `  ↳ 其中新建家庭组: ${familyCreated}\n`;
      msg += `已开启（跳过）: ${num(r, "already_enabled_count")}\n`;
      msg += `失败: ${num(r, "failed_count")}\n`;
      const failed = Array.isArray(r["failed_list"]) ? r["failed_list"].map(obj) : [];
      if (failed.length) {
        msg += "\n失败账户:\n";
        for (const item of failed.slice(0, 5)) {
          let errorText = String(item["error"] ?? "");
          if (errorText.length > 30) errorText = `${errorText.slice(0, 30)}...`;
          msg += `  • ${String(item["email"] ?? "")}: ${errorText}\n`;
        }
        if (failed.length > 5) msg += `  ... 等 ${failed.length} 个\n`;
      }
      return { title: "完成", message: msg };
    }

    default:
      return null;
  }
}
