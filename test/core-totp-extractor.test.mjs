/**
 * src/core/totp-extractor —— 与 Python core/totp_extractor 对拍
 *
 * test/fixtures/totp-parity-vectors.json 由 Python 生成：
 *   按 protobuf 线格式手工编码 migration payload（单/多账号、有无 issuer、SHA256/512、8 位、HOTP+counter、
 *   issuer:email 与 "email (Issuer)" 两种名称、中文名称、未知字段号 9/10（64bit/32bit wire type）、
 *   base64 去填充与保留填充、URL 编码），再用 parse_otpauth_migration_uri / parse_standard_otpauth_uri 解析。
 * 字段名与 Python dataclass 一致（snake_case）；email 列为 OTPAccount.get_email()。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_QR_FOUND,
  extractTotpSecretsFromContents,
  getOtpEmail,
  parseOtpauthMigrationUri,
  parseStandardOtpauthUri,
} from "../src/core/totp-extractor/index.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/totp-parity-vectors.json", import.meta.url), "utf8"));

const withEmail = (a) => ({ ...a, email: getOtpEmail(a) });

test("对拍：otpauth-migration 解析结果与 Python 逐字段一致", () => {
  assert.ok(fixture.migration.length >= 4);
  for (const c of fixture.migration) {
    assert.deepEqual(parseOtpauthMigrationUri(c.uri).map(withEmail), c.accounts, c.uri);
  }
});

test("对拍：标准 otpauth:// 解析结果与 Python 一致（含非 otpauth 返回 null）", () => {
  assert.ok(fixture.standard.length >= 6);
  for (const c of fixture.standard) {
    const r = parseStandardOtpauthUri(c.uri);
    assert.deepEqual(r ? withEmail(r) : null, c.account, c.uri);
  }
});

test("对拍：多账号 payload 覆盖 SHA256/SHA512、8 位、HOTP counter、中文名称", () => {
  const accounts = fixture.migration[1].accounts;
  assert.deepEqual(
    accounts.map((a) => [a.algorithm, a.digits, a.otp_type, a.counter]),
    [
      ["SHA256", 8, "totp", 0],
      ["SHA512", 6, "hotp", 42],
      ["SHA1", 6, "totp", 0],
    ],
  );
  assert.equal(accounts[2].name, "张三:zhang@例子.cn");
});

// 以下异常行为同样以 Python 实际输出为准（scratch 脚本逐条比对过）
test("异常输入：缺 data / 空 data → 「URI 中缺少 data 参数」；错误 scheme 报错", () => {
  assert.throws(() => parseOtpauthMigrationUri("otpauth-migration://offline"), /URI 中缺少 data 参数/);
  assert.throws(() => parseOtpauthMigrationUri("otpauth-migration://offline?data="), /URI 中缺少 data 参数/);
  assert.throws(
    () => parseOtpauthMigrationUri("otpauth://totp/x?secret=A"),
    /无效的 URI scheme: otpauth，期望 otpauth-migration/,
  );
});

test("异常输入：非法 base64 字符被忽略 → 空列表；截断 varint 不抛错（与 Python 一致）", () => {
  assert.deepEqual(parseOtpauthMigrationUri("otpauth-migration://offline?data=!!!@@@"), []);
  assert.deepEqual(parseOtpauthMigrationUri("otpauth-migration://offline?data=Cg").map((a) => a.secret), [""]);
  assert.deepEqual(parseOtpauthMigrationUri("otpauth-migration://offline?data=CgUKAw").map((a) => a.secret), [""]);
});

test("extractTotpSecretsFromContents：空列表 → NO_QR_FOUND；未知格式截断 50 字；解析异常收集为错误", () => {
  assert.deepEqual(extractTotpSecretsFromContents([]), { accounts: [], errors: [NO_QR_FOUND] });

  const unknown = extractTotpSecretsFromContents(["x".repeat(80)]);
  assert.deepEqual(unknown.errors, [`未知的 QR 码格式: ${"x".repeat(50)}...`]);

  const bad = extractTotpSecretsFromContents(["otpauth-migration://offline"]);
  assert.equal(bad.accounts.length, 0);
  const firstError = bad.errors[0];
  assert.ok(firstError, "解析失败应记入 errors");
  assert.match(firstError, /^解析 QR 码失败: URI 中缺少 data 参数/);

  const ok = extractTotpSecretsFromContents([fixture.migration[0].uri, fixture.standard[0].uri]);
  assert.deepEqual(
    ok.accounts.map((a) => a.secret),
    ["JBSWY3DPK5XXE3DE", "JBSWY3DPEHPK3PXP"],
  );
  assert.deepEqual(ok.errors, []);
});

test("getOtpEmail：issuer:email、email (Issuer)、非邮箱返回 null，结果小写", () => {
  assert.equal(getOtpEmail({ name: "Google:User@Gmail.com" }), "user@gmail.com");
  assert.equal(getOtpEmail({ name: "a@b.com (Google)" }), "a@b.com");
  assert.equal(getOtpEmail({ name: "noemail" }), null);
  assert.equal(getOtpEmail({ name: "x@nodot" }), null);
});
