/**
 * Google 敏感设置页的「重新验证身份」——替换手机 / 替换邮箱 / 修改验证器 / 修改 2SV / 踢设备 / 改密共用一份。
 *
 * 这 6 个操作原来各写一份，经过几轮真机修复后已经分叉；这里合并了各份经真机验证过的写法：
 *   1. 验证页可能**直接给验证码框**，也可能先要密码（替换邮箱、踢设备那两轮真机）
 *      → 每轮先找验证码框，没有才填密码，最多 maxRounds 轮。
 *   2. 提交密码后如果出现验证码框，就是进入了下一步（真机：密码 → 验证码），立即进入下一轮，
 *      不用等到超时（替换手机那轮真机）。
 *   3. 提交顺序是 Enter → 点按钮 → 在按钮上派发 click。真机实测：密码页先按 Enter 就能提交；
 *      先点外层 div（#passwordNext）会把焦点带走，Enter 反而失效（修改验证器那轮真机）。
 *   4. 同一个 30 秒窗口里的验证码只能提交一次，重复提交 Google 会回「验证码错误，请重试」；
 *      同一窗口里重新生成还是同一个码，所以必须等到下一个窗口（修改 2SV 那轮真机）。
 *
 * 凭据只经 fill 写入，**不经过 act()**：AI 指令、日志、返回值里都不能出现凭据（日志只记密码长度）。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { Timeouts } from "../constants.ts";
import { generateTotp } from "../totp.ts";

/** 「重新验证身份」所需凭据（由 automation 层从数据库账号传入） */
export interface ReauthCredentials {
  password?: string | null;
  totpSecret?: string | null;
}

export interface ReauthOutcome {
  success: boolean;
  message?: string;
  error?: string;
}

/** 本模块用到的引擎原语 */
export type ReauthEngine = Pick<
  StagehandGoogleEngine,
  "getCurrentUrl" | "getPageContent" | "isVisible" | "fill" | "pressKey" | "click" | "jsClick" | "wait"
>;

/** 验证页的输入框 / 按钮选择器（与 login.ts 同一套） */
export const REAUTH_PASSWORD_SELECTORS: readonly string[] = ['input[name="Passwd"]', '#password input[type="password"]'];
export const REAUTH_PASSWORD_NEXT_SELECTORS: readonly string[] = ["#passwordNext button", "#passwordNext"];
export const REAUTH_TOTP_SELECTORS: readonly string[] = ["#totpPin", 'input[name="totpPin"]'];
export const REAUTH_TOTP_NEXT_SELECTORS: readonly string[] = ["#totpNext button", "#totpNext"];
/** 验证页特征：URL 含 /challenge/，或页面上有 Google 的提示文案 */
export const REAUTH_TEXT_PATTERN = /请先验证您的身份|输入您的密码|Verify it'?s you|Enter your password/i;
/** navigate 返回后 Google 可能还在重定向，判定阶段的轮询上限 */
export const REAUTH_DETECT_TIMEOUT_MS = 6000;
/** 提交一步之后等待下一步（验证码框 / 跳回设置页）的上限 */
export const REAUTH_STEP_TIMEOUT_MS = 8000;
/** 默认最多提交几轮（密码 → 验证码 两步） */
export const REAUTH_DEFAULT_ROUNDS = 2;
/** 一轮没通过时，下一轮之前的等待 */
const RETRY_PAUSE_MS = 1000;

/** 第一个可见的选择器；都不可见返回 null */
export async function visibleSelector(
  engine: Pick<StagehandGoogleEngine, "isVisible">,
  selectors: readonly string[],
): Promise<string | null> {
  for (const s of selectors) if (await engine.isVisible(s)) return s;
  return null;
}

/** 轮询等待条件成立（每 500 毫秒查一次） */
export async function waitUntil(
  engine: Pick<StagehandGoogleEngine, "wait">,
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await engine.wait(500);
  }
}

export interface ReauthOptions {
  /** 最多提交几轮（默认 2；改密传 3，留一轮余量） */
  maxRounds?: number;
  /** 额外的验证页文案特征（改密页多认「验证身份」）；不要带 g 标志 */
  extraTextPattern?: RegExp;
  /** 任务日志：只记轮次与密码长度，不记内容 */
  log?: (msg: string) => void;
}

/**
 * 每个 operation 实例持有一个：上一次提交的验证码记在实例上，
 * 同一次操作里第二次遇到验证页（例如核对结果时重新导航）也不会重复提交同一个码。
 */
export class GoogleReauth {
  private readonly engine: ReauthEngine;
  private readonly maxRounds: number;
  private readonly extraTextPattern: RegExp | null;
  private readonly log: (msg: string) => void;
  private lastTotpCode: string | null = null;

  constructor(engine: ReauthEngine, options: ReauthOptions = {}) {
    this.engine = engine;
    this.maxRounds = options.maxRounds ?? REAUTH_DEFAULT_ROUNDS;
    // 带 g 标志的正则 .test() 会记忆 lastIndex（时判时不判），这里统一去掉
    const extra = options.extraTextPattern;
    this.extraTextPattern = extra ? new RegExp(extra.source, extra.flags.replace("g", "")) : null;
    this.log = options.log ?? (() => {});
  }

  /** 当前页面是不是 Google 的「重新验证身份」页 */
  async isReauthPage(): Promise<boolean> {
    const url = await this.engine.getCurrentUrl();
    if (url.includes("/challenge/")) return true;
    const text = await this.engine.getPageContent();
    return REAUTH_TEXT_PATTERN.test(text) || (this.extraTextPattern?.test(text) ?? false);
  }

  /**
   * 页面停在验证页时完成验证；返回 null 表示没有验证要求，可以继续主流程。
   *
   * 调用方已 wait(AFTER_NAVIGATION)。真机顺序是「导航到 myaccount 页 → Google 立刻 302 到 challenge 页」，
   * 所以正常情况下第一拍就命中；这里的轮询只是兜「重定向还没落地」：
   * 连续两拍停在非登录域名即认为稳定（没有验证要求），不再等满 REAUTH_DETECT_TIMEOUT_MS ——
   * 这个短路正是「不需要验证时快速返回」的保证（去掉会让每次导航都多等 6 秒），6 个操作的真机复跑都据此通过。
   *
   * 两条判据都要留着：页面一直停在 accounts.google.com 的登录页上时 settledTicks 会被反复清零，
   * 只剩截止时间能退出循环 —— 去掉它是真的会转不出去（未登录场景就是这样）。
   */
  async passIfRequired(credentials: ReauthCredentials): Promise<ReauthOutcome | null> {
    const deadline = Date.now() + REAUTH_DETECT_TIMEOUT_MS;
    let settledTicks = 0;
    for (;;) {
      if (await this.isReauthPage()) return this.complete(credentials);
      if (!(await this.engine.getCurrentUrl()).includes("accounts.google.com")) settledTicks += 1;
      else settledTicks = 0;
      if (settledTicks >= 2) return null;
      if (Date.now() >= deadline) return null;
      await this.engine.wait(500);
    }
  }

  private async complete(credentials: ReauthCredentials): Promise<ReauthOutcome> {
    const password = String(credentials.password ?? "");
    const secret = String(credentials.totpSecret ?? "").replace(/\s/g, "");

    for (let round = 1; round <= this.maxRounds; round++) {
      const totpSelector = await visibleSelector(this.engine, REAUTH_TOTP_SELECTORS);
      const passwordSelector = await visibleSelector(this.engine, REAUTH_PASSWORD_SELECTORS);

      if (!totpSelector && !passwordSelector) {
        // 页面还在渲染；再等一会，实在没有就如实报错
        const appeared = await waitUntil(
          this.engine,
          async () =>
            (await visibleSelector(this.engine, REAUTH_TOTP_SELECTORS)) !== null ||
            (await visibleSelector(this.engine, REAUTH_PASSWORD_SELECTORS)) !== null,
          REAUTH_STEP_TIMEOUT_MS,
        );
        if (!appeared) {
          return { success: false, message: "需要重新验证身份，但未找到密码 / 验证码输入框", error: "未找到输入框" };
        }
        continue;
      }

      let submittedPassword = false;
      if (totpSelector) {
        if (!secret) {
          return { success: false, message: "需要验证器验证码，但账号信息中没有密钥", error: "缺少 TOTP 密钥" };
        }
        this.log(`重新验证身份（第 ${round} 轮）：输入验证器验证码`);
        if (!(await this.engine.fill(totpSelector, await this.freshTotp(secret)))) {
          return { success: false, message: "重新验证身份失败：验证码未能写入", error: "验证码写入失败" };
        }
        await this.submit(REAUTH_TOTP_NEXT_SELECTORS);
      } else if (passwordSelector) {
        if (!password) {
          return { success: false, message: "需要重新验证身份，但账号信息中没有密码", error: "缺少密码" };
        }
        this.log(`重新验证身份（第 ${round} 轮）：输入当前密码（长度 ${password.length}）`);
        if (!(await this.engine.fill(passwordSelector, password))) {
          return { success: false, message: "重新验证身份失败：密码未能写入", error: "密码写入失败" };
        }
        await this.submit(REAUTH_PASSWORD_NEXT_SELECTORS);
        submittedPassword = true;
      }

      // 离开验证页即通过；提交密码后出现验证码框 = 进入下一步，立即进入下一轮
      let nextStep = false;
      const moved = await waitUntil(
        this.engine,
        async () => {
          if (!(await this.isReauthPage())) return true;
          if (submittedPassword && (await visibleSelector(this.engine, REAUTH_TOTP_SELECTORS)) !== null) {
            nextStep = true;
            return true;
          }
          return false;
        },
        REAUTH_STEP_TIMEOUT_MS,
      );
      if (moved && !nextStep) {
        await this.engine.wait(Timeouts.AFTER_NAVIGATION);
        return { success: true };
      }
      if (!nextStep) await this.engine.wait(RETRY_PAUSE_MS);
    }

    return { success: false, message: "重新验证身份失败：验证未被接受", error: "重新验证未通过" };
  }

  /** 提交当前表单：Enter → 点按钮 → 在按钮上派发 click（真机上坐标点击会落空，同 login.ts） */
  private async submit(buttonSelectors: readonly string[]): Promise<boolean> {
    if (await this.engine.pressKey("Enter")) return true;
    const button = await visibleSelector(this.engine, buttonSelectors);
    if (button && (await this.engine.click(button))) return true;
    if (button) return this.engine.jsClick(button);
    return false;
  }

  /** 本次要提交的验证码：与上一次提交的相同时，等到下一个 30 秒窗口再生成 */
  private async freshTotp(secret: string): Promise<string> {
    let code = generateTotp(secret);
    if (this.lastTotpCode !== null && code === this.lastTotpCode) {
      const intoWindow = Math.floor(Date.now() / 1000) % 30;
      await this.engine.wait((31 - intoWindow) * 1000);
      code = generateTotp(secret);
    }
    this.lastTotpCode = code;
    return code;
  }
}
