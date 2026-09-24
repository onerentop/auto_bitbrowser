/**
 * Google 登录
 *
 * 流程：检查是否已登录 → 打开登录页 →（账号选择页则点「使用其他账号」）→ 输入邮箱 →
 *       输入密码 → 验证器（TOTP）→ 打开 myaccount 验证登录结果。
 *
 * ==================== 关键设计取舍（真机测试发现，用户批准） ====================
 * 1. 成功判定：不能用含 "account" 的关键词匹配页面文本，
 *    因为 Google 登录页本身就有 "Use your Google Account"、"Create account"，
 *    一打开登录页就会被判为「已登录」。这里只认 URL 证据：
 *    打开 myaccount.google.com 后仍停留在该域名，且页面里出现目标邮箱，才算登录成功 / 已登录。
 * 2. 页面状态：不能只按关键词顺序判定，"验证码" 同时出现在 TOTP 与 CAPTCHA 关键词里，
 *    "phone number" 出现在大量页面上，容易误判。这里优先看 Google 登录页的固定元素
 *    （#identifierId / input[name=Passwd] / #totpPin）是否可见，再看 URL 的 /challenge/ 路径，
 *    最后才看少量精确文本。
 * 3. 输入方式：固定元素优先（fill / click / Enter），定位不到才退回 AI act()。
 *    act() 仍使用原有提示词。
 * 4. 密码只写入一次：act("在密码输入框中输入密码") 这条指令本身不含密码，
 *    AI 可能先填入别的内容，再加一次键盘输入会让密码被写两次或写错。
 *    这里删掉该 act，按「fill 一次；fill 失败才点击输入框后 type 一次」写入。
 * 5. 两步验证：只处理直接出现验证器输入框（TOTP）的情况；短信、手机提示、
 *    「Verify it's you」选择页等一律判失败并给出明确提示（用户确认）。
 * 6. 等待：固定 sleep 改为轮询页面状态直到跳转（带上限），Google 页面加载时快时慢。
 * 7. 登录页 URL 带 hl=en 与 continue=myaccount，保证页面语言与跳转目标确定。
 * 8. 验证码生成避开 30 秒窗口的最后 5 秒，防止提交时已过期。
 * 9. 通过 options.log 输出每一步（不含密码、密钥、验证码）。
 * 10. 提交方式（真机测试发现）：ixBrowser 窗口里常开着多个标签页，登录页不在前台时
 *     按坐标的鼠标点击会落空。打开登录页后先切到前台，提交时依次尝试
 *     Enter → 点击按钮 → 派发点击事件 → AI，每次都确认页面真的跳转了。
 */
import { generateTotp } from "../totp.ts";
import { Timeouts } from "../constants.ts";
import { createLoginResult, type LoginResult, type LoginState, type OperationStatus } from "../types.ts";

/** 登录操作用到的引擎能力（StagehandGoogleEngine 满足；单测用假引擎） */
export interface LoginEngine {
  navigate(url: string, options?: { timeoutMs?: number }): Promise<{ success: boolean; error?: string }>;
  wait(milliseconds: number): Promise<void>;
  getCurrentUrl(): Promise<string>;
  /** 页面可见文本 */
  getPageContent(): Promise<string>;
  /** 页面 HTML（用于查找 aria-label 等属性里的邮箱） */
  getPageHtml(): Promise<string>;
  isVisible(selector: string): Promise<boolean>;
  fill(selector: string, value: string): Promise<boolean>;
  click(selector: string): Promise<boolean>;
  /** 在元素上直接派发 click 事件（不依赖坐标命中） */
  jsClick(selector: string): Promise<boolean>;
  typeText(text: string): Promise<boolean>;
  pressKey(key: string): Promise<boolean>;
  /** 把当前页切到浏览器前台 */
  bringToFront(): Promise<void>;
  /**
   * 按可见文本点击（页面内派发 DOM 点击）。mode="contains" 用于文本前缀不确定的长句，
   * 例如「Get a verification code from the Google Authenticator app」。
   * 可选：假引擎可以不实现（此时登录流程跳过「选择验证方式」页的处理）。
   */
  clickByText?(
    text: string,
    mode?: "prefix" | "contains",
  ): Promise<{ tag: string; href: string | null } | null>;
  act(instruction: string): Promise<{ success: boolean }>;
}

/** 登录入口（hl=en 固定页面语言，continue 固定登录后跳到 myaccount） */
export const SIGNIN_URL =
  "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmyaccount.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin&hl=en";

/** 验证登录结果用的页面：首页 + 个人信息页（个人信息页一定显示邮箱） */
export const MYACCOUNT_URLS = [
  "https://myaccount.google.com/?hl=en",
  "https://myaccount.google.com/personal-info?hl=en",
];

const MYACCOUNT_HOST = "myaccount.google.com";
const SIGNIN_HOST = "accounts.google.com";

/** Google 登录页的固定元素 */
export const LoginSelectors = {
  EMAIL: ["#identifierId", 'input[type="email"]'],
  EMAIL_NEXT: ["#identifierNext button", "#identifierNext"],
  PASSWORD: ['input[name="Passwd"]', '#password input[type="password"]'],
  PASSWORD_NEXT: ["#passwordNext button", "#passwordNext"],
  TOTP: ["#totpPin", 'input[name="totpPin"]'],
  TOTP_NEXT: ["#totpNext button", "#totpNext"],
  CAPTCHA: ["#captchaimg", 'iframe[title*="reCAPTCHA"]', 'iframe[src*="recaptcha"]'],
} as const;

/** 精确文本（小写比较）。只在元素判断之后兜底使用；账号健康巡检也复用这里的停用词表 */
export const TEXT = {
  CAPTCHA: ["type the text you hear or see", "confirm you're not a robot", "i'm not a robot", "请输入您听到或看到的文字"],
  ACCOUNT_DISABLED: ["account disabled", "your account has been disabled", "帐号已停用", "账号已停用", "帐号已被停用"],
  ACCOUNT_NOT_FOUND: ["couldn't find your google account", "找不到您的 google 帐号", "找不到您的 google 账号"],
  WRONG_PASSWORD: ["wrong password", "密码错误", "密码不正确"],
  WRONG_CODE: ["wrong code", "wrong number of digits", "验证码错误", "代码错误"],
  CHOOSER: ["choose an account", "use another account", "选择账号", "使用其他账号"],
  PHONE_PROMPT: ["check your phone", "google prompt", "tap yes", "检查您的手机"],
  SMS: ["text message", "短信"],
  VERIFY_IT_IS_YOU: ["verify it's you", "验证是您本人", "验证是否是您本人"],
} as const;

/** 当前页面所处的登录阶段 */
export type LoginStage =
  | "email"
  | "chooser"
  | "password"
  | "wrong_password"
  | "totp"
  | "wrong_totp"
  | "account_not_found"
  | "account_disabled"
  | "captcha"
  | "2fa_sms"
  | "2fa_prompt"
  | "2fa_other"
  | "verify_selection"
  /** 已离开 accounts.google.com 的登录流程（是否真的登录成功，由 myaccount 验证决定） */
  | "left_signin"
  /** 登录后的提示页（设置通行密钥、补充辅助信息等），仍在 accounts.google.com */
  | "interstitial"
  | "unknown";

/** 非验证器两步验证的失败提示 */
const TWO_FA_MESSAGES: Partial<Record<LoginStage, string>> = {
  "2fa_sms": "需要短信验证码两步验证（仅支持验证器 TOTP）",
  "2fa_prompt": "需要在手机上确认登录（仅支持验证器 TOTP）",
  "2fa_other": "需要其他方式的两步验证（仅支持验证器 TOTP）",
  verify_selection: "Google 要求选择验证方式（Verify it's you），没有直接出现验证器输入框",
};

/**
 * 「选择验证方式」页里指向验证器的那一项的措辞（英文页 / 中文页）。
 * 真机（2026-09-24）实际文本是「Get a verification code from the Google Authenticator app」——
 * 前缀不是这个关键词，所以必须用 contains 模式匹配（用前缀匹配会返回 null，登录就卡在这一页）。
 */
export const AUTHENTICATOR_OPTION_TEXTS = [
  "Google Authenticator app",
  "Authenticator app",
  "身份验证器",
  "验证器应用",
];

/** 文本点击命中后打在元素上的标记属性（与 stagehand-engine 的 TEXT_HIT_ATTRIBUTE 同一个值） */
const TEXT_HIT_SELECTOR = '[data-abb-text-hit="1"]';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

const hasAny = (text: string, words: readonly string[]) => words.some((w) => text.includes(w));

export interface LoginOperationOptions {
  /** 当前时间（毫秒），单测注入 */
  now?: () => number;
  /** 轮询间隔（毫秒） */
  pollIntervalMs?: number;
}

export class LoginOperation {
  private readonly engine: LoginEngine;
  private readonly now: () => number;
  private readonly pollMs: number;
  /** 当前这次 execute 的步骤日志（submitAndWait 等内部步骤也要写） */
  private log: ((msg: string) => void) | null = null;

  constructor(engine: LoginEngine, options: LoginOperationOptions = {}) {
    this.engine = engine;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollIntervalMs ?? 1000;
  }

  async execute(options: {
    email: string;
    password: string;
    totpSecret?: string | null;
    recoveryEmail?: string | null;
    log?: ((msg: string) => void) | null;
  }): Promise<LoginResult> {
    const { email, password } = options;
    const totpSecret = options.totpSecret ?? null;
    const log = (msg: string) => options.log?.(msg);
    this.log = log;
    const start = this.now();
    const done = (
      r: { success: boolean; status: OperationStatus; login_state: LoginState } & Partial<LoginResult>,
    ): LoginResult => createLoginResult({ account_email: email, duration_ms: this.now() - start, ...r });
    const fail = (
      login_state: LoginState,
      error_type: string,
      error: string,
      extra: Partial<LoginResult> & { status?: OperationStatus } = {},
    ): LoginResult => {
      log(`[X] ${error}`);
      return done({ success: false, status: extra.status ?? "failed", login_state, error, error_type, ...extra });
    };

    try {
      // 1. 已登录就直接返回（只认 myaccount 域名 + 目标邮箱）
      log("检查窗口当前登录状态...");
      const pre = await this.checkSignedIn(email);
      if (pre.signedIn) {
        log("myaccount 页面显示该账号，已处于登录状态");
        return done({ success: true, status: "success", login_state: "logged_in", message: "已登录" });
      }
      if (pre.otherAccount) log("窗口当前登录的是其他账号，继续登录目标账号");

      // 2. 打开登录页
      log("打开 Google 登录页");
      const nav = await this.engine.navigate(SIGNIN_URL, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return fail("unknown", "navigation_failed", `无法导航到登录页: ${nav.error ?? ""}`);
      }
      // 窗口里可能开着多个标签页：把登录用的这一页切到前台，避免坐标点击落空（真机测试发现）
      await this.engine.bringToFront();
      let stage = await this.waitForStage(["unknown"], 15_000);

      /**
       * 3+4. 账号选择页 → 邮箱输入。
       *
       * 真机（2026-09-24）：**登出之后再登录**，Google 会先把人送到账号选择页（列表里那个账号显示
       * 「已退出」）；提交一次邮箱后还可能**又被送回**选择页。原实现只在一开始处理 chooser，
       * 提交邮箱后再落到 chooser 就被后面的 myaccount 验证判成含糊的「登录验证失败」。
       * 这里最多走两轮：落到 chooser 就点「使用其他账号」，再重走邮箱输入。
       */
      for (let round = 1; round <= 2; round++) {
        if (stage === "chooser") {
          log(`检测到账号选择页（第 ${round} 轮），点击「使用其他账号」`);
          await this.engine.act("点击使用其他账号或添加其他账号");
          stage = await this.waitForStage(["chooser", "unknown"], 15_000);
        }
        if (stage !== "email") break;

        log(`输入邮箱: ${email}`);
        if (!(await this.fillFirst(LoginSelectors.EMAIL, email))) {
          const r = await this.engine.act(`在邮箱或电话号码输入框中输入: ${email}`);
          if (!r.success) return fail("logged_out", "email_input_failed", "无法输入邮箱");
        }
        await this.engine.wait(Timeouts.AFTER_INPUT);
        log("提交邮箱");
        stage = await this.submitAndWait(LoginSelectors.EMAIL_NEXT, "点击下一步按钮", ["email", "unknown"], 20_000);
        if (stage !== "chooser") break;
        log("提交邮箱后又被送回账号选择页，重试一次");
      }
      if (stage === "email") return fail("logged_out", "email_submit_failed", "提交邮箱后页面没有跳转");

      // 重试一轮后仍停在账号选择页：给明确结论，不要落到 myaccount 验证去报含糊的失败
      if (stage === "chooser") {
        return fail("logged_out", "chooser_stuck", "账号选择页没有放行（重试一次后仍停在选择页）");
      }
      const blocked = this.blockedResult(stage, totpSecret, fail);
      if (blocked) return blocked;

      // 5. 密码（只写入一次）
      if (stage === "password") {
        log("输入密码");
        if (!(await this.writePasswordOnce(password))) {
          return fail("need_password", "password_input_failed", "无法输入密码");
        }
        await this.engine.wait(Timeouts.AFTER_INPUT);
        log("提交密码");
        stage = await this.submitAndWait(LoginSelectors.PASSWORD_NEXT, "点击下一步按钮或登录按钮", ["password", "unknown"], 25_000);
        // submitAndWait 只在耗尽超时后才会返回 from 里的值：stage 仍是 password（页面没动）
        // 或 unknown（一直停在 /challenge/pwd 的过渡态没渲染出下一步），两者都是「提交密码没成功」。
        if (stage === "password" || stage === "unknown") {
          return fail("need_password", "password_submit_failed", "提交密码后页面没有跳转");
        }
      }

      // 5.5 「选择验证方式」页（真机常见）：先把验证器选出来，否则根本走不到验证码输入框。
      // 以前这里直接判 need_2fa，真机表现就是「一直没把验证码填进去」；那一项的文本是长句
      // 「Get a verification code from the Google Authenticator app」，必须用 contains 模式匹配。
      if (stage === "verify_selection" && totpSecret) {
        const picked = await this.chooseAuthenticator(log);
        if (picked) {
          stage = await this.waitForStage(["verify_selection", "unknown"], 20_000);
          if (stage === "verify_selection") {
            // 真机教训（踢出设备）：Google 的 Material 列表项对 DOM click() 不响应，改用坐标点击
            log("选择验证器后页面没有跳转，改用坐标点击");
            await this.engine.click(TEXT_HIT_SELECTOR);
            stage = await this.waitForStage(["verify_selection", "unknown"], 20_000);
          }
        }
      }
      const blocked2 = this.blockedResult(stage, totpSecret, fail);
      if (blocked2) return blocked2;

      // 6. 验证器（TOTP）
      if (stage === "totp" && totpSecret) {
        const code = await this.freshTotp(totpSecret);
        log("输入验证器验证码");
        if (!(await this.fillFirst(LoginSelectors.TOTP, code))) {
          const r = await this.engine.act(`在验证码输入框中输入: ${code}`);
          if (!r.success) {
            return fail("need_2fa", "totp_failed", "无法输入验证器验证码", { need_2fa: true, two_fa_method: "totp" });
          }
        }
        await this.engine.wait(Timeouts.AFTER_INPUT);
        log("提交验证器验证码");
        stage = await this.submitAndWait(LoginSelectors.TOTP_NEXT, "点击下一步按钮或验证按钮", ["totp", "unknown"], 25_000);
        if (stage === "wrong_totp" || stage === "totp") {
          return fail("need_2fa", "totp_failed", stage === "wrong_totp" ? "验证器验证码被拒绝" : "提交验证码后页面没有跳转", {
            need_2fa: true,
            two_fa_method: "totp",
          });
        }
        const blocked3 = this.blockedResult(stage, totpSecret, fail);
        if (blocked3) return blocked3;
      }

      // 7. 最终验证：只有 myaccount 显示目标邮箱才算成功
      log("打开 myaccount 验证登录结果");
      const post = await this.checkSignedIn(email);
      if (post.signedIn) {
        log("[OK] myaccount 页面显示该账号，登录成功");
        return done({ success: true, status: "success", login_state: "logged_in", message: "登录成功" });
      }
      const where = post.otherAccount ? "myaccount 显示的是其他账号" : `最终页面 ${hostOf(post.url)}${pathOf(post.url)}`;
      return fail("unknown", "verification_failed", `登录验证失败（${where}，登录阶段: ${stage}）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail("unknown", "exception", msg);
    }
  }

  /** 把「不能继续」的阶段转换成失败结果；可以继续时返回 null */
  private blockedResult(
    stage: LoginStage,
    totpSecret: string | null,
    fail: (
      state: LoginState,
      type: string,
      error: string,
      extra?: Partial<LoginResult> & { status?: OperationStatus },
    ) => LoginResult,
  ): LoginResult | null {
    switch (stage) {
      case "account_not_found":
        return fail("account_not_found", "account_not_found", "账号不存在");
      case "account_disabled":
        return fail("account_disabled", "account_disabled", "账号已被停用", { status: "blocked" });
      case "captcha":
        return fail("captcha_required", "captcha_required", "需要人机验证（验证码），已停止", { status: "blocked" });
      case "wrong_password":
        return fail("wrong_password", "wrong_password", "密码错误");
      case "totp":
        if (totpSecret) return null;
        return fail("need_2fa", "need_2fa", "需要验证器（TOTP）验证码，但账号未配置 2FA 密钥", {
          status: "partial",
          need_2fa: true,
          two_fa_method: "totp",
        });
      case "2fa_sms":
      case "2fa_prompt":
      case "2fa_other":
      case "verify_selection": {
        const method = stage === "verify_selection" ? "selection" : stage.replace("2fa_", "");
        return fail("need_2fa", "need_2fa", TWO_FA_MESSAGES[stage] ?? "需要两步验证", {
          status: "partial",
          need_2fa: true,
          two_fa_method: method,
        });
      }
      default:
        return null;
    }
  }

  /**
   * 打开 myaccount，判断是否以目标邮箱登录。
   * 未登录时 myaccount 会跳回 accounts.google.com 或 www.google.com/account/about。
   */
  async checkSignedIn(email: string): Promise<{ signedIn: boolean; otherAccount: boolean; url: string }> {
    const target = email.trim().toLowerCase();
    let url = "";
    let onMyAccount = false;
    for (const pageUrl of MYACCOUNT_URLS) {
      const nav = await this.engine.navigate(pageUrl, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) continue;
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      url = await this.engine.getCurrentUrl();
      if (hostOf(url) !== MYACCOUNT_HOST) return { signedIn: false, otherAccount: false, url };
      onMyAccount = true;
      const text = (await this.engine.getPageContent()).toLowerCase();
      const html = (await this.engine.getPageHtml()).toLowerCase();
      if (target && (text.includes(target) || html.includes(target))) {
        return { signedIn: true, otherAccount: false, url };
      }
    }
    return { signedIn: false, otherAccount: onMyAccount, url };
  }

  /** 识别当前页面所处阶段（元素 → URL → 精确文本） */
  async detectStage(): Promise<LoginStage> {
    const url = await this.engine.getCurrentUrl();
    const host = hostOf(url);
    const path = pathOf(url);
    if (host && host !== SIGNIN_HOST) return "left_signin";

    // Google 文案用弯引号（Couldn’t / it’s），统一成直引号再比较
    const text = (await this.engine.getPageContent()).toLowerCase().replace(/[\u2018\u2019]/g, "'");

    if (path.includes("/challenge/recaptcha") || hasAny(text, TEXT.CAPTCHA) || (await this.anyVisible(LoginSelectors.CAPTCHA))) {
      return "captcha";
    }
    if (path.includes("/disabled") || hasAny(text, TEXT.ACCOUNT_DISABLED)) return "account_disabled";
    if (hasAny(text, TEXT.ACCOUNT_NOT_FOUND)) return "account_not_found";

    if (await this.anyVisible(LoginSelectors.TOTP)) return hasAny(text, TEXT.WRONG_CODE) ? "wrong_totp" : "totp";
    if (await this.anyVisible(LoginSelectors.PASSWORD)) {
      return hasAny(text, TEXT.WRONG_PASSWORD) ? "wrong_password" : "password";
    }
    if (await this.anyVisible(LoginSelectors.EMAIL)) return "email";

    if (path.includes("/challenge/")) {
      // 走到这里说明该阶段的输入框都不可见 —— 页面要么还在渲染，要么确实是别的验证方式。
      // pwd / totp 是「本流程自己的」challenge 页：输入框没出来只是渲染未完成，
      // 必须继续等，不能当成其他两步验证（真机实测：提交密码后会短暂停在
      // /v3/signin/challenge/pwd 且页面文本为空，旧实现在这里误判成 2fa_other 直接中止）。
      if (path.includes("/challenge/pwd") || path.includes("/challenge/totp")) return "unknown";
      if (path.includes("/challenge/ipp") || path.includes("/challenge/sms")) return "2fa_sms";
      if (path.includes("/challenge/dp") || path.includes("/challenge/az")) return "2fa_prompt";
      if (path.includes("/challenge/selection")) return "verify_selection";
      return "2fa_other";
    }
    if (hasAny(text, TEXT.CHOOSER)) return "chooser";
    if (path.includes("/speedbump/")) return "interstitial";
    if (hasAny(text, TEXT.PHONE_PROMPT)) return "2fa_prompt";
    if (hasAny(text, TEXT.VERIFY_IT_IS_YOU)) return "verify_selection";
    if (hasAny(text, TEXT.SMS)) return "2fa_sms";
    return "unknown";
  }

  /**
   * 轮询直到页面进入 from 以外的阶段；超时返回最后一次看到的阶段。
   * 用次数而不是墙钟计时，单测里 wait() 不真等也能结束。
   */
  private async waitForStage(from: readonly LoginStage[], timeoutMs: number): Promise<LoginStage> {
    const polls = Math.max(1, Math.ceil(timeoutMs / this.pollMs));
    let stage: LoginStage = "unknown";
    for (let i = 0; i < polls; i++) {
      await this.engine.wait(this.pollMs);
      stage = await this.detectStage();
      if (!from.includes(stage)) return stage;
    }
    return stage;
  }

  /**
   * 在「选择验证方式」页点开验证器那一项。
   *
   * 只用确定性的文本点击（不交给 AI 判断）：命中返回 true，页面上没有验证器项返回 false
   * （此时调用方保持原来的 need_2fa 结论，不会假装成功）。
   */
  private async chooseAuthenticator(log: (msg: string) => void): Promise<boolean> {
    const clickByText = this.engine.clickByText?.bind(this.engine);
    if (!clickByText) return false;
    for (const text of AUTHENTICATOR_OPTION_TEXTS) {
      const hit = await clickByText(text, "contains");
      if (!hit) continue;
      log(`「选择验证方式」页：已选择 ${text}`);
      return true;
    }
    log("「选择验证方式」页：没有找到验证器选项");
    return false;
  }

  private async anyVisible(selectors: readonly string[]): Promise<boolean> {
    for (const s of selectors) if (await this.engine.isVisible(s)) return true;
    return false;
  }

  private async firstVisible(selectors: readonly string[]): Promise<string | null> {
    for (const s of selectors) if (await this.engine.isVisible(s)) return s;
    return null;
  }

  /** 往第一个可见的输入框 fill；没有可见输入框或 fill 失败返回 false */
  private async fillFirst(selectors: readonly string[], value: string): Promise<boolean> {
    const sel = await this.firstVisible(selectors);
    if (!sel) return false;
    return this.engine.fill(sel, value);
  }

  /**
   * 提交当前表单并等页面跳转。依次尝试：Enter（刚填写的输入框仍有焦点）→ 点击固定按钮 →
   * 在按钮上派发 click 事件（不依赖坐标，窗口不在前台也有效）→ AI act；
   * 每种方式之后都确认页面确实离开了 from 阶段，没跳转才换下一种（真机测试发现坐标点击会落空）。
   * 同一页面重复提交不会产生副作用（邮箱 / 密码 / 同一个验证码）。
   */
  private async submitAndWait(
    buttons: readonly string[],
    actInstruction: string,
    from: readonly LoginStage[],
    timeoutMs: number,
  ): Promise<LoginStage> {
    const perTry = Math.min(8_000, timeoutMs);
    const tries: Array<[string, () => Promise<boolean>]> = [
      ["按 Enter 提交", () => this.engine.pressKey("Enter")],
      ["点击按钮提交", async () => {
        const btn = await this.firstVisible(buttons);
        return btn ? this.engine.click(btn) : false;
      }],
      ["派发点击事件提交", async () => {
        const btn = await this.firstVisible(buttons);
        return btn ? this.engine.jsClick(btn) : false;
      }],
      ["AI 点击提交", async () => (await this.engine.act(actInstruction)).success],
    ];
    let stage: LoginStage = "unknown";
    for (const [name, attempt] of tries) {
      if (!(await attempt())) continue;
      stage = await this.waitForStage(from, perTry);
      if (!from.includes(stage)) return stage;
      this.log?.(`${name}后页面没有跳转，换下一种方式`);
    }
    // 最后再多等一会儿（慢网络）
    const rest = timeoutMs - perTry;
    return rest > 0 ? this.waitForStage(from, rest) : stage;
  }

  /**
   * 密码只写入一次：fill 成功就结束；fill 失败才点击密码框并 type 一次。
   * 不使用 act()——AI 指令里不能带密码，而不带密码的指令会让 AI 自己往框里填东西。
   */
  private async writePasswordOnce(password: string): Promise<boolean> {
    const sel = await this.firstVisible(LoginSelectors.PASSWORD);
    if (!sel) return false;
    if (await this.engine.fill(sel, password)) return true;
    if (!(await this.engine.click(sel))) return false;
    return this.engine.typeText(password);
  }

  /** 生成验证码；当前 30 秒窗口剩余不足 5 秒时等到下一个窗口 */
  private async freshTotp(secret: string): Promise<string> {
    const left = 30 - (Math.floor(this.now() / 1000) % 30);
    if (left < 5) await this.engine.wait((left + 1) * 1000);
    return generateTotp(secret, this.now());
  }
}
