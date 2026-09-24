/**
 * Google 账号一键登录
 *
 * 与其他 auto_* 不同：本函数用 use_config=True 连接，
 * 即 AI 配置从 ConfigManager 读取（调用方无需传 model/api_key）。
 *
 * 设计取舍：登录的每一步经 callback 写入任务日志；
 * 失败提示在通用文案后附上具体原因（如「需要短信验证码两步验证」），便于判断下一步怎么处理。
 */
import type { AccountRepository } from "../db/account-repository.ts";
import { printBanner, withEngine } from "./shared.ts";

export interface AutoLoginResult {
  success: boolean;
  message: string;
  email: string;
  browserId: string;
  /** logged_in / login_failed / not_logged */
  loginStatus: string;
  errorType?: string | null;
  totalSteps?: number;
}

/** 登录失败时把 LoginState 映射成 error_type */
const STATE_TO_ERROR: Record<string, [string, string]> = {
  wrong_password: ["wrong_password", "密码错误"],
  account_not_found: ["account_not_found", "账号不存在"],
  account_disabled: ["account_disabled", "账号已被禁用"],
  captcha_required: ["captcha_required", "需要验证码"],
  security_challenge: ["security_challenge", "需要安全挑战验证"],
  need_2fa: ["need_2fa", "需要两步验证"],
};

/** 快速检查当前是否已登录（只看 URL 域名） */
export async function checkLoginStatusQuick(engine: {
  getCurrentUrl(): Promise<string>;
}): Promise<boolean> {
  try {
    const url = await engine.getCurrentUrl();
    const domains = [
      "myaccount.google.com",
      "mail.google.com",
      "drive.google.com",
      "one.google.com",
    ];
    return domains.some((d) => url.includes(d));
  } catch {
    return false;
  }
}

export async function autoGoogleLogin(
  browserId: string,
  account: Record<string, unknown>,
  options: {
    callback?: ((msg: string) => void) | null;
    accountRepo?: Pick<AccountRepository, "updateLoginStatus">;
  } = {},
): Promise<AutoLoginResult> {
  const email = String(account["email"] ?? "");
  const password = String(account["password"] ?? "");
  const secretKey = String(account["secret_key"] ?? "");
  const recoveryEmail = String(account["recovery_email"] ?? "");
  const repo = options.accountRepo;

  const log = (msg: string) => {
    process.stdout.write(`[GoogleLogin] ${email}: ${msg}\n`);
    options.callback?.(`[${email}] ${msg}`);
  };

  log("开始登录流程...");
  repo?.updateLoginStatus(email, "logging_in");

  const engineOptions = {
    // 无 model/apiKey 时由引擎侧兜底
    closeAfter: false,
  };

  return withEngine(
    browserId,
    engineOptions,
    async (engine): Promise<AutoLoginResult> => {
      log("StagehandGoogleEngine 已连接，开始登录...");

      const result = await engine.login({
        email,
        password,
        totpSecret: secretKey || null,
        recoveryEmail: recoveryEmail || null,
        log,
      });

      const state = result.login_state ?? "unknown";
      log(`登录结果: success=${result.success}, state=${state}`);

      if (result.success) {
        log("[OK] 登录成功");
        repo?.updateLoginStatus(email, "logged_in");

        return {
          success: true,
          message: "登录成功",
          email,
          browserId,
          loginStatus: "logged_in",
        };
      }

      // 失败：按 login_state 映射错误类型
      const detail = result.message || result.error || "";
      let errorMsg = detail || "登录失败";
      let errorType = result.error_type || "login_failed";
      const mapped = STATE_TO_ERROR[state];
      if (mapped) {
        errorType = mapped[0];
        errorMsg = detail && detail !== mapped[1] ? `${mapped[1]}: ${detail}` : mapped[1];
      }

      log(`[X] ${errorMsg}`);
      repo?.updateLoginStatus(email, "login_failed", errorMsg);

      return {
        success: false,
        message: errorMsg,
        email,
        browserId,
        loginStatus: "login_failed",
        errorType,
      };
    },
    (msg): AutoLoginResult => {
      log(`[X] 异常: ${msg}`);
      repo?.updateLoginStatus(email, "login_failed", msg);
      return {
        success: false,
        message: `登录异常: ${msg}`,
        email,
        browserId,
        loginStatus: "login_failed",
        errorType: "exception",
      };
    },
  );
}