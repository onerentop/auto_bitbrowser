/**
 * 自动踢出非本机登录设备
 * 对标 automation/auto_kick_devices.py
 */
import { printBanner, withEngine, type CommonOptions, type Result2 } from "./shared.ts";

export async function autoKickDevices(
  browserId: string,
  accountInfo: Record<string, unknown>,
  options: CommonOptions = {},
): Promise<Result2 & { kickedCount: number }> {
  const email = String(accountInfo["email"] ?? "Unknown");
  printBanner("踢出非本机登录设备 (StagehandGoogleEngine)", [`账号: ${email}`]);

  let kickedCount = 0;
  const [ok, message] = await withEngine(
    browserId,
    { ...options, closeAfter: options.closeAfter ?? false },
    async (engine) => {
      // 真机：设备页会要求 Google 的「重新验证身份」，凭据从数据库账号取（只经 fill 写入）
      const result = await engine.kickDevices({
        keepCurrent: true,
        credentials: {
          password: String(accountInfo["password"] ?? ""),
          totpSecret: String(accountInfo["secret_key"] ?? ""),
        },
      });
      kickedCount = result.devices_kicked || 0;

      if (result.success) {
        if (kickedCount > 0) {
          return [true, `成功踢出 ${kickedCount} 个设备`] as Result2;
        }
        return [true, "没有需要踢出的设备（仅本机登录）"] as Result2;
      }
      return [false, result.message] as Result2;
    },
    (msg) => [false, `运行失败: ${msg}`] as Result2,
  );

  return Object.assign([ok, message] as Result2, { kickedCount });
}