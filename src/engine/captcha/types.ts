/**
 * 人机验证（reCAPTCHA）打码模块的公共类型。
 *
 * 背景与实证见 `.trellis/tasks/09-26-captcha-capsolver-integration/`（design §3/§4/§5、
 * research/real-machine-recaptcha.md）。本模块在 engine 层，只操作页面与 CDP，不认识宿主配置、
 * 不写数据库、不碰窗口备注。
 */

/**
 * 注入式 fetch：只要求「发请求 + 读文本响应」，真实 `fetch` 满足（单测注入假实现，零真实网络）。
 *
 * 注：`Response` 还带 `arrayBuffer()`，求解器下载原始图时用它读二进制；本类型只约束最小值，
 * 不额外声明可选项，保持与真机脚本一致的调用形态。
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** 求解器需要的配置（由 `captcha/config.ts` 的 `resolveCaptchaConfig()` 产出） */
export interface CaptchaConfig {
  provider: string;
  apiKey: string;
  enabled: boolean;
  /** 单次登录最多几轮图片挑战 */
  maxRounds: number;
  /** 单次 CapSolver 请求超时（毫秒） */
  timeoutMs: number;
}

/** 逐轮日志（进任务日志）；**绝不允许出现密钥、邮箱、密码、token** */
export type CaptchaLogger = (message: string) => void;

/** 求解失败原因（供登录流程细分 error_type，design §6.3） */
export type CaptchaFailureReason =
  | "disabled" // 配置关闭
  | "no_api_key" // 未配置密钥
  | "no_endpoint" // 拿不到 CDP 端点 / 没有 page 目标
  | "cdp_failed" // 连接或 CDP 命令失败
  | "no_challenge" // 页面上没有 checkbox / 图片挑战
  | "no_raw_image" // 未取到原始图 —— 不调打码
  | "unsupported_object" // 挑战对象不在 kg 支持列表 —— 不调打码
  | "api_error" // CapSolver 报错 / 网络失败 / 超时
  | "round_limit" // 打满轮次仍未通过
  | "not_passed"; // 最后一轮打码完成但页面仍在验证码页

/** 求解结果：ok 只表示「已离开验证码页或拿到 token」，调用方仍须用 detectStage / myaccount 终检复核 */
export type CaptchaSolveResult =
  | { ok: true; rounds: number; costMs: number }
  | { ok: false; reason: CaptchaFailureReason; detail?: string; rounds: number };
