/**
 * 列表状态色调（全部列表共用，纯函数、不碰 DOM）
 *
 * 各列表把自己的状态映射成统一色调，色调决定：
 * - 行首 3px 状态条（`rowClassName={(r) => railClass(tone)}`，样式在 theme/app.css）；
 * - 状态列圆点与文字的颜色（components/StatusDot.tsx）。
 * none = 没有值得提示的状态：不画状态条，圆点用 idle 灰。
 */

export type ListTone = "ok" | "warn" | "bad" | "busy" | "none";

export const RAIL_CLASS: Readonly<Record<ListTone, string>> = {
  ok: "abb-rail-ok",
  warn: "abb-rail-warn",
  bad: "abb-rail-bad",
  busy: "abb-rail-busy",
  none: "",
};

export function railClass(tone: ListTone): string {
  return RAIL_CLASS[tone];
}

/** 账号登录状态（accounts.login_status） */
export function accountLoginTone(status: string | null): ListTone {
  if (status === "logged_in") return "ok";
  if (status === "logging_in") return "busy";
  if (status === "login_failed") return "bad";
  return "none";
}

/** AI 任务本次运行的条目状态（没跑过为 undefined / 空） */
export function aiItemTone(status: string | undefined): ListTone {
  if (!status) return "none";
  if (status === "成功") return "ok";
  if (status === "失败" || status === "错误") return "bad";
  if (status === "处理中") return "busy";
  return "warn";
}

/** 导入 TOTP 的匹配结果 */
export function totpTone(status: "can_import" | "has_secret" | "no_match"): ListTone {
  if (status === "can_import") return "ok";
  if (status === "has_secret") return "warn";
  return "none";
}

/** 任务历史：一次运行的结果（null = 还没结束） */
export function runOutcomeTone(outcome: string | null): ListTone {
  if (outcome === null || outcome === "") return "none";
  if (outcome === "succeeded") return "ok";
  if (outcome === "stopped") return "warn";
  return "bad";
}

/** 任务历史：逐条目状态（「跳过」等中间状态不提示） */
export function historyItemTone(status: string | null): ListTone {
  if (status === "成功") return "ok";
  if (status === "失败" || status === "错误") return "bad";
  if (status === "处理中") return "busy";
  return "none";
}

/** 代理连通性检测结果（null = 还没测过） */
export function proxyCheckTone(ok: boolean | null): ListTone {
  if (ok === null) return "none";
  return ok ? "ok" : "bad";
}
