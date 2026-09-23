/**
 * 后台任务运行器 —— 运行在后端进程，纯逻辑、不依赖 electron
 *
 * 对标 Python GUI 里的 QThread / threading.Thread + stop_flag：
 *   - **全局单任务互斥**：同一时间只允许一个任务（对标 account_manager_service.check_task_conflicts），
 *     重复启动抛 CodedError(TASK_BUSY)
 *   - start() 立即返回 TaskInfo，任务在后台跑；日志 / 进度 / 结束通过 emit 推给主进程，
 *     再由主进程转给渲染层（IPC 请求有 30s 超时，长任务不能同步等）
 *   - stop() 协作式：置标志并触发 onStop 钩子（编排层在钩子里调 processor.stop()）
 *
 * 结束状态：
 *   - 任务函数抛错            → failed
 *   - 期间请求过停止          → stopped（Python 返回 {type:"stopped", task_type}）
 *   - 否则                    → succeeded
 */
import { CodedError, ERROR_CODES } from "../shared/envelope.ts";
import {
  IPC,
  type EventChannel,
  type EventPayload,
  type TaskFinishedEvent,
  type TaskInfo,
  type TaskOutcome,
} from "../shared/ipc.ts";

export type TaskEmit = <C extends EventChannel>(channel: C, payload: EventPayload<C>) => void;

/** 交给任务函数的操作面 */
export interface TaskApi {
  readonly taskId: number;
  log(message: string): void;
  progress(current: number, total: number): void;
  /** 是否已请求停止（对标 Python 的 should_stop()） */
  shouldStop(): boolean;
  /** 注册停止钩子；已请求停止时立即执行 */
  onStop(fn: () => void): void;
}

export type TaskFn = (api: TaskApi) => Promise<unknown>;

export interface TaskRunnerOptions {
  emit: TaskEmit;
  now?: () => number;
  /** 结束后的回调（测试用来等待任务完成） */
  onFinished?: (event: TaskFinishedEvent) => void;
}

interface RunningTask {
  info: TaskInfo;
  stopHooks: Array<() => void>;
}

export class TaskRunner {
  private readonly emit: TaskEmit;
  private readonly now: () => number;
  private readonly onFinished: ((event: TaskFinishedEvent) => void) | null;
  private running: RunningTask | null = null;
  private nextId = 1;

  constructor(options: TaskRunnerOptions) {
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.onFinished = options.onFinished ?? null;
  }

  /** 当前任务快照（无则 null） */
  current(): TaskInfo | null {
    return this.running ? { ...this.running.info } : null;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** 启动任务；已有任务在跑时抛 TASK_BUSY */
  start(type: string, label: string, fn: TaskFn): TaskInfo {
    if (this.running) {
      const r = this.running.info;
      throw new CodedError(ERROR_CODES.TASK_BUSY, `已有任务正在运行：${r.label}，请等待完成或先停止`);
    }
    const info: TaskInfo = {
      id: this.nextId++,
      type,
      label,
      startedAt: this.now(),
      stopRequested: false,
      current: 0,
      total: 0,
    };
    const task: RunningTask = { info, stopHooks: [] };
    this.running = task;

    const api: TaskApi = {
      taskId: info.id,
      log: (message) => {
        if (this.running !== task) return;
        this.emit(IPC.event.taskLog, { taskId: info.id, type, message, at: this.now() });
      },
      progress: (current, total) => {
        if (this.running !== task) return;
        info.current = current;
        info.total = total;
        this.emit(IPC.event.taskProgress, { taskId: info.id, type, current, total });
      },
      shouldStop: () => info.stopRequested,
      onStop: (hook) => {
        if (info.stopRequested) {
          safeCall(hook);
          return;
        }
        task.stopHooks.push(hook);
      },
    };

    // 放到微任务之后执行：保证调用方先拿到返回值，再收到第一条日志
    void Promise.resolve()
      .then(() => fn(api))
      .then(
        (result) => this.finish(task, info.stopRequested ? "stopped" : "succeeded", result, null),
        (error: unknown) =>
          this.finish(task, "failed", null, error instanceof Error ? error.message : String(error)),
      );

    return { ...info };
  }

  /** 请求停止当前任务；没有任务时返回 false */
  stop(): boolean {
    const task = this.running;
    if (!task) return false;
    if (!task.info.stopRequested) {
      task.info.stopRequested = true;
      this.emit(IPC.event.taskLog, {
        taskId: task.info.id,
        type: task.info.type,
        message: "正在停止任务...",
        at: this.now(),
      });
      for (const hook of task.stopHooks) safeCall(hook);
    }
    return true;
  }

  private finish(task: RunningTask, outcome: TaskOutcome, result: unknown, error: string | null): void {
    if (this.running !== task) return;
    this.running = null;
    const event: TaskFinishedEvent = {
      taskId: task.info.id,
      type: task.info.type,
      label: task.info.label,
      outcome,
      result: toCloneable(result),
      error,
      startedAt: task.info.startedAt,
      finishedAt: this.now(),
    };
    this.emit(IPC.event.taskFinished, event);
    this.onFinished?.(event);
  }
}

function safeCall(fn: () => void): void {
  try {
    fn();
  } catch {
    // 停止钩子出错不应影响停止流程本身
  }
}

/**
 * 结果要经 postMessage 跨两次进程边界：先 JSON 往返一次，
 * 去掉函数 / 类实例 / undefined，保证可结构化克隆。
 */
export function toCloneable(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

// ==================== 进度解析（照搬 Python） ====================

/** 对标 account_task_orchestrator.py:417 的关键词列表 */
export const PROGRESS_KEYWORDS: readonly string[] = ["✓", "✗", "成功", "失败", "跳过", "完成:"];

/**
 * 从日志文本推算进度 —— 逐字对标 account_task_orchestrator.py:417-424：
 *   命中任一关键词时：有 `[i/n]` 取 i；否则完成数 +1（不超过 total）
 * 注意 Python 用的是 total（任务账号数），而不是日志里的 n。
 */
export function createLogProgressTracker(
  total: number,
  onProgress: (current: number, total: number) => void,
): (message: string) => void {
  let completed = 0;
  return (message) => {
    if (!PROGRESS_KEYWORDS.some((k) => message.includes(k))) return;
    const match = /\[(\d+)\/(\d+)\]/.exec(message);
    if (match) {
      onProgress(Number(match[1]), total);
    } else {
      completed += 1;
      onProgress(Math.min(completed, total), total);
    }
  };
}
