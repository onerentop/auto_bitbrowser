/**
 * 替换辅助邮箱 operation 的真机回归用例
 *
 * 真机（ixBrowser profile 7 + 真实 Google 账号，2026-09-24）暴露两处缺陷：
 *   1. 恢复邮箱页会要求 Google 的「重新验证身份」，真机上出现的形态是**直接要身份验证器验证码**
 *      （URL accounts.google.com/v3/signin/challenge/totp），也可能先要密码再要验证码。
 *      原实现把跳转后的 accounts.google.com/.../signin/... 判成「需要先登录账号」直接失败（假失败）。
 *   2. 点完「下一步」后 Google 弹「请输入已发送至新邮箱的 6 位数验证码」——真机确认**新邮箱此时已经生效**，
 *      那只是对新地址的可选校验（页面上留一个「验证辅助邮箱」入口，点取消也照样生效）。
 *      原实现把「出现验证码框且没有取码服务」直接判成失败（假失败）。
 *
 * 假引擎按真机观察到的页面序列驱动；真机核对确认 GoogleURLs.RECOVERY_EMAIL 本身有效
 * （落点就是辅助邮箱设置页），所以地址不变。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ReplaceEmailOperation } from "../src/engine/operations/replace-email.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const SETTINGS_URL = GoogleURLs.RECOVERY_EMAIL;
const REAUTH_TOTP_URL = "https://accounts.google.com/v3/signin/challenge/totp?continue=recovery/email&sarp=1";
const REAUTH_PWD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?continue=recovery/email&sarp=1";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier";

const PASSWORD_SELECTOR = 'input[name="Passwd"]';
const TOTP_SELECTOR = "#totpPin";
const NEW_EMAIL = "renw93606@gmail.com";
const PASSWORD = "pw-must-not-reach-the-llm";
const SECRET = "JBSWY3DPEHPK3PXP";

/**
 * 假引擎：state 由 navigate / fill 驱动。
 *   reauthShape: "totp"（直接要验证码，真机形态）| "password_then_totp" | null
 *   needsEmailCode: true 时，第二次 extract（提交后的检查）返回「检测到验证码框」
 * @param {{ reauthShape?: string | null, signedOut?: boolean, needsEmailCode?: boolean }} [options]
 */
function fakeEngine({ reauthShape = null, signedOut = false, needsEmailCode = false } = {}) {
  /** @type {{ navigate: any[], fill: any[], act: any[] }} */
  const calls = { navigate: [], fill: [], act: [] };
  const initialState = signedOut
    ? "signin"
    : reauthShape === "totp"
      ? "reauth_totp"
      : reauthShape === "password_then_totp"
        ? "reauth_pwd"
        : "settings";
  const urls = {
    signin: SIGNIN_URL,
    reauth_totp: REAUTH_TOTP_URL,
    reauth_pwd: REAUTH_PWD_URL,
    settings: SETTINGS_URL,
  };
  const texts = {
    signin: "登录\n使用您的 Google 账号",
    reauth_totp: "如需继续操作，请先验证您的身份\n输入身份验证器生成的验证码\n下一步",
    reauth_pwd: "如需继续操作，请先验证您的身份\n输入您的密码\n下一步",
    settings: "辅助邮箱\nRecovery email",
  };
  let state = initialState;
  let extractCount = 0;

  return {
    calls,
    // 假引擎只实现被用到的门面方法，用 any 局部标注避免与真引擎门面形状对拍
    engine: /** @type {any} */ ({
      async navigate(url) {
        calls.navigate.push(url);
        state = initialState;
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urls[state];
      },
      async getPageContent() {
        return texts[state];
      },
      async isVisible(selector) {
        if (state === "reauth_totp") return selector === TOTP_SELECTOR;
        if (state === "reauth_pwd") return selector === PASSWORD_SELECTOR;
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        if (state === "reauth_totp" && selector === TOTP_SELECTOR) state = "settings";
        else if (state === "reauth_pwd" && selector === PASSWORD_SELECTOR) state = "reauth_totp";
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
        if (extractCount === 1) return { success: true, data: { has_recovery_email: true, has_edit_button: true } };
        if (extractCount === 2) {
          return {
            success: true,
            data: needsEmailCode ? { extraction: "验证码输入框 - 验证码" } : { nothing_required: true },
          };
        }
        return { success: true, data: { recovery_email_shown: NEW_EMAIL } };
      },
    }),
  };
}

test("回归：重新验证身份页直接要验证器验证码时（真机形态），填码后继续替换而不是判「未登录」", async () => {
  const { engine, calls } = fakeEngine({ reauthShape: "totp" });
  const result = await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);

  // 两次导航（开头一次、核对替换结果时一次）都会要求验证 → 验证码填两次
  const totpFills = calls.fill.filter((f) => f.selector === TOTP_SELECTOR);
  assert.equal(totpFills.length, 2);
  assert.match(totpFills[0].value, /^\d{6}$/);

  // 凭据只经 fill 写入：AI 指令里不能出现密码
  for (const instruction of calls.act) {
    assert.ok(!instruction.includes(PASSWORD), `AI 指令里出现了密码: ${instruction}`);
  }
});

test("回归：重新验证身份先要密码、再要验证码时同样能通过", async () => {
  const { engine, calls } = fakeEngine({ reauthShape: "password_then_totp" });
  const result = await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.equal(calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR).length, 2);
  assert.equal(calls.fill.filter((f) => f.selector === TOTP_SELECTOR).length, 2);
});

test("验证页缺少凭据时如实报「重新验证身份」，不误判为「需要先登录账号」", async () => {
  const { engine } = fakeEngine({ reauthShape: "totp" });
  const result = await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, {});

  assert.equal(result.success, false);
  assert.match(result.message, /验证/);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);
});

test("确实未登录时仍报「需要先登录账号」（没有把登录态判定放宽）", async () => {
  const { engine } = fakeEngine({ signedOut: true });
  const result = await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "需要先登录账号");
});

test("地址沿用真机有效的 GoogleURLs.RECOVERY_EMAIL（不需要像替换手机号那样改地址）", async () => {
  const { engine, calls } = fakeEngine();
  await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, { password: PASSWORD, totpSecret: SECRET });

  assert.equal(calls.navigate[0], SETTINGS_URL);
  assert.equal(SETTINGS_URL, "https://myaccount.google.com/recovery/email");
});

test("缺陷 2 回归：出现新邮箱验证码框时不判失败（真机上新邮箱此时已生效，是否成功由结果核对定论）", async () => {
  const { engine } = fakeEngine({ needsEmailCode: true });
  const result = await new ReplaceEmailOperation(engine).execute(NEW_EMAIL, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.ok(!result.message.includes("需要手动输入验证码"), result.message);
});
