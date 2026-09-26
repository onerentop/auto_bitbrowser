/**
 * reCAPTCHA 求解器：点 checkbox → （必要时）用 CapSolver 打图片挑战 → 点格子 + Verify → 复核页面。
 *
 * 流程与坐标换算全部照抄真机跑通的脚本
 * （.trellis/tasks/09-26-captcha-capsolver-integration/research/real-machine-recaptcha.md §2）：
 *   1. Page.bringToFront（后台标签页不渲染，checkbox 停在 0×0）
 *   2. 真机鼠标点 checkbox —— 主文档里 anchor iframe 左边缘 +26px、垂直居中
 *   3. 等 bframe 变大（h > 200 且出现 .rc-imageselect-tile）= 图片挑战；
 *      checkbox 单独通过时页面直接离开 /challenge/recaptcha（0 成本，打码零调用）
 *   4. 在 bframe session 内读原始图 URL + 格子坐标 + 挑战文案
 *   5. 下载原始图（payload 的 30–50KB JPEG，**不能用截图**）→ CapSolver → 0-based 索引
 *   6. 点格子中心（页坐标 = bframe 在主文档的偏移 + 格子在本 iframe 内的偏移 + 半宽/半高）
 *   7. 从 bframe session 内读 #recaptcha-verify-button 位置并点击
 *   8. 复核 path / token，未通过则下一轮；轮次上限 `config.maxRounds`
 *
 * 硬性约束：
 *   - 拿不到原始图 / 挑战对象不在词表 → **绝对不调打码 API**，直接返回对应失败原因；
 *   - `objects` 是 0-based，越界索引丢弃；空数组不点格子但仍点 Verify（「一张都没有」是合法答案）；
 *   - 中途 `api_error` 立即返回，不空烧剩余轮次；
 *   - 日志只含轮次 / 对象 / 索引 / 字节数 / 耗时 —— **绝不出现密钥、邮箱、密码、token**；
 *   - 成功判据只有「离开验证码页或拿到 token」，调用方仍须走既有的 myaccount 终检。
 */

import { classifyImage, resolveQuestion } from "./capsolver.ts";
import type { CdpPort } from "./cdp.ts";
import type { CaptchaConfig, CaptchaFailureReason, CaptchaLogger, CaptchaSolveResult, FetchLike } from "./types.ts";

// ==================== 真机表达式（照抄，见 research §2） ====================

/** 主文档：anchor iframe（checkbox 所在）位置 + 当前 path */
export const ANCHOR_EXPR = `(() => {
  const a = [...document.querySelectorAll('iframe')].find(f => String(f.src||'').includes('recaptcha/enterprise/anchor'));
  const r = a ? a.getBoundingClientRect() : null;
  return { path: location.pathname, anchor: r && r.width > 10 ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null };
})()`;

/** 主文档：bframe iframe 的位置（坐标换算基准；`h > 200` = 出现图片挑战） */
export const BFRAME_RECT_EXPR = `(() => {
  const f = [...document.querySelectorAll('iframe')].find(x => String(x.src||'').includes('recaptcha/enterprise/bframe'));
  if (!f) return null;
  const r = f.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
})()`;

/** 某个 session 里有没有图片网格（判定「哪个 session 是 bframe」只能靠探 DOM，不能靠 URL） */
export const TILE_PROBE_EXPR = "document.querySelectorAll('.rc-imageselect-tile').length";

/** bframe session 内：挑战文案 + 原始图 URL + 格子坐标 */
export const CHALLENGE_EXPR = `(() => {
  const t = (document.body ? document.body.innerText : '').replace(/\\s+/g,' ').trim();
  const imgs = [...document.querySelectorAll('.rc-imageselect-tile img, img[src*="recaptcha/enterprise/payload"]')];
  const rawUrl = imgs.length ? String(imgs[0].src) : null;
  const tiles = [...document.querySelectorAll('.rc-imageselect-tile')].map(td => {
    const r = td.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return { title: t.slice(0, 150), rawUrl, tiles };
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

// ==================== 轮询节奏（design §5） ====================

const ANCHOR_POLL_ATTEMPTS = 12;
const ANCHOR_POLL_INTERVAL_MS = 2500;
/** 点完 checkbox 后等「通过 / 出网格」：≤ 25s */
const RESOLVE_POLL_ATTEMPTS = 25;
const RESOLVE_POLL_INTERVAL_MS = 1000;
/**
 * 点完 Verify 后等结果：≤ 7s。
 * 真机脚本这里固定等 7 秒；等太短会在 Google 还没给出结论时就进入下一轮，
 * 而「同一张图重来」时再点同样的格子会把已经选中的格子**取消选中**（reCAPTCHA 的格子是开关）。
 */
const VERIFY_POLL_ATTEMPTS = 14;
const VERIFY_POLL_INTERVAL_MS = 500;
/** 逐格点击之间的间隔（真人化） */
const TILE_CLICK_INTERVAL_MS = 350;

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

interface ChallengeInfo {
  title: string;
  rawUrl: string | null;
  tiles: Rect[];
}

interface GridInfo {
  sessionId: string;
  frame: Rect;
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

function rectList(value: unknown): Rect[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRect);
}

function cdpErrorOf(message: Record<string, unknown>): string | null {
  const error = message["__error"];
  return typeof error === "string" && error ? error : null;
}

/** 读 bframe iframe 在主文档里的位置（页面级求值） */
async function readBframeFrame(connection: CdpPort): Promise<Rect | null> {
  const rect = await connection.evaluate<unknown>(BFRAME_RECT_EXPR);
  return isRect(rect) ? rect : null;
}

/**
 * 找图片挑战：逐个 session 探 `.rc-imageselect-tile`（`targetInfo.url` 可能是空的，
 * 只能靠 DOM 认 bframe），并要求 bframe 在主文档里 `h > 200`。
 */
async function findGrid(connection: CdpPort): Promise<GridInfo | null> {
  for (const session of connection.sessions) {
    const count = await connection.evaluate<unknown>(TILE_PROBE_EXPR, session.sessionId);
    if (typeof count !== "number" || count <= 0) continue;
    const frame = await readBframeFrame(connection);
    if (frame && frame.h > 200) return { sessionId: session.sessionId, frame };
    return null;
  }
  return null;
}

/** 在 bframe session 内读挑战信息 */
async function readChallenge(connection: CdpPort, sessionId: string): Promise<ChallengeInfo | null> {
  const info = await connection.evaluate<unknown>(CHALLENGE_EXPR, sessionId);
  if (typeof info !== "object" || info === null) return null;
  const record = info as Record<string, unknown>;
  const title = typeof record["title"] === "string" ? record["title"] : "";
  const rawUrl = typeof record["rawUrl"] === "string" && record["rawUrl"] ? record["rawUrl"] : null;
  return { title, rawUrl, tiles: rectList(record["tiles"]) };
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

/** 通过判据：path 不含 recaptcha 或拿到 token（不看任何 act() / 打码 API 的成功返回） */
function hasPassed(state: PageState): boolean {
  return !state.path.includes("recaptcha") || state.hasToken;
}

/** 轮询「页面已通过」或「出现图片网格」；两者都没有则超时 */
async function waitForResolution(
  connection: CdpPort,
  sleep: (ms: number) => Promise<void>,
  attempts: number,
  intervalMs: number,
): Promise<WaitOutcome> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readPageState(connection);
    if (!state) return { kind: "cdp_failed" };
    if (hasPassed(state)) return { kind: "passed" };
    const grid = await findGrid(connection);
    if (grid) return { kind: "grid", grid };
    if (attempt < attempts - 1) await sleep(intervalMs);
  }
  return { kind: "timeout" };
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
 * 下载原始图（payload 的 30–50KB JPEG）。
 * 必须用二进制：只有 `text()` 的响应读不出 JPEG（真实 fetch 恒有 `arrayBuffer()`）。
 */
async function downloadImage(
  rawUrl: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  now: () => number,
): Promise<{ ok: true; bytes: number; base64: string; costMs: number } | { ok: false; detail: string }> {
  const started = now();
  try {
    const response = await fetchImpl(rawUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, detail: `下载失败: HTTP ${response.status}` };
    const binary = response as { arrayBuffer?: () => Promise<ArrayBuffer> };
    if (typeof binary.arrayBuffer !== "function") return { ok: false, detail: "下载失败: 响应不支持二进制读取" };
    const bytes = new Uint8Array(await binary.arrayBuffer());
    if (bytes.length === 0) return { ok: false, detail: "下载失败: 原始图为空" };
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

  const frontError = await bringToFront();
  if (frontError) return fail("cdp_failed", frontError);

  let checkboxClicked = false;
  for (let attempt = 1; attempt <= maxRounds; attempt += 1) {
    if (attempt > 1) {
      const retryError = await bringToFront();
      if (retryError) return fail("cdp_failed", retryError);
    }

    let grid = await findGrid(connection);
    if (!grid) {
      if (!checkboxClicked) {
        const anchor = await waitForAnchor(connection, sleep);
        if (!anchor) {
          log("[C] 未找到 reCAPTCHA checkbox（anchor iframe），不打码");
          return fail("no_challenge", "未找到 anchor iframe");
        }
        // 真机：checkbox 在主文档里 anchor iframe 左边缘 +26px、垂直居中
        await connection.mouseClick(anchor.x + 26, anchor.y + Math.round(anchor.h / 2));
        checkboxClicked = true;
        log("[C] 已点击 reCAPTCHA checkbox");
      }

      const outcome = await waitForResolution(connection, sleep, RESOLVE_POLL_ATTEMPTS, RESOLVE_POLL_INTERVAL_MS);
      if (outcome.kind === "cdp_failed") return fail("cdp_failed", "读取页面状态失败");
      if (outcome.kind === "passed") return pass();
      if (outcome.kind === "timeout") {
        log("[C] 等待图片挑战超时（页面仍在验证码页），不打码");
        return fail("no_challenge", "等待图片挑战超时");
      }
      grid = outcome.grid;
    }

    rounds += 1;
    const roundLabel = `第 ${rounds} 轮`;

    const info = await readChallenge(connection, grid.sessionId);
    if (!info) {
      log(`[C] ${roundLabel}: 读取图片挑战信息失败`);
      return fail("cdp_failed", "读取图片挑战信息失败");
    }

    const question = resolveQuestion(info.title);
    if (!question) {
      log(`[C] ${roundLabel}: 挑战对象不在支持词表（不调打码）: "${truncate(info.title, 80)}"`);
      return fail("unsupported_object", truncate(info.title, 150));
    }
    log(`[C] ${roundLabel}图片挑战: "${truncate(info.title, 80)}" 对象=${question.label}(${question.id})`);

    if (!info.rawUrl) {
      log(`[C] ${roundLabel}: 未取到原始图（不调打码）`);
      return fail("no_raw_image", "rawUrl 为空");
    }

    const downloaded = await downloadImage(info.rawUrl, fetchImpl, config.timeoutMs, now);
    if (!downloaded.ok) {
      log(`[C] ${roundLabel}: 未取到原始图（不调打码）: ${downloaded.detail}`);
      return fail("no_raw_image", downloaded.detail);
    }

    const classifyStarted = now();
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
      log(`[C] ${roundLabel}: 打码失败（不继续下一轮）: ${classified.detail}`);
      return fail("api_error", classified.detail);
    }
    log(
      `[C] ${roundLabel}: 下载原图 ${downloaded.bytes} 字节 (${downloaded.costMs}ms) → 打码 ${classifyMs}ms → ` +
        `objects=[${classified.objects.join(",")}] (0-based)`,
    );

    let clickedTiles = 0;
    let droppedTiles = 0;
    for (const index of classified.objects) {
      // 0-based；越界丢弃，绝不点到网格外
      const tile = info.tiles[index];
      if (!tile) {
        droppedTiles += 1;
        continue;
      }
      await connection.mouseClick(grid.frame.x + tile.x + tile.w / 2, grid.frame.y + tile.y + tile.h / 2);
      clickedTiles += 1;
      await sleep(TILE_CLICK_INTERVAL_MS);
    }
    if (droppedTiles > 0) {
      // 4×4 与 3×3 混用时，能一眼看出「打码返回的索引超出网格」，真机排查快得多
      log(
        `[C] ${roundLabel}: 已丢弃 ${droppedTiles} 个越界索引（objects=[${classified.objects.join(",")}]，格子数=${info.tiles.length}）`,
      );
    }

    const verify = await readVerifyButton(connection, grid.sessionId);
    if (!verify) {
      log(`[C] ${roundLabel}: 未找到 Verify 按钮`);
      return fail("cdp_failed", "未找到 Verify 按钮");
    }
    await connection.mouseClick(grid.frame.x + verify.x + verify.w / 2, grid.frame.y + verify.y + verify.h / 2);
    log(`[C] ${roundLabel}: 已点 ${clickedTiles} 格 + Verify，等待结果`);

    const after = await waitForResolution(connection, sleep, VERIFY_POLL_ATTEMPTS, VERIFY_POLL_INTERVAL_MS);
    if (after.kind === "cdp_failed") return fail("cdp_failed", "读取页面状态失败");
    if (after.kind === "passed") return pass();
    // 未通过（换成新网格或超时）→ 进入下一轮
  }

  log(`[C] 已打满 ${maxRounds} 轮图片挑战仍未通过`);
  return fail("not_passed", `已打满 ${maxRounds} 轮图片挑战仍未通过`);
}
