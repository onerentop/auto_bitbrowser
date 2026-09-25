/**
 * 修改验证器之后「新密钥一个都不能丢」（src/automation/auto-modify-authenticator.ts 的 settleModifyAuthResult）
 *
 * 真机背景（2026-09-25）：Google 换验证器后旧密钥立刻失效；新密钥没记下来就等于这个账号的两步验证丢了。
 * 原实现：
 *   - 结果判失败时直接丢掉新密钥（返回 null，也不写文件）；
 *   - 文件写入依赖数据库写入成功——数据库一失败，密钥哪儿都没留下，任务还报「成功」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settleModifyAuthResult } from "../src/automation/auto-modify-authenticator.ts";

const EMAIL = "a@x.com";
const PASSWORD = "pw-1";
/** 合成测试向量（RFC 6238 样例），不是任何真实账号的密钥 */
const NEW_KEY = "JBSWY3DPEHPK3PXP";
const KEY_FILE = "已修改密钥.txt";

/**
 * @param {{ dbOk?: boolean }} [o]
 */
function setup({ dbOk = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "abb-auth-"));
  /** @type {any[]} */
  const upserts = [];
  /** @type {any[]} */
  const history = [];
  const save = {
    email: EMAIL,
    password: PASSWORD,
    browserId: null,
    projectRoot: dir,
    accountRepo: /** @type {any} */ ({
      upsertAccount: (/** @type {any} */ f) => {
        upserts.push(f);
        return dbOk;
      },
    }),
    historyRepo: /** @type {any} */ ({
      addAuthenticatorModification: (/** @type {string} */ e, /** @type {string} */ k) => history.push([e, k]),
    }),
  };
  const fileText = () => (existsSync(join(dir, KEY_FILE)) ? readFileSync(join(dir, KEY_FILE), "utf8") : "");
  return { dir, save, upserts, history, fileText, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("成功：新密钥写库（secret_key）+ 记修改历史 + 写文件，返回成功", async () => {
  const s = setup();
  try {
    const r = await settleModifyAuthResult({ success: true, secret_key: NEW_KEY }, s.save);
    assert.equal(r[0], true);
    assert.deepEqual(s.upserts.map((u) => u.secret_key), [NEW_KEY]);
    assert.deepEqual(s.history, [[EMAIL, NEW_KEY]]);
    assert.ok(s.fileText().includes(`${EMAIL}----${PASSWORD}----${NEW_KEY}`));
  } finally {
    s.cleanup();
  }
});

test("成功但写库失败：密钥照样写进文件（不能丢），任务判失败并说明要手动更新", async () => {
  const s = setup({ dbOk: false });
  try {
    const r = await settleModifyAuthResult({ success: true, secret_key: NEW_KEY }, s.save);
    assert.equal(r[0], false, "库没写上就不能报成功");
    assert.match(r[1], /写入数据库失败/);
    assert.match(r[1], /已修改密钥\.txt/);
    assert.ok(s.fileText().includes(NEW_KEY), "文件里必须有新密钥");
  } finally {
    s.cleanup();
  }
});

test("结果无法确认但已拿到新密钥：写进文件并标注「未确认」，不改库里的密钥，任务判失败并提示人工核对", async () => {
  const s = setup();
  try {
    const r = await settleModifyAuthResult({ success: false, message: "验证失败", secret_key: NEW_KEY }, s.save);
    assert.equal(r[0], false);
    assert.match(r[1], /未确认|无法确认/);
    assert.match(r[1], /已修改密钥\.txt/);
    assert.deepEqual(s.upserts, [], "没确认换成功之前不能覆盖库里的密钥（旧密钥可能仍然有效）");
    assert.ok(/未确认/.test(s.fileText()) && s.fileText().includes(NEW_KEY), "文件里要有这条新密钥，并标注未确认");
  } finally {
    s.cleanup();
  }
});

test("失败且没拿到新密钥：什么都不写，原样报失败原因", async () => {
  const s = setup();
  try {
    const r = await settleModifyAuthResult({ success: false, message: "无法提取密钥", secret_key: null }, s.save);
    assert.deepEqual([r[0], r[1]], [false, "无法提取密钥"]);
    assert.deepEqual(s.upserts, []);
    assert.equal(s.fileText(), "");
  } finally {
    s.cleanup();
  }
});

test("窗口 tfa_secret 同步：等写完再返回；失败时任务判失败并说明（首页验证码就是从窗口密钥算的）", async () => {
  const s = setup();
  /** @type {any[]} */
  const updates = [];
  const ixOk = /** @type {any} */ ({ updateProfile: async (/** @type {number} */ id, /** @type {any} */ f) => (updates.push([id, f]), true) });
  const ixFail = /** @type {any} */ ({ updateProfile: async () => false });
  try {
    const ok = await settleModifyAuthResult({ success: true, secret_key: NEW_KEY }, { ...s.save, browserId: "12", ixClient: ixOk });
    assert.equal(ok[0], true);
    assert.deepEqual(updates, [[12, { tfa_secret: NEW_KEY }]], "返回之前窗口已同步（只写 tfa_secret，不碰备注）");

    const bad = await settleModifyAuthResult({ success: true, secret_key: NEW_KEY }, { ...s.save, browserId: "12", ixClient: ixFail });
    assert.equal(bad[0], false);
    assert.match(bad[1], /窗口.*同步失败/);
  } finally {
    s.cleanup();
  }
});
