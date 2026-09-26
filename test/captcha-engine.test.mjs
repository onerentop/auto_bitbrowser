/**
 * StagehandGoogleEngine.solveCaptcha 门面（离线，不连真机）。
 *
 * 钉住三件事（PRD 验收标准 1 的引擎侧一半）：
 *   1. 未配置打码密钥 → 直接 no_api_key，**零网络请求、零 CDP 流量**；
 *   2. 配了密钥但拿不到窗口调试端点 → no_endpoint，同样零请求；
 *   3. 连不上窗口（WebSocket 建不起来）→ cdp_failed，且**不把坏连接缓存下来**（下次登录重来）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StagehandGoogleEngine } from "../src/engine/stagehand-engine.ts";
import { registerCaptchaConfigSource } from "../src/engine/captcha/config.ts";

const RECAPTCHA_URL = "https://accounts.google.com/v3/signin/challenge/recaptcha?hl=en";

/**
 * 用假 page 构造一个「已连接」的引擎（私有字段只是 TS 层面的限制）
 * @param {{ url?: string, debuggingAddress?: string | null }} [options]
 */
function engineWith({ url = RECAPTCHA_URL, debuggingAddress = null } = {}) {
  const engine = /** @type {any} */ (new StagehandGoogleEngine(/** @type {any} */ ({ ixClient: {} })));
  engine.sh = {};
  engine.page = { url: () => url };
  engine.debuggingAddress = debuggingAddress;
  return engine;
}

/** 注册一个只提供密钥的配置来源；返回还原函数 */
function withCaptchaKey(key) {
  registerCaptchaConfigSource(() => ({
    get: (name, fallback) => (name === "captcha.api_key" ? key : fallback),
  }));
  return () => registerCaptchaConfigSource(null);
}

/**
 * 替换 globalThis.fetch（engine 里 fetchPageTarget 走全局 fetch）；返回 { calls, restore }。
 * @param {(url: string, init?: any) => Promise<any>} handler
 */
function patchFetch(handler) {
  const holder = /** @type {any} */ (globalThis);
  const original = holder.fetch;
  const calls = [];
  holder.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  return {
    calls,
    restore: () => {
      holder.fetch = original;
    },
  };
}

test("未配置密钥：return no_api_key，且零 fetch、零 CDP 连接", { timeout: 10000 }, async () => {
  const engine = engineWith({ debuggingAddress: "127.0.0.1:49693" });
  const fetched = patchFetch(async () => {
    throw new Error("未配置密钥时不该发任何请求");
  });
  try {
    assert.deepEqual(await engine.solveCaptcha(), { ok: false, reason: "no_api_key", rounds: 0 });
    assert.equal(fetched.calls.length, 0, "未配置密钥时不得有任何网络请求");
    assert.equal(engine.captchaCdp, null, "不得建立 CDP 连接");
  } finally {
    fetched.restore();
  }
});

test("配了密钥但没有窗口调试端点：no_endpoint，仍然零请求", { timeout: 10000 }, async () => {
  const restoreKey = withCaptchaKey("CAP-test-key");
  const engine = engineWith({ debuggingAddress: null });
  const fetched = patchFetch(async () => {
    throw new Error("没有端点时不该发任何请求");
  });
  try {
    assert.deepEqual(await engine.solveCaptcha(), { ok: false, reason: "no_endpoint", rounds: 0 });
    assert.equal(fetched.calls.length, 0);
  } finally {
    fetched.restore();
    restoreKey();
  }
});

test("有端点但 /json/list 里没有 page 目标：no_endpoint（且不发打码请求）", { timeout: 10000 }, async () => {
  const restoreKey = withCaptchaKey("CAP-test-key");
  const engine = engineWith({ debuggingAddress: "127.0.0.1:49693" });
  const fetched = patchFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify([{ type: "service_worker", url: "https://example.com/sw.js" }]),
  }));
  try {
    assert.deepEqual(await engine.solveCaptcha(), { ok: false, reason: "no_endpoint", rounds: 0 });
    assert.deepEqual(fetched.calls, ["http://127.0.0.1:49693/json/list"]);
  } finally {
    fetched.restore();
    restoreKey();
  }
});

test("CDP 连接建不起来：cdp_failed，且不缓存坏连接", { timeout: 30000 }, async () => {
  const restoreKey = withCaptchaKey("CAP-test-key");
  const engine = engineWith({ debuggingAddress: "127.0.0.1:49693" });
  const fetched = patchFetch(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify([
        {
          type: "page",
          url: RECAPTCHA_URL,
          // 端口 1 上没有任何服务：WebSocket 立刻失败，走 connect() 的失败分支
          webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/deadbeef",
        },
      ]),
  }));
  try {
    const result = await engine.solveCaptcha();
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "cdp_failed", JSON.stringify(result));
    assert.equal(engine.captchaCdp, null, "失败后必须丢掉缓存，下一次登录重新建");
  } finally {
    fetched.restore();
    restoreKey();
  }
});
