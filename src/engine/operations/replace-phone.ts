/**
 * 替换恢复手机号
 *
 * 与 replace-email 结构几乎一致，差异在 URL、按钮文案、以及验证时比对手机号后四位。
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
import { GoogleReauth, type ReauthCredentials } from "./reauth.ts";

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
      await this.engine.extract(
        `
                检查当前恢复手机设置页面：
                1. 是否有现有的恢复手机号
                2. 是否有 "Add recovery phone" 或 "添加恢复手机" 按钮
                3. 是否有 "Edit" 或 "编辑" 按钮
                4. 是否有 "Update" 或 "更新" 按钮
                `,
      );

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
      await this.engine.wait(3000);

      const verifyCheck = await this.engine.extract(
        `
                检查页面是否显示：
                1. 验证码输入框 - 需要输入发送到新手机的验证码
                2. 成功消息 - 恢复手机已更新
                3. 错误消息 - 无效的手机号等
                `,
      );

      if (verifyCheck.success && verifyCheck.data) {
        const resultText = String(JSON.stringify(verifyCheck.data)).toLowerCase();

        if (
          resultText.includes("verification") ||
          resultText.includes("验证码") ||
          resultText.includes("code")
        ) {
          if (smsService) {
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
          } else {
            return createModifyPhoneResult({ success: false, message: "需要手动输入验证码", error: "未提供短信服务" });
          }
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
  /** 刷新后核对：手机号后四位出现即视为成功（页面通常做脱敏显示） */
  private async verifyReplacement(
    newPhone: string,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      // 真机：再次导航到该页通常又会要求重新验证身份
      await this.engine.navigate(GoogleURLs.RECOVERY_PHONE_SETTINGS, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      const reauth = await this.reauth.passIfRequired(credentials);
      if (reauth && !reauth.success) return reauth;

      const extracted = await this.engine.extract(
        `
                检查页面是否显示：
                1. 新的恢复手机号（可能是部分隐藏的格式，如 ***1234）
                2. "Recovery phone updated" 或 "恢复手机已更新" 消息
                3. "Success" 或 "成功" 提示

                也检查错误信息：
                4. "Invalid phone" 或 "无效手机号"
                5. "Error" 或 "错误"
                `,
      );

      if (!extracted.success) return createModifyPhoneResult({ success: false, message: "无法验证替换结果" });

      const resultText = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      if (newPhone.length >= 4) {
        const lastFour = newPhone.slice(-4);
        if (resultText.includes(lastFour)) return createModifyPhoneResult({ success: true });
      }

      const okWords = ["updated", "已更新", "success", "成功"];
      if (okWords.some((k) => resultText.includes(k))) return createModifyPhoneResult({ success: true });

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => resultText.includes(k))) {
        return createModifyPhoneResult({ success: false, message: "手机号验证失败", error: "无效的手机号" });
      }

      return createModifyPhoneResult({ success: false, message: "无法确定替换结果" });
    } catch (err) {
      return createModifyPhoneResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}