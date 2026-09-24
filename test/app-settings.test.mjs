/**
 * 设置页（配置 / 代理 / 账号数据）的后端逻辑测试 —— 全部离线
 *
 * 覆盖：SettingsService 保存语义、运行时配置回退、测试连接的请求构造、
 * 批量导入解析 / 校验、导出文本、代理新增方法、handler 参数校验与端到端流程。
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ConfigManager } from "../src/core/config-manager.ts";
import { SettingsService } from "../src/application/settings-service.ts";
import {
  ANTHROPIC_VERSION,
  TEST_AI_DEFAULT_BASE_URLS,
  buildAnthropicRequest,
  buildOpenAiCompatRequest,
  testAiConnection,
} from "../src/application/test-ai-connection.ts";
import {
  buildAccountExportText,
  buildAccountImportUpsert,
  countImportRows,
  formatAccountPreviewRow,
  formatProxyPreviewRow,
  isValidNewAccountEmail,
  parseAccountImportLine,
  parseImportText,
  parseProxyImportLine,
  truncateInvalidLine,
  dedupeProxiesByKey,
} from "../app/shared/logic/settings-data.ts";
import { initDb } from "../src/db/schema.ts";
import { ProxyRepository } from "../src/db/proxy-repository.ts";
import { ProxyAllocator } from "../src/services/proxy-allocator.ts";
import { createHostContext } from "../app/host/context.ts";
import { createSettingsHandlers } from "../app/host/handlers/settings.ts";
import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { SETTINGS_INVOKE, SETTINGS_NUMBER_RANGES, SETTINGS_TASK_TYPES, clampSettingsNumber, clampSettingsNumbers } from "../app/shared/channels/settings.ts";

const tmpDirs = [];
function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), "abb-settings-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const silent = () => {};

function makeConfig() {
  const dir = makeTmp();
  const configFile = join(dir, "config.json");
  return { cm: new ConfigManager({ configFile, log: silent }), configFile };
}

function baseSnapshot(overrides = {}) {
  return {
    ai_default_provider: "anthropic",
    gemini_api_key: "",
    gemini_base_url: "https://g.example/v1beta/openai",
    gemini_model: "gemini-2.5-pro",
    anthropic_api_key: "",
    anthropic_base_url: "",
    anthropic_model: "claude-3-haiku-20240307",
    ai_max_steps: 30,
    gmail_imap_email: "me@gmail.com",
    gmail_imap_password: "",
    timeout_page_load: 40,
    timeout_status_check: 21,
    timeout_iframe_wait: 16,
    delay_after_login: 4,
    delay_after_offer: 9,
    delay_after_save: 19,
    proxy_max_windows_per_ip: 5,
    default_thread_count: 6,
    theme: "dark",
    data_dir: "",
    data_separator: "----",
    ...overrides,
  };
}

// ==================== SettingsService ====================

test("SettingsService.save：API Key 为空不覆盖、非空加密写入", () => {
  const { cm, configFile } = makeConfig();
  cm.setAiProviderApiKey("gemini", "OLD-GEMINI");
  new SettingsService(cm).saveSettingsSnapshot(baseSnapshot({ gemini_api_key: "", anthropic_api_key: "NEW-ANT" }));

  const fresh = new ConfigManager({ configFile, log: silent });
  assert.equal(fresh.getAiProviderApiKey("gemini"), "OLD-GEMINI");
  assert.equal(fresh.getAiProviderApiKey("anthropic"), "NEW-ANT");
  const raw = readFileSync(configFile, "utf-8");
  assert.equal(raw.includes("NEW-ANT"), false, "API Key 不能明文落盘");
  assert.equal(raw.includes("OLD-GEMINI"), false);
});

test("SettingsService.save：gmail 应用密码无条件写入（空值会清空）", () => {
  const { cm, configFile } = makeConfig();
  cm.setGmailImapPassword("app-pass");
  const svc = new SettingsService(cm);
  svc.saveSettingsSnapshot(baseSnapshot({ gmail_imap_password: "" }));
  assert.equal(new ConfigManager({ configFile, log: silent }).getGmailImapPassword(), "");

  svc.saveSettingsSnapshot(baseSnapshot({ gmail_imap_password: " p w " }));
  const fresh = new ConfigManager({ configFile, log: silent });
  assert.equal(fresh.getGmailImapPassword(), " p w ", "密码原样保存，不 strip");
  assert.equal(readFileSync(configFile, "utf-8").includes(" p w "), false);
});

test("SettingsService.save：data_separator strip，数值 / 主题 / 提供商写入，data_dir 不写", () => {
  const { cm, configFile } = makeConfig();
  cm.set("data_dir", "D:\\keep");
  new SettingsService(cm).saveSettingsSnapshot(baseSnapshot({ data_separator: "  ||  ", data_dir: "X:\\ignored" }));
  const fresh = new ConfigManager({ configFile, log: silent });
  assert.equal(fresh.get("data_separator"), "||");
  assert.equal(fresh.get("data_dir"), "D:\\keep");
  assert.equal(fresh.get("timeouts.page_load"), 40);
  assert.equal(fresh.get("delays.after_save"), 19);
  assert.equal(fresh.get("proxy.max_windows_per_ip"), 5);
  assert.equal(fresh.get("default_thread_count"), 6);
  assert.equal(fresh.get("ai_agent.max_steps"), 30);
  assert.equal(fresh.get("theme"), "dark");
  assert.equal(fresh.getAiDefaultProvider(), "anthropic");
  assert.equal(fresh.getAiProviderModel("gemini"), "gemini-2.5-pro");
  assert.equal(fresh.getAiProviderBaseUrl("gemini"), "https://g.example/v1beta/openai");
});

test("SettingsService.save：一次落盘（不走逐项 set）", () => {
  const { cm } = makeConfig();
  cm.load();
  cm.set = () => {
    throw new Error("save 不应调用 set()（每次 set 都会写盘）");
  };
  new SettingsService(cm).saveSettingsSnapshot(baseSnapshot());
});

test("SettingsService.load：读取快照并回落默认值", () => {
  const { cm } = makeConfig();
  const s = new SettingsService(cm).loadSettingsSnapshot();
  assert.equal(s.ai_default_provider, "gemini");
  assert.equal(s.gemini_model, "gemini-2.5-flash");
  assert.equal(s.ai_max_steps, 25);
  assert.equal(s.timeout_page_load, 30);
  assert.equal(s.theme, "auto");
  assert.equal(s.data_separator, "----");
  assert.equal(s.data_dir, "");
});

test("resolveProviderRuntimeConfig：界面输入优先，空白回退已保存配置", () => {
  const { cm } = makeConfig();
  cm.setAiProviderApiKey("anthropic", "SAVED-KEY");
  cm.setAiProviderBaseUrl("anthropic", "https://saved.example");
  cm.setAiProviderModel("anthropic", "saved-model");
  const svc = new SettingsService(cm);

  assert.deepEqual(svc.resolveProviderRuntimeConfig("Anthropic", "", "  ", "input-model"), [
    "SAVED-KEY",
    "https://saved.example",
    "input-model",
  ]);
  assert.deepEqual(svc.resolveProviderRuntimeConfig("anthropic", " IK ", "https://in", ""), [
    "IK",
    "https://in",
    "saved-model",
  ]);
});

// ==================== 测试连接 ====================

/**
 * 假 fetch：记录请求与请求体，按构造的 body 返回响应
 * @param {{ status?: number, body?: unknown }} [response]
 */
function fakeFetch(response = { status: 200, body: { model: "m-actual", choices: [{ message: { content: " OK " } }] } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return { calls, fetchImpl };
}

test("testAiConnection：gemini 走 OpenAI 兼容 chat/completions + Bearer", async () => {
  const { calls, fetchImpl } = fakeFetch();
  let t = 1000;
  const r = await testAiConnection(
    { provider: "gemini", apiKey: "gk", baseUrl: "https://x.example/v1beta/openai/", model: "gemini-2.5-flash" },
    { fetchImpl, now: () => (t += 50) },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://x.example/v1beta/openai/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer gk");
  assert.deepEqual(calls[0].body, {
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Hi, reply with OK" }],
    max_tokens: 10,
  });
  assert.equal(r.success, true);
  assert.equal(r.message, "连接测试成功");
  assert.deepEqual(r.details, { provider: "gemini", model: "m-actual", response_time_ms: 50, response_preview: "OK" });
});

test("testAiConnection：anthropic 去掉末尾 /v1 再拼 /v1/messages，带 x-api-key 与版本头", async () => {
  const { calls, fetchImpl } = fakeFetch({ status: 200, body: { model: "claude-x", content: [{ type: "text", text: "OK" }] } });
  const r = await testAiConnection(
    { provider: "anthropic", apiKey: "ak", baseUrl: "https://relay.example/v1/", model: "claude-3-haiku-20240307" },
    { fetchImpl },
  );
  assert.equal(calls[0].url, "https://relay.example/v1/messages");
  assert.equal(calls[0].init.headers["x-api-key"], "ak");
  assert.equal(calls[0].init.headers["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[0].body.max_tokens, 10);
  assert.equal(r.success, true);
  assert.equal(r.details.model, "claude-x");
  assert.equal(r.details.response_preview, "OK");
});

test("testAiConnection：base_url / model 为空时回退 Python 的默认值", async () => {
  const { calls, fetchImpl } = fakeFetch({ status: 200, body: {} });
  await testAiConnection({ provider: "anthropic", apiKey: "ak", baseUrl: "", model: "" }, { fetchImpl });
  assert.equal(calls[0].url, `${TEST_AI_DEFAULT_BASE_URLS.anthropic}/v1/messages`);
  assert.equal(calls[0].body.model, "claude-sonnet-4-20250514");

  await testAiConnection({ provider: "gemini", apiKey: "gk", baseUrl: "", model: "" }, { fetchImpl });
  assert.equal(calls[1].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(calls[1].body.model, "gemini-2.0-flash");
});

test("testAiConnection：无 key 不发请求；HTTP 错误与超时转成失败结果", async () => {
  const { calls, fetchImpl } = fakeFetch({ status: 401, body: { error: "bad key" } });
  const noKey = await testAiConnection({ provider: "gemini", apiKey: "", baseUrl: "", model: "" }, { fetchImpl });
  assert.equal(noKey.success, false);
  assert.equal(noKey.message, "请输入 API Key");
  assert.equal(calls.length, 0);

  const bad = await testAiConnection({ provider: "gemini", apiKey: "k", baseUrl: "", model: "" }, { fetchImpl });
  assert.equal(bad.success, false);
  assert.match(bad.message, /^测试失败: Error code: 401 - /);

  const timeout = await testAiConnection(
    { provider: "gemini", apiKey: "k", baseUrl: "", model: "" },
    {
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    },
  );
  assert.equal(timeout.success, false);
  assert.match(timeout.message, /请求超时（25s）/);
});

test("buildOpenAiCompatRequest / buildAnthropicRequest：多余斜杠被去掉", () => {
  assert.equal(buildOpenAiCompatRequest("k", "https://a.example/v1///", "m").url, "https://a.example/v1/chat/completions");
  assert.equal(buildAnthropicRequest("k", "https://api.anthropic.com", "m").url, "https://api.anthropic.com/v1/messages");
  assert.equal(buildAnthropicRequest("k", "https://r.example/proxy/v1", "m").url, "https://r.example/proxy/v1/messages");
});

// ==================== 导入 / 导出纯函数 ====================

test("parseAccountImportLine：校验照搬 batch_import_dialog.py:180-194", () => {
  assert.deepEqual(parseAccountImportLine("a@b.com"), { ok: false, error: "格式错误：至少需要 邮箱----密码" });
  assert.deepEqual(parseAccountImportLine("ab.com----pw"), { ok: false, error: "邮箱格式无效" });
  assert.deepEqual(parseAccountImportLine("a@bcom----pw"), { ok: false, error: "邮箱格式无效" });
  assert.deepEqual(parseAccountImportLine("a@b.com----  "), { ok: false, error: "密码不能为空" });
  assert.deepEqual(parseAccountImportLine(" a@b.com ---- pw "), {
    ok: true,
    data: { email: "a@b.com", password: "pw", recovery_email: "", secret_key: "" },
  });
  assert.deepEqual(parseAccountImportLine("a@b.com----pw----r@x.com----SECRETKEY123----extra"), {
    ok: true,
    data: { email: "a@b.com", password: "pw", recovery_email: "r@x.com", secret_key: "SECRETKEY123" },
  });
});

test("parseImportText：跳过空行与 # 注释，序号连续，计数正确", () => {
  const text = "# 注释\r\n\r\na@b.com----pw\n   \nbad line\n  # 缩进注释\nc@d.com----x----r@e.com----ABCDEFGHIJ\n";
  const rows = parseImportText(text, parseAccountImportLine);
  assert.deepEqual(
    rows.map((r) => [r.no, r.line, r.result.ok]),
    [
      [1, "a@b.com----pw", true],
      [2, "bad line", false],
      [3, "c@d.com----x----r@e.com----ABCDEFGHIJ", true],
    ],
  );
  assert.deepEqual(countImportRows(rows), { valid: 2, invalid: 1 });
  const third = rows[2];
  assert.ok(third && third.result.ok);
  assert.deepEqual(formatAccountPreviewRow(third.result.data), ["c@d.com", "******", "r@e.com", "ABCDEFGH..."]);
  assert.deepEqual(formatAccountPreviewRow({ email: "e", password: "p", recovery_email: "", secret_key: "12345678" }), [
    "e",
    "******",
    "",
    "12345678",
  ]);
  assert.equal(truncateInvalidLine("x".repeat(51)), `${"x".repeat(50)}...`);
  assert.equal(truncateInvalidLine("x".repeat(50)), "x".repeat(50));
});

test("parseProxyImportLine：照搬 batch_import_dialog.py:245-267", () => {
  assert.deepEqual(parseProxyImportLine("1.2.3.4"), { ok: false, error: "格式错误：至少需要 host:port" });
  assert.deepEqual(parseProxyImportLine(" :1080"), { ok: false, error: "主机不能为空" });
  assert.deepEqual(parseProxyImportLine("h:80a"), { ok: false, error: "端口必须是数字" });
  assert.deepEqual(parseProxyImportLine("h:"), { ok: false, error: "端口必须是数字" });
  const ok = parseProxyImportLine("1.2.3.4:1080:user:pass");
  assert.deepEqual(ok, {
    ok: true,
    data: { proxy_type: "socks5", host: "1.2.3.4", port: "1080", username: "user", password: "pass" },
  });
  assert.deepEqual(formatProxyPreviewRow(ok.data), ["socks5", "1.2.3.4", "1080", "user"]);
  assert.deepEqual(formatProxyPreviewRow({ ...ok.data, username: "" }), ["socks5", "1.2.3.4", "1080", "(无)"]);
});

test("buildAccountImportUpsert：已存在只更新非空字段，新账号 status=pending", () => {
  const data = { email: "a@b.com", password: "pw", recovery_email: "", secret_key: "S" };
  assert.deepEqual(buildAccountImportUpsert(data, true), { email: "a@b.com", password: "pw", secret_key: "S" });
  assert.deepEqual(buildAccountImportUpsert(data, false), {
    email: "a@b.com",
    password: "pw",
    recovery_email: "",
    secret_key: "S",
    status: "pending",
  });
});

test("isValidNewAccountEmail：非空且含 @", () => {
  assert.equal(isValidNewAccountEmail(""), false);
  assert.equal(isValidNewAccountEmail("abc"), false);
  assert.equal(isValidNewAccountEmail("a@b"), true);
});

test("buildAccountExportText：首行分隔符声明，每行四段以 \\n 结尾", () => {
  const text = buildAccountExportText([
    { email: "a@b.com", password: "p1", recovery_email: "r@x.com", secret_key: "S1" },
    { email: "c@d.com", password: "p2", recovery_email: "", secret_key: "" },
  ]);
  assert.equal(text, '分隔符="----"\na@b.com----p1----r@x.com----S1\nc@d.com----p2--------\n');
  assert.equal(buildAccountExportText([]), '分隔符="----"\n');
});

// ==================== 代理新增方法 ====================

test("ProxyRepository / ProxyAllocator.getProxyBindingDetails：返回绑定整行", () => {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  const repo = new ProxyRepository(db);
  repo.addProxy({ proxy_type: "socks5", host: "h", port: "1", username: "", password: "" });
  const added = repo.getAllProxies()[0];
  assert.ok(added);
  const id = added.id;
  assert.equal(repo.bindProxyToWindow(id, "101", "a@b.com"), true);
  assert.equal(repo.bindProxyToWindow(id, "102", null), true);

  const rows = repo.getProxyBindingDetails(id);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.proxy_id, id);
    assert.equal(typeof r.id, "number");
    assert.ok("bound_at" in r);
  }
  assert.deepEqual(rows.map((r) => r.browser_id).sort(), ["101", "102"]);
  assert.deepEqual(new ProxyAllocator(repo).getProxyBindingDetails(id), rows);
  assert.deepEqual(repo.getProxyBindingDetails(9999), []);
  db.close();
});

// ==================== handler ====================

function makeHandlers(options = {}) {
  const dataRoot = makeTmp();
  const events = [];
  let resolveFinished;
  const finished = new Promise((r) => (resolveFinished = r));
  const ctx = createHostContext({
    dataRoot,
    log: silent,
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) resolveFinished(payload);
    },
    openDatabase: () => new DatabaseSync(":memory:"),
    ixClient: options.ixClient,
  });
  const handlers = createSettingsHandlers(ctx, { fetchImpl: options.fetchImpl, sleep: async () => {} });
  // handlers 只登记了白名单里的通道；返回值形状由各用例自行断言
  const call = (channel, ...args) => /** @type {(...a: any[]) => any} */ (handlers[channel])(...args);
  return { ctx, handlers, call, events, finished, dataRoot };
}

async function rejectsInvalid(fn) {
  await assert.rejects(
    async () => fn(),
    (/** @type {{ code?: string }} */ e) => e.code === ERROR_CODES.INVALID_ARGUMENT,
  );
}

test("settings handler：登记了 SETTINGS_INVOKE 的全部通道", () => {
  const { handlers } = makeHandlers();
  assert.deepEqual(Object.keys(handlers).sort(), Object.values(SETTINGS_INVOKE).sort());
});

test("settings handler：参数校验（类型 / 范围 / 枚举 / 必填）", async () => {
  const { call } = makeHandlers();
  const I = SETTINGS_INVOKE;
  await rejectsInvalid(() => call(I.settingsSave, null));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ ai_default_provider: "openai" })));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ theme: "blue" })));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ ai_max_steps: 51 })));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ timeout_page_load: 9 })));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ default_thread_count: 2.5 })));
  await rejectsInvalid(() => call(I.settingsSave, baseSnapshot({ gemini_api_key: 123 })));
  await rejectsInvalid(() => call(I.settingsSetDataDir, ""));
  await rejectsInvalid(() => call(I.settingsSetDataDir, join(tmpdir(), "abb-no-such-dir-xyz")));
  await rejectsInvalid(() => call(I.settingsTestAi, { provider: "openai", apiKey: "", baseUrl: "", model: "" }));
  await rejectsInvalid(() => call(I.settingsTestAi, { provider: "gemini" }));
  await rejectsInvalid(() => call(I.settingsProxiesAdd, { proxy_type: "socks5", host: " ", port: "1", username: "", password: "" }));
  await rejectsInvalid(() => call(I.settingsProxiesAdd, { proxy_type: "ftp", host: "h", port: "1", username: "", password: "" }));
  await rejectsInvalid(() => call(I.settingsProxiesUpdate, { index: -1, key: "h:1" }, {}));
  await rejectsInvalid(() => call(I.settingsProxiesDelete, "x"));
  await rejectsInvalid(() => call(I.settingsProxiesDelete, []));
  await rejectsInvalid(() => call(I.settingsProxiesImport, "no valid line"));
  await rejectsInvalid(() => call(I.settingsProxiesBindings, "1"));
  await rejectsInvalid(() => call(I.settingsProxiesUnbind, "  "));
  await rejectsInvalid(() => call(I.settingsAccountsAdd, { email: "abc", password: "", recovery_email: "", secret_key: "" }));
  await rejectsInvalid(() => call(I.settingsAccountsUpdate, { email: "", password: "", recovery_email: "", secret_key: "" }));
  await rejectsInvalid(() => call(I.settingsAccountsImport, 42));
  await rejectsInvalid(() => call(I.settingsAccountsImport, "bad\n# only comment"));
  await rejectsInvalid(() => call(I.settingsAccountsDelete, []));
  await rejectsInvalid(() => call(I.settingsAccountsDelete, [1]));
  await rejectsInvalid(() => call(I.settingsGetTheme, "x"));
  await rejectsInvalid(() => call(I.settingsGetTheme, undefined));
});

test("settings handler：保存后返回最新快照；data_dir 立即写入", async () => {
  const { call, dataRoot } = makeHandlers();
  const saved = await call(SETTINGS_INVOKE.settingsSave, baseSnapshot({ data_separator: " ; " }));
  assert.equal(saved.data_separator, ";");
  assert.equal(saved.theme, "dark");
  assert.equal(await call(SETTINGS_INVOKE.settingsSetDataDir, `  ${dataRoot}  `), dataRoot);
  assert.equal((await call(SETTINGS_INVOKE.settingsLoad)).data_dir, dataRoot);
});

test("settings handler：testAi 无 key 只提示，有 key 用回退后的配置发请求", async () => {
  const { calls, fetchImpl } = fakeFetch();
  const { call, ctx } = makeHandlers({ fetchImpl });
  const missing = await call(SETTINGS_INVOKE.settingsTestAi, { provider: "anthropic", apiKey: " ", baseUrl: "", model: "" });
  assert.deepEqual(missing, { success: false, missingKey: true, message: "请先输入 ANTHROPIC API Key", details: {} });
  assert.equal(calls.length, 0);

  ctx.config().setAiProviderApiKey("gemini", "SAVED");
  const ok = await call(SETTINGS_INVOKE.settingsTestAi, { provider: "gemini", apiKey: "", baseUrl: "", model: "" });
  assert.equal(ok.success, true);
  assert.equal(ok.missingKey, false);
  assert.equal(calls[0].init.headers.authorization, "Bearer SAVED");
  // 已保存的默认 base_url 带末尾斜杠
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
});

test("settings handler：代理 增 / 导入 / 列表 / 编辑 / 删除 / 绑定详情 / 解绑", async () => {
  const { call, ctx } = makeHandlers();
  const I = SETTINGS_INVOKE;
  assert.equal(await call(I.settingsProxiesAdd, { proxy_type: "http", host: " h1 ", port: " 80 ", username: "u", password: "p" }), true);
  assert.deepEqual(await call(I.settingsProxiesImport, "h2:81\n# c\nbad\nh3:82:u3:p3"), { success_count: 2, fail_count: 0 });

  let list = await call(I.settingsProxiesList);
  assert.deepEqual(
    list.map((p) => [p.index, p.key, p.proxy_type, p.used_count, p.max_count]),
    [
      [0, "h1:80", "http", 0, 3],
      [1, "h2:81", "socks5", 0, 3],
      [2, "h3:82", "socks5", 0, 3],
    ],
  );

  // 绑定一个窗口：使用情况与详情
  const repo = new ProxyRepository(ctx.db());
  const proxyId = list[1].proxy_id;
  repo.bindProxyToWindow(proxyId, "555", "x@y.com");
  list = await call(I.settingsProxiesList);
  assert.equal(list[1].used_count, 1);
  const bindings = await call(I.settingsProxiesBindings, proxyId);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].browser_id, "555");
  assert.equal(bindings[0].email, "x@y.com");
  assert.equal(await call(I.settingsProxiesUnbind, "555"), true);
  assert.deepEqual(await call(I.settingsProxiesBindings, proxyId), []);

  // 下标漂移时拒绝
  await rejectsInvalid(() => call(I.settingsProxiesUpdate, { index: 0, key: "h2:81" }, list[0]));
  await call(I.settingsProxiesUpdate, { index: 0, key: "h1:80" }, { proxy_type: "https", host: "h1", port: "80", username: "", password: "" });
  list = await call(I.settingsProxiesList);
  assert.equal(list[0].proxy_type, "https");

  assert.equal(await call(I.settingsProxiesDelete, [{ index: 0, key: "h1:80" }, { index: 2, key: "h3:82" }]), 2);
  list = await call(I.settingsProxiesList);
  assert.deepEqual(list.map((p) => p.key), ["h2:81"]);
});

test("settings handler：账号 添加 / 编辑 / 导入（已存在只更新非空字段）", async () => {
  const { call, ctx } = makeHandlers();
  const I = SETTINGS_INVOKE;
  assert.equal(await call(I.settingsAccountsAdd, { email: " a@b.com ", password: " pw ", recovery_email: "r@x.com", secret_key: "S" }), true);
  let a = ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.equal(a.status, "pending");
  assert.equal(a.password, " pw ");

  ctx.accountRepo().upsertAccount({ email: "a@b.com", status: "subscribed" });
  await call(I.settingsAccountsUpdate, { email: "a@b.com", password: "pw2", recovery_email: "", secret_key: "S" });
  a = ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.equal(a.status, "subscribed", "编辑不改状态");
  assert.equal(a.password, "pw2");

  const r = await call(I.settingsAccountsImport, "a@b.com----pw3----new@r.com\nbad\nn@m.com----p----rr@x.com----K");
  assert.deepEqual(r, { success_count: 2, fail_count: 0 });
  a = ctx.accountRepo().getAccountByEmail("a@b.com");
  assert.ok(a);
  assert.equal(a.password, "pw3");
  assert.equal(a.recovery_email, "new@r.com");
  assert.equal(a.secret_key, "S", "空 2FA 不覆盖");
  assert.equal(a.status, "subscribed");
  const n = ctx.accountRepo().getAccountByEmail("n@m.com");
  assert.ok(n);
  assert.equal(n.status, "pending");
  assert.equal(n.secret_key, "K");

  const list = await call(I.settingsAccountsList);
  assert.deepEqual(list.map((x) => x.email), ["a@b.com", "n@m.com"]);
  assert.deepEqual(Object.keys(list[0]).sort(), ["email", "password", "recovery_email", "secret_key", "status"]);
});

/**
 * 记录调用的假 ixBrowser 客户端；getProfileList 被调到说明又在按邮箱找窗口
 * @param {(id?: string) => void} [onDelete]
 */
function recordingIx(onDelete = () => {}) {
  const calls = [];
  const ixClient = {
    async getProfileList() {
      calls.push("list");
      return [];
    },
    async closeProfile(id) {
      calls.push(`close:${id}`);
      throw new Error("未打开");
    },
    async deleteProfile(id) {
      calls.push(`delete:${id}`);
      onDelete(id);
      return true;
    },
  };
  return { calls, ixClient };
}

test("settings handler：删除账号作为后台任务，窗口取数据库绑定，先删账号再删窗口", async () => {
  let ctxRef;
  const aliveAtWindowDelete = [];
  const { calls, ixClient } = recordingIx(() => aliveAtWindowDelete.push(ctxRef.accountRepo().getAccountByEmail("a@b.com")));
  const { call, ctx, events, finished } = makeHandlers({ ixClient });
  ctxRef = ctx;
  ctx.accountRepo().upsertAccount({ email: "a@b.com", password: "p" });
  ctx.accountRepo().bindAccountToBrowser("a@b.com", "7");
  ctx.accountRepo().upsertAccount({ email: "c@d.com", password: "p" });

  const info = await call(SETTINGS_INVOKE.settingsAccountsDelete, ["a@b.com", "c@d.com", "a@b.com", ""]);
  assert.equal(info.type, SETTINGS_TASK_TYPES.deleteAccounts);
  assert.equal(info.label, "删除 2 个账号");
  await rejectsInvalid(() => call(SETTINGS_INVOKE.settingsAccountsDelete, []));
  await assert.rejects(
    async () => call(SETTINGS_INVOKE.settingsAccountsDelete, ["c@d.com"]),
    (/** @type {{ code?: string }} */ e) => e.code === ERROR_CODES.TASK_BUSY,
  );

  const done = await finished;
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, { total: 2, deleted_accounts: 2, deleted_windows: 1, failed_count: 0, failed_list: [] });
  // 只删绑定的窗口 7；关闭失败不影响删除；不再去 ixBrowser 按邮箱找窗口
  assert.deepEqual(calls, ["close:7", "delete:7"]);
  // 删窗口时账号已经从库里删掉
  assert.deepEqual(aliveAtWindowDelete, [null]);
  assert.equal(ctx.accountRepo().getAllAccounts().length, 0);
  const logs = events.filter(([c]) => c === IPC.event.taskLog).map(([, p]) => p.message);
  assert.ok(logs.includes("开始删除 2 个账号，将同时删除已绑定的 ixBrowser 窗口"));
  assert.ok(logs.includes("已删除: a@b.com"));
  assert.ok(logs.includes("删除完成: 已删除 2 个账号，1 个窗口"));
});

test("settings handler：删除账号时库里没删掉的计失败，其绑定窗口不删", async () => {
  const { calls, ixClient } = recordingIx();
  const { call, ctx, events, finished } = makeHandlers({ ixClient });
  const repo = ctx.accountRepo();
  repo.upsertAccount({ email: "x@y.com", password: "p" });
  repo.bindAccountToBrowser("x@y.com", "5");
  const realDelete = repo.deleteAccount.bind(repo);
  repo.deleteAccount = (email) => (email === "x@y.com" ? false : realDelete(email));

  // ghost@z.com 库里本来就没有
  await call(SETTINGS_INVOKE.settingsAccountsDelete, ["x@y.com", "ghost@z.com"]);
  const done = await finished;
  assert.equal(done.outcome, "succeeded");
  assert.deepEqual(done.result, {
    total: 2,
    deleted_accounts: 0,
    deleted_windows: 0,
    failed_count: 2,
    failed_list: [
      { email: "x@y.com", error: "数据库中未删除该账号" },
      { email: "ghost@z.com", error: "数据库中未删除该账号" },
    ],
  });
  assert.deepEqual(calls, []);
  assert.ok(repo.getAccountByEmail("x@y.com"));
  const items = events.filter(([c]) => c === IPC.event.taskItem).map(([, p]) => [p.key, p.status]);
  assert.deepEqual(items, [
    ["x@y.com", "失败"],
    ["ghost@z.com", "失败"],
  ]);
  const logs = events.filter(([c]) => c === IPC.event.taskLog).map(([, p]) => p.message);
  assert.ok(logs.includes("删除完成: 已删除 0 个账号，失败 2 个"));
});

// ==================== 评审修复补测 ====================

test("clampSettingsNumber / clampSettingsNumbers：越界夹到边界，范围内原样，非数值字段不动", () => {
  assert.equal(clampSettingsNumber("ai_max_steps", 999), 50);
  assert.equal(clampSettingsNumber("ai_max_steps", 0), 5);
  assert.equal(clampSettingsNumber("ai_max_steps", 30), 30);
  assert.equal(clampSettingsNumber("timeout_page_load", -5), 10);
  assert.equal(clampSettingsNumber("default_thread_count", 21), 20);

  const raw = baseSnapshot({ ai_max_steps: 100, delay_after_save: 0, proxy_max_windows_per_ip: 1000, theme: "dark" });
  const clamped = clampSettingsNumbers(raw);
  assert.equal(clamped.ai_max_steps, 50);
  assert.equal(clamped.delay_after_save, 1);
  assert.equal(clamped.proxy_max_windows_per_ip, 100);
  assert.equal(clamped.timeout_page_load, 40, "范围内不变");
  assert.equal(clamped.theme, "dark");
  assert.equal(raw.ai_max_steps, 100, "不修改入参");
  for (const [k, [min, max]] of Object.entries(SETTINGS_NUMBER_RANGES)) {
    assert.ok(clamped[k] >= min && clamped[k] <= max, k);
  }
});

test("settings handler：config.json 越界值载入后经夹紧即可保存", async () => {
  const { call, ctx } = makeHandlers();
  ctx.config().set("ai_agent.max_steps", 500);
  ctx.config().set("timeouts.page_load", 1);
  const loaded = await call(SETTINGS_INVOKE.settingsLoad);
  await rejectsInvalid(() => call(SETTINGS_INVOKE.settingsSave, loaded));
  const saved = await call(SETTINGS_INVOKE.settingsSave, clampSettingsNumbers(loaded));
  assert.equal(saved.ai_max_steps, 50);
  assert.equal(saved.timeout_page_load, 10);
});

test("SettingsService.save：保存前重读磁盘，不覆盖外部写入的表单外键", () => {
  const { cm, configFile } = makeConfig();
  cm.set("sub2api.admin_token", "OLD-TOKEN");
  const svc = new SettingsService(cm);
  svc.loadSettingsSnapshot(); // cm 内部已有缓存

  // 模拟同时运行的 Python 版直接改磁盘
  const other = new ConfigManager({ configFile, log: silent });
  other.set("sub2api.admin_token", "NEW-TOKEN");

  svc.saveSettingsSnapshot(baseSnapshot());
  assert.equal(new ConfigManager({ configFile, log: silent }).get("sub2api.admin_token"), "NEW-TOKEN");
});

test("SettingsService：加载后原样保存，密钥不被重复加密，表单外加密键保持不变", () => {
  const { cm, configFile } = makeConfig();
  cm.setAiProviderApiKey("gemini", "G-KEY");
  cm.setAiProviderApiKey("anthropic", "A-KEY");
  cm.setGmailImapPassword("app pass");
  // Sub2API / SMS-Bus 功能已删除，但它们的加密字段仍可能由 Python 版写入，必须原样保留
  cm.set("sub2api.admin_token", "SUB-TOKEN");
  cm.set("sms_bus.token", "SMS-TOKEN");
  const before = JSON.parse(readFileSync(configFile, "utf-8"));

  const svc = new SettingsService(cm);
  const snap = svc.loadSettingsSnapshot();
  assert.equal(snap.gemini_api_key, "G-KEY");
  svc.saveSettingsSnapshot(snap);
  svc.saveSettingsSnapshot(svc.loadSettingsSnapshot());

  const fresh = new ConfigManager({ configFile, log: silent });
  assert.equal(fresh.getAiProviderApiKey("gemini"), "G-KEY");
  assert.equal(fresh.getAiProviderApiKey("anthropic"), "A-KEY");
  assert.equal(fresh.getGmailImapPassword(), "app pass");
  assert.equal(fresh.get("sub2api.admin_token"), "SUB-TOKEN");
  assert.equal(fresh.get("sms_bus.token"), "SMS-TOKEN");
  const after = JSON.parse(readFileSync(configFile, "utf-8"));
  assert.equal(after.sub2api.admin_token, before.sub2api.admin_token, "表单外密文原样保留");
  assert.equal(after.sms_bus.token, before.sms_bus.token);
  assert.equal(after.ai_agent.providers.gemini.api_key, before.ai_agent.providers.gemini.api_key, "同值加密结果不变");
});

test("settings handler：getTheme 只返回 theme", async () => {
  const { call, ctx } = makeHandlers();
  assert.deepEqual(await call(SETTINGS_INVOKE.settingsGetTheme), { theme: "auto" });
  ctx.config().setAiProviderApiKey("gemini", "SECRET");
  ctx.config().set("theme", "dark");
  const r = await call(SETTINGS_INVOKE.settingsGetTheme);
  assert.deepEqual(r, { theme: "dark" });
  assert.deepEqual(Object.keys(r), ["theme"]);
});

test("dedupeProxiesByKey：按 host:port 去重，后者覆盖前者，位置取首次出现", () => {
  const p = (host, port, username) => ({ proxy_type: "socks5", host, port, username, password: "" });
  assert.deepEqual(dedupeProxiesByKey([p("h", "1", "a"), p("x", "2", ""), p("h", "1", "b")]), [p("h", "1", "b"), p("x", "2", "")]);
  assert.deepEqual(dedupeProxiesByKey([]), []);
});

test("settings handler：同批导入重复 host:port 只落一行，取最后一条；与已有代理同 key 时更新", async () => {
  const { call, ctx } = makeHandlers();
  const I = SETTINGS_INVOKE;
  await call(I.settingsProxiesAdd, { proxy_type: "http", host: "h0", port: "1", username: "", password: "" });
  const r = await call(I.settingsProxiesImport, "h1:80:u1:p1\nh2:81\nh1:80:u2:p2\nh0:1:z:z");
  assert.deepEqual(r, { success_count: 4, fail_count: 0 });
  const rows = new ProxyRepository(ctx.db()).getAllProxies();
  assert.deepEqual(
    rows.map((x) => [`${x.host}:${x.port}`, x.username]).sort(),
    [
      ["h0:1", "z"],
      ["h1:80", "u2"],
      ["h2:81", ""],
    ],
  );
});

test("settings handler：删除代理只回写一次，并级联删除被删代理的绑定", async () => {
  const { call, ctx } = makeHandlers();
  const I = SETTINGS_INVOKE;
  await call(I.settingsProxiesImport, "a:1\nb:2\nc:3");
  const repo = new ProxyRepository(ctx.db());
  const ids = Object.fromEntries(repo.getAllProxies().map((x) => [x.host, x.id]));
  repo.bindProxyToWindow(ids.a, "w1", null);
  repo.bindProxyToWindow(ids.b, "w2", null);
  repo.bindProxyToWindow(ids.c, "w3", null);

  let saves = 0;
  const orig = ProxyRepository.prototype.saveAllProxies;
  /** @param {Parameters<typeof orig>} args */
  ProxyRepository.prototype.saveAllProxies = function (...args) {
    saves += 1;
    return orig.apply(this, args);
  };
  try {
    assert.equal(await call(I.settingsProxiesDelete, [{ index: 0, key: "a:1" }, { index: 2, key: "c:3" }, { index: 0, key: "a:1" }]), 2);
  } finally {
    ProxyRepository.prototype.saveAllProxies = orig;
  }
  assert.equal(saves, 1);
  assert.deepEqual((await call(I.settingsProxiesList)).map((p) => p.key), ["b:2"]);
  assert.deepEqual(repo.getProxyBindingDetails(ids.a), []);
  assert.deepEqual(repo.getProxyBindingDetails(ids.c), []);
  assert.equal(repo.getProxyBindingDetails(ids.b).length, 1, "未删的代理绑定保留");
});

test("settings handler：删除账号任务中途停止，剩余账号保留", async () => {
  let ctxRef;
  const ixClient = {
    async getProfileList() {
      return [];
    },
    async closeProfile() {
      ctxRef.tasks.stop(); // 处理第一个账号的窗口时用户点了停止
    },
    async deleteProfile() {
      return true;
    },
  };
  const { call, ctx, finished } = makeHandlers({ ixClient });
  ctxRef = ctx;
  for (const e of ["a@b.com", "c@d.com", "e@f.com"]) ctx.accountRepo().upsertAccount({ email: e, password: "p" });
  ctx.accountRepo().bindAccountToBrowser("a@b.com", "1");

  await call(SETTINGS_INVOKE.settingsAccountsDelete, ["a@b.com", "c@d.com", "e@f.com"]);
  const done = await finished;
  assert.equal(done.outcome, "stopped");
  assert.deepEqual(ctx.accountRepo().getAllAccounts().map((a) => a.email).sort(), ["c@d.com", "e@f.com"]);
});

test("settings handler：删除未绑定窗口的账号，ixBrowser 里同名窗口保留", async () => {
  const calls = [];
  const ixClient = {
    async getProfileList() {
      calls.push("list");
      return [{ profile_id: 9, name: "a@b.com", username: "a@b.com" }];
    },
    async closeProfile(id) {
      calls.push(`close:${id}`);
    },
    async deleteProfile(id) {
      calls.push(`delete:${id}`);
      return true;
    },
  };
  const { call, ctx, finished } = makeHandlers({ ixClient });
  ctx.accountRepo().upsertAccount({ email: "a@b.com", password: "p" });
  await call(SETTINGS_INVOKE.settingsAccountsDelete, ["a@b.com"]);
  const done = await finished;
  assert.deepEqual(done.result, { total: 1, deleted_accounts: 1, deleted_windows: 0, failed_count: 0, failed_list: [] });
  assert.deepEqual(calls, []);
});
