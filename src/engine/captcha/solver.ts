/**
 * reCAPTCHA 求解器：点 checkbox → （必要时）用 CapSolver 打图片挑战 → 点格子 + Verify → 复核页面。
 *
 * 流程与坐标换算照抄真机跑通的脚本
 * （.trellis/tasks/09-26-captcha-capsolver-integration/research/real-machine-recaptcha.md §2、§6）：
 *   1. Page.bringToFront（后台标签页不渲染，checkbox 停在 0×0）
 *   2. 真机鼠标点 checkbox —— 主文档里 anchor iframe 左边缘 +26px、垂直居中
 *   3. 等「弹层可见」的图片挑战（bframe `visibility` 不是 hidden、h > 200、有 .rc-imageselect-tile）；
 *      checkbox 单独通过时页面直接离开 /challenge/recaptcha（0 成本，打码零调用）
 *   4. 在 bframe session 内读挑战文案 + 每个格子（坐标 / 图片 src / 裁切类型 / 选中态）
 *   5. `-33/-44` 格子共用一张原始图（300×300 / 450×450 JPEG，**不能用截图**）→ CapSolver multi → 0-based 索引；
 *      `-11` 格子是动态题换上来的 100×100 单图 → 逐张 CapSolver single → hasObject
 *   6. 点格子中心（页坐标 = bframe 在主文档的偏移 + 格子在本 iframe 内的偏移 + 半宽/半高）
 *   7. 动态题（点过的格子会淡出并换成新图）：等新图出现 → 逐张 single 识别 → 命中再点，直到没有
 *   8. 从 bframe session 内读 #recaptcha-verify-button 位置并点击，等 Google 给出结论：
 *      通过 / 下一页（4×4 连续多页，文案 NEXT）/ 答错（出现错误提示）/ 弹层收起
 *   9. 答错或弹层收起算一轮；轮次上限 `config.maxRounds`，每轮页数与总打码次数另有硬上限
 *
 * 硬性约束：
 *   - 拿不到原始图 / 挑战对象不在词表（换题后仍不在）→ **绝对不调打码 API**，直接返回对应失败原因；
 *   - 弹层隐藏（真机 y = -9999、visibility:hidden）时 DOM 里残留的旧格子**不算**图片挑战 —— 重新点 checkbox；
 *   - `objects` 是 0-based，越界索引丢弃；空数组不点格子但仍点 Verify（「一张都没有」是合法答案）；
 *   - 中途 `api_error` 立即返回，不空烧剩余轮次；
 *   - 日志只含轮次 / 对象 / 索引 / 字节数 / 耗时 —— **绝不出现密钥、邮箱、密码、token**；
 *   - 成功判据只有「离开验证码页或拿到 token」，调用方仍须走既有的 myaccount 终检。
 */

import { classifyImage, classifyTile, resolveQuestion } from "./capsolver.ts";
import type { CdpPort } from "./cdp.ts";
import type { CaptchaConfig, CaptchaFailureReason, CaptchaLogger, CaptchaSolveResult, FetchLike } from "./types.ts";

// ==================== 真机表达式（照抄，见 research §2 / §6） ====================

/** 主文档：anchor iframe（checkbox 所在）位置 + 当前 path */
export const ANCHOR_EXPR = `(() => {
  const a = [...document.querySelectorAll('iframe')].find(f => String(f.src||'').includes('recaptcha/enterprise/anchor'));
  const r = a ? a.getBoundingClientRect() : null;
  return { path: location.pathname, anchor: r && r.width > 10 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null };
})()`;

/**
 * 主文档：bframe iframe 的位置 + 是否可见（坐标换算基准；`h > 200` = 出现图片挑战）。
 *
 * 真机实测（2026-09-26）：弹层收起时 bframe 的祖先容器是 `visibility:hidden; top:-10000px`，
 * iframe 停在 y = -9999，而里面的格子 DOM **还在**（上一道题的残留）。只看 `h` 会把它当成
 * 进行中的挑战，点击全部落空。`visibility` 会继承，读 iframe 自己的计算样式即可。
 */
export const BFRAME_RECT_EXPR = `(() => {
  const f = [...document.querySelectorAll('iframe')].find(x => String(x.src||'').includes('recaptcha/enterprise/bframe'));
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: getComputedStyle(f).visibility !== 'hidden' };
})()`;

/** 某个 session 里有没有图片网格（判定「哪个 session 是 bframe」只能靠探 DOM，不能靠 URL） */
export const TILE_PROBE_EXPR = "document.querySelectorAll('.rc-imageselect-tile').length";

/**
 * bframe session 内：挑战文案 + 原始图 URL + 每个格子的坐标 / 图片 / 状态 + 当前显示的错误提示。
 *
 * - `cls`：`rc-image-tile-33` / `-44` 是整张原图的切片（共用一个 src）；`rc-image-tile-11` 是动态题
 *   换上来的 100×100 单图（各自独立 src）。**原图只能取自非 `-11` 的格子** —— 真机实测：动态题答到一半时
 *   第 0 格可能已经是新图，取第 0 格当原图送 multi 只会拿到 single 形态的响应。
 * - `sel`：静态题里已选中（再点会取消选中）；`dyn`：动态题里点过、正在淡出等新图。
 * - `errors`：可见的错误提示类名（`rc-imageselect-incorrect-response`「Please try again」、
 *   `rc-imageselect-error-dynamic-more`「Please also check the new images」等）= Google 判答错。
 */
export const CHALLENGE_EXPR = `(() => {
  const t = (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').trim();
  const ins = document.querySelector('.rc-imageselect-instructions');
  const title = ins ? String(ins.innerText || '').replace(/\\s+/g,' ').trim() : t;
  const imgs = [...document.querySelectorAll('.rc-imageselect-tile img, img[src*="recaptcha/enterprise/payload"]')];
  const base = imgs.find(i => !String(i.className).includes('rc-image-tile-11'));
  const rawUrl = base ? String(base.src) : null;
  const tiles = [...document.querySelectorAll('.rc-imageselect-tile')].map(td => {
    const r = td.getBoundingClientRect();
    const img = td.querySelector('img');
    const c = String(td.className);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cls: img ? String(img.className) : "", src: img ? String(img.src) : "",
      sel: c.includes('rc-imageselect-tileselected'), dyn: c.includes('rc-imageselect-dynamic-selected'),
      ready: !!(img && img.complete && img.naturalWidth > 0),
    };
  });
  const errors = [...document.querySelectorAll('[class*="rc-imageselect-error"], .rc-imageselect-incorrect-response')]
    .filter(e => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0 && String(e.innerText || '').trim())
    .map(e => String(e.className).split(' ')[0]);
  return { title: (title || t).slice(0, 150), rawUrl, tiles, errors };
})()`;

/** 主文档：视口尺寸（点击前用它确认落点在视口内） */
export const VIEWPORT_EXPR = "({ w: window.innerWidth, h: window.innerHeight })";

/** bframe session 内：「换一题」按钮位置（真机实测 id = #recaptcha-reload-button，title="Get a new challenge"） */
export const RELOAD_BUTTON_EXPR = `(() => {
  const b = document.querySelector('#recaptcha-reload-button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  if (r.width < 5) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

/**
 * anchor session 内：checkbox 的真实状态。
 *
 * 为什么要读它：真机实测（2026-09-26 14:29，窗口 77）页面刚跳到验证码页时 anchor 已经是
 * 304×78 可见，但 widget 还没接管点击 —— 鼠标事件被吞掉、弹层永远不出现，旧实现白等 25s 后
 * 判 `no_challenge`。只认正面证据：转圈中 / 已勾选才算「点击被收到了」。
 */
export const CHECKBOX_STATE_EXPR = `(() => {
  const c = document.querySelector('#recaptcha-anchor');
  if (!c) return null;
  const cls = String(c.className);
  return { checked: cls.includes('recaptcha-checkbox-checked'), loading: cls.includes('recaptcha-checkbox-loading') };
})()`;

/** bframe session 内：Verify 按钮位置（**必须在本 session 内读**，主文档里没有它） */
export const VERIFY_BUTTON_EXPR = `(() => {
  const b = document.querySelector('#recaptcha-verify-button');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  if (r.width < 5) return null;
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

/** 主文档：结果复核（path 不含 recaptcha 或拿到 token = 通过） */
export const PAGE_STATE_EXPR = `(() => {
  const ta = document.querySelector('textarea[name="g-recaptcha-response"], #g-recaptcha-response');
  return { path: location.pathname, hasToken: !!(ta && ta.value && ta.value.length > 20) };
})()`;

// ==================== 节奏与上限 ====================

const ANCHOR_POLL_ATTEMPTS = 12;
const ANCHOR_POLL_INTERVAL_MS = 2500;
/** 点完 checkbox 后等「通过 / 出网格」：≤ 25s */
const RESOLVE_POLL_ATTEMPTS = 25;
const RESOLVE_POLL_INTERVAL_MS = 1000;
/**
 * 点完 Verify 后等结论：≤ 7s。
 * 点完 Verify 的瞬间旧网格仍然可见 —— 必须等到「通过 / 换图 / 出错误提示 / 弹层收起」才算有结论，
 * 否则下一轮会读到半新半旧的页面；而静态题里再点一次已选中的格子会把它**取消选中**。
 */
const VERIFY_POLL_ATTEMPTS = 14;
const VERIFY_POLL_INTERVAL_MS = 500;
/** 逐格点击之间的间隔（真人化） */
const TILE_CLICK_INTERVAL_MS = 350;
/** checkbox 点击：被吞掉时最多重点几次（widget 未就绪 / 页面刚跳过来） */
const CHECKBOX_CLICK_ATTEMPTS = 3;
/** 每次点击后等「点击被收到」的窗口：≤ 2.5s（转圈 / 已勾选 / 出现挑战 / 页面通过） */
const CHECKBOX_EFFECT_ATTEMPTS = 5;
const CHECKBOX_EFFECT_INTERVAL_MS = 500;
/** 动态题：等被点格子换上新图（真机 3.5s 时仍有格子在淡出；环境「冷」时 Google 会故意放慢）≤ 15s */
const DYNAMIC_POLL_ATTEMPTS = 30;
const DYNAMIC_POLL_INTERVAL_MS = 500;
/** 动态题：补图最多几波（每波 = 逐张识别新图 + 点命中的格子） */
const MAX_DYNAMIC_WAVES = 6;
/** 换题（挑战对象不在词表时）上限；换题不花打码费，但也要有界 */
const MAX_RELOADS = 3;
const RELOAD_WAIT_MS = 2000;
/** 4×4 常连续出多页（按钮文案 NEXT），一页不算一轮；每轮最多几页 */
const MAX_PAGES_PER_ROUND = 5;
/** 单次求解的打码请求硬上限（约 $0.0009/次） */
const MAX_API_CALLS = 40;
/** 页面状态读失败的重试（跨文档跳转时执行上下文会短暂不可用） */
const PAGE_STATE_RETRIES = 3;
const PAGE_STATE_RETRY_MS = 400;

/** 求解器依赖注入（单测全部替换为假实现） */
export interface SolveRecaptchaOptions {
  /** 调用方保证已 `connect()` 的 CDP 连接 */
  connection: CdpPort;
  config: CaptchaConfig;
  log?: CaptchaLogger | null;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** bframe iframe 在主文档里的位置 + 弹层是否可见 */
type FrameRect = Rect & { visible: boolean };

/** 格子：坐标 + 图片 + 状态（见 CHALLENGE_EXPR 注释） */
interface Tile extends Rect {
  cls: string;
  src: string;
  sel: boolean;
  dyn: boolean;
  ready: boolean;
}

/** 视口尺寸（点击前用它确认落点在视口内） */
interface Viewport {
  w: number;
  h: number;
}

interface ChallengeInfo {
  title: string;
  /** 整张原图（取自非 `-11` 格子）；只剩单图时为 null */
  rawUrl: string | null;
  tiles: Tile[];
  /** 当前可见的错误提示类名（非空 = Google 判答错） */
  errors: string[];
}

interface GridInfo {
  sessionId: string;
  frame: FrameRect;
}

interface PageState {
  path: string;
  hasToken: boolean;
}

type WaitOutcome =
  | { kind: "passed" }
  | { kind: "grid"; grid: GridInfo }
  | { kind: "timeout" }
  | { kind: "cdp_failed" };

/** 点完 Verify 之后 Google 的结论 */
type Verdict = "passed" | "next_page" | "wrong" | "hidden" | "timeout" | "cdp_failed";

type Point = { x: number; y: number };

/** 点格子的结果：hidden = 弹层中途收起（按本轮未通过处理），其余失败直接结束求解 */
type ClickStatus = "ok" | "hidden" | "off_viewport" | "cdp_failed";

/** 解一页的结果：已点 Verify（带判定基准），或弹层中途收起 */
type PageOutcome = { kind: "verified"; before: VerdictBaseline } | { kind: "collapsed" };

/** 截断（日志 / detail 用） */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.name === "TimeoutError" ? `超时（${error.name}）` : error.message;
  return String(error);
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (["x", "y", "w", "h"] as const).every((key) => typeof record[key] === "number" && Number.isFinite(record[key]));
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 动态题换上来的 100×100 单图（各自独立 src，只能走 CapSolver single） */
function isSingleTile(tile: Tile): boolean {
  return tile.cls.includes("rc-image-tile-11");
}

/** 格子列表：只保留合法矩形；缺失的状态字段按「未选中 / 已加载」处理 */
function tileList(value: unknown): Tile[] {
  if (!Array.isArray(value)) return [];
  const out: Tile[] = [];
  for (const item of value) {
    if (!isRect(item)) continue;
    const record = item as unknown as Record<string, unknown>;
    out.push({
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      cls: textOf(record["cls"]),
      src: textOf(record["src"]),
      sel: record["sel"] === true,
      dyn: record["dyn"] === true,
      ready: record["ready"] !== false,
    });
  }
  return out;
}

function cdpErrorOf(message: Record<string, unknown>): string | null {
  const error = message["__error"];
  return typeof error === "string" && error ? error : null;
}

/** 读 bframe iframe 在主文档里的位置（页面级求值） */
async function readBframeFrame(connection: CdpPort): Promise<FrameRect | null> {
  const rect = await connection.evaluate<unknown>(BFRAME_RECT_EXPR);
  if (!isRect(rect)) return null;
  const visible = (rect as unknown as Record<string, unknown>)["visible"] !== false;
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h, visible };
}

/** 弹层是否真的展示在屏幕上（隐藏态：visibility:hidden 或停在 y = -9999） */
function isShown(frame: FrameRect): boolean {
  return frame.visible && frame.y + frame.h > 0;
}

/** 读视口尺寸（点击前确认落点） */
async function readViewport(connection: CdpPort): Promise<Viewport | null> {
  const vp = await connection.evaluate<unknown>(VIEWPORT_EXPR);
  if (typeof vp !== "object" || vp === null) return null;
  const record = vp as Record<string, unknown>;
  const w = record["w"];
  const h = record["h"];
  if (typeof w !== "number" || typeof h !== "number" || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  return { w, h };
}

/**
 * 落点是否在视口内。视口外 `Input.dispatchMouseEvent` 派发出去**什么都不会发生**。
 * 读不到视口时不拦（保持旧行为）。
 */
function inViewport(x: number, y: number, viewport: Viewport | null): boolean {
  if (!viewport) return true;
  return x >= 0 && y >= 0 && x < viewport.w && y < viewport.h;
}

/**
 * 把元素（格子 / 按钮）在 iframe 内的偏移换算成页面坐标，并确认落在视口内。
 * `frame` 必须是**刚刚读到**的 bframe 位置：控件会随挑战刷新而移动（出错误提示时弹层会变高）。
 */
function toPagePoint(frame: Rect, item: Rect, viewport: Viewport | null): Point | null {
  const x = frame.x + item.x + Math.round(item.w / 2);
  const y = frame.y + item.y + Math.round(item.h / 2);
  return inViewport(x, y, viewport) ? { x, y } : null;
}

/** 读 anchor session 里的 checkbox 状态（找不到 anchor 会话返回 null） */
async function readCheckboxState(connection: CdpPort): Promise<"checked" | "loading" | "unchecked" | null> {
  for (const session of connection.sessions) {
    const state = await connection.evaluate<unknown>(CHECKBOX_STATE_EXPR, session.sessionId);
    if (typeof state !== "object" || state === null) continue;
    const record = state as Record<string, unknown>;
    if (record["checked"] === true) return "checked";
    if (record["loading"] === true) return "loading";
    return "unchecked";
  }
  return null;
}

/** 读「换一题」按钮位置（bframe session 内） */
async function readReloadButton(connection: CdpPort, sessionId: string): Promise<Rect | null> {
  const rect = await connection.evaluate<unknown>(RELOAD_BUTTON_EXPR, sessionId);
  return isRect(rect) ? rect : null;
}

/**
 * 找「正在展示」的图片挑战：逐个 session 探 `.rc-imageselect-tile`（`targetInfo.url` 可能是空的，
 * 只能靠 DOM 认 bframe），并要求 bframe 弹层可见且 `h > 200`。弹层收起时残留的旧格子不算。
 */
async function findGrid(connection: CdpPort): Promise<GridInfo | null> {
  for (const session of connection.sessions) {
    const count = await connection.evaluate<unknown>(TILE_PROBE_EXPR, session.sessionId);
    if (typeof count !== "number" || count <= 0) continue;
    const frame = await readBframeFrame(connection);
    if (frame && frame.h > 200 && isShown(frame)) return { sessionId: session.sessionId, frame };
    return null;
  }
  return null;
}

/** 在 bframe session 内读挑战信息 */
async function readChallenge(connection: CdpPort, sessionId: string): Promise<ChallengeInfo | null> {
  const info = await connection.evaluate<unknown>(CHALLENGE_EXPR, sessionId);
  if (typeof info !== "object" || info === null) return null;
  const record = info as Record<string, unknown>;
  const tiles = tileList(record["tiles"]);
  // 原图只认非 `-11` 格子的 src；格子没带 src 时（旧形态）才退回表达式给的 rawUrl
  const baseSrc = tiles.find((tile) => !isSingleTile(tile) && tile.src)?.src ?? null;
  const exprRaw = textOf(record["rawUrl"]) || null;
  const rawUrl = baseSrc ?? (tiles.some((tile) => tile.src) ? null : exprRaw);
  const errors = Array.isArray(record["errors"]) ? record["errors"].filter((e): e is string => typeof e === "string" && e !== "") : [];
  return { title: textOf(record["title"]), rawUrl, tiles, errors };
}

/**
 * 页面指纹：只看原图（4×4 换页 / 换题时原图一定变）。
 * 不看单图格子的 src —— 动态题里没来得及等完的格子会在点 Verify 之后才换上新图，
 * 把它当成「换页」会让本轮永不结束（审查发现）。只剩单图时才退回全部格子的 src。
 */
function signatureOf(info: ChallengeInfo): string {
  return info.rawUrl ?? info.tiles.map((tile) => tile.src).join("|");
}

/** 点 Verify 之前的基准：页面指纹 + 当时已经显示着的错误提示 */
interface VerdictBaseline {
  signature: string;
  errors: string[];
}

/** 在 bframe session 内读 Verify 按钮位置 */
async function readVerifyButton(connection: CdpPort, sessionId: string): Promise<Rect | null> {
  const rect = await connection.evaluate<unknown>(VERIFY_BUTTON_EXPR, sessionId);
  return isRect(rect) ? rect : null;
}

/** 页面级复核（主文档） */
async function readPageState(connection: CdpPort): Promise<PageState | null> {
  const state = await connection.evaluate<unknown>(PAGE_STATE_EXPR);
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  if (typeof record["path"] !== "string") return null;
  return { path: record["path"], hasToken: record["hasToken"] === true };
}

/**
 * 页面级复核，容忍短暂失败：通过验证后页面跨文档跳转，`Runtime.evaluate` 会短暂报
 * 「执行上下文已销毁」。只读一次就判 cdp_failed 会把「已通过」报成「连不上调试端口」。
 */
async function readPageStateStable(connection: CdpPort, sleep: (ms: number) => Promise<void>): Promise<PageState | null> {
  for (let attempt = 0; attempt < PAGE_STATE_RETRIES; attempt += 1) {
    const state = await readPageState(connection);
    if (state) return state;
    if (attempt < PAGE_STATE_RETRIES - 1) await sleep(PAGE_STATE_RETRY_MS);
  }
  return null;
}

/**
 * 通过判据（不看任何 act() / 打码 API 的成功返回）：拿到 token，或离开了验证码页。
 * 「离开」= path 不含 recaptcha **且与开始求解时不同** —— reCAPTCHA 嵌在普通页面里时
 * （path 本来就不含 recaptcha），不能一上来就算通过。读不到起始 path 时退回旧判据。
 */
function hasPassed(state: PageState, startPath: string | null): boolean {
  if (state.hasToken) return true;
  if (state.path.includes("recaptcha")) return false;
  return startPath === null || state.path !== startPath;
}

/** 轮询「页面已通过」或「出现可见的图片网格」；两者都没有则超时 */
async function waitForResolution(
  connection: CdpPort,
  sleep: (ms: number) => Promise<void>,
  startPath: string | null,
  attempts: number,
  intervalMs: number,
): Promise<WaitOutcome> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readPageStateStable(connection, sleep);
    if (!state) return { kind: "cdp_failed" };
    if (hasPassed(state, startPath)) return { kind: "passed" };
    const grid = await findGrid(connection);
    if (grid) return { kind: "grid", grid };
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  return { kind: "timeout" };
}

/**
 * 点完 Verify 后等 Google 的结论（旧网格在点击瞬间仍然可见，先等一拍再读）：
 *   - passed：离开验证码页 / 拿到 token
 *   - wrong：出现**新的**错误提示（Please try again / also check the new images …）；
 *     上一轮残留、点 Verify 前就显示着的提示不算（审查发现：否则点完立刻误判为答错）
 *   - next_page：没有错误提示、但原图换了（4×4 连续多页，按钮文案 NEXT）
 *   - hidden：弹层收起且没拿到 token（例如挑战过期）→ 需要重新点 checkbox
 *   - timeout：什么都没变（点击可能没生效）
 */
async function waitForVerdict(
  connection: CdpPort,
  sleep: (ms: number) => Promise<void>,
  sessionId: string,
  startPath: string | null,
  before: VerdictBaseline,
): Promise<Verdict> {
  let lastHidden = false;
  let cleared = before.errors.length === 0;
  for (let attempt = 0; attempt < VERIFY_POLL_ATTEMPTS; attempt += 1) {
    await sleep(VERIFY_POLL_INTERVAL_MS);
    const state = await readPageStateStable(connection, sleep);
    if (!state) return "cdp_failed";
    if (hasPassed(state, startPath)) return "passed";
    const frame = await readBframeFrame(connection);
    lastHidden = !frame || !isShown(frame);
    if (lastHidden) continue;
    const info = await readChallenge(connection, sessionId);
    if (!info) continue;
    const fresh = info.errors.some((error) => !before.errors.includes(error));
    if (fresh || (cleared && info.errors.length > 0)) return "wrong";
    if (info.errors.length === 0) cleared = true;
    if (signatureOf(info) !== before.signature) return "next_page";
  }
  return lastHidden ? "hidden" : "timeout";
}

/** 轮询 anchor iframe（宽 > 10 才算渲染出来；后台标签页里 checkbox 停在 0×0） */
async function waitForAnchor(connection: CdpPort, sleep: (ms: number) => Promise<void>): Promise<Rect | null> {
  for (let attempt = 0; attempt < ANCHOR_POLL_ATTEMPTS; attempt += 1) {
    const state = await connection.evaluate<unknown>(ANCHOR_EXPR);
    if (typeof state === "object" && state !== null) {
      const anchor = (state as Record<string, unknown>)["anchor"];
      if (isRect(anchor) && anchor.w > 10) return anchor;
    }
    if (attempt < ANCHOR_POLL_ATTEMPTS - 1) await sleep(ANCHOR_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * 下载图片（原图 30–50KB / 单图 3–5KB 的 JPEG，直连不需要 cookie）。
 * 必须用二进制：只有 `text()` 的响应读不出 JPEG（真实 fetch 恒有 `arrayBuffer()`）。
 */
async function downloadImage(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  now: () => number,
): Promise<{ ok: true; bytes: number; base64: string; costMs: number } | { ok: false; detail: string }> {
  const started = now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, detail: `下载失败: HTTP ${response.status}` };
    const binary = response as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof binary.arrayBuffer !== "function") return { ok: false, detail: "下载失败: 响应不支持二进制读取" };
    const bytes = new Uint8Array(await binary.arrayBuffer());
    if (bytes.length === 0) return { ok: false, detail: "下载失败: 图片为空" };
    return {
      ok: true,
      bytes: bytes.length,
      base64: Buffer.from(bytes).toString("base64"),
      costMs: Math.max(0, Math.round(now() - started)),
    };
  } catch (error) {
    return { ok: false, detail: `下载失败: ${errorText(error)}` };
  }
}

/**
 * 求解 reCAPTCHA。
 * 只返回判定结果；不写数据库、不写窗口备注、不写标签，也不打印任何凭据。
 */
export async function solveRecaptcha(options: SolveRecaptchaOptions): Promise<CaptchaSolveResult> {
  const { connection, config } = options;
  const log: CaptchaLogger = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const started = now();
  const maxRounds = Number.isFinite(config.maxRounds) && config.maxRounds > 0 ? Math.floor(config.maxRounds) : 1;

  // 零成本失败：不发任何请求、不建任何 CDP 流量
  if (!config.enabled) return { ok: false, reason: "disabled", rounds: 0 };
  if (!config.apiKey) return { ok: false, reason: "no_api_key", rounds: 0 };

  let rounds = 0;
  let apiCalls = 0;
  let reloads = 0;
  const fail = (reason: CaptchaFailureReason, detail?: string): CaptchaSolveResult =>
    detail === undefined ? { ok: false, reason, rounds } : { ok: false, reason, detail, rounds };
  const pass = (): CaptchaSolveResult => {
    const costMs = Math.max(0, Math.round(now() - started));
    log(`[C] 人机验证已通过（${rounds} 轮，共 ${(costMs / 1000).toFixed(1)}s）`);
    return { ok: true, rounds, costMs };
  };
  const bringToFront = async (): Promise<string | null> => {
    const error = cdpErrorOf(await connection.send("Page.bringToFront"));
    if (error) log(`[C] CDP 失败（Page.bringToFront）: ${error}`);
    return error;
  };

  /**
   * 点 checkbox，并确认「点击真的被 Google 收到了」。
   *
   * 真机教训（2026-09-26 14:29，窗口 77）：页面刚跳到验证码页时 anchor 已经是 304×78 可见，
   * 但 widget 还没接管点击 —— 鼠标事件被吞掉、弹层永远不出现，旧实现白等 25s 后判 no_challenge。
   * 这里只认正面证据（页面通过 / 出现可见挑战 / checkbox 转圈或已勾选），没有证据就有界重点。
   */
  const clickCheckbox = async (
    point: Point,
    startPath: string | null,
  ): Promise<{ kind: "passed" } | { kind: "grid"; grid: GridInfo } | { kind: "wait" } | { kind: "cdp_failed" }> => {
    for (let attempt = 1; attempt <= CHECKBOX_CLICK_ATTEMPTS; attempt += 1) {
      await connection.mouseClick(point.x, point.y);
      if (attempt === 1) {
        log(checkboxClicks === 1 ? "[C] 已点击 reCAPTCHA checkbox" : `[C] 验证弹层已收起，重新点击 checkbox（第 ${checkboxClicks} 次）`);
      } else {
        log(`[C] 上一次点击没有任何反应，重新点击 checkbox（第 ${attempt} 次）`);
      }
      for (let poll = 0; poll < CHECKBOX_EFFECT_ATTEMPTS; poll += 1) {
        await sleep(CHECKBOX_EFFECT_INTERVAL_MS);
        const state = await readPageStateStable(connection, sleep);
        if (!state) return { kind: "cdp_failed" };
        if (hasPassed(state, startPath)) return { kind: "passed" };
        const grid = await findGrid(connection);
        if (grid) return { kind: "grid", grid };
        const box = await readCheckboxState(connection);
        if (box === "checked" || box === "loading") return { kind: "wait" }; // 收到了，等 Google 出结果
      }
    }
    log(`[C] 连续 ${CHECKBOX_CLICK_ATTEMPTS} 次点击 checkbox 都没有反应，继续等页面`);
    return { kind: "wait" };
  };

  /**
   * 按页坐标点一组格子（每次都用刚读到的 bframe 位置）；任何一格落点不合格就一格都不点：
   *   - hidden：弹层中途收起（挑战过期）→ 调用方结束本轮、重新点 checkbox，不是「视口外」
   *   - off_viewport：弹层可见但落点在视口外；cdp_failed：读不到弹层位置
   */
  const clickTiles = async (tiles: readonly Tile[], indexes: readonly number[]): Promise<ClickStatus> => {
    if (indexes.length === 0) return "ok";
    const frame = await readBframeFrame(connection);
    if (!frame) return "cdp_failed";
    if (!isShown(frame)) return "hidden";
    const viewport = await readViewport(connection);
    const points: Point[] = [];
    for (const index of indexes) {
      const tile = tiles[index];
      const point = tile ? toPagePoint(frame, tile, viewport) : null;
      if (!point) return "off_viewport";
      points.push(point);
    }
    for (const point of points) {
      await connection.mouseClick(point.x, point.y);
      await sleep(TILE_CLICK_INTERVAL_MS);
    }
    return "ok";
  };

  /** clickTiles 的失败状态（hidden 之外）→ 失败结果 */
  const clickFailure = (status: "off_viewport" | "cdp_failed", label: string): CaptchaSolveResult => {
    if (status === "cdp_failed") {
      log(`[C] ${label}: 读取验证弹层位置失败`);
      return fail("cdp_failed", "读取验证弹层位置失败");
    }
    log(`[C] ${label}: 格子落点在视口外，点了也没用`);
    return fail("off_viewport", "格子落点在视口外");
  };

  /** 点 bframe 里的「换一题」（真机 id = #recaptcha-reload-button）；落点必须在视口内；不花打码费 */
  const reloadChallenge = async (sessionId: string): Promise<boolean> => {
    if (reloads >= MAX_RELOADS) return false;
    const button = await readReloadButton(connection, sessionId);
    if (!button) return false;
    const frame = await readBframeFrame(connection);
    if (!frame) return false;
    const point = toPagePoint(frame, button, await readViewport(connection));
    if (!point) return false;
    await connection.mouseClick(point.x, point.y);
    reloads += 1;
    await sleep(RELOAD_WAIT_MS);
    return true;
  };

  /** 逐张识别单图（100×100，CapSolver single）；返回命中的格子下标。下载失败的单图按「没有」处理并记日志 */
  const classifySingles = async (
    label: string,
    tiles: readonly Tile[],
    indexes: readonly number[],
    questionId: string,
  ): Promise<{ ok: true; hits: number[] } | { ok: false; result: CaptchaSolveResult }> => {
    const hits: number[] = [];
    for (const index of indexes) {
      const tile = tiles[index];
      if (!tile?.src) continue;
      if (apiCalls >= MAX_API_CALLS) {
        log(`[C] ${label}: 打码次数已达单次上限 ${MAX_API_CALLS}，停止`);
        return { ok: false, result: fail("round_limit", `打码次数已达上限 ${MAX_API_CALLS}`) };
      }
      const image = await downloadImage(tile.src, fetchImpl, config.timeoutMs, now);
      if (!image.ok) {
        log(`[C] ${label}: 第 ${index} 格新图下载失败，按「没有」处理: ${image.detail}`);
        continue;
      }
      apiCalls += 1;
      const judged = await classifyTile({
        apiKey: config.apiKey,
        imageBase64: image.base64,
        questionId,
        fetchImpl,
        timeoutMs: config.timeoutMs,
      });
      if (!judged.ok) {
        log(`[C] ${label}: 打码失败（不继续下一轮）: ${judged.detail}`);
        return { ok: false, result: fail("api_error", judged.detail) };
      }
      if (judged.hasObject) hits.push(index);
    }
    return { ok: true, hits };
  };

  /**
   * 动态题补图：点过的格子会淡出（`dyn`）并换成 100×100 新图。等新图出现 → 逐张识别 →
   * 命中的再点，直到一波里没有命中。静态题点完格子只会变成选中态，第一波就直接结束。
   * 返回补点的格子数与「弹层是否中途收起」；失败返回 CaptchaSolveResult。
   */
  const fillDynamic = async (
    label: string,
    sessionId: string,
    clicked: ReadonlyArray<{ index: number; src: string }>,
    questionId: string,
  ): Promise<{ extraClicks: number; collapsed: boolean } | CaptchaSolveResult> => {
    let extraClicks = 0;
    let pending = [...clicked];
    for (let wave = 1; wave <= MAX_DYNAMIC_WAVES && pending.length > 0; wave += 1) {
      let info: ChallengeInfo | null = null;
      let replaced: number[] = [];
      let waiting: number[] = [];
      for (let attempt = 0; attempt < DYNAMIC_POLL_ATTEMPTS; attempt += 1) {
        await sleep(DYNAMIC_POLL_INTERVAL_MS);
        info = await readChallenge(connection, sessionId);
        if (!info) return fail("cdp_failed", "读取图片挑战信息失败");
        const tiles = info.tiles;
        // 只认换上来的 `-11` 单图：整张网格被换掉（src 变了但仍是 -33/-44 原图切片）不是补图
        replaced = pending.filter((p) => {
          const tile = tiles[p.index];
          return !!tile && tile.src !== p.src && isSingleTile(tile) && tile.ready && !tile.dyn;
        }).map((p) => p.index);
        waiting = pending.filter((p) => {
          const tile = tiles[p.index];
          return !!tile && (tile.dyn || (tile.src !== p.src && !tile.ready));
        }).map((p) => p.index);
        if (waiting.length === 0) break;
      }
      if (!info) break;
      if (waiting.length > 0) log(`[C] ${label}: ${waiting.length} 格新图等待超时，跳过`);
      if (replaced.length === 0) break; // 静态题（没换图）或新图都没出来

      // 识别前确认弹层还开着：挑战中途过期时残留的格子不值得花钱
      const frame = await readBframeFrame(connection);
      if (!frame) return fail("cdp_failed", "读取验证弹层位置失败");
      if (!isShown(frame)) return { extraClicks, collapsed: true };

      const judged = await classifySingles(label, info.tiles, replaced, questionId);
      if (!judged.ok) return judged.result;
      log(`[C] ${label}: 动态补图第 ${wave} 波: 新图 [${replaced.join(",")}] → 命中 [${judged.hits.join(",")}]`);
      if (judged.hits.length === 0) break;
      const status = await clickTiles(info.tiles, judged.hits);
      if (status === "hidden") return { extraClicks, collapsed: true };
      if (status !== "ok") return clickFailure(status, label);
      extraClicks += judged.hits.length;
      const current = info.tiles;
      pending = judged.hits.map((index) => ({ index, src: current[index]?.src ?? "" }));
    }
    return { extraClicks, collapsed: false };
  };

  /**
   * 解一页：识别（原图 multi + 单图 single）→ 点格子 → 动态补图 → 点 Verify。
   * 返回点 Verify 前的基准（用于判断结论）或「弹层中途收起」；失败返回 CaptchaSolveResult。
   */
  const solvePage = async (grid: GridInfo, label: string): Promise<PageOutcome | CaptchaSolveResult> => {
    let info = await readChallenge(connection, grid.sessionId);
    if (!info) {
      log(`[C] ${label}: 读取图片挑战信息失败`);
      return fail("cdp_failed", "读取图片挑战信息失败");
    }

    // 挑战对象不在词表：先换一题（不花钱），换够了仍不支持才放弃
    let question = resolveQuestion(info.title);
    while (!question && reloads < MAX_RELOADS) {
      log(`[C] ${label}: 挑战对象不在支持词表，换一题: "${truncate(info.title, 80)}"`);
      if (!(await reloadChallenge(grid.sessionId))) break;
      info = await readChallenge(connection, grid.sessionId);
      if (!info) return fail("cdp_failed", "读取图片挑战信息失败");
      question = resolveQuestion(info.title);
    }
    if (!question) {
      log(`[C] ${label}: 挑战对象不在支持词表（不调打码）: "${truncate(info.title, 80)}"`);
      return fail("unsupported_object", truncate(info.title, 150));
    }
    log(`[C] ${label}图片挑战: "${truncate(info.title, 80)}" 对象=${question.label}(${question.id})`);

    // 先确认弹层开着、且在视口内：收起了按「本轮未通过」处理；视口外点了也没用，先把打码的钱省下来
    const frame = (await readBframeFrame(connection)) ?? grid.frame;
    if (!isShown(frame)) return { kind: "collapsed" };
    if (!inViewport(frame.x + 5, frame.y + 5, await readViewport(connection))) {
      log(`[C] ${label}: 挑战控件在视口外（bframe y=${frame.y}），点了也没用 — 不打码`);
      return fail("off_viewport", `bframe 在视口外（y=${frame.y}）`);
    }

    const tiles = info.tiles;
    const baseIndexes = tiles.flatMap((tile, index) => (isSingleTile(tile) ? [] : [index]));
    const singleIndexes = tiles.flatMap((tile, index) => (isSingleTile(tile) ? [index] : []));
    const targets = new Set<number>();

    if (baseIndexes.length > 0) {
      if (!info.rawUrl) {
        log(`[C] ${label}: 未取到原始图（不调打码）`);
        return fail("no_raw_image", "rawUrl 为空");
      }
      const downloaded = await downloadImage(info.rawUrl, fetchImpl, config.timeoutMs, now);
      if (!downloaded.ok) {
        log(`[C] ${label}: 未取到原始图（不调打码）: ${downloaded.detail}`);
        return fail("no_raw_image", downloaded.detail);
      }
      if (apiCalls >= MAX_API_CALLS) {
        log(`[C] ${label}: 打码次数已达单次上限 ${MAX_API_CALLS}，停止`);
        return fail("round_limit", `打码次数已达上限 ${MAX_API_CALLS}`);
      }
      const classifyStarted = now();
      apiCalls += 1;
      const classified = await classifyImage({
        apiKey: config.apiKey,
        imageBase64: downloaded.base64,
        questionId: question.id,
        fetchImpl,
        timeoutMs: config.timeoutMs,
      });
      const classifyMs = Math.max(0, Math.round(now() - classifyStarted));
      if (!classified.ok) {
        // 打码平台报错：立即返回，不空烧剩余轮次
        log(`[C] ${label}: 打码失败（不继续下一轮）: ${classified.detail}`);
        return fail("api_error", classified.detail);
      }
      log(
        `[C] ${label}: 下载原图 ${downloaded.bytes} 字节 (${downloaded.costMs}ms) → 打码 ${classifyMs}ms → ` +
          `objects=[${classified.objects.join(",")}] (0-based)`,
      );
      let dropped = 0;
      for (const index of classified.objects) {
        // 0-based；越界丢弃，绝不点到网格外；指向单图格子的索引也丢（那一格已不是原图的内容）
        const tile = tiles[index];
        if (!tile || isSingleTile(tile)) {
          dropped += 1;
          continue;
        }
        targets.add(index);
      }
      if (dropped > 0) {
        log(`[C] ${label}: 已丢弃 ${dropped} 个无效索引（越界或指向单图格子；objects=[${classified.objects.join(",")}]，格子数=${tiles.length}）`);
      }
    }

    if (singleIndexes.length > 0) {
      const judged = await classifySingles(label, tiles, singleIndexes, question.id);
      if (!judged.ok) return judged.result;
      log(`[C] ${label}: 单图 [${singleIndexes.join(",")}] 逐张识别 → 命中 [${judged.hits.join(",")}]`);
      for (const index of judged.hits) targets.add(index);
    }

    // 静态题的格子是开关：只点「选中态与答案不一致」的格子（已选中的正确格子不能再点）
    const toClick = tiles.flatMap((tile, index) => (targets.has(index) !== tile.sel ? [index] : []));
    const status = await clickTiles(tiles, toClick);
    if (status === "hidden") return { kind: "collapsed" };
    if (status !== "ok") return clickFailure(status, label);

    let clickedTotal = toClick.length;
    if (toClick.length > 0) {
      const filled = await fillDynamic(
        label,
        grid.sessionId,
        toClick.map((index) => ({ index, src: tiles[index]?.src ?? "" })),
        question.id,
      );
      if ("ok" in filled) return filled;
      if (filled.collapsed) return { kind: "collapsed" };
      clickedTotal += filled.extraClicks;
    }

    // 点 Verify 前重读页面：指纹 + 已显示的错误提示作为基准；按钮与弹层位置可能已随错误提示移动
    const latest = (await readChallenge(connection, grid.sessionId)) ?? info;
    const before: VerdictBaseline = { signature: signatureOf(latest), errors: latest.errors };
    const verify = await readVerifyButton(connection, grid.sessionId);
    if (!verify) {
      log(`[C] ${label}: 未找到 Verify 按钮`);
      return fail("cdp_failed", "未找到 Verify 按钮");
    }
    const verifyFrame = await readBframeFrame(connection);
    if (!verifyFrame) return clickFailure("cdp_failed", label);
    if (!isShown(verifyFrame)) return { kind: "collapsed" };
    const verifyPoint = toPagePoint(verifyFrame, verify, await readViewport(connection));
    if (!verifyPoint) {
      log(`[C] ${label}: Verify 按钮在视口外（bframe y=${verifyFrame.y}），点了也没用`);
      return fail("off_viewport", `Verify 按钮在视口外（bframe y=${verifyFrame.y}）`);
    }
    await connection.mouseClick(verifyPoint.x, verifyPoint.y);
    log(`[C] ${label}: 已点 ${clickedTotal} 格 + Verify，等待结果`);
    return { kind: "verified", before };
  };

  const frontError = await bringToFront();
  if (frontError) return fail("cdp_failed", frontError);

  // 起始 path：「通过」必须是离开了这个页面（或拿到 token），见 hasPassed
  const startPath = (await readPageStateStable(connection, sleep))?.path ?? null;

  const maxCheckboxClicks = maxRounds + 1;
  let checkboxClicks = 0;
  let roundOpen = false;
  let pagesInRound = 0;
  let pages = 0;

  for (;;) {
    if (pages > 0) {
      const retryError = await bringToFront();
      if (retryError) return fail("cdp_failed", retryError);
    }

    let grid = await findGrid(connection);
    if (!grid) {
      // 没有可见的图片挑战：点 checkbox（首次；或弹层收起 / 挑战过期后重新打开），次数有界
      if (checkboxClicks >= maxCheckboxClicks) break;
      const anchor = await waitForAnchor(connection, sleep);
      if (!anchor) {
        log("[C] 未找到 reCAPTCHA checkbox（anchor iframe），不打码");
        return fail("no_challenge", "未找到 anchor iframe");
      }
      // 真机：checkbox 在主文档里 anchor iframe 左边缘 +26px、垂直居中
      const checkboxPoint = { x: anchor.x + 26, y: anchor.y + Math.round(anchor.h / 2) };
      if (!inViewport(checkboxPoint.x, checkboxPoint.y, await readViewport(connection))) {
        log(`[C] checkbox 落点在视口外（anchor y=${anchor.y}），点了也没用`);
        return fail("off_viewport", `anchor 在视口外（y=${anchor.y}）`);
      }
      checkboxClicks += 1;
      const effect = await clickCheckbox(checkboxPoint, startPath);
      if (effect.kind === "passed") return pass();
      if (effect.kind === "cdp_failed") return fail("cdp_failed", "读取页面状态失败");
      if (effect.kind === "grid") {
        grid = effect.grid;
      } else {
        // 点击已被收到（转圈 / 已勾选）但还没出结果：走长轮询等 Google 的下一步
        const outcome = await waitForResolution(connection, sleep, startPath, RESOLVE_POLL_ATTEMPTS, RESOLVE_POLL_INTERVAL_MS);
        if (outcome.kind === "cdp_failed") return fail("cdp_failed", "读取页面状态失败");
        if (outcome.kind === "passed") return pass();
        if (outcome.kind === "timeout") {
          log("[C] 等待图片挑战超时（页面仍在验证码页），不打码");
          return rounds > 0 ? fail("not_passed", "等待图片挑战超时") : fail("no_challenge", "等待图片挑战超时");
        }
        grid = outcome.grid;
      }
    }

    if (!roundOpen) {
      if (rounds >= maxRounds) break;
      rounds += 1;
      roundOpen = true;
      pagesInRound = 0;
    }
    if (pagesInRound >= MAX_PAGES_PER_ROUND) {
      log(`[C] 第 ${rounds} 轮已连续 ${MAX_PAGES_PER_ROUND} 页，按一轮未通过处理`);
      roundOpen = false;
      if (rounds >= maxRounds) break;
      continue;
    }
    pagesInRound += 1;
    pages += 1;
    const label = pagesInRound === 1 ? `第 ${rounds} 轮` : `第 ${rounds} 轮第 ${pagesInRound} 页`;

    const page = await solvePage(grid, label);
    if ("ok" in page) return page;
    if (page.kind === "collapsed") {
      log(`[C] ${label}: 未通过（验证弹层中途收起，挑战可能已过期）`);
      roundOpen = false;
      continue;
    }

    const verdict = await waitForVerdict(connection, sleep, grid.sessionId, startPath, page.before);
    if (verdict === "cdp_failed") return fail("cdp_failed", "读取页面状态失败");
    if (verdict === "passed") return pass();
    if (verdict === "next_page") {
      log(`[C] ${label}: 进入下一页`);
      continue;
    }
    const why = verdict === "wrong" ? "答案被判错" : verdict === "hidden" ? "验证弹层已收起" : "页面无变化";
    log(`[C] ${label}: 未通过（${why}）`);
    roundOpen = false;
  }

  // 收尾复核：Google 有时超过等待窗口才放行，报失败前再看一眼页面
  const last = await readPageStateStable(connection, sleep);
  if (last && hasPassed(last, startPath)) return pass();
  log(`[C] 已打满 ${maxRounds} 轮图片挑战仍未通过`);
  return fail("not_passed", `已打满 ${maxRounds} 轮图片挑战仍未通过`);
}
