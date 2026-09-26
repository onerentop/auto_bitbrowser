/**
 * src/engine/captcha/capsolver.ts 与 src/engine/captcha/config.ts 的离线测试。
 *
 * 全程注入 fetchImpl（零真实网络）：请求体字段名、kg 词表最长匹配、响应解析、错误/超时/非 JSON、
 * 密钥不进 detail；配置解析的「未注册/关闭/无密钥/provider 不认 → null」与密钥掩码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAPSOLVER_CREATE_TASK_URL,
  CAPSOLVER_KG_IDS,
  buildCreateTaskBody,
  classifyImage,
  classifyTile,
  parseCreateTaskResponse,
  parseSingleTileResponse,
  resolveQuestion,
} from "../src/engine/captcha/capsolver.ts";
import {
  DEFAULT_CAPTCHA_MAX_ROUNDS,
  DEFAULT_CAPTCHA_TIMEOUT_SECONDS,
  maskCaptchaKey,
  registerCaptchaConfigSource,
  resolveCaptchaConfig,
} from "../src/engine/captcha/config.ts";

const API_KEY = "CapKey-test-1234abcd";

/**
 * 假配置来源（只实现 get(key, defaultValue)）
 * @param {Record<string, unknown>} values
 * @returns {import("../src/engine/captcha/config.ts").CaptchaConfigSource}
 */
function configSource(values) {
  return {
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue;
    },
  };
}

/**
 * 记录请求的假 fetch
 * @param {{ objects?: number[], errorId?: number, errorCode?: string, errorDescription?: string, rawBody?: string }} [plan]
 */
function fakeClassifyFetch(plan = {}) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fn = async (url, init) => {
    calls.push({ url, init });
    const payload =
      plan.rawBody ??
      JSON.stringify({
        errorId: plan.errorId ?? 0,
        ...(plan.errorCode ? { errorCode: plan.errorCode } : {}),
        ...(plan.errorDescription ? { errorDescription: plan.errorDescription } : {}),
        status: "ready",
        solution: { objects: plan.objects ?? [2, 5, 8], size: 9, type: "multi" },
      });
    return { ok: true, status: 200, text: async () => payload };
  };
  return { calls, fn };
}
test("CAPSOLVER_KG_IDS：17 个对象，ID 形如 /m/…", () => {
  assert.equal(Object.keys(CAPSOLVER_KG_IDS).length, 17);
  assert.equal(CAPSOLVER_KG_IDS["bicycles"], "/m/0199g");
  assert.equal(CAPSOLVER_KG_IDS["school bus"], "/m/02yvhj");
  assert.equal(CAPSOLVER_KG_IDS["bus"], "/m/01bjv");
  assert.ok(Object.values(CAPSOLVER_KG_IDS).every((id) => /^\/m\/[\w]+$/.test(id)));
});

test("resolveQuestion：最长关键词优先（school buses ≠ bus），无对象文案 → null", () => {
  assert.deepEqual(resolveQuestion("Select all images with school buses"), { label: "school bus", id: "/m/02yvhj" });
  assert.deepEqual(resolveQuestion("Select all images with buses"), { label: "bus", id: "/m/01bjv" });
  assert.deepEqual(resolveQuestion("Select all images with bicycles Click verify once there are none left"), {
    label: "bicycles",
    id: "/m/0199g",
  });
  assert.deepEqual(resolveQuestion("Select all images with fire hydrants"), { label: "fire hydrant(s)", id: "/m/01pns0" });
  assert.deepEqual(resolveQuestion("Select all images with a traffic light"), { label: "traffic lights", id: "/m/015qff" });
  assert.deepEqual(resolveQuestion("Select all images with mountains or hills"), { label: "mountains or hills", id: "/m/09d_r" });
  assert.deepEqual(resolveQuestion("SELECT ALL IMAGES WITH BICYCLES"), { label: "bicycles", id: "/m/0199g" });
  assert.equal(resolveQuestion("Click verify once there are none left"), null);
  assert.equal(resolveQuestion(""), null);
});

test("buildCreateTaskBody：字段名是 image（单数），question 是 kg ID", () => {
  assert.deepEqual(buildCreateTaskBody("k-1", "BASE64", "/m/0199g"), {
    clientKey: "k-1",
    task: { type: "ReCaptchaV2Classification", image: "BASE64", question: "/m/0199g" },
  });
  const task = /** @type {Record<string, unknown>} */ (buildCreateTaskBody("k-1", "B", "/m/01bjv").task);
  assert.deepEqual(Object.keys(task), ["type", "image", "question"]);
  assert.equal("imageBody" in task, false);
});

test("parseCreateTaskResponse：errorId 0 原样返回 0-based objects；errorId≠0 带 errorCode", () => {
  assert.deepEqual(parseCreateTaskResponse({ errorId: 0, status: "ready", solution: { objects: [2, 5, 8], size: 9, type: "multi" } }), {
    ok: true,
    objects: [2, 5, 8],
  });
  const failed = parseCreateTaskResponse({ errorId: 1, errorCode: "ERROR_NO_BALANCE", errorDescription: "balance is not enough" });
  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.detail.includes("ERROR_NO_BALANCE"), failed.ok ? "" : failed.detail);
  assert.ok(!failed.ok && failed.detail.includes("balance is not enough"), failed.ok ? "" : failed.detail);
  assert.equal(parseCreateTaskResponse({ errorId: 0 }).ok, false, "缺 solution.objects");
  assert.equal(parseCreateTaskResponse("nope").ok, false);
  assert.equal(parseCreateTaskResponse(null).ok, false);
  assert.deepEqual(parseCreateTaskResponse({ errorId: 0, solution: { objects: [2, 5.5, -1, 8, "9"] } }), { ok: true, objects: [2, 8] });
});

test("classifyImage：POST createTask，请求体字段是 image（单数）+ kg ID，响应 0-based 原样返回", { timeout: 5000 }, async () => {
  const { calls, fn } = fakeClassifyFetch({ objects: [8, 6, 7] });
  const result = await classifyImage({ apiKey: API_KEY, imageBase64: "IMGB64", questionId: "/m/0199g", fetchImpl: fn, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true, objects: [8, 6, 7] });
  assert.equal(calls.length, 1);
  const call = calls[0];
  if (!call) throw new Error("没有发出请求");
  assert.equal(call.url, CAPSOLVER_CREATE_TASK_URL);
  assert.equal(call.url, "https://api.capsolver.com/createTask");
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.headers?.["content-type"], "application/json");
  assert.deepEqual(JSON.parse(String(call.init?.body)), {
    clientKey: API_KEY,
    task: { type: "ReCaptchaV2Classification", image: "IMGB64", question: "/m/0199g" },
  });
});

test("classifyImage：errorId≠0 → 失败，detail 含 errorCode 且不含 clientKey", { timeout: 5000 }, async () => {
  const { fn } = fakeClassifyFetch({
    errorId: 1,
    errorCode: "ERROR_UNSUPPORTED_QUESTION",
    errorDescription: `bad key ${API_KEY}`,
  });
  const result = await classifyImage({ apiKey: API_KEY, imageBase64: "B", questionId: "/m/0199g", fetchImpl: fn, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("不该成功");
  assert.ok(result.detail.includes("ERROR_UNSUPPORTED_QUESTION"), result.detail);
  assert.equal(result.detail.includes(API_KEY), false, result.detail);
  assert.ok(result.detail.includes(maskCaptchaKey(API_KEY)), result.detail);
});

test("classifyImage：非 JSON 响应 → 失败（带 HTTP 状态）", { timeout: 5000 }, async () => {
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fetchImpl = async () => ({ ok: false, status: 502, text: async () => "<html>Bad Gateway</html>" });
  const result = await classifyImage({ apiKey: API_KEY, imageBase64: "B", questionId: "/m/0199g", fetchImpl, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("不该成功");
  assert.ok(result.detail.includes("502"), result.detail);
  assert.ok(result.detail.includes("JSON"), result.detail);
});

test("classifyImage：请求超时（AbortSignal.timeout）→ 失败，detail 含「超时」", { timeout: 5000 }, async () => {
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fetchImpl = (url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("缺少 AbortSignal");
      // 兜底定时器（ref 住事件循环）：AbortSignal.timeout() 的定时器是 unref 的，
      // 单测里没有真实 socket，只有它的话事件循环会空转退出
      const guard = setTimeout(() => reject(new Error("兜底超时：请求没有按时被 abort")), 2000);
      signal.addEventListener("abort", () => {
        clearTimeout(guard);
        reject(signal.reason);
      });
    });
  const result = await classifyImage({ apiKey: API_KEY, imageBase64: "B", questionId: "/m/0199g", fetchImpl, timeoutMs: 20 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("不该成功");
  assert.ok(result.detail.includes("超时"), result.detail);
});

test("classifyImage：网络异常 → 失败，detail 保留错误文本且不含密钥", { timeout: 5000 }, async () => {
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fetchImpl = async () => {
    throw new Error("fetch failed: ECONNREFUSED 127.0.0.1:443");
  };
  const result = await classifyImage({ apiKey: API_KEY, imageBase64: "B", questionId: "/m/0199g", fetchImpl, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("不该成功");
  assert.ok(result.detail.includes("ECONNREFUSED"), result.detail);
  assert.equal(result.detail.includes(API_KEY), false, result.detail);
});

// 真机实测（2026-09-26，research §6）：100×100 单图 → {type:"single", hasObject, size:1}；300×300 → multi
test("parseSingleTileResponse：只认布尔 hasObject；multi 形态 / 缺字段 / errorId≠0 一律失败", () => {
  assert.deepEqual(parseSingleTileResponse({ errorId: 0, status: "ready", solution: { hasObject: true, size: 1, type: "single" } }), {
    ok: true,
    hasObject: true,
  });
  assert.deepEqual(parseSingleTileResponse({ errorId: 0, solution: { hasObject: false, size: 1, type: "single" } }), {
    ok: true,
    hasObject: false,
  });
  assert.equal(parseSingleTileResponse({ errorId: 0, solution: { objects: [1], size: 3, type: "multi" } }).ok, false, "multi 形态不是单图结论");
  assert.equal(parseSingleTileResponse({ errorId: 0, solution: { hasObject: "true" } }).ok, false, "非布尔不猜");
  const failed = parseSingleTileResponse({ errorId: 1, errorCode: "ERROR_ZERO_BALANCE" });
  assert.ok(!failed.ok && failed.detail.includes("ERROR_ZERO_BALANCE"));
  assert.equal(parseSingleTileResponse(null).ok, false);
  // 反过来：把单图的 single 响应当 multi 解析必须失败（原图误取成单图时不会被当成「一格都没有」）
  assert.equal(parseCreateTaskResponse({ errorId: 0, solution: { hasObject: false, size: 1, type: "single" } }).ok, false);
});

test("classifyTile：请求体与 multi 相同（image 单数 + kg ID），解析 single 形态", { timeout: 5000 }, async () => {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @type {import("../src/engine/captcha/types.ts").FetchLike} */
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const payload = JSON.stringify({ errorId: 0, status: "ready", solution: { hasObject: true, size: 1, type: "single" } });
    return { ok: true, status: 200, text: async () => payload };
  };
  const result = await classifyTile({ apiKey: API_KEY, imageBase64: "TILE64", questionId: "/m/01pns0", fetchImpl, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true, hasObject: true });
  assert.equal(calls[0]?.url, CAPSOLVER_CREATE_TASK_URL);
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    clientKey: API_KEY,
    task: { type: "ReCaptchaV2Classification", image: "TILE64", question: "/m/01pns0" },
  });
});

test("classifyTile：errorId≠0 → 失败，detail 掩码密钥", { timeout: 5000 }, async () => {
  const { fn } = fakeClassifyFetch({ errorId: 1, errorCode: "ERROR_KEY_DENIED_ACCESS", errorDescription: `key ${API_KEY}` });
  const result = await classifyTile({ apiKey: API_KEY, imageBase64: "B", questionId: "/m/0199g", fetchImpl: fn, timeoutMs: 5000 });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("不该成功");
  assert.ok(result.detail.includes("ERROR_KEY_DENIED_ACCESS"), result.detail);
  assert.equal(result.detail.includes(API_KEY), false, result.detail);
});

test("resolveCaptchaConfig：未注册 / 关闭 / 无密钥 / provider 不认 → null（调用方据此零请求）", () => {
  registerCaptchaConfigSource(null);
  assert.equal(resolveCaptchaConfig(), null);
  assert.equal(resolveCaptchaConfig(null), null);
  assert.equal(resolveCaptchaConfig(configSource({ "captcha.provider": "capsolver", "captcha.enabled": true, "captcha.api_key": "" })), null);
  assert.equal(resolveCaptchaConfig(configSource({ "captcha.enabled": false, "captcha.api_key": "k" })), null);
  assert.equal(resolveCaptchaConfig(configSource({ "captcha.provider": "2captcha", "captcha.api_key": "k" })), null);
  assert.equal(
    resolveCaptchaConfig({
      get() {
        throw new Error("读配置炸了");
      },
    }),
    null,
  );
  assert.equal(DEFAULT_CAPTCHA_MAX_ROUNDS, 3);
  assert.equal(DEFAULT_CAPTCHA_TIMEOUT_SECONDS, 20);
});

test("resolveCaptchaConfig：默认值 + 注册来源；max_rounds/timeout 有下限、字符串数值可解析", () => {
  const values = { "captcha.api_key": " secret-key " };
  assert.deepEqual(resolveCaptchaConfig(configSource(values)), {
    provider: "capsolver",
    apiKey: "secret-key",
    enabled: true,
    maxRounds: 3,
    timeoutMs: 20000,
  });
  try {
    registerCaptchaConfigSource(() =>
      configSource({ "captcha.api_key": "k", "captcha.max_rounds": 0, "captcha.timeout": 0.5, "captcha.provider": "capsolver" }),
    );
    const config = resolveCaptchaConfig();
    assert.equal(config?.maxRounds, 1, "0 轮没有意义，抬到 1");
    assert.equal(config?.timeoutMs, 1000, "0.5s 抬到 1s");
    const fromStrings = resolveCaptchaConfig(configSource({ "captcha.api_key": "k", "captcha.max_rounds": "5", "captcha.timeout": "9" }));
    assert.equal(fromStrings?.maxRounds, 5);
    assert.equal(fromStrings?.timeoutMs, 9000);
  } finally {
    registerCaptchaConfigSource(null);
  }
  assert.equal(resolveCaptchaConfig(), null, "取消注册后回到 null");
});

test("maskCaptchaKey：空串 → ''；否则 **** + 后 4 位，且不泄漏原串", () => {
  assert.equal(maskCaptchaKey(""), "");
  assert.equal(maskCaptchaKey(API_KEY), "****abcd");
  assert.equal(maskCaptchaKey("12"), "****12");
  assert.equal(maskCaptchaKey(API_KEY).includes(API_KEY), false);
  assert.equal(maskCaptchaKey(API_KEY).includes("CapKey-test-1234"), false);
});
