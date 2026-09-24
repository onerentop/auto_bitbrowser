/**
 * 导入 TOTP：文本解析、匹配、导入任务、handler 参数校验
 * 对照 gui/import_totp_interface.py（:552-609 文本解析、:708-751 匹配、:56-196 ImportWorker）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { ERROR_CODES } from "../app/shared/envelope.ts";
import { IPC } from "../app/shared/ipc.ts";
import { TOTP_INVOKE } from "../app/shared/channels/totp.ts";
import { createHostContext } from "../app/host/context.ts";
import { createDispatcher } from "../app/host/dispatch.ts";
import { createTotpHandlers } from "../app/host/handlers/totp.ts";
import {
  entriesFromUris,
  importFinishedLogLines,
  matchTotpEntries,
  parseTotpText,
  runTotpImport,
  secretPreview,
} from "../src/application/totp-import.ts";
import { initDb } from "../src/db/schema.ts";
import { AccountRepository } from "../src/db/account-repository.ts";

// ==================== 文本解析 ====================

test("parseTotpText：解析成功条目，密钥转大写，邮箱原样保留，密码带出", () => {
  const r = parseTotpText("  A@X.com----pw1----abcd efg \n\nb@y.com----pw2----zzzz----extra\n");
  assert.deepEqual(
    r.entries.map((e) => [e.kind, e.email, e.password, e.secret, e.issuer]),
    [
      ["text", "A@X.com", "pw1", "ABCD EFG", "文本导入"],
      ["text", "b@y.com", "pw2", "ZZZZ", "文本导入"],
    ],
  );
  assert.deepEqual(r.errorLines, []);
  // Python 先对整段 strip 再分行（:557-562），末尾换行不计入
  assert.equal(r.logs[0], "开始解析文本，共 3 行...");
});

test("parseTotpText：三条校验文案与行号（行号含空行，从 1 计）", () => {
  const r = parseTotpText("a@x.com----pw\nnoat----pw----S\n----pw----S\nc@x.com----pw----   ");
  assert.deepEqual(
    r.errorLines.map((e) => [e.line, e.reason]),
    [
      [1, "格式错误：字段不足"],
      [2, "邮箱格式无效: noat"],
      [3, "邮箱格式无效: "],
      [4, "密钥为空"],
    ],
  );
  assert.equal(r.entries.length, 0);
});

test("parseTotpText：错误日志最多列 5 行，超出追加汇总；空文本返回空结果", () => {
  const r = parseTotpText(Array.from({ length: 7 }, () => "bad").join("\n"));
  const errLogs = r.logs.filter((l) => l.startsWith("  第 "));
  assert.equal(errLogs.length, 5);
  assert.ok(r.logs.includes("解析错误 7 行:"));
  assert.ok(r.logs.includes("  ... 等 7 行错误"));
  assert.deepEqual(parseTotpText("   \n  "), { entries: [], errorLines: [], logs: [] });
});

// ==================== 匹配 ====================

test("matchTotpEntries：三类状态、email 大小写不敏感、空 email 为未匹配", () => {
  const accounts = [
    { email: "Has@X.com", secret_key: "ABCDEFGHIJK" },
    { email: "new@x.com", secret_key: null },
    { email: "short@x.com", secret_key: "ABC" },
  ];
  const r = matchTotpEntries(
    [{ email: "has@x.com" }, { email: "NEW@X.COM" }, { email: "nobody@x.com" }, { email: null }, { email: "short@x.com" }],
    accounts,
  );
  assert.deepEqual(
    r.rows.map((x) => [x.status, x.matchedEmail, x.currentSecret]),
    [
      ["has_secret", "Has@X.com", "ABCDEFGH..."],
      ["can_import", "new@x.com", ""],
      ["no_match", null, null],
      ["no_match", null, null],
      ["has_secret", "short@x.com", "ABC"],
    ],
  );
  assert.deepEqual(r.counts, { can_import: 1, has_secret: 2, no_match: 2 });
  assert.equal(secretPreview(null), "");
});

test("entriesFromUris：识别不到二维码 → 未在图片中找到 QR 码；标准 URI → qr 条目", () => {
  const r = entriesFromUris([
    { uri: null, source: "a.png" },
    { uri: "otpauth://totp/G:u@x.com?secret=jbsw", source: "b.png" },
  ]);
  assert.deepEqual(r.errors, ["未在图片中找到 QR 码"]);
  assert.deepEqual(
    r.entries.map((e) => [e.kind, e.email, e.secret, e.source]),
    [["qr", "u@x.com", "JBSW", "b.png"]],
  );
  assert.deepEqual(r.items.map((i) => i.count), [0, 1]);
});

// ==================== 导入任务 ====================

function repoWith(rows) {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  const repo = new AccountRepository(db);
  for (const r of rows) repo.upsertAccount(r);
  return repo;
}

function importDeps(repo, { windows = [], noteOk = true, stopAfter = Infinity, listThrows = false } = {}) {
  const notes = [];
  const logs = [];
  const items = [];
  const progress = [];
  let checks = 0;
  return {
    notes,
    logs,
    items,
    progress,
    deps: {
      getAllAccounts: () => repo.getAllAccounts(),
      upsertAccount: (f) => repo.upsertAccount(f),
      listWindows: async () => {
        if (listThrows) throw new Error("ix 不可达");
        return windows;
      },
      updateProfile: async (id, fields) => {
        notes.push([id, fields.tfa_secret ?? null, "note" in fields ? fields.note : null]);
        if (noteOk === "throw") throw new Error("网络错误");
        return noteOk;
      },
      log: (m) => logs.push(m),
      progress: (c, t) => progress.push([c, t]),
      item: (k, s, m) => items.push([k, s, m]),
      shouldStop: () => checks++ >= stopAfter,
    },
  };
}

test("runTotpImport：写入密钥；文本导入带密码时更新密码；二维码导入不改密码", async () => {
  const repo = repoWith([
    { email: "t@x.com", password: "old", recovery_email: "r@x.com", browser_profile_id: "11" },
    { email: "q@x.com", password: "keep", browser_profile_id: "12" },
  ]);
  const h = importDeps(repo);
  const r = await runTotpImport(
    [
      { email: "t@x.com", secret: "SECRET1", kind: "text", password: "newpw" },
      { email: "q@x.com", secret: "SECRET2", kind: "qr", password: "ignored" },
    ],
    h.deps,
  );
  assert.equal(repo.getAccountByEmail("t@x.com").secret_key, "SECRET1");
  assert.equal(repo.getAccountByEmail("t@x.com").password, "newpw");
  assert.equal(repo.getAccountByEmail("q@x.com").password, "keep");
  assert.equal(r.password_count, 1);
  // 只写窗口的 tfa_secret；**备注（note）不再写** —— 那是用户自己的笔记区，
  // 原实现整条重建备注（email----password----recovery_email----secret）会清掉用户手写的内容。
  // 第三个元素是 note（null = 没传），用来钉住「不再碰备注」。
  assert.deepEqual(h.notes, [
    [11, "SECRET1", null],
    [12, "SECRET2", null],
  ]);
  assert.deepEqual(r, {
    success_count: 2,
    total_count: 2,
    password_count: 1,
    bind_count: 0,
    ix_update_count: 2,
    failed_list: [],
    warning_list: [],
    skipped_count: 0,
  });
  assert.deepEqual(h.progress, [
    [1, 2],
    [2, 2],
  ]);
  assert.deepEqual(h.items, [
    ["t@x.com", "成功", ""],
    ["q@x.com", "成功", ""],
  ]);
});

test("runTotpImport：未绑定账号按窗口名（小写）自动绑定；已绑定的不改", async () => {
  const repo = repoWith([
    { email: "Free@X.com", password: "p" },
    { email: "bound@x.com", password: "p", browser_profile_id: "99" },
  ]);
  const h = importDeps(repo, {
    windows: [
      { name: "free@x.com", profile_id: 21 },
      { name: "bound@x.com", profile_id: 22 },
      { name: "", profile_id: 23 },
    ],
  });
  const r = await runTotpImport(
    [
      { email: "free@x.com", secret: "S1", kind: "qr" },
      { email: "bound@x.com", secret: "S2", kind: "qr" },
    ],
    h.deps,
  );
  assert.equal(repo.getAccountByEmail("Free@X.com").browser_profile_id, "21");
  assert.equal(repo.getAccountByEmail("bound@x.com").browser_profile_id, "99");
  assert.equal(r.bind_count, 1);
  assert.deepEqual(
    h.notes.map(([id]) => id),
    [21, 99],
  );
  assert.ok(h.logs.includes("  获取到 2 个窗口"));
});

test("runTotpImport：写入 2FA 密钥失败 / 抛错记为警告，密钥仍计成功；无窗口时不更新", async () => {
  const repo = repoWith([
    { email: "a@x.com", browser_profile_id: "1" },
    { email: "c@x.com" },
  ]);
  const h = importDeps(repo, { noteOk: false });
  const r = await runTotpImport(
    [
      { email: "a@x.com", secret: "S", kind: "qr" },
      { email: "c@x.com", secret: "S", kind: "qr" },
    ],
    h.deps,
  );
  assert.equal(r.success_count, 2);
  assert.equal(r.ix_update_count, 0);
  assert.deepEqual(r.warning_list, [{ email: "a@x.com", warning: "更新窗口 2FA 密钥返回失败" }]);
  assert.equal(h.notes.length, 1);

  const h2 = importDeps(repoWith([{ email: "a@x.com", browser_profile_id: "1" }]), { noteOk: "throw" });
  const r2 = await runTotpImport([{ email: "a@x.com", secret: "S", kind: "qr" }], h2.deps);
  assert.deepEqual(r2.warning_list, [{ email: "a@x.com", warning: "更新窗口 2FA 密钥失败: 网络错误" }]);
});

test("runTotpImport：以数据库为准 —— 库中无该账号记为失败，不新建账号", async () => {
  const repo = repoWith([]);
  const h = importDeps(repo);
  const r = await runTotpImport([{ email: "ghost@x.com", secret: "S", kind: "text", password: "p" }], h.deps);
  assert.deepEqual(r.failed_list, [{ email: "ghost@x.com", error: "数据库中未找到该账号" }]);
  assert.equal(r.success_count, 0);
  assert.equal(r.password_count, 0);
  assert.equal(repo.getAccountByEmail("ghost@x.com"), null);
  assert.deepEqual(h.items, [["ghost@x.com", "失败", "数据库中未找到该账号"]]);
});

test("runTotpImport：窗口列表获取失败只记日志，仍继续写密钥", async () => {
  const repo = repoWith([{ email: "a@x.com" }]);
  const h = importDeps(repo, { listThrows: true });
  const r = await runTotpImport([{ email: "a@x.com", secret: "S", kind: "qr" }], h.deps);
  assert.ok(h.logs.includes("  ⚠ 获取窗口列表失败: ix 不可达"));
  assert.equal(r.success_count, 1);
});

test("runTotpImport：中途停止，剩余条目计入 skipped_count", async () => {
  const repo = repoWith([{ email: "a@x.com" }, { email: "b@x.com" }, { email: "c@x.com" }]);
  const h = importDeps(repo, { stopAfter: 1 });
  const r = await runTotpImport(
    ["a", "b", "c"].map((n) => ({ email: `${n}@x.com`, secret: "S", kind: "qr" })),
    h.deps,
  );
  assert.equal(r.success_count, 1);
  assert.equal(r.skipped_count, 2);
  assert.ok(h.logs.includes("已停止，剩余 2 个账号未处理"));
  assert.equal(repo.getAccountByEmail("b@x.com").secret_key, null);
  assert.ok(importFinishedLogLines(r).length > 0);
});

test("importFinishedLogLines：窗口写入计数如实写成 2FA 密钥，不再声称更新了窗口备注", () => {
  // 导入只写窗口 tfa_secret、不碰备注；汇总若仍写「已更新 N 个窗口备注」，
  // 用户会误以为自己手写的备注被改过。
  const lines = importFinishedLogLines({
    success_count: 1,
    total_count: 1,
    password_count: 0,
    bind_count: 0,
    ix_update_count: 1,
    failed_list: [],
    warning_list: [],
    skipped_count: 0,
  });
  assert.ok(lines.includes("已写入 1 个窗口的 2FA 密钥"), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("备注")), lines.join("\n"));
});

// ==================== handler ====================

function makeHandlers(rows = [], opts = {}) {
  const events = [];
  const waiters = [];
  const ctx = createHostContext({
    dataRoot: "X:/abb-totp-test",
    emit: (channel, payload) => {
      events.push([channel, payload]);
      if (channel === IPC.event.taskFinished) waiters.shift()?.(payload);
    },
    log: () => {},
    openDatabase: () => new DatabaseSync(":memory:"),
  });
  for (const r of rows) ctx.accountRepo().upsertAccount(r);
  const notes = [];
  const dispatch = createDispatcher(
    createTotpHandlers(ctx, {
      listWindows: async () => opts.windows ?? [],
      updateProfile: async (id, fields) => {
        notes.push([id, fields.tfa_secret ?? null, "note" in fields ? fields.note : null]);
        return true;
      },
    }),
  );
  const call = async (channel, ...args) => {
    const env = await dispatch(channel, args);
    if (!env.ok) {
      const e = new Error(env.error.message);
      e.code = env.error.code;
      throw e;
    }
    return env.data;
  };
  const nextFinished = () => new Promise((r) => waiters.push(r));
  return { ctx, call, notes, events, nextFinished };
}

test("handler：parseText / parseUris / match 走通并以数据库匹配", async () => {
  const h = makeHandlers([{ email: "a@x.com" }]);
  const parsed = await h.call(TOTP_INVOKE.totpParseText, "a@x.com----p----s");
  assert.equal(parsed.entries[0].secret, "S");
  const uris = await h.call(TOTP_INVOKE.totpParseUris, [{ uri: null, source: "x.png" }]);
  assert.deepEqual(uris.errors, ["未在图片中找到 QR 码"]);
  const m = await h.call(TOTP_INVOKE.totpMatch, [{ email: "A@X.COM" }]);
  assert.equal(m.rows[0].status, "can_import");
});

test("handler：import 返回 TaskInfo，任务完成后写库并写入窗口 2FA 密钥", async () => {
  const h = makeHandlers([{ email: "a@x.com", password: "p" }], { windows: [{ name: "a@x.com", profile_id: 5 }] });
  const finished = h.nextFinished();
  const info = await h.call(TOTP_INVOKE.totpImport, [{ email: "a@x.com", secret: "NEW", kind: "text", password: "p2" }]);
  assert.equal(info.type, "import_totp");
  const done = await finished;
  assert.equal(done.outcome, "succeeded");
  assert.equal(done.result.success_count, 1);
  assert.equal(done.result.bind_count, 1);
  const acc = h.ctx.accountRepo().getAccountByEmail("a@x.com");
  assert.deepEqual([acc.secret_key, acc.password, acc.browser_profile_id], ["NEW", "p2", "5"]);
  assert.deepEqual(h.notes, [[5, "NEW", null]], "只写 tfa_secret，不传 note");
});

test("handler：二维码条目带密码时丢弃密码", async () => {
  const h = makeHandlers([{ email: "a@x.com", password: "keep" }]);
  const finished = h.nextFinished();
  await h.call(TOTP_INVOKE.totpImport, [{ email: "a@x.com", secret: "Q", kind: "qr", password: "x" }]);
  await finished;
  assert.equal(h.ctx.accountRepo().getAccountByEmail("a@x.com").password, "keep");
});

test("handler 参数校验：各类非法输入 → INVALID_ARGUMENT", async () => {
  const h = makeHandlers();
  const bad = [
    [TOTP_INVOKE.totpParseText, [123]],
    [TOTP_INVOKE.totpParseUris, ["nope"]],
    [TOTP_INVOKE.totpParseUris, [[{ uri: 1, source: "a" }]]],
    [TOTP_INVOKE.totpParseUris, [[{ uri: null }]]],
    [TOTP_INVOKE.totpMatch, [[{ email: 5 }]]],
    [TOTP_INVOKE.totpMatch, [[null]]],
    [TOTP_INVOKE.totpImport, [[]]],
    [TOTP_INVOKE.totpImport, [[{ email: "", secret: "S", kind: "qr" }]]],
    [TOTP_INVOKE.totpImport, [[{ email: "a@x.com", secret: " ", kind: "qr" }]]],
    [TOTP_INVOKE.totpImport, [[{ email: "a@x.com", secret: "S", kind: "zip" }]]],
    [TOTP_INVOKE.totpImport, [[{ email: "a@x.com", secret: "S", kind: "text", password: 1 }]]],
  ];
  for (const [channel, args] of bad) {
    await assert.rejects(h.call(channel, ...args), (e) => e.code === ERROR_CODES.INVALID_ARGUMENT, `${channel} ${JSON.stringify(args)}`);
  }
});
