/**
 * AccountRepository.updateMembershipInfo 单测（内存 SQLite，全离线）
 *
 * 用 node:sqlite 的 `:memory:` 库，**绝不触碰仓库根的 accounts.db**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { AccountRepository } from "../src/db/account-repository.ts";

/** 与生产库结构一致的最小 accounts 表（含全部会员信息字段） */
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE accounts (
    email TEXT PRIMARY KEY,
    password TEXT,
    recovery_email TEXT,
    secret_key TEXT,
    status TEXT,
    login_status TEXT,
    sub2api_status TEXT,
    unlock_status TEXT,
    validation_url TEXT,
    browser_profile_id TEXT,
    updated_at TIMESTAMP,
    is_pro TEXT,
    pro_plan_name TEXT,
    family_role TEXT,
    family_manager_email TEXT,
    has_family_group TEXT,
    family_member_count INTEGER,
    family_slots_left INTEGER,
    account_country TEXT,
    family_info_refreshed_at TIMESTAMP,
    family_info_refresh_error TEXT
  )`);
  return db;
}

function seed(db, email = "a@x.com") {
  db.prepare("INSERT INTO accounts (email, is_pro) VALUES (?, ?)").run(email, "unknown");
}

function row(db, email = "a@x.com") {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").get(email);
}

const fullFields = (overrides = {}) => ({
  email: "a@x.com",
  is_pro: "yes",
  pro_plan_name: "Google One AI Premium",
  family_role: "manager",
  family_manager_email: "boss@example.com",
  has_family_group: "yes",
  family_member_count: 3,
  family_slots_left: 3,
  account_country: "Japan",
  error_message: null,
  ...overrides,
});

test("updateMembershipInfo: 9 个字段全部写入并返回 true", () => {
  const db = freshDb();
  seed(db);
  const repo = new AccountRepository(db);

  assert.equal(repo.updateMembershipInfo(fullFields()), true);

  const r = row(db);
  assert.equal(r.is_pro, "yes");
  assert.equal(r.pro_plan_name, "Google One AI Premium");
  assert.equal(r.family_role, "manager");
  assert.equal(r.family_manager_email, "boss@example.com");
  assert.equal(r.has_family_group, "yes");
  assert.equal(r.family_member_count, 3);
  assert.equal(r.family_slots_left, 3);
  assert.equal(r.account_country, "Japan");
  assert.equal(r.family_info_refresh_error, null);
});

test("updateMembershipInfo: 同时刷新 family_info_refreshed_at 与 updated_at", () => {
  const db = freshDb();
  seed(db);
  assert.equal(row(db).family_info_refreshed_at, null);
  assert.equal(row(db).updated_at, null);

  new AccountRepository(db).updateMembershipInfo(fullFields());

  const r = row(db);
  assert.match(String(r.family_info_refreshed_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(String(r.updated_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("updateMembershipInfo: error_message 落到 family_info_refresh_error 列", () => {
  const db = freshDb();
  seed(db);
  new AccountRepository(db).updateMembershipInfo(
    fullFields({ is_pro: "detection_failed", error_message: "检测超时" }),
  );
  assert.equal(row(db).family_info_refresh_error, "检测超时");
  assert.equal(row(db).is_pro, "detection_failed");
});

test("updateMembershipInfo: family_yes / member / -1 槽位也能原样写入", () => {
  const db = freshDb();
  seed(db);
  new AccountRepository(db).updateMembershipInfo(
    fullFields({
      is_pro: "family_yes",
      family_role: "member",
      family_slots_left: -1,
      pro_plan_name: "",
      account_country: "unknown",
    }),
  );

  const r = row(db);
  assert.equal(r.is_pro, "family_yes");
  assert.equal(r.family_role, "member");
  assert.equal(r.family_slots_left, -1);
  assert.equal(r.pro_plan_name, "");
  assert.equal(r.account_country, "unknown");
});

test("updateMembershipInfo: email 不存在时 affected=0 → 返回 false 且不插入新行", () => {
  const db = freshDb();
  seed(db, "a@x.com");
  const repo = new AccountRepository(db);

  assert.equal(repo.updateMembershipInfo(fullFields({ email: "ghost@x.com" })), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n, 1);
  assert.equal(row(db).is_pro, "unknown", "已有行不受影响");
});

test("updateMembershipInfo: 只影响目标 email，其它账号不动", () => {
  const db = freshDb();
  seed(db, "a@x.com");
  seed(db, "b@x.com");

  new AccountRepository(db).updateMembershipInfo(fullFields({ email: "a@x.com" }));

  assert.equal(row(db, "a@x.com").is_pro, "yes");
  assert.equal(row(db, "b@x.com").is_pro, "unknown");
  assert.equal(row(db, "b@x.com").family_info_refreshed_at, null);
});

test("updateMembershipInfo: 可重复调用，后一次覆盖前一次", () => {
  const db = freshDb();
  seed(db);
  const repo = new AccountRepository(db);

  repo.updateMembershipInfo(fullFields());
  repo.updateMembershipInfo(
    fullFields({ is_pro: "no", family_role: "none", has_family_group: "no", family_member_count: 0 }),
  );

  const r = row(db);
  assert.equal(r.is_pro, "no");
  assert.equal(r.family_role, "none");
  assert.equal(r.has_family_group, "no");
  assert.equal(r.family_member_count, 0);
});

test("updateMembershipInfo: SQL 异常被吞掉并返回 false", () => {
  const db = new DatabaseSync(":memory:"); // 没有 accounts 表
  assert.equal(new AccountRepository(db).updateMembershipInfo(fullFields()), false);
});
