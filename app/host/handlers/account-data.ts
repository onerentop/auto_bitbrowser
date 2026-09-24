/**
 * 账号管理页的「账号数据」handler：按邮箱取原文 / 添加 / 编辑 / 批量导入 / 导出
 *
 * 从原设置页「账号数据」标签迁来（设置页已不再提供账号数据）。
 * 列表（abb/accounts/list）只下发有 / 无；原文只在这里按邮箱单独取（编辑弹窗）或整段导出。
 * handler 只做参数校验与调用：导入规则在 src/application/account-import.ts，导出格式在 shared/logic/settings-data.ts。
 */
import {
  buildAccountExportText,
  isValidNewAccountEmail,
  parseAccountImportLine,
  parseImportText,
  type ImportedAccount,
} from "../../shared/logic/settings-data.ts";
import { importAccounts } from "../../../src/application/account-import.ts";
import {
  ACCOUNTS_INVOKE,
  type AccountDetail,
  type AccountsExportResult,
} from "../../shared/channels/accounts.ts";
import type { ImportResultDto } from "../../shared/channels/settings.ts";
import type { HostContext } from "../context.ts";
import type { HostHandlerTable } from "../dispatch.ts";
import { MAX_IMPORT_TEXT_LENGTH, asArray, asRecord, asString, field, invalid } from "./settings/validate.ts";

/** 校验账号输入：邮箱 / 辅助邮箱 / 2FA 密钥 strip，密码原样 */
export function parseAccountInputArg(value: unknown): AccountDetail {
  const o = asRecord(value, "account");
  return {
    email: field(o, "email").trim(),
    password: field(o, "password"),
    recovery_email: field(o, "recovery_email").trim(),
    secret_key: field(o, "secret_key").trim(),
  };
}

/** 校验邮箱列表：字符串数组，去掉空串后去重保序；为空时拒绝 */
export function parseEmailListArg(value: unknown, emptyMessage: string): string[] {
  const emails = asArray(value, "emails").map((e, i) => asString(e, `emails[${i}]`));
  const out = [...new Set(emails.filter((e) => e.length > 0))];
  if (out.length === 0) invalid(emptyMessage);
  return out;
}

export function createAccountDataHandlers(ctx: HostContext): HostHandlerTable {
  const repo = () => ctx.accountRepo();
  return {
    /** 按邮箱取原文（编辑弹窗打开时调用） */
    [ACCOUNTS_INVOKE.accountsGet]: (email: unknown): AccountDetail => {
      const e = asString(email, "email").trim();
      if (!e) invalid("email 不能为空");
      const a = repo().getAccountByEmail(e);
      if (!a) invalid(`未找到账号: ${e}`);
      return {
        email: a.email,
        password: a.password ?? "",
        recovery_email: a.recovery_email ?? "",
        secret_key: a.secret_key ?? "",
      };
    },

    /** 添加账号：只在添加时校验邮箱，新增 status=pending */
    [ACCOUNTS_INVOKE.accountsAdd]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!isValidNewAccountEmail(data.email)) invalid("请输入有效的邮箱地址");
      return repo().upsertAccount({ ...data, status: "pending" });
    },

    /** 编辑账号：不改状态 */
    [ACCOUNTS_INVOKE.accountsUpdate]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!data.email) invalid("邮箱不能为空");
      if (!repo().getAccountByEmail(data.email)) invalid(`未找到账号: ${data.email}`);
      return repo().upsertAccount(data);
    },

    /**
     * 批量导入：后端按同一纯函数重新解析文本（不信任渲染层预览），
     * 写库与计数规则见 src/application/account-import.ts（整批一个事务）。
     */
    [ACCOUNTS_INVOKE.accountsImport]: (text: unknown): ImportResultDto => {
      const raw = asString(text, "text", MAX_IMPORT_TEXT_LENGTH);
      const valid: ImportedAccount[] = [];
      for (const row of parseImportText(raw, parseAccountImportLine)) {
        if (row.result.ok) valid.push(row.result.data);
      }
      if (valid.length === 0) invalid("没有可导入的有效数据");
      return importAccounts(repo(), valid);
    },

    /** 导出选中：按传入顺序，库里没有的跳过；文本格式与原设置页导出一致 */
    [ACCOUNTS_INVOKE.accountsExportText]: (emails: unknown): AccountsExportResult => {
      const list = parseEmailListArg(emails, "请先勾选要导出的账号");
      const found = list.flatMap((e) => {
        const a = repo().getAccountByEmail(e);
        return a
          ? [{ email: a.email, password: a.password ?? "", recovery_email: a.recovery_email ?? "", secret_key: a.secret_key ?? "" }]
          : [];
      });
      return { text: buildAccountExportText(found), count: found.length };
    },
  };
}
