/**
 * 自动修改身份验证器并保存新密钥
 *
 * 保存分三处（优先级递减）：
 *   1. 数据库（最重要，失败则后续两步也跳过文件写入）
 *   2. 项目根目录下的密钥文本文件（追加）
 *   3. ixBrowser 窗口备注与 tfa_secret
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
 * 保存新密钥。返回数据库是否写入成功。
 * 注意：文件与备注更新都依赖数据库成功（save_to_file 与数据库写入成功同时成立才写）。
 */
export function saveNewSecret(options: SaveSecretOptions): boolean {
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

  // 2. 文件（仅在数据库成功后写）
  if ((options.saveToFile ?? true) && dbSuccess) {
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
  if (bid != null && /^\d+$/.test(String(bid)) && options.ixClient) {
    void (async () => {
      try {
        const profileId = Number.parseInt(String(bid), 10);
        await options.ixClient!.updateProfile(profileId, { tfa_secret: cleanSecret });
      } catch (err) {
        console.error(`❌ 更新 ixBrowser 窗口的 2FA 密钥失败: ${err}`);
      }
    })();
  }

  return dbSuccess;
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

      if (result.success) {
        const newSecret = result.secret_key ?? null;
        if (newSecret && newSecret.trim().length > 0) {
          saveNewSecret({
            email,
            password: String(accountInfo["password"] ?? ""),
            newSecret,
            browserId,
            saveToFile: options.saveToFile,
            outputFile: options.outputFile,
            projectRoot: options.projectRoot ?? process.cwd(),
            accountRepo: options.accountRepo,
            historyRepo: options.historyRepo,
            ixClient: options.ixClient,
          });
          return [true, "身份验证器修改成功，新密钥已保存", newSecret] as Result3;
        }
        return [true, "身份验证器修改成功", newSecret] as Result3;
      }

      return [false, result.message, null] as Result3;
    },
    (msg) => [false, `运行失败: ${msg}`, null] as Result3,
  );
}