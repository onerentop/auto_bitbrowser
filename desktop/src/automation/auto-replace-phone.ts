/**
 * 替换恢复手机号（Playwright 选择器直连版）
 *
 * 结构与 auto-replace-email.ts 几乎一致，两处关键差异：
 *   1. 输入的是手机号（tel 类选择器）而非邮箱
 *   2. **不自动取码**——检测到短信验证码输入框后等 15 秒，
 *      让用户手动输入，然后点确认。因为短信平台与页面校验的时序不稳定，
 *      自动填码容易失败。
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
  CONFIRM_DIALOG_SELECTORS,
  detectErrorText,
  findFirst,
  findFirstVisible,
  PHONE_ERROR_HINTS,
  SKIP_SELECTORS,
} from "./selector-helpers.ts";

/** 恢复手机设置页 */
export const RECOVERY_PHONE_SETTINGS_URL = "https://myaccount.google.com/signinoptions/rescuephone";

export type StepResult = [boolean, string];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function cleanSecret(secret: string): string {
  return secret.replace(/ /g, "").trim();
}

/** 与 email 版同构：找不到登录页元素即视为已登录 */
export async function checkAndLoginForPhone(
  page: CompatPage,
  accountInfo: Record<string, unknown> | null,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("\n检测登录状态...");

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
    if (!(await clickFirstVisible(page, NEXT_SELECTORS))) await page.keyboard.press("Enter");

    log("等待密码输入框...");
    await page.waitForSelector('input[type="password"]', { state: "visible", timeout: 15000 });
    log("正在输入密码...");
    await page.fill('input[type="password"]', password);
    if (!(await clickFirstVisible(page, PWD_NEXT_SELECTORS))) await page.keyboard.press("Enter");

    log("等待2FA输入...");
    try {
      const totpInput = await page.waitForSelector(TOTP_INPUT_SELECTORS.join(", "), { timeout: 10000 });
      if (totpInput) {
        if (!secret) return [false, "需要2FA但未提供secret"];
        const code = generateTotp(cleanSecret(secret));
        log(`正在输入2FA验证码: ${code}`);
        await totpInput.fill(code);
        if (!(await clickFirstVisible(page, TOTP_NEXT_SELECTORS))) await page.keyboard.press("Enter");
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

/** 与 email 版一致：TOTP 挑战优先，其次密码挑战 */
export async function handleReauthChallenge(
  page: CompatPage,
  accountInfo: Record<string, unknown>,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("检测是否需要重新验证身份...");

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
          await clickFirstVisible(page, [
            'button:has-text("Next")',
            'button:has-text("下一步")',
            'button[type="submit"]',
            "#totpNext button",
          ]);
          await sleep(3000);
          log("✅ 2FA 验证完成");
          return [true, "2FA验证成功"];
        }
      }
    } catch {
      /* 无 TOTP 挑战 */
    }

    try {
      const passwordInput = await page.waitForSelector('input[type="password"]:visible', { timeout: 3000 });
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
        if (!(await clickFirstVisible(page, nextSelectors))) await page.keyboard.press("Enter");
        await sleep(3000);

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
      /* 无需密码 */
    }

    log("✅ 无需重新验证身份");
    return [true, "无需验证"];
  } catch (err) {
    log(`处理重新验证时出错: ${err}`);
    return [false, `重新验证失败: ${err}`];
  }
}

export type PhoneStatus = "has_phone" | "no_phone" | "unknown";

/** 检测当前是否已设置恢复手机号 */
export async function detectCurrentPhoneStatus(
  page: CompatPage,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<[PhoneStatus, string]> {
  try {
    await sleep(2000);

    const displaySelectors = [
      '[data-phone]',
      '[data-phone-number]',
      'div[role="listitem"]',
      ".recovery-phone",
      // 形如 +86 138... 的数字串；排除含 Add 的按钮文案
      'span:has-text("+"):not(:has-text("Add"))',
    ];
    for (const selector of displaySelectors) {
      try {
        const element = page.locator(selector).first();
        if ((await element.count()) > 0) {
          const text = await (element as unknown as { textContent(): Promise<string> }).textContent();
          // 手机号特征：包含数字且长度足够
          if (text && /\d{4,}/.test(text)) {
            log(`检测到现有恢复手机号: ${text}`);
            return ["has_phone", text.trim()];
          }
        }
      } catch {
        continue;
      }
    }

    const addSelectors = [
      'button:has-text("Add recovery phone")',
      'button:has-text("Add phone")',
      'button:has-text("添加恢复手机")',
      'button:has-text("添加手机")',
      'a:has-text("Add recovery phone")',
      '[aria-label*="Add"]',
    ];
    if (await findFirst(page, addSelectors)) {
      log("检测到无恢复手机号（发现添加按钮）");
      return ["no_phone", ""];
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
      log("检测到有恢复手机号（发现编辑按钮）");
      return ["has_phone", "(已设置)"];
    }

    log("⚠️ 无法确定恢复手机号状态");
    return ["unknown", ""];
  } catch (err) {
    log(`检测恢复手机号状态出错: ${err}`);
    return ["unknown", ""];
  }
}

export const REMOVE_PHONE_ACTION_SELECTORS = [
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

export const CONFIRM_REMOVE_PHONE_SELECTORS = [
  ...CONFIRM_DIALOG_SELECTORS,
  'button:has-text("Remove phone")',
  'button:has-text("Delete")',
  'button:has-text("删除")',
  'button:has-text("移除")',
  '[aria-label*="Remove"]',
];

export async function removeOldPhone(
  page: CompatPage,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log("正在删除旧恢复手机号...");

    const clicked = await clickFirstVisible(page, REMOVE_PHONE_ACTION_SELECTORS);
    if (!clicked) return [false, "未找到删除/编辑按钮"];

    log(`已点击: ${clicked}`);
    await sleep(2000);
    await sleep(1000);

    const confirm = await clickFirstVisible(page, CONFIRM_REMOVE_PHONE_SELECTORS);
    if (confirm) {
      log(`已确认删除: ${confirm}`);
      await sleep(2000);
    }

    return [true, "旧恢复手机号已删除"];
  } catch (err) {
    log(`删除旧手机号出错: ${err}`);
    return [false, `删除失败: ${err}`];
  }
}

export const ADD_PHONE_SELECTORS = [
  'button:has-text("Add recovery phone")',
  'button:has-text("Add phone")',
  'button:has-text("Add")',
  'button:has-text("添加恢复手机")',
  'button:has-text("添加手机号")',
  'button:has-text("添加恢复电话")',
  'button:has-text("添加手机")',
  'button:has-text("添加")',
  'a:has-text("Add recovery phone")',
  '[aria-label*="Add"]',
];

export const PHONE_INPUT_SELECTORS = [
  'input[type="tel"]',
  'input[autocomplete*="tel"]',
  'input[name*="phone"]',
  'input[id*="phone"]',
  'input[placeholder*="phone"]',
  'input[placeholder*="Phone"]',
  'input[aria-label*="phone"]',
  'input[aria-label*="Phone"]',
];

export const PHONE_NEXT_SELECTORS = [
  'button:has-text("Next")',
  'button:has-text("Verify")',
  'button:has-text("Send")',
  'button:has-text("Continue")',
  'button:has-text("下一步")',
  'button:has-text("验证")',
  'button:has-text("发送")',
  'button:has-text("继续")',
  'button[type="submit"]',
];

export const PHONE_SAVE_SELECTORS = [
  'button:has-text("Save")',
  'button:has-text("Done")',
  'button:has-text("Confirm")',
  'button:has-text("保存")',
  'button:has-text("完成")',
  'button:has-text("确认")',
  'button:has-text("確認")',
  'button[type="submit"]',
];

export const SMS_CODE_INPUT_SELECTORS = [
  'input[placeholder="Verification code"]',
  'input[placeholder="验证码"]',
  'input[placeholder*="验证码"]',
  'input[type="tel"]:not([value])',
  'input[placeholder*="Verification"]',
  'input[placeholder*="Code"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[name*="code"]',
  'input[id*="code"]',
  'input[autocomplete="one-time-code"]',
  'input[maxlength="6"]',
];

/** 检测到短信验证码框后等待用户手动输入的时长 */
export const MANUAL_CODE_WAIT_MS = 15000;

/**
 * 添加新恢复手机号。
 * 与 email 版的关键差异：检测到验证码框后**等 15 秒让用户手动输入**，
 * 不自动取码。
 */
export async function addNewPhone(
  page: CompatPage,
  phoneNumber: string,
  log: (msg: string) => void = (m) => process.stdout.write(`${m}\n`),
): Promise<StepResult> {
  try {
    log(`正在添加新恢复手机号: ${phoneNumber}`);
    await sleep(2000);

    const addClicked = await clickFirstVisible(page, ADD_PHONE_SELECTORS);
    if (addClicked) log(`已点击添加按钮: ${addClicked}`);
    await sleep(2000);

    // 找手机号输入框
    let phoneInput: CompatLocator | null = await findFirstVisible(page, PHONE_INPUT_SELECTORS);
    if (!phoneInput) {
      try {
        phoneInput = await page.waitForSelector('input[type="tel"]', { timeout: 10000 });
      } catch {
        /* 落到下面的失败返回 */
      }
    }
    if (!phoneInput) return [false, "未找到手机号输入框"];

    await phoneInput.click();
    await phoneInput.fill("");
    await sleep(500);
    await phoneInput.fill(phoneNumber);
    log("✅ 已输入手机号");

    await sleep(1000);

    const submitted = await clickFirstVisible(page, PHONE_NEXT_SELECTORS);
    if (!submitted) await page.keyboard.press("Enter");
    await sleep(3000);

    // 点掉 Google 的引导弹窗（了解详情/稍后提醒），否则会挡住后续按钮
    const skipped = await clickFirstVisible(page, SKIP_SELECTORS);
    if (skipped) {
      log(`已跳过引导弹窗: ${skipped}`);
      await sleep(2000);
    }

    // 检测短信验证码框——找到也不自动填，等用户
    let smsCodeInput: CompatLocator | null = null;
    for (const selector of SMS_CODE_INPUT_SELECTORS) {
      try {
        const element = page.locator(selector).first();
        if ((await element.count()) > 0 && (await element.isVisible())) {
          const currentValue = await (
            element as unknown as { inputValue(): Promise<string> }
          ).inputValue();
          if (!/\d{6}/.test(currentValue)) {
            smsCodeInput = element;
            log(`⚠️ 检测到需要输入短信验证码: ${selector}`);
            break;
          }
        }
      } catch {
        continue;
      }
    }

    if (smsCodeInput) {
      log("⚠️ 需要输入短信验证码，等待用户手动输入或自动跳过...");
      await sleep(MANUAL_CODE_WAIT_MS);

      // 用户输完（或跳过）后点确认
      await clickFirstVisible(page, PHONE_NEXT_SELECTORS);
      await sleep(3000);
    }

    // 最终保存
    const saved = await clickFirstVisible(page, PHONE_SAVE_SELECTORS);
    if (saved) {
      log(`已点击保存: ${saved}`);
      await sleep(2000);
    }

    // 结果判定：出现错误提示即失败
    const errText = await detectErrorText(page, [
      'div:has-text("Invalid phone")',
      'div:has-text("Error")',
      'div:has-text("错误")',
      'div:has-text("无效")',
    ]);
    if (errText) {
      const lower = errText.toLowerCase();
      if (PHONE_ERROR_HINTS.some((h) => lower.includes(h.toLowerCase()))) {
        return [false, `添加失败: ${errText}`];
      }
    }

    return [true, "恢复手机号添加完成"];
  } catch (err) {
    log(`添加恢复手机号出错: ${err}`);
    return [false, `添加失败: ${err}`];
  }
}

/** 主流程。 */
export async function autoReplacePhone(
  page: CompatPage,
  phoneNumber: string,
  accountInfo: Record<string, unknown> | null,
  options: { pageLoadTimeoutMs?: number; log?: (msg: string) => void } = {},
): Promise<StepResult> {
  const log = options.log ?? ((m: string) => process.stdout.write(`${m}\n`));

  try {
    log(`${"=".repeat(50)}`);
    log("开始替换恢复手机号流程");
    log(`新手机号: ${phoneNumber}`);
    log(`${"=".repeat(50)}\n`);

    log(`导航到: ${RECOVERY_PHONE_SETTINGS_URL}`);
    try {
      await page.goto(RECOVERY_PHONE_SETTINGS_URL, {
        timeout: options.pageLoadTimeoutMs ?? 30000,
      });
    } catch (err) {
      log(`导航失败: ${err}`);
      return [false, `导航失败: ${err}`];
    }
    await sleep(3000);

    const [loginOk, loginMsg] = await checkAndLoginForPhone(page, accountInfo, log);
    if (!loginOk && loginMsg.includes("需要登录")) return [false, `登录失败: ${loginMsg}`];
    if (loginMsg.includes("登录成功")) {
      log("登录后重新导航到恢复手机设置页面...");
      await page.goto(RECOVERY_PHONE_SETTINGS_URL, { timeout: 60000 });
      await sleep(3000);
    }

    const [reauthOk, reauthMsg] = await handleReauthChallenge(page, accountInfo ?? {}, log);
    if (!reauthOk) return [false, `重新验证失败: ${reauthMsg}`];
    if (reauthMsg.includes("成功")) await sleep(2000);

    const [status, currentPhone] = await detectCurrentPhoneStatus(page, log);
    log(`当前状态: ${status}, 现有手机号: ${currentPhone}`);

    if (status === "has_phone") {
      log("检测到已有恢复手机号，先删除...");
      const [removeOk, removeMsg] = await removeOldPhone(page, log);
      if (!removeOk) log(`删除旧手机号失败: ${removeMsg}，尝试直接替换...`);
      await sleep(2000);

      const [reauth2Ok, reauth2Msg] = await handleReauthChallenge(page, accountInfo ?? {}, log);
      if (!reauth2Ok) return [false, `删除后重新验证失败: ${reauth2Msg}`];
    }

    let [addOk, addMsg] = await addNewPhone(page, phoneNumber, log);

    if (!addOk && (addMsg.includes("验证") || addMsg.toLowerCase().includes("password"))) {
      const [retryReauthOk] = await handleReauthChallenge(page, accountInfo ?? {}, log);
      if (retryReauthOk) {
        [addOk, addMsg] = await addNewPhone(page, phoneNumber, log);
      }
    }

    if (addOk) {
      log(`\n${"=".repeat(50)}`);
      log(`✅ 恢复手机号替换成功: ${phoneNumber}`);
      log(`${"=".repeat(50)}\n`);
      return [true, `恢复手机号替换成功: ${phoneNumber}`];
    }
    return [false, addMsg];
  } catch (err) {
    log(`❌ 替换恢复手机号流程出错: ${err}`);
    return [false, `替换失败: ${err}`];
  }
}