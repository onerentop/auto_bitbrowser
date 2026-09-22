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
}

interface PageLike {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url(): string;
  content?(): Promise<string>;
  locator?(selector: string): LocatorLike;
  keyboard?: { type(text: string): Promise<void> };
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

  async getPageContent(): Promise<string> {
    const { page } = this.ensureReady();
    if (typeof page.content !== "function") return "";
    try {
      return await page.content();
    } catch {
      return "";
    }
  }

  /**
   * 按选择器填充输入框。
   * 对标 Python 的 engine.page.fill()——用于 act() 输入失败时的降级路径。
   * 拿不到 locator 能力时返回 false，由调用方决定后续。
   */
  async fill(selector: string, value: string): Promise<boolean> {
    const { page } = this.ensureReady();
    if (typeof page.locator !== "function") return false;
    try {
      await page.locator(selector).fill(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 直接敲键盘输入文本。
   * 对标 Python 的 engine.page.keyboard.type()——act() 与 fill() 都失败时的最后手段。
   */
  async typeText(text: string): Promise<boolean> {
    const { page } = this.ensureReady();
    if (page.keyboard && typeof page.keyboard.type === "function") {
      try {
        await page.keyboard.type(text);
        return true;
      } catch {
        return false;
      }
    }
    // 回退：尝试对当前焦点元素用 locator 输入
    if (typeof page.locator === "function") {
      try {
        await page.locator("input:focus").type(text);
        return true;
      } catch {
        return false;
      }
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
  // ==================== operation 门面 ====================
  // 对标 Python engine.py 上同名方法。用动态 import 避免
  // engine ↔ operations 的循环依赖（operations 需要 engine 类型）。
  // 每个方法只做一件事：构造对应 Operation 并委托执行。

  async login(options: {
    email: string;
    password: string;
    totpSecret?: string | null;
    recoveryEmail?: string | null;
  }): Promise<import("./types.ts").LoginResult> {
    const { LoginOperation } = await import("./operations/login.ts");
    return new LoginOperation(this).execute(options);
  }

  async detectProStatus(
    options: { navigateIfNeeded?: boolean } = {},
  ): Promise<import("./types.ts").ProStatusResult> {
    const { ProStatusOperation } = await import("./operations/pro-status.ts");
    return new ProStatusOperation(this as never).execute(options);
  }

  async detectFamilyStatus(
    options: { navigateIfNeeded?: boolean } = {},
  ): Promise<import("./types.ts").FamilyStatusResult> {
    const { FamilyOperation } = await import("./operations/family.ts");
    return new FamilyOperation(this).execute(options);
  }

  async kickDevices(
    options: { keepCurrent?: boolean } = {},
  ): Promise<import("./types.ts").KickDevicesResult> {
    const { KickDevicesOperation } = await import("./operations/kick-devices.ts");
    return new KickDevicesOperation(this).execute(options);
  }

  async modify2svPhone(
    newPhone: string,
    smsService: import("./operations/modify-2sv.ts").SmsCodeService | null = null,
  ): Promise<import("./types.ts").ModifyPhoneResult> {
    const { Modify2SVOperation } = await import("./operations/modify-2sv.ts");
    return new Modify2SVOperation(this).execute(newPhone, smsService);
  }

  async modifyAuthenticator(): Promise<import("./types.ts").ModifyAuthenticatorResult> {
    const { ModifyAuthenticatorOperation } = await import("./operations/modify-auth.ts");
    return new ModifyAuthenticatorOperation(this).execute();
  }

  async replaceRecoveryEmail(
    newEmail: string,
    emailService: import("./operations/replace-email.ts").EmailCodeService | null = null,
  ): Promise<import("./types.ts").ReplaceEmailResult> {
    const { ReplaceEmailOperation } = await import("./operations/replace-email.ts");
    return new ReplaceEmailOperation(this).execute(newEmail, emailService);
  }

  async replaceRecoveryPhone(
    newPhone: string,
    smsService: import("./operations/replace-phone.ts").SmsCodeService | null = null,
  ): Promise<import("./types.ts").ModifyPhoneResult> {
    const { ReplacePhoneOperation } = await import("./operations/replace-phone.ts");
    return new ReplacePhoneOperation(this).execute(newPhone, smsService);
  }

  async unlock403(
    options: import("./operations/unlock-403.ts").UnlockOptions = {},
  ): Promise<import("./types.ts").UnlockResult> {
    const { Unlock403Operation } = await import("./operations/unlock-403.ts");
    return new Unlock403Operation(this).execute(options);
  }

  async joinFamily(inviterEmail: string): Promise<import("./types.ts").JoinFamilyResult> {
    const { JoinFamilyOperation } = await import("./operations/join-family.ts");
    return new JoinFamilyOperation(this).execute(inviterEmail);
  }

  async enableFamilySharing(): Promise<import("./types.ts").EnableSharingResult> {
    const { EnableSharingOperation } = await import("./operations/enable-sharing.ts");
    return new EnableSharingOperation(this).execute();
  }

  async oauthAuthorize(
    service: string,
    oauthUrl?: string | null,
    oauthUrls?: Record<string, string>,
  ): Promise<import("./types.ts").OAuthResult> {
    const { OAuthOperation } = await import("./operations/oauth.ts");
    return new OAuthOperation(this, oauthUrls).execute(service, oauthUrl);
  }
}
