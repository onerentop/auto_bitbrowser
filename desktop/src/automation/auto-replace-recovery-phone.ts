/**
 * 自动替换辅助手机号
 * 对标 automation/auto_replace_recovery_phone.py
 */
import { printBanner, withEngine, type CommonOptions, type Result2 } from "./shared.ts";

export async function autoReplaceRecoveryPhone(
  browserId: string,
  accountInfo: Record<string, unknown>,
  newPhone: string,
  options: CommonOptions = {},
): Promise<Result2> {
  const email = String(accountInfo["email"] ?? "Unknown");
  printBanner("替换辅助手机号 (StagehandGoogleEngine)", [`账号: ${email}`, `新手机号: ${newPhone}`]);

  return withEngine(
    browserId,
    { ...options, closeAfter: options.closeAfter ?? false },
    async (engine) => {
      const result = await engine.replaceRecoveryPhone(newPhone);
      if (result.success) return [true, "辅助手机号替换成功"] as Result2;
      return [false, result.message] as Result2;
    },
    (msg) => [false, `运行失败: ${msg}`] as Result2,
  );
}