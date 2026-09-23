/**
 * IPC 信封 —— 三端共用（主进程 / 后端进程 / 渲染进程）
 *
 * 对标 PI-Desktop 的做法：所有跨进程结果统一包成
 *   { ok: true,  data }                       成功
 *   { ok: false, error: { code, message } }   失败
 * 这样异常永远不会穿透 IPC 边界（Electron 默认会把 handler 抛出的异常
 * 序列化成一条丢失 code 的字符串，渲染层无法区分错误种类）。
 *
 * 本文件是纯 TS，不依赖 electron，可被 node --test 直接导入。
 */

/** 约定的错误码。新增错误种类时在这里登记，渲染层据此分支 */
export const ERROR_CODES = {
  /** 后端进程未启动、正在重启或已崩溃 */
  HOST_UNAVAILABLE: "HOST_UNAVAILABLE",
  /** 请求在规定时间内没有收到回复 */
  TIMEOUT: "TIMEOUT",
  /** 通道不在白名单 / 分发表中 */
  UNKNOWN_CHANNEL: "UNKNOWN_CHANNEL",
  /** handler 抛出了未分类的异常 */
  INTERNAL: "INTERNAL",
  /** 请求来源不可信（非本应用渲染层页面发起的 IPC） */
  FORBIDDEN: "FORBIDDEN",
  /** 已有任务在运行（全局单任务互斥，对标 check_task_conflicts） */
  TASK_BUSY: "TASK_BUSY",
  /** 参数不合法（校验失败） */
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES] | (string & {});

export interface EnvelopeError {
  code: ErrorCode;
  message: string;
}

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: EnvelopeError };

/** 带错误码的异常：handler 想返回特定 code 时抛它 */
export class CodedError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CodedError";
    this.code = code;
  }
}

export function okEnvelope<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function errEnvelope<T = never>(code: ErrorCode, message: string): Envelope<T> {
  return { ok: false, error: { code, message } };
}

/**
 * 把任意抛出值折算成 EnvelopeError：
 *   - 带字符串 code 属性的对象（CodedError 或 Node 的系统错误）保留其 code
 *   - 普通 Error 取 message，code 记为 INTERNAL
 *   - 非 Error 值（字符串、数字、对象）转成字符串
 */
export function toEnvelopeError(error: unknown): EnvelopeError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === "string" && code.length > 0 ? code : ERROR_CODES.INTERNAL,
      message: error.message,
    };
  }
  if (error !== null && typeof error === "object") {
    const o = error as { code?: unknown; message?: unknown };
    return {
      code: typeof o.code === "string" && o.code.length > 0 ? o.code : ERROR_CODES.INTERNAL,
      message: typeof o.message === "string" ? o.message : safeStringify(error),
    };
  }
  return { code: ERROR_CODES.INTERNAL, message: String(error) };
}

/** 执行 fn 并把结果或异常包成信封，永不抛出 */
export async function wrap<T>(fn: () => T | Promise<T>): Promise<Envelope<T>> {
  try {
    return okEnvelope(await fn());
  } catch (error) {
    return { ok: false, error: toEnvelopeError(error) };
  }
}

/** 判断一个未知值是否是信封（用于校验跨进程收到的消息） */
export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (value === null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o["ok"] === true) return "data" in o;
  if (o["ok"] === false) {
    const e = o["error"] as Record<string, unknown> | undefined;
    return !!e && typeof e["code"] === "string" && typeof e["message"] === "string";
  }
  return false;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
