/**
 * 修改身份验证器 operation 的真机回归用例
 *
 * 真机（ixBrowser profile 14 + 真实 Google 账号，2026-09-24）暴露两处缺陷：
 *   1. 2SV / 验证器设置页会要求 Google 的「重新验证身份」，真机形态是**密码页**
 *      （accounts.google.com/v3/signin/challenge/pwd）。该 URL 命中登录态判定
 *      url.includes("accounts.google.com") && url.includes("signin")，任务会以
 *      「需要先登录账号 / 未登录」假失败——账号其实已登录。
 *   2. 点开「更改身份验证器应用 → 无法扫描？」后，页面上**只有密钥文本、没有验证码输入框**，
 *      必须先点「下一页」Google 才会给出「输入应用生成的验证码」这一步。
 *      原实现直接去「输入验证码」，真机上该 act 返回 success=false，随后核对必然失败
 *      （真机实测：item 报「无法确定设置结果」，而账号其实没变）。
 *   3. 判定词表缺真机文案：改成功后页面显示「身份验证器应用已更改 / 添加时间：刚刚」，
 *      而 verifySetup 的成功词表只有「已添加 / added / 成功 / 完成」→ 真机上必然判成
 *      「无法确定设置结果」。后果不只是误报：新密钥不会落盘（saveNewSecret 只在 success 时调用），
 *      账号的验证器已被换掉而库里还是旧密钥 → 之后会登录失败（本次真机上就发生了，已手动恢复并复跑）。
 *
 * 假引擎严格按真机观察到的页面序列驱动（状态机）：
 *   settings →（点击更改）→ confirm →（点击无法扫描）→ manual_key
 *   →（点击下一页）→ code_input →（输入验证码）→ verifying →（提交）→ done
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ModifyAuthenticatorOperation } from "../src/engine/operations/modify-auth.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const SETTINGS_URL = GoogleURLs.AUTHENTICATOR;
const REAUTH_PWD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?continue=two-step-verification&sarp=1";
const REAUTH_TOTP_URL = "https://accounts.google.com/v3/signin/challenge/totp?continue=two-step-verification&sarp=1";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier";

const PASSWORD_SELECTOR = 'input[name="Passwd"]';
const TOTP_SELECTOR = "#totpPin";
const NEW_SECRET = "JBSWY3DPEHPK3PXP";
const PASSWORD = "pw-must-not-reach-the-llm";
/** 合成测试向量（RFC 6238 样例密钥），不是任何真实账号的密钥 */
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/**
 * 假引擎：状态机 + 只读记录。
 *   reauthShape: "password"（真机形态）| "password_then_totp" | null
 * @param {{ reauthShape?: string | null, signedOut?: boolean }} [options]
 */
function fakeEngine({ reauthShape = null, signedOut = false } = {}) {
  /** @type {{ navigate: any[], fill: any[], act: any[], actResult: any[] }} */
  const calls = { navigate: [], fill: [], act: [], actResult: [] };
  const initialState = signedOut ? "signin" : reauthShape ? "reauth_pwd" : "settings";
  const urls = {
    signin: SIGNIN_URL,
    reauth_pwd: REAUTH_PWD_URL,
    reauth_totp: REAUTH_TOTP_URL,
    settings: SETTINGS_URL,
    confirm: SETTINGS_URL,
    manual_key: SETTINGS_URL,
    code_input: SETTINGS_URL,
    verifying: SETTINGS_URL,
    done: SETTINGS_URL,
  };
  const texts = {
    signin: "登录\n使用您的 Google 账号",
    reauth_pwd: "如需继续操作，请先验证您的身份\n输入您的密码\n下一步",
    reauth_totp: "输入身份验证器生成的验证码\n下一步",
    settings: "“身份验证器”应用\n您的身份验证器\n添加时间：244 天前\n更改身份验证器应用",
    confirm: "更改身份验证器应用\n取消\n下一页",
    manual_key: "在 Google 身份验证器应用中，依次点按 + 和输入设置密钥\n输入您的电子邮件地址和以下密钥（空格没有影响）：\ne27w iofp 3imn d7a2 y5bv x7pv me6r bia2\n上一步\n取消\n下一页",
    code_input: "输入应用生成的验证码\n下一步",
    verifying: "正在验证…",
    done: "身份验证器应用已更改\n添加时间：刚刚",
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
        if (state === "reauth_pwd") return selector === PASSWORD_SELECTOR;
        if (state === "reauth_totp") return selector === TOTP_SELECTOR;
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        if (state === "reauth_pwd" && selector === PASSWORD_SELECTOR) {
          state = reauthShape === "password_then_totp" ? "reauth_totp" : "settings";
        } else if (state === "reauth_totp" && selector === TOTP_SELECTOR) {
          state = "settings";
        }
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
      /** 真机页面序列：每一步的可见性与可点性由此状态机决定 */
      async act(instruction) {
        calls.act.push(instruction);
        let result = true;
        if (/设置身份验证器|更改身份验证器|Set up|Add authenticator|Change app/.test(instruction) && state === "settings") {
          state = "confirm";
        } else if (/无法扫描|Can't scan|Enter a setup key|输入设置密钥/.test(instruction) && state === "confirm") {
          state = "manual_key";
        } else if (/进入输入验证码的步骤/.test(instruction) && state === "manual_key") {
          state = "code_input";
        } else if (/在验证码输入框中输入/.test(instruction)) {
          // 真机：这一步之前页面上没有验证码输入框 → act 返回 false
          if (state !== "code_input") result = false;
          else state = "verifying";
        } else if (/Verify|验证|Done|完成/.test(instruction) && state === "verifying") {
          state = "done";
        }
        calls.actResult.push(result);
        return { success: result };
      },
      async extract() {
        extractCount += 1;
        if (extractCount === 1) return { success: true, data: { secret_key: NEW_SECRET } };
        // 第二步核对：只有真正走完 → 才有成功标志
        return {
          success: true,
        data: { status: state === "done" ? "身份验证器应用已更改\n添加时间：刚刚" : "您的身份验证器 添加时间：244 天前" },
        };
      },
    }),
  };
}

test("回归：验证器设置页要求重新验证身份（密码形式，真机形态）时，填密码后继续而不是判「未登录」", async () => {
  const { engine, calls } = fakeEngine({ reauthShape: "password" });
  const result = await new ModifyAuthenticatorOperation(engine).execute({
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.equal(result.secret_key, NEW_SECRET);

  const passwordFills = calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR);
  assert.equal(passwordFills.length, 1);
  assert.equal(passwordFills[0].value, PASSWORD);

  // 凭据只经 fill 写入：AI 指令里不能出现密码
  for (const instruction of calls.act) {
    assert.ok(!instruction.includes(PASSWORD), `AI 指令里出现了密码: ${instruction}`);
  }
});

test("回归：重新验证先要密码、再要验证码时同样能通过", async () => {
  const { engine, calls } = fakeEngine({ reauthShape: "password_then_totp" });
  const result = await new ModifyAuthenticatorOperation(engine).execute({
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.equal(calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR).length, 1);
  assert.equal(calls.fill.filter((f) => f.selector === TOTP_SELECTOR).length, 1);
});

test("缺陷 2 回归：手动密钥视图下必须先点「下一页」再输入验证码（不点则输入必然失败）", async () => {
  const { engine, calls } = fakeEngine();
  const result = await new ModifyAuthenticatorOperation(engine).execute({
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);

  const nextIndex = calls.act.findIndex((i) => /进入输入验证码的步骤/.test(i));
  const codeIndex = calls.act.findIndex((i) => /在验证码输入框中输入/.test(i));
  assert.ok(nextIndex >= 0, `缺少「下一页」步骤: ${JSON.stringify(calls.act)}`);
  assert.ok(codeIndex > nextIndex, "应先点「下一页」再输入验证码");

  // 每一步 act 都必须成功（真机上第 4 步曾返回 false）
  assert.deepEqual(calls.actResult, calls.act.map(() => true));
});

test("验证页缺少密码时如实报「重新验证身份」，不误判为「需要先登录账号」", async () => {
  const { engine } = fakeEngine({ reauthShape: "password" });
  const result = await new ModifyAuthenticatorOperation(engine).execute({});

  assert.equal(result.success, false);
  assert.match(result.message, /重新验证身份/);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);
});

test("确实未登录时仍报「需要先登录账号」（没有把登录态判定放宽）", async () => {
  const { engine } = fakeEngine({ signedOut: true });
  const result = await new ModifyAuthenticatorOperation(engine).execute({
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "需要先登录账号");
});

test("地址沿用真机有效的 GoogleURLs.AUTHENTICATOR", async () => {
  const { engine, calls } = fakeEngine();
  await new ModifyAuthenticatorOperation(engine).execute({ password: PASSWORD, totpSecret: SECRET });

  assert.equal(calls.navigate[0], SETTINGS_URL);
  assert.equal(SETTINGS_URL, "https://myaccount.google.com/two-step-verification/authenticator");
});

test("缺陷 3 回归：真机成功文案「身份验证器应用已更改」要判成功（否则新密钥不会落盘）", async () => {
  const { engine } = fakeEngine();
  const result = await new ModifyAuthenticatorOperation(engine).execute({
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.equal(result.secret_key, NEW_SECRET);
});
