/**
 * Antigravity OAuth 授权
 * 对标 automation/auto_antigravity_oauth.py
 *
 * 流程：先查 Sub2API 是否已有该账号（有则直接返回，省掉整个 OAuth）→
 *       连接窗口 → 按需登录 → 向 Sub2API 申请 OAuth URL →
 *       在浏览器完成授权 → 回写 sub2api 状态。
 */
import type { AccountRepository } from "../db/account-repository.ts";
import type { Sub2ApiClient } from "../services/sub2api-client.ts";
import { GoogleURLs } from "../engine/constants.ts";
import { printBanner, withEngine } from "./shared.ts";

export interface OAuthRunResult {
  success: boolean;
  message: string;
  email: string;
  errorType?: string | null;
  sub2apiAccountId?: number | null;
  sub2apiStatus?: string | null;
}

export async function autoAntigravityOauth(
  browserId: string,
  account: Record<string, unknown>,
  options: {
    sub2apiClient: Sub2ApiClient;
    callback?: ((msg: string) => void) | null;
    skipLoginCheck?: boolean;
    accountRepo?: AccountRepository;
  },
): Promise<OAuthRunResult> {
  const email = String(account["email"] ?? "");
  const password = String(account["password"] ?? "");
  const secretKey = String(account["secret_key"] ?? "");
  const sub2api = options.sub2apiClient;

  const log = (msg: string) => {
    process.stdout.write(`[OAuth] ${email}: ${msg}\n`);
    options.callback?.(`[${email}] ${msg}`);
  };

  printBanner("Antigravity OAuth", [`账号: ${email}`]);
  log("开始 OAuth 流程...");

  // 1. 已存在于 Sub2API 就跳过整个流程
  try {
    const existingId = await sub2api.checkAccountExists(email);
    if (existingId) {
      log(`账号已存在于 Sub2API (ID: ${existingId})`);
      options.accountRepo?.updateSub2apiStatus(email, "linked", existingId);
      return {
        success: true,
        message: "账号已存在于 Sub2API",
        email,
        sub2apiAccountId: existingId,
        sub2apiStatus: "linked",
      };
    }
  } catch (err) {
    log(`检查 Sub2API 账号失败: ${err}`);
  }

  return withEngine(
    browserId,
    { closeAfter: false },
    async (engine): Promise<OAuthRunResult> => {
      log("StagehandGoogleEngine 已连接");

      // 2. 按需登录
      if (!options.skipLoginCheck) {
        log("检查登录状态...");
        await engine.navigate(GoogleURLs.ACCOUNT);
        await engine.wait(2000);
        const url = await engine.getCurrentUrl();
        if (url.includes("accounts.google.com") && url.includes("signin")) {
          log("未登录，执行登录...");
          const loginResult = await engine.login({
            email,
            password,
            totpSecret: secretKey || null,
          });
          if (!loginResult.success) {
            log(`[X] 登录失败: ${loginResult.message}`);
            return { success: false, message: `登录失败: ${loginResult.message}`, email, errorType: "login_failed" };
          }
          log("[OK] 登录成功");
        }
      }

      // 3. 向 Sub2API 申请 OAuth URL
      const startRes = await sub2api.startAntigravityOauth();
      if (!startRes.success) {
        const errorMsg = startRes.error ?? "无法启动 OAuth 流程";
        log(`[X] ${errorMsg}`);
        return { success: false, message: errorMsg, email, errorType: "oauth_url_failed" };
      }

      const oauthUrl = (startRes.data?.["auth_url"] as string | undefined) ?? null;
      if (!oauthUrl) {
        log("[X] 无法获取 OAuth URL");
        return { success: false, message: "无法获取 OAuth URL", email, errorType: "oauth_url_failed" };
      }

      log(`OAuth URL: ${oauthUrl.slice(0, 50)}...`);
      log("执行 OAuth 授权...");

      // 4. 在浏览器里完成授权
      const oauthResult = await engine.oauthAuthorize("antigravity", oauthUrl);

      if (oauthResult.success) {
        log("[OK] OAuth 授权成功");
        // Python 侧是 int(account_id)——OAuthResult 里该字段为字符串，需转数字
        const accountId = oauthResult.account_id
          ? Number.parseInt(String(oauthResult.account_id), 10)
          : null;
        if (accountId !== null && !Number.isNaN(accountId)) {
          options.accountRepo?.updateSub2apiStatus(email, "linked", accountId);
        }
        return {
          success: true,
          message: "OAuth 授权成功",
          email,
          sub2apiAccountId: accountId !== null && !Number.isNaN(accountId) ? accountId : null,
          sub2apiStatus: "linked",
        };
      }

      const errorMsg = oauthResult.error ?? oauthResult.message ?? "OAuth 授权失败";
      log(`[X] ${errorMsg}`);
      return { success: false, message: errorMsg, email, errorType: "oauth_failed" };
    },
    (msg): OAuthRunResult => {
      log(`[X] 异常: ${msg}`);
      return { success: false, message: `OAuth 异常: ${msg}`, email, errorType: "exception" };
    },
  );
}

/** 批量版，对标 batch_antigravity_oauth */
export async function batchAntigravityOauth(
  accounts: Record<string, unknown>[],
  browserIds: string[],
  options: {
    sub2apiClient: Sub2ApiClient;
    callback?: ((msg: string) => void) | null;
    skipLoginCheck?: boolean;
    accountRepo?: AccountRepository;
  },
): Promise<{ total: number; successCount: number; failedCount: number; results: OAuthRunResult[] }> {
  const results: OAuthRunResult[] = [];
  let successCount = 0;
  let failedCount = 0;
  const log = (msg: string) => {
    process.stdout.write(`[BatchOAuth] ${msg}\n`);
    options.callback?.(msg);
  };

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i] as Record<string, unknown>;
    const email = String(account["email"] ?? "");
    log(`[${i + 1}/${accounts.length}] 处理: ${email}`);

    const result = await autoAntigravityOauth(browserIds[i] ?? "", account, options);
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