/**
 * src/engine/captcha/solver.ts 的离线测试（假 CdpPort + 假 fetch，零真实浏览器、零真实网络）。
 *
 * 覆盖：checkbox 直接通过（0 轮 / 0 请求）、一轮图片挑战（点击坐标 = bframe 偏移 + 格子偏移 + 半宽半高）、
 * 原始图缺失或不支持对象（打码零调用）、objects 为空 / 越界索引、轮次上限 not_passed、
 * api_error 立即返回、cdp_failed、配置关闭 / 无密钥零 CDP 流量、找不到 checkbox → no_challenge；
 * 以及真机探针（research §6）得出的：弹层收起时的残留格子、动态题补图（single 模式）、
 * 混合格子取原图、静态题开关语义、4×4 连续多页、答错进下一轮、不支持对象先换题。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANCHOR_EXPR,
  BFRAME_RECT_EXPR,
  CHALLENGE_EXPR,
  PAGE_STATE_EXPR,
  TILE_PROBE_EXPR,
  VERIFY_BUTTON_EXPR,
  solveRecaptcha,
} from "../src/engine/captcha/solver.ts";

const RAW_URL = "https://www.google.com/recaptcha/enterprise/payload?p=abc";
const CAPSOLVER_URL = "https://api.capsolver.com/createTask";
const API_KEY = "CapKey-test-1234abcd";
const DEFAULT_CONFIG = { provider: "capsolver", apiKey: API_KEY, enabled: true, maxRounds: 3, timeoutMs: 20000 };

/**
 * 矩形（页面 / iframe 内坐标）
 * @typedef {object} Rect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * 格子（坐标 + 可选的图片 / 状态；缺省 = 原图切片 `-33`、src 跟随 state.rawUrl、未选中、已加载）
 * @typedef {Rect & { cls?: string, src?: string, sel?: boolean, dyn?: boolean, ready?: boolean }} FakeTile
 */

/**
 * 假页面状态（真机形态的简化模型）
 * @typedef {object} RecaptchaState
 * @property {string} path
 * @property {boolean} hasToken
 * @property {Rect | null} anchor
 * @property {Rect & { visible?: boolean }} bframe 弹层位置；`visible:false` = 收起（真机 visibility:hidden）
 * @property {boolean} grid
 * @property {string} title
 * @property {string | null} rawUrl
 * @property {FakeTile[]} tiles
 * @property {Rect | null} verify
 * @property {string[]} [errors] 可见的错误提示类名（Google 判答错）
 * @property {{ w: number, h: number }} [viewport] 视口尺寸；缺省 1280×905
 * @property {"unchecked" | "loading" | "checked"} [checkbox] anchor 里 checkbox 的真实状态；缺省未勾选
 * @property {Rect | null} [reload] 换题按钮位置（缺省为真机实测的 48x48）
 * @property {number} [pageStateFailures] 接下来几次读页面状态返回 null（模拟跨文档跳转时执行上下文短暂不可用）
 */

/** 假 CDP 端口：按表达式子串回答；记录点击、请求与每次 evaluate 的 sessionId 路由 */
class FakeCdp {
  /** @param {RecaptchaState} state */
  constructor(state) {
    /** @type {RecaptchaState} */
    this.state = state;
    /** @type {import("../src/engine/captcha/cdp.ts").CdpSession[]} */
    this.sessionList = [
      { sessionId: "wrk", url: "https://example.com/sw.js" },
      { sessionId: "an", url: "https://www.google.com/recaptcha/enterprise/anchor" },
      { sessionId: "bf", url: "" },
    ];
    /** @type {{ x: number, y: number }[]} */
    this.clicks = [];
    /** @type {Record<string, unknown>[]} */
    this.sends = [];
    /** @type {{ expr: string, sessionId: string | undefined }[]} */
    this.evaluations = [];
    /** @type {Record<string, unknown>} */
    this.sendResult = {};
    /** @type {((x: number, y: number) => void) | null} */
    this.onClick = null;
    /** @type {boolean} */
    this.closed = false;
  }
  get sessions() {
    return this.sessionList;
  }
  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string} [sessionId]
   * @returns {Promise<Record<string, unknown>>}
   */
  async send(method, params = {}, sessionId) {
    this.sends.push({ method, params, sessionId });
    return this.sendResult;
  }
  /**
   * @param {string} expr
   * @param {string} [sessionId]
   * @returns {Promise<any>}
   */
  async evaluate(expr, sessionId) {
    this.evaluations.push({ expr, sessionId });
    const s = this.state;
    if (expr.includes("#recaptcha-anchor")) {
      if (sessionId !== "an") return null;
      const box = s.checkbox ?? "unchecked";
      return { checked: box === "checked", loading: box === "loading" };
    }
    if (expr.includes("recaptcha/enterprise/anchor")) return { path: s.path, anchor: s.anchor };
    if (expr.includes("recaptcha/enterprise/bframe")) return s.bframe;
    if (expr.includes("rc-imageselect-tile img")) {
      if (sessionId !== "bf" || !s.grid) return null;
      return {
        title: s.title,
        rawUrl: s.rawUrl,
        tiles: s.tiles.map((t) => ({
          ...t,
          cls: t.cls ?? "rc-image-tile-33",
          src: t.src ?? s.rawUrl ?? "",
          sel: t.sel ?? false,
          dyn: t.dyn ?? false,
          ready: t.ready ?? true,
        })),
        errors: s.errors ?? [],
      };
    }
    if (expr.includes("rc-imageselect-tile")) return sessionId === "bf" && s.grid ? s.tiles.length : 0;
    if (expr.includes("recaptcha-verify-button")) {
      if (sessionId !== "bf" || !s.grid) return null;
      return s.verify;
    }
    if (expr.includes("#recaptcha-reload-button")) {
      if (sessionId !== "bf" || !s.grid) return null;
      return s.reload === undefined ? { x: 6, y: 558, w: 48, h: 48 } : s.reload;
    }
    if (expr.includes("innerWidth")) return s.viewport ?? { w: 1280, h: 905 };
    if (expr.includes("g-recaptcha-response")) {
      if ((s.pageStateFailures ?? 0) > 0) {
        s.pageStateFailures = (s.pageStateFailures ?? 0) - 1;
        return null;
      }
      return { path: s.path, hasToken: s.hasToken };
    }
    return null;
  }
  /**
   * @param {number} x
   * @param {number} y
   */
  async mouseClick(x, y) {
    this.clicks.push({ x, y });
    if (this.onClick) this.onClick(x, y);
  }
  /** @param {(msg: Record<string, unknown>) => void} fn */
  on(fn) {
    void fn;
  }
  close() {
    this.closed = true;
  }
}

/** @param {Partial<RecaptchaState>} [overrides] @returns {RecaptchaState} */
function recaptchaState(overrides = {}) {
  return {
    path: "/v3/signin/challenge/recaptcha",
    hasToken: false,
    anchor: { x: 78, y: 70, w: 70, h: 52 },
    bframe: { x: 100, y: 200, w: 300, h: 400 },
    grid: false,
    title: "Select all images with bicycles Click verify once there are none left",
    rawUrl: RAW_URL,
    tiles: [
      { x: 10, y: 20, w: 100, h: 80 },
      { x: 120, y: 20, w: 100, h: 80 },
      { x: 230, y: 20, w: 100, h: 80 },
      { x: 340, y: 20, w: 100, h: 80 },
    ],
    verify: { x: 40, y: 300, w: 88, h: 36 },
    ...overrides,
  };
}

/** 注入时钟：第一次取 100，之后固定 250 → 成功路径 costMs 恒为 150 */
function clock() {
  const seq = [100, 250];
  return () => seq.shift() ?? 250;
}
/**
 * 记录请求的假 fetch：
 *   - 原图 URL 返回 2048 字节二进制；`singles` 里的单图 URL 返回「URL 本身的字节」（便于按图作答）
 *   - CapSolver：请求图片解码后命中 `singles` → single 形态 `{hasObject}`；否则 multi 形态 `{objects}`
 *     （`objectsQueue` 按调用顺序逐次取，取完回落到 `objects`）
 * @param {{ objects?: number[], objectsQueue?: number[][], singles?: Record<string, boolean>, singleError?: boolean,
 *           errorId?: number, errorCode?: string, errorDescription?: string, imageStatus?: number, imageThrows?: boolean }} [plan]
 */
function fakeFetch(plan = {}) {
  /** @type {{ url: string, init: any, body: any }[]} */
  const calls = [];
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const singles = plan.singles ?? {};
  const queue = [...(plan.objectsQueue ?? [])];
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fn = async (url, init) => {
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (url === CAPSOLVER_URL) {
      const imageText = Buffer.from(String(body?.task?.image ?? ""), "base64").toString();
      const isSingle = Object.prototype.hasOwnProperty.call(singles, imageText);
      if (isSingle && plan.singleError) {
        const payload = JSON.stringify({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE", errorDescription: "no balance" });
        return { ok: true, status: 200, text: async () => payload };
      }
      const solution = isSingle
        ? { type: "single", hasObject: singles[imageText], size: 1 }
        : { objects: queue.length > 0 ? queue.shift() : (plan.objects ?? [0]), size: 4, type: "multi" };
      const payload = JSON.stringify({
        errorId: plan.errorId ?? 0,
        ...(plan.errorCode ? { errorCode: plan.errorCode } : {}),
        ...(plan.errorDescription ? { errorDescription: plan.errorDescription } : {}),
        status: "ready",
        solution,
      });
      return { ok: true, status: 200, text: async () => payload };
    }
    if (plan.imageThrows) throw new Error("HTTP 403");
    const status = plan.imageStatus ?? 200;
    const data = Object.prototype.hasOwnProperty.call(singles, url) ? new Uint8Array(Buffer.from(url)) : bytes;
    const res = { ok: status === 200, status, text: async () => "", arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
    return res;
  };
  return { calls, fn, bytes };
}

/**
 * @param {import("../src/engine/captcha/cdp.ts").CdpPort} connection
 * @param {Partial<import("../src/engine/captcha/solver.ts").SolveRecaptchaOptions>} [extra]
 * @returns {Promise<import("../src/engine/captcha/types.ts").CaptchaSolveResult>}
 */
function solve(connection, extra = {}) {
  return solveRecaptcha({ connection, config: DEFAULT_CONFIG, sleep: async () => {}, now: clock(), ...extra });
}

test("使用真机验证过的 JS 表达式原文（research §2）", () => {
  assert.ok(ANCHOR_EXPR.includes("recaptcha/enterprise/anchor"), ANCHOR_EXPR);
  assert.ok(ANCHOR_EXPR.includes("r.width > 10"), ANCHOR_EXPR);
  assert.ok(ANCHOR_EXPR.includes("Math.round(r.x)"), ANCHOR_EXPR);
  assert.ok(BFRAME_RECT_EXPR.includes("recaptcha/enterprise/bframe"), BFRAME_RECT_EXPR);
  assert.ok(BFRAME_RECT_EXPR.includes("f.getBoundingClientRect()"), BFRAME_RECT_EXPR);
  assert.ok(TILE_PROBE_EXPR.includes(".rc-imageselect-tile"), TILE_PROBE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes('img[src*="recaptcha/enterprise/payload"]'), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("/\\s+/g"), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("td.getBoundingClientRect()"), CHALLENGE_EXPR);
  assert.ok(VERIFY_BUTTON_EXPR.includes("#recaptcha-verify-button"), VERIFY_BUTTON_EXPR);
  assert.ok(VERIFY_BUTTON_EXPR.includes("r.width < 5"), VERIFY_BUTTON_EXPR);
  assert.ok(PAGE_STATE_EXPR.includes('textarea[name="g-recaptcha-response"], #g-recaptcha-response'), PAGE_STATE_EXPR);
  assert.ok(PAGE_STATE_EXPR.includes("ta.value.length > 20"), PAGE_STATE_EXPR);
  // 真机探针（research §6）补充的判据：弹层可见性、单图格子、动态淡出、静态选中、错误提示
  assert.ok(BFRAME_RECT_EXPR.includes("visibility !== 'hidden'"), BFRAME_RECT_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("rc-image-tile-11"), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("rc-imageselect-dynamic-selected"), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("rc-imageselect-tileselected"), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("rc-imageselect-error"), CHALLENGE_EXPR);
  assert.ok(CHALLENGE_EXPR.includes("rc-imageselect-incorrect-response"), CHALLENGE_EXPR);
});

test("checkbox 直接通过：ok:true, rounds:0，打码与图片下载零请求", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch();
  const logs = [];
  cdp.onClick = () => {
    // 环境「热」：点完 checkbox 页面直接离开验证码页
    if (cdp.clicks.length === 1) state.path = "/v3/signin/challenge/pwd";
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 0, costMs: 150 });
  assert.deepEqual(cdp.clicks, [{ x: 104, y: 96 }], "anchor 左边缘 +26px、垂直居中：78+26, 70+52/2");
  assert.equal(fetchRec.calls.length, 0, "打码 API 与图片下载都必须零请求");
  assert.equal(cdp.sends.filter((s) => s.method === "Page.bringToFront").length, 1);
  assert.ok(logs.some((m) => m.includes("人机验证已通过（0 轮")), JSON.stringify(logs));
  assert.ok(logs.every((m) => !m.includes(API_KEY)));
});

test("一轮图片挑战：读原始图 → 打码 → 按 bframe 偏移点格子中心 → 点 Verify → 通过", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0, 2] });
  const logs = [];
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true; // 点 checkbox → 出图片网格
    if (cdp.clicks.length === 4) state.path = "/v3/signin/challenge/pwd"; // 点 Verify → 通过
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(
    cdp.clicks,
    [
      { x: 104, y: 96 }, // checkbox：78+26, 70+52/2
      { x: 160, y: 260 }, // 格子 0：bframe(100,200) + (10,20) + 半宽半高(50,40)
      { x: 380, y: 260 }, // 格子 2：100+230+50, 200+20+40
      { x: 184, y: 518 }, // Verify：100+40+44, 200+300+18（必须加 bframe 偏移）
    ],
    "点击坐标 = bframe 偏移 + 元素在 iframe 内的偏移 + 半宽/半高",
  );
  assert.equal(fetchRec.calls.length, 2);
  assert.equal(fetchRec.calls[0]?.url, RAW_URL);
  assert.equal(fetchRec.calls[1]?.url, CAPSOLVER_URL);
  assert.deepEqual(fetchRec.calls[1]?.body, {
    clientKey: API_KEY,
    task: { type: "ReCaptchaV2Classification", image: Buffer.from(fetchRec.bytes).toString("base64"), question: "/m/0199g" },
  });
  const verifyRead = cdp.evaluations.find((e) => e.expr.includes("recaptcha-verify-button"));
  assert.equal(verifyRead?.sessionId, "bf", "Verify 位置必须在 bframe session 内读");
  const challengeRead = cdp.evaluations.find((e) => e.expr.includes("rc-imageselect-tile img"));
  assert.equal(challengeRead?.sessionId, "bf", "挑战信息在 bframe session 内读");
  const frameRead = cdp.evaluations.find((e) => e.expr.includes("recaptcha/enterprise/bframe"));
  assert.equal(frameRead?.sessionId, undefined, "bframe iframe 位置在主文档读（页面级）");
  assert.ok(logs.some((m) => m.includes('第 1 轮图片挑战: "Select all images with bicycles') && m.includes("对象=bicycles(/m/0199g)")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("下载原图 2048 字节") && m.includes("objects=[0,2] (0-based)")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("已点 2 格 + Verify")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("人机验证已通过（1 轮")), JSON.stringify(logs));
  assert.ok(logs.every((m) => !m.includes(API_KEY)), "日志里不得出现密钥");
});

test("取不到原始图（rawUrl 为空）→ no_raw_image，打码零调用", { timeout: 5000 }, async () => {
  const state = recaptchaState({ rawUrl: null });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch();
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: false, reason: "no_raw_image", detail: "rawUrl 为空", rounds: 1 });
  assert.equal(fetchRec.calls.length, 0, "没有原始图时一个请求都不许发");
});

test("原始图下载失败 → no_raw_image，打码零调用", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ imageThrows: true });
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: false, reason: "no_raw_image", detail: "下载失败: HTTP 403", rounds: 1 });
  assert.equal(fetchRec.calls.filter((c) => c.url === CAPSOLVER_URL).length, 0, "不许调用打码 API");
  assert.equal(cdp.clicks.length, 1, "只点了 checkbox");
});

test("挑战对象不在词表 → unsupported_object，打码零调用", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: "Click verify once there are none left" });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch();
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: false, reason: "unsupported_object", detail: "Click verify once there are none left", rounds: 1 });
  assert.equal(fetchRec.calls.length, 0, "不支持的对象：连原始图都不下载");
});

test("objects 为空（一张都没有）：不点格子但仍点 Verify", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [] });
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
    if (cdp.clicks.length === 2) state.path = "/v3/signin/challenge/pwd";
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [{ x: 104, y: 96 }, { x: 184, y: 518 }], "空 objects：直接 Verify");
});

test("越界索引被丢弃：objects=[1,99] 只点格子 1，仍点 Verify", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [1, 99] });
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
    if (cdp.clicks.length === 3) state.path = "/v3/signin/challenge/pwd";
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [
    { x: 104, y: 96 },
    { x: 270, y: 260 }, // 格子 1：100+120+50, 200+20+40（99 越界，丢弃）
    { x: 184, y: 518 },
  ]);
});

test("一直不通过 → not_passed，rounds === maxRounds（3），每轮只点一次 Verify", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  const logs = [];
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true; // 网格一直刷新，页面始终停在验证码页
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: false, reason: "not_passed", detail: "已打满 3 轮图片挑战仍未通过", rounds: 3 });
  assert.equal(fetchRec.calls.filter((c) => c.url === CAPSOLVER_URL).length, 3);
  assert.equal(cdp.clicks.length, 7, "checkbox + 3 × (1 格 + Verify)");
  assert.deepEqual(cdp.clicks[0], { x: 104, y: 96 });
  assert.equal(cdp.clicks.filter((c) => c.y === 518).length, 3, "每轮恰好点一次 Verify");
  assert.ok(logs.some((m) => m.includes("第 3 轮图片挑战")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("已打满 3 轮图片挑战仍未通过")), JSON.stringify(logs));
});

test("中途 api_error：立即返回，不空烧剩余轮次", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ errorId: 1, errorCode: "ERROR_NO_BALANCE", errorDescription: "Insufficient balance" });
  const logs = [];
  cdp.onClick = () => {
    if (cdp.clicks.length === 1) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: false, reason: "api_error", detail: "ERROR_NO_BALANCE: Insufficient balance", rounds: 1 });
  assert.equal(fetchRec.calls.filter((c) => c.url === CAPSOLVER_URL).length, 1, "只烧 1 次，不继续下一轮");
  assert.equal(cdp.clicks.length, 1, "打码失败：不点格子也不点 Verify");
  assert.equal(result.ok === false && result.detail.includes(API_KEY), false);
  assert.ok(logs.some((m) => m.includes("打码失败")), JSON.stringify(logs));
});

test("CDP 返回 __error → cdp_failed（不做任何点击、不发任何请求）", { timeout: 5000 }, async () => {
  const cdp = new FakeCdp(recaptchaState());
  const fetchRec = fakeFetch();
  cdp.sendResult = { __error: "timeout" };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: false, reason: "cdp_failed", detail: "timeout", rounds: 0 });
  assert.equal(cdp.clicks.length, 0);
  assert.equal(fetchRec.calls.length, 0);
});

test("配置关闭 / 无密钥：直接失败，零 CDP 流量、零请求", { timeout: 5000 }, async () => {
  const cdp = new FakeCdp(recaptchaState());
  const fetchRec = fakeFetch();
  const disabled = await solve(cdp, {
    config: { provider: "capsolver", apiKey: API_KEY, enabled: false, maxRounds: 3, timeoutMs: 20000 },
    fetchImpl: fetchRec.fn,
  });
  assert.deepEqual(disabled, { ok: false, reason: "disabled", rounds: 0 });
  const noKey = await solve(cdp, {
    config: { provider: "capsolver", apiKey: "", enabled: true, maxRounds: 3, timeoutMs: 20000 },
    fetchImpl: fetchRec.fn,
  });
  assert.deepEqual(noKey, { ok: false, reason: "no_api_key", rounds: 0 });
  assert.equal(cdp.sends.length, 0, "零 CDP 流量");
  assert.equal(fetchRec.calls.length, 0, "零请求");
});

test("页面上没有 checkbox → no_challenge（12 × 2.5s 轮询后放弃）", { timeout: 5000 }, async () => {
  const state = recaptchaState({ anchor: null });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch();
  /** @type {number[]} */
  const sleeps = [];
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(result, { ok: false, reason: "no_challenge", detail: "未找到 anchor iframe", rounds: 0 });
  assert.equal(cdp.clicks.length, 0);
  assert.equal(fetchRec.calls.length, 0);
  assert.equal(sleeps.length, 11, "轮询 12 次之间睡 11 次");
  assert.ok(sleeps.every((ms) => ms === 2500), JSON.stringify(sleeps));
});

// ==================== 真机探针回归（research §6：公共演示页实测的 reCAPTCHA 形态） ====================

const CHECKBOX = { x: 104, y: 96 };
/** 与 solver 的 CHECKBOX_CLICK_ATTEMPTS 对齐：点击无正面证据时的重点次数上限 */
const CHECKBOX_ATTEMPTS = 3;
const VERIFY = { x: 184, y: 518 };
/** bframe(100,200) + 换一题按钮(6,558,48x48) 的中心页坐标 */
const RELOAD_POINT = { x: 130, y: 782 };
const PWD_PATH = "/v3/signin/challenge/pwd";
const RAW2 = "https://www.google.com/recaptcha/enterprise/payload?p=page2";
const BICYCLES = "Select all images with bicycles Click verify once there are none left";

/** 页坐标 → 格子下标（bframe(100,200) + 格子 (10/120/230/340, 20) + 半宽半高 (50,40)） */
function tileAt(x, y) {
  return y === 260 ? [160, 270, 380, 490].indexOf(x) : -1;
}
/** @param {{x:number,y:number}} p @param {{x:number,y:number}} q */
const same = (p, q) => p.x === q.x && p.y === q.y;
/** @param {{ calls: { url: string, body: any }[] }} rec */
const capsolverCalls = (rec) => rec.calls.filter((c) => c.url === CAPSOLVER_URL);
/** CapSolver 请求里的图片解码回文本（单图在假 fetch 里就是 URL 本身的字节） */
const judgedImages = (rec) => capsolverCalls(rec).map((c) => Buffer.from(String(c.body.task.image), "base64").toString());
/**
 * 改写某一格（模拟 Google 换图 / 淡出）；下标不存在直接抛错，避免静默改错格
 * @param {RecaptchaState} state @param {number} index @param {Partial<FakeTile>} patch
 */
function patchTile(state, index, patch) {
  const tile = state.tiles[index];
  if (!tile) throw new Error(`没有第 ${index} 格`);
  state.tiles[index] = { ...tile, ...patch };
}

test("弹层收起（visibility:hidden、y=-9999）时 DOM 里的残留格子不算挑战：先点 checkbox，弹层展开后再打码", { timeout: 5000 }, async () => {
  const state = recaptchaState({ grid: true, bframe: { x: 1, y: -9999, w: 400, h: 580, visible: false } });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.bframe = { x: 100, y: 200, w: 300, h: 400, visible: true };
    if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 160, y: 260 }, VERIFY], "先 checkbox，弹层展开后才点格子与 Verify");
  assert.equal(capsolverCalls(fetchRec).length, 1);
});

test("弹层一直收起（visibility:hidden 或只停在 y=-9999）：点击无正面证据 → 有界重点，仍不下载不打码，超时 → no_challenge", { timeout: 5000 }, async () => {
  for (const bframe of [
    { x: 1, y: -9999, w: 400, h: 580, visible: false },
    { x: 1, y: -9999, w: 400, h: 580, visible: true },
  ]) {
    const state = recaptchaState({ grid: true, bframe });
    const cdp = new FakeCdp(state);
    const fetchRec = fakeFetch({ objects: [0] });
    const logs = [];
    const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
    assert.deepEqual(result, { ok: false, reason: "no_challenge", detail: "等待图片挑战超时", rounds: 0 }, JSON.stringify(bframe));
    assert.equal(fetchRec.calls.length, 0, "隐藏弹层：一个请求都不许发");
    assert.deepEqual(cdp.clicks, [CHECKBOX, CHECKBOX, CHECKBOX], "隐藏弹层里的格子一个都不点；checkbox 无证据时有界重点 " + CHECKBOX_ATTEMPTS + " 次");
    assert.ok(logs.some((m) => m.includes("次点击 checkbox 都没有反应")), JSON.stringify(logs));
  }
});

test("Verify 后弹层收起（挑战过期）→ 算一轮未通过，重新点 checkbox 开下一轮", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  const logs = [];
  let verifies = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) {
      state.grid = true;
      state.bframe = { x: 100, y: 200, w: 300, h: 400, visible: true };
      if (verifies === 1) state.rawUrl = RAW2;
    }
    if (same({ x, y }, VERIFY)) {
      verifies += 1;
      if (verifies === 1) state.bframe = { x: 1, y: -9999, w: 400, h: 580, visible: false };
      else state.path = PWD_PATH;
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 2, costMs: 150 });
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 160, y: 260 }, VERIFY, CHECKBOX, { x: 160, y: 260 }, VERIFY]);
  assert.ok(logs.some((m) => m.includes("第 1 轮: 未通过（验证弹层已收起）")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("重新点击 checkbox（第 2 次）")), JSON.stringify(logs));
});

test("动态题：点过的格子换成 100×100 新图 → 逐张 single 识别 → 命中再点 → 没有了才点 Verify", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: BICYCLES });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0, 2], singles: { "new-0-1": true, "new-2-1": false, "new-0-2": false } });
  const logs = [];
  /** @type {Record<number, number>} */
  const gen = {};
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    else if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
    else {
      const i = tileAt(x, y);
      if (i >= 0) {
        gen[i] = (gen[i] ?? 0) + 1;
        patchTile(state, i, { cls: "rc-image-tile-11", src: `new-${i}-${gen[i]}` });
      }
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(
    cdp.clicks,
    [CHECKBOX, { x: 160, y: 260 }, { x: 380, y: 260 }, { x: 160, y: 260 }, VERIFY],
    "格子 0、2 → 新图 0 命中再点 → 新图都没有了 → Verify",
  );
  assert.deepEqual(judgedImages(fetchRec).slice(1), ["new-0-1", "new-2-1", "new-0-2"], "每张新图单独送 single");
  assert.equal(capsolverCalls(fetchRec).length, 4, "1 次 multi + 3 次 single");
  assert.ok(capsolverCalls(fetchRec).every((c) => c.body.task.question === "/m/0199g"));
  assert.ok(logs.some((m) => m.includes("动态补图第 1 波: 新图 [0,2] → 命中 [0]")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("动态补图第 2 波: 新图 [0] → 命中 []")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("已点 3 格 + Verify")), "补点的格子计入总数");
});

test("动态题：格子还在淡出（dyn）时不识别，等新图出现再送 single", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: BICYCLES });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [1], singles: { "late-1": false } });
  let fading = false;
  let ticks = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    else if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
    else if (tileAt(x, y) === 1) {
      patchTile(state, 1, { dyn: true });
      fading = true;
    }
  };
  /** @param {number} ms */
  const sleep = async (ms) => {
    if (!fading || ms !== 500) return;
    ticks += 1;
    if (ticks === 4) {
      patchTile(state, 1, { dyn: false, cls: "rc-image-tile-11", src: "late-1" });
      fading = false;
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, sleep });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.equal(ticks, 4, "淡出期间一直在等");
  assert.deepEqual(judgedImages(fetchRec).slice(1), ["late-1"], "只识别换上来的新图，不拿淡出中的旧图打码");
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 270, y: 260 }, VERIFY]);
});

test("答错后部分格子已是单图（-11）：原图只取 -33 格子，-11 格子逐张 single，multi 指向单图格子的索引丢弃", { timeout: 5000 }, async () => {
  const state = recaptchaState({
    title: BICYCLES,
    errors: ["rc-imageselect-error-dynamic-more"],
    rawUrl: "new-0", // 旧表达式会把第 0 格（已是新图）当成原图
    tiles: [
      { x: 10, y: 20, w: 100, h: 80, cls: "rc-image-tile-11", src: "new-0" },
      { x: 120, y: 20, w: 100, h: 80, src: RAW_URL },
      { x: 230, y: 20, w: 100, h: 80, src: RAW_URL },
      { x: 340, y: 20, w: 100, h: 80, cls: "rc-image-tile-11", src: "new-3" },
    ],
  });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0, 2], singles: { "new-0": true, "new-3": false } });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.equal(fetchRec.calls.filter((c) => c.url === RAW_URL).length, 1, "原图取自 -33 格子");
  assert.equal(capsolverCalls(fetchRec)[0]?.body.task.image, Buffer.from(fetchRec.bytes).toString("base64"), "multi 送的是原图");
  assert.deepEqual(judgedImages(fetchRec).slice(1), ["new-0", "new-3"]);
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 160, y: 260 }, { x: 380, y: 260 }, VERIFY], "单图命中的 0 + 原图命中的 2");
});

test("静态题格子是开关：已选中的正确格子不再点，选错的点掉", { timeout: 5000 }, async () => {
  const state = recaptchaState({
    title: "Select all squares with bicycles If there are none, click skip",
    tiles: [
      { x: 10, y: 20, w: 100, h: 80, sel: true },
      { x: 120, y: 20, w: 100, h: 80, sel: true },
      { x: 230, y: 20, w: 100, h: 80 },
      { x: 340, y: 20, w: 100, h: 80 },
    ],
  });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0, 2] });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 270, y: 260 }, { x: 380, y: 260 }, VERIFY], "取消 1、选中 2，0 保持");
});

test("4×4 连续多页（无错误提示、图片换了 = 下一页）：换页不算新一轮", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objectsQueue: [[0], [1]] });
  const logs = [];
  let verifies = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) {
      verifies += 1;
      if (verifies === 1) state.rawUrl = RAW2;
      else state.path = PWD_PATH;
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 160, y: 260 }, VERIFY, { x: 270, y: 260 }, VERIFY]);
  assert.deepEqual(
    fetchRec.calls.filter((c) => c.url !== CAPSOLVER_URL).map((c) => c.url),
    [RAW_URL, RAW2],
  );
  assert.ok(logs.some((m) => m.includes("第 1 轮: 进入下一页")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("第 1 轮第 2 页图片挑战")), JSON.stringify(logs));
});

test("答错（出现错误提示）→ 本轮结束，下一轮重新识别", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  const logs = [];
  let verifies = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) {
      verifies += 1;
      if (verifies === 1) {
        state.errors = ["rc-imageselect-incorrect-response"];
        state.rawUrl = RAW2;
      } else {
        state.path = PWD_PATH;
      }
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 2, costMs: 150 });
  assert.equal(capsolverCalls(fetchRec).length, 2);
  assert.ok(logs.some((m) => m.includes("第 1 轮: 未通过（答案被判错）")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("第 2 轮图片挑战")), JSON.stringify(logs));
});

test("挑战对象不在词表 → 先点「换一题」（不花钱），换到支持的对象再打码", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: "Select all images with vehicles" });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, RELOAD_POINT)) state.title = BICYCLES;
    if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.deepEqual(cdp.clicks, [CHECKBOX, RELOAD_POINT, { x: 160, y: 260 }, VERIFY]);
  assert.equal(capsolverCalls(fetchRec).length, 1, "换题前一次都不打码");
  assert.equal(capsolverCalls(fetchRec)[0]?.body.task.question, "/m/0199g");
});

test("单图识别报错 → api_error 立即返回，不点任何格子", { timeout: 5000 }, async () => {
  const state = recaptchaState({
    tiles: [
      { x: 10, y: 20, w: 100, h: 80 },
      { x: 120, y: 20, w: 100, h: 80, cls: "rc-image-tile-11", src: "new-1" },
      { x: 230, y: 20, w: 100, h: 80 },
      { x: 340, y: 20, w: 100, h: 80 },
    ],
  });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [], singles: { "new-1": true }, singleError: true });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: false, reason: "api_error", detail: "ERROR_ZERO_BALANCE: no balance", rounds: 1 });
  assert.deepEqual(cdp.clicks, [CHECKBOX]);
});

test("弹层可见但在视口外（窗口太小）→ off_viewport：不下载、不打码", { timeout: 5000 }, async () => {
  const state = recaptchaState({ viewport: { w: 1280, h: 150 } });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.equal(result.ok === false && result.reason, "off_viewport", JSON.stringify(result));
  assert.equal(fetchRec.calls.length, 0);
  assert.deepEqual(cdp.clicks, [CHECKBOX]);
});

// ==================== 审查回归（code-reviewer 发现的问题） ====================

test("上一轮残留的错误提示不算新结论：点 Verify 后页面没变 → 页面无变化，不是答错", { timeout: 5000 }, async () => {
  const state = recaptchaState({ errors: ["rc-imageselect-incorrect-response"] });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [] }); // 一格不点：残留提示一直显示
  const logs = [];
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m), config: { ...DEFAULT_CONFIG, maxRounds: 1 } });
  assert.deepEqual(result, { ok: false, reason: "not_passed", detail: "已打满 1 轮图片挑战仍未通过", rounds: 1 });
  assert.ok(logs.some((m) => m.includes("第 1 轮: 未通过（页面无变化）")), JSON.stringify(logs));
  assert.ok(!logs.some((m) => m.includes("答案被判错")), "残留提示不能当成本次答错");
});

test("残留提示消失后又出现 / 出现新的提示类名 → 判答错", { timeout: 5000 }, async () => {
  const state = recaptchaState({ errors: ["rc-imageselect-error-select-more"] });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [] });
  const logs = [];
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) state.errors = ["rc-imageselect-incorrect-response"];
  };
  await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m), config: { ...DEFAULT_CONFIG, maxRounds: 1 } });
  assert.ok(logs.some((m) => m.includes("第 1 轮: 未通过（答案被判错）")), JSON.stringify(logs));
});

test("动态补图中途弹层收起（挑战过期）→ 不给残留格子打码，本轮结束，重新点 checkbox", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: BICYCLES });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0], singles: { "stale-0": true, "new-0": false } });
  const logs = [];
  let tileClicks = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) {
      state.grid = true;
      state.bframe = { x: 100, y: 200, w: 300, h: 400, visible: true };
      patchTile(state, 0, { cls: "rc-image-tile-33", src: RAW_URL });
    } else if (same({ x, y }, VERIFY)) {
      state.path = PWD_PATH;
    } else if (tileAt(x, y) === 0) {
      tileClicks += 1;
      if (tileClicks === 1) {
        // 第一次点完：换上新图，但挑战同时过期，弹层收起
        patchTile(state, 0, { cls: "rc-image-tile-11", src: "stale-0" });
        state.bframe = { x: 1, y: -9999, w: 400, h: 580, visible: false };
      } else {
        patchTile(state, 0, { cls: "rc-image-tile-11", src: "new-0" });
      }
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 2, costMs: 150 });
  assert.ok(!judgedImages(fetchRec).includes("stale-0"), "收起的弹层里的格子不许花钱识别");
  assert.deepEqual(cdp.clicks, [CHECKBOX, { x: 160, y: 260 }, CHECKBOX, { x: 160, y: 260 }, VERIFY]);
  assert.ok(logs.some((m) => m.includes("验证弹层中途收起")), JSON.stringify(logs));
  assert.ok(!logs.some((m) => m.includes("视口外")), "收起不是「视口外」");
});

test("reCAPTCHA 嵌在普通页面（起始 path 不含 recaptcha）：没拿到 token 不算通过；拿到 token 才通过", { timeout: 5000 }, async () => {
  const stuck = recaptchaState({ path: "/v3/signin/identifier" });
  const stuckRec = fakeFetch();
  const stuckResult = await solve(new FakeCdp(stuck), { fetchImpl: stuckRec.fn });
  assert.deepEqual(stuckResult, { ok: false, reason: "no_challenge", detail: "等待图片挑战超时", rounds: 0 }, "旧判据会直接判通过");

  const state = recaptchaState({ path: "/v3/signin/identifier" });
  const cdp = new FakeCdp(state);
  cdp.onClick = () => {
    state.hasToken = true;
  };
  const result = await solve(cdp, { fetchImpl: fakeFetch().fn });
  assert.deepEqual(result, { ok: true, rounds: 0, costMs: 150 });
});

test("页面状态读失败：短暂失败（跳转中）容忍后判通过；持续失败才 cdp_failed", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  cdp.onClick = () => {
    state.path = PWD_PATH;
    state.pageStateFailures = 2;
  };
  const result = await solve(cdp, { fetchImpl: fakeFetch().fn });
  assert.deepEqual(result, { ok: true, rounds: 0, costMs: 150 });

  const broken = recaptchaState();
  const brokenCdp = new FakeCdp(broken);
  brokenCdp.onClick = () => {
    broken.pageStateFailures = 99;
  };
  const failed = await solve(brokenCdp, { fetchImpl: fakeFetch().fn });
  assert.deepEqual(failed, { ok: false, reason: "cdp_failed", detail: "读取页面状态失败", rounds: 0 });
});

test("只有单图格子在 Verify 之后才换图（原图没变）→ 不算下一页", { timeout: 5000 }, async () => {
  const state = recaptchaState({
    tiles: [
      { x: 10, y: 20, w: 100, h: 80 },
      { x: 120, y: 20, w: 100, h: 80, cls: "rc-image-tile-11", src: "late-1" },
      { x: 230, y: 20, w: 100, h: 80 },
      { x: 340, y: 20, w: 100, h: 80 },
    ],
  });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [], singles: { "late-1": false } });
  const logs = [];
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) patchTile(state, 1, { src: "late-1b" });
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m), config: { ...DEFAULT_CONFIG, maxRounds: 1 } });
  assert.equal(result.ok === false && result.reason, "not_passed", JSON.stringify(result));
  assert.ok(!logs.some((m) => m.includes("进入下一页")), JSON.stringify(logs));
  assert.ok(logs.some((m) => m.includes("未通过（页面无变化）")), JSON.stringify(logs));
});

test("打码次数硬上限（含整图 multi）：连续换页也最多 40 次，超了 → round_limit", { timeout: 10000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [] });
  let pagesSeen = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) {
      pagesSeen += 1;
      state.rawUrl = `${RAW_URL}&page=${pagesSeen}`; // 永远「下一页」
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, config: { ...DEFAULT_CONFIG, maxRounds: 10 } });
  assert.equal(result.ok === false && result.reason, "round_limit", JSON.stringify(result));
  assert.equal(capsolverCalls(fetchRec).length, 40);
});

test("每轮最多 5 页：连续换页满 5 页算一轮未通过，打满轮次 → not_passed", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [] });
  const logs = [];
  let pagesSeen = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    if (same({ x, y }, VERIFY)) {
      pagesSeen += 1;
      state.rawUrl = `${RAW_URL}&page=${pagesSeen}`;
    }
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m), config: { ...DEFAULT_CONFIG, maxRounds: 2 } });
  assert.deepEqual(result, { ok: false, reason: "not_passed", detail: "已打满 2 轮图片挑战仍未通过", rounds: 2 });
  assert.equal(capsolverCalls(fetchRec).length, 10, "2 轮 × 5 页");
  assert.equal(logs.filter((m) => m.includes("已连续 5 页")).length, 2, JSON.stringify(logs));
});

test("不支持的对象换题最多 3 次，仍不支持 → unsupported_object", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: "Select all images with vehicles" });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch();
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.equal(result.ok === false && result.reason, "unsupported_object", JSON.stringify(result));
  assert.equal(cdp.clicks.filter((c) => same(c, RELOAD_POINT)).length, 3);
  assert.equal(fetchRec.calls.length, 0);
});

test("补图期间整张网格被换掉（仍是 -33 原图切片）→ 不当成单图送 single，直接去点 Verify", { timeout: 5000 }, async () => {
  const state = recaptchaState({ title: BICYCLES });
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) state.grid = true;
    else if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
    else if (tileAt(x, y) === 0) state.rawUrl = RAW2; // 所有格子的 src 跟着 rawUrl 变，但裁切类型仍是 -33
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.equal(capsolverCalls(fetchRec).length, 1, "只有第一次整图 multi，没有把新原图当单图送 single");
});

// ==================== 真机缺陷回归：checkbox 点击被吞（窗口 77，2026-09-26 14:29） ====================

test("第一次点 checkbox 没有任何反应（widget 还没接管点击）→ 有界重点，第二次出现挑战后照常打码", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  const fetchRec = fakeFetch({ objects: [0] });
  const logs = [];
  let boxClicks = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) {
      boxClicks += 1;
      if (boxClicks === 2) state.grid = true; // 第二次点击才被 widget 收到
      return;
    }
    if (same({ x, y }, VERIFY)) state.path = PWD_PATH;
  };
  const result = await solve(cdp, { fetchImpl: fetchRec.fn, log: (m) => logs.push(m) });
  assert.deepEqual(result, { ok: true, rounds: 1, costMs: 150 });
  assert.equal(boxClicks, 2, "第一次被吞 → 第二次生效");
  assert.deepEqual(cdp.clicks, [CHECKBOX, CHECKBOX, { x: 160, y: 260 }, VERIFY]);
  assert.ok(logs.some((m) => m.includes("上一次点击没有任何反应，重新点击 checkbox（第 2 次）")), JSON.stringify(logs));
});

test("点击后 checkbox 转入转圈/已勾选（热环境直接放行）→ 不再重复点，等页面自己跳走", { timeout: 5000 }, async () => {
  const state = recaptchaState();
  const cdp = new FakeCdp(state);
  let boxClicks = 0;
  let sleeps = 0;
  cdp.onClick = (x, y) => {
    if (same({ x, y }, CHECKBOX)) {
      boxClicks += 1;
      state.checkbox = "loading";
    }
  };
  /** @param {number} ms */
  const sleep = async (ms) => {
    void ms;
    sleeps += 1;
    if (sleeps === 8) state.path = PWD_PATH; // 稍后自己跳走：刻意晚于「点击生效」轮询窗口，判定只能靠 checkbox 证据
  };
  const result = await solve(cdp, { fetchImpl: fakeFetch().fn, sleep });
  assert.deepEqual(result, { ok: true, rounds: 0, costMs: 150 });
  assert.equal(boxClicks, 1, "已有正面证据（转圈中）就不再点第二次");
});

test("三次点击 checkbox 都被吞掉 → 继续等页面（不再无限重点）", { timeout: 5000 }, async () => {
  const state = recaptchaState({ path: "/v3/signin/identifier" });
  const cdp = new FakeCdp(state);
  const logs = [];
  cdp.onClick = () => {};
  const result = await solve(cdp, { fetchImpl: fakeFetch().fn, log: (m) => logs.push(m) });
  assert.equal(result.ok === false && result.reason, "no_challenge", JSON.stringify(result));
  assert.equal(cdp.clicks.filter((c) => same(c, CHECKBOX)).length, CHECKBOX_ATTEMPTS);
  assert.ok(logs.some((m) => m.includes(`连续 ${CHECKBOX_ATTEMPTS} 次点击 checkbox 都没有反应`)), JSON.stringify(logs));
});
