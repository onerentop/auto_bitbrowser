/**
 * 自动修改 2SV 手机号
 * 对标 automation/auto_modify_2sv_phone.py
 */
import { printBanner, withEngine, type CommonOptions, type Result2 } from "./shared.ts";

export async function autoModify2svPhone(
  browserId: string,
  accountInfo: Record<string, unknown>,
  newPhone: string,
  options: CommonOptions = {},
): Promise<Result2> {
  const email = String(accountInfo["email"] ?? "Unknown");
  printBanner("修改 2SV 手机号 (StagehandGoogleEngine)", [`账号: ${email}`, `新手机号: ${newPhone}`]);

  return withEngine(
    browserId,
    // Python 侧此函数 close_after 默认为 True
    { ...options, closeAfter: options.closeAfter ?? true },
    async (engine) => {
      const result = await engine.modify2svPhone(newPhone);
      if (result.success) return [true, "2SV 手机号修改成功"] as Result2;
      return [false, result.message] as Result2;
    },
    (msg) => [false, `运行失败: ${msg}`] as Result2,
  );
}