/**
 * 「修改密码」（F1）单测
 *
 * 覆盖：强随机密码生成（长度/字符集/类别齐全/不可预测/参数校验）、
 * 改密成功后三处写回（数据库 / 窗口备注第 2 段 / 窗口 password 字段）、
 * Google 侧失败时**一个本地字段都不写**、写库失败时的行为、日志不泄露密码。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { generateStrongPassword, PASSWORD_LENGTH, PASSWORD_MIN_LENGTH } from "../src/core/random-password.ts";
import { AccountRepository } from "../src/db/account-repository.ts";
import {
  describeSaveOutcome,
  maskPassword,
  replacePasswordInNote,
  saveNewPassword,
} from "../src/automation/auto-change-password.ts";
import { initDb } from "../src/db/schema.ts";

// ==================== 密码生成 ====================

const CLASSES = [
  ["大写", /[A-Z]/],
  ["小写", /[a-z]/],
  ["数字", /[0-9]/],
  ["符号", /[^A-Za-z0-9]/],
];

test("generateStrongPassword：默认长度 ≥ 16，且四类字符齐全", () => {
  const pw = generateStrongPassword();
  assert.ok(pw.length >= PASSWORD_MIN_LENGTH, `长度应 ≥ 16，实际 ${pw.length}`);
  assert.equal(pw.length, PASSWORD_LENGTH);
  for (const [label, re] of CLASSES) assert.match(pw, re, `应包含${label}字符`);
});

test("generateStrongPassword：指定长度时也满足类别齐全", () => {
  for (const n of [PASSWORD_MIN_LENGTH, 24, 40]) {
    const pw = generateStrongPassword(n);
    assert.equal(pw.length, n);
    for (const [label, re] of CLASSES) assert.match(pw, re, `长度 ${n} 应包含${label}字符`);
  }
});

test("generateStrongPassword：不使用易混淆字符（I O l 0 1）与空格/引号/反斜杠", () => {
  const banned = /[IOl01 '"\\]/;
  for (let i = 0; i < 200; i++) {
    const pw = generateStrongPassword();
    assert.doesNotMatch(pw, banned, `不该出现易混淆字符: ${pw}`);
  }
});

test("generateStrongPassword：每次都不一样（不是固定值/低熵）", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generateStrongPassword());
  assert.equal(seen.size, 500);
});

test("generateStrongPassword：先四类各一个再洗牌（注入可控随机源可复现）", () => {
  // random 恒返回 0：四类各取第一个字符，洗牌也不动（j=0 与 i 交换）
  const pw = generateStrongPassword(16, () => 0);
  assert.equal(pw.length, 16);
  for (const [label, re] of CLASSES) assert.match(pw, re, `应包含${label}字符`);
  // 注入同一个序列两次 → 结果一致（说明没有隐藏的随机源）
  assert.equal(pw, generateStrongPassword(16, () => 0));
});

test("generateStrongPassword：长度小于 16 时抛错（不能悄悄生成弱密码）", () => {
  assert.throws(() => generateStrongPassword(15), /至少 16 位/);
  assert.throws(() => generateStrongPassword(0), /至少 16 位/);
  assert.throws(() => generateStrongPassword(16.5), /至少 16 位/);
});

// ==================== 备注第 2 段替换 ====================

test("replacePasswordInNote：备注是 邮箱----密码----辅助邮箱----密钥 时只换第 2 段", () => {
  assert.equal(
    replacePasswordInNote("a@x.com----old----b@y.com----SECRET", "a@x.com", "NEW"),
    "a@x.com----NEW----b@y.com----SECRET",
  );
  // 段数与其它段一律不动
  assert.equal(replacePasswordInNote("a@x.com----old", "a@x.com", "NEW"), "a@x.com----NEW");
  assert.equal(
    replacePasswordInNote("a@x.com----old----b@y.com----S----extra", "a@x.com", "NEW"),
    "a@x.com----NEW----b@y.com----S----extra",
  );
});

test("replacePasswordInNote：备注段数不足时补成 邮箱----新密码----(原有内容)，不丢东西", () => {
  assert.equal(replacePasswordInNote("", "a@x.com", "NEW"), "a@x.com----NEW");
  assert.equal(replacePasswordInNote(null, "a@x.com", "NEW"), "a@x.com----NEW");
  assert.equal(replacePasswordInNote("随手写的备注", "a@x.com", "NEW"), "a@x.com----NEW----随手写的备注");
});

// ==================== 三处写回 ====================

function repoWith(email, password) {
  const db = new DatabaseSync(":memory:");
  initDb(db);
  db.prepare("INSERT INTO accounts (email, password, secret_key, recovery_email) VALUES (?,?,?,?)").run(
    email,
    password,
    "SECRETKEEP",
    "keep@y.com",
  );
  return { db, repo: new AccountRepository(db) };
}

test("saveNewPassword：三处都写成功（数据库 / 备注第 2 段 / 窗口 password）", async () => {
  const email = "a@x.com";
  const { repo } = repoWith(email, "old");
  const updated = [];
  const result = await saveNewPassword({
    email,
    newPassword: "NEWPASS",
    browserId: "7",
    accountRepo: repo,
    ixClient: {
      getProfileInfo: async () => ({ profile_id: 7, note: `${email}----old----b@y.com----SECRET` }),
      updateProfile: async (id, fields) => {
        updated.push([id, fields]);
        return true;
      },
    },
  });

  assert.deepEqual(result, { db: true, note: true, windowPassword: true });
  assert.deepEqual(updated, [[7, { note: `${email}----NEWPASS----b@y.com----SECRET`, password: "NEWPASS" }]]);
  // 数据库只换了密码，其它列没被动
  const row = repo.getAccountByEmail(email);
  assert.equal(row.password, "NEWPASS");
  assert.equal(row.secret_key, "SECRETKEEP");
  assert.equal(row.recovery_email, "keep@y.com");
});

test("saveNewPassword：某一处失败只影响那一处，其余照写（并如实返回）", async () => {
  const email = "a@x.com";
  const { repo } = repoWith(email, "old");
  const result = await saveNewPassword({
    email,
    newPassword: "NEWPASS",
    browserId: "7",
    accountRepo: repo,
    ixClient: {
      getProfileInfo: async () => ({ profile_id: 7, note: `${email}----old` }),
      updateProfile: async () => false, // 窗口侧失败
    },
  });
  assert.deepEqual(result, { db: true, note: false, windowPassword: false });
  assert.equal(repo.getAccountByEmail(email).password, "NEWPASS", "数据库仍应写成功");
});

test("saveNewPassword：ixBrowser 抛错不把异常抛给调用方", async () => {
  const email = "a@x.com";
  const { repo } = repoWith(email, "old");
  const result = await saveNewPassword({
    email,
    newPassword: "NEWPASS",
    browserId: "7",
    accountRepo: repo,
    ixClient: {
      getProfileInfo: async () => {
        throw new Error("ix 挂了");
      },
      updateProfile: async () => true,
    },
  });
  assert.deepEqual(result, { db: true, note: false, windowPassword: false });
});

test("saveNewPassword：没有窗口 ID / 没有 ixClient 时只写数据库", async () => {
  const email = "a@x.com";
  const { repo } = repoWith(email, "old");
  assert.deepEqual(await saveNewPassword({ email, newPassword: "N1", accountRepo: repo }), {
    db: true,
    note: false,
    windowPassword: false,
  });
  assert.deepEqual(await saveNewPassword({ email, newPassword: "N2", browserId: "abc", accountRepo: repo }), {
    db: true,
    note: false,
    windowPassword: false,
  });
});

// ==================== 掩码 ====================

test("maskPassword：只露长度与前 4 位，不出现完整密码", () => {
  const pw = "Ab3!zzzzzzzzzzzzzzzz";
  const masked = maskPassword(pw);
  assert.equal(masked, "len=20 前4=Ab3!…");
  assert.ok(!masked.includes(pw));
});

// ==================== 写回结果上报 ====================

test("describeSaveOutcome：三处都写成 → 报成功，消息说明已落库与窗口", () => {
  const outcome = describeSaveOutcome({ db: true, note: true, windowPassword: true });
  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /密码已更改/);
  assert.match(outcome.message, /已写入数据库与窗口信息/);
});

test("describeSaveOutcome：只写了数据库 → 仍算成功，但要指引去窗口侧手动同步", () => {
  const outcome = describeSaveOutcome({ db: true, note: false, windowPassword: false });
  assert.equal(outcome.ok, true, "Google 侧已改成功，不能报失败");
  assert.match(outcome.message, /窗口/, "要指出哪一处没写");
  assert.match(outcome.message, /手动同步/, "要告诉操作者怎么补救");
  assert.doesNotMatch(outcome.message, /本地密码已失效/, "数据库里已是新密码，凭据没丢");
});

test("describeSaveOutcome：只写了窗口 → 仍算成功，并指明新密码在窗口备注第 2 段", () => {
  const outcome = describeSaveOutcome({ db: false, note: true, windowPassword: true });
  assert.equal(outcome.ok, true, "Google 侧已改成功，不能报失败");
  assert.match(outcome.message, /窗口备注第 2 段/, "要说清新密码现在能从哪取回");
  assert.match(outcome.message, /手动同步数据库/, "要提示数据库需要人工补齐");
});

test("describeSaveOutcome：三处全没写成 → 必须报失败（新密码只存在于内存，等于丢了）", () => {
  const outcome = describeSaveOutcome({ db: false, note: false, windowPassword: false });
  assert.equal(outcome.ok, false, "一处都没写成时必须报失败，不能让操作者看到绿点");
  assert.match(outcome.message, /本地密码已失效/, "要说清账号本地凭据已失效");
  assert.match(outcome.message, /Google 侧/, "要说清远端其实已经改了，避免误以为没改");
  assert.match(outcome.message, /重设密码/, "要给出下一步动作");
});
