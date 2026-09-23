/**
 * 替换恢复手机号 operation 的真机回归用例
 *
 * 真机（ixBrowser profile 7 + 真实 Google 账号，2026-09-24）暴露的两处缺陷：
 *   1. 操作导航到 GoogleURLs.RECOVERY_PHONE（myaccount.google.com/recovery/phone）→ 真机是 404 页
 *      （"404. That's an error."，完成身份验证后再访问仍是 404），整个流程在错误页面上跑。
 *      该页面在 Google 侧的正确地址是 GoogleURLs.RECOVERY_PHONE_SETTINGS。
 *   2. 该页面会要求 Google 的「重新验证身份」（密码 → 验证器验证码）。原实现把跳转后的
 *      accounts.google.com/v3/signin/challenge/pwd 判成「需要先登录账号」，直接判任务失败。
 *
 * 假引擎按真机观察到的页面序列驱动：每次 navigate 到设置页都落在验证页（真机行为）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ReplacePhoneOperation } from "../src/engine/operations/replace-phone.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const SETTINGS_URL = GoogleURLs.RECOVERY_PHONE_SETTINGS;
const DEAD_URL = GoogleURLs.RECOVERY_PHONE;
const REAUTH_PWD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?continue=rescuephone&sarp=1";
const REAUTH_TOTP_URL = "https://accounts.google.com/v3/signin/challenge/totp?continue=rescuephone&sarp=1";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier";

const PASSWORD_SELECTOR = 'input[name="Passwd"]';
const TOTP_SELECTOR = "#totpPin";
const NEW_PHONE = "+8613800001234";
const PASSWORD = "pw-must-not-reach-the-llm";
const SECRET = "JBSWY3DPEHPK3PXP";

/** 假引擎：state 由 navigate / fill 驱动，记录所有原语调用 */
function fakeEngine({ needsReauth = false, signedOut = false } = {}) {
  const calls = { navigate: [], fill: [], act: [] };
  const urls = {
    signin: SIGNIN_URL,
    reauth_password: REAUTH_PWD_URL,
    reauth_totp: REAUTH_TOTP_URL,
    settings: SETTINGS_URL,
  };
  const texts = {
    signin: "登录\n使用您的 Google 账号",
    reauth_password: "欢迎\n如需继续操作，请先验证您的身份\n输入您的密码\n下一步",
    reauth_totp: "输入身份验证器生成的验证码\n下一步",
    settings: "恢复手机\nRecovery phone",
  };
  let state = signedOut ? "signin" : needsReauth ? "reauth_password" : "settings";
  let extractCount = 0;

  return {
    calls,
    engine: {
      async navigate(url) {
        calls.navigate.push(url);
        state = signedOut ? "signin" : needsReauth ? "reauth_password" : "settings";
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urls[state];
      },
      async getPageContent() {
        return texts[state];
      },
      async isVisible(selector) {
        if (state === "reauth_password") return selector === PASSWORD_SELECTOR;
        if (state === "reauth_totp") return selector === TOTP_SELECTOR;
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        if (state === "reauth_password" && selector === PASSWORD_SELECTOR) state = "reauth_totp";
        else if (state === "reauth_totp" && selector === TOTP_SELECTOR) state = "settings";
        return true;
      },
      async pressKey() {
        return true;
      },
      async click() {
        return true;
      },
      async jsClick() {
        return true;
      },
      async wait() {},
      async act(instruction) {
        calls.act.push(instruction);
        return { success: true };
      },
      async extract() {
        extractCount += 1;
        return extractCount === 1
          ? { success: true, data: { has_recovery_phone: true, has_edit_button: true } }
          : { success: true, data: { recovery_phone_shown: `***${NEW_PHONE.slice(-4)}` } };
      },
    },
  };
}

test("缺陷 1 回归：导航到恢复手机设置页的正确地址，而不是已失效的 RECOVERY_PHONE", async () => {
  const { engine, calls } = fakeEngine();
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(calls.navigate[0], SETTINGS_URL);
  assert.notEqual(calls.navigate[0], DEAD_URL);
  assert.equal(result.success, true, result.message);
});

test("缺陷 2 回归：验证页要求重新验证身份时，填密码 + 验证码后继续替换（不是「未登录」）", async () => {
  const { engine, calls } = fakeEngine({ needsReauth: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);

  // 每次导航到该页都会重新要求验证（真机行为）→ 第一次导航与核对时的第二次导航都要处理
  const passwordFills = calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR);
  assert.equal(passwordFills.length, 2);
  assert.equal(passwordFills[0].value, PASSWORD);

  const totpFills = calls.fill.filter((f) => f.selector === TOTP_SELECTOR);
  assert.equal(totpFills.length, 2);
  assert.match(totpFills[0].value, /^\d{6}$/);

  // 凭据只经 fill 写入：AI 指令里不能出现密码
  for (const instruction of calls.act) {
    assert.ok(!instruction.includes(PASSWORD), `AI 指令里出现了密码: ${instruction}`);
  }
});

test("验证页缺少密码时如实报「重新验证身份」，不误判为「需要先登录账号」", async () => {
  const { engine } = fakeEngine({ needsReauth: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {});

  assert.equal(result.success, false);
  assert.match(result.message, /重新验证身份/);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);
});

test("确实未登录时仍报「需要先登录账号」（没有把登录态判定放宽）", async () => {
  const { engine } = fakeEngine({ signedOut: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "需要先登录账号");
});

test("缺陷 3 回归：填完号码、点过「下一步」之后还要再点保存，改动才会生效", async () => {
  const { engine, calls } = fakeEngine();
  await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  const nextIndex = calls.act.findIndex((i) => i.includes("'Next'"));
  const saveIndex = calls.act.findIndex((i) => /保存|'Save'|'Done'|'Confirm'/.test(i));
  assert.ok(nextIndex >= 0, `没有点「下一步」: ${JSON.stringify(calls.act)}`);
  assert.ok(saveIndex >= 0, `点完「下一步」后没有点保存: ${JSON.stringify(calls.act)}`);
  assert.ok(saveIndex > nextIndex, "保存点击应发生在「下一步」之后");
});
