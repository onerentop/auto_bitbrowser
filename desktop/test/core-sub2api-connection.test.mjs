/**
 * Sub2ApiClient.testAccountConnection 单测（全离线）
 *
 * SSE 流式接口，不走 request()。全部用注入的 fetchImpl 假实现驱动，
 * **绝不发真实网络请求**（构造参数 fetchImpl 优先于 globalThis.fetch，
 * 因此也不需要 stub 全局 fetch）。
 *
 * 私有方法 parseSseEvents / extractValidationUrlFromError 通过
 * testAccountConnection 的返回值间接断言。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Sub2ApiClient } from "../src/services/sub2api-client.ts";

// ==================== 替身 ====================

/**
 * 假 fetch：返回预置的 SSE 文本 + HTTP 状态码，并记录调用参数。
 * throws 用于模拟网络异常（可带自定义 name，如 AbortError）。
 */
function fakeFetch(opts = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (opts.throws) {
      const err = new Error(opts.throws.message ?? "boom");
      if (opts.throws.name) err.name = opts.throws.name;
      throw err;
    }
    return {
      status: opts.status ?? 200,
      async text() {
        return opts.body ?? "";
      },
    };
  };
  return { calls, impl };
}

function makeClient(fetchOpts = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new Sub2ApiClient({
    baseUrl: "https://sub2api.example.test/",
    adminToken: "admin-token-123",
    fetchImpl: f.impl,
  });
  return { client, fetch: f };
}

/** 把若干事件对象拼成 SSE 文本 */
function sse(...events) {
  return events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
}

// 与生产环境同形的 403 错误体（error.details[0].metadata.validation_url）
const VALIDATION_URL = "https://accounts.google.com/signin/continue?sarp=1&scc=1&token=ABC-123";

function error403Json(url = VALIDATION_URL) {
  return JSON.stringify({
    error: {
      code: 403,
      status: "PERMISSION_DENIED",
      details: [{ metadata: { validation_url: url } }],
    },
  });
}

// ==================== 403 / VALIDATION_REQUIRED ====================

test("testAccountConnection: 403 错误事件 → needs_unlock + 从 JSON 提取 validation_url", async () => {
  const { client } = makeClient({
    status: 200,
    body: sse(
      { type: "start" },
      { type: "error", error: `API 返回 403: ${error403Json()}` },
    ),
  });

  const res = await client.testAccountConnection(77);

  assert.equal(res.success, false);
  assert.equal(res.error, "VALIDATION_REQUIRED");
  assert.equal(res.statusCode, 403, "statusCode 被硬编码为 403，不取 HTTP 状态码");
  assert.equal(res.data.needs_unlock, true);
  assert.equal(res.data.validation_url, VALIDATION_URL);
  assert.equal(res.data.account_id, 77);
  assert.match(String(res.data.raw_error), /^API 返回 403: /);
});

test("testAccountConnection: VALIDATION_REQUIRED（无 JSON）→ 正则后备提取 URL", async () => {
  const { client } = makeClient({
    body: sse({
      type: "error",
      error: `VALIDATION_REQUIRED: please visit ${VALIDATION_URL} to continue`,
    }),
  });

  const res = await client.testAccountConnection(5);
  assert.equal(res.success, false);
  assert.equal(res.data.needs_unlock, true);
  assert.equal(res.data.validation_url, VALIDATION_URL);
});

test("testAccountConnection: 正则后备在引号/尖括号处截断 URL", async () => {
  const { client } = makeClient({
    body: sse({
      type: "error",
      error: `403 Forbidden "${VALIDATION_URL}" trailing`,
    }),
  });

  const res = await client.testAccountConnection(5);
  assert.equal(res.data.validation_url, VALIDATION_URL, "右引号不应被吞进 URL");
});

test("testAccountConnection: JSON 里没有 details → 落到正则后备", async () => {
  const { client } = makeClient({
    body: sse({
      type: "error",
      error: `403: {"error":{"code":403,"status":"PERMISSION_DENIED"}} see ${VALIDATION_URL}`,
    }),
  });

  const res = await client.testAccountConnection(5);
  assert.equal(res.data.validation_url, VALIDATION_URL);
});

test("testAccountConnection: JSON details 存在但 metadata 无 validation_url → 也落到正则后备", async () => {
  const { client } = makeClient({
    body: sse({
      type: "error",
      error: `403: ${JSON.stringify({ error: { details: [{ metadata: { reason: "x" } }] } })}`,
    }),
  });

  const res = await client.testAccountConnection(5);
  assert.equal(res.data.validation_url, "", "两条路径都取不到时返回空串");
  assert.equal(res.data.needs_unlock, true, "取不到 URL 也仍然是 needs_unlock");
});

test("testAccountConnection: 403 但完全没有可提取的 URL → validation_url 为空串", async () => {
  const { client } = makeClient({
    body: sse({ type: "error", error: "HTTP 403 Forbidden" }),
  });

  const res = await client.testAccountConnection(9);
  assert.equal(res.success, false);
  assert.equal(res.error, "VALIDATION_REQUIRED");
  assert.equal(res.data.validation_url, "");
});

test("testAccountConnection: 非 google 域名的 URL 不被正则接受", async () => {
  const { client } = makeClient({
    body: sse({ type: "error", error: "403: https://evil.example.com/signin/continue?x=1" }),
  });
  const res = await client.testAccountConnection(1);
  assert.equal(res.data.validation_url, "");
});

// ==================== 普通 error 事件 ====================

test("testAccountConnection: 普通 error 事件 → 原样返回错误消息与 HTTP 状态码", async () => {
  const { client } = makeClient({
    status: 200,
    body: sse({ type: "error", error: "upstream rate limited" }),
  });

  const res = await client.testAccountConnection(3);
  assert.equal(res.success, false);
  assert.equal(res.error, "upstream rate limited");
  assert.equal(res.statusCode, 200);
  assert.equal(res.data, undefined);
});

test("testAccountConnection: error 事件缺 error 字段 → 兜底 'Unknown error'", async () => {
  const { client } = makeClient({ body: sse({ type: "error" }) });
  const res = await client.testAccountConnection(3);
  assert.equal(res.success, false);
  assert.equal(res.error, "Unknown error");
});

test("testAccountConnection: 首个 error 事件胜出，后续事件不再处理", async () => {
  const { client } = makeClient({
    body: sse(
      { type: "error", error: "first failure" },
      { type: "test_complete", success: true },
    ),
  });
  const res = await client.testAccountConnection(3);
  assert.equal(res.success, false);
  assert.equal(res.error, "first failure");
});

// ==================== test_complete ====================

test("testAccountConnection: test_complete + success=true → 账号正常", async () => {
  const { client } = makeClient({
    status: 200,
    body: sse({ type: "chunk", content: "hi" }, { type: "test_complete", success: true }),
  });

  const res = await client.testAccountConnection(42);
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { account_id: 42, status: "ok" });
  assert.equal(res.statusCode, 200);
});

test("testAccountConnection: test_complete + success=false 且 HTTP 200 → 兜底判为成功（照搬 Python）", async () => {
  // Python L423 的条件是 `type == "test_complete" and event.get("success")`，
  // success=false 时不 return，循环结束后落到 L433 的「无明确结果 + 状态码 < 400 → 成功」。
  const { client } = makeClient({
    status: 200,
    body: sse({ type: "test_complete", success: false }),
  });

  const res = await client.testAccountConnection(42);
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { account_id: 42, status: "ok" });
});

// ==================== HTTP 状态码兜底 ====================

test("testAccountConnection: 无任何事件 + HTTP >= 400 → HTTP 兜底错误（正文截断 200 字）", async () => {
  const body = "x".repeat(500);
  const { client } = makeClient({ status: 500, body });

  const res = await client.testAccountConnection(1);
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 500);
  assert.equal(res.error, `HTTP 500: ${"x".repeat(200)}`);
});

test("testAccountConnection: 无任何事件 + HTTP < 400 → 视为成功", async () => {
  const { client } = makeClient({ status: 204, body: "" });
  const res = await client.testAccountConnection(1);
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { account_id: 1, status: "ok" });
  assert.equal(res.statusCode, 204);
});

// ==================== SSE 解析细节 ====================

test("parseSseEvents（间接）: 非 data: 行、空 data、坏 JSON 全部被忽略", async () => {
  const { client } = makeClient({
    status: 200,
    body: [
      "event: message",
      ": this is a comment",
      "data:",
      "data: {坏JSON",
      "   ",
      'data: {"type":"test_complete","success":true}',
    ].join("\n"),
  });

  const res = await client.testAccountConnection(8);
  assert.equal(res.success, true, "坏行不应中断解析，仍能读到后面的 test_complete");
});

test("parseSseEvents（间接）: 兼容 `data:` 后无空格的写法", async () => {
  const { client } = makeClient({
    body: 'data:{"type":"error","error":"no space"}\n',
  });
  const res = await client.testAccountConnection(8);
  assert.equal(res.error, "no space");
});

// ==================== 请求构造 ====================

test("testAccountConnection: URL / 方法 / admin 头正确，未传 modelId 时不带请求体", async () => {
  const { client, fetch } = makeClient({ body: sse({ type: "test_complete", success: true }) });
  await client.testAccountConnection(123);

  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, "https://sub2api.example.test/api/v1/admin/accounts/123/test", "baseUrl 末尾斜杠被剥掉");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], "admin-token-123");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.body, undefined, "对标 Python 的 `json=data if data else None`");
});

test("testAccountConnection: 传入 modelId 时请求体带 model_id", async () => {
  const { client, fetch } = makeClient({ body: sse({ type: "test_complete", success: true }) });
  await client.testAccountConnection(123, "claude-sonnet-4");
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { model_id: "claude-sonnet-4" });
});

// ==================== 异常 ====================

test("testAccountConnection: fetch 抛普通异常 → 网络请求失败", async () => {
  const { client } = makeClient({ throws: { message: "ECONNREFUSED" } });
  const res = await client.testAccountConnection(1);
  assert.deepEqual(res, { success: false, error: "网络请求失败: ECONNREFUSED", statusCode: 0 });
});

test("testAccountConnection: AbortError → 请求超时", async () => {
  const { client } = makeClient({ throws: { name: "AbortError", message: "aborted" } });
  const res = await client.testAccountConnection(1);
  assert.deepEqual(res, { success: false, error: "请求超时", statusCode: 0 });
});

test("testAccountConnection: 读取响应体失败 → 落到网络请求失败分支", async () => {
  const client = new Sub2ApiClient({
    baseUrl: "https://sub2api.example.test",
    adminToken: "t",
    fetchImpl: async () => ({
      status: 200,
      async text() {
        throw new Error("stream closed");
      },
    }),
  });
  const res = await client.testAccountConnection(1);
  assert.equal(res.success, false);
  assert.equal(res.error, "网络请求失败: stream closed");
});
