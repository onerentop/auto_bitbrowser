/**
 * 后端进程客户端 —— 运行在主进程
 *
 * 职责：
 *   1. 拉起后端进程（真实环境是 utilityProcess.fork，测试里注入假进程）
 *   2. 维护状态机 stopped → starting → ready → (crashed | stopped)，变化时通知订阅者
 *   3. request(channel, args)：分配自增 id → postMessage → 按 id 配对响应，带超时
 *   4. 进程退出时，所有待回复的请求立刻以 HOST_UNAVAILABLE 失败
 *
 * 本文件不 import electron：进程句柄通过 spawn 注入，定时器与时钟也可注入，
 * 因此能被 node --test 离线测试。
 *
 * ── 并发安全（代码审查后重写） ──
 * utilityProcess 的 exit 事件是**异步**到达的。早期版本用单个 exitWaiter 槽位，
 * 连点两次「重启」时第二次 stop() 会覆盖第一次的 waiter，第一次必然超时并把
 * 已经拉起的新进程作废——新进程变成无人管理的孤儿。现在的做法：
 *   - 所有生命周期操作（start / stop / restart）进同一条串行队列 lifecycle，
 *     任何时刻只有一个在执行，不存在交错
 *   - 每一代进程有自己的 GenerationState（exited Promise + 是否已结束），
 *     stop() 只等待、只作废它当初拿到的那一代
 *   - shutdown() 之后 start() 一律拒绝，防止退出过程中被重启拉起孤儿
 *
 * 防串台：每次 spawn 递增 generation，旧进程迟到的 message/exit 事件一律忽略。
 */
import { ERROR_CODES, errEnvelope, isEnvelope, type Envelope } from "../../shared/envelope.ts";
import {
  isHostOutboundMessage,
  type HostRequestMessage,
  type HostState,
  type HostStatus,
} from "../../shared/ipc.ts";

/** 被拉起的后端进程句柄的最小形状（对齐 Electron UtilityProcess 的子集） */
export interface HostProcessHandle {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): boolean;
}

export type SpawnHost = () => HostProcessHandle;

export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface HostClientOptions {
  spawn: SpawnHost;
  /** 单个请求的超时，默认 30s */
  requestTimeoutMs?: number;
  /** stop() 等待进程退出的最长时间，超时后强制视为已停止，默认 5s */
  stopTimeoutMs?: number;
  now?: () => number;
  timers?: TimerApi;
  log?: (message: string) => void;
  /**
   * stop 超时后对仍未退出的进程补一刀（真实环境传 process.kill(pid, "SIGKILL")）。
   * 不传则只在逻辑上作废该进程并记日志。
   */
  forceKill?: (pid: number) => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingRequest {
  channel: string;
  resolve: (envelope: Envelope<unknown>) => void;
  timer: unknown;
}

/** 某一代进程的运行态：只属于这一代，不会被后续代次覆盖 */
interface GenerationState {
  readonly id: number;
  readonly child: HostProcessHandle;
  /** 这一代是否已经结束（真实退出或被超时作废） */
  ended: boolean;
  /** 这一代是否处于主动停止中（决定退出后标 stopped 还是 crashed） */
  stopping: boolean;
  /** 这一代结束时 resolve */
  readonly exited: Promise<void>;
  readonly markExited: () => void;
}

type StatusListener = (status: HostStatus) => void;
type EventListener = (channel: string, payload: unknown) => void;

export class HostClient {
  private readonly spawnHost: SpawnHost;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly now: () => number;
  private readonly timers: TimerApi;
  private readonly log: (message: string) => void;
  private readonly forceKill: ((pid: number) => void) | null;

  /** 当前这一代；null 表示没有进程 */
  private current: GenerationState | null = null;
  private generationCounter = 0;
  /** 进入关闭流程后不再允许拉起新进程 */
  private shuttingDown = false;
  /** 生命周期操作串行队列 */
  private lifecycle: Promise<unknown> = Promise.resolve();

  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  /** 单调递增的状态序号，渲染层据此去重（不依赖墙钟，时钟回拨也不受影响） */
  private seq = 0;
  private status: HostStatus;
  private readonly statusListeners = new Set<StatusListener>();
  private readonly eventListeners = new Set<EventListener>();

  constructor(options: HostClientOptions) {
    this.spawnHost = options.spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? (() => {});
    this.forceKill = options.forceKill ?? null;
    this.status = { state: "stopped", pid: null, since: this.now(), seq: 0, detail: null };
  }

  // ==================== 状态 ====================

  getStatus(): HostStatus {
    return { ...this.status };
  }

  /** 订阅状态变化，返回取消订阅函数 */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 订阅后端进程主动推送的事件（为任务进度预留） */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private setStatus(state: HostState, pid: number | null, detail: string | null = null): void {
    this.seq += 1;
    this.status = { state, pid, since: this.now(), seq: this.seq, detail };
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log(`状态订阅者抛错: ${errorText(error)}`);
      }
    }
  }

  // ==================== 生命周期（全部串行） ====================

  /** 把一个生命周期操作排进串行队列；前一个失败不影响后一个 */
  private enqueue<T>(op: () => Promise<T> | T): Promise<T> {
    const run = this.lifecycle.then(op, op);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  /** 拉起后端进程。已在运行（starting/ready）时不重复拉起；关闭流程中拒绝 */
  start(): Promise<HostStatus> {
    return this.enqueue(() => this.startNow());
  }

  /** 停止后端进程；等待其退出（最长 stopTimeoutMs），状态最终为 stopped */
  stop(): Promise<void> {
    return this.enqueue(() => this.stopNow());
  }

  /** 重启：先停再起；状态依次为 stopped → starting →（收到 ready 后）ready */
  restart(): Promise<HostStatus> {
    return this.enqueue(async () => {
      await this.stopNow();
      return this.startNow();
    });
  }

  /**
   * 进入关闭流程：此后 start/restart 都不再拉起进程，然后停掉当前进程。
   * 应用退出（before-quit）时调用，防止退出过程中被「重启」拉起孤儿进程。
   */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.stop();
  }

  private startNow(): HostStatus {
    if (this.shuttingDown) {
      this.log("应用正在退出，忽略拉起后端进程的请求");
      return this.getStatus();
    }
    const cur = this.current;
    if (cur && !cur.ended && (this.status.state === "starting" || this.status.state === "ready")) {
      return this.getStatus();
    }

    const id = ++this.generationCounter;

    let child: HostProcessHandle;
    try {
      child = this.spawnHost();
    } catch (error) {
      const detail = `拉起后端进程失败: ${errorText(error)}`;
      this.log(detail);
      this.current = null;
      this.setStatus("crashed", null, detail);
      return this.getStatus();
    }

    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const gen: GenerationState = { id, child, ended: false, stopping: false, exited, markExited };
    this.current = gen;
    this.setStatus("starting", child.pid ?? null);

    child.onMessage((message) => {
      if (this.current !== gen || gen.ended) return;
      this.handleMessage(gen, message);
    });
    child.onExit((code) => {
      if (gen.ended) return;
      this.endGeneration(gen, gen.stopping ? "stopped" : "crashed", gen.stopping ? null : `退出码 ${code}`);
      if (!gen.stopping) this.log(`后端进程意外退出，退出码 ${code}`);
    });

    return this.getStatus();
  }

  private async stopNow(): Promise<void> {
    const gen = this.current;
    if (!gen || gen.ended) {
      if (this.status.state !== "stopped") this.setStatus("stopped", null);
      return;
    }

    gen.stopping = true;
    try {
      gen.child.kill();
    } catch (error) {
      this.log(`结束后端进程失败: ${errorText(error)}`);
    }

    let timer: unknown = null;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = this.timers.set(() => resolve("timeout"), this.stopTimeoutMs);
    });
    const outcome = await Promise.race([gen.exited.then(() => "exited" as const), timedOut]);
    this.timers.clear(timer);

    // 只处理「这一代」：若它已结束（exit 恰好先到），这里什么都不做
    if (outcome === "timeout" && !gen.ended) {
      const pid = gen.child.pid;
      this.log(`后端进程未在 ${this.stopTimeoutMs}ms 内退出，强制视为已停止${pid ? `（pid ${pid}）` : ""}`);
      if (pid && this.forceKill) {
        try {
          this.forceKill(pid);
        } catch (error) {
          this.log(`强制结束 pid ${pid} 失败: ${errorText(error)}`);
        }
      }
      this.endGeneration(gen, "stopped", null);
    }
  }

  /**
   * 结束某一代：标记已结束、让它名下的待回复请求失败、更新状态、唤醒等待者。
   * 若它已不是当前代（理论上不会发生，因为生命周期已串行），只唤醒不改状态。
   */
  private endGeneration(gen: GenerationState, state: HostState, detail: string | null): void {
    if (gen.ended) return;
    gen.ended = true;

    if (this.current === gen) {
      this.current = null;
      this.failAllPending();
      this.setStatus(state, null, detail);
    }
    gen.markExited();
  }

  private failAllPending(): void {
    const failed = [...this.pending.values()];
    this.pending.clear();
    for (const p of failed) {
      this.timers.clear(p.timer);
      p.resolve(errEnvelope(ERROR_CODES.HOST_UNAVAILABLE, `后端进程已退出，请求未完成: ${p.channel}`));
    }
  }

  // ==================== 请求 ====================

  /**
   * 发请求给后端进程。永不抛出：失败一律折算成信封。
   *   - 进程未就绪：HOST_UNAVAILABLE
   *   - 超时：TIMEOUT
   *   - 进程中途退出：HOST_UNAVAILABLE
   */
  request(channel: string, args: unknown[] = []): Promise<Envelope<unknown>> {
    const gen = this.current;
    if (!gen || gen.ended || gen.stopping || this.status.state !== "ready") {
      return Promise.resolve(
        errEnvelope(ERROR_CODES.HOST_UNAVAILABLE, `后端进程未就绪（当前状态: ${this.status.state}）`),
      );
    }

    const id = this.nextId++;
    return new Promise<Envelope<unknown>>((resolve) => {
      const timer = this.timers.set(() => {
        if (!this.pending.delete(id)) return;
        resolve(errEnvelope(ERROR_CODES.TIMEOUT, `后端请求超时（${this.requestTimeoutMs}ms）: ${channel}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { channel, resolve, timer });

      const message: HostRequestMessage = { type: "request", id, channel, args };
      try {
        gen.child.postMessage(message);
      } catch (error) {
        this.timers.clear(timer);
        this.pending.delete(id);
        resolve(errEnvelope(ERROR_CODES.HOST_UNAVAILABLE, `发送到后端进程失败: ${errorText(error)}`));
      }
    });
  }

  // ==================== 内部 ====================

  private handleMessage(gen: GenerationState, message: unknown): void {
    if (!isHostOutboundMessage(message)) {
      this.log(`忽略后端进程发来的无法识别的消息: ${safeJson(message)}`);
      return;
    }

    switch (message.type) {
      case "ready":
        // 停止过程中迟到的 ready 不能把状态改回 ready（否则会放行注定失败的请求）
        if (gen.stopping) return;
        this.setStatus("ready", message.pid);
        return;

      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) return; // 已超时或重复响应
        this.pending.delete(message.id);
        this.timers.clear(pending.timer);
        pending.resolve(
          isEnvelope(message.envelope)
            ? message.envelope
            : errEnvelope(ERROR_CODES.INTERNAL, `后端返回了非法信封: ${pending.channel}`),
        );
        return;
      }

      case "event":
        for (const listener of this.eventListeners) {
          try {
            listener(message.channel, message.payload);
          } catch (error) {
            this.log(`事件订阅者抛错: ${errorText(error)}`);
          }
        }
        return;
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
