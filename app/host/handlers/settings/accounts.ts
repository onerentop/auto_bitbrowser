/**
 * 设置页「账号数据」标签的 handler（列表 / 增删改 / 批量导入 / 导出 / 删除）
 */
import {
  isValidNewAccountEmail,
  parseAccountImportLine,
  parseImportText,
  type ImportedAccount,
} from "../../../shared/logic/settings-data.ts";
import { importAccounts } from "../../../../src/application/account-import.ts";
import { deleteAccountsByEmail, deleteAccountsFinishedLine } from "../../../../src/application/account-delete.ts";
import { createIxWindowOps } from "../../../../src/application/account-task-orchestrator.ts";
import {
  SETTINGS_INVOKE,
  SETTINGS_TASK_TYPES,
  type DeleteAccountsResultDto,
  type ImportResultDto,
  type SettingsAccountDto,
  type SettingsAccountInputDto,
} from "../../../shared/channels/settings.ts";
import type { TaskInfo } from "../../../shared/ipc.ts";
import type { HostContext } from "../../context.ts";
import type { HostHandlerTable } from "../../dispatch.ts";
import { MAX_IMPORT_TEXT_LENGTH, asArray, asRecord, asString, field, invalid } from "./validate.ts";

export const DELETE_ACCOUNTS_TASK_TYPE = SETTINGS_TASK_TYPES.deleteAccounts;

export interface AccountsHandlerDeps {
  /** 测试注入：跳过 ixBrowser 重试的真实等待 */
  sleep?: (ms: number) => Promise<void>;
}

/** 校验账号输入：邮箱 / 辅助邮箱 / 2FA 密钥 strip，密码原样 */
export function parseAccountInputArg(value: unknown): SettingsAccountInputDto {
  const o = asRecord(value, "account");
  return {
    email: field(o, "email").trim(),
    password: field(o, "password"),
    recovery_email: field(o, "recovery_email").trim(),
    secret_key: field(o, "secret_key").trim(),
  };
}

/** 校验待删除的邮箱列表：非空字符串数组，去重保序 */
export function parseEmailListArg(value: unknown): string[] {
  const emails = asArray(value, "emails").map((e, i) => asString(e, `emails[${i}]`));
  const out = [...new Set(emails.filter((e) => e.length > 0))];
  if (out.length === 0) invalid("请先勾选要删除的账号");
  return out;
}

export function createAccountsDataHandlers(ctx: HostContext, deps: AccountsHandlerDeps = {}): HostHandlerTable {
  return {
    /** 加载列表数据 */
    [SETTINGS_INVOKE.settingsAccountsList]: (): SettingsAccountDto[] =>
      ctx
        .accountRepo()
        .getAllAccounts()
        .map((a) => ({
          email: a.email,
          password: a.password ?? "",
          recovery_email: a.recovery_email ?? "",
          secret_key: a.secret_key ?? "",
          status: a.status ?? "",
        })),

    /** 新增账号：只在添加时校验邮箱，新增 status=pending */
    [SETTINGS_INVOKE.settingsAccountsAdd]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!isValidNewAccountEmail(data.email)) invalid("请输入有效的邮箱地址");
      return ctx.accountRepo().upsertAccount({ ...data, status: "pending" });
    },

    /** 编辑账号：不改状态 */
    [SETTINGS_INVOKE.settingsAccountsUpdate]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!data.email) invalid("邮箱不能为空");
      return ctx.accountRepo().upsertAccount(data);
    },

    /**
     * 批量导入账号：后端按同一纯函数重新解析文本（不信任渲染层预览），
     * 写库与计数规则见 src/application/account-import.ts（整批一个事务）。
     */
    [SETTINGS_INVOKE.settingsAccountsImport]: (text: unknown): ImportResultDto => {
      const raw = asString(text, "text", MAX_IMPORT_TEXT_LENGTH);
      const valid: ImportedAccount[] = [];
      for (const row of parseImportText(raw, parseAccountImportLine)) {
        if (row.result.ok) valid.push(row.result.data);
      }
      if (valid.length === 0) invalid("没有可导入的有效数据");
      return importAccounts(ctx.accountRepo(), valid);
    },

    /**
     * 批量删除账号（同时删除数据库里绑定的窗口；规则见 src/application/account-delete.ts）。
     * 删窗口要调 ixBrowser（带重试，ixBrowser 未启动时单个账号就要等数秒），
     * 可能超过主进程 30s 转发超时，因此作为后台任务运行，立即返回 TaskInfo。
     */
    [SETTINGS_INVOKE.settingsAccountsDelete]: (emailsArg: unknown): TaskInfo => {
      const emails = parseEmailListArg(emailsArg);
      const total = emails.length;

      return ctx.tasks.start(DELETE_ACCOUNTS_TASK_TYPE, `删除 ${total} 个账号`, async (api) => {
        api.log(`开始删除 ${total} 个账号，将同时删除已绑定的 ixBrowser 窗口`);
        api.progress(0, total);
        const results = await deleteAccountsByEmail({
          emails,
          repo: ctx.accountRepo(),
          windowOps: createIxWindowOps({
            client: () => ctx.ix(),
            log: api.log,
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
          }),
          shouldStop: api.shouldStop,
          log: api.log,
          progress: (i) => api.progress(i, total),
          item: api.item,
        });
        api.log(deleteAccountsFinishedLine(results));
        const result: DeleteAccountsResultDto = results;
        return result;
      });
    },
  };
}
