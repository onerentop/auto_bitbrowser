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
/** 页面上的显示格式（真机：+86 176 0014 4886 这种分组格式） */
const NEW_PHONE_SHOWN = "+86 138 0000 1234";
const OLD_PHONE_SHOWN = "07521 544348";
const PASSWORD = "pw-must-not-reach-the-llm";
const SECRET = "JBSWY3DPEHPK3PXP";

/**
 * 假引擎（按真机 2026-09-25 页面形态）：
 *   设置页显示旧号码 → 点「下一步」→ 「Confirm your phone number」确认框（codeRequired 时改为输入验证码页）
 *   → 点保存 → 设置页显示新号码（saveNoop 时保存无效，仍是旧号码）。
 * extract 故意返回否定句 / 误导性文字：判定必须以页面文本为准，不能看 AI 回答里有没有某个词。
 */
function fakeEngine({
  needsReauth = false,
  signedOut = false,
  codeRequired = false,
  saveNoop = false,
  saveMissed = false,
  verifyNavFails = false,
  confirmDelayWaits = 0,
} = {}) {
  let confirmDelay = confirmDelayWaits;
  /** @type {{ navigate: string[], fill: { selector: string, value: string }[], act: string[], saved: boolean }} */
  const calls = { navigate: [], fill: [], act: [], saved: false };
  const urls = {
    signin: SIGNIN_URL,
    reauth_password: REAUTH_PWD_URL,
    reauth_totp: REAUTH_TOTP_URL,
    settings: SETTINGS_URL,
    confirm: SETTINGS_URL,
    code: SETTINGS_URL,
    pending_confirm: SETTINGS_URL,
    editing: SETTINGS_URL,
  };
  let phoneShown = OLD_PHONE_SHOWN;
  const texts = {
    signin: () => "登录\n使用您的 Google 账号",
    reauth_password: () => "欢迎\n如需继续操作，请先验证您的身份\n输入您的密码\n下一步",
    reauth_totp: () => "输入身份验证器生成的验证码\n下一步",
    settings: () =>
      `Recovery phone\nWhen you change your recovery phone, you may be able to choose to get sign-in codes sent to your previous recovery phone for one week.\n${phoneShown}`,
    confirm: () =>
      `Recovery phone\n${phoneShown}\nConfirm your phone number\nMake sure\n${NEW_PHONE_SHOWN}\nis the number you would like to save. When you need to use your phone number to verify it's you signing in, codes will be sent to this number by text message.\nBack\nSave`,
    code: () => `Recovery phone\nVerify your phone number\nEnter the code sent to ${NEW_PHONE_SHOWN}\nVerify`,
    pending_confirm: () => `Recovery phone\n${phoneShown}\nAdd phone number`,
    editing: () => `Recovery phone\n${phoneShown}\nPhone number\n${NEW_PHONE_SHOWN}\nCancel\nSave`,
  };
  let state = signedOut ? "signin" : needsReauth ? "reauth_password" : "settings";
  let extractCount = 0;

  return {
    calls,
    engine: /** @type {any} */ ({
      async navigate(url) {
        calls.navigate.push(url);
        // 核对阶段（第二次导航）失败：页面停在原地
        if (verifyNavFails && calls.navigate.length >= 2) return { success: false, error: "Timeout 30000ms exceeded" };
        state = signedOut ? "signin" : needsReauth ? "reauth_password" : "settings";
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urls[state];
      },
      async getPageContent() {
        return texts[state]();
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
      async bringToFront() {},
      async wait() {
        // 确认框晚几拍才渲染（审查：不能赌一次 3 秒固定等待）
        if (state === "pending_confirm" && --confirmDelay <= 0) state = "confirm";
      },
      async act(instruction) {
        calls.act.push(instruction);
        if (state === "settings" && instruction.includes("'Next'")) {
          state = codeRequired ? "code" : confirmDelay > 0 ? "pending_confirm" : "confirm";
        } else if (state === "confirm" && /'Save'/.test(instruction)) {
          if (saveMissed) {
            // act 说成功，但其实没点中：编辑框还开着、里面是刚输入的新号码（不含「verify it's you」字样）
            state = "editing";
            return { success: true };
          }
          calls.saved = true;
          if (!saveNoop) phoneShown = NEW_PHONE_SHOWN;
          state = "settings";
        }
        return { success: true };
      },
      async extract() {
        extractCount += 1;
        if (extractCount === 1) return { success: true, data: { has_recovery_phone: true, has_edit_button: true } };
        // 真机原话：否定句里也含「验证码」；以及含「已更新」的否定句
        return {
          success: true,
          data: { extraction: "页面未显示验证码输入框、成功消息“恢复手机已更新”或错误消息“无效的手机号”。" },
        };
      },
    }),
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
  const firstPasswordFill = passwordFills[0];
  assert.ok(firstPasswordFill);
  assert.equal(firstPasswordFill.value, PASSWORD);

  const totpFills = calls.fill.filter((f) => f.selector === TOTP_SELECTOR);
  assert.equal(totpFills.length, 2);
  const firstTotpFill = totpFills[0];
  assert.ok(firstTotpFill);
  assert.match(firstTotpFill.value, /^\d{6}$/);

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

test("真机回归（2026-09-25）：点「下一步」后弹出「Confirm your phone number」确认框 → 点保存；AI 说「未显示验证码输入框」不能被当成要验证码", async () => {
  const { engine, calls } = fakeEngine();
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });
  assert.equal(result.success, true, result.message);
  assert.ok(calls.saved, "确认框上要点保存");
});

test("真的要短信验证码（页面出现输入验证码提示）且没有短信服务：如实报需要手动输入验证码，不点保存", async () => {
  const { engine, calls } = fakeEngine({ codeRequired: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });
  assert.equal(result.success, false);
  assert.equal(result.message, "需要手动输入验证码");
  assert.ok(!calls.act.some((i) => /'Save'|保存/.test(i)), `不应发出保存指令: ${JSON.stringify(calls.act)}`);
});

test("核对以真实页面为准：保存没生效（页面仍是旧号码）时判失败，即使 AI 回答里有「已更新」字样", async () => {
  const { engine } = fakeEngine({ saveNoop: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });
  assert.equal(result.success, false, "页面上没有新号码就不能判成功");
});

test("审查回归：保存没点中、核对时导航又失败 → 页面还停在编辑框（里面是刚输入的新号码），不能判成功", async () => {
  const { engine } = fakeEngine({ saveMissed: true, verifyNavFails: true });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });
  assert.equal(result.success, false, "导航失败时不能拿屏幕上的确认框当结果");
});

test("审查回归：确认框渲染晚于 3 秒时轮询等它出现，再点保存", async () => {
  const { engine, calls } = fakeEngine({ confirmDelayWaits: 3 });
  const result = await new ReplacePhoneOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });
  assert.equal(result.success, true, result.message);
  assert.ok(calls.saved);
});
