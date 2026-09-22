/**
 * 自动替换辅助邮箱
 * 对标 automation/auto_replace_recovery_email.py
 */
import { printBanner, withEngine, type CommonOptions, type Result3 } from "./shared.ts";

export async function autoReplaceRecoveryEmail(
  browserId: string,
  accountInfo: Record<string, unknown>,
  newEmail: string,
  options: CommonOptions & { poolEmails?: string[] | null } = {},
): Promise<Result3> {
  const email = String(accountInfo["email"] ?? "Unknown");
  const lines = [`账号: ${email}`, `新辅助邮箱: ${newEmail}`];
  if (options.poolEmails?.length) lines.push(`邮箱池: ${options.poolEmails.length} 个邮箱`);
  printBanner("替换辅助邮箱 (StagehandGoogleEngine)", lines);

  return withEngine(
    browserId,
    { ...options, closeAfter: options.closeAfter ?? false },
    async (engine) => {
      const result = await engine.replaceRecoveryEmail(newEmail);
      if (result.success) return [true, "辅助邮箱替换成功", null] as Result3;
      // 失败时把 error 作为 error_type 带回，与 Python 一致
      return [false, result.message, result.error ?? null] as Result3;
    },
    (msg) => [false, `运行失败: ${msg}`, "exception"] as Result3,
  );
}