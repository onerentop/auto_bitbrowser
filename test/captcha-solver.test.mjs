/**
 * src/engine/captcha/solver.ts 的离线测试（假 CdpPort + 假 fetch，零真实浏览器、零真实网络）。
 *
 * 覆盖：checkbox 直接通过（0 轮 / 0 请求）、一轮图片挑战（点击坐标 = bframe 偏移 + 格子偏移 + 半宽半高）、
 * 原始图缺失或不支持对象（打码零调用）、objects 为空 / 越界索引、轮次上限 not_passed、
 * api_error 立即返回、cdp_failed、配置关闭 / 无密钥零 CDP 流量、找不到 checkbox → no_challenge。
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
 * 假页面状态（真机形态的简化模型）
 * @typedef {object} RecaptchaState
 * @property {string} path
 * @property {boolean} hasToken
 * @property {Rect | null} anchor
 * @property {Rect} bframe
 * @property {boolean} grid
 * @property {string} title
 * @property {string | null} rawUrl
 * @property {Rect[]} tiles
 * @property {Rect | null} verify
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
    if (expr.includes("recaptcha/enterprise/anchor")) return { path: s.path, anchor: s.anchor };
    if (expr.includes("recaptcha/enterprise/bframe")) return s.bframe;
    if (expr.includes("rc-imageselect-tile img")) {
      if (sessionId !== "bf" || !s.grid) return null;
      return { title: s.title, rawUrl: s.rawUrl, tiles: s.tiles };
    }
    if (expr.includes("rc-imageselect-tile")) return sessionId === "bf" && s.grid ? s.tiles.length : 0;
    if (expr.includes("recaptcha-verify-button")) {
      if (sessionId !== "bf" || !s.grid) return null;
      return s.verify;
    }
    if (expr.includes("g-recaptcha-response")) return { path: s.path, hasToken: s.hasToken };
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
 * 记录请求的假 fetch：图片 URL 返回 2048 字节二进制，CapSolver URL 返回 JSON
 * @param {{ objects?: number[], errorId?: number, errorCode?: string, errorDescription?: string, imageStatus?: number, imageThrows?: boolean }} [plan]
 */
function fakeFetch(plan = {}) {
  /** @type {{ url: string, init: any, body: any }[]} */
  const calls = [];
  const bytes = new Uint8Array(2048);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fn = async (url, init) => {
    calls.push({ url, init, body: init && typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (url === CAPSOLVER_URL) {
      const payload = JSON.stringify({
        errorId: plan.errorId ?? 0,
        ...(plan.errorCode ? { errorCode: plan.errorCode } : {}),
        ...(plan.errorDescription ? { errorDescription: plan.errorDescription } : {}),
        status: "ready",
        solution: { objects: plan.objects ?? [0], size: 4, type: "multi" },
      });
      return { ok: true, status: 200, text: async () => payload };
    }
    if (plan.imageThrows) throw new Error("HTTP 403");
    const status = plan.imageStatus ?? 200;
    const res = { ok: status === 200, status, text: async () => "", arrayBuffer: async () => bytes.buffer };
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
