/**
 * automation/batch-account-processor.ts 单测（全离线）
 *
 * 所有外部依赖都注入替身：
 *   - loginFn / oauthFn / unlockFn  → 假流程（不开浏览器、不调 AI）
 *   - ixClient                      → 假 ixBrowser 客户端（不碰 :53200）
 *   - accountRepo                   → 内存假仓储（不碰 accounts.db）
 *   - config                        → 假配置（不读仓库根 config.json）
 *   - createSub2ApiClient / createProxyAllocator / createBrowserUseEngine / cdpConnector
 *     → 假实现（不发 HTTP、不连 CDP）
 *   - sleepImpl                     → 只记录毫秒数的假 sleep
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

// 批量处理器用 process.stdout.write 打 `[BatchProcessor] ...` 日志。
// 这里只过滤掉它自己的日志行，其它输出（含 node:test 的 TAP）一律放行。
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string" && chunk.startsWith("[BatchProcessor] ")) return true;
  return realWrite(chunk, ...rest);
};

import {
  BatchAccountProcessor,
  quickBatchLogin,
  quickBatchOauth,
} from "../src/automation/batch-account-processor.ts";

// ==================== 替身 ====================

/** 假 ConfigManager（只实现 ConfigManagerLike 的 4 个方法） */
function fakeConfig(overrides = {}) {
  return {
    getLoginConcurrency: () => overrides.concurrency ?? 3,
    getLoginMaxRetries: () => overrides.maxRetries ?? 2,
    getLoginRetryDelay: () => overrides.retryDelay ?? 3,
    getSmsBusToken: () => overrides.smsToken ?? "",
  };
}

/** 内存假账号仓储 */
function fakeAccountRepo(rows = {}) {
  const calls = { pro: [], unlock: [], membership: [] };
  return {
    calls,
    rows,
    getAccountByEmail(email) {
      return rows[email] ?? null;
    },
    updateProStatus(email, isPro) {
      calls.pro.push({ email, isPro });
      return true;
    },
    updateUnlockStatus(email, status, validationUrl) {
      calls.unlock.push({ email, status, validationUrl });
      return true;
    },
    updateMembershipInfo(fields) {
      calls.membership.push(fields);
      return true;
    },
  };
}

/** 假 ixBrowser 客户端 */
function fakeIxClient(opts = {}) {
  const calls = { open: [], close: [] };
  return {
    calls,
    async openProfile(profileId) {
      calls.open.push(profileId);
      if (opts.openThrows) throw new Error(opts.openThrows);
      return { ws: opts.ws ?? "ws://127.0.0.1:1/devtools/browser/fake" };
    },
    async closeProfile(profileId) {
      calls.close.push(profileId);
      if (opts.closeThrows) throw new Error("关窗失败");
      return true;
    },
  };
}

/**
 * 假 Sub2ApiClient。
 * `testAccountConnection` 现在是 Sub2ApiClientLike 的**必需**方法（实现已移植），
 * 默认返回「账号需要解锁但没给新链接」，各用例按需覆盖 opts.testResult / opts.testThrows。
 */
function fakeSub2Api(opts = {}) {
  const calls = { exists: [], test: [], closed: 0 };
  return {
    calls,
    async checkAccountExists(email) {
      calls.exists.push(email);
      return opts.accountId ?? null;
    },
    async testAccountConnection(accountId, modelId) {
      calls.test.push({ accountId, modelId });
      if (opts.testThrows) throw new Error(opts.testThrows);
      return opts.testResult ?? { success: false, data: { needs_unlock: true }, error: null };
    },
    async close() {
      calls.closed += 1;
    },
  };
}

/** 假 sleep（毫秒） */
function fakeSleep() {
  const calls = [];
  return { calls, fn: async (ms) => void calls.push(ms) };
}

/** 默认 deps：一切都是替身，绝不触碰真实实现 */
function makeDeps(extra = {}) {
  return {
    config: fakeConfig(),
    ixClient: fakeIxClient(),
    sleepImpl: async () => {},
    createSub2ApiClient: () => fakeSub2Api(),
    createProxyAllocator: () => ({ allocateAndBind: async () => true }),
    createSmsClient: () => ({}),
    createBrowserUseEngine: () => ({
      connectCdp: async () => {},
      stop: async () => {},
      navigate: async () => ({ success: false, error: "离线" }),
      extract: async () => ({ success: false, error: "离线" }),
      getPageContent: async () => "",
      getCurrentUrl: async () => "about:blank",
    }),
    cdpConnector: { connect: async () => ({ page: null, close: async () => {}, dispose: async () => {}, closeContext: async () => {} }) },
    ...extra,
  };
}

const acct = (email) => ({ email, password: "pw", secret_key: "", recovery_email: "" });
const ok = (extra = {}) => ({ success: true, message: "成功", ...extra });
const fail = (message, errorType = null) => ({ success: false, message, errorType });

/** 让出事件循环若干轮 */
async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

// ==================== 构造与入参校验 ====================

test("构造: concurrency 未传（或为 0）时回落到配置值", () => {
  const p1 = new BatchAccountProcessor({}, makeDeps({ config: fakeConfig({ concurrency: 7 }) }));
  assert.equal(p1.concurrency, 7);

  const p2 = new BatchAccountProcessor({ concurrency: 0 }, makeDeps({ config: fakeConfig({ concurrency: 7 }) }));
  assert.equal(p2.concurrency, 7, "Python 用 `or`，0 也回落配置");

  const p3 = new BatchAccountProcessor({ concurrency: 2 }, makeDeps());
  assert.equal(p3.concurrency, 2);
});

test("构造: retryTimes 传入 RetryHelper（默认 2，baseDelay 2.0）", () => {
  assert.equal(new BatchAccountProcessor({}, makeDeps()).retryHelper.maxRetries, 2);
  assert.equal(new BatchAccountProcessor({ retryTimes: 5 }, makeDeps()).retryHelper.maxRetries, 5);
  assert.equal(new BatchAccountProcessor({}, makeDeps()).retryHelper.baseDelay, 2.0);
});

test("batchLogin: 账号数与窗口数不匹配时抛错", async () => {
  const p = new BatchAccountProcessor({}, makeDeps());
  await assert.rejects(
    () => p.batchLogin([acct("a@x.com"), acct("b@x.com")], ["1"]),
    /账号数量与浏览器窗口数量不匹配/,
  );
});

test("batchOauth / batchUnlock403 / batchDetectPro / batchRefreshMembershipInfo 同样校验数量", async () => {
  const p = new BatchAccountProcessor({}, makeDeps());
  const accounts = [acct("a@x.com")];
  await assert.rejects(() => p.batchOauth(accounts, []), /账号数量与浏览器窗口数量不匹配/);
  await assert.rejects(() => p.batchUnlock403(accounts, []), /账号数量与浏览器窗口数量不匹配/);
  await assert.rejects(() => p.batchDetectPro(accounts, []), /账号数量与浏览器窗口数量不匹配/);
  await assert.rejects(
    () => p.batchRefreshMembershipInfo(accounts, []),
    /账号数量与浏览器窗口数量不匹配/,
  );
});

// ==================== batchLogin ====================

test("batchLogin: 全部成功，结果记录 browser_id / attempts", async () => {
  const seen = [];
  const p = new BatchAccountProcessor(
    { concurrency: 2 },
    makeDeps({
      loginFn: async ({ browserId, account }) => {
        seen.push({ browserId, email: account.email });
        return ok({ totalSteps: 9 });
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com"), acct("b@x.com")], ["11", "22"]);

  assert.equal(result.total, 2);
  assert.equal(result.success_count, 2);
  assert.equal(result.failed_count, 0);
  assert.equal(result.skipped_count, 0);
  assert.equal(result.results[0].status, "success");
  assert.deepEqual(result.results[0].data, { browser_id: "11", total_steps: 9, attempts: 1 });
  assert.deepEqual(seen, [
    { browserId: "11", email: "a@x.com" },
    { browserId: "22", email: "b@x.com" },
  ]);
  assert.ok(result.start_time !== null && result.end_time !== null);
});

test("batchLogin: 首次失败、第二次成功，期间按 retryDelay 秒睡眠", async () => {
  const sleep = fakeSleep();
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 3 }),
      sleepImpl: sleep.fn,
      loginFn: async () => {
        calls += 1;
        return calls === 1 ? fail("验证码错误", "captcha") : ok();
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(result.success_count, 1);
  assert.equal(calls, 2);
  assert.equal(result.results[0].data.attempts, 2);
  assert.deepEqual(sleep.calls, [3000], "retryDelay(3 秒) → sleepImpl(3000 毫秒)");
});

test("batchLogin: 尝试次数用尽后记为失败，保留最后一次的 message / errorType", async () => {
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 3, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        return fail("密码错误", "bad_password");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(calls, 3);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(result.results[0], {
    email: "a@x.com",
    status: "failed",
    error: "密码错误",
    error_type: "bad_password",
  });
});

test("batchLogin: 不可重试的错误类型立即 break，不再尝试", async () => {
  for (const errorType of ["stagehand_unavailable", "no_api_key", "browser_open_failed"]) {
    let calls = 0;
    const p = new BatchAccountProcessor(
      { concurrency: 1 },
      makeDeps({
        config: fakeConfig({ maxRetries: 5, retryDelay: 1 }),
        loginFn: async () => {
          calls += 1;
          return fail("致命错误", errorType);
        },
      }),
    );

    const result = await p.batchLogin([acct("a@x.com")], ["11"]);
    assert.equal(calls, 1, `${errorType} 应该只尝试一次`);
    assert.equal(result.results[0].error_type, errorType);
  }
});

test("batchLogin: options.maxRetries 覆盖配置里的次数", async () => {
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        return fail("失败");
      },
    }),
  );
  await p.batchLogin([acct("a@x.com")], ["11"], { maxRetries: 4 });
  assert.equal(calls, 4);
});

test("batchLogin: loginFn 抛异常时记为 exception 失败", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        throw new Error("引擎崩了");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error, "引擎崩了");
  assert.equal(result.results[0].error_type, "exception");
});

test("batchLogin: stop() 之后未开始的账号全部记为跳过", async () => {
  let started = 0;
  const processorRef = {};
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      loginFn: async () => {
        started += 1;
        if (started === 1) processorRef.p.stop();
        return ok();
      },
    }),
  );
  processorRef.p = p;

  const accounts = ["a", "b", "c", "d"].map((n) => acct(`${n}@x.com`));
  const result = await p.batchLogin(accounts, ["1", "2", "3", "4"]);

  assert.equal(started, 1, "停止后不再执行新的登录");
  assert.equal(result.success_count, 1);
  assert.equal(result.skipped_count, 3);
  assert.ok(result.results.slice(1).every((r) => r.status === "skipped" && r.reason === "用户停止"));
});

test("batchLogin: 并发数受 concurrency 限制（峰值恰为 2）", async () => {
  let active = 0;
  let peak = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 2 },
    makeDeps({
      loginFn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(3);
        active -= 1;
        return ok();
      },
    }),
  );

  const accounts = ["a", "b", "c", "d", "e"].map((n) => acct(`${n}@x.com`));
  const result = await p.batchLogin(accounts, ["1", "2", "3", "4", "5"]);

  assert.equal(peak, 2);
  assert.equal(result.success_count, 5);
});

test("batchLogin: concurrency=1 时严格串行（峰值 1）", async () => {
  let active = 0;
  let peak = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      loginFn: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick(2);
        active -= 1;
        return ok();
      },
    }),
  );
  await p.batchLogin([acct("a@x.com"), acct("b@x.com"), acct("c@x.com")], ["1", "2", "3"]);
  assert.equal(peak, 1);
});

test("batchLogin: 进度回调同时收到 _log 的每条消息", async () => {
  const msgs = [];
  const p = new BatchAccountProcessor(
    { concurrency: 1, callback: (m) => msgs.push(m) },
    makeDeps({ loginFn: async () => ok() }),
  );
  await p.batchLogin([acct("a@x.com")], ["11"]);
  assert.ok(msgs.some((m) => m.includes("开始批量登录")));
  assert.ok(msgs.some((m) => m.includes("✅ 登录成功")));
  assert.ok(msgs.some((m) => m.includes("批量登录完成")));
});

// ==================== batchOauth ====================

test("batchOauth: 数据库里已 linked 的账号被跳过，不执行 OAuth", async () => {
  let called = 0;
  const repo = fakeAccountRepo({ "a@x.com": { sub2api_status: "linked" } });
  const ix = fakeIxClient();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      accountRepo: repo,
      ixClient: ix,
      oauthFn: async () => {
        called += 1;
        return ok();
      },
    }),
  );

  const result = await p.batchOauth([acct("a@x.com"), acct("b@x.com")], ["11", "22"]);

  assert.equal(called, 1, "只有 b@x.com 真正跑了 OAuth");
  assert.equal(result.skipped_count, 1);
  assert.deepEqual(result.results[0], { email: "a@x.com", status: "skipped", reason: "已关联" });
  assert.deepEqual(ix.calls.close, [22], "只有成功的那个关窗");
});

test("batchOauth: 成功后关闭浏览器窗口并记录 sub2api_account_id", async () => {
  const ix = fakeIxClient();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      ixClient: ix,
      oauthFn: async () => ok({ sub2apiAccountId: 4321 }),
    }),
  );

  const result = await p.batchOauth([acct("a@x.com")], ["77"]);

  assert.equal(result.success_count, 1);
  assert.deepEqual(result.results[0].data, {
    browser_id: "77",
    sub2api_account_id: 4321,
    total_steps: undefined,
  });
  assert.deepEqual(ix.calls.close, [77]);
});

test("batchOauth: 失败时不关窗，方便调试", async () => {
  const ix = fakeIxClient();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ ixClient: ix, oauthFn: async () => fail("授权被拒", "denied") }),
  );

  const result = await p.batchOauth([acct("a@x.com")], ["77"]);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error_type, "denied");
  assert.deepEqual(ix.calls.close, []);
});

test("batchOauth: 关窗失败只记日志，不影响成功结果", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ ixClient: fakeIxClient({ closeThrows: true }), oauthFn: async () => ok() }),
  );
  const result = await p.batchOauth([acct("a@x.com")], ["77"]);
  assert.equal(result.success_count, 1);
});

test("batchOauth: oauthFn 抛异常 → exception 失败", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      oauthFn: async () => {
        throw new Error("网络中断");
      },
    }),
  );
  const result = await p.batchOauth([acct("a@x.com")], ["77"]);
  assert.equal(result.results[0].error, "网络中断");
  assert.equal(result.results[0].error_type, "exception");
});

test("batchOauth: 未传 sub2apiClient 时自建并在结束时关闭；传入时不关", async () => {
  const created = fakeSub2Api();
  const p1 = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ createSub2ApiClient: () => created, oauthFn: async () => ok() }),
  );
  await p1.batchOauth([acct("a@x.com")], ["1"]);
  assert.equal(created.calls.closed, 1);

  const injected = fakeSub2Api();
  const p2 = new BatchAccountProcessor({ concurrency: 1 }, makeDeps({ oauthFn: async () => ok() }));
  await p2.batchOauth([acct("a@x.com")], ["1"], { sub2apiClient: injected });
  assert.equal(injected.calls.closed, 0, "外部传入的客户端由调用方负责关闭");
});

test("batchOauth: autoBindProxy 默认 true 时创建代理分配器并透传给 oauthFn", async () => {
  const allocator = { allocateAndBind: async () => true };
  let seenArgs = null;
  const deps = makeDeps({
    createProxyAllocator: () => allocator,
    oauthFn: async (args) => {
      seenArgs = args;
      return ok();
    },
  });

  const p = new BatchAccountProcessor({ concurrency: 1 }, deps);
  await p.batchOauth([acct("a@x.com")], ["1"]);
  assert.equal(seenArgs.proxyAllocator, allocator);
  assert.equal(seenArgs.autoBindProxy, true);
  assert.equal(seenArgs.skipLoginCheck, false);

  const p2 = new BatchAccountProcessor({ concurrency: 1 }, deps);
  await p2.batchOauth([acct("a@x.com")], ["1"], { autoBindProxy: false, skipLogin: true });
  assert.equal(seenArgs.proxyAllocator, null);
  assert.equal(seenArgs.autoBindProxy, false);
  assert.equal(seenArgs.skipLoginCheck, true);
});

test("batchOauth: stop() 之后剩余账号被跳过", async () => {
  const processorRef = {};
  let started = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      oauthFn: async () => {
        started += 1;
        processorRef.p.stop();
        return ok();
      },
    }),
  );
  processorRef.p = p;

  const result = await p.batchOauth([acct("a@x.com"), acct("b@x.com")], ["1", "2"]);
  assert.equal(started, 1);
  assert.equal(result.skipped_count, 1);
});

// ==================== batchLoginAndOauth ====================

test("batchLoginAndOauth: 只有 login_status=logged_in 的账号进入 OAuth 阶段", async () => {
  const repo = fakeAccountRepo({
    "a@x.com": { login_status: "logged_in" },
    "b@x.com": { login_status: "failed" },
    "c@x.com": { login_status: "logged_in" },
  });
  const oauthSeen = [];

  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      accountRepo: repo,
      loginFn: async () => ok(),
      oauthFn: async ({ account, browserId, skipLoginCheck }) => {
        oauthSeen.push({ email: account.email, browserId, skipLoginCheck });
        return ok();
      },
    }),
  );

  const accounts = ["a", "b", "c"].map((n) => acct(`${n}@x.com`));
  const { login, oauth } = await p.batchLoginAndOauth(accounts, ["10", "20", "30"]);

  assert.equal(login.total, 3);
  assert.equal(login.success_count, 3);
  assert.equal(oauth.total, 2, "只有 2 个账号进入 OAuth");
  assert.deepEqual(oauthSeen, [
    { email: "a@x.com", browserId: "10", skipLoginCheck: true },
    { email: "c@x.com", browserId: "30", skipLoginCheck: true },
  ]);
});

test("batchLoginAndOauth: 没有任何账号登录成功时 oauth 结果 total=0 且不跑 OAuth", async () => {
  let oauthCalls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      accountRepo: fakeAccountRepo({}),
      config: fakeConfig({ maxRetries: 1 }),
      loginFn: async () => fail("登录失败"),
      oauthFn: async () => {
        oauthCalls += 1;
        return ok();
      },
    }),
  );

  const { login, oauth } = await p.batchLoginAndOauth([acct("a@x.com")], ["1"]);
  assert.equal(login.failed_count, 1);
  assert.equal(oauth.total, 0);
  assert.equal(oauth.results.length, 0);
  assert.equal(oauthCalls, 0);
});

test("batchLoginAndOauth: 登录阶段被 stop() 时直接返回空 OAuth 结果", async () => {
  const processorRef = {};
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      accountRepo: fakeAccountRepo({ "a@x.com": { login_status: "logged_in" } }),
      loginFn: async () => {
        processorRef.p.stop();
        return ok();
      },
      oauthFn: async () => ok(),
    }),
  );
  processorRef.p = p;

  const { oauth } = await p.batchLoginAndOauth([acct("a@x.com")], ["1"]);
  assert.equal(oauth.total, 0);
});

test("batchLoginAndOauth: 未注入 accountRepo 时没有账号能通过筛选", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ loginFn: async () => ok(), oauthFn: async () => ok() }),
  );
  const { login, oauth } = await p.batchLoginAndOauth([acct("a@x.com")], ["1"]);
  assert.equal(login.success_count, 1);
  assert.equal(oauth.total, 0);
});

// ==================== batchUnlock403 ====================

test("batchUnlock403: 未配置 SMS-Bus Token 时直接返回空结果", async () => {
  let unlockCalls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ smsToken: "" }),
      unlockFn: async () => {
        unlockCalls += 1;
        return ok();
      },
    }),
  );

  const result = await p.batchUnlock403([acct("a@x.com")], ["1"]);
  assert.equal(result.total, 1);
  assert.equal(result.results.length, 0);
  assert.equal(unlockCalls, 0);
});

test("batchUnlock403: 没有 validation_url 的账号被跳过", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ config: fakeConfig({ smsToken: "tk" }), unlockFn: async () => ok() }),
  );
  const result = await p.batchUnlock403([acct("a@x.com")], ["1"]);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.results[0].reason, "无验证链接");
});

test("batchUnlock403: 解锁成功后关窗并记录 phone_used / attempts", async () => {
  const ix = fakeIxClient();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ smsToken: "tk" }),
      ixClient: ix,
      unlockFn: async () => ok({ phoneUsed: "+8613800000000", attempts: 2 }),
    }),
  );

  const account = { ...acct("a@x.com"), validation_url: "https://accounts.google.com/verify?x=1" };
  const result = await p.batchUnlock403([account], ["9"]);

  assert.equal(result.success_count, 1);
  assert.deepEqual(result.results[0].data, {
    browser_id: "9",
    phone_used: "+8613800000000",
    attempts: 2,
  });
  assert.deepEqual(ix.calls.close, [9]);
});

test("batchUnlock403: 解锁失败时不关窗", async () => {
  const ix = fakeIxClient();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ smsToken: "tk" }),
      ixClient: ix,
      unlockFn: async () => fail("验证码超时", "sms_timeout"),
    }),
  );
  const account = { ...acct("a@x.com"), validation_url: "https://v" };
  const result = await p.batchUnlock403([account], ["9"]);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(ix.calls.close, []);
});

// ==================== batchDetectPro ====================

test("batchDetectPro: 打开浏览器失败 → browser_open_failed", async () => {
  const repo = fakeAccountRepo();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ accountRepo: repo, ixClient: fakeIxClient({ openThrows: "窗口不存在" }) }),
  );

  const result = await p.batchDetectPro([acct("a@x.com")], ["1"]);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error_type, "browser_open_failed");
  assert.equal(result.results[0].error, "窗口不存在");
});

test("batchDetectPro: 拿不到 WebSocket 端点 → no_ws_endpoint", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ ixClient: fakeIxClient({ ws: "" }) }),
  );
  const result = await p.batchDetectPro([acct("a@x.com")], ["1"]);
  assert.equal(result.results[0].error_type, "no_ws_endpoint");
});

test("batchDetectPro: CDP 连接拿不到页面 → no_context，并追加统计摘要行", async () => {
  const p = new BatchAccountProcessor({ concurrency: 1 }, makeDeps());
  const result = await p.batchDetectPro([acct("a@x.com")], ["1"]);

  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error_type, "no_context");

  const summary = result.results.at(-1);
  assert.equal(summary._summary, true);
  assert.deepEqual(summary, {
    _summary: true,
    pro_count: 0,
    pro_regular_count: 0,
    pro_family_count: 0,
    non_pro_count: 0,
  });
});

test("batchDetectPro: stop() 后剩余账号跳过", async () => {
  const p = new BatchAccountProcessor({ concurrency: 1 }, makeDeps());
  p.stop();
  const result = await p.batchDetectPro([acct("a@x.com")], ["1"]);
  // batchDetectPro 入口会重置 stopFlag，因此这里跑的是正常流程
  assert.equal(result.total, 1);
  assert.equal(result.skipped_count, 0);
});

// ==================== batchRefreshMembershipInfo ====================

test("batchRefreshMembershipInfo: pro_only 模式下 Pro 检测失败 → detection_failed 并写库", async () => {
  const repo = fakeAccountRepo();
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ accountRepo: repo }),
  );

  const result = await p.batchRefreshMembershipInfo([acct("a@x.com")], ["1"], "pro_only");

  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error_type, "detection_failed");
  assert.deepEqual(repo.calls.pro, [{ email: "a@x.com", isPro: "detection_failed" }]);
});

test("batchRefreshMembershipInfo: full 模式创建刷新任务并在结束时收尾", async () => {
  const taskCalls = { create: [], items: [], started: [], updated: [], finished: [] };
  const refreshTaskRepo = {
    createRefreshTask(mode, total) {
      taskCalls.create.push({ mode, total });
      return 42;
    },
    createTaskItems(taskId, emails) {
      taskCalls.items.push({ taskId, emails });
    },
    updateTaskItemStarted(taskId, email) {
      taskCalls.started.push({ taskId, email });
    },
    updateTaskItem(taskId, email, status, result) {
      taskCalls.updated.push({ taskId, email, status, result });
    },
    finishTask(taskId, status, successCount, failedCount) {
      taskCalls.finished.push({ taskId, status, successCount, failedCount });
    },
  };

  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ accountRepo: fakeAccountRepo(), refreshTaskRepo }),
  );

  const result = await p.batchRefreshMembershipInfo([acct("a@x.com")], ["1"], "full");

  assert.deepEqual(taskCalls.create, [{ mode: "full", total: 1 }]);
  assert.deepEqual(taskCalls.items, [{ taskId: 42, emails: ["a@x.com"] }]);
  assert.deepEqual(taskCalls.started, [{ taskId: 42, email: "a@x.com" }]);
  assert.equal(taskCalls.finished.length, 1);
  assert.equal(taskCalls.finished[0].status, "completed");
  // 离线假引擎导航必失败 → Pro 检测失败
  assert.equal(result.failed_count, 1);
  assert.equal(taskCalls.updated[0].status, "failed");
});

test("batchRefreshMembershipInfo: 结果末尾附带 _summary 统计行", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ accountRepo: fakeAccountRepo() }),
  );
  const result = await p.batchRefreshMembershipInfo([acct("a@x.com")], ["1"], "pro_only");
  const summary = result.results.at(-1);
  assert.equal(summary._summary, true);
  assert.equal(summary.pro_count, 0);
});

test("batchRefreshMembershipInfo: 打开浏览器失败 → browser_open_failed", async () => {
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({ ixClient: fakeIxClient({ openThrows: "打不开" }), accountRepo: fakeAccountRepo() }),
  );
  const result = await p.batchRefreshMembershipInfo([acct("a@x.com")], ["1"], "pro_only");
  assert.equal(result.results[0].error_type, "browser_open_failed");
});

// ==================== 便捷函数 ====================

test("quickBatchLogin: 默认并发 3，透传 maxRetries 与 deps", async () => {
  let calls = 0;
  const result = await quickBatchLogin(
    [acct("a@x.com"), acct("b@x.com")],
    ["1", "2"],
    { concurrency: 2, maxRetries: 1 },
    makeDeps({
      loginFn: async () => {
        calls += 1;
        return ok();
      },
    }),
  );
  assert.equal(result.success_count, 2);
  assert.equal(calls, 2);
});

test("quickBatchOauth: 走 batchOauth 全流程", async () => {
  const ix = fakeIxClient();
  const result = await quickBatchOauth(
    [acct("a@x.com")],
    ["5"],
    { concurrency: 1 },
    makeDeps({ ixClient: ix, oauthFn: async () => ok({ sub2apiAccountId: 1 }) }),
  );
  assert.equal(result.success_count, 1);
  assert.deepEqual(ix.calls.close, [5]);
});

// ==================== batchLogin: 失败结果 + 后续异常（Python 行为基线） ====================

test("batchLogin: 先失败再抛异常时报告的是较早那次的 message —— 与 Python L410-425 一致，是照搬而非 bug", async () => {
  // Python 里 login_result 只在「拿到返回值」时被赋值，异常分支只写 last_error；
  // 循环跑完后 `if login_result:` 为真 → 用的是第 1 次的 message / error_type，
  // 第 2 次的异常文本被丢弃（只进日志）。TS 侧逐行照搬了这个控制流。
  let calls = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      config: fakeConfig({ maxRetries: 2, retryDelay: 1 }),
      loginFn: async () => {
        calls += 1;
        if (calls === 1) return fail("第一次：验证码错误", "captcha");
        throw new Error("第二次：引擎崩了");
      },
    }),
  );

  const result = await p.batchLogin([acct("a@x.com")], ["11"]);

  assert.equal(calls, 2);
  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error, "第一次：验证码错误");
  assert.equal(result.results[0].error_type, "captcha");
  assert.ok(
    !String(result.results[0].error).includes("引擎崩了"),
    "后发生的异常文本不会出现在结果里",
  );
});

// ==================== batchUnlock403: 「重新检测 403」整段（对标 Python L772-803） ====================

/** 带 SMS token 的解锁场景脚手架 */
function unlockSetup(extra = {}) {
  const repo = fakeAccountRepo();
  const ix = fakeIxClient();
  const unlockSeen = [];
  const sub2api = fakeSub2Api(extra.sub2apiOpts ?? {});
  const deps = makeDeps({
    config: fakeConfig({ smsToken: "sms-token" }),
    accountRepo: repo,
    ixClient: ix,
    createSub2ApiClient: () => sub2api,
    unlockFn: async (args) => {
      unlockSeen.push({ email: args.account.email, validationUrl: args.validationUrl });
      return extra.unlockResult ?? ok({ phoneUsed: "+1555", attempts: 1 });
    },
  });
  const p = new BatchAccountProcessor({ concurrency: 1 }, deps);
  return { p, repo, ix, sub2api, unlockSeen };
}

const NEW_URL = "https://accounts.google.com/signin/continue?token=NEW";
const DB_URL = "https://accounts.google.com/signin/continue?token=OLD";

test("batchUnlock403: 重新检测拿到新验证链接 → 用新链接并写库 needs_unlock", async () => {
  const { p, repo, sub2api, unlockSeen } = unlockSetup({
    sub2apiOpts: {
      accountId: 555,
      testResult: {
        success: false,
        data: { needs_unlock: true, validation_url: NEW_URL, account_id: 555 },
        error: "VALIDATION_REQUIRED",
      },
    },
  });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  const result = await p.batchUnlock403([account], ["9"]);

  assert.deepEqual(sub2api.calls.exists, ["a@x.com"]);
  assert.deepEqual(sub2api.calls.test, [{ accountId: 555, modelId: undefined }]);
  assert.deepEqual(unlockSeen, [{ email: "a@x.com", validationUrl: NEW_URL }], "使用新链接");
  assert.deepEqual(repo.calls.unlock, [
    { email: "a@x.com", status: "needs_unlock", validationUrl: NEW_URL },
  ]);
  assert.equal(result.success_count, 1);
});

test("batchUnlock403: needs_unlock 但没给新链接 → 回落数据库链接，不写库", async () => {
  const { p, repo, unlockSeen } = unlockSetup({
    sub2apiOpts: {
      accountId: 555,
      testResult: { success: false, data: { needs_unlock: true, validation_url: "" }, error: null },
    },
  });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  await p.batchUnlock403([account], ["9"]);

  assert.deepEqual(unlockSeen, [{ email: "a@x.com", validationUrl: DB_URL }]);
  assert.deepEqual(repo.calls.unlock, [], "没有新链接就不更新 validation_url");
});

test("batchUnlock403: 检测显示账号已正常 → 写 unlocked 并记 add_success({skipped:true, reason:'已解锁'})", async () => {
  const { p, repo, ix, unlockSeen } = unlockSetup({
    sub2apiOpts: {
      accountId: 555,
      testResult: { success: true, data: { account_id: 555, status: "ok" }, error: null },
    },
  });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  const result = await p.batchUnlock403([account], ["9"]);

  // 照搬 Python L793-798：走的是 add_success（不是 add_skipped），data 里带 skipped 标记
  assert.equal(result.success_count, 1);
  assert.equal(result.skipped_count, 0);
  assert.deepEqual(result.results[0], {
    email: "a@x.com",
    status: "success",
    data: { skipped: true, reason: "已解锁" },
  });
  assert.deepEqual(repo.calls.unlock, [
    { email: "a@x.com", status: "unlocked", validationUrl: undefined },
  ]);
  assert.deepEqual(unlockSeen, [], "不再执行解锁流程");
  assert.deepEqual(ix.calls.close, [], "提前 return，不关窗");
});

test("batchUnlock403: 检测返回其它失败（无 needs_unlock）→ 回落数据库链接继续解锁", async () => {
  const { p, repo, unlockSeen } = unlockSetup({
    sub2apiOpts: {
      accountId: 555,
      testResult: { success: false, data: null, error: "upstream 500" },
    },
  });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  const result = await p.batchUnlock403([account], ["9"]);

  assert.deepEqual(unlockSeen, [{ email: "a@x.com", validationUrl: DB_URL }]);
  assert.deepEqual(repo.calls.unlock, []);
  assert.equal(result.success_count, 1);
});

test("batchUnlock403: 检测失败且库里也没有链接 → 跳过（无验证链接）", async () => {
  const { p, unlockSeen } = unlockSetup({
    sub2apiOpts: {
      accountId: 555,
      testResult: { success: false, data: { needs_unlock: true, validation_url: "" }, error: null },
    },
  });

  const result = await p.batchUnlock403([acct("a@x.com")], ["9"]);
  assert.equal(result.skipped_count, 1);
  assert.equal(result.results[0].reason, "无验证链接");
  assert.deepEqual(unlockSeen, []);
});

test("batchUnlock403: Sub2API 查不到账号 → 不调 testAccountConnection，直接用库里的链接", async () => {
  const { p, sub2api, unlockSeen } = unlockSetup({ sub2apiOpts: { accountId: null } });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  await p.batchUnlock403([account], ["9"]);

  assert.deepEqual(sub2api.calls.test, []);
  assert.deepEqual(unlockSeen, [{ email: "a@x.com", validationUrl: DB_URL }]);
});

test("batchUnlock403: testAccountConnection 抛异常 → 落到外层 catch 记 exception（与 Python 一致）", async () => {
  // Python 侧同样没有对这次调用单独 try，异常会被 _unlock_with_semaphore 的
  // `except Exception` 兜住并 add_failed(..., "exception")，不会回落到库里的链接。
  const { p, unlockSeen } = unlockSetup({
    sub2apiOpts: { accountId: 555, testThrows: "sub2api 连接被重置" },
  });

  const account = { ...acct("a@x.com"), validation_url: DB_URL };
  const result = await p.batchUnlock403([account], ["9"]);

  assert.equal(result.failed_count, 1);
  assert.equal(result.results[0].error, "sub2api 连接被重置");
  assert.equal(result.results[0].error_type, "exception");
  assert.deepEqual(unlockSeen, [], "异常打断了整条流程");
});

// ==================== deps.db 注入路径 ====================

/** 内存 accounts 表（只建 batchOauth 会读到的列），绝不碰仓库根的 accounts.db */
function memoryDb(rows = []) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE accounts (
    email TEXT PRIMARY KEY,
    login_status TEXT,
    sub2api_status TEXT,
    is_pro TEXT,
    updated_at TIMESTAMP
  )`);
  for (const r of rows) {
    db.prepare("INSERT INTO accounts (email, login_status, sub2api_status) VALUES (?, ?, ?)").run(
      r.email,
      r.login_status ?? null,
      r.sub2api_status ?? null,
    );
  }
  return db;
}

test("deps.db: 自动构造 accountRepo —— batchOauth 能读到 linked 状态并跳过", async () => {
  const db = memoryDb([
    { email: "a@x.com", sub2api_status: "linked" },
    { email: "b@x.com", sub2api_status: null },
  ]);
  let called = 0;
  const deps = makeDeps({
    db,
    oauthFn: async () => {
      called += 1;
      return ok();
    },
  });
  delete deps.accountRepo; // 确认走的是 db 自动构造这条路

  const p = new BatchAccountProcessor({ concurrency: 1 }, deps);
  const result = await p.batchOauth([acct("a@x.com"), acct("b@x.com")], ["1", "2"]);

  assert.equal(result.skipped_count, 1);
  assert.deepEqual(result.results[0], { email: "a@x.com", status: "skipped", reason: "已关联" });
  assert.equal(called, 1);
});

test("deps.db: 自动构造 refreshTaskRepo —— full 模式真的往任务表里写记录", async () => {
  const db = memoryDb([{ email: "a@x.com" }]);
  // AccountRefreshRepository 需要的两张表（列与生产库一致）
  db.exec(`CREATE TABLE account_refresh_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT, task_mode TEXT, status TEXT, total_count INTEGER,
    progress_current INTEGER DEFAULT 0, progress_percent REAL DEFAULT 0,
    success_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
    started_at TIMESTAMP, finished_at TIMESTAMP, created_at TIMESTAMP
  )`);
  db.exec(`CREATE TABLE account_refresh_task_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER, email TEXT, status TEXT, error_message TEXT,
    is_pro TEXT, pro_plan_name TEXT, family_role TEXT, family_manager_email TEXT,
    has_family_group TEXT, family_member_count INTEGER, family_slots_left INTEGER,
    account_country TEXT, started_at TIMESTAMP, finished_at TIMESTAMP
  )`);

  const p = new BatchAccountProcessor({ concurrency: 1 }, makeDeps({ db }));
  await p.batchRefreshMembershipInfo([acct("a@x.com")], ["1"], "full");

  const tasks = db.prepare("SELECT * FROM account_refresh_tasks").all();
  assert.equal(tasks.length, 1, "任务记录由自动构造的 refreshTaskRepo 写入");
  assert.equal(tasks[0].task_mode, "full");
  const items = db.prepare("SELECT * FROM account_refresh_task_items").all();
  assert.equal(items.length, 1);
  assert.equal(items[0].email, "a@x.com");
});

test("deps.db: 显式注入的仓储优先于 db 自动构造", async () => {
  const db = memoryDb([{ email: "a@x.com", sub2api_status: "linked" }]);
  const repo = fakeAccountRepo({}); // 库里说 linked，假仓储说没这个账号
  let called = 0;
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      db,
      accountRepo: repo,
      oauthFn: async () => {
        called += 1;
        return ok();
      },
    }),
  );

  const result = await p.batchOauth([acct("a@x.com")], ["1"]);
  assert.equal(called, 1, "显式仓储胜出，所以没有被判为已关联");
  assert.equal(result.skipped_count, 0);
});

test("构造: 既无 db 也无仓储时输出 ⚠️ 未注入 告警（两个仓储都列出）", () => {
  const msgs = [];
  const deps = makeDeps();
  delete deps.accountRepo;
  delete deps.refreshTaskRepo;
  new BatchAccountProcessor({ callback: (m) => msgs.push(m) }, deps);

  const warn = msgs.find((m) => m.startsWith("⚠️ 未注入"));
  assert.ok(warn, `应有告警，实际: ${JSON.stringify(msgs)}`);
  assert.match(warn, /accountRepo \/ refreshTaskRepo/);
  assert.match(warn, /请注入 deps\.db 或对应仓储/);
});

test("构造: 只缺一个仓储时告警只列出缺的那个", () => {
  const msgs = [];
  new BatchAccountProcessor(
    { callback: (m) => msgs.push(m) },
    makeDeps({ accountRepo: fakeAccountRepo() }),
  );
  const warn = msgs.find((m) => m.startsWith("⚠️ 未注入"));
  assert.ok(warn);
  assert.match(warn, /未注入 refreshTaskRepo（/);
  assert.ok(!warn.includes("accountRepo"));
});

test("构造: 给了 db 之后不再告警", () => {
  const msgs = [];
  const deps = makeDeps({ db: memoryDb() });
  delete deps.accountRepo;
  delete deps.refreshTaskRepo;
  new BatchAccountProcessor({ callback: (m) => msgs.push(m) }, deps);
  assert.equal(
    msgs.filter((m) => m.startsWith("⚠️ 未注入")).length,
    0,
  );
});

// ==================== batchRefreshMembershipInfo: full 模式成功路径 ====================

/**
 * 能走通 Step 1/2/3 的假引擎（仍然零 LLM、零浏览器）：
 *   - navigate 恒成功，并记录「当前 URL」
 *   - extract 按指令文本分派预置结果
 *   - getPageContent 按当前 URL 返回不同页面文本
 */
function fakeFullEngine(opts = {}) {
  const calls = { navigate: [], extract: [], stop: [], connect: 0 };
  let currentUrl = "about:blank";
  return {
    calls,
    async connectCdp() {
      calls.connect += 1;
    },
    async stop(closeBrowser) {
      calls.stop.push(closeBrowser);
    },
    async navigate(url) {
      calls.navigate.push(url);
      currentUrl = url;
      return { success: true };
    },
    async extract(instruction, schema, options) {
      calls.extract.push({ instruction, options });
      // Pro 状态检测（pro-status-detector 的 PRO_DETECT_INSTRUCTION）
      if (instruction.includes("Google One page")) {
        return {
          success: true,
          data: { is_subscribed: true, is_family_member: false, plan_name: "2 TB" },
        };
      }
      // 账户国家提取
      if (instruction.includes("account_country")) {
        return { success: true, data: { account_country: opts.country ?? "Japan" } };
      }
      // 管理员邮箱补充提取：默认不提供
      return { success: false, error: "未预置的 extract" };
    },
    async getPageContent() {
      if (currentUrl.includes("one.google.com")) {
        // 含 OWNER 标识 → 二次验证不会把个人订阅者改判成家庭成员
        return opts.proText ?? "Manage membership\nNext payment: 2026-01-01\n2 TB";
      }
      if (currentUrl.includes("family")) return opts.familyText ?? "";
      return "";
    },
    async getCurrentUrl() {
      return currentUrl;
    },
  };
}

function fullModeSetup(engineOpts = {}) {
  const repo = fakeAccountRepo();
  const ix = fakeIxClient();
  const engine = fakeFullEngine(engineOpts);
  const taskCalls = { updated: [], finished: [] };
  const refreshTaskRepo = {
    createRefreshTask: () => 7,
    createTaskItems: () => {},
    updateTaskItemStarted: () => {},
    updateTaskItem: (taskId, email, status, result) =>
      taskCalls.updated.push({ taskId, email, status, result }),
    finishTask: (taskId, status, successCount, failedCount) =>
      taskCalls.finished.push({ taskId, status, successCount, failedCount }),
  };
  const p = new BatchAccountProcessor(
    { concurrency: 1 },
    makeDeps({
      accountRepo: repo,
      refreshTaskRepo,
      ixClient: ix,
      createBrowserUseEngine: () => engine,
    }),
  );
  return { p, repo, ix, engine, taskCalls };
}

test("batchRefreshMembershipInfo(full): 普通 Pro 管理员的完整成功路径", async () => {
  const { p, repo, ix, engine, taskCalls } = fullModeSetup({
    familyText: "Your family group\nInvite family members\n3 members",
  });

  const result = await p.batchRefreshMembershipInfo([acct("me@x.com")], ["1"], "full");

  // Step 1/2/3 的导航依次发生在同一个引擎上
  assert.equal(engine.calls.connect, 1, "全程共用一个引擎");
  assert.ok(engine.calls.navigate[0].includes("one.google.com"), "Step 1");
  assert.ok(engine.calls.navigate[1].includes("/family/details"), "Step 2");
  assert.ok(engine.calls.navigate.at(-1).includes("/personal-info"), "Step 3");
  assert.deepEqual(engine.calls.stop, [false], "finally 里 stop(false)");

  // 结果
  assert.equal(result.success_count, 1);
  assert.equal(result.failed_count, 0);
  const data = result.results[0].data;
  assert.equal(data.is_pro, "yes");
  assert.equal(data.membership_type, "regular");
  assert.equal(data.family_role, "manager");
  assert.equal(data.has_family_group, "yes");
  assert.equal(data.family_member_count, 3);
  assert.equal(data.family_slots_left, 3, "calculateFamilySlots: 6 - max(3,1)");
  assert.equal(data.account_country, "Japan");
  assert.equal(data.success, true);

  // Step 4 写库
  assert.equal(repo.calls.membership.length, 1);
  assert.deepEqual(repo.calls.membership[0], {
    email: "me@x.com",
    is_pro: "yes",
    pro_plan_name: "",
    family_role: "manager",
    family_manager_email: "",
    has_family_group: "yes",
    family_member_count: 3,
    family_slots_left: 3,
    account_country: "Japan",
    error_message: null,
  });
  assert.deepEqual(repo.calls.pro, [], "full 模式不再单独调 updateProStatus");

  // 任务明细 + 关窗
  assert.equal(taskCalls.updated.length, 1);
  assert.equal(taskCalls.updated[0].status, "success");
  assert.equal(taskCalls.updated[0].result.is_pro, "yes");
  assert.deepEqual(taskCalls.finished[0], {
    taskId: 7,
    status: "completed",
    successCount: 1,
    failedCount: 0,
  });
  assert.deepEqual(ix.calls.close, [1]);
});

test("batchRefreshMembershipInfo(full): 检测到家庭成员角色时把 is_pro 从 yes 修正为 family_yes", async () => {
  const { p, repo } = fullModeSetup({
    familyText: "Your family group\nLeave family group\n2 members\nboss@example.com",
  });

  const result = await p.batchRefreshMembershipInfo([acct("me@x.com")], ["1"], "full");

  const data = result.results[0].data;
  assert.equal(data.is_pro, "family_yes", "状态修正");
  assert.equal(data.membership_type, "family");
  assert.equal(data.family_role, "member");
  assert.equal(data.family_member_count, 2);
  assert.equal(data.family_manager_email, "boss@example.com");
  assert.equal(data.family_slots_left, -1, "family_yes 不计算剩余位");
  assert.equal(repo.calls.membership[0].is_pro, "family_yes");
  assert.equal(repo.calls.membership[0].family_slots_left, -1);
});

test("batchRefreshMembershipInfo(full): 国家提取失败时写入 unknown，其余字段照常", async () => {
  const { p, repo } = fullModeSetup({
    familyText: "Your family group\nInvite family members\n4 members",
    country: "unknown",
  });

  const result = await p.batchRefreshMembershipInfo([acct("me@x.com")], ["1"], "full");

  assert.equal(result.success_count, 1);
  assert.equal(result.results[0].data.account_country, "unknown");
  assert.equal(repo.calls.membership[0].account_country, "unknown");
  assert.equal(repo.calls.membership[0].family_slots_left, 2, "6 - 4");
});

test("batchRefreshMembershipInfo(full): 统计摘要把成功账号计入 pro_regular_count", async () => {
  const { p } = fullModeSetup({
    familyText: "Your family group\nInvite family members\n3 members",
  });
  const result = await p.batchRefreshMembershipInfo([acct("me@x.com")], ["1"], "full");
  assert.deepEqual(result.results.at(-1), {
    _summary: true,
    pro_count: 1,
    pro_regular_count: 1,
    pro_family_count: 0,
    non_pro_count: 0,
  });
});
