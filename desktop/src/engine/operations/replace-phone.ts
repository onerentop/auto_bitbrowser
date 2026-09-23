/**
 * 替换恢复手机号（Node 重写）
 * 对标 core/stagehand_engine/operations/replace_phone.py
 *
 * 与 replace-email 结构几乎一致，差异在 URL、按钮文案、以及验证时比对手机号后四位。
 * operation_type 固定为 "recovery"。
 *
 * 真机（2026-09-24，ixBrowser profile 7 + 真实 Google 账号）暴露、并在此修正的 Python 侧缺陷：
 *   1. Python 用的 GoogleURLs.RECOVERY_PHONE（myaccount.google.com/recovery/phone）已失效：
 *      真机打开是 404 页（"404. That's an error."），完成身份验证后再访问仍是 404。
 *      这里改用同一份代码里指向该页面的 RECOVERY_PHONE_SETTINGS
 *      （myaccount.google.com/signinoptions/rescuephone）——Python 的 auto_replace_phone.py
 *      与 desktop 的 Playwright 版 auto-replace-phone.ts 用的都是这个地址。
 *   2. 真机上该页面会要求「请先验证您的身份」（密码 → 验证器验证码）；原实现把跳转后的
 *      accounts.google.com/v3/signin/challenge/pwd 判成「需要先登录账号」直接失败。
 *      这里新增 passReauthIfRequired 处理该验证后再继续。
 *   3. 填完号码并点「下一步」后，Google 的编辑框还停在待保存状态，**不点最终的保存按钮改动不生效**
 *      （原来的链路点完「下一步/获取验证码」就去做核对，账号上的号码始终没变；无调用方的
 *      Playwright 版 auto-replace-phone.ts 里有 PHONE_SAVE_SELECTORS，但从未被执行）。
 *      这里在核对之前补一次保存点击。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createModifyPhoneResult, type ModifyPhoneResult } from "../types.ts";
import { generateTotp } from "../totp.ts";

/** 短信验证码服务接口，对应 Python 传入的 sms_service */
export interface SmsCodeService {
  getCode(phone: string): Promise<string | null>;
}

/** Google 敏感设置页「重新验证身份」所需凭据（由 automation 层从数据库账号传入） */
export interface ReauthCredentials {
  password?: string | null;
  totpSecret?: string | null;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string | null;
}

/** 重新验证身份页的输入框 / 按钮选择器（与 login.ts 同一套） */
const REAUTH_PASSWORD_SELECTORS = ['input[name="Passwd"]', '#password input[type="password"]'];
const REAUTH_PASSWORD_NEXT_SELECTORS = ["#passwordNext button", "#passwordNext"];
const REAUTH_TOTP_SELECTORS = ["#totpPin", 'input[name="totpPin"]'];
const REAUTH_TOTP_NEXT_SELECTORS = ["#totpNext button", "#totpNext"];

/** 「重新验证身份」页特征：URL 是 /challenge/，文案是 Google 的提示 */
const REAUTH_TEXT_PATTERN = /请先验证您的身份|输入您的密码|Verify it'?s you|Enter your password/i;

/** navigate 返回后 Google 仍在重定向，判定阶段的轮询上限 */
const REAUTH_DETECT_TIMEOUT_MS = 5000;
/** 提交一步之后等待下一步（验证码框 / 跳回设置页）的上限 */
const REAUTH_STEP_TIMEOUT_MS = 8000;


export class ReplacePhoneOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
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
      const reauth = await this.passReauthIfRequired(credentials);
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

  // ==================== 「重新验证身份」处理（真机新增） ====================

  /** 第一个可见的选择器；都不可见返回 null */
  private async visibleSelector(selectors: readonly string[]): Promise<string | null> {
    for (const s of selectors) if (await this.engine.isVisible(s)) return s;
    return null;
  }

  /** 当前页面是不是 Google 的「重新验证身份」页 */
  private async isReauthPage(): Promise<boolean> {
    const url = await this.engine.getCurrentUrl();
    if (url.includes("/challenge/")) return true;
    const text = await this.engine.getPageContent();
    return REAUTH_TEXT_PATTERN.test(text);
  }

  /** 提交当前表单：Enter → 点击按钮 → 在按钮上派发 click（真机上坐标点击会落空，同 login.ts） */
  private async submitReauthForm(buttonSelectors: readonly string[]): Promise<boolean> {
    if (await this.engine.pressKey("Enter")) return true;
    const button = await this.visibleSelector(buttonSelectors);
    if (button && (await this.engine.click(button))) return true;
    if (button) return this.engine.jsClick(button);
    return false;
  }

  /** 轮询等待条件成立 */
  private async waitUntil(condition: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await condition()) return true;
      if (Date.now() >= deadline) return false;
      await this.engine.wait(500);
    }
  }

  /**
   * 页面停留在 Google 的「重新验证身份」页时完成验证（密码 → 验证器验证码）。
   * 返回 null 表示没有验证要求，可以继续主流程；否则返回验证结果。
   *
   * 密码 / 验证码只经 fill 写入，**不经过 act()**：AI 指令里不能出现凭据（同 login.ts 的密码处理）。
   */
  private async passReauthIfRequired(credentials: ReauthCredentials): Promise<StepOutcome | null> {
    // 调用方已 wait(AFTER_NAVIGATION)；Google 的重定向可能还没落地，连续两次停在非登录域名才算稳定
    const deadline = Date.now() + REAUTH_DETECT_TIMEOUT_MS;
    let settledTicks = 0;
    for (;;) {
      if (await this.isReauthPage()) return this.completeReauth(credentials);
      if (!(await this.engine.getCurrentUrl()).includes("accounts.google.com")) settledTicks += 1;
      else settledTicks = 0;
      if (settledTicks >= 2) return null;
      if (Date.now() >= deadline) return null;
      await this.engine.wait(500);
    }
  }

  /** 完成「重新验证身份」：填密码 → 提交 → 若出现验证器验证码就填码 → 提交 → 等回到设置页 */
  private async completeReauth(credentials: ReauthCredentials): Promise<StepOutcome> {
    const password = String(credentials.password ?? "");
    const secret = String(credentials.totpSecret ?? "").replace(/\s/g, "");
    if (!password) {
      return { success: false, message: "需要重新验证身份，但账号信息中没有密码", error: "缺少密码" };
    }

    const passwordSelector = await this.visibleSelector(REAUTH_PASSWORD_SELECTORS);
    if (!passwordSelector) {
      return { success: false, message: "需要重新验证身份，但未找到密码输入框", error: "未找到密码输入框" };
    }
    if (!(await this.engine.fill(passwordSelector, password))) {
      return { success: false, message: "重新验证身份失败：密码未能写入", error: "密码写入失败" };
    }
    await this.submitReauthForm(REAUTH_PASSWORD_NEXT_SELECTORS);

    // 提交密码后：可能出现验证器验证码输入框，也可能直接跳回设置页
    const movedOn = await this.waitUntil(
      async () =>
        (await this.visibleSelector(REAUTH_TOTP_SELECTORS)) !== null || !(await this.isReauthPage()),
      REAUTH_STEP_TIMEOUT_MS,
    );
    if (!movedOn) {
      return { success: false, message: "重新验证身份失败：提交密码后页面没有变化", error: "提交密码后未跳转" };
    }

    const totpSelector = await this.visibleSelector(REAUTH_TOTP_SELECTORS);
    if (totpSelector) {
      if (!secret) {
        return { success: false, message: "需要验证器验证码，但账号信息中没有密钥", error: "缺少 TOTP 密钥" };
      }
      if (!(await this.engine.fill(totpSelector, generateTotp(secret)))) {
        return { success: false, message: "重新验证身份失败：验证码未能写入", error: "验证码写入失败" };
      }
      await this.submitReauthForm(REAUTH_TOTP_NEXT_SELECTORS);
    }

    const passed = await this.waitUntil(async () => !(await this.isReauthPage()), REAUTH_STEP_TIMEOUT_MS);
    if (!passed) {
      return { success: false, message: "重新验证身份失败：验证未被接受", error: "重新验证未通过" };
    }
    await this.engine.wait(Timeouts.AFTER_NAVIGATION);
    return { success: true };
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
      const reauth = await this.passReauthIfRequired(credentials);
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