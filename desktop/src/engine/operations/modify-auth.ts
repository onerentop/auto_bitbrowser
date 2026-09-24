/**
 * 修改身份验证器
 *
 * 流程：进验证器设置 → 开始设置 → 切到"手动输入密钥" → 提取密钥 →
 *       用新密钥生成验证码自证 → 提交 → 验证。
 *
 * 密钥提取是本文件的核心资产：Google 页面上的密钥可能是
 * "ABCD EFGH IJKL MNOP"（分组）或 "ABCDEFGHIJKLMNOP"（连续），
 * 也可能混在其他文本里，所以先清洗再按两套正则找、最后做 Base32 校验。
 *
 * 真机（2026-09-24，ixBrowser profile 14 + 真实 Google 账号）修正的缺陷：
 *   2SV / 验证器设置页会要求 Google 的「重新验证身份」（真机形态：密码页 /v3/signin/challenge/pwd）。
 *   原实现把跳转后的 accounts.google.com/.../signin/... 判成「需要先登录账号」直接失败（假失败，账号其实已登录）。
 *   这里新增 passReauthIfRequired：处理完验证（密码 → 如有验证码则验证码）再继续主流程。
 *   （地址无需改动：GoogleURLs.AUTHENTICATOR 真机有效，通过验证后就是「身份验证器」设置页。）
 *   手动密钥视图里**没有验证码输入框**，必须先点「下一页」Google 才会进入「输入验证码」这一步；
 *   原实现直接去「输入验证码」，真机上该 act 返回 success=false、随后核对必然失败（无法确定设置结果）。
 *   这里在输入验证码之前补一次「下一页」点击。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { generateTotp } from "../totp.ts";
import {
  createModifyAuthenticatorResult,
  type ModifyAuthenticatorResult,
} from "../types.ts";

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
/** 一次「重新验证身份」最多提交几轮（真机形态：密码；也可能 密码 → 验证码） */
const REAUTH_MAX_ROUNDS = 2;
const BASE32_CHARS = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".split(""));

/** 校验是否为合法 Base32 密钥（长度 16-32，字符集 A-Z2-7） */
export function isValidBase32(s: string): boolean {
  if (s.length < 16 || s.length > 32) return false;
  for (const ch of s.toUpperCase()) {
    if (!BASE32_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * 从任意文本里解析 TOTP 密钥。
 * 先去掉空格与连字符再匹配——Google 展示的分组密钥正是这种形态。
 * 两套正则按顺序尝试，取第一个通过 Base32 校验的候选。
 */
export function parseSecret(text: string): string | null {
  const cleaned = text.replace(/ /g, "").replace(/-/g, "").toUpperCase();

  // 第一个无捕获组：findAll 返回完整匹配
  const bare = cleaned.match(/[A-Z2-7]{16,32}/gi) ?? [];
  for (const m of bare) {
    const candidate = m.toUpperCase();
    if (isValidBase32(candidate)) return candidate;
  }

  // 第二个带标签：只取捕获组内容
  const labeled = /(?:key|secret|密钥)[:\s]*([A-Z2-7]{16,32})/gi;
  let hit: RegExpExecArray | null;
  while ((hit = labeled.exec(cleaned)) !== null) {
    const candidate = (hit[1] ?? "").toUpperCase();
    if (isValidBase32(candidate)) return candidate;
  }

  return null;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string;
  new_secret?: string | null;
}

export class ModifyAuthenticatorOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(credentials: ReauthCredentials = {}): Promise<ModifyAuthenticatorResult> {
    const start = Date.now();
    const fail = (message: string, error?: string | null): ModifyAuthenticatorResult =>
      createModifyAuthenticatorResult({
        success: false,
        message,
        error,
        duration_ms: Date.now() - start,
      });

    try {
      const nav = await this.engine.navigate(GoogleURLs.AUTHENTICATOR, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) return fail("导航到身份验证器设置页面失败", nav.error);

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 真机：该页会先要求 Google 的「重新验证身份」；不处理就会被下面的登录态判定误判成「未登录」
      const reauth = await this.passReauthIfRequired(credentials);
      if (reauth && !reauth.success) return fail(reauth.message ?? "重新验证身份失败", reauth.error);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return fail("需要先登录账号", "未登录");
      }

      const result = await this.performModify();
      const durationMs = Date.now() - start;

      if (result.success) {
        return createModifyAuthenticatorResult({
          success: true,
          message: "身份验证器修改成功",
          secret_key: result.new_secret ?? null,
          duration_ms: durationMs,
        });
      }
      return createModifyAuthenticatorResult({
        success: false,
        message: result.message ?? "修改失败",
        error: result.error,
        // 即使最终验证失败也把密钥带回——它已经生成，用户可能仍需留存
        secret_key: result.new_secret ?? null,
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`操作失败: ${msg}`, msg);
    }
  }

  private async performModify(): Promise<StepOutcome> {
    try {
      // Step 1: 进入设置流程
      await this.engine.act(
        "点击 'Set up authenticator' 或 '设置身份验证器' 或 'Add authenticator' 或 'Change app' 按钮",
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 2: 切到手动密钥模式（这样才拿得到密钥文本）
      await this.engine.act(
        '点击 "Can\'t scan it?" 或 \'无法扫描？\' 或 \'Enter a setup key\' 或 \'输入设置密钥\' 链接',
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 3: 提取密钥
      const newSecret = await this.extractSecret();
      if (!newSecret) {
        return { success: false, message: "无法提取密钥", error: "未找到 TOTP 密钥" };
      }

      // Step 3.5（真机新增）：手动密钥视图里没有验证码输入框，必须先点「下一页」，
      // Google 才会进入「输入应用生成的验证码」这一步。
      await this.engine.act("点击 '下一页' 或 'Next' 按钮，进入输入验证码的步骤");
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 4: 用新密钥生成验证码自证
      try {
        const code = generateTotp(newSecret);
        await this.engine.act(`在验证码输入框中输入: ${code}`);
        await this.engine.wait(Timeouts.AFTER_INPUT);
        await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 或 'Done' 或 '完成' 按钮");
        await this.engine.wait(3000);
      } catch {
        // 生成失败通常意味着密钥非法，把密钥带回供人工处理
        return { success: false, message: "需要手动完成验证", new_secret: newSecret, error: "验证码生成失败" };
      }

      // Step 5: 验证设置
      const verify = await this.verifySetup();
      if (verify.success) return { success: true, new_secret: newSecret };

      return {
        success: false,
        message: verify.message ?? "验证失败",
        new_secret: newSecret,
        error: verify.error,
      };
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

  /**
   * 提交当前表单。真机实测（2026-09-24）：密码页**先按 Enter 就能提交**；
   * 若先点外层 div（#passwordNext）会把焦点带走、Enter 反而失效，所以顺序是 Enter → 点按钮 → 派发点击。
   */
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
      // 仍未通过：可能是 密码 → 验证码 的第二轮，或页面在渲染，继续下一轮
      await this.engine.wait(1000);
    }

    return { success: false, message: "重新验证身份失败：验证未被接受", error: "重新验证未通过" };
  }

  /** 先试 extract 拿结构化结果，失败则回退到整页文本再解析 */
  private async extractSecret(): Promise<string | null> {
    try {
      const extracted = await this.engine.extract(
        `
                在页面上查找 TOTP 设置密钥：
                1. 通常是一串大写字母和数字的组合
                2. 可能标记为 "Setup key", "Secret key", "密钥"
                3. 格式类似于: ABCD EFGH IJKL MNOP 或 ABCDEFGHIJKLMNOP
                4. 通常是 16-32 个字符

                返回找到的密钥字符串（仅密钥，不含其他文本）。
                `,
      );

      if (extracted.success && extracted.data) {
        const secret = parseSecret(String(JSON.stringify(extracted.data)));
        if (secret) return secret;
      }

      // 回退：整页文本里再找一遍
      return parseSecret(await this.engine.getPageContent());
    } catch {
      return null;
    }
  }

  private async verifySetup(): Promise<StepOutcome> {
    try {
      const extracted = await this.engine.extract(
        `
                检查页面是否显示身份验证器设置成功的标志：
                1. "Authenticator app added" 或 "已添加身份验证器"
                2. "Success" 或 "成功"
                3. "Done" 或 "完成"
                4. 显示已设置的验证器

                也检查错误信息：
                5. "Invalid code" 或 "验证码无效"
                6. "Error" 或 "错误"
                `,
      );
      if (!extracted.success) return { success: false, message: "无法验证设置结果" };

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      // 真机（2026-09-24）：改成功后页面上写的是「身份验证器应用已更改 / 添加时间：刚刚」，
      // 原词表只有「已添加 / added」，真机上必然判成「无法确定设置结果」——而账号其实已经改掉，
      // 新密钥因此不会被保存（saveNewSecret 只在 success 时调用）。故补上「已更改」等真机文案。
      const okWords = ["added", "已添加", "success", "成功", "done", "完成", "已更改", "更改", "changed"];
      if (okWords.some((k) => text.includes(k))) return { success: true };

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => text.includes(k))) {
        return { success: false, message: "验证码验证失败", error: "无效的验证码" };
      }

      return { success: false, message: "无法确定设置结果" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}