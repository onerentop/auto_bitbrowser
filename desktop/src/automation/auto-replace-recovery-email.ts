/**
 * 自动替换辅助邮箱
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
      // 真机：恢复邮箱页会要求 Google 的「重新验证身份」，凭据从数据库账号取
      const result = await engine.replaceRecoveryEmail(newEmail, null, {
        password: String(accountInfo["password"] ?? ""),
        totpSecret: String(accountInfo["secret_key"] ?? ""),
      });
      if (result.success) return [true, "辅助邮箱替换成功", null] as Result3;
      // 失败时把 error 作为 error_type 带回
      return [false, result.message, result.error ?? null] as Result3;
    },
    (msg) => [false, `运行失败: ${msg}`, "exception"] as Result3,
  );
}