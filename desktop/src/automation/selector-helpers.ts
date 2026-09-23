/**
 * 选择器尝试辅助
 *
 * auto_replace_email / auto_replace_phone 这两个脚本是确定性选择器驱动，
 * Python 源码里到处是同一个模式：
 *
 *     for selector in [一堆候选选择器]:
 *         try:
 *             el = page.locator(selector).first
 *             if await el.count() > 0 and await el.is_visible():
 *                 await el.click()
 *                 break
 *         except:
 *             continue
 *
 * 这段在两个文件里重复了 20 多次，共约 400 行。抽成这里，行为保持一致：
 *   - 逐个尝试，任一成功即返回
 *   - 单个选择器出错不中断整个循环（Google 页面在不同语言/版本下
 *     会命中不同的非法选择器）
 *   - 全部失败返回 null，由调用方决定后续
 */
import type { CompatLocator, CompatPage } from "../engine/playwright-compat.ts";

/** 逐个尝试选择器，返回第一个「存在且可见」的定位器 */
export async function findFirstVisible(
  page: CompatPage,
  selectors: readonly string[],
): Promise<CompatLocator | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
    } catch {
      continue;
    }
  }
  return null;
}

/** 逐个尝试选择器，返回第一个「存在」的定位器（不要求可见） */
export async function findFirst(
  page: CompatPage,
  selectors: readonly string[],
): Promise<CompatLocator | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0) return loc;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 逐个尝试点击，返回命中的选择器（未命中返回 null）。
 * 调用方常需要知道「是否点到了」，故返回选择器而非布尔。
 */
export async function clickFirstVisible(
  page: CompatPage,
  selectors: readonly string[],
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.click();
        return selector;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 逐个尝试点击**最后一个**匹配元素。
 *
 * 为什么需要它：Google 的验证弹窗里 "Verify" 按钮在右侧，
 * 用 first 会点到左侧的无关元素。Python 侧对此有明确注释
 * （"用 last 因为 Verify 在右边"），必须保留。
 */
export async function clickLastVisible(
  page: CompatPage,
  selectors: readonly string[],
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const base = page.locator(selector);
      // CompatLocator 的 last 能力：借 count 定位到下标末尾
      const count = await base.count();
      if (count === 0) continue;
      const loc = nthOf(base, count - 1);
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.click();
        return selector;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 取第 n 个匹配元素。
 * CompatLocator 只暴露 first()，这里用 first 链做不到 nth，
 * 故通过底层 locator 的 nth 能力实现；不可用时退化为 first。
 */
function nthOf(loc: CompatLocator, index: number): CompatLocator {
  const raw = loc as unknown as { nth?: (i: number) => CompatLocator };
  if (typeof raw.nth === "function") {
    try {
      return raw.nth(index);
    } catch {
      /* 落到 first */
    }
  }
  return loc.first();
}

/**
 * 逐个尝试填充，返回命中的选择器（未命中返回 null）。
 * 用于「不知道输入框长什么样，试一批选择器」的场景。
 */
export async function fillFirstVisible(
  page: CompatPage,
  selectors: readonly string[],
  value: string,
): Promise<string | null> {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.fill(value);
        return selector;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 带重试地逐个尝试选择器。
 * Python 侧对应「for attempt in range(N): ... await asyncio.sleep(间隔)」那类结构。
 */
export async function findFirstVisibleWithRetry(
  page: CompatPage,
  selectors: readonly string[],
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<CompatLocator | null> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 3000;

  for (let i = 0; i < attempts; i += 1) {
    const found = await findFirstVisible(page, selectors);
    if (found) return found;
    if (i < attempts - 1) await page.waitForTimeout(intervalMs);
  }
  return null;
}

// ==================== 选择器表（逐字照搬 Python） ====================

/** 登录按钮候选 */
export const SIGN_IN_SELECTORS = [
  'button:has-text("Sign in")',
  'a:has-text("Sign in")',
  'text="Sign in"',
  'button:has-text("登录")',
  'a:has-text("登录")',
];

/** 邮箱页的「下一步」按钮候选（Google 各语言/版本） */
export const NEXT_SELECTORS = [
  "#identifierNext >> button",
  "#identifierNext button",
  'button[jsname="LgbsSe"]',
  'button:has-text("Next")',
  'button:has-text("下一步")',
  'button:has-text("Tiếp theo")',
];

/** 密码页的「下一步」按钮候选 */
export const PWD_NEXT_SELECTORS = [
  "#passwordNext >> button",
  "#passwordNext button",
  'button[jsname="LgbsSe"]',
  'button:has-text("Next")',
  'button:has-text("下一步")',
];

/** TOTP 页的「下一步」按钮候选 */
export const TOTP_NEXT_SELECTORS = [
  "#totpNext >> button",
  "#totpNext button",
  'button[jsname="LgbsSe"]',
  'button:has-text("Next")',
  'button:has-text("下一步")',
];

/** TOTP 输入框候选 */
export const TOTP_INPUT_SELECTORS = [
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[type="tel"]',
];

/** 重新验证场景下的 TOTP 输入框候选（范围更广） */
export const REAUTH_TOTP_SELECTORS = [
  'input[type="tel"]',
  'input[name="totpPin"]',
  'input[id="totpPin"]',
  'input[autocomplete="one-time-code"]',
  'input[placeholder*="code"]',
  'input[placeholder*="Enter code"]',
];
// ==================== 弹窗与引导（两个脚本共用） ====================

/** 删除确认弹窗的确认按钮（含 Google 的 MDC 对话框） */
export const CONFIRM_DIALOG_SELECTORS = [
  'button:has-text("Yes")',
  'button:has-text("Remove")',
  'button:has-text("确认")',
  'button:has-text("是")',
  '[data-mdc-dialog-action="accept"]',
];

/**
 * 引导弹窗的跳过按钮。
 * Google 在添加恢复方式后常弹「了解详情 / 稍后提醒」，
 * 不点掉会挡住后续的保存按钮。
 */
export const SKIP_SELECTORS = [
  'button:has-text("Skip")',
  'button:has-text("Not now")',
  'button:has-text("Later")',
  'button:has-text("跳过")',
  'button:has-text("以后再说")',
  'button:has-text("稍后")',
  'a:has-text("Skip")',
];

/** 错误提示容器（文案判定由调用方做，因为邮箱/手机号的文案不同） */
export const ERROR_ALERT_SELECTORS = [
  'div[role="alert"]',
  ".error-message",
];

/** 邮箱场景的错误文案特征 */
export const EMAIL_ERROR_HINTS = ["invalid email", "error", "错误", "无效"];

/** 手机号场景的错误文案特征 */
export const PHONE_ERROR_HINTS = ["invalid phone", "error", "错误", "无效"];

/**
 * 检查页面是否出现错误提示。
 * 返回错误文本（无错误返回 null）。
 */
export async function detectErrorText(
  page: CompatPage,
  extraSelectors: readonly string[] = [],
): Promise<string | null> {
  for (const selector of [...ERROR_ALERT_SELECTORS, ...extraSelectors]) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        const text = await (loc as unknown as { textContent(): Promise<string> }).textContent();
        if (text && text.trim().length > 0) return text.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}