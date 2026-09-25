/**
 * 自动修改身份验证器并保存新密钥
 *
 * 保存分三处：
 *   1. 数据库（最重要；失败时任务判失败）
 *   2. 项目根目录下的密钥文本文件（追加；不依赖数据库成功，保证密钥不丢）
 *   3. ixBrowser 窗口的 tfa_secret（窗口备注由用户维护，不碰）
 */
import fs from "node:fs";
import path from "node:path";
import type { AccountRepository } from "../db/account-repository.ts";
import type { HistoryRepository } from "../db/history-repository.ts";
import type { IxBrowserClient } from "../ixbrowser/client.ts";
import { printBanner, withEngine, type CommonOptions, type Result3 } from "./shared.ts";

export interface SaveSecretOptions {
  email: string;
  password: string;
  newSecret: string;
  browserId?: string | number | null;
  saveToFile?: boolean;
  outputFile?: string;
  projectRoot: string;
  accountRepo?: AccountRepository;
  historyRepo?: HistoryRepository;
  ixClient?: IxBrowserClient;
}

/**
 * 保存新密钥：数据库、文件、窗口 tfa_secret 三处，互不依赖。
 * 文件写入不依赖数据库成功（数据库失败时密钥至少还在文件里）。
 * 窗口同步要等写完并返回结果（审查指出：原来不 await、也不看返回值，失败完全不可见，
 * 而首页的验证码就是从窗口 tfa_secret 算的）。
 */
export async function saveNewSecret(options: SaveSecretOptions): Promise<{ db: boolean; window: boolean | null }> {
  // 清洗：去空格与连字符后转大写
  const cleanSecret = options.newSecret.replace(/ /g, "").replace(/-/g, "").toUpperCase();
  let dbSuccess = false;

  // 1. 数据库
  if (options.accountRepo) {
    try {
      dbSuccess = options.accountRepo.upsertAccount({
        email: options.email,
        password: options.password,
        secret_key: cleanSecret,
      });
      if (dbSuccess) {
        try {
          options.historyRepo?.addAuthenticatorModification(options.email, cleanSecret);
        } catch (err) {
          // 历史记录失败不影响主流程
          console.error(`⚠️ 记录修改历史失败（不影响主功能）: ${err}`);
        }
      }
    } catch (err) {
      console.error(`❌ 更新数据库失败: ${err}`);
    }
  }

  // 2. 文件：与数据库写入**无关**，一律写——新密钥只要落下一处就不会丢（原实现数据库失败就不写文件）
  if (options.saveToFile ?? true) {
    try {
      const outputPath = path.join(options.projectRoot, options.outputFile ?? "已修改密钥.txt");
      fs.appendFileSync(outputPath, `${options.email}----${options.password}----${cleanSecret}\n`, "utf8");
    } catch (err) {
      console.error(`❌ 保存到文件失败: ${err}`);
    }
  }

  // 3. ixBrowser 窗口：只写 tfa_secret —— **备注（note）一律不碰**
  // 备注是用户自己的笔记区（真机实测用户会在里面手写历史密码）；原实现按段数把密钥插进备注，
  // 既会覆盖用户手写的内容，也会拼出空段（用户备注里那个空段就是它的痕迹）。
  const bid = options.browserId;
  let windowSynced: boolean | null = null; // null = 没有窗口可同步
  if (bid != null && /^\d+$/.test(String(bid)) && options.ixClient) {
    try {
      const profileId = Number.parseInt(String(bid), 10);
      // updateProfile 自己吞异常返回 false，所以要看返回值
      windowSynced = await options.ixClient.updateProfile(profileId, { tfa_secret: cleanSecret });
    } catch (err) {
      console.error(`❌ 更新 ixBrowser 窗口的 2FA 密钥失败: ${err}`);
      windowSynced = false;
    }
  }

  return { db: dbSuccess, window: windowSynced };
}
/** 未确认是否已生效的新密钥：追加到密钥文件并标注，**不写库**（旧密钥可能仍然有效） */
function recordUnconfirmedSecret(save: Omit<SaveSecretOptions, "newSecret">, newSecret: string): boolean {
  try {
    const cleanSecret = newSecret.replace(/ /g, "").replace(/-/g, "").toUpperCase();
    const outputPath = path.join(save.projectRoot, save.outputFile ?? "已修改密钥.txt");
    fs.appendFileSync(outputPath, `${save.email}----${save.password}----${cleanSecret}----未确认\n`, "utf8");
    return true;
  } catch (err) {
    console.error(`❌ 保存未确认密钥到文件失败: ${err}`);
    return false;
  }
}

/**
 * 按操作结果决定新密钥怎么落——**新密钥一个都不能丢**（真机 2026-09-25：Google 换验证器后旧密钥立刻失效）：
 *   - 成功：写库 + 修改历史 + 文件 + 窗口 tfa_secret；写库失败时任务判失败（文件里仍有密钥），提示手动更新；
 *   - 失败但已拿到新密钥（已提交过验证码，是否生效无法确认）：写进文件并标注「未确认」，不改库，提示人工核对；
 *   - 失败且没拿到新密钥：什么都不写。
 */
export async function settleModifyAuthResult(
  result: { success: boolean; message?: string | null; secret_key?: string | null },
  save: Omit<SaveSecretOptions, "newSecret">,
): Promise<Result3> {
  const newSecret = (result.secret_key ?? "").trim();
  if (result.success) {
    if (!newSecret) return [true, "身份验证器修改成功", null];
    const saved = await saveNewSecret({ ...save, newSecret });
    if (!saved.db) {
      return [false, "身份验证器已修改，但新密钥写入数据库失败；密钥已写入「已修改密钥.txt」，请手动更新", newSecret];
    }
    if (saved.window === false) {
      return [false, "身份验证器已修改、新密钥已存库，但 ixBrowser 窗口里的密钥同步失败（首页验证码会不对），请手动更新窗口", newSecret];
    }
    return [true, "身份验证器修改成功，新密钥已保存", newSecret];
  }
  const message = String(result.message ?? "");
  if (!newSecret) return [false, message, null];
  const kept = recordUnconfirmedSecret(save, newSecret);
  return [
    false,
    `${message}；无法确认验证器是否已更换，新密钥${kept ? "已写入「已修改密钥.txt」（标注「未确认」）" : "写文件也失败了"}，` +
      "数据库里的密钥未改，请人工核对",
    // 审查：写文件失败时这里是密钥唯一的去处，不能再丢
    newSecret,
  ];
}

export async function autoModifyAuthenticator(
  browserId: string,
  accountInfo: Record<string, unknown>,
  options: CommonOptions & {
    saveToFile?: boolean;
    outputFile?: string;
    projectRoot?: string;
    accountRepo?: AccountRepository;
    historyRepo?: HistoryRepository;
    ixClient?: IxBrowserClient;
  } = {},
): Promise<Result3> {
  const email = String(accountInfo["email"] ?? "Unknown");
  printBanner("修改身份验证器 (StagehandGoogleEngine)", [`账号: ${email}`]);

  return withEngine(
    browserId,
    { ...options, closeAfter: options.closeAfter ?? false },
    async (engine) => {
      // 真机：2SV / 验证器设置页会要求 Google 的「重新验证身份」，凭据从数据库账号取
      const result = await engine.modifyAuthenticator({
        password: String(accountInfo["password"] ?? ""),
        totpSecret: String(accountInfo["secret_key"] ?? ""),
      });
      return settleModifyAuthResult(result, {
        email,
        password: String(accountInfo["password"] ?? ""),
        browserId,
        saveToFile: options.saveToFile,
        outputFile: options.outputFile,
        projectRoot: options.projectRoot ?? process.cwd(),
        accountRepo: options.accountRepo,
        historyRepo: options.historyRepo,
        ixClient: options.ixClient,
      });
    },
    (msg) => [false, `运行失败: ${msg}`, null] as Result3,
  );
}