/** 账号写入方法单测（内存 SQLite）—— 重点验证「只更新非 null 字段」的语义 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AccountRepository } from "../src/db/account-repository.ts";

/** 建一张与生产库结构一致的最小 accounts 表 */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE accounts (
    email TEXT PRIMARY KEY,
    password TEXT,
    recovery_email TEXT,
    secret_key TEXT,
    verification_link TEXT,
    status TEXT,
    message TEXT,
    updated_at TIMESTAMP,
    sheerid_steps INTEGER,
    last_failed_step TEXT,
    last_error TEXT,
    sub2api_account_id INTEGER,
    sub2api_status TEXT,
    sub2api_session_id TEXT,
    login_status TEXT,
    last_login_at TIMESTAMP,
    browser_profile_id TEXT,
    unlock_status TEXT,
    validation_url TEXT,
    is_pro TEXT,
    family_member_count INTEGER,
    family_sharing_enabled TEXT,
    pro_plan_name TEXT,
    family_role TEXT,
    family_manager_email TEXT,
    has_family_group TEXT,
    account_country TEXT,
    family_slots_left INTEGER,
    family_info_refreshed_at TIMESTAMP,
    family_info_refresh_error TEXT
  )`);
  return db;
}

test("upsert: 新账号插入，status 默认 pending、sheerid_steps 默认 0", () => {
  const repo = new AccountRepository(freshDb());
  assert.equal(repo.upsertAccount({ email: "a@b.com", password: "pw" }), true);

  const row = repo.getAccountByEmail("a@b.com");
  assert.equal(row?.password, "pw");
  assert.equal(row?.status, "pending");
  assert.equal(row?.sheerid_steps, 0);
});

test("upsert: email 为空直接返回 false", () => {
  const repo = new AccountRepository(freshDb());
  assert.equal(repo.upsertAccount({ email: "" }), false);
});

test("upsert: 已存在时只改传入字段，其余保持原值", () => {
  const db = freshDb();
  const repo = new AccountRepository(db);
  repo.upsertAccount({ email: "a@b.com", password: "pw1", recovery_email: "r@b.com", status: "verified" });

  // 只改 secret_key——password / recovery_email / status 必须原样保留
  repo.upsertAccount({ email: "a@b.com", secret_key: "NEWSECRET" });

  const row = repo.getAccountByEmail("a@b.com");
  assert.equal(row?.secret_key, "NEWSECRET");
  assert.equal(row?.password, "pw1", "未传的 password 不应被覆盖");
  assert.equal(row?.recovery_email, "r@b.com", "未传的 recovery_email 不应被覆盖");
  assert.equal(row?.status, "verified", "未传的 status 不应被覆盖");
});

test("upsert: 显式传 null 也不更新（与 undefined 同义）", () => {
  const repo = new AccountRepository(freshDb());
  repo.upsertAccount({ email: "a@b.com", password: "keep-me" });
  repo.upsertAccount({ email: "a@b.com", password: null });
  assert.equal(repo.getAccountByEmail("a@b.com")?.password, "keep-me");
});

test("upsert: last_error 传空串落成 NULL", () => {
  const repo = new AccountRepository(freshDb());
  repo.upsertAccount({ email: "a@b.com", status: "error" });
  repo.upsertAccount({ email: "a@b.com", last_error: "boom" });
  assert.equal(repo.getAccountByEmail("a@b.com")?.last_error, "boom");

  repo.upsertAccount({ email: "a@b.com", last_error: "" });
  assert.equal(repo.getAccountByEmail("a@b.com")?.last_error, null, "空串应落成 NULL");
});

test("upsert: link 写入 verification_link 列（字段名映射）", () => {
  const repo = new AccountRepository(freshDb());
  repo.upsertAccount({ email: "a@b.com", link: "https://x.io/v/1" });
  assert.equal(repo.getAccountByEmail("a@b.com")?.verification_link, "https://x.io/v/1");
});

test("upsert: 只改一个字段也要刷新 updated_at", () => {
  const db = freshDb();
  const repo = new AccountRepository(db);
  repo.upsertAccount({ email: "a@b.com", password: "pw" });
  db.prepare("UPDATE accounts SET updated_at = '2000-01-01 00:00:00' WHERE email = ?").run("a@b.com");

  repo.upsertAccount({ email: "a@b.com", secret_key: "S" });
  const row = repo.getAccountByEmail("a@b.com");
  assert.notEqual(row?.updated_at, "2000-01-01 00:00:00", "updated_at 应被刷新");
});