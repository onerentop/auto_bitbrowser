/**
 * 自动开启家庭组共享
 * 对标 automation/auto_enable_family_sharing.py
 */
import type { AccountRepository } from "../db/account-repository.ts";
import { printBanner, withEngine } from "./shared.ts";

export interface EnableSharingResult {
  success: boolean;
  message: string;
  email: string;
  errorType?: string | null;
  wasAlreadyEnabled?: boolean;
  familyCreated?: boolean;
}

export async function autoEnableFamilySharing(
  browserId: string,
  account: Record<string, unknown>,
  options: {
    callback?: ((msg: string) => void) | null;
    closeBrowserOnSuccess?: boolean;
    accountRepo?: AccountRepository;
  } = {},
): Promise<EnableSharingResult> {
  const email = String(account["email"] ?? "");
  const log = (msg: string) => {
    process.stdout.write(`[EnableFamilySharing] ${email}: ${msg}\n`);
    options.callback?.(`[${email}] ${msg}`);
  };

  log("开始开启家庭组共享...");
  const closeAfter = options.closeBrowserOnSuccess ?? false;

  return withEngine(
    browserId,
    { closeAfter },
    async (engine): Promise<EnableSharingResult> => {
      log("StagehandGoogleEngine 已连接");
      log("执行开启家庭共享...");

      const result = await engine.enableFamilySharing();

      if (result.success) {
        log("[OK] 家庭共享已开启");
        options.accountRepo?.updateFamilySharingStatus(email, true);

        if (result.family_created) {
          options.accountRepo?.updateFamilyMemberCount(email, 1);
          log("已创建新的家庭组");
        }

        return {
          success: true,
          message: result.was_already_enabled ? "家庭共享已处于开启状态" : "家庭共享已开启",
          email,
          wasAlreadyEnabled: result.was_already_enabled,
          familyCreated: result.family_created,
        };
      }

      const errorMsg = result.error || result.message || "开启家庭共享失败";
      log(`[X] ${errorMsg}`);
      return { success: false, message: errorMsg, email, errorType: "enable_sharing_failed" };
    },
    (msg): EnableSharingResult => {
      log(`[X] 异常: ${msg}`);
      return { success: false, message: `开启家庭共享异常: ${msg}`, email, errorType: "exception" };
    },
  );
}

/** 批量版，对标 batch_enable_family_sharing */
export async function batchEnableFamilySharing(
  accounts: Record<string, unknown>[],
  browserIds: string[],
  options: {
    callback?: ((msg: string) => void) | null;
    closeBrowserOnSuccess?: boolean;
    accountRepo?: AccountRepository;
  } = {},
): Promise<{ total: number; successCount: number; failedCount: number; results: EnableSharingResult[] }> {
  const results: EnableSharingResult[] = [];
  let successCount = 0;
  let failedCount = 0;
  const log = (msg: string) => {
    process.stdout.write(`[BatchEnableSharing] ${msg}\n`);
    options.callback?.(msg);
  };

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i] as Record<string, unknown>;
    const email = String(account["email"] ?? "");
    log(`[${i + 1}/${accounts.length}] 处理: ${email}`);

    const result = await autoEnableFamilySharing(browserIds[i] ?? "", account, options);
    results.push(result);
    if (result.success) {
      successCount += 1;
      log(`[${email}] ✅ 成功`);
    } else {
      failedCount += 1;
      log(`[${email}] ❌ 失败: ${result.message}`);
    }
  }

  return { total: accounts.length, successCount, failedCount, results };
}