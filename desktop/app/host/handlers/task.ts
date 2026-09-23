/**
 * 任务控制通道：查询当前任务、请求停止
 * 各业务任务的「启动」通道在各自领域的 handler 里（它们调用 ctx.tasks.start）。
 */
import { IPC, type TaskInfo } from "../../shared/ipc.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import type { TaskRunner } from "../task-runner.ts";

export function createTaskHandlers(tasks: TaskRunner): HostHandlerTable {
  return {
    [IPC.invoke.taskGetCurrent]: (): TaskInfo | null => tasks.current(),
    [IPC.invoke.taskStop]: (): boolean => tasks.stop(),
  };
}
