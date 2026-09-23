/**
 * 5 个 AI 批量任务页（替换手机号 / 替换辅助邮箱 / 修改2SV手机 / 修改验证器 / 踢出设备） 的 IPC 通道与类型
 *
 * 命名 `abb/aiTasks/动作`。每新增一个通道：常量登记在 AI_TASKS_INVOKE，
 * 参数与返回类型写在 AiTasksInvokeMap，后端实现在 app/host/handlers/ai-tasks.ts。
 * 本文件是纯 TS，不依赖 electron。
 */

export const AI_TASKS_INVOKE = {} as const;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AiTasksInvokeMap {}
