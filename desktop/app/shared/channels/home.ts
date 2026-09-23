/**
 * 首页（ixBrowser 窗口管理） 的 IPC 通道与类型
 *
 * 命名 `abb/home/动作`。每新增一个通道：
 *   1. 在 HOME_INVOKE 里登记常量
 *   2. 在 HomeInvokeMap 里写参数元组与返回类型
 *   3. 在 app/host/handlers/home.ts 里实现
 * ipc.ts 会把这里的通道并入总表；类型检查保证三处一致。
 * 本文件是纯 TS，不依赖 electron。
 */

export const HOME_INVOKE = {} as const;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface HomeInvokeMap {}
