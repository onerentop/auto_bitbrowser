/**
 * StagehandGoogleEngine（Node 重写）
 * 对标 core/stagehand_engine/engine.py
 *
 * 管道层：CDP 接管 ixBrowser 窗口 + navigate / act / extract / observe 四原语。
 * 已由 ENGINE_SLICE_REPORT.md 的真机切片验证通过。
 *
 * 两个必须遵守的约束（切片实测得出）：
 *   1. Stagehand 必须锁 3.7.3 —— 4.x 依赖 Extensions.* CDP 域，ixBrowser 不支持
 *   2. API key 必须经环境变量传入，model.clientOptions.apiKey 不生效
 *      （对标 Python 的 _setup_provider_env_vars）
 */
import { Stagehand } from "@browserbasehq/stagehand";
import { IxBrowserClient } from "../ixbrowser/client.ts";
import { Timeouts } from "./constants.ts";
import { createCompatPage, type CompatPage } from "./playwright-compat.ts";

/** provider → 该 provider 的 AI SDK 环境变量名 */
export const PROVIDER_ENV_VARS: Record<string, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  gemini: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

/**
 * 按 provider 注入 API key 环境变量。
 * 必须在 new Stagehand() 之前调用，否则底层 ai-sdk 报 AI_LoadAPIKeyError。
 */
export function setupProviderEnvVars(modelName: string, apiKey: string): void {
  const provider = (modelName.split("/")[0] ?? "").toLowerCase();
  const envVar = PROVIDER_ENV_VARS[provider];
  if (envVar) process.env[envVar] = apiKey;
  // 兜底：部分路径读通用变量
  process.env["MODEL_API_KEY"] = apiKey;
}

export interface EngineOptions {
  modelName: string;
  apiKey: string;
  /** 日志详细程度 0-2，对齐 Python 的 verbose */
  verbose?: 0 | 1 | 2;
  ixClient?: IxBrowserClient;
  /** 引擎关闭时是否一并关掉 ixBrowser 窗口，对齐 Python 的 close_browser_on_exit */
  closeBrowserOnExit?: boolean;
}

/** 统一的原语返回结构，对标 Python 的 ActionResult / ExtractResult 等 */
export interface PrimitiveResult<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  durationMs: number;
}

/** Stagehand V3 的最小接口，避免直接依赖其内部类型 */
interface V3Like {
  init(): Promise<void>;
  close(): Promise<void>;
  act(instruction: string, options?: unknown): Promise<unknown>;
  extract(instruction: string, schema?: unknown, options?: unknown): Promise<unknown>;
  observe(instruction?: string, options?: unknown): Promise<unknown[]>;
  context: {
    awaitActivePage(timeoutMs?: number): Promise<PageLike>;
  };
}

interface LocatorLike {
  fill(value: string): Promise<void>;
  type(text: string): Promise<void>;
  first?(): LocatorLike;
  isVisible?(): Promise<boolean>;
  click?(): Promise<void>;
  /** 直接在元素上派发 click 事件，不依赖坐标命中（窗口不在前台时也有效） */
  sendClickEvent?(): Promise<void>;
}

interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  content?(): Promise<string>;
  locator?(selector: string): LocatorLike;
  keyboard?: { type(text: string): Promise<void> };
  /** Stagehand V3 Page 没有 keyboard 对象，直接提供 type / keyPress */
  type?(text: string): Promise<void>;
  keyPress?(key: string): Promise<void>;
  evaluate?<R = unknown>(fn: string | ((arg?: unknown) => R | Promise<R>), arg?: unknown): Promise<R>;
  sendCDP?<T = unknown>(method: string, params?: object): Promise<T>;
}

/**
 * 页面内复核脚本：首个匹配元素需有非零尺寸，且自身与祖先都没被隐藏。
 * 返回 null 表示主文档里查不到该元素。导出供单测校验。
 */
export function renderedCheckScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return typeof el.checkVisibility === "function"
      ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      : true;
  })()`;
}

export const TEXT_HIT_ATTRIBUTE = "data-abb-text-hit";

/**
 * 页面内「按可见文本点击」脚本。
 *
 * 为什么需要它：stagehand 的选择器引擎不支持 Playwright 的 `:has-text()` / `text=` 伪类。
 * 真机实测 locator(':is(a,button,[role="button"]):has-text("电话号码")').count() 恒为 0
 * 并抛 StagehandElementNotFoundError，click() / jsClick() 只能静默返回 false。
 * 这里改为在页面里按可见文本找元素并派发 DOM 点击（真机已验证能触发导航与弹层按钮）。
 *
 * 匹配模式 mode：
 *   - `prefix`（默认）要求候选文本**以目标开头**，用于「保存」「下一步」这类按钮；
 *   - `contains` 只要求**包含**目标，用于「Get a verification code from the Google Authenticator app」
 *     这种前缀不确定的长句（真机 2026-09-24：登录停在「选择验证方式」页就是因为 prefix 找不到它）。
 *
 * 选元素顺序（每一级都是为了不点错）：
 *   1. 只保留「可见 + 可点」且文本命中模式的候选；
 *   2. 有文本**恰好等于**目标文本的就只在这一层里挑（否则「保存更改」会抢走「保存」）；
 *   3. 再去掉「包含其它命中元素」的祖先（点在外层容器上事件不一定会冒泡到控件）；
 *   4. 最后优先 `<a href>`（Google 的条目就是链接），否则取子树最小的那个。
 * 命中后会给元素打上 `data-abb-text-hit="1"` 标记，供「DOM 点击无效时改用坐标点击」兜底
 * （真机教训：Google 的 Material 列表项对 DOM click() 不响应）。
 * 返回 { tag, href }；找不到返回 null。导出供单测校验。
 */
export function textClickScript(text: string, mode: "prefix" | "contains" = "prefix"): string {
  return `(() => {
    const want = ${JSON.stringify(text)};
    const mode = ${JSON.stringify(mode)};
    const MARK = '${TEXT_HIT_ATTRIBUTE}';
    for (const old of document.querySelectorAll('[' + MARK + ']')) old.removeAttribute(MARK);
    const isClickable = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    };
    const label = (el) => (el.innerText || '').trim();
    const hits = (el) => (mode === 'contains' ? label(el).includes(want) : label(el).startsWith(want));
    const candidates = Array.from(
      document.querySelectorAll(
        'a[href], button, [role="button"], [role="menuitem"], [role="link"], input[type="submit"], li',
      ),
    ).filter((el) => isClickable(el) && hits(el));
    if (candidates.length === 0) return null;

    const exact = candidates.filter((el) => label(el) === want);
    const matched = exact.length > 0 ? exact : candidates;
    const contained = (el, other) => typeof el.contains === 'function' && el.contains(other);
    const innermost = matched.filter(
      (el) => !matched.some((other) => other !== el && contained(el, other)),
    );
    const pool = innermost.length > 0 ? innermost : matched;
    const target =
      pool.find((el) => el.tagName === 'A' && el.getAttribute('href')) ??
      pool.slice().sort((a, b) => a.children.length - b.children.length)[0];
    target.setAttribute(MARK, '1');
    target.click();
    return { tag: target.tagName, href: target.getAttribute('href') };
  })()`;
}

export class StagehandGoogleEngine {
  private sh: V3Like | null = null;
  private page: PageLike | null = null;
  private readonly options: EngineOptions;
  private readonly ix: IxBrowserClient;
  private profileId: number | null = null;
  private loggedInEmail: string | null = null;

  constructor(options: EngineOptions) {
    this.options = options;
    this.ix = options.ixClient ?? new IxBrowserClient();
  }

  get isInitialized(): boolean {
    return this.sh !== null;
  }

  get currentEmail(): string | null {
    return this.loggedInEmail;
  }

  setLoggedInEmail(email: string | null): void {
    this.loggedInEmail = email;
  }

  /**
   * 连接到 ixBrowser 窗口。
   * 对标 Python 的 connect_to_ixbrowser()：先开窗拿 CDP 端点，再让 Stagehand 接管。
   */
  static async connectToIxBrowser(
    profileId: number | string,
    options: EngineOptions,
  ): Promise<StagehandGoogleEngine> {
    const engine = new StagehandGoogleEngine(options);
    await engine.connect(profileId);
    return engine;
  }

  /**
   * 直接从 CDP WebSocket 端点接入。
   * 对标 Python 的 engine.connect_cdp(ws_endpoint)——不经过 ixBrowser API，
   * 用于「窗口已经开着，只要接管」的场景。
   */
  static async connectCdp(
    wsEndpoint: string,
    options: EngineOptions,
  ): Promise<StagehandGoogleEngine> {
    const engine = new StagehandGoogleEngine(options);
    await engine.connectViaCdp(wsEndpoint);
    return engine;
  }

  /** 复用 CDP 端点建立 Stagehand 会话（内部实现，供 connectCdp 调用） */
  async connectViaCdp(wsEndpoint: string): Promise<void> {
    setupProviderEnvVars(this.options.modelName, this.options.apiKey);

    const sh = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: { cdpUrl: wsEndpoint },
      model: {
        modelName: this.options.modelName,
        clientOptions: { apiKey: this.options.apiKey },
      },
      verbose: this.options.verbose ?? 0,
    } as never) as unknown as V3Like;

    await sh.init();
    this.sh = sh;
    this.page = await sh.context.awaitActivePage(15_000);
  }

  async connect(profileId: number | string): Promise<void> {
    const id = typeof profileId === "string" ? Number.parseInt(profileId, 10) : profileId;
    this.profileId = id;

    const opened = await this.ix.openProfile(id);
    setupProviderEnvVars(this.options.modelName, this.options.apiKey);

    const sh = new Stagehand({
      env: "LOCAL",
      localBrowserLaunchOptions: { cdpUrl: opened.ws },
      model: {
        modelName: this.options.modelName,
        clientOptions: { apiKey: this.options.apiKey },
      },
      verbose: this.options.verbose ?? 0,
    } as never) as unknown as V3Like;

    await sh.init();
    this.sh = sh;
    this.page = await sh.context.awaitActivePage(15_000);
  }

  /**
   * 关闭引擎，对齐 Python 的 engine.stop(close_browser=...)。
   * 不传参数时沿用构造时的 closeBrowserOnExit 设定。
   */
  async stop(closeBrowser?: boolean): Promise<void> {
    return this.close(closeBrowser ?? this.options.closeBrowserOnExit ?? false);
  }

  /** 关闭 Stagehand 并按需关闭 ixBrowser 窗口 */
  async close(closeBrowser = false): Promise<void> {
    try {
      if (this.sh) await this.sh.close();
    } catch {
      /* 忽略关闭异常，与 Python 一致 */
    }
    this.sh = null;
    this.page = null;

    if (closeBrowser && this.profileId !== null) {
      try {
        await this.ix.closeProfile(this.profileId);
      } catch {
        /* 忽略 */
      }
    }
  }

  private ensureReady(): { sh: V3Like; page: PageLike } {
    if (!this.sh || !this.page) throw new Error("引擎未初始化，请先调用 connect()");
    return { sh: this.sh, page: this.page };
  }

  /** 固定等待，对标 Python 的 wait() */
  async wait(milliseconds: number): Promise<void> {
    await new Promise((r) => setTimeout(r, milliseconds));
  }

  async getCurrentUrl(): Promise<string> {
    const { page } = this.ensureReady();
    return page.url();
  }

  /**
   * 获取页面**可见文本**。
   *
   * 为什么不用 page.content()（HTML）：关键词检测（Pro 状态、家庭组角色）依赖
   * 可见文本做子串匹配。HTML 里标签名、class 属性、内联脚本都会误命中
   * （例如 class="upgrade-banner" 会让页面被判为非订阅），且跨标签文本
   * （<span>Manage</span> <span>membership</span>）匹配不到。
   *
   * 与 Python 的做法语义一致（Python 分别用 page.inner_text("body") 与 AI extract "all visible text"）。
   * 这里走浏览器原生 innerText：更快、不消耗额度、结果确定。
   */
  async getPageContent(): Promise<string> {
    const { page } = this.ensureReady();
    if (typeof page.evaluate === "function") {
      try {
        const text = await page.evaluate<string>(
          "document.body ? document.body.innerText : ''",
        );
        return typeof text === "string" ? text : "";
      } catch {
        /* 落到下面的 HTML 回退 */
      }
    }
    // 回退：拿不到 evaluate 能力时退回 HTML（调用方需自行容忍噪声）
    if (typeof page.content === "function") {
      try {
        return await page.content();
      } catch {
        return "";
      }
    }
    return "";
  }

  /** 选择器匹配多个元素时取第一个（V3 Locator 的 first() 是方法） */
  private firstLocator(selector: string): LocatorLike | null {
    const { page } = this.ensureReady();
    if (typeof page.locator !== "function") return null;
    const loc = page.locator(selector);
    return typeof loc.first === "function" ? loc.first() : loc;
  }

  /**
   * 按选择器填充输入框。
   * 对标 Python 的 engine.page.fill()——用于 act() 输入失败时的降级路径。
   * 拿不到 locator 能力时返回 false，由调用方决定后续。
   */
  async fill(selector: string, value: string): Promise<boolean> {
    try {
      const loc = this.firstLocator(selector);
      if (!loc) return false;
      await loc.fill(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 选择器对应的元素是否存在且可见；出错（含元素不存在）一律视为不可见。
   *
   * Stagehand 的 isVisible 只看元素自身的 display / visibility / opacity，
   * 不看祖先是否 display:none、也不看尺寸。Google 密码页 DOM 里常驻一个
   * 隐藏容器内的 0×0 `#captchaimg`，会被它误判为可见 → 把密码页当成人机验证。
   * 所以 Stagehand 判可见后再在页面里复核一次盒子尺寸与 checkVisibility()。
   */
  async isVisible(selector: string): Promise<boolean> {
    try {
      const loc = this.firstLocator(selector);
      if (!loc || typeof loc.isVisible !== "function") return false;
      if (!(await loc.isVisible())) return false;
    } catch {
      return false;
    }
    const { page } = this.ensureReady();
    if (typeof page.evaluate !== "function") return true;
    try {
      // null：主文档里查不到（可能在 shadow DOM 里），沿用 Stagehand 的结论
      const rendered = await page.evaluate<boolean | null>(renderedCheckScript(selector));
      return rendered !== false;
    } catch {
      return true;
    }
  }

  /** 按选择器点击；元素不存在或不可点击时返回 false */
  async click(selector: string): Promise<boolean> {
    try {
      const loc = this.firstLocator(selector);
      if (!loc || typeof loc.click !== "function") return false;
      await loc.click();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 在元素上直接派发 click 事件（不按坐标命中）。
   * 窗口里有多个标签页、当前页不在前台时，坐标点击可能落空，用它兜底。
   */
  async jsClick(selector: string): Promise<boolean> {
    try {
      const loc = this.firstLocator(selector);
      if (!loc || typeof loc.sendClickEvent !== "function") return false;
      await loc.sendClickEvent();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 按可见文本点击元素（页面内派发 DOM 点击），返回被点元素信息，没点到返回 null。
   *
   * 这是 `:has-text()` 在 stagehand 下失效之后的确定性点击通道：真机实测
   * `locator(':is(a,button,[role="button"]):has-text("电话号码")').count() === 0`，
   * 而页面内 `el.click()` 能正常触发 Google 条目的导航。
   */
  async clickByText(
    text: string,
    mode: "prefix" | "contains" = "prefix",
  ): Promise<{ tag: string; href: string | null } | null> {
    const { page } = this.ensureReady();
    if (typeof page.evaluate !== "function") return null;
    try {
      const hit = await page.evaluate<{ tag: string; href: string | null } | null>(
        textClickScript(text, mode),
      );
      return hit ?? null;
    } catch {
      return null;
    }
  }
  /** 把当前页切到浏览器前台（CDP Page.bringToFront）；不支持时静默跳过 */
  async bringToFront(): Promise<void> {
    const { page } = this.ensureReady();
    if (typeof page.sendCDP !== "function") return;
    try {
      await page.sendCDP("Page.bringToFront");
    } catch {
      /* 切前台失败不影响后续操作 */
    }
  }

  /** 按下一个键（如 "Enter"）；V3 Page 用 keyPress */
  async pressKey(key: string): Promise<boolean> {
    const { page } = this.ensureReady();
    if (typeof page.keyPress !== "function") return false;
    try {
      await page.keyPress(key);
      return true;
    } catch {
      return false;
    }
  }

  /** 页面完整 HTML（含 aria-label 等属性，innerText 看不到），取不到返回空串 */
  async getPageHtml(): Promise<string> {
    const { page } = this.ensureReady();
    try {
      if (typeof page.evaluate === "function") {
        const html = await page.evaluate<string>("document.documentElement ? document.documentElement.outerHTML : ''");
        if (typeof html === "string") return html;
      }
      if (typeof page.content === "function") return await page.content();
    } catch {
      /* 取不到就当空 */
    }
    return "";
  }

  /**
   * 直接敲键盘输入文本（输入到当前焦点元素）。
   * 对标 Python 的 engine.page.keyboard.type()——act() 与 fill() 都失败时的最后手段。
   * Stagehand V3 的 Page 没有 keyboard 对象，改用 page.type()。
   */
  async typeText(text: string): Promise<boolean> {
    const { page } = this.ensureReady();
    try {
      if (page.keyboard && typeof page.keyboard.type === "function") {
        await page.keyboard.type(text);
        return true;
      }
      if (typeof page.type === "function") {
        await page.type(text);
        return true;
      }
      // 回退：尝试对当前焦点元素用 locator 输入
      if (typeof page.locator === "function") {
        await page.locator("input:focus").type(text);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** 导航。失败不抛出，返回 success=false（与 Python 一致） */
  async navigate(
    url: string,
    options: { waitUntil?: string; timeoutMs?: number } = {},
  ): Promise<PrimitiveResult<string>> {
    const start = Date.now();
    try {
      const { page } = this.ensureReady();
      await page.goto(url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? Timeouts.NAVIGATION,
      });
      return { success: true, data: page.url(), durationMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** 执行自然语言动作 */
  async act(instruction: string): Promise<PrimitiveResult> {
    const start = Date.now();
    try {
      const { sh } = this.ensureReady();
      const result = await sh.act(instruction);
      const ok =
        result && typeof result === "object" && "success" in result
          ? Boolean((result as { success: unknown }).success)
          : true;
      return {
        success: ok,
        data: result,
        message: `执行成功: ${instruction}`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** 结构化抽取；schema 省略时返回页面文本 */
  async extract<T = unknown>(instruction: string, schema?: unknown): Promise<PrimitiveResult<T>> {
    const start = Date.now();
    try {
      const { sh } = this.ensureReady();
      const data = schema
        ? await sh.extract(instruction, schema)
        : await sh.extract(instruction);
      return { success: true, data: data as T, durationMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** 观察页面候选元素 */
  async observe(instruction?: string): Promise<PrimitiveResult<unknown[]>> {
    const start = Date.now();
    try {
      const { sh } = this.ensureReady();
      const data = await sh.observe(instruction);
      return {
        success: true,
        data: Array.isArray(data) ? data : [],
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        data: [],
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }
  /**
   * 取 Playwright 兼容页对象。
   * 供 auto_replace_email / auto_replace_phone 这类确定性选择器脚本使用——
   * 它们不用 AI，直接按选择器操作，复用同一条 CDP 连接。
   */
  asPlaywrightPage(): CompatPage {
    const { page } = this.ensureReady();
    return createCompatPage(page as never);
  }

  // ==================== operation 门面 ====================
  // 对标 Python engine.py 上同名方法。用动态 import 避免
  // engine ↔ operations 的循环依赖（operations 需要 engine 类型）。
  // 每个方法只做一件事：构造对应 Operation 并委托执行。

  async login(options: {
    email: string;
    password: string;
    totpSecret?: string | null;
    recoveryEmail?: string | null;
    /** 步骤日志（不会包含密码、密钥与验证码） */
    log?: ((msg: string) => void) | null;
  }): Promise<import("./types.ts").LoginResult> {
    const { LoginOperation } = await import("./operations/login.ts");
    return new LoginOperation(this).execute(options);
  }

  /**
   * 在页面内执行脚本并返回结果（operation 需要按 DOM 结构读数据时用，例如设备页的会话条目）。
   * 拿不到 evaluate 能力或脚本抛错时返回 null，由调用方如实处理。
   */
  async evaluateScript<R = unknown>(script: string): Promise<R | null> {
    const { page } = this.ensureReady();
    if (typeof page.evaluate !== "function") return null;
    try {
      return (await page.evaluate<R>(script)) ?? null;
    } catch {
      return null;
    }
  }

  async kickDevices(
    options: {
      keepCurrent?: boolean;
      credentials?: import("./operations/kick-devices.ts").ReauthCredentials;
    } = {},
  ): Promise<import("./types.ts").KickDevicesResult> {
    const { KickDevicesOperation } = await import("./operations/kick-devices.ts");
    return new KickDevicesOperation(this).execute(options);
  }

  async modify2svPhone(
    newPhone: string,
    smsService: import("./operations/modify-2sv.ts").SmsCodeService | null = null,
    credentials: import("./operations/modify-2sv.ts").ReauthCredentials = {},
  ): Promise<import("./types.ts").ModifyPhoneResult> {
    const { Modify2SVOperation } = await import("./operations/modify-2sv.ts");
    return new Modify2SVOperation(this).execute(newPhone, smsService, credentials);
  }

  async modifyAuthenticator(
    credentials: import("./operations/modify-auth.ts").ReauthCredentials = {},
  ): Promise<import("./types.ts").ModifyAuthenticatorResult> {
    const { ModifyAuthenticatorOperation } = await import("./operations/modify-auth.ts");
    return new ModifyAuthenticatorOperation(this).execute(credentials);
  }

  async replaceRecoveryEmail(
    newEmail: string,
    emailService: import("./operations/replace-email.ts").EmailCodeService | null = null,
    credentials: import("./operations/replace-email.ts").ReauthCredentials = {},
  ): Promise<import("./types.ts").ReplaceEmailResult> {
    const { ReplaceEmailOperation } = await import("./operations/replace-email.ts");
    return new ReplaceEmailOperation(this).execute(newEmail, emailService, credentials);
  }

  async replaceRecoveryPhone(
    newPhone: string,
    smsService: import("./operations/replace-phone.ts").SmsCodeService | null = null,
    credentials: import("./operations/replace-phone.ts").ReauthCredentials = {},
  ): Promise<import("./types.ts").ModifyPhoneResult> {
    const { ReplacePhoneOperation } = await import("./operations/replace-phone.ts");
    return new ReplacePhoneOperation(this).execute(newPhone, smsService, credentials);
  }

  /**
   * 修改账号密码（F1，本地新增）。options.newPassword 由调用方生成，凭据不经日志。
   * log 只用于把「第几轮重新验证」这类进度写进任务日志（不含任何凭据）。
   */
  async changePassword(
    options: import("./operations/change-password.ts").ChangePasswordOptions,
    log: ((msg: string) => void) | null = null,
  ): Promise<import("./types.ts").ChangePasswordResult> {
    const { ChangePasswordOperation } = await import("./operations/change-password.ts");
    const op = new ChangePasswordOperation(this);
    op.setLog(log);
    return op.execute(options);
  }

}
