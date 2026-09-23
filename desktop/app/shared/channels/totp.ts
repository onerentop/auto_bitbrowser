/**
 * TOTP 密钥导入页 的 IPC 通道与类型
 *
 * 命名 `abb/totp/动作`。每新增一个通道：常量登记在 TOTP_INVOKE，
 * 参数与返回类型写在 TotpInvokeMap，后端实现在 app/host/handlers/totp.ts。
 * 本文件是纯 TS，不依赖 electron。
 */

export const TOTP_INVOKE = {} as const;

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TotpInvokeMap {}
