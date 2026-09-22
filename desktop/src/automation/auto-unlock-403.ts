/**
 * 自动解锁 403 账号
 * 对标 automation/auto_unlock_403.py
 *
 * 与其它 auto_* 的最大区别：这是**带重试的外层循环**——
 * 每次重试都重新取号（旧号码作废），共 maxRetries 次。
 * 无论成功失败，每轮结束都要取消号码请求，避免占用额度。
 */
import type { AccountRepository } from "../db/account-repository.ts";
import { printBanner, connectEngine, type CommonOptions } from "./shared.ts";
import type { StagehandGoogleEngine } from "../engine/stagehand-engine.ts";

/** SMS-Bus 客户端接口（只需这四个能力） */
export interface UnlockSmsClient {
  getNumber(options: {
    countryId?: number;
    projectId?: number;
    preferCheapest?: boolean;
  }): Promise<[{ request_id: number; number: string; country_name: string; cost: number } | null, string | null]>;
  cancelRequest(requestId: number): Promise<unknown>;
}

export interface Unlock403Options extends CommonOptions {
  validationUrl?: string | null;
  smsClient: UnlockSmsClient;
  countryId?: number | null;
  projectId?: number | null;
  maxRetries?: number | null;
  smsTimeoutSeconds?: number;
  smsIntervalSeconds?: number;
  callback?: ((msg: string) => void) | null;
  accountRepo?: AccountRepository;
}

export interface AutoUnlockResult {
  success: boolean;
  message: string;
  email: string;
  phoneUsed: string;
  attempts: number;
  errorType?: string | null;
}

export async function autoUnlock403(
  browserId: string,
  account: Record<string, unknown>,
  options: Unlock403Options,
): Promise<AutoUnlockResult> {
  const email = String(account["email"] ?? "");
  const log = (msg: string) => {
    process.stdout.write(`[Unlock403] ${email}: ${msg}\n`);
    options.callback?.(`[${email}] ${msg}`);
  };

  printBanner("403 解锁 (StagehandGoogleEngine)", [`账号: ${email}`]);
  options.accountRepo?.updateUnlockStatus(email, "unlocking");

  const maxRetries = options.maxRetries ?? 3;
  const smsTimeout = options.smsTimeoutSeconds ?? 120;
  const smsInterval = options.smsIntervalSeconds ?? 5;

  let attempts = 0;
  let lastError = "";
  let phoneUsed = "";

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    attempts = attempt + 1;
    log(`=== 尝试 ${attempts}/${maxRetries} ===`);

    let phone: { request_id: number; number: string; country_name: string; cost: number } | null = null;
    let engine: StagehandGoogleEngine | null = null;

    try {
      log("获取手机号...");
      const [gotPhone, err] = await options.smsClient.getNumber({
        countryId: options.countryId ?? undefined,
        projectId: options.projectId ?? undefined,
        preferCheapest: true,
      });
      phone = gotPhone;
      if (!phone) {
        lastError = err ?? "无法获取手机号";
        log(`❌ ${lastError}`);
        continue; // 取号失败，直接下一轮
      }

      // 与 Python 的 formatted_number 一致：无 + 前缀时补上
      phoneUsed = phone.number.startsWith("+") ? phone.number : `+${phone.number}`;
      log(`✅ 获取到手机号: ${phoneUsed} (${phone.country_name}, cost: $${phone.cost})`);

      engine = await connectEngine(browserId, { ...options, closeAfter: false });

      const result = await engine.unlock403({
        validationUrl: options.validationUrl ?? null,
        phoneNumber: phoneUsed,
        countryName: phone.country_name || "United States",
        // 引擎侧的解锁操作需要取码与轮询能力，这里适配其接口
        smsClient: {
          getSmsCode: async () => {
            const sms = options.smsClient as unknown as {
              getSms(requestId: number): Promise<[string | null, string | null]>;
            };
            const [code] = await sms.getSms(phone!.request_id);
            return code;
          },
        },
        requestId: String(phone.request_id),
        smsTimeoutSeconds: smsTimeout,
        smsIntervalSeconds: smsInterval,
      });

      if (result.success) {
        log("✅ 403 解锁成功");
        options.accountRepo?.updateUnlockStatus(email, "unlocked");
        try {
          await options.smsClient.cancelRequest(phone.request_id);
        } catch {
          /* 释放失败不影响成功结论 */
        }
        return { success: true, message: "403 解锁成功", email, phoneUsed, attempts };
      }

      lastError = `验证失败: ${result.message}`;
      log(`❌ ${lastError}`);
      try {
        await options.smsClient.cancelRequest(phone.request_id);
      } catch {
        /* ignore */
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`❌ 异常: ${lastError}`);
      if (phone) {
        try {
          await options.smsClient.cancelRequest(phone.request_id);
        } catch {
          /* ignore */
        }
      }
    } finally {
      if (engine) {
        try {
          await engine.stop(false);
        } catch {
          /* ignore */
        }
      }
    }
  }

  log(`❌ 解锁失败，已重试 ${attempts} 次`);
  options.accountRepo?.updateUnlockStatus(email, "unlock_failed");
  return {
    success: false,
    message: `解锁失败: ${lastError}`,
    email,
    phoneUsed,
    attempts,
    errorType: "max_retries_exceeded",
  };
}