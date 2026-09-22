/**
 * Google 登录（Node 重写）
 * 对标 core/stagehand_engine/operations/login.py
 *
 * 流程：导航登录页 → 查已登录 → 处理账号选择器 → 输邮箱 → 检测页态 →
 *       输密码 → 再检测 → TOTP → 验证成功。
 *
 * _detectPageState 的关键词判定顺序严格照搬 Python，不可调整：
 * 账号不存在/停用优先于验证码，验证码优先于密码错误，
 * 因为一个页面上可能同时出现多组关键词，顺序决定归类结果。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { generateTotp } from "../totp.ts";
import { GoogleURLs, Timeouts, LoginKeywords } from "../constants.ts";
import {
  createLoginResult,
  type LoginResult,
  type LoginState,
  type OperationStatus,
} from "../types.ts";

/** 账号选择器页面的特征词 */
const CHOOSER_KEYWORDS = [
  "use another account",
  "使用其他账号",
  "add another account",
  "choose an account",
];

/** 登录成功时的 URL 特征（多账号视图也算） */
const SUCCESS_URLS = ["myaccount.google.com", "one.google.com", "accounts.google.com/b/"];

/** _detectPageState 的返回集合 */
export type PageState =
  | "account_not_found"
  | "account_disabled"
  | "captcha"
  | "wrong_password"
  | "security_challenge"
  | "2fa_totp"
  | "2fa_sms"
  | "2fa_email"
  | "2fa_prompt"
  | "password"
  | "success"
  | "unknown";

export class LoginOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(options: {
    email: string;
    password: string;
    totpSecret?: string | null;
    recoveryEmail?: string | null;
  }): Promise<LoginResult> {
    const { email, password, totpSecret = null } = options;
    const start = Date.now();
    const done = (
      r: { success: boolean; status: OperationStatus; login_state: LoginState } & Partial<LoginResult>,
    ): LoginResult => createLoginResult({ account_email: email, duration_ms: Date.now() - start, ...r });

    try {
      // 1. 导航到登录页
      const nav = await this.engine.navigate(GoogleURLs.LOGIN, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return done({
          success: false,
          status: "failed",
          login_state: "unknown",
          error: `无法导航到登录页: ${nav.error ?? ""}`,
          error_type: "navigation_failed",
        });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 2. 已登录就直接返回
      if (await this.checkAlreadyLoggedIn()) {
        return done({
          success: true,
          status: "success",
          login_state: "logged_in",
          message: "已登录",
        });
      }

      // 3. 账号选择器（多账号时会先出现这个页）
      await this.handleAccountChooser();

      // 4. 输入邮箱
      if (!(await this.enterEmail(email))) {
        return done({
          success: false,
          status: "failed",
          login_state: "logged_out",
          error: "无法输入邮箱",
          error_type: "email_input_failed",
        });
      }
      await this.engine.wait(Timeouts.AFTER_CLICK);

      // 5. 下一步
      await this.engine.act("点击下一步按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // 6. 邮箱页之后的页态检查（三种失败要早返回）
      const state = await this.detectPageState();
      if (state === "account_not_found") {
        return done({
          success: false,
          status: "failed",
          login_state: "account_not_found",
          error: "账号不存在",
          error_type: "account_not_found",
        });
      }
      if (state === "account_disabled") {
        return done({
          success: false,
          status: "blocked",
          login_state: "account_disabled",
          error: "账号已被停用",
          error_type: "account_disabled",
        });
      }
      if (state === "captcha") {
        return done({
          success: false,
          status: "blocked",
          login_state: "captcha_required",
          error: "需要验证码",
          error_type: "captcha_required",
        });
      }

      // 7. 输入密码
      if (!(await this.enterPassword(password))) {
        return done({
          success: false,
          status: "failed",
          login_state: "need_password",
          error: "无法输入密码",
          error_type: "password_input_failed",
        });
      }
      await this.engine.wait(Timeouts.AFTER_CLICK);

      // 8. 提交
      await this.engine.act("点击下一步按钮或登录按钮");
      await this.engine.wait(Timeouts.AFTER_2FA);

      // 9. 密码提交后的页态
      const postState = await this.detectPageState();

      if (postState === "wrong_password") {
        return done({
          success: false,
          status: "failed",
          login_state: "wrong_password",
          error: "密码错误",
          error_type: "wrong_password",
          can_retry: true,
          retry_delay_seconds: 5,
        });
      }

      if (postState === "security_challenge") {
        return done({
          success: false,
          status: "partial",
          login_state: "security_challenge",
          message: "需要安全验证",
          error_type: "security_challenge",
        });
      }

      // 10. 两步验证
      if (postState === "2fa_totp") {
        if (totpSecret) {
          if (!(await this.handleTotp(totpSecret))) {
            return done({
              success: false,
              status: "failed",
              login_state: "need_2fa",
              error: "两步验证失败",
              error_type: "totp_failed",
              need_2fa: true,
              two_fa_method: "totp",
            });
          }
        } else {
          return done({
            success: false,
            status: "partial",
            login_state: "need_2fa",
            message: "需要 TOTP 两步验证",
            need_2fa: true,
            two_fa_method: "totp",
          });
        }
      } else if (postState === "2fa_sms" || postState === "2fa_email" || postState === "2fa_prompt") {
        return done({
          success: false,
          status: "partial",
          login_state: "need_2fa",
          message: `需要两步验证 (${postState})`,
          need_2fa: true,
          two_fa_method: postState.replace("2fa_", ""),
        });
      }

      // 11. 最终验证
      await this.engine.wait(Timeouts.AFTER_2FA);
      if (await this.verifyLoginSuccess()) {
        return done({
          success: true,
          status: "success",
          login_state: "logged_in",
          message: "登录成功",
        });
      }
      return done({
        success: false,
        status: "failed",
        login_state: "unknown",
        error: "登录验证失败",
        error_type: "verification_failed",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({
        success: false,
        status: "failed",
        login_state: "unknown",
        error: msg,
        error_type: "exception",
      });
    }
  }

  /** URL 命中或页面出现成功关键词即算已登录 */
  private async checkAlreadyLoggedIn(): Promise<boolean> {
    const url = await this.engine.getCurrentUrl();
    if (url.includes("myaccount.google.com")) return true;

    const pageLower = (await this.engine.getPageContent()).toLowerCase();
    return LoginKeywords.LOGIN_SUCCESS.some((k) => pageLower.includes(k.toLowerCase()));
  }

  /** 检测到账号选择器就点「使用其他账号」进入邮箱输入流程 */
  private async handleAccountChooser(): Promise<boolean> {
    try {
      const pageLower = (await this.engine.getPageContent()).toLowerCase();
      const isChooser = CHOOSER_KEYWORDS.some((k) => pageLower.includes(k.toLowerCase()));
      if (!isChooser) return false;

      await this.engine.act("点击使用其他账号或添加其他账号");
      await this.engine.wait(Timeouts.AFTER_CLICK);
      return true;
    } catch {
      return false;
    }
  }

  private async enterEmail(email: string): Promise<boolean> {
    try {
      const result = await this.engine.act(`在邮箱或电话号码输入框中输入: ${email}`);
      return result.success;
    } catch {
      return false;
    }
  }

  /**
   * 输入密码，三级降级。
   *
   * 注意：这里**刻意保留**了 Python 版的一个可疑行为——act() 成功之后
   * 仍会执行 keyboard.type()，导致密码可能被输入两次。
   * 原样照搬是为了让后续全量测试能复现同样的表现；
   * 真机验证时若确认 act 恒失败（指令里不含密码值，AI 无从猜测），
   * 这条分支实际上不会触发，届时可安全去掉。
   */
  private async enterPassword(password: string): Promise<boolean> {
    try {
      const result = await this.engine.act("在密码输入框中输入密码");

      if (!result.success) {
        // 降级 1：直接按选择器填充
        if (await this.engine.fill('input[type="password"]', password)) return true;
      }

      // 降级 2：直接敲键盘
      await this.engine.typeText(password);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检测当前页态。
   * 判定顺序严格照搬 Python：顺序变了归类就会变。
   */
  private async detectPageState(): Promise<PageState> {
    try {
      const pageLower = (await this.engine.getPageContent()).toLowerCase();
      const hit = (kws: readonly string[]) => kws.some((k) => pageLower.includes(k.toLowerCase()));

      if (hit(LoginKeywords.ACCOUNT_NOT_FOUND)) return "account_not_found";
      if (hit(LoginKeywords.ACCOUNT_DISABLED)) return "account_disabled";
      if (hit(LoginKeywords.CAPTCHA)) return "captcha";
      if (hit(LoginKeywords.WRONG_PASSWORD)) return "wrong_password";
      if (hit(LoginKeywords.SECURITY_CHALLENGE)) return "security_challenge";
      if (hit(LoginKeywords.TWO_FA_TOTP)) return "2fa_totp";
      if (hit(LoginKeywords.TWO_FA_SMS)) return "2fa_sms";
      if (hit(LoginKeywords.TWO_FA_EMAIL)) return "2fa_email";
      if (hit(LoginKeywords.TWO_FA_PROMPT)) return "2fa_prompt";
      if (hit(LoginKeywords.PASSWORD_PAGE)) return "password";

      const url = await this.engine.getCurrentUrl();
      if (url.includes("myaccount.google.com") || url.includes("one.google.com")) return "success";

      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 生成 TOTP 并提交；act 失败时降级为直接敲键盘 */
  private async handleTotp(totpSecret: string): Promise<boolean> {
    try {
      const code = generateTotp(totpSecret);

      const result = await this.engine.act(`在验证码输入框中输入: ${code}`);
      if (!result.success) {
        await this.engine.typeText(code);
      }
      await this.engine.wait(Timeouts.AFTER_INPUT);

      await this.engine.act("点击下一步按钮或验证按钮");
      await this.engine.wait(Timeouts.AFTER_2FA);

      return true;
    } catch {
      return false;
    }
  }

  private async verifyLoginSuccess(): Promise<boolean> {
    try {
      const url = await this.engine.getCurrentUrl();
      if (SUCCESS_URLS.some((u) => url.includes(u))) return true;

      const pageLower = (await this.engine.getPageContent()).toLowerCase();
      return LoginKeywords.LOGIN_SUCCESS.some((k) => pageLower.includes(k.toLowerCase()));
    } catch {
      return false;
    }
  }
}