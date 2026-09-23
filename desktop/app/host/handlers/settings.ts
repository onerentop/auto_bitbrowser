/**
 * 设置页（配置 / 代理 / 账号数据） 的后端 handler
 *
 * 三个标签各自一个文件（settings/config.ts、proxies.ts、accounts.ts），这里合并成一张表。
 * 所有依赖都是惰性取用：构造分发表时不打开数据库、不读配置。
 */
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { createAccountsDataHandlers, type AccountsHandlerDeps } from "./settings/accounts.ts";
import { createConfigHandlers, type ConfigHandlerDeps } from "./settings/config.ts";
import { createProxiesHandlers } from "./settings/proxies.ts";

/** 测试注入点（生产环境不传） */
export type SettingsHandlerDeps = ConfigHandlerDeps & AccountsHandlerDeps;

export function createSettingsHandlers(ctx: HostContext, deps: SettingsHandlerDeps = {}): HostHandlerTable {
  return {
    ...createConfigHandlers(ctx, deps),
    ...createProxiesHandlers(ctx),
    ...createAccountsDataHandlers(ctx, deps),
  };
}
