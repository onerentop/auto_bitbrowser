/**
 * src/engine/totp.ts —— 与 pyotp 对拍；密钥中的空白容错（真机测试发现的有意偏差）
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { base32Decode, generateTotp } from "../src/engine/totp.ts";

// 期望值由 pyotp.TOTP(secret).at(t) 生成
/** @type {Array<[string, number, string]>} */
const PYOTP = [
  ["JBSWY3DPEHPK3PXP", 1700000000, "324550"],
  ["JBSWY3DPEHPK3PXP", 59, "996554"],
  ["ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 1700000000, "532659"],
  ["abcdefghijklmnopqrstuvwxyz234567", 1234567890, "111313"],
];

test("generateTotp：与 pyotp 结果一致（含小写密钥）", () => {
  for (const [secret, t, code] of PYOTP) assert.equal(generateTotp(secret, t * 1000), code, `${secret}@${t}`);
});

test("generateTotp：Google 显示格式（小写、每 4 位空格分隔）与去空格后结果相同", () => {
  const spaced = "abcd efgh ijkl mnop qrst uvwx yz23 4567";
  assert.equal(generateTotp(spaced, 1700000000 * 1000), "532659");
  assert.equal(generateTotp(" \tABCD\nEFGH IJKL MNOP QRST UVWX YZ23 4567 ", 1700000000 * 1000), "532659");
});

test("base32Decode：非法字符仍然抛错（容错只去空白）", () => {
  assert.throws(() => base32Decode("ABC1"), /非法的 base32 字符: 1/);
  assert.throws(() => generateTotp("ABCD-EFGH", 0), /非法的 base32 字符: -/);
});
