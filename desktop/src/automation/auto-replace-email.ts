/**
 * 替换辅助邮箱（Playwright 选择器直连版）
 * 对标 automation/auto_replace_email.py
 *
 * 与其它 auto_* 不同：本文件**不使用 AI**，走确定性选择器操作。
 * 因为要处理的是 Google 固定的表单流程，选择器比自然语言更可靠。
 *
 * 整体流程（顺序不可调整）：
 *   导航设置页 → 检查/执行登录 → 处理重新验证 → 检测现有辅助邮箱 →
 *   有则删除并再次处理重新验证 → 添加新邮箱（含验证码）→
 *   若被要求验证，重新验证后重试一次添加
 */
import type { CompatLocator, CompatPage } from "../engine/playwright-compat.ts";
import { generateTotp } from "../engine/totp.ts";
import {
  SIGN_IN_SELECTORS,
  NEXT_SELECTORS,
  PWD_NEXT_SELECTORS,
  TOTP_NEXT_SELECTORS,
  TOTP_INPUT_SELECTORS,
  REAUTH_TOTP_SELECTORS,
  clickFirstVisible,
  clickLastVisible,
  CONFIRM_DIALOG_SELECTORS,
  detectErrorText,
  EMAIL_ERROR_HINTS,
  fillFirstVisible,
  findFirst,
  findFirstVisible,
  findFirstVisibleWithRetry,
} from "./selector-helpers.ts";

/** Google 恢复邮箱设置页（对标 GoogleURLs.RECOVERY_EMAIL_SETTINGS） */
export const RECOVERY_EMAIL_SETTINGS_URL = "https://myaccount.google.com/signinoptions/rescueemail";

/** 验证码读取服务，对应 Python 的 GmailCodeReader */
export interface EmailCodeReader {
  fetchVerificationCode(options: {
    timeoutSeconds?: number;
    pollIntervalSeconds?: number;
  }): Promise<[boolean, string]>;
}

export type StepResult = [boolean, string];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 清洗 TOTP 密钥：去空格（与 Python 的 secret.replace(' ', '').strip() 一致） */
function cleanSecret(secret: string): string {
  return secret.replace(/ /g, "").trim();
}

/**
 * 检查登录状态并按需登录。
 * 返回 [是否可继续, 消息]。判定「已登录」的分支刻意保持宽松：
 * 找不到登录页元素就认为已登录（与 Python 一致）。
 */
export async function checkAndLoginForEmail(
  page: CompatPage,
  accountInfo: Record<string, unknown> | null,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("\n检测登录状态...");

    // 尝试点掉 Sign in 按钮（存在说明未登录）
    for (const selector of SIGN_IN_SELECTORS) {
      try {
        const btn = page.locator(selector).first();
        if ((await btn.count()) > 0 && (await btn.isVisible())) {
          log("❌ 检测到 Sign in 按钮，当前未登录");
          await btn.click();
          log("已点击 Sign in 按钮，等待登录页面加载...");
          await sleep(3000);
          break;
        }
      } catch {
        continue;
      }
    }

    // 找邮箱输入框——找得到才说明确实在登录页
    let emailInput: CompatLocator | null = null;
    try {
      emailInput = await page.waitForSelector('input[type="email"]', { timeout: 5000 });
    } catch {
      log("✅ 已登录或无需登录");
      return [true, "已登录"];
    }

    if (!emailInput) {
      log("✅ 已登录或无需登录");
      return [true, "已登录"];
    }

    log("❌ 未登录，开始登录流程...");
    if (!accountInfo) return [false, "需要登录但未提供账号信息"];

    const email = String(accountInfo["email"] ?? "").trim();
    const password = String(accountInfo["password"] ?? "").trim();
    const secret = String(accountInfo["secret"] ?? "").trim();

    if (!email || !password) return [false, "账号信息不完整（缺少邮箱或密码）"];

    log(`正在输入账号: ${email}`);
    await emailInput.fill(email);

    const clickedId = await clickFirstVisible(page, NEXT_SELECTORS);
    if (!clickedId) await page.keyboard.press("Enter");

    log("等待密码输入框...");
    await page.waitForSelector('input[type="password"]', { state: "visible", timeout: 15000 });

    log("正在输入密码...");
    await page.fill('input[type="password"]', password);

    const clickedPwd = await clickFirstVisible(page, PWD_NEXT_SELECTORS);
    if (!clickedPwd) await page.keyboard.press("Enter");

    log("等待2FA输入...");
    try {
      const totpInput = await page.waitForSelector(TOTP_INPUT_SELECTORS.join(", "), {
        timeout: 10000,
      });
      if (totpInput) {
        if (!secret) return [false, "需要2FA但未提供secret"];
        const code = generateTotp(cleanSecret(secret));
        log(`正在输入2FA验证码: ${code}`);
        await totpInput.fill(code);
        const clickedTotp = await clickFirstVisible(page, TOTP_NEXT_SELECTORS);
        if (!clickedTotp) await page.keyboard.press("Enter");
        log("✅ 2FA验证完成");
      }
    } catch (err) {
      log(`2FA步骤跳过或失败（可能不需要）: ${err}`);
    }

    await sleep(5000);
    log("✅ 登录流程完成");
    return [true, "登录成功"];
  } catch (err) {
    log(`登录检测出错: ${err}`);
    return [false, `登录检测错误: ${err}`];
  }
}

/**
 * 处理「Verify it's you」/ 重新输入密码两类挑战。
 * 返回 [是否可继续, 消息]；消息含「成功」时调用方会额外等待。
 */
export async function handleReauthChallenge(
  page: CompatPage,
  accountInfo: Record<string, unknown>,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("检测是否需要重新验证身份...");

    // 先看是否有 TOTP 输入框 + Verify it's you 文案
    try {
      const totpInput = await findFirstVisible(page, REAUTH_TOTP_SELECTORS);
      if (totpInput) {
        const pageText = await page.content();
        if (pageText.includes("Verify it") || pageText.includes("Authenticator") || pageText.includes("验证您的身份")) {
          log("⚠️ 检测到需要 2FA 验证（Verify it's you 页面）");
          const secret = String(accountInfo["secret"] ?? "").trim();
          if (!secret) return [false, "需要2FA验证但未提供secret"];

          const code = generateTotp(cleanSecret(secret));
          log(`正在输入2FA验证码: ${code}`);
          await totpInput.fill(code);

          const nextSelectors = [
            'button:has-text("Next")',
            'button:has-text("下一步")',
            'button[type="submit"]',
            "#totpNext button",
          ];
          await clickFirstVisible(page, nextSelectors);
          await sleep(3000);
          log("✅ 2FA 验证完成");
          return [true, "2FA验证成功"];
        }
      }
    } catch {
      /* 没有 2FA 挑战，继续看密码挑战 */
    }

    // 再看是否需要重新输密码
    try {
      const passwordInput = await page.waitForSelector('input[type="password"]:visible', {
        timeout: 3000,
      });
      if (passwordInput) {
        log("⚠️ 检测到需要重新验证密码");
        const password = String(accountInfo["password"] ?? "").trim();
        if (!password) return [false, "需要重新验证密码但未提供密码"];

        await passwordInput.fill(password);
        log("已输入密码");

        const nextSelectors = [
          'button[type="submit"]',
          'button:has-text("Next")',
          'button:has-text("下一步")',
          'button:has-text("Tiếp theo")',
          "#passwordNext button",
          'button[jsname="LgbsSe"]',
        ];
        const clicked = await clickFirstVisible(page, nextSelectors);
        if (!clicked) await page.keyboard.press("Enter");
        await sleep(3000);

        // 密码通过后可能还要 2FA
        try {
          const totpInput = await page.waitForSelector(
            'input[name="totpPin"], input[id="totpPin"], input[type="tel"][name*="code"], input[autocomplete="one-time-code"]',
            { timeout: 5000 },
          );
          if (totpInput) {
            log("⚠️ 检测到需要 2FA 验证");
            const secret = String(accountInfo["secret"] ?? "").trim();
            if (!secret) return [false, "需要2FA验证但未提供secret"];
            const code = generateTotp(cleanSecret(secret));
            log(`正在输入2FA验证码: ${code}`);
            await totpInput.fill(code);
            await clickFirstVisible(page, nextSelectors);
            await sleep(3000);
            log("✅ 2FA 验证完成");
          }
        } catch {
          log("无需 2FA 或已跳过");
        }

        log("✅ 重新验证身份完成");
        return [true, "重新验证身份成功"];
      }
    } catch {
      /* 不需要密码 */
    }

    log("✅ 无需重新验证身份");
    return [true, "无需验证"];
  } catch (err) {
    log(`处理重新验证时出错: ${err}`);
    return [false, `重新验证失败: ${err}`];
  }
}

/** 辅助邮箱当前状态 */
export type EmailStatus = "has_email" | "no_email" | "unknown";

/**
 * 检测当前是否已设置辅助邮箱。
 * 判定顺序：先读展示元素（能读到含 @ 的文本 → has_email），
 * 再看有没有添加按钮（→ no_email），最后看有没有编辑按钮（→ has_email）。
 */
export async function detectCurrentEmailStatus(
  page: CompatPage,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<[EmailStatus, string]> {
  try {
    await sleep(2000);

    const displaySelectors = ['[data-email]', 'div[role="listitem"]', ".recovery-email"];
    for (const selector of displaySelectors) {
      try {
        const element = page.locator(selector).first();
        if ((await element.count()) > 0) {
          const text = await (element as unknown as { textContent(): Promise<string> }).textContent();
          if (text && text.includes("@")) {
            log(`检测到现有辅助邮箱: ${text}`);
            return ["has_email", text.trim()];
          }
        }
      } catch {
        continue;
      }
    }

    const addSelectors = [
      'button:has-text("Add recovery email")',
      'button:has-text("Add email")',
      'button:has-text("添加辅助邮箱")',
      'button:has-text("添加电子邮件")',
      'a:has-text("Add recovery email")',
      '[aria-label*="Add"]',
    ];
    if (await findFirst(page, addSelectors)) {
      log("检测到无辅助邮箱（发现添加按钮）");
      return ["no_email", ""];
    }

    const editSelectors = [
      'button:has-text("Edit")',
      'button:has-text("Change")',
      'button:has-text("编辑")',
      'button:has-text("更改")',
      '[aria-label*="Edit"]',
      '[aria-label*="Change"]',
    ];
    if (await findFirst(page, editSelectors)) {
      log("检测到有辅助邮箱（发现编辑按钮）");
      return ["has_email", "(已设置)"];
    }

    log("⚠️ 无法确定辅助邮箱状态");
    return ["unknown", ""];
  } catch (err) {
    log(`检测辅助邮箱状态出错: ${err}`);
    return ["unknown", ""];
  }
}

export const REMOVE_ACTION_SELECTORS = [
  'button:has-text("Remove")',
  'button:has-text("Delete")',
  'button:has-text("删除")',
  'button:has-text("移除")',
  '[aria-label*="Remove"]',
  '[aria-label*="Delete"]',
  'button:has-text("Edit")',
  'button:has-text("Change")',
  'button:has-text("编辑")',
  'button:has-text("更改")',
];

/**
 * 删除确认弹窗按钮。
 * 复用共用的 CONFIRM_DIALOG_SELECTORS（含 Yes / 是 / MDC accept），
 * 再补 email 场景特有的 Remove email。
 */
export const CONFIRM_REMOVE_SELECTORS = [
  ...CONFIRM_DIALOG_SELECTORS,
  'button:has-text("Remove email")',
  'button:has-text("Delete")',
  'button:has-text("删除")',
  'button:has-text("移除")',
  '[aria-label*="Remove"]',
];

/** 删除旧辅助邮箱：先点编辑/删除入口，再点确认 */
export async function removeOldEmail(
  page: CompatPage,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("正在删除旧辅助邮箱...");

    const clicked = await clickFirstVisible(page, REMOVE_ACTION_SELECTORS);
    if (!clicked) return [false, "未找到删除/编辑按钮"];

    log(`已点击: ${clicked}`);
    await sleep(2000);
    await sleep(1000);

    const confirm = await clickFirstVisible(page, CONFIRM_REMOVE_SELECTORS);
    if (confirm) {
      log(`已确认删除: ${confirm}`);
      await sleep(2000);
    }

    return [true, "旧辅助邮箱已删除"];
  } catch (err) {
    log(`删除旧邮箱出错: ${err}`);
    return [false, `删除失败: ${err}`];
  }
}

export const ADD_EMAIL_SELECTORS = [
  'button:has-text("Add recovery email")',
  'button:has-text("Add email")',
  'button:has-text("Add")',
  'button:has-text("添加辅助邮箱")',
  'button:has-text("添加电子邮件")',
  'button:has-text("添加")',
  'a:has-text("Add recovery email")',
  '[aria-label*="Add"]',
];

export const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete*="email"]',
  'input[name*="email"]',
  'input[id*="email"]',
  'input[placeholder*="email"]',
  'input[placeholder*="Email"]',
  'input[placeholder*="recovery"]',
  'input[placeholder*="Recovery"]',
  'input[aria-label*="email"]',
  'input[aria-label*="Email"]',
  'input[aria-label*="recovery"]',
];

/** 调试用：页面上所有可见输入框（Python 侧在找不到验证码框时枚举它们） */
export const VISIBLE_INPUT_SELECTOR = "input:visible";

export const CODE_INPUT_SELECTORS = [
  'input[placeholder="Verification code"]',
  'input[placeholder="验证码"]',
  'input[placeholder*="Verification"]',
  'input[placeholder*="verification"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[name*="code"]',
  'input[id*="code"]',
  'input[id*="otp"]',
  'input[name*="otp"]',
  'input[autocomplete="one-time-code"]',
  'input[placeholder*="code"]',
  'input[placeholder*="Code"]',
  'input[aria-label*="code"]',
  'input[aria-label*="Code"]',
  'input[aria-label*="verification"]',
  'input[aria-label*="Verification"]',
  'input[aria-label*="Enter"]',
  'input[data-action-name*="code"]',
  "input[jsname]",
  "input.whsOnd",
  'input[dir="ltr"]',
  "input[data-initial-value]",
  'input[maxlength="6"]',
];

/**
 * 验证码提交后的「Verify」按钮候选。
 * 注意 Google 的验证弹窗里该按钮在**右侧**，必须用 last 定位，
 * 用 first 会点到左侧无关元素。Python 源码对此有明确注释。
 */
export const VERIFY_DIALOG_SELECTORS = [
  'text="Verify"',
  ':text("Verify")',
  'button >> text="Verify"',
  '*:has-text("Verify"):visible',
  'button:has-text("Verify")',
  'button:text-is("Verify")',
  'span:text-is("Verify")',
  'a:text-is("Verify")',
  'div:text-is("Verify")',
  '[role="button"]:has-text("Verify")',
  'text="验证"',
  'text="確認"',
  'button:has-text("Next")',
  'button:has-text("Continue")',
  'button[type="submit"]',
];

/** 验证码提交后的最终保存按钮 */
export const FINAL_SAVE_SELECTORS = [
  'button:has-text("Save")',
  'button:has-text("Done")',
  'button:has-text("Confirm")',
  'button:has-text("保存")',
  'button:has-text("完成")',
  'button:has-text("确认")',
  'button:has-text("確認")',
];

/** 邮箱添加失败时的错误提示特征（div:has-text 形式） */
export const EMAIL_ERROR_TEXT_SELECTORS = [
  'div:has-text("Invalid email")',
  'div:has-text("Error")',
  'div:has-text("错误")',
  'div:has-text("无效")',
];

export const SAVE_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Save")',
  'button:has-text("Verify")',
  'button:has-text("Send")',
  'button:has-text("Continue")',
  'button:has-text("下一步")',
  'button:has-text("保存")',
  'button:has-text("验证")',
  'button:has-text("发送")',
  'button:has-text("继续")',
  'button[type="submit"]',
];

/**
 * 添加新辅助邮箱。
 * 输入框定位用了「先枚举候选选择器（最多 5 轮）→ 再 waitForSelector → 最后通用探测」
 * 三级降级，因为 Google 的表单结构在不同账号/语言下差异很大。
 */
export async function addNewEmail(
  page: CompatPage,
  newEmail: string,
  codeReader: EmailCodeReader | null,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log(`正在添加新辅助邮箱: ${newEmail}`);
    await sleep(2000);

    // 点添加按钮（点不到也继续，可能已经在表单页）
    const addClicked = await clickFirstVisible(page, ADD_EMAIL_SELECTORS);
    if (addClicked) log(`已点击添加按钮: ${addClicked}`);
    await sleep(2000);

    // 找邮箱输入框：最多 5 轮
    const emailInput = await findFirstVisibleWithRetry(page, EMAIL_INPUT_SELECTORS, {
      attempts: 5,
      intervalMs: 3000,
    });

    if (!emailInput) {
      // 二级降级：waitForSelector
      let viaWait: CompatLocator | null = null;
      try {
        viaWait = await page.waitForSelector('input[type="email"]', { timeout: 10000 });
        if (viaWait) log("通过 waitForSelector 找到邮箱输入框");
      } catch {
        /* 落到下一级 */
      }
      if (!viaWait) {
        log("⚠️ 未找到邮箱输入框");
        return [false, "未找到邮箱输入框"];
      }
      await viaWait.click();
      await viaWait.fill("");
      await sleep(500);
      await viaWait.fill(newEmail);
    } else {
      await emailInput.click();
      await emailInput.fill("");
      await sleep(500);
      await emailInput.fill(newEmail);
    }

    log("✅ 已输入辅助邮箱");
    await sleep(1000);

    // 提交
    const submitted = await clickFirstVisible(page, SAVE_SELECTORS);
    if (!submitted) {
      await page.keyboard.press("Enter");
      log("已按 Enter 键提交");
    } else {
      log(`已点击按钮: ${submitted}`);
    }
    await sleep(3000);

    // 找验证码输入框：最多 10 轮，跳过已填了邮箱的输入框
    let codeInput: CompatLocator | null = null;
    log("开始检测验证码输入框...");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      for (const selector of CODE_INPUT_SELECTORS) {
        try {
          const element = page.locator(selector).first();
          if ((await element.count()) > 0 && (await element.isVisible())) {
            const currentValue = await (
              element as unknown as { inputValue(): Promise<string> }
            ).inputValue();
            if (!currentValue.includes("@")) {
              codeInput = element;
              log(`检测到验证码输入框: ${selector}`);
              break;
            }
          }
        } catch {
          continue;
        }
      }
      if (codeInput) break;
      log(`  等待验证码输入框... (${attempt + 1}/10)`);
      await sleep(2000);
    }

    if (codeInput) {
      log("⚠️ 需要输入邮箱验证码，开始读取...");

      if (!codeReader) return [false, "需要验证码但未提供读取器"];

      const [ok, code] = await codeReader.fetchVerificationCode({
        timeoutSeconds: 90,
        pollIntervalSeconds: 5,
      });

      if (!ok) {
        log(`❌ 获取验证码失败: ${code}`);
        return [false, `获取验证码失败: ${code}`];
      }

      log(`✅ 获取到验证码: ${code}`);
      await codeInput.fill(code);
      log("已输入验证码");
      await sleep(1000);

      // 验证按钮在弹窗右侧 → 必须用 last；全失败则退化为 Tab+Enter
      const verifyHit = await clickLastVisible(page, VERIFY_DIALOG_SELECTORS);
      if (verifyHit) {
        log(`✅ 已点击验证按钮: ${verifyHit}`);
      } else {
        log("⚠️ 未找到验证按钮，尝试 Tab+Enter 提交...");
        await page.keyboard.press("Tab");
        await sleep(300);
        await page.keyboard.press("Enter");
      }
      await sleep(3000);

      // 可能还需要点一次最终保存
      const finalSave = await clickFirstVisible(page, FINAL_SAVE_SELECTORS);
      if (finalSave) {
        log(`✅ 已点击最终保存按钮: ${finalSave}`);
        await sleep(3000);
      }
    } else {
      log("⚠️ 未检测到验证码输入框");
    }

    // 结果判定：出现错误提示即失败
    const errText = await detectErrorText(page, EMAIL_ERROR_TEXT_SELECTORS);
    if (errText) {
      const lower = errText.toLowerCase();
      if (EMAIL_ERROR_HINTS.some((h) => lower.includes(h.toLowerCase()))) {
        return [false, `添加失败: ${errText}`];
      }
    }

    return [true, "辅助邮箱添加完成"];
  } catch (err) {
    log(`添加辅助邮箱出错: ${err}`);
    return [false, `添加失败: ${err}`];
  }
}

/**
 * 主流程。对标 auto_replace_email()。
 * 传入的是已连接的 CompatPage（连接由调用方负责，便于复用窗口）。
 */
export async function autoReplaceEmail(
  page: CompatPage,
  newEmail: string,
  accountInfo: Record<string, unknown> | null,
  codeReader: EmailCodeReader | null,
  options: { pageLoadTimeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<StepResult> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  try {
    log(`${"=".repeat(50)}`);
    log("开始替换辅助邮箱流程");
    log(`目标辅助邮箱: ${newEmail}`);
    log(`${"=".repeat(50)}\n`);

    log(`导航到: ${RECOVERY_EMAIL_SETTINGS_URL}`);
    try {
      await page.goto(RECOVERY_EMAIL_SETTINGS_URL, {
        timeout: options.pageLoadTimeoutMs ?? 30000,
      });
    } catch (err) {
      log(`导航失败: ${err}`);
      return [false, `导航失败: ${err}`];
    }
    await sleep(3000);

    const [loginOk, loginMsg] = await checkAndLoginForEmail(page, accountInfo, log);
    if (!loginOk && loginMsg.includes("需要登录")) {
      return [false, `登录失败: ${loginMsg}`];
    }
    if (loginMsg.includes("登录成功")) {
      log("登录后重新导航到辅助邮箱设置页面...");
      await page.goto(RECOVERY_EMAIL_SETTINGS_URL, { timeout: 60000 });
      await sleep(3000);
    }

    const [reauthOk, reauthMsg] = await handleReauthChallenge(page, accountInfo ?? {}, log);
    if (!reauthOk) return [false, `重新验证失败: ${reauthMsg}`];
    if (reauthMsg.includes("成功")) await sleep(2000);

    const [status, currentEmail] = await detectCurrentEmailStatus(page, log);
    log(`当前状态: ${status}, 现有辅助邮箱: ${currentEmail}`);

    if (status === "has_email") {
      log("检测到已有辅助邮箱，先删除...");
      const [removeOk, removeMsg] = await removeOldEmail(page, log);
      if (!removeOk) log(`删除旧邮箱失败: ${removeMsg}，尝试直接替换...`);
      await sleep(2000);

      const [reauth2Ok, reauth2Msg] = await handleReauthChallenge(page, accountInfo ?? {}, log);
      if (!reauth2Ok) return [false, `删除后重新验证失败: ${reauth2Msg}`];
    }

    let [addOk, addMsg] = await addNewEmail(page, newEmail, codeReader, log);

    // 被要求验证时重新验证后重试一次
    if (!addOk && (addMsg.includes("验证") || addMsg.toLowerCase().includes("password"))) {
      const [retryReauthOk] = await handleReauthChallenge(page, accountInfo ?? {}, log);
      if (retryReauthOk) {
        [addOk, addMsg] = await addNewEmail(page, newEmail, codeReader, log);
      }
    }

    if (addOk) {
      log(`\n${"=".repeat(50)}`);
      log(`✅ 辅助邮箱替换成功: ${newEmail}`);
      log(`${"=".repeat(50)}\n`);
      return [true, `辅助邮箱替换成功: ${newEmail}`];
    }
    return [false, addMsg];
  } catch (err) {
    log(`❌ 替换辅助邮箱流程出错: ${err}`);
    return [false, `替换失败: ${err}`];
  }
}