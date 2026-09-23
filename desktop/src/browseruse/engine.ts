/**
 * BrowserUse Engine - 主引擎类（Node 重写）
 * 对标 core/browseruse_engine/engine.py
 *
 * 基于 browser-use 设计的 AI 浏览器控制引擎，实现 EngineProtocol，
 * 与 StagehandGoogleEngine 互换使用。
 *
 * 移植差异（均在对应位置另有注释）：
 *   1. Python 直接 import playwright；Node 侧把 CDP 连接抽成可注入的 CdpConnector
 *      （默认实现惰性加载 playwright-core），保证 typecheck 与单测离线。
 *   2. Python 的 `openBrowser/closeBrowser`（services.ix_api）→ IxBrowserClient 的
 *      openProfile/closeProfile。Python 侧 import 失败会降级为不可用，这里改为
 *      构造时注入客户端，不可用的情况由调用方决定。
 *   3. Python 的 `async with` 上下文管理器 → withEngine() 辅助函数。
 *   4. Python 的 `time.time()*1000` → `Date.now()`。
 *
 * 用法：
 *   const engine = await BrowserUseEngine.connectToIxBrowser(370, { llmApiKey, llmProvider });
 *   try { await engine.run("打开 Google 并搜索 Python"); } finally { await engine.stop(); }
 */
import { IxBrowserClient } from "../ixbrowser/client.ts";
import { AgentService } from "./agent/service.ts";
import { PromptManager } from "./agent/prompts.ts";
import { DomService } from "./dom/service.ts";
import { createLlmAdapter, createLlmFromConfig, type LlmConfigProvider } from "./llm/adapters.ts";
import type { BaseChatModel } from "./llm/base.ts";
import { noopLog, type BrowserPageLike, type LogFn } from "./page.ts";
import { createPlaywrightConnector, type CdpConnection, type CdpConnector } from "./playwright-cdp.ts";
import {
  createActionResult,
  createAgentResult,
  createAgentStep,
  createExtractResult,
  createNavigationResult,
  createObserveResult,
  type ActionResult,
  type AgentResult,
  type AgentStep,
  type EngineProtocol,
  type ExtractResult,
  type NavigateOptions,
  type NavigationResult,
  type ObserveResult,
} from "./protocol.ts";
import { ActionExecutor } from "./tools/executor.ts";
import type { JoinFamilyResult } from "./types.ts";
import { JoinFamilyOperation } from "./operations/join-family.ts";

/** 引擎构造参数 —— 对标 Python `__init__` 的关键字参数 */
export interface BrowserUseEngineOptions {
  /** 已有页面对象（CDP 连接时会自动获取） */
  page?: BrowserPageLike | null;
  /** LLM 适配器实例（不给则按下面的 provider 参数创建） */
  llm?: BaseChatModel | null;
  llmProvider?: string | null;
  llmModel?: string | null;
  llmApiKey?: string | null;
  llmBaseUrl?: string | null;
  /** 是否使用视觉模式（截图），默认 true */
  useVision?: boolean;
  /** 每步最大动作数，默认 3 */
  maxActionsPerStep?: number;
  /** 提示词语言（"en" 或 "zh"），默认 "zh" */
  language?: string;
  /** 日志钩子（Python 侧是 logging） */
  log?: LogFn;
  /** ixBrowser 客户端（默认自建） */
  ixClient?: IxBrowserClient;
  /** CDP 连接器（默认 playwright-core；测试可注入替身） */
  cdpConnector?: CdpConnector;
  /** 无 provider 参数时，create_llm_from_config 的配置来源 */
  aiConfig?: LlmConfigProvider | null;
}

/** connectToIxBrowser 的参数 */
export interface ConnectToIxBrowserOptions extends BrowserUseEngineOptions {
  /** 退出时是否关闭 ixBrowser 窗口，默认 false */
  closeBrowserOnExit?: boolean;
}

export class BrowserUseEngine {
  private _page: BrowserPageLike | null;
  private _connection: CdpConnection | null = null;

  private readonly _llm: BaseChatModel;
  readonly useVision: boolean;
  readonly maxActionsPerStep: number;
  readonly language: string;

  // 组件（延迟初始化）
  private _domService: DomService | null = null;
  private _actionExecutor: ActionExecutor | null = null;
  private _agentService: AgentService | null = null;
  private _promptManager: PromptManager | null = null;

  // 状态
  private _initialized = false;
  private _cdpMode = false;
  private _cdpUrl: string | null = null;
  private _browserId: number | null = null;
  private _closeBrowserOnExit = false;

  private readonly log: LogFn;
  private readonly ix: IxBrowserClient;
  private readonly connector: CdpConnector;

  constructor(options: BrowserUseEngineOptions = {}) {
    this._page = options.page ?? null;
    this.log = options.log ?? noopLog;
    this.ix = options.ixClient ?? new IxBrowserClient();
    this.connector = options.cdpConnector ?? createPlaywrightConnector();

    // LLM 配置 —— 分支顺序与 Python 一致
    if (options.llm) {
      this._llm = options.llm;
    } else if (options.llmProvider && options.llmApiKey) {
      this._llm = createLlmAdapter({
        provider: options.llmProvider,
        api_key: options.llmApiKey,
        model: options.llmModel ?? null,
        base_url: options.llmBaseUrl ?? null,
        log: this.log,
      });
    } else {
      // 尝试从配置创建
      this._llm = createLlmFromConfig(options.aiConfig ?? null, { log: this.log });
    }

    this.useVision = options.useVision ?? true;
    this.maxActionsPerStep = options.maxActionsPerStep ?? 3;
    this.language = options.language ?? "zh";
  }

  // ==================== CDP 连接方法 ====================

  /**
   * 连接到已打开的 ixBrowser 窗口 —— 对标 connect_to_ixbrowser()
   *
   * Python 侧 browser_id 是字符串；这里用 number（IxBrowserClient 的 profile_id 口径），
   * 同时接受字符串形式并转换。
   */
  static async connectToIxBrowser(
    browserId: string | number,
    options: ConnectToIxBrowserOptions = {},
  ): Promise<BrowserUseEngine> {
    const log = options.log ?? noopLog;
    const profileId = typeof browserId === "number" ? browserId : Number(browserId);

    const engine = new BrowserUseEngine(options);

    // 打开浏览器获取 WebSocket 端点
    log(`正在打开 ixBrowser 窗口: ${browserId}`);
    let wsEndpoint: string;
    try {
      const result = await engine.ix.openProfile(profileId);
      wsEndpoint = result.ws;
      if (!wsEndpoint) {
        throw new Error("未获取到 WebSocket 端点");
      }
      log(`获取到 CDP 端点: ${wsEndpoint.slice(0, 50)}...`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`打开 ixBrowser 窗口失败: ${msg}`);
      throw new Error(`打开 ixBrowser 窗口失败: ${msg}`);
    }

    engine._browserId = profileId;
    engine._closeBrowserOnExit = options.closeBrowserOnExit ?? false;

    // 连接到 CDP
    await engine.connectCdp(wsEndpoint);

    return engine;
  }

  /** 连接到现有的 CDP WebSocket 端点 —— 对标 connect_cdp() */
  async connectCdp(wsEndpoint: string): Promise<void> {
    if (this._initialized) {
      throw new Error("引擎已初始化，无法重复连接");
    }

    this.log(`正在通过 CDP 连接: ${wsEndpoint.slice(0, 50)}...`);

    try {
      this._connection = await this.connector.connect(wsEndpoint);
      this._page = this._connection.page;

      this._cdpUrl = wsEndpoint;
      this._cdpMode = true;

      // 初始化组件
      await this.initializeComponents();

      this.log("CDP 连接成功");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`CDP 连接失败: ${msg}`);
      // 清理已分配的资源，避免泄漏（与 Python 的 except 分支一致）
      if (this._connection) {
        try {
          await this._connection.close();
        } catch {
          /* 忽略 */
        }
        try {
          await this._connection.dispose();
        } catch {
          /* 忽略 */
        }
        this._connection = null;
      }
      this._page = null;
      this._cdpMode = false;
      this._cdpUrl = null;
      throw new Error(`CDP 连接失败: ${msg}`);
    }
  }

  /** 初始化内部组件 —— 对标 _initialize_components() */
  private async initializeComponents(): Promise<void> {
    if (this._initialized) return;

    if (!this._page) {
      throw new Error("Page 对象未设置，无法初始化");
    }
    if (!this._llm) {
      throw new Error("LLM 未配置，无法初始化");
    }

    // 创建组件
    this._domService = new DomService(this._page, { log: this.log });
    this._promptManager = new PromptManager({ language: this.language });
    this._actionExecutor = new ActionExecutor({
      page: this._page,
      domService: this._domService,
      llm: this._llm,
      log: this.log,
    });
    this._agentService = new AgentService({
      llm: this._llm,
      page: this._page,
      domService: this._domService,
      actionExecutor: this._actionExecutor,
      promptManager: this._promptManager,
      useVision: this.useVision,
      maxActionsPerStep: this.maxActionsPerStep,
      language: this.language,
      log: this.log,
    });

    this._initialized = true;
    this.log("BrowserUseEngine 初始化完成");
  }

  /**
   * 进入引擎（对标 Python 的 `__aenter__`）。
   *
   * Python：`async with BrowserUseEngine(page=page, llm=llm) as engine:` 会在
   * 未初始化时调 `_initialize_components()`——注意它**不会**启动浏览器。
   * 注入了 page 的用法走的就是这条路径，而不是 start()。
   */
  async enter(): Promise<this> {
    if (!this._initialized) {
      await this.initializeComponents();
    }
    return this;
  }

  /**
   * 启动引擎（本地模式） —— 对标 start()
   *
   * ⚠️ 照搬 Python：**无条件**拉起本地浏览器并覆盖已注入的 page
   * （engine.py:353-356 就是无条件 launch + new_context + new_page）。
   * 想复用已注入的 page，请用 enter()（对应 Python 的 `async with`）。
   */
  async start(): Promise<void> {
    if (this._initialized) {
      this.log("引擎已初始化，跳过重复启动");
      return;
    }

    if (this._cdpMode) {
      this.log("CDP 模式下请使用 connect_cdp() 而非 start()");
      return;
    }

    this.log("正在启动 BrowserUseEngine (本地模式)...");

    try {
      this._connection = await this.connector.launchLocal();
      this._page = this._connection.page;

      await this.initializeComponents();

      this.log("BrowserUseEngine 启动成功 (本地模式)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`启动 BrowserUseEngine 失败: ${msg}`);
      throw e;
    }
  }

  /**
   * 关闭引擎 —— 对标 stop()
   *
   * @param closeBrowser 是否关闭 ixBrowser 窗口（仅 CDP 模式有效）：
   *   undefined → 用创建时的 closeBrowserOnExit；true 强制关；false 不关。
   */
  async stop(closeBrowser?: boolean): Promise<void> {
    if (!this._initialized) {
      // 即使未完全初始化，也要清理可能已分配的底层资源
      if (this._connection) {
        try {
          await this._connection.close();
        } catch {
          /* 忽略 */
        }
        try {
          await this._connection.dispose();
        } catch {
          /* 忽略 */
        }
        this._connection = null;
      }
      return;
    }

    this.log("正在关闭 BrowserUseEngine...");

    try {
      if (this._cdpMode) {
        // CDP 模式：断开连接但不关闭浏览器（除非指定）
        const shouldClose = closeBrowser === undefined ? this._closeBrowserOnExit : closeBrowser;

        if (this._connection) {
          try {
            await this._connection.close();
          } catch (e) {
            this.log(`关闭浏览器连接时出错: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        // 是否关闭 ixBrowser 窗口
        if (shouldClose && this._browserId !== null) {
          try {
            await this.ix.closeProfile(this._browserId);
            this.log(`已关闭 ixBrowser 窗口: ${this._browserId}`);
          } catch (e) {
            this.log(`关闭 ixBrowser 窗口失败: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        this._cdpUrl = null;
        this._browserId = null;

        if (this._connection) {
          try {
            await this._connection.dispose();
          } catch (e) {
            this.log(`关闭 Playwright 实例时出错: ${e instanceof Error ? e.message : String(e)}`);
          }
          this._connection = null;
        }
      } else {
        // 本地模式：关闭 context → browser → playwright
        if (this._connection) {
          if (this._connection.closeContext) {
            try {
              await this._connection.closeContext();
            } catch {
              /* 忽略 */
            }
          }
          try {
            await this._connection.close();
          } catch {
            /* 忽略 */
          }
          try {
            await this._connection.dispose();
          } catch {
            /* 忽略 */
          }
          this._connection = null;
        }
      }

      this._page = null;
      this._domService = null;
      this._actionExecutor = null;
      this._agentService = null;
      this._initialized = false;
      this._cdpMode = false;

      this.log("BrowserUseEngine 已关闭");
    } catch (e) {
      this.log(`关闭 BrowserUseEngine 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 确保引擎已初始化 —— 对标 _ensure_initialized() */
  private ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error("引擎未初始化。请先调用 start() 或使用 async with 上下文管理器");
    }
  }

  // ==================== EngineProtocol 实现 ====================

  get isInitialized(): boolean {
    return this._initialized;
  }

  /** Playwright Page 对象 */
  get page(): BrowserPageLike {
    this.ensureInitialized();
    return this._page as BrowserPageLike;
  }

  get isCdpMode(): boolean {
    return this._cdpMode;
  }

  get browserId(): number | null {
    return this._browserId;
  }

  /** 导航到指定 URL —— 对标 navigate() */
  async navigate(url: string, options: NavigateOptions = {}): Promise<NavigationResult> {
    this.ensureInitialized();
    const startTime = Date.now();

    try {
      await this.page.goto(url, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? 30000,
      });
      const durationMs = Date.now() - startTime;

      const finalUrl = this.page.url();
      this.log(`导航成功: ${url} -> ${finalUrl}`);

      return createNavigationResult({
        success: true,
        url,
        final_url: finalUrl,
        duration_ms: durationMs,
      });
    } catch (e) {
      const durationMs = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`导航失败: ${url} - ${msg}`);

      return createNavigationResult({
        success: false,
        url,
        error: msg,
        duration_ms: durationMs,
      });
    }
  }

  /** 执行自然语言指令（单步） —— 对标 act()，内部是 max_steps=1 的 Agent */
  async act(instruction: string, _timeoutMs = 30000): Promise<ActionResult> {
    this.ensureInitialized();
    const startTime = Date.now();

    try {
      const result = await this.agentService.run(instruction, { maxSteps: 1 });
      const durationMs = Date.now() - startTime;

      if (result.success) {
        return createActionResult({
          success: true,
          message: `执行成功: ${instruction}`,
          extracted_content: result.extracted_content,
          duration_ms: durationMs,
        });
      }
      return createActionResult({
        success: false,
        error: result.error || "执行失败",
        duration_ms: durationMs,
      });
    } catch (e) {
      const durationMs = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`操作失败: ${instruction} - ${msg}`);

      return createActionResult({ success: false, error: msg, duration_ms: durationMs });
    }
  }

  /**
   * 提取页面数据 —— 对标 extract()
   *
   * schema：Python 传 pydantic 类并用 model_json_schema() 拼进任务描述；
   * TS 侧接受任意「可 JSON 序列化的 schema 描述」，有值就照同样格式拼接。
   */
  async extract<T = Record<string, unknown>>(
    instruction: string,
    schema?: unknown,
    options: { timeoutMs?: number; maxSteps?: number } = {},
  ): Promise<ExtractResult<T>> {
    this.ensureInitialized();
    const startTime = Date.now();
    const maxSteps = options.maxSteps ?? 10;

    try {
      // 构建提取任务
      let extractTask = `Extract the following from the page: ${instruction}`;
      if (schema) {
        // 添加 schema 信息到任务
        let schemaInfo = "";
        const jsonSchema = toJsonSchema(schema);
        if (jsonSchema !== null) {
          schemaInfo = `\n\nExpected output format: ${jsonSchema}`;
        }
        extractTask += schemaInfo;
      }

      // 使用 Agent 执行提取
      const result = await this.agentService.run(extractTask, { maxSteps });
      const durationMs = Date.now() - startTime;

      if (result.success && result.extracted_content) {
        // 尝试解析提取的内容
        let data: unknown;
        try {
          data = JSON.parse(result.extracted_content);
        } catch {
          data = { content: result.extracted_content };
        }

        return createExtractResult<T>({
          success: true,
          data: data as T,
          duration_ms: durationMs,
        });
      }
      return createExtractResult<T>({
        success: false,
        error: result.error || "提取失败",
        duration_ms: durationMs,
      });
    } catch (e) {
      const durationMs = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`提取失败: ${instruction} - ${msg}`);

      return createExtractResult<T>({ success: false, error: msg, duration_ms: durationMs });
    }
  }

  /** 观察页面元素 —— 对标 observe()，直接读 DOM 树不调 LLM */
  async observe(instruction: string, _timeoutMs = 30000): Promise<ObserveResult> {
    this.ensureInitialized();
    const startTime = Date.now();

    try {
      // 获取 DOM 树
      const domTree = await this.domService.extractDom();
      const durationMs = Date.now() - startTime;

      // 收集元素信息
      const elements: Record<string, unknown>[] = [];
      for (const element of domTree.elements) {
        elements.push({
          index: element.index,
          tag: element.tag_name,
          text: element.text ? element.text.slice(0, 100) : "",
          attributes: element.attributes,
          is_visible: element.is_visible,
          is_interactive: element.is_interactive,
        });
      }

      return createObserveResult({ success: true, elements, duration_ms: durationMs });
    } catch (e) {
      const durationMs = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`观察失败: ${instruction} - ${msg}`);

      return createObserveResult({ success: false, error: msg, duration_ms: durationMs });
    }
  }

  /** 执行完整 Agent 任务（多步） —— 对标 run() */
  async run(
    task: string,
    options: { maxSteps?: number; onStep?: (step: Record<string, unknown>) => void } = {},
  ): Promise<AgentResult> {
    this.ensureInitialized();
    const startTime = Date.now();
    const maxSteps = options.maxSteps ?? 50;

    try {
      // 执行 Agent 任务
      const runOptions: { maxSteps: number; onStep?: (step: Record<string, unknown>) => void } = {
        maxSteps,
      };
      if (options.onStep) runOptions.onStep = options.onStep;
      const result = await this.agentService.run(task, runOptions);
      const durationMs = Date.now() - startTime;

      // 转换步骤格式（Python 侧 AgentService 返回的 steps 是 dict 列表）
      const steps: AgentStep[] = [];
      for (const stepData of result.steps as unknown[]) {
        if (stepData !== null && typeof stepData === "object") {
          const d = stepData as Record<string, unknown>;
          steps.push(
            createAgentStep({
              step_number: typeof d["step_number"] === "number" ? (d["step_number"] as number) : 0,
              thinking: typeof d["thinking"] === "string" ? (d["thinking"] as string) : "",
              action_name: typeof d["action_name"] === "string" ? (d["action_name"] as string) : "",
              action_params:
                d["action_params"] && typeof d["action_params"] === "object"
                  ? (d["action_params"] as Record<string, unknown>)
                  : {},
              browser_url: typeof d["browser_url"] === "string" ? (d["browser_url"] as string) : "",
              timestamp: typeof d["timestamp"] === "number" ? (d["timestamp"] as number) : 0,
            }),
          );
        }
      }

      return createAgentResult({
        success: result.success,
        message: result.message,
        error: result.error,
        extracted_content: result.extracted_content,
        steps,
        total_steps: result.total_steps,
        duration_ms: durationMs,
      });
    } catch (e) {
      const durationMs = Date.now() - startTime;
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`Agent 任务失败: ${task} - ${msg}`);

      return createAgentResult({ success: false, error: msg, duration_ms: durationMs });
    }
  }

  // ==================== 辅助方法 ====================

  /** 获取页面截图 —— 对标 screenshot()，失败返回 null */
  async screenshot(fullPage = false): Promise<Uint8Array | null> {
    this.ensureInitialized();
    try {
      return await this.page.screenshot({ fullPage });
    } catch (e) {
      this.log(`截图失败: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** 获取当前 URL */
  async getCurrentUrl(): Promise<string> {
    this.ensureInitialized();
    return this.page.url();
  }

  /** 获取页面标题 */
  async getPageTitle(): Promise<string> {
    this.ensureInitialized();
    return this.page.title();
  }

  /** 获取页面文本内容 —— 对标 get_page_content()（inner_text("body")） */
  async getPageContent(): Promise<string> {
    this.ensureInitialized();
    try {
      return await this.page.innerText("body");
    } catch (e) {
      this.log(`获取页面内容失败: ${e instanceof Error ? e.message : String(e)}`);
      return "";
    }
  }

  /** 等待指定毫秒数 */
  async wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  // ==================== 高级操作方法 ====================

  /** 发送家庭邀请 —— 对标 send_family_invite() */
  async sendFamilyInvite(inviteeEmail: string): Promise<JoinFamilyResult> {
    this.ensureInitialized();
    const op = new JoinFamilyOperation(this, { log: this.log });
    return op.sendInvite(inviteeEmail);
  }

  /** 接受家庭邀请并加入家庭组 —— 对标 join_family() */
  async joinFamily(inviterEmail: string): Promise<JoinFamilyResult> {
    this.ensureInitialized();
    const op = new JoinFamilyOperation(this, { log: this.log });
    return op.acceptInvite(inviterEmail);
  }

  // ==================== 内部取值 ====================

  private get agentService(): AgentService {
    if (!this._agentService) throw new Error("AgentService 未初始化");
    return this._agentService;
  }

  private get domService(): DomService {
    if (!this._domService) throw new Error("DOMService 未初始化");
    return this._domService;
  }
}

/**
 * 把调用方给的 schema 描述转成放进提示词的文本。
 * 对标 Python 的 `hasattr(schema, 'model_json_schema')` 分支：
 * 拿不到可序列化结构时返回 null（等价 Python 的 schema_info 为空串）。
 */
function toJsonSchema(schema: unknown): string | null {
  if (schema === null || schema === undefined) return null;
  if (typeof schema === "string") return schema;
  try {
    return JSON.stringify(schema);
  } catch {
    return null;
  }
}

// ==================== 便捷函数 ====================

/** 创建并启动 BrowserUseEngine —— 对标 create_engine() */
export async function createEngine(options: BrowserUseEngineOptions = {}): Promise<BrowserUseEngine> {
  const engine = new BrowserUseEngine(options);
  await engine.start();
  return engine;
}

/** 从项目配置创建并启动引擎 —— 对标 create_engine_from_config() */
export async function createEngineFromConfig(
  options: BrowserUseEngineOptions = {},
): Promise<BrowserUseEngine> {
  const engine = new BrowserUseEngine(options);
  await engine.start();
  return engine;
}

/**
 * 生命周期包装：对标 Python 的 `async with engine`。
 *
 * 与 Python 一一对应：
 *   进入 → `__aenter__`（未初始化时 `_initialize_components()`，见 enter()）
 *   退出 → `__aexit__`（无论 body 是否抛错都 stop()）
 * Node 没有异步上下文管理器，用高阶函数等价表达。
 */
export async function withEngine<T>(
  engine: BrowserUseEngine,
  body: (engine: BrowserUseEngine) => Promise<T>,
  closeBrowser?: boolean,
): Promise<T> {
  try {
    await engine.enter();
    return await body(engine);
  } finally {
    await engine.stop(closeBrowser);
  }
}
