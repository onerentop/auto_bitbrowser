/**
 * 解锁 403 账号（Node 重写）
 * 对标 core/stagehand_engine/operations/unlock_403.py
 *
 * 流程：进验证页 → 识别挑战类型 → 分派到对应处理器 →
 *       captcha / phone / email / identity 各有独立策略。
 *
 * 挑战类型判定顺序严格照搬 Python，不可调整：
 * captcha → phone → email → identity → disabled → sign in。
 * 注意 disabled 排在 sign in 之前——被封页面往往也含 "sign in" 字样，
 * 顺序颠倒会把封号误判为"无需解锁"。
 *
 * 需要人工介入的三种情况会返回 needs_manual=true，
 * 调用方据此把账号转入人工队列，而不是当作失败重试。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createUnlockResult, type UnlockResult } from "../types.ts";

/** 短信客户端接口。注意方法名与 modify-2sv 的 getCode 不同，不可混用 */
export interface UnlockSmsClient {
  getSmsCode(requestId: string | null): Promise<string | null>;
}

export interface UnlockOptions {
  validationUrl?: string | null;
  phoneNumber?: string | null;
  countryName?: string;
  smsClient?: UnlockSmsClient | null;
  requestId?: string | null;
  smsTimeoutSeconds?: number;
  smsIntervalSeconds?: number;
}

/** 挑战类型判定结果 */
export type ChallengeType =
  | "captcha"
  | "phone_verification"
  | "email_verification"
  | "identity_verification"
  | "account_disabled"
  | "no_challenge"
  | "unknown";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Unlock403Operation {
  private readonly engine: StagehandGoogleEngine;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(engine: StagehandGoogleEngine, sleepImpl?: (ms: number) => Promise<void>) {
    this.engine = engine;
    this.sleep = sleepImpl ?? defaultSleep;
  }

  async execute(options: UnlockOptions = {}): Promise<UnlockResult> {
    const start = Date.now();
    const done = (r: Partial<UnlockResult> & { success: boolean; message: string }): UnlockResult =>
      createUnlockResult({ duration_ms: Date.now() - start, ...r });

    try {
      const targetUrl = options.validationUrl || GoogleURLs.ACCOUNT_VERIFY;
      const nav = await this.engine.navigate(targetUrl, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return done({ success: false, message: "导航到验证页面失败", error: nav.error });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const challenge = await this.detectChallengeType();

      switch (challenge) {
        case "captcha":
          return await this.handleCaptcha(start);
        case "phone_verification":
          return await this.handlePhoneVerification(start, options);
        case "email_verification":
          return await this.handleEmailVerification(start);
        case "identity_verification":
          return await this.handleIdentityVerification(start);
        case "no_challenge":
          return done({ success: true, message: "账号无需解锁" });
        default:
          return done({
            success: false,
            message: `未知的挑战类型: ${challenge}`,
            error: "无法识别验证类型",
          });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `操作失败: ${msg}`, error: msg });
    }
  }

  /** 判定顺序即优先级，见文件头注释 */
  private async detectChallengeType(): Promise<ChallengeType> {
    try {
      const extracted = await this.engine.extract(
        `
                检测当前页面的验证类型：
                1. reCAPTCHA / 验证码图片 / "I'm not a robot"
                2. 手机验证 / "Verify with phone" / "验证手机号"
                3. 邮箱验证 / "Verify with email" / "验证邮箱"
                4. 身份验证 / "Verify it's you" / "验证身份"
                5. 正常登录页面 / "Sign in" / 无特殊验证
                6. 账号被禁用 / "Account disabled" / "账号已被停用"
                `,
      );
      if (!extracted.success) return "unknown";

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();
      const has = (kws: string[]) => kws.some((k) => text.includes(k));

      if (has(["captcha", "robot", "验证码", "recaptcha"])) return "captcha";
      if (has(["phone", "手机", "sms", "text message"])) return "phone_verification";
      if (has(["email verification", "邮箱验证", "send email"])) return "email_verification";
      if (has(["verify it", "验证身份", "identity"])) return "identity_verification";
      if (has(["disabled", "suspended", "停用", "禁用"])) return "account_disabled";
      if (has(["sign in", "登录", "welcome"])) return "no_challenge";

      return "unknown";
    } catch {
      return "unknown";
    }
  }

  /** 点复选框；若出现图片题则判定需人工介入 */
  private async handleCaptcha(start: number): Promise<UnlockResult> {
    const done = (r: Partial<UnlockResult> & { success: boolean; message: string }): UnlockResult =>
      createUnlockResult({ duration_ms: Date.now() - start, ...r });

    try {
      await this.engine.act("点击 'I'm not a robot' 复选框或 reCAPTCHA 验证区域");
      await this.engine.wait(3000);

      const check = await this.engine.extract("检查是否出现图片验证（如选择交通灯、红绿灯等）");
      if (check.success && check.data) {
        const text = String(JSON.stringify(check.data)).toLowerCase();
        const imageWords = ["select", "选择", "click", "点击", "image", "图片"];
        if (imageWords.some((k) => text.includes(k))) {
          return done({
            success: false,
            message: "需要手动完成图片验证",
            error: "需要人工介入完成 CAPTCHA",
            needs_manual: true,
          });
        }
      }

      const verified = await this.verifyUnlock();
      return done({
        success: verified.success ?? false,
        message: verified.message ?? "验证码处理完成",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `验证码处理失败: ${msg}`, error: msg });
    }
  }

  /** 输号码 → 发码 → 轮询取码 → 填码 → 验证 */
  private async handlePhoneVerification(
    start: number,
    options: UnlockOptions,
  ): Promise<UnlockResult> {
    const phoneNumber = options.phoneNumber ?? null;
    const smsTimeout = options.smsTimeoutSeconds ?? 120;
    const smsInterval = options.smsIntervalSeconds ?? 5;

    const done = (r: Partial<UnlockResult> & { success: boolean; message: string }): UnlockResult =>
      createUnlockResult({ duration_ms: Date.now() - start, phone_used: phoneNumber, ...r });

    try {
      // 页面上可能已显示（部分隐藏的）号码，先读一次供日志参考
      await this.engine.extract("找到页面上显示的手机号（可能是 ***1234 格式）");

      if (phoneNumber) {
        await this.engine.act(`在手机号输入框中输入: ${phoneNumber}`);
        await this.engine.wait(1000);
      }

      await this.engine.act("点击 'Send' 或 '发送' 或 'Get code' 或 '获取验证码' 按钮");
      await this.engine.wait(3000);

      if (options.smsClient) {
        try {
          // 按 smsTimeout/smsInterval 轮询，异常静默后继续等
          let code: string | null = null;
          let elapsed = 0;
          while (elapsed < smsTimeout) {
            try {
              code = await options.smsClient.getSmsCode(options.requestId ?? null);
              if (code) break;
            } catch {
              /* 单次取码失败不终止轮询 */
            }
            await this.sleep(smsInterval * 1000);
            elapsed += smsInterval;
          }

          if (!code) {
            return done({
              success: false,
              message: "等待验证码超时",
              error: `超过 ${smsTimeout} 秒未收到验证码`,
              can_retry: true,
            });
          }

          await this.engine.act(`在验证码输入框中输入: ${code}`);
          await this.engine.wait(Timeouts.AFTER_INPUT);
          await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮");
          await this.engine.wait(3000);

          const verified = await this.verifyUnlock();
          return done({
            success: verified.success ?? false,
            message: verified.message ?? "手机验证完成",
            sms_code_used: code,
          });
        } catch {
          /* 落到下面的手动提示 */
        }
      }

      return done({
        success: false,
        message: "需要手动输入验证码",
        error: "未提供短信服务或获取验证码失败",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `手机验证失败: ${msg}`, error: msg });
    }
  }

  /** 发邮件后即交还人工——点击邮件里的链接无法自动化 */
  private async handleEmailVerification(start: number): Promise<UnlockResult> {
    const done = (r: Partial<UnlockResult> & { success: boolean; message: string }): UnlockResult =>
      createUnlockResult({ duration_ms: Date.now() - start, ...r });

    try {
      await this.engine.act("点击 'Send' 或 '发送' 或 'Send email' 或 '发送邮件' 按钮");
      await this.engine.wait(3000);

      return done({
        success: false,
        message: "已发送验证邮件，需要手动完成验证",
        error: "需要在邮箱中点击验证链接",
        needs_manual: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `邮箱验证失败: ${msg}`, error: msg });
    }
  }

  /** 优先选手机/邮箱方式，随后交还人工 */
  private async handleIdentityVerification(start: number): Promise<UnlockResult> {
    const done = (r: Partial<UnlockResult> & { success: boolean; message: string }): UnlockResult =>
      createUnlockResult({ duration_ms: Date.now() - start, ...r });

    try {
      const observed = await this.engine.observe(
        "找到可用的验证方式选项（手机、邮箱、安全密钥等）",
      );
      if (observed.success && (observed.data ?? []).length > 0) {
        await this.engine.act("点击手机验证或邮箱验证选项");
        await this.engine.wait(2000);
      }

      return done({
        success: false,
        message: "需要完成身份验证",
        error: "请手动选择并完成验证方式",
        needs_manual: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `身份验证失败: ${msg}`, error: msg });
    }
  }

  /** URL 已离开 accounts 域即视为解锁成功 */
  private async verifyUnlock(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const url = await this.engine.getCurrentUrl();

      if (url.includes("myaccount.google.com")) {
        return { success: true, message: "解锁成功" };
      }
      if ((url.includes("mail.google.com") || url.includes("google.com")) && !url.includes("accounts")) {
        return { success: true, message: "解锁成功" };
      }

      const extracted = await this.engine.extract(
        `
                检查页面状态：
                1. 是否显示账号主页或正常服务页面
                2. 是否仍在验证页面
                3. 是否显示错误信息
                `,
      );
      if (!extracted.success) return { success: false, message: "无法验证解锁结果" };

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();
      const okWords = ["welcome", "欢迎", "account", "账号", "inbox", "收件箱"];
      if (okWords.some((k) => text.includes(k))) return { success: true, message: "解锁成功" };

      return { success: false, message: "解锁未完成" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}