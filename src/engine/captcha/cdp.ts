/**
 * 一条自开的 CDP 连接（reCAPTCHA 求解用）。
 *
 * 为什么不用 Stagehand：`page.sendCDP(method, params)` **没有 sessionId 参数** → 访问不了
 * OOPIF（跨域 bframe）→ 必须自开一条 CDP 连接（真机实证，research §1.4）。
 *
 * 接法（照抄真机脚本，别凭记忆改）：
 *   GET http://<debugging_address>/json/list → 取 type === "page" 的 webSocketDebuggerUrl
 *   → 全局 WebSocket（Node ≥ 22 自带，不新增依赖）
 *   → Page.enable / Runtime.enable / Target.setAutoAttach {flatten:true} / Page.bringToFront
 *   → 从 Target.attachedToTarget 收集 sessionId，用 sessionId 路由 Runtime.evaluate；
 *     Input.dispatchMouseEvent 走页面级（不带 sessionId）
 *
 * 约定：
 *   - `send()` 超时不是异常，返回 `{ __error: "timeout" }`（便于在流程里逐点判断）；
 *     `evaluate()` 遇到 `__error` 返回 null —— 调用方如实处理，不假装成功。
 *   - `Target.attachedToTarget` 的 `targetInfo.url` 实测**可能是空的**，所以不能靠 URL 认 bframe，
 *     要逐个 session 探 DOM（求解器里做）。
 */

import type { FetchLike } from "./types.ts";

/** 可注入的 WebSocket（全局 WebSocket 满足；单测注入假实现） */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** `/json/list` 里的页面目标 */
export interface CdpTarget {
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** 已附加的 OOPIF 会话（sessionId + 可能为空的 url） */
export interface CdpSession {
  sessionId: string;
  url: string;
}

/** 求解器依赖的最小 CDP 能力（单测注入假实现） */
export interface CdpPort {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  evaluate<T = unknown>(expr: string, sessionId?: string): Promise<T | null>;
  mouseClick(x: number, y: number): Promise<void>;
  readonly sessions: readonly CdpSession[];
  on(fn: (msg: Record<string, unknown>) => void): void;
  close(): void;
}

/** 单次 CDP 请求超时 */
export const DEFAULT_CDP_TIMEOUT_MS = 15_000;

/** `/json/list` 查询超时 */
export const CDP_LIST_TIMEOUT_MS = 5_000;

/** 取文本值（null/undefined → ""） */
function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** URL 的 hostname（解析失败 → ""） */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * `ws://127.0.0.1:49693/devtools/browser/x` → `127.0.0.1:49693`。
 * 解析不了（空串 / 没有 scheme / 非法 URL）返回 null。
 */
export function parseHostPort(wsUrl: string): string | null {
  if (!wsUrl) return null;
  try {
    const url = new URL(wsUrl);
    return url.host || null;
  } catch {
    return null;
  }
}

/**
 * 选页面目标（纯函数）。真机教训：窗口里常开多个标签页，选错页会把鼠标事件派发到别的标签
 * （点击落空、页面却「没反应」），所以按 URL 认页，而不是取第一个。
 *
 * 规则（design §4）：
 *   1. `type === "page"` 且 URL 与 currentUrl 完全相等
 *   2. 否则 URL host 是 `accounts.google.com` 的 page
 *   3. 否则第一个 `type === "page"`；都没有 → null
 */
export function pickPageTarget(targets: readonly CdpTarget[], currentUrl: string): CdpTarget | null {
  const pages = targets.filter(
    (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl !== "",
  );
  if (pages.length === 0) return null;

  const wanted = pickText(currentUrl).trim();
  if (wanted) {
    const exact = pages.find((target) => target.url === wanted);
    if (exact) return exact;
  }

  const google = pages.find((target) => hostOf(target.url) === "accounts.google.com");
  if (google) return google;

  return pages[0] ?? null;
}

/**
 * 查 `/json/list` 并按 `pickPageTarget` 选页。
 * 任何失败（连不上、非 200、坏 JSON、没有 page）都返回 null（→ 调用方按 `no_endpoint` 处理）。
 */
export async function fetchPageTarget(
  debuggingAddress: string,
  currentUrl: string,
  fetchImpl?: FetchLike,
): Promise<CdpTarget | null> {
  const doFetch: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const response = await doFetch(`http://${debuggingAddress}/json/list`, {
      method: "GET",
      signal: AbortSignal.timeout(CDP_LIST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed: unknown = JSON.parse(await response.text());
    if (!Array.isArray(parsed)) return null;
    const targets: CdpTarget[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record["type"] !== "string" || typeof record["url"] !== "string") continue;
      targets.push({
        type: record["type"],
        url: record["url"],
        webSocketDebuggerUrl: pickText(record["webSocketDebuggerUrl"]),
      });
    }
    return pickPageTarget(targets, currentUrl);
  } catch {
    return null;
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 自开的 CDP 连接（一个窗口一条，懒建、缓存） */
export class CdpConnection implements CdpPort {
  private readonly wsUrl: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly timeoutMs: number;
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners: ((msg: Record<string, unknown>) => void)[] = [];
  private readonly sessionList: CdpSession[] = [];
  private nextId = 1;
  private closed = false;

  constructor(wsUrl: string, options: { createSocket?: (url: string) => WebSocketLike; timeoutMs?: number } = {}) {
    this.wsUrl = wsUrl;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
  }

  /** 已收集到的 OOPIF 会话（`targetInfo.url` 可能为空） */
  get sessions(): readonly CdpSession[] {
    return this.sessionList.slice();
  }

  /**
   * 建连接并跑完固定握手：open → Page.enable → Runtime.enable →
   * Target.setAutoAttach{flatten:true} → Page.bringToFront。
   * 任何一步失败都关掉连接并抛出（调用方转成 `cdp_failed`，不要外泄异常）。
   */
  async connect(): Promise<void> {
    if (this.closed) throw new Error("CDP 连接已关闭");
    if (this.socket) throw new Error("CDP 连接已建立，不要重复 connect()");

    const socket = this.createSocket(this.wsUrl);
    this.socket = socket;
    socket.onmessage = (ev) => this.handleMessage(ev?.data);

    let failOpen: ((error: Error) => void) | null = null;
    socket.onerror = () => {
      const error = new Error("CDP socket error");
      this.failPending("socket_error");
      if (failOpen) failOpen(error);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          failOpen = null;
          reject(new Error(`CDP 连接超时（${this.timeoutMs}ms）`));
        }, this.timeoutMs);
        failOpen = (error) => {
          clearTimeout(timer);
          failOpen = null;
          reject(error);
        };
        socket.onopen = () => {
          clearTimeout(timer);
          failOpen = null;
          resolve();
        };
      });

      await this.must("Page.enable");
      await this.must("Runtime.enable");
      await this.must("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      await this.must("Page.bringToFront");
    } catch (error) {
      this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * 发一条 CDP 消息。`sessionId` 可选：带上即路由到 OOPIF，不带就是页面级。
   * 超时 / socket 已关 / 底层 CDP 报错一律返回带 `__error` 的对象，**不抛异常**。
   */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const socket = this.socket;
    if (!socket || this.closed) return Promise.resolve({ __error: "closed" });

    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message["sessionId"] = sessionId;

    return new Promise<Record<string, unknown>>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __error: "timeout" });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ __error: `send_failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  }

  /** 求值（`returnByValue`）：失败 / 超时 → null，调用方不得当成「求值为假」以外的成功证据 */
  async evaluate<T = unknown>(expr: string, sessionId?: string): Promise<T | null> {
    const response = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (typeof response["__error"] === "string") return null;
    const remote = response["result"];
    if (typeof remote !== "object" || remote === null) return null;
    const value = (remote as Record<string, unknown>)["value"];
    return value === undefined ? null : (value as T);
  }

  /** 真人化点击：移动轨迹 + 按下/抬起间隔（真机实测的数值） */
  async mouseClick(x: number, y: number): Promise<void> {
    await this.mouse("mouseMoved", x - 90, y - 45);
    await sleep(90);
    await this.mouse("mouseMoved", x - 25, y - 12);
    await sleep(80);
    await this.mouse("mouseMoved", x, y);
    await sleep(130);
    await this.mouse("mousePressed", x, y, { button: "left", clickCount: 1, buttons: 1 });
    await sleep(70);
    await this.mouse("mouseReleased", x, y, { button: "left", clickCount: 1, buttons: 0 });
  }

  /** 订阅事件（`Runtime.executionContextCreated` 等未被内部消费的消息） */
  on(fn: (msg: Record<string, unknown>) => void): void {
    this.listeners.push(fn);
  }

  /** 幂等：重复调用只有第一次会关 socket；未决请求以 `{__error:"closed"}` 收尾 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending("closed");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onopen = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // 关闭失败不影响调用方（连接已经不再被使用）
      }
    }
    this.listeners.length = 0;
    this.sessionList.length = 0;
  }

  private async mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
    // Input.dispatchMouseEvent 走页面级（不带 sessionId）
    await this.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  private async must(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.send(method, params);
    const error = result["__error"];
    if (typeof error === "string") throw new Error(`${method} 失败: ${error}`);
    return result;
  }

  private failPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ __error: reason });
      this.pending.delete(id);
    }
  }

  private handleMessage(data: unknown): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = typeof data === "string" ? JSON.parse(data) : data;
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return; // CDP 偶发非 JSON 消息：忽略，不影响在途请求的超时收尾
    }

    const id = message["id"];
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const error = message["error"];
        if (typeof error === "object" && error !== null) {
          const record = error as Record<string, unknown>;
          pending.resolve({ __error: pickText(record["message"]) || "cdp_error", code: record["code"] });
        } else {
          const result = message["result"];
          pending.resolve(typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {});
        }
      }
    }

    const method = message["method"];
    if (typeof method !== "string") return;

    if (method === "Target.attachedToTarget") {
      this.collectSession(message["params"]);
    } else if (method === "Target.detachedFromTarget") {
      this.dropSession(message["params"]);
    }

    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // 订阅者自己出错不影响 CDP 连接
      }
    }
  }

  private collectSession(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const record = params as Record<string, unknown>;
    const sessionId = pickText(record["sessionId"]);
    if (!sessionId) return;
    const targetInfo = record["targetInfo"];
    const url = typeof targetInfo === "object" && targetInfo !== null ? pickText((targetInfo as Record<string, unknown>)["url"]) : "";
    const existing = this.sessionList.find((session) => session.sessionId === sessionId);
    if (existing) existing.url = url;
    else this.sessionList.push({ sessionId, url });
  }

  private dropSession(params: unknown): void {
    if (typeof params !== "object" || params === null) return;
    const sessionId = pickText((params as Record<string, unknown>)["sessionId"]);
    const index = this.sessionList.findIndex((session) => session.sessionId === sessionId);
    if (index >= 0) this.sessionList.splice(index, 1);
  }
}
