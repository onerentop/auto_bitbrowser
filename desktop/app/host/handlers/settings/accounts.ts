/**
 * 设置页「账号数据」标签的 handler —— 对标 gui/data_management/accounts_tab.py 的 AccountsTab
 * 与 batch_import_dialog.py 的 AccountBatchImportDialog
 */
import {
  buildAccountImportUpsert,
  isValidNewAccountEmail,
  parseAccountImportLine,
  parseImportText,
  type ImportedAccount,
} from "../../../../src/application/settings-data.ts";
import { deleteBrowserById, findBrowserByEmail, type IxWindowDeps } from "../../../../src/ixbrowser/window.ts";
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

/** 照搬 AccountEditDialog.get_data（accounts_tab.py:70-76）：邮箱 / 辅助邮箱 / 2FA strip，密码原样 */
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
    /** 对标 AccountsTab.loadData（accounts_tab.py:230-273） */
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

    /** 对标 AccountsTab.addAccount（accounts_tab.py:286-318）：只在添加时校验邮箱，新增 status=pending */
    [SETTINGS_INVOKE.settingsAccountsAdd]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!isValidNewAccountEmail(data.email)) invalid("请输入有效的邮箱地址");
      return ctx.accountRepo().upsertAccount({ ...data, status: "pending" });
    },

    /** 对标 AccountsTab.editAccount（accounts_tab.py:320-341）：不改状态 */
    [SETTINGS_INVOKE.settingsAccountsUpdate]: (account: unknown): boolean => {
      const data = parseAccountInputArg(account);
      if (!data.email) invalid("邮箱不能为空");
      return ctx.accountRepo().upsertAccount(data);
    },

    /**
     * 对标 AccountBatchImportDialog._validateInputs + save_record（batch_import_dialog.py:128-166, 211-230）。
     * 后端按同一纯函数重新解析文本；逐条保存。整个导入包在一个事务里，只为减少磁盘同步次数。
     *
     * 与 Python 的计数差异（有意保留）：
     *   - 失败计数：Python 的 save_record 忽略 upsert_account 的返回值、恒返回 True，
     *     只有抛异常才计 fail 并继续下一条，所以单条写库失败（upsert 内部吞掉异常返回 False）
     *     在 Python 里仍计为成功；这里把 upsertAccount 返回 false 计为 fail，计数更真实。
     *   - 事务回滚：Python 无事务，逐条立即提交，中途异常只影响那一条；这里若循环中抛出
     *     未被 upsertAccount 吞掉的异常，会 ROLLBACK 整批并把错误抛给界面，已写入的条目也不保留。
     */
    [SETTINGS_INVOKE.settingsAccountsImport]: (text: unknown): ImportResultDto => {
      const raw = asString(text, "text", MAX_IMPORT_TEXT_LENGTH);
      const valid: ImportedAccount[] = [];
      for (const row of parseImportText(raw, parseAccountImportLine)) {
        if (row.result.ok) valid.push(row.result.data);
      }
      if (valid.length === 0) invalid("没有可导入的有效数据");

      const repo = ctx.accountRepo();
      const db = ctx.db();
      let success = 0;
      let fail = 0;
      db.exec("BEGIN");
      try {
        for (const data of valid) {
          const exists = repo.getAccountByEmail(data.email) !== null;
          if (repo.upsertAccount(buildAccountImportUpsert(data, exists))) success += 1;
          else fail += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { success_count: success, fail_count: fail };
    },

    /**
     * 对标 AccountsTab.deleteSelected（accounts_tab.py:343-398）。
     * 每个账号都要按邮箱查 ixBrowser 窗口（带重试，ixBrowser 未启动时单个账号就要等数秒），
     * 可能超过主进程 30s 转发超时，因此作为后台任务运行，立即返回 TaskInfo。
     * 语义照搬：找到窗口先关闭（忽略错误）再删除，删除成功才计数；无论窗口是否删成，账号都删除。
     */
    [SETTINGS_INVOKE.settingsAccountsDelete]: (emailsArg: unknown): TaskInfo => {
      const emails = parseEmailListArg(emailsArg);
      const total = emails.length;

      return ctx.tasks.start(DELETE_ACCOUNTS_TASK_TYPE, `删除 ${total} 个账号`, async (api) => {
        const ixDeps: IxWindowDeps = {
          client: ctx.ix(),
          log: (m) => api.log(m),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        };
        let deletedAccounts = 0;
        let deletedWindows = 0;

        api.log(`确定删除 ${total} 个账号，将同时删除对应的 ixBrowser 窗口`);
        for (let i = 0; i < total; i++) {
          if (api.shouldStop()) {
            api.log("任务已停止");
            break;
          }
          const email = emails[i] as string;
          let note = "";
          api.log(`[${i + 1}/${total}] 删除账号: ${email}`);

          try {
            const profileId = await findBrowserByEmail(ixDeps, email);
            if (profileId) {
              try {
                await ctx.ix().closeProfile(profileId);
              } catch {
                // 照搬 accounts_tab.py:373-376：关闭失败忽略
              }
              try {
                if (await deleteBrowserById(ixDeps, profileId)) {
                  deletedWindows += 1;
                  api.log(`  ✓ 已删除窗口 ${profileId}`);
                  note = `已删除窗口 ${profileId}`;
                } else {
                  api.log(`  ✗ 窗口 ${profileId} 删除失败`);
                  note = `窗口 ${profileId} 删除失败`;
                }
              } catch {
                // 照搬 accounts_tab.py:381-382
              }
            } else {
              api.log("  未找到对应窗口");
              note = "未找到对应窗口";
            }
          } catch {
            // 照搬 accounts_tab.py:383-384
          }

          ctx.accountRepo().deleteAccount(email);
          deletedAccounts += 1;
          // 逐条目结果（任务历史用）：窗口那一侧的成败放进消息里，账号删除语义照搬 Python（必然删账号）
          api.item(email, "成功", note);
          api.progress(i + 1, total);
        }

        // 对标完成提示（accounts_tab.py:392）
        api.log(`删除完成: 已删除 ${deletedAccounts} 个账号` + (deletedWindows > 0 ? `，${deletedWindows} 个窗口` : ""));
        const result: DeleteAccountsResultDto = { deleted_accounts: deletedAccounts, deleted_windows: deletedWindows };
        return result;
      });
    },
  };
}
