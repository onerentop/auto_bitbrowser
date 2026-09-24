/**
 * 修改两步验证手机号
 *
 * 流程：进 2SV 设置 → 查状态 → 点修改 → (必要时先删旧号) → 加新号 →
 *       输号码 → 发验证码 → 填码 → 验证结果。
 *
 * operation_type 固定为 "2sv"，与 replace-phone 的 "recovery" 区分。
 *
 * 真机（2026-09-24）修正的缺陷：
 *   2SV 设置页会要求 Google 的「重新验证身份」（真机形态：密码页 /v3/signin/challenge/pwd）。
 *   原实现把跳转后的 accounts.google.com/.../signin/... 判成「需要先登录账号」直接失败（假失败，账号其实已登录）。
 *   这里新增 passReauthIfRequired：处理完验证（密码 → 如有验证码则验证码）再继续主流程。
 *   （地址无需改动：GoogleURLs.TWO_STEP_VERIFICATION 真机有效。）
 * 真机（2026-09-24，第二次）修正：
 *   2SV 首页没有「更改手机号」按钮，只有一条 `<a href="two-step-verification/phone-numbers">` 条目；
 *   而 `:is(a,button,[role="button"]):has-text("电话号码")` 这类选择器在 stagehand 的选择器引擎里
 *   恒为 0 匹配（count()=0、抛 StagehandElementNotFoundError），确定性点击只能静默返回 false，
 *   流程退回到 AI act 后「报成功但页面毫无变化」（run-2sv6 实测卡死在 2SV 首页）。
 *   现在四处确定性点击一律走 engine.clickByText()（页面内按可见文本点击 + 复核页面状态，未命中不再盲发 AI act）。
 *   结果核对也不再靠 AI 摘要，而是重新打开电话号码列表页、用页面文本里有没有新号码定论。
 *   另外补上缺失的「保存」一步：点「下一步」后是「确认您的电话号码」页，不点「保存」号码不会写入。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createModifyPhoneResult, type ModifyPhoneResult } from "../types.ts";
import { generateTotp } from "../totp.ts";
/** Google 敏感设置页「重新验证身份」所需凭据（由 automation 层从数据库账号传入） */
export interface ReauthCredentials {
  password?: string | null;
  totpSecret?: string | null;
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
/** 一次「重新验证身份」最多提交几轮 */
const REAUTH_MAX_ROUNDS = 2;

/** 短信验证码服务（取码实现由调用方注入） */
export interface SmsCodeService {
  getCode(phone: string): Promise<string | null>;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string;
}

export class Modify2SVOperation {
  private readonly engine: StagehandGoogleEngine;
  /** 上一次提交过的验证码：同一 30 秒窗口内重复提交会被 Google 判「验证码错误，请重试」 */
  private lastTotpCode: string | null = null;

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
        operation_type: "2sv",
        duration_ms: Date.now() - start,
      });

    try {
      const nav = await this.engine.navigate(GoogleURLs.TWO_STEP_VERIFICATION, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) return fail("导航到 2SV 设置页面失败", nav.error);

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 真机：该页会先要求 Google 的「重新验证身份」；不处理就会被下面的登录态判定误判成「未登录」
      const reauth = await this.passReauthIfRequired(credentials);
      if (reauth && !reauth.success) return fail(reauth.message ?? "重新验证身份失败", reauth.error);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return fail("需要先登录账号", "未登录");
      }

      const status = await this.check2svStatus();
      if (status.needs_password) {
        return fail("需要重新验证密码", "需要密码验证");
      }

      const result = await this.performModify(newPhone, smsService, credentials);
      const durationMs = Date.now() - start;

      if (result.success) {
        return createModifyPhoneResult({
          success: true,
          message: "2SV 手机号修改成功",
          new_phone: newPhone,
          operation_type: "2sv",
          duration_ms: durationMs,
        });
      }
      return createModifyPhoneResult({
        success: false,
        message: result.message ?? "修改失败",
        error: result.error,
        operation_type: "2sv",
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`操作失败: ${msg}`, msg);
    }
  }

  /** 用一次 extract 判断页面处于哪种状态，关键词取并集后按组判定 */
  private async check2svStatus(): Promise<{
    needs_password?: boolean;
    has_phone?: boolean;
    is_enabled?: boolean;
  }> {
    try {
      const extracted = await this.engine.extract(
        `
                检查当前 2-Step Verification 页面状态：
                1. 是否显示密码验证页面
                2. 是否显示现有的手机号
                3. 是否有 "Add a phone" 或 "更改手机号" 按钮
                4. 2SV 是否已启用
                `,
      );
      if (!extracted.success) return {};

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();
      const has = (kws: string[]) => kws.some((k) => text.includes(k));

      return {
        needs_password: has(["enter your password", "输入密码", "verify"]),
        has_phone: has(["phone", "手机", "number"]),
        is_enabled: has(["2-step", "两步", "enabled", "已启用"]),
      };
    } catch {
      return {};
    }
  }

  private async performModify(
    newPhone: string,
    smsService: SmsCodeService | null,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      // Step 1（真机修正 2026-09-24）：2SV 首页没有「更改手机号 / Change phone」按钮，只有一个
      // 「电话号码 <号>」条目；点它才会进入「用于进行两步验证的电话号码」页。AI act 在该元素上
      // 会「报成功但没效果」，所以先做确定性点击，并用页面上的「添加两步验证备用电话号码」复核，
      // 都没生效再退回一次 AI act。
      const onPhonePage = async (): Promise<boolean> =>
        /添加两步验证备用电话号码|管理辅助电话号码|删除电话号码/.test(await this.engine.getPageContent());
      if (!(await onPhonePage())) {
        // 真机（2026-09-24）：该条目是 <a href="two-step-verification/phone-numbers">，
        // 而 `:is(a, button, [role="button"]):has-text("电话号码")` 这类选择器在 stagehand 的
        // 选择器引擎里**恒为 0 匹配**（count()=0 + StagehandElementNotFoundError），
        // click()/jsClick() 只会静默返回 false → 不要再用 :has-text()。
        await this.engine.clickByText("电话号码");
        await this.engine.wait(Timeouts.AFTER_CLICK * 3);
      }
      if (!(await onPhonePage())) {
        await this.engine.act(
          "点击页面上的 '电话号码' 条目，或 'Change phone' 或 '更改手机号' 或 'Edit' 或 '编辑' 按钮",
        );
        await this.engine.wait(Timeouts.AFTER_CLICK * 3);
      }

      // Step 2（真机修正）：不再先删旧号。旧实现用 observe + 模糊指令去点「删除电话号码：…」，
      // 真机上会弹出确认框并把后续 act 全部带偏（实测 act #6~#9 连续 success=false、
      // 最后还误报「需要手动输入验证码」）。改为直接走添加流程；旧号是否另行删除留待决策。
      const addDialogOpen = async (): Promise<boolean> =>
        /添加的电话号码可用于|通过短信接收验证码/.test(await this.engine.getPageContent());
      if (!(await addDialogOpen())) {
        await this.engine.clickByText("添加两步验证备用电话号码");
        await this.engine.wait(Timeouts.AFTER_CLICK * 2);
      }
      if (!(await addDialogOpen())) {
        await this.engine.act(
          "点击 '添加两步验证备用电话号码' 或 'Add a phone' 或 '添加手机号' 按钮",
        );
        await this.engine.wait(Timeouts.AFTER_CLICK * 2);
      }

      // Step 4: 输入号码
      await this.engine.act(`在手机号输入框中输入: ${newPhone}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      // Step 4b: 输入号码（弹层里的输入框是 input[type="tel"]；先让 AI act 试一次，再用确定性 fill 兜底）
      if (!(await this.engine.fill('input[type="tel"]', newPhone))) {
        await this.engine.act(`在手机号输入框中输入: ${newPhone}`);
      }
      await this.engine.wait(Timeouts.AFTER_INPUT);
      // Step 5: 发送验证码 / 下一步（真机：AI act 会「成功但弹层没动」→ 确定性点击 + 复核弹层是否关闭）
      const dialogGone = async (): Promise<boolean> =>
        !/通过短信接收验证码|添加的电话号码可用于/.test(await this.engine.getPageContent());
      if (!(await dialogGone())) {
        // 真机（2026-09-24）：弹层里的「下一步」同样不吃 :has-text() 选择器，
        // 且 AI act 会「报成功但弹层没动」，所以用按文本点击 + 复核弹层是否关闭。
        await this.engine.clickByText("下一步");
        await this.engine.wait(3000);
      }
      if (!(await dialogGone())) {
        await this.engine.act("点击 'Next' 或 '下一步' 或 'Send' 或 '发送验证码' 按钮");
        await this.engine.wait(3000);
      }
      await this.engine.wait(3000);

      // Step 5b（真机 2026-09-24 新增）：点「下一步」之后**不是**验证码页，而是「确认您的电话号码」页
      //（真机页面文本：确认您的电话号码 / 请确认 +86 … 是您要保存的号码 / 上一步 / 保存）。
      // 不点「保存」的话 2SV 电话号码列表里根本不会出现新号码——真机探针实测（任务目录 add-probe-2.log）。
      // 判定只锚定该页独有的「确认您的电话号码」：单凭「请确认」会把还开着弹层的页面也判成确认页。
      const confirmPage = async (): Promise<boolean> =>
        /确认您的电话号码/.test(await this.engine.getPageContent());
      // 确认页是「下一步」之后渲染出来的 → 轮询等它出现，而不是赌一次 3 秒固定等待
      if (await this.waitUntil(confirmPage, REAUTH_STEP_TIMEOUT_MS)) {
        // clickByText 未命中就**不再发 AI act**：在这个页面上让模型自由点「保存」，
        // 它可能点到「上一步 / 取消 / 删除电话号码」；点不到就交给结果核对如实报失败。
        if (await this.engine.clickByText("保存")) {
          await this.engine.wait(Timeouts.AFTER_CLICK * 3);
        }
      }

      // Step 6: 取码并提交
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
          return { success: false, message: "需要手动输入验证码", error: "短信验证码获取失败" };
        }
      } else {
        // 真机（2026-09-24）：用户确认「改 2SV 手机不需要验证码」；而原实现在这里**无条件**判失败
        // （哪怕页面根本没让输码）→ 假失败。改为不判失败，交给 Step 7 的结果核对定论。
      }

      // Step 7: 验证
      return await this.verifyModification(newPhone, credentials);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg };
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

  /** 提交当前表单：Enter → 点按钮 → 派发点击（真机实测：先按 Enter 就能提交） */
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

  /** 页面停在「重新验证身份」页时完成验证；返回 null 表示没有验证要求 */
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

  /** 凭据只经 fill 写入，**不经过 act()**：AI 指令里不能出现凭据 */
  private async completeReauth(credentials: ReauthCredentials): Promise<StepOutcome> {
    const password = String(credentials.password ?? "");
    const secret = String(credentials.totpSecret ?? "").replace(/\s/g, "");

    for (let round = 1; round <= REAUTH_MAX_ROUNDS; round++) {
      const totpSelector = await this.visibleSelector(REAUTH_TOTP_SELECTORS);
      const passwordSelector = await this.visibleSelector(REAUTH_PASSWORD_SELECTORS);

      if (!totpSelector && !passwordSelector) {
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
        // 真机（2026-09-24）：同一 30 秒窗口内的验证码只能提交一次——重复提交 Google 会回
        //「验证码错误，请重试」；而在同一窗口里重新生成拿到的还是同一个码，所以必须等到下一个窗口。
        let code = generateTotp(secret);
        if (this.lastTotpCode !== null && code === this.lastTotpCode) {
          const intoWindow = Math.floor(Date.now() / 1000) % 30;
          await this.engine.wait((31 - intoWindow) * 1000);
          code = generateTotp(secret);
        }
        this.lastTotpCode = code;
        if (!(await this.engine.fill(totpSelector, code))) {
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
      await this.engine.wait(1000);
    }

    return { success: false, message: "重新验证身份失败：验证未被接受", error: "重新验证未通过" };
  }

  /**
   * 核对 2SV 电话号码是否真的加上了。
   *
   * 真机（2026-09-24）：原来靠一次 AI extract 的摘要判成败，实测会**假成功**——
   * AI 看到弹层里刚输入的号码就回了「已添加」字样，而账号的 2SV 电话列表里仍然只有旧号。
   * 现在改成把「2SV 电话号码」页重新打开，用页面文本里是否出现新号码来定论。
   */
  private async verifyModification(
    newPhone: string,
    credentials: ReauthCredentials,
  ): Promise<StepOutcome> {
    try {
      const phoneNumbersUrl = "https://myaccount.google.com/two-step-verification/phone-numbers";
      // 审查发现：导航失败时页面会停在原地（可能还停在「确认您的电话号码」页，而该页正文里本来就有
      // 完整新号码）→ 不检查导航成败就会把它读成「列表里有新号码」= 假成功。
      const nav = await this.engine.navigate(phoneNumbersUrl, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return {
          success: false,
          message: "无法核验：打开 2SV 电话号码页失败",
          error: nav.error ?? "导航失败",
        };
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      const reauth = await this.passReauthIfRequired(credentials);
      if (reauth && !reauth.success) return { success: false, message: reauth.message, error: reauth.error };
      const url = await this.engine.getCurrentUrl();
      if (!url.includes("two-step-verification/phone-numbers")) {
        return { success: false, message: "无法核验：页面没有停在 2SV 电话号码列表页", error: url };
      }

      const pageText = await this.engine.getPageContent();
      const digits = newPhone.replace(/\D/g, "");
      const compact = pageText.replace(/\s/g, "");
      // 审查发现：只认完整号码或尾 7 位——尾 4 位太容易撞上页面上的其它数字（旧号尾段、日期等）造成假成功
      const tail = digits.slice(-7);
      if (digits && (compact.includes(digits) || compact.includes(tail))) {
        return { success: true };
      }
      if (/无效|错误|Invalid|Error/i.test(pageText)) {
        return { success: false, message: "手机号验证失败", error: "页面提示无效号码或错误" };
      }
      return { success: false, message: "2SV 电话号码列表里没有出现新号码", error: "页面未显示新号码" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
