/**
 * 自动修改 Google 账号密码（F1，本地新增 —— Python 侧没有这个操作）
 *
 * 与其他 auto_* 最大的不同：**先确认 Google 侧改成功，再写本地**。
 * 反过来的顺序（先写本地）在 Google 侧失败时会留下「库里是新密码、Google 还是旧密码」，
 * 之后所有登录都会失败 —— 这是本功能最不能接受的失败形态。
 *
 * 新密码由调用方生成（系统自动生成强随机密码）；这里绝不把密码写进日志、也不放进返回值
 * （任务结果会进任务历史与事件载荷）。
 */
import type { AccountRepository } from "../db/account-repository.ts";
import type { IxBrowserClient } from "../ixbrowser/client.ts";
import { generateStrongPassword } from "../core/random-password.ts";
import { printBanner, withEngine, type CommonOptions, type Result2 } from "./shared.ts";

/*
 * 备注（窗口的 note 字段）**不由自动化维护** —— 它是用户自己的笔记区：
 * 真机实测（2026-09-24）用户会在里面手写历史密码，而写入备注的三条路径（改密 / 导入 TOTP /
 * 修改验证器）互相覆盖：导入 TOTP 会整条重建（`邮箱----密码----辅助邮箱----密钥`）、
 * 修改验证器会追加并拼出空段，都吃掉过用户手写的内容。用户已决定：
 * **自动化任务一律不碰备注**，密码只写数据库与窗口的 password 字段。
 */

export interface SavePasswordOptions {
  email: string;
  newPassword: string;
  browserId?: string | number | null;
  accountRepo?: Pick<AccountRepository, "upsertAccount">;
  ixClient?: Pick<IxBrowserClient, "updateProfile">;
}

export interface SavePasswordResult {
  /** 数据库（accounts.password） */
  db: boolean;
  /** 窗口信息面板上的 password 字段 */
  windowPassword: boolean;
}

/**
 * 把写回结果翻成「任务行状态 + 给人看的消息」。
 *
 * 关键判断：Google 侧已经改了，本地写得再差也不能报「没改成功」——那会让操作者以为密码没变。
 * 但如果**一处都没写成**，新密码就只存在于内存里，等于丢了：这时必须报失败，
 * 逼操作者按消息里的指引去重设密码，而不是看到一个绿点以为一切正常。
 */
export function describeSaveOutcome(saved: SavePasswordResult): { ok: boolean; message: string } {
  if (saved.db && saved.windowPassword) {
    return { ok: true, message: "密码已更改，新密码已写入数据库与窗口的 password 字段" };
  }
  if (saved.db && !saved.windowPassword) {
    return { ok: true, message: "密码已更改；窗口的 password 字段未写入（数据库已是新密码，请手动同步窗口信息）" };
  }
  if (!saved.db && saved.windowPassword) {
    return { ok: true, message: "密码已更改；数据库未写入（新密码在窗口的 password 字段里，请手动同步数据库）" };
  }
  return {
    ok: false,
    message: "密码已在 Google 侧更改，但新密码未能写入数据库与窗口，本地密码已失效；请人工重设密码后再同步",
  };
}

/**
 * 把新密码写回两处（数据库 + 窗口 password 字段），两处各自独立尝试：
 * Google 侧已经改掉了，任何一处失败都只影响那一处，能修一处是一处（失败由调用方汇总上报）。
 * 备注（note）刻意不写 —— 那是用户自己的笔记区，见文件头说明。
 */
export async function saveNewPassword(options: SavePasswordOptions): Promise<SavePasswordResult> {
  const result: SavePasswordResult = { db: false, windowPassword: false };

  // 1) 数据库：upsertAccount 是「未传即不动」，所以这里只会动 password 与 updated_at
  if (options.accountRepo) {
    try {
      result.db = options.accountRepo.upsertAccount({ email: options.email, password: options.newPassword });
      if (!result.db) console.error("[改密] 数据库写入返回 false");
    } catch (err) {
      console.error(`❌ 更新数据库失败: ${err}`);
    }
  }

  // 2) ixBrowser 窗口：只写 password 字段（不读、不写 note）
  const bid = options.browserId;
  if (bid != null && /^\d+$/.test(String(bid)) && options.ixClient) {
    try {
      const profileId = Number.parseInt(String(bid), 10);
      // 注意：params 里带着**明文新密码**，任何日志/错误上报都不得把 params 或服务端响应体打印出来。
      result.windowPassword = await options.ixClient.updateProfile(profileId, { password: options.newPassword });
      if (!result.windowPassword) console.error("[改密] 窗口 password 字段写入返回 false");
    } catch (err) {
      console.error(`❌ 更新 ixBrowser 窗口信息失败: ${err}`);
    }
  }

  return result;
}

export interface AutoChangePasswordOptions extends CommonOptions {
  /** 新密码；不传则系统自动生成 */
  newPassword?: string;
  accountRepo?: Pick<AccountRepository, "upsertAccount">;
  ixClient?: Pick<IxBrowserClient, "getProfileInfo" | "updateProfile">;
  /** 任务日志回调（只写进度，不含凭据） */
  callback?: ((msg: string) => void) | null;
}

/** 日志里的密码掩码：只露长度与首 4 位，绝不打印完整密码 */
export function maskPassword(password: string): string {
  return `len=${password.length} 前4=${password.slice(0, 4)}…`;
}

export async function autoChangePassword(
  browserId: string,
  accountInfo: Record<string, unknown>,
  options: AutoChangePasswordOptions = {},
): Promise<Result2> {
  const email = String(accountInfo["email"] ?? "Unknown");
  const newPassword = options.newPassword ?? generateStrongPassword();
  const log = (msg: string): void => options.callback?.(`[${email}] ${msg}`);

  printBanner("修改账号密码 (StagehandGoogleEngine)", [`账号: ${email}`, `新密码: ${maskPassword(newPassword)}`]);

  return withEngine(
    browserId,
    { ...options, closeAfter: options.closeAfter ?? false },
    async (engine): Promise<Result2> => {
      log(`开始修改密码（新密码 ${maskPassword(newPassword)}），需要重新验证身份`);
      const result = await engine.changePassword(
        {
          currentPassword: String(accountInfo["password"] ?? ""),
          totpSecret: String(accountInfo["secret_key"] ?? ""),
          newPassword,
        },
        log,
      );

      // 关键：Google 侧没确认成功 → 一个本地字段都不动
      if (!result.success) return [false, result.message || "修改密码失败"] as Result2;

      log("Google 侧已确认更改，开始写回本地（数据库 / 窗口备注第 2 段 / 窗口密码字段）");
      const saved = await saveNewPassword({
        email,
        newPassword,
        browserId,
        accountRepo: options.accountRepo,
        ixClient: options.ixClient,
      });

      // 判定依据一并带上：它会进任务历史（落库 + 可导出 CSV），是事后唯一能复盘的东西
      const why = result.message ? `（判定依据：${result.message}）` : "";
      const outcome = describeSaveOutcome(saved);
      return [outcome.ok, `${outcome.message}${why}`] as Result2;
    },
    (msg): Result2 => [false, `运行失败: ${msg}`],
  );
}
