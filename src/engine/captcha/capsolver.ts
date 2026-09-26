/**
 * CapSolver 打码客户端（ReCaptchaV2Classification）。
 *
 * 契约全部来自真机实证（.trellis/tasks/09-26-captcha-capsolver-integration/research/real-machine-recaptcha.md §3）：
 *   POST https://api.capsolver.com/createTask
 *   { clientKey, task: { type: "ReCaptchaV2Classification", image: "<原始JPEG base64>", question: "<kg ID>" } }
 *   → { errorId: 0, status: "ready", solution: { objects: [0-based 格子索引], size, type: "multi" } }
 *
 * 坑（都踩过，不要改回去）：
 *   - 字段名是 `image`（单数）。`imageBody` / `images: [...]` 实测全部报 `ERROR_INVALID_TASK_DATA`。
 *   - `question` 必须是知识图谱 ID；写自然语言报 `ERROR_UNSUPPORTED_QUESTION`。
 *   - `solution.objects` 是 0-based。
 *   - 必须用原始图（payload 的 30–50KB JPEG），屏幕截图识别不出（`{hasObject:false,size:0}`）。
 *
 * 打码平台只回「哪些格子」；token 由我们自己的浏览器环境生成，不存在 token 与环境不匹配的问题。
 * 密钥只出现在请求体里，绝不进返回值 / 日志 / detail。
 */

import { DEFAULT_CAPTCHA_TIMEOUT_SECONDS, maskCaptchaKey } from "./config.ts";
import type { FetchLike } from "./types.ts";

/** CapSolver 同步打码接口（约 1s 返回，约 $0.0009/次） */
export const CAPSOLVER_CREATE_TASK_URL = "https://api.capsolver.com/createTask";

/** 任务类型：图片网格分类 */
export const CAPSOLVER_TASK_TYPE = "ReCaptchaV2Classification";

/** 支持的对象 → Google 知识图谱 ID（17 个） */
export const CAPSOLVER_KG_IDS: Readonly<Record<string, string>> = {
  taxis: "/m/0pg52",
  bus: "/m/01bjv",
  "school bus": "/m/02yvhj",
  motorcycles: "/m/04_sv",
  tractors: "/m/013xlm",
  chimneys: "/m/01jk_4",
  crosswalks: "/m/014xcs",
  "traffic lights": "/m/015qff",
  stairs: "/m/01lynh",
  bicycles: "/m/0199g",
  "parking meters": "/m/015qbp",
  cars: "/m/0k4j",
  bridges: "/m/015kr",
  boats: "/m/019jd",
  "palm trees": "/m/0cdl1",
  "mountains or hills": "/m/09d_r",
  "fire hydrant(s)": "/m/01pns0",
};

/** 词表条目：匹配关键词（小写）→ 展示名 + kg ID */
interface KgKeyword {
  keyword: string;
  label: string;
  id: string;
}

/**
 * 匹配关键词表（含单复数/同义写法）。**按关键词长度降序匹配**：
 * 「Select all images with school buses」里同时含 `bus`，按声明顺序会命中错的那个。
 */
const KG_KEYWORD_TABLE: readonly KgKeyword[] = [
  { keyword: "school buses", label: "school bus", id: "/m/02yvhj" },
  { keyword: "school bus", label: "school bus", id: "/m/02yvhj" },
  { keyword: "parking meters", label: "parking meters", id: "/m/015qbp" },
  { keyword: "parking meter", label: "parking meters", id: "/m/015qbp" },
  { keyword: "traffic lights", label: "traffic lights", id: "/m/015qff" },
  { keyword: "traffic light", label: "traffic lights", id: "/m/015qff" },
  { keyword: "mountains or hills", label: "mountains or hills", id: "/m/09d_r" },
  { keyword: "fire hydrants", label: "fire hydrant(s)", id: "/m/01pns0" },
  { keyword: "fire hydrant", label: "fire hydrant(s)", id: "/m/01pns0" },
  { keyword: "palm trees", label: "palm trees", id: "/m/0cdl1" },
  { keyword: "palm tree", label: "palm trees", id: "/m/0cdl1" },
  { keyword: "motorcycles", label: "motorcycles", id: "/m/04_sv" },
  { keyword: "motorcycle", label: "motorcycles", id: "/m/04_sv" },
  { keyword: "crosswalks", label: "crosswalks", id: "/m/014xcs" },
  { keyword: "crosswalk", label: "crosswalks", id: "/m/014xcs" },
  { keyword: "mountains", label: "mountains or hills", id: "/m/09d_r" },
  { keyword: "tractors", label: "tractors", id: "/m/013xlm" },
  { keyword: "tractor", label: "tractors", id: "/m/013xlm" },
  { keyword: "chimneys", label: "chimneys", id: "/m/01jk_4" },
  { keyword: "chimney", label: "chimneys", id: "/m/01jk_4" },
  { keyword: "staircase", label: "stairs", id: "/m/01lynh" },
  { keyword: "bicycles", label: "bicycles", id: "/m/0199g" },
  { keyword: "bicycle", label: "bicycles", id: "/m/0199g" },
  { keyword: "bridges", label: "bridges", id: "/m/015kr" },
  { keyword: "bridge", label: "bridges", id: "/m/015kr" },
  { keyword: "stairs", label: "stairs", id: "/m/01lynh" },
  { keyword: "taxis", label: "taxis", id: "/m/0pg52" },
  { keyword: "boats", label: "boats", id: "/m/019jd" },
  { keyword: "hills", label: "mountains or hills", id: "/m/09d_r" },
  { keyword: "hill", label: "mountains or hills", id: "/m/09d_r" },
  { keyword: "buses", label: "bus", id: "/m/01bjv" },
  { keyword: "taxi", label: "taxis", id: "/m/0pg52" },
  { keyword: "cars", label: "cars", id: "/m/0k4j" },
  { keyword: "car", label: "cars", id: "/m/0k4j" },
  { keyword: "boat", label: "boats", id: "/m/019jd" },
  { keyword: "bus", label: "bus", id: "/m/01bjv" },
];

/** 长度降序（Array#sort 稳定：等长关键词保持声明顺序） */
const KG_KEYWORDS: readonly KgKeyword[] = [...KG_KEYWORD_TABLE].sort((a, b) => b.keyword.length - a.keyword.length);

/** 取文本值（null/undefined → ""） */
function pickText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/** 截断（detail 限 200 字符，防止把整段响应塞进任务历史） */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** detail 里出现密钥就掩码（响应回显 clientKey 也不能泄漏） */
function safeDetail(text: string, apiKey: string): string {
  const masked = apiKey ? text.split(apiKey).join(maskCaptchaKey(apiKey)) : text;
  return truncate(masked, 200);
}

/** 错误文本（超时与普通错误分开，日志里看得懂） */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? `超时（${error.name}）` : error.message;
  }
  return String(error);
}

/**
 * 挑战文案 → 知识图谱问题。找不到受支持对象返回 null（调用方据此**不打码**）。
 *
 * `label` 只用于日志（例：`对象=bicycles(/m/0199g)`）。
 */
export function resolveQuestion(challengeText: string): { label: string; id: string } | null {
  const text = pickText(challengeText).toLowerCase();
  if (!text) return null;
  for (const entry of KG_KEYWORDS) {
    if (text.includes(entry.keyword)) return { label: entry.label, id: entry.id };
  }
  return null;
}

/** 组装 createTask 请求体（纯函数，单测断言字段名） */
export function buildCreateTaskBody(clientKey: string, imageBase64: string, questionId: string): Record<string, unknown> {
  return {
    clientKey,
    task: { type: CAPSOLVER_TASK_TYPE, image: imageBase64, question: questionId },
  };
}

/**
 * 解析 createTask 响应（纯函数）。
 * `objects` 只保留非负整数索引（小数 / 负数 / 字符串一律丢弃）；**原样保持 0-based**。
 */
export function parseCreateTaskResponse(json: unknown): { ok: true; objects: number[] } | { ok: false; detail: string } {
  if (typeof json !== "object" || json === null) {
    return { ok: false, detail: "响应不是 JSON 对象" };
  }
  const record = json as Record<string, unknown>;
  const errorId = record["errorId"];
  if (typeof errorId === "number" && errorId !== 0) {
    const code = pickText(record["errorCode"]).trim();
    const description = pickText(record["errorDescription"]).trim();
    return { ok: false, detail: truncate([code, description].filter(Boolean).join(": ") || `errorId=${errorId}`, 200) };
  }
  const solution = record["solution"];
  const objectsRaw =
    typeof solution === "object" && solution !== null ? (solution as Record<string, unknown>)["objects"] : undefined;
  if (!Array.isArray(objectsRaw)) {
    return { ok: false, detail: `solution.objects 缺失（errorId=${pickText(errorId) || "?"}）` };
  }
  const objects: number[] = [];
  for (const item of objectsRaw) {
    if (typeof item === "number" && Number.isInteger(item) && item >= 0) objects.push(item);
  }
  return { ok: true, objects };
}

export interface ClassifyImageOptions {
  apiKey: string;
  /** 原始图（payload JPEG）的 base64，**不是截图** */
  imageBase64: string;
  /** `resolveQuestion()` 产出的 kg ID */
  questionId: string;
  /** 注入式 fetch（单测零网络）；默认全局 fetch */
  fetchImpl?: FetchLike;
  /** 请求超时（毫秒），默认 20s */
  timeoutMs?: number;
}

/**
 * 调 CapSolver 识别图片网格。
 * 失败一律返回 `{ok:false, detail}`（detail ≤200 字符、已掩码密钥），不抛异常。
 */
export async function classifyImage(
  options: ClassifyImageOptions,
): Promise<{ ok: true; objects: number[] } | { ok: false; detail: string }> {
  const timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? DEFAULT_CAPTCHA_TIMEOUT_SECONDS * 1000));
  const doFetch: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const body = JSON.stringify(buildCreateTaskBody(options.apiKey, options.imageBase64, options.questionId));

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await doFetch(CAPSOLVER_CREATE_TASK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, detail: safeDetail(`请求失败: ${errorText(error)}`, options.apiKey) };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return { ok: false, detail: safeDetail(`读取响应失败: ${errorText(error)}`, options.apiKey) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      detail: safeDetail(`HTTP ${response.status} 响应不是 JSON: ${pickText(text).slice(0, 120)}`, options.apiKey),
    };
  }

  const result = parseCreateTaskResponse(parsed);
  if (!result.ok) return { ok: false, detail: safeDetail(result.detail, options.apiKey) };
  return result;
}
