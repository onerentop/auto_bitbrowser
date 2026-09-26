/**
 * 任务结果视图 —— 把任务结束事件翻成「一句话摘要 + 色调 + 明细行」。
 *
 * 为什么独立成模块：任务结束的呈现只允许出现在任务坞一处（设计见
 * `.trellis/tasks/09-26-ui-notifications/design.md`）。原先摘要分散在
 * `components/TaskDock.tsx`（逐字段 dump + 弹窗）与 `pages/accounts/finished-notice.ts`
 * （只有删除 / 巡检两种类型）两处，本模块是唯一实现。
 *
 * 纯函数：不 import antd、不碰 DOM，可被 node:test 直接导入（先例：test/list-tone.test.mjs）。
 */
import type { TaskFinishedEvent } from "../../../shared/ipc.ts";
import { DELETE_ACCOUNTS_ONLY_LABEL } from "../../../shared/channels/accounts.ts";

export interface TaskResultView {
  /** 结论 + 一句人话摘要（任务名由调用方另行展示） */
  summary: string;
  /** 结果行色调，对应令牌 ok / warn / bad（none = 用 muted） */
  tone: "ok" | "warn" | "bad" | "none";
  /** 明细行（字段名已中文化），渲染在任务日志抽屉里 */
  details: Array<[string, string]>;
}

/** 任务结论的中文 —— 任务坞结果行与任务抽屉共用这一份，不各写一份 */
export const OUTCOME_TEXT: Record<TaskFinishedEvent["outcome"], string> = {
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/** 常见结果字段的中文名；未列出的字段原样显示键名 */
const RESULT_LABELS: Record<string, string> = {
  total: "总数",
  total_count: "总数",
  success_count: "成功",
  failed_count: "失败",
  fail_count: "失败",
  failed_ids: "失败窗口",
  failed_list: "失败列表",
  warning_list: "警告",
  skipped_count: "跳过",
  results: "明细",
  deleted_accounts: "已删除账号",
  deleted_windows: "已删除窗口",
  password_count: "写入密码",
  bind_count: "绑定窗口",
  ix_update_count: "写入窗口 2FA 密钥",
  success_rate: "成功率",
  duration_seconds: "耗时（秒）",
  message: "说明",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 取一个计数字段；**键不存在时返回 null 而不是 0** —— 「没这个字段」与「计数为 0」必须能区分 */
function countOf(r: Record<string, unknown>, key: string): number | null {
  const v = r[key];
  return typeof v === "number" ? v : null;
}

/** 数组字段的长度（非数组按 0 计），用于「失败了几个」这类判断 */
function len(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  return Array.isArray(v) ? v.length : 0;
}

/** 内部标识，不进明细：结论与任务名已经在结果行里说过了 */
const DETAIL_OMIT = new Set(["type", "task_type"]);

/**
 * 结果对象展开成可读字段：
 * 账号类任务返回 `{ type, result: {...} }`，要展开内层统计；列表字段只显示条数。
 */
function summarize(result: unknown): Array<[string, string]> {
  if (!isPlainObject(result)) {
    return result === null || result === undefined ? [] : [["结果", JSON.stringify(result)]];
  }
  const flat = typeof result["type"] === "string" && isPlainObject(result["result"]) ? result["result"] : result;
  return Object.entries(flat)
    .filter(([k]) => !DETAIL_OMIT.has(k))
    .map(([k, v]) => {
      const label = RESULT_LABELS[k] ?? k;
      if (Array.isArray(v)) return [label, `${v.length} 项`];
      if (v !== null && typeof v === "object") return [label, JSON.stringify(v)];
      return [label, String(v)];
    });
}

/** 结果里有失败计数的类型（决定成功时是用 ok 还是 warn） */
function failureCount(r: Record<string, unknown>): number {
  return Math.max(
    countOf(r, "failed_count") ?? 0,
    countOf(r, "fail_count") ?? 0,
    len(r, "failed_list"),
    len(r, "failed_ids"),
  );
}

/** 结果里的说明文本（停止任务返回的骨架把原因放在 message 里） */
function messageOf(r: Record<string, unknown>): string {
  const v = r["message"];
  return typeof v === "string" ? v.trim() : "";
}

/** 「标签 数字」；该计数不存在时返回 null，绝不编造 0 */
function countPart(r: Record<string, unknown>, key: string, label: string): string | null {
  const n = countOf(r, key);
  return n === null ? null : `${label} ${n}`;
}

/**
 * 按任务类型给一句人话摘要。
 *
 * 规则：**只写真实存在的计数**。字段缺失时返回空串，由调用方退回 message 或只留结论 ——
 * 否则「这个结果里没有这个字段」会被印成「0」，是假数据（停止任务的骨架就是这样）。
 */
function describe(type: string, label: string, r: Record<string, unknown>): string {
  switch (type) {
    case "batch_delete": {
      const accounts = countOf(r, "deleted_accounts");
      if (accounts === null) return "";
      const windows = countOf(r, "deleted_windows");
      if (label === DELETE_ACCOUNTS_ONLY_LABEL || windows === null) return `已删除 ${accounts} 个账号`;
      return `已删除 ${accounts} 个账号、${windows} 个窗口`;
    }

    case "health_check":
      return [
        countPart(r, "ok", "正常"),
        countPart(r, "need_login", "需登录"),
        countPart(r, "suspended", "已停用"),
        countPart(r, "window_error", "窗口异常"),
      ]
        .filter((s): s is string => s !== null)
        .join(" · ");

    case "login":
      return [
        countPart(r, "success_count", "成功"),
        countPart(r, "failed_count", "失败"),
        countPart(r, "skipped_count", "跳过"),
      ]
        .filter((s): s is string => s !== null)
        .join(" · ");

    default: {
      // 其余类型（批量打开 / 删除窗口、按模板创建、导入 TOTP、AI 任务…）用通用计数
      const parts = [
        countPart(r, "success_count", "成功"),
        countPart(r, "failed_count", "失败"),
      ].filter((s): s is string => s !== null);
      if (parts.length === 0) {
        const total = countPart(r, "total", "共");
        if (total !== null) parts.push(`${total} 项`);
      }
      return parts.join(" · ");
    }
  }
}

export function taskResultView(
  e: Pick<TaskFinishedEvent, "type" | "label" | "outcome" | "result" | "error">,
): TaskResultView {
  const conclusion = OUTCOME_TEXT[e.outcome];
  const raw = isPlainObject(e.result) ? e.result : {};
  const flat = typeof raw["type"] === "string" && isPlainObject(raw["result"]) ? raw["result"] : raw;

  // 失败优先说原因：计数再多也不如错误本身有用。
  // 类型化摘要取不到计数时退回结果里的 message —— 停止任务返回的是骨架
  // `{ type: "stopped", task_type, message }`，**没有计数字段**；
  // 若照 0 兜底就会在同一行里谎报「成功 0」，而这次运行其实成功过若干账号。
  const sentence =
    e.outcome === "failed" && e.error
      ? e.error
      : describe(e.type, e.label, flat) || messageOf(flat);
  const summary = sentence ? `${conclusion} · ${sentence}` : conclusion;

  const tone: TaskResultView["tone"] =
    e.outcome === "failed"
      ? "bad"
      : e.outcome === "stopped"
        ? "none"
        : failureCount(flat) > 0
          ? "warn"
          : "ok";

  return { summary, tone, details: summarize(e.result) };
}
