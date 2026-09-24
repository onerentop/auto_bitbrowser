/**
 * 首页 2FA 验证码（src/application/tfa-codes.ts）：密钥只在后端，界面只拿验证码
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeTfaCodes, extractTfaSecrets, TFA_PERIOD_MS } from "../src/application/tfa-codes.ts";
import { generateTotp } from "../src/engine/totp.ts";

const SECRET = "JBSWY3DPEHPK3PXP";

test("extractTfaSecrets：只收有效窗口 ID 与非空密钥（去空白）", () => {
  const m = extractTfaSecrets([
    { profile_id: 1, tfa_secret: SECRET },
    { profile_id: 2, tfa_secret: "  " },
    { profile_id: 3 },
    { profile_id: "4", tfa_secret: "abcd efgh" },
    { profile_id: -1, tfa_secret: SECRET },
    null,
  ]);
  assert.deepEqual([...m.entries()], [
    [1, SECRET],
    [4, "abcdefgh"],
  ]);
});

test("computeTfaCodes：与 generateTotp 一致；无密钥不返回；非法密钥进 invalid；periodEndsAt 为本周期结束", () => {
  const now = 1_758_000_012_345;
  const secrets = new Map([
    [1, SECRET],
    [2, "not-base32!"],
  ]);
  const r = computeTfaCodes(secrets, [1, 2, 3], now);
  assert.deepEqual(r.codes, { 1: generateTotp(SECRET, now) });
  assert.deepEqual(r.invalid, [2]);
  assert.equal(r.periodEndsAt, (Math.floor(now / TFA_PERIOD_MS) + 1) * TFA_PERIOD_MS);
  assert.ok(r.periodEndsAt > now && r.periodEndsAt - now <= TFA_PERIOD_MS);
  assert.ok(!JSON.stringify(r).includes(SECRET), "返回值不含密钥");
});
