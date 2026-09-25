/**
 * 替换恢复手机号
 *
 * 与 replace-email 结构几乎一致，差异在 URL、按钮文案、以及核对时在页面上找新号码（完整或后 7 位）。
 * operation_type 固定为 "recovery"。
 *
 * 真机（2026-09-24，ixBrowser profile 7 + 真实 Google 账号）暴露、并在此修正的缺陷：
 *   1. GoogleURLs.RECOVERY_PHONE（myaccount.google.com/recovery/phone）已失效：
 *      真机打开是 404 页（"404. That's an error."），完成身份验证后再访问仍是 404。
 *      这里改用同一份代码里指向该页面的 RECOVERY_PHONE_SETTINGS
 *      （myaccount.google.com/signinoptions/rescuephone）。
 *   2. 真机上该页面会要求「请先验证您的身份」（密码 → 验证器验证码）；原实现把跳转后的
 *      accounts.google.com/v3/signin/challenge/pwd 判成「需要先登录账号」直接失败。
 *      这里新增重新验证身份（现为 reauth.ts 公共实现）处理该验证后再继续。
 *   3. 填完号码并点「下一步」后，Google 的编辑框还停在待保存状态，**不点最终的保存按钮改动不生效**
 *      （原来的链路点完「下一步/获取验证码」就去做核对，账号上的号码始终没变）。
 *      这里在核对之前补一次保存点击。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createModifyPhoneResult, type ModifyPhoneResult } from "../types.ts";
import { GoogleReauth, REAUTH_STEP_TIMEOUT_MS, waitUntil, type ReauthCredentials } from "./reauth.ts";

/** 点「下一步」后的确认框（真机：Confirm your phone number / Make sure … is the number you would like to save / Back / Save） */
export const PHONE_CONFIRM_PATTERN = /Confirm your phone number|确认(您|你)的(电话号码|手机号)/i;
/** 页面要求输入发到新号码的短信验证码 */
export const PHONE_CODE_PROMPT_PATTERN = /Enter (the )?(verification )?code|输入验证码/i;

/** 短信验证码服务接口（取码实现由调用方注入） */
export interface SmsCodeService {
  getCode(phone: string): Promise<string | null>;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string | null;
}
export class ReplacePhoneOperation {
  private readonly engine: StagehandGoogleEngine;
  /** 「重新验证身份」（与其它 operation 共用 reauth.ts；核对时重新导航还会再要一次） */
  private readonly reauth: GoogleReauth;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
    this.reauth = new GoogleReauth(engine);
  }

  async execute(
    newPhone: string,
    smsService: SmsCodeService | null = null,
    credentials: ReauthCredentials = {},
  ): Promise<ModifyPhoneResult> {
    const start = Date.now();
    const fail = (message: string, error?: string | null): ModifyPhoneResult =>
      createModifyPhoneResult({
      success: false,
      message,
      error,
      operation_type: "recovery",
      duration_ms: Date.now() - start,
    });

    try {
      const nav = await this.engine.navigate(GoogleURLs.RECOVERY_PHONE_SETTINGS, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) return fail("导航到恢复手机设置页面失败", nav.error);

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 真机：该页会先要求「请先验证您的身份」；不处理就会被下一行误判成「未登录」
      const reauth = await this.reauth.passIfRequired(credentials);
      if (reauth && !reauth.success) return fail(reauth.message ?? "重新验证身份失败", reauth.error);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return fail("需要先登录账号", "未登录");
      }

      const replaced = await this.performReplace(newPhone, smsService, credentials);
      const durationMs = Date.now() - start;

      if (replaced.success) {
        return createModifyPhoneResult({
          success: true,
          message: "恢复手机号替换成功",
          new_phone: newPhone,
          operation_type: "recovery",
          duration_ms: durationMs,
        });
      }
      return createModifyPhoneResult({
        success: false,
        message: replaced.message ?? "替换失败",
        error: replaced.error,
        operation_type: "recovery",
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`操作失败: ${msg}`, msg);
    }
  }

  private async performReplace(
    newPhone: string,
    smsService: SmsCodeService | null,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      await this.engine.act(
        "点击 'Add recovery phone' 或 '添加恢复手机' 或 'Edit' 或 '编辑' 或 'Update' 或 '更新' 或铅笔图标按钮",
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      await this.engine.act("清除手机号输入框中的现有内容");
      await this.engine.wait(500);

      await this.engine.act(`在恢复手机号输入框中输入: ${newPhone}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      await this.engine.act(
        "点击 'Next' 或 '下一步' 或 'Get code' 或 '获取验证码' 或 'Send' 或 '发送' 按钮",
      );

      // 以真实页面文本判断下一步（真机 2026-09-25）：
      //   - 「Confirm your phone number … Save」确认框 → 去点保存。确认框文案里也有 "codes will be sent"，所以先认它；
      //   - 页面要求输入短信验证码 → 有短信服务就填，没有就如实报需要手动输入。
      // 原实现看 AI 抽取的回答里有没有「验证码」二字：AI 答「页面未显示验证码输入框」也会命中，误报「需要手动输入验证码」。
      // 两种页面都是点完「下一步」才渲染 → 轮询等它出现，不赌一次固定等待（同 modify-2sv）。
      let page = "";
      await waitUntil(
        this.engine,
        async () => {
          page = await this.engine.getPageContent();
          return PHONE_CONFIRM_PATTERN.test(page) || PHONE_CODE_PROMPT_PATTERN.test(page);
        },
        REAUTH_STEP_TIMEOUT_MS,
      );
      if (!PHONE_CONFIRM_PATTERN.test(page) && PHONE_CODE_PROMPT_PATTERN.test(page)) {
        if (!smsService) {
          return createModifyPhoneResult({ success: false, message: "需要手动输入验证码", error: "未提供短信服务" });
        }
        try {
          const code = await smsService.getCode(newPhone);
          if (code) {
            await this.engine.act(`在验证码输入框中输入: ${code}`);
            await this.engine.wait(Timeouts.AFTER_INPUT);
            await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮");
            await this.engine.wait(3000);
          }
        } catch {
          return createModifyPhoneResult({
            success: false,
            message: "需要手动输入验证码",
            error: "短信验证码获取失败",
          });
        }
      }

      // 真机：填完号码、点过「下一步」之后 Google 还会要求点一次保存，改动才会生效
      await this.engine.act(
        "点击 '保存' 或 'Save' 或 '完成' 或 'Done' 或 '确认' 或 'Confirm' 按钮以保存新的恢复手机号",
      );
      await this.engine.wait(3000);
      return await this.verifyReplacement(newPhone, credentials);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createModifyPhoneResult({ success: false, message: msg, error: msg });
    }
  }
  /** 刷新后核对：以真实页面文本为准，页面上出现新号码（完整或后 7 位）才算成功 */
  private async verifyReplacement(
    newPhone: string,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      // 审查：导航失败时页面停在原地（可能还是确认框，正文里就有完整新号码）→ 不查成败会假成功（同 modify-2sv）
      const nav = await this.engine.navigate(GoogleURLs.RECOVERY_PHONE_SETTINGS, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return createModifyPhoneResult({ success: false, message: "无法核验：打开恢复手机设置页失败", error: nav.error ?? "导航失败" });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      // 真机：再次导航到该页通常又会要求重新验证身份
      const reauth = await this.reauth.passIfRequired(credentials);
      if (reauth && !reauth.success) return reauth;
      const url = await this.engine.getCurrentUrl();
      if (!url.includes("signinoptions/rescuephone")) {
        return createModifyPhoneResult({ success: false, message: "无法核验：页面没有停在恢复手机设置页", error: url });
      }

      // 不看 AI 的回答（真机上它答「未显示…已更新」这种否定句，按关键词会误判成功）；
      // 只去空白不去其它符号，避免把相邻数字拼出页面上不存在的串；尾号至少 7 位，防止撞上旧号尾段等其它数字
      const text = await this.engine.getPageContent();
      const digits = newPhone.replace(/\D/g, "");
      const compact = text.replace(/\s/g, "");
      const tail = digits.slice(-7);
      if (tail.length === 7 && (compact.includes(digits) || compact.includes(tail))) {
        return createModifyPhoneResult({ success: true });
      }
      if (/invalid phone|无效的?手机号/i.test(text)) {
        return createModifyPhoneResult({ success: false, message: "手机号验证失败", error: "无效的手机号" });
      }
      return createModifyPhoneResult({ success: false, message: "保存后恢复手机设置页上没有看到新号码" });
    } catch (err) {
      return createModifyPhoneResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}