/**
 * 后端进程的完整分发表：把各领域 handler 合并成一张表
 *
 * 合并时检查重名：两个领域登记了同一个通道属于编程错误，启动即报错，
 * 而不是让后登记的静默覆盖前一个。
 */
import type { HostHandlerTable } from "../dispatch.ts";
import type { HostContext } from "../context.ts";
import { createHealthHandlers } from "./health.ts";
import { createTaskHandlers } from "./task.ts";
import { createSettingsHandlers } from "./settings.ts";
import { createHomeHandlers } from "./home.ts";
import { createAccountsHandlers } from "./accounts.ts";
import { createAiTasksHandlers } from "./ai-tasks.ts";
import { createTotpHandlers } from "./totp.ts";
import { createTaskHistoryHandlers } from "./task-history.ts";

export function mergeHandlers(...tables: HostHandlerTable[]): HostHandlerTable {
  const merged: Record<string, HostHandlerTable[string]> = {};
  for (const table of tables) {
    for (const [channel, handler] of Object.entries(table)) {
      if (Object.prototype.hasOwnProperty.call(merged, channel)) {
        throw new Error(`通道重复登记: ${channel}`);
      }
      merged[channel] = handler;
    }
  }
  return merged;
}

export function createHostHandlers(ctx: HostContext): HostHandlerTable {
  return mergeHandlers(
    createHealthHandlers(),
    createTaskHandlers(ctx.tasks),
    createSettingsHandlers(ctx),
    createHomeHandlers(ctx),
    createAccountsHandlers(ctx),
    createAiTasksHandlers(ctx),
    createTotpHandlers(ctx),
    createTaskHistoryHandlers(ctx),
  );
}
