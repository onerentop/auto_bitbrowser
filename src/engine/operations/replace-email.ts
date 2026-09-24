/**
 * 替换辅助邮箱
 *
 * 提示词逐字沿用原有版本。注意带 new_email 的指令
 * 用模板字符串拼接，前缀与分隔符必须一致。
 *
 * 真机（2026-09-24，ixBrowser profile 7 + 真实 Google 账号）修正的缺陷：
 *   恢复邮箱页会要求 Google 的「重新验证身份」——真机上出现的形态是**直接要身份验证器验证码**
 *   （URL accounts.google.com/v3/signin/challenge/totp），也可能先要密码再要验证码。
 *   原实现把跳转后的 accounts.google.com/.../signin/... 判成「需要先登录账号」直接失败（假失败）。
 *   这里新增 passReauthIfRequired：两种形态都能处理，处理完再继续主流程。
 *   （URL 无需改动：GoogleURLs.RECOVERY_EMAIL 真机有效，落点就是辅助邮箱设置页。）
 *   点完「下一步」后 Google 会弹「请输入已发送至新邮箱的 6 位数验证码」——真机确认**新邮箱此时已经生效**，
 *   那只是对新地址的可选校验（页面上留一个「验证辅助邮箱」入口，点取消也照样生效）。
 *   原实现把「出现验证码框且没有取码服务」直接判成失败（假失败）。这里改为不判失败，交给结果核对定论。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createReplaceEmailResult, type ReplaceEmailResult } from "../types.ts";
import { generateTotp } from "../totp.ts";

/** 邮箱验证码服务接口（取码实现由调用方注入） */
export interface EmailCodeService {
  getCode(email: string): Promise<string | null>;
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
const REAUTH_DETECT_TIMEOUT_MS = 6000;
/** 提交一步之后等待下一步（验证码框 / 跳回设置页）的上限 */
const REAUTH_STEP_TIMEOUT_MS = 8000;
/** 一次「重新验证身份」最多提交几轮（真机形态：直接验证码；或 密码 → 验证码） */
const REAUTH_MAX_ROUNDS = 2;


export class ReplaceEmailOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(
    newEmail: string,
    emailService: EmailCodeService | null = null,
    credentials: ReauthCredentials = {},
  ): Promise<ReplaceEmailResult> {
    const start = Date.now();
    try {
      const nav = await this.engine.navigate(GoogleURLs.RECOVERY_EMAIL, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) {
        return createReplaceEmailResult({
          success: false,
          message: "导航到恢复邮箱设置页面失败",
          error: nav.error,
          duration_ms: Date.now() - start,
        });
      }

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 真机：该页会先要求 Google 的「重新验证身份」；不处理就会被下面的登录态判定误判成「未登录」
      const reauth = await this.passReauthIfRequired(credentials);
      if (reauth && !reauth.success) {
        return createReplaceEmailResult({
          success: false,
          message: reauth.message ?? "重新验证身份失败",
          error: reauth.error,
          duration_ms: Date.now() - start,
        });
      }

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return createReplaceEmailResult({
          success: false,
          message: "需要先登录账号",
          error: "未登录",
          duration_ms: Date.now() - start,
        });
      }

      const replaced = await this.performReplace(newEmail, emailService, credentials);
      const durationMs = Date.now() - start;

      if (replaced.success) {
        return createReplaceEmailResult({
          success: true,
          message: "辅助邮箱替换成功",
          new_email: newEmail,
          duration_ms: durationMs,
        });
      }
      return createReplaceEmailResult({
        success: false,
        message: replaced.message ?? "替换失败",
        error: replaced.error,
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createReplaceEmailResult({ success: false, message: `操作失败: ${msg}`, error: msg, duration_ms: Date.now() - start });
    }
  }

  private async performReplace(
    newEmail: string,
    emailService: EmailCodeService | null,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      // Step 1: 检查当前状态
      await this.engine.extract(
        `
                检查当前恢复邮箱设置页面：
                1. 是否有现有的恢复邮箱
                2. 是否有 "Add recovery email" 或 "添加恢复邮箱" 按钮
                3. 是否有 "Edit" 或 "编辑" 按钮
                `,
      );

      // Step 2: 点击添加或编辑按钮
      await this.engine.act(
        "点击 'Add recovery email' 或 '添加恢复邮箱' 或 'Edit' 或 '编辑' 或铅笔图标按钮",
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 3: 清除现有邮箱并输入新邮箱
      await this.engine.act("清除邮箱输入框中的现有内容");
      await this.engine.wait(500);

      await this.engine.act(`在恢复邮箱输入框中输入: ${newEmail}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      // Step 4: 点击下一步/确认
      await this.engine.act(
        "点击 'Next' 或 '下一步' 或 'Confirm' 或 '确认' 或 'Save' 或 '保存' 按钮",
      );
      await this.engine.wait(3000);

      // Step 5: 检查是否需要验证
      const verifyCheck = await this.engine.extract(
        `
                检查页面是否显示：
                1. 验证码输入框 - 需要输入发送到新邮箱的验证码
                2. 成功消息 - 恢复邮箱已更新
                3. 错误消息 - 无效的邮箱等
                `,
      );

      if (verifyCheck.success && verifyCheck.data) {
        const resultText = String(JSON.stringify(verifyCheck.data)).toLowerCase();

        if (
          resultText.includes("verification") ||
          resultText.includes("验证码") ||
          resultText.includes("code")
        ) {
          if (emailService) {
            try {
              const code = await emailService.getCode(newEmail);
              if (code) {
                await this.engine.act(`在验证码输入框中输入: ${code}`);
                await this.engine.wait(Timeouts.AFTER_INPUT);
                await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮");
                await this.engine.wait(3000);
              }
            } catch {
              return createReplaceEmailResult({
                success: false,
                message: "需要手动输入验证码",
                error: "邮箱验证码获取失败",
              });
            }
          } else {
            // 真机：此时新邮箱已生效，「请输入验证码」只是对新地址的可选校验，不该判失败。
            // 是否真的替换成功由后面的 verifyReplacement 核对（没生效时会如实报失败）。
          }
        }
      }

      // Step 6: 验证替换成功
      return await this.verifyReplacement(newEmail, credentials);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createReplaceEmailResult({ success: false, message: msg, error: msg });
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
   * 页面停在 Google 的「重新验证身份」页时完成验证。
   * 返回 null 表示没有验证要求，可以继续主流程；否则返回验证结果。
   *
   * 真机形态（2026-09-24）：该页**直接给验证器验证码输入框**（也可能先要密码），
   * 所以按「有验证码框先填验证码，否则填密码」轮换，最多 REAUTH_MAX_ROUNDS 轮。
   * 凭据只经 fill 写入，**不经过 act()**：AI 指令里不能出现凭据。
   */
  private async passReauthIfRequired(credentials: ReauthCredentials): Promise<StepOutcome | null> {
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

  private async completeReauth(credentials: ReauthCredentials): Promise<StepOutcome> {
    const password = String(credentials.password ?? "");
    const secret = String(credentials.totpSecret ?? "").replace(/\s/g, "");

    for (let round = 1; round <= REAUTH_MAX_ROUNDS; round++) {
      const totpSelector = await this.visibleSelector(REAUTH_TOTP_SELECTORS);
      const passwordSelector = await this.visibleSelector(REAUTH_PASSWORD_SELECTORS);

      if (!totpSelector && !passwordSelector) {
        // 页面在渲染中；再等一会，实在没有就交给调用方的登录态判定
        const appeared = await this.waitUntil(
          async () =>
            (await this.visibleSelector(REAUTH_TOTP_SELECTORS)) !== null ||
            (await this.visibleSelector(REAUTH_PASSWORD_SELECTORS)) !== null,
          REAUTH_STEP_TIMEOUT_MS,
        );
        if (!appeared) {
          return { success: false, message: "需要重新验证身份，但未找到密码 / 验证码输入框", error: "未找到输入框" };
        }
        continue;
      }

      if (totpSelector) {
        if (!secret) {
          return { success: false, message: "需要验证器验证码，但账号信息中没有密钥", error: "缺少 TOTP 密钥" };
        }
        if (!(await this.engine.fill(totpSelector, generateTotp(secret)))) {
          return { success: false, message: "重新验证身份失败：验证码未能写入", error: "验证码写入失败" };
        }
        await this.submitReauthForm(REAUTH_TOTP_NEXT_SELECTORS);
      } else if (passwordSelector) {
        if (!password) {
          return { success: false, message: "需要重新验证身份，但账号信息中没有密码", error: "缺少密码" };
        }
        if (!(await this.engine.fill(passwordSelector, password))) {
          return { success: false, message: "重新验证身份失败：密码未能写入", error: "密码写入失败" };
        }
        await this.submitReauthForm(REAUTH_PASSWORD_NEXT_SELECTORS);
      }

      const passed = await this.waitUntil(async () => !(await this.isReauthPage()), REAUTH_STEP_TIMEOUT_MS);
      if (passed) {
        await this.engine.wait(Timeouts.AFTER_NAVIGATION);
        return { success: true };
      }
    }

    return { success: false, message: "重新验证身份失败：验证未被接受", error: "重新验证未通过" };
  }

  /** 刷新页面后核对新邮箱是否生效 */
  private async verifyReplacement(
    newEmail: string,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      // 真机：再次导航到该页通常又会要求重新验证身份
      await this.engine.navigate(GoogleURLs.RECOVERY_EMAIL, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      const reauth = await this.passReauthIfRequired(credentials);
      if (reauth && !reauth.success) return reauth;

      const extracted = await this.engine.extract(
        `
                检查页面是否显示：
                1. 新的恢复邮箱 ${newEmail}
                2. "Recovery email updated" 或 "恢复邮箱已更新" 消息
                3. "Success" 或 "成功" 提示

                也检查错误信息：
                4. "Invalid email" 或 "无效邮箱"
                5. "Error" 或 "错误"
                `,
      );

      if (!extracted.success) {
        return createReplaceEmailResult({ success: false, message: "无法验证替换结果" });
      }

      const resultText = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      if (resultText.includes(newEmail.toLowerCase())) return createReplaceEmailResult({ success: true });

      const okWords = ["updated", "已更新", "success", "成功"];
      if (okWords.some((k) => resultText.includes(k))) return createReplaceEmailResult({ success: true });

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => resultText.includes(k))) {
        return createReplaceEmailResult({ success: false, message: "邮箱验证失败", error: "无效的邮箱" });
      }

      return createReplaceEmailResult({ success: false, message: "无法确定替换结果" });
    } catch (err) {
      return createReplaceEmailResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}