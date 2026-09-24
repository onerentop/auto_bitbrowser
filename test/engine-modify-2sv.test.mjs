/**
 * 修改 2SV 手机号 operation 的真机回归用例
 *
 * 真机（2026-09-24，profile 14 + 真实 Google 账号）暴露的缺陷：
 *   2SV 设置页会要求 Google 的「重新验证身份」，真机形态是**密码页**
 *   （accounts.google.com/v3/signin/challenge/pwd）。该 URL 命中登录态判定
 *   url.includes("accounts.google.com") && url.includes("signin")，任务会以
 *   「需要先登录账号 / 未登录」假失败——账号其实已登录。
 *
 * 另注：AI 任务页不传 smsService（用户既有决定「改 2SV 手机不需要验证码」）。真机确认：
 * 「下一步」之后是「确认您的电话号码」页，点「保存」才真正写入，全程没有验证码步骤。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { Modify2SVOperation } from "../src/engine/operations/modify-2sv.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const SETTINGS_URL = GoogleURLs.TWO_STEP_VERIFICATION;
const REAUTH_PWD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?continue=two-step-verification&sarp=1";
const REAUTH_TOTP_URL = "https://accounts.google.com/v3/signin/challenge/totp?continue=two-step-verification&sarp=1";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier";

const PASSWORD_SELECTOR = 'input[name="Passwd"]';
const TOTP_SELECTOR = "#totpPin";
const NEW_PHONE = "+8613800001234";
const PASSWORD = "pw-must-not-reach-the-llm";
/** 合成测试向量（RFC 6238 样例密钥），不是任何真实账号的密钥 */
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/**
 * 假引擎：状态机（重新验证 → 2SV 设置页）+ 只读记录
 * @param {{
 *   needsReauth?: boolean,
 *   signedOut?: boolean,
 *   totpStyle?: boolean,
 *   rejectFirstTotpSubmit?: boolean,
 *   onWait?: ((ms: number) => void) | null,
 *   dialogHasConfirmWord?: boolean,
 *   saveDoesNothing?: boolean,
 *   navigateFails?: boolean,
 *   nextDoesNothing?: boolean,
 * }} [options]
 */
function fakeEngine({
  needsReauth = false,
  signedOut = false,
  totpStyle = false,
  rejectFirstTotpSubmit = false,
  onWait = null,
  /** 弹层里也出现「请确认」字样（真机上这类措辞很常见）→ 钉住「确认页判定必须收窄」 */
  dialogHasConfirmWord = false,
  /** 点「保存」不生效（确认页仍在）→ 钉住「复核导航失败不得假成功」 */
  saveDoesNothing = false,
  /** 复核时的 navigate 失败（多标签 / 超时）→ 页面停在原地 */
  navigateFails = false,
  /** 点「下一步」不生效（弹层仍在）→ 钉住「确认页判定过宽会在弹层上盲点保存」 */
  nextDoesNothing = false,
} = {}) {
  /** @type {{ navigate: any[], fill: any[], act: any[], click: any[], jsClick: any[], clickByText: any[], totpSubmits?: number }} */
  const calls = { navigate: [], fill: [], act: [], click: [], jsClick: [], clickByText: [] };
  const initialState = signedOut
    ? "signin"
    : totpStyle
      ? "reauth_totp"
      : needsReauth
        ? "reauth_pwd"
        : "settings";
  const urls = {
    signin: SIGNIN_URL,
    reauth_pwd: REAUTH_PWD_URL,
    reauth_totp: REAUTH_TOTP_URL,
    settings: SETTINGS_URL,
    phone_page: "https://myaccount.google.com/two-step-verification/phone-numbers",
  };
  const texts = {
    signin: "登录\n使用您的 Google 账号",
    reauth_pwd: "如需继续操作，请先验证您的身份\n输入您的密码\n下一步",
    reauth_totp: "验证身份\n为了确保您的账号安全，Google 希望确认是您本人在操作\n从 Google 身份验证器应用获取验证码\n输入验证码\n下一步",
    settings: "两步验证\n您的手机号\n更改手机号",
  };
  /** 2SV 电话号码列表页：只在保存生效后才含新号码 */
  const phoneListText = (hasNewPhone) =>
    `用于进行两步验证的电话号码\n管理辅助电话号码\n07521 000100\n${
      hasNewPhone ? "+8613800001234\n" : ""
    }添加两步验证备用电话号码`;
  let state = initialState;
  /** 「添加电话号码」弹层是否打开（真机：弹层里会出现「通过短信接收验证码」） */
  let dialogOpen = false;
  /** 真机：「下一步」之后还会出现「确认您的电话号码」页，必须再点「保存」才写入 */
  let confirmOpen = false;
  /** 真机：号码是否已经在 2SV 电话号码列表里（只有「保存」真正生效后才会有） */
  let listHasNewPhone = false;
  let extractCount = 0;

  return {
    calls,
    engine: /** @type {any} */ ({
      async navigate(url) {
        calls.navigate.push(url);
        // 真机：多标签 / 前台不在当前页 / 超时都会让 navigate 失败，此时页面停原地不动
        // 只让「复核用的那一次」导航失败：任务开头的导航必须成功，否则跑不到复核
        if (navigateFails && String(url).includes("/two-step-verification/phone-numbers")) {
          return { success: false, error: "导航失败（模拟）" };
        }
        dialogOpen = false;
        confirmOpen = false;
        state = String(url).includes("/two-step-verification/phone-numbers") ? "phone_page" : initialState;
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urls[state];
      },
      async getPageContent() {
        if (confirmOpen)
          return "确认您的电话号码\n请确认 +8613800001234 是您要保存的号码。\n上一步\n保存";
        if (dialogOpen)
          return `添加电话号码\n通过短信接收验证码\n下一步${
            dialogHasConfirmWord ? "\n请确认您的手机号能正常接收短信" : ""
          }`;
        if (state === "phone_page") return phoneListText(listHasNewPhone);
        return texts[state];
      },
      async isVisible(selector) {
        if (state === "reauth_pwd") return selector === PASSWORD_SELECTOR;
        if (state === "reauth_totp") return selector === TOTP_SELECTOR;
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        if (state === "reauth_pwd" && selector === PASSWORD_SELECTOR) state = "settings";
        return true;
      },
      async pressKey() {
        // 真机（2026-09-24）：TOTP 页按 Enter 就能提交；但同一窗口的码重复提交会被判「验证码错误」
        if (state === "reauth_totp") {
          calls.totpSubmits = (calls.totpSubmits ?? 0) + 1;
          if (!(rejectFirstTotpSubmit && calls.totpSubmits === 1)) state = "settings";
        }
        return true;
      },
      async click(selector) {
        calls.click.push(selector);
        return true;
      },
      async jsClick(selector) {
        calls.jsClick.push(selector);
        return true;
      },
      /**
       * 按可见文本点击（引擎在页面内派发 DOM 点击）。
       * 真机 2026-09-24：:has-text() 选择器在 stagehand 下恒为 0 匹配，
       * 这是修掉之后唯一有效的确定性点击。fake 这里给出真实副作用，便于钉住点击顺序。
       */
      async clickByText(text) {
        calls.clickByText.push(text);
        if (state === "settings" && text === "电话号码") state = "phone_page";
        else if (state === "phone_page" && text === "添加两步验证备用电话号码") dialogOpen = true;
        else if (dialogOpen && text === "下一步") {
          // 真机：点「下一步」只是进入「确认您的电话号码」页，还要再点「保存」才真正写入
          if (!nextDoesNothing) {
            dialogOpen = false;
            confirmOpen = true;
          }
        } else if (confirmOpen && text === "保存") {
          // 真机因果：只有「保存」真正生效，2SV 电话号码列表里才会出现新号码
          if (!saveDoesNothing) {
            listHasNewPhone = true;
            confirmOpen = false;
          }
        }
        return { tag: "A", href: null };
      },
      async wait(ms) {
        onWait?.(ms ?? 0);
      },
      async act(instruction) {
        calls.act.push(instruction);
        return { success: true };
      },
      async observe() {
        return { success: true, data: [] };
      },
      async extract() {
        extractCount += 1;
        // 第 1 次：check2svStatus（关键词里不能出现 verify / 输入密码，否则会被判成需要密码）
        if (extractCount === 1) return { success: true, data: { has_phone: true, is_enabled: true } };
        // 第 2 次：verifyModification
        return { success: true, data: { status: "已添加手机号" } };
      },
    }),
  };
}

test("回归：2SV 页要求重新验证身份（密码形式）时，填密码后继续而不是判「未登录」", async () => {
  const { engine, calls } = fakeEngine({ needsReauth: true });
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  // 走到了取码那一步（AI 任务不传 smsService）→ 如实报需要验证码，而不是「需要先登录账号」
  // 走完重新验证 + 加号流程；AI 任务不传 smsService，真机确认不需要验证码 → 结果核对判定成功
  assert.equal(result.success, true, result.message);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);

  // 确实越过了验证页并把主流程发起起来（真机修正后由「按文本点击电话号码条目」进入添加流程）
  assert.ok(
    calls.clickByText.includes("电话号码"),
    `未进入修改流程: ${JSON.stringify(calls.clickByText)}`,
  );
  assert.equal(calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR).length, 1);
  assert.equal(calls.fill[0].value, PASSWORD);

  // 凭据只经 fill 写入：AI 指令里不能出现密码
  for (const instruction of calls.act) {
    assert.ok(!instruction.includes(PASSWORD), `AI 指令里出现了密码: ${instruction}`);
  }
});

test("回归：提供短信服务时，重新验证 + 改号 + 填码全流程成功", async () => {
  const { engine, calls } = fakeEngine({ needsReauth: true });
  const sms = { async getCode() { return "123456"; } };
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, sms, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  assert.equal(result.new_phone, NEW_PHONE);
  assert.ok(calls.act.some((i) => /在验证码输入框中输入: 123456/.test(i)), `未提交验证码: ${JSON.stringify(calls.act)}`);
});

test("验证页缺少密码时如实报「重新验证身份」，不误判为「需要先登录账号」", async () => {
  const { engine } = fakeEngine({ needsReauth: true });
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {});

  assert.equal(result.success, false);
  assert.match(result.message, /重新验证身份/);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);
});

test("确实未登录时仍报「需要先登录账号」（没有把登录态判定放宽）", async () => {
  const { engine } = fakeEngine({ signedOut: true });
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, false);
  assert.equal(result.message, "需要先登录账号");
});

test("地址沿用真机有效的 GoogleURLs.TWO_STEP_VERIFICATION", async () => {
  const { engine, calls } = fakeEngine();
  await new Modify2SVOperation(engine).execute(NEW_PHONE, null, { password: PASSWORD, totpSecret: SECRET });

  assert.equal(calls.navigate[0], SETTINGS_URL);
  assert.equal(SETTINGS_URL, "https://myaccount.google.com/signinoptions/two-step-verification");
});

test("缺陷 2 回归：验证码被拒后重试必须等到下一个 30 秒窗口用新码（同窗口重复提交会被判「验证码错误」）", async () => {
  const realNow = Date.now;
  const WINDOW = 30_000;
  const base = 1_700_000_000_000;
  // 从 30 秒窗口的第 0 秒开始：第一次提交被拒时仍在同一窗口，重新生成拿到的还是同一个码
  let fakeMs = base - (base % WINDOW);
  const waits = [];

  const { engine, calls } = fakeEngine({
    totpStyle: true,
    rejectFirstTotpSubmit: true,
    onWait: (ms) => {
      waits.push(ms);
      fakeMs += ms;
    },
  });
  Date.now = () => fakeMs;
  let result;
  try {
    result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
      password: PASSWORD,
      totpSecret: SECRET,
    });
  } finally {
    Date.now = realNow;
  }

  // 真机确认改 2SV 手机不需要验证码 → 不传 smsService 也应走完并核对成功
  assert.equal(result.success, true, result.message);
  assert.ok(!result.message.includes("需要先登录账号"), result.message);

  const codes = calls.fill.filter((f) => f.selector === TOTP_SELECTOR).map((f) => f.value);
  assert.equal(codes.length, 2, `应提交两次验证码: ${JSON.stringify(codes)}`);
  assert.match(codes[0], /^\d{6}$/);
  assert.notEqual(codes[0], codes[1], "第二次必须是新窗口的验证码，不能复用同一个码");
  assert.ok(
    waits.some((ms) => ms >= 10_000),
    `重试前没有等到下一个窗口: ${JSON.stringify(waits)}`,
  );
});

test("回归（真机 2026-09-24）：进「电话号码」页必须用按文本点击，不得再用 stagehand 不支持的 :has-text()", async () => {
  const { engine, calls } = fakeEngine();
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.equal(result.success, true, result.message);
  // 真机实测：locator(':is(a,button,[role="button"]):has-text("电话号码")').count() === 0
  // —— stagehand 的选择器引擎不支持 Playwright 的 :has-text 伪类，click/jsClick 只会静默返回 false，
  // 于是流程退回到 AI act，而 AI act 在该条目上「报成功但页面毫无变化」（run-2sv6 实测卡死）。
  assert.ok(
    calls.clickByText.includes("电话号码"),
    `没有用按文本点击进入电话号码页: ${JSON.stringify(calls.clickByText)}`,
  );
  const hasTextSelectors = [...calls.click, ...calls.jsClick].filter((s) =>
    String(s).includes(":has-text("),
  );
  assert.deepEqual(
    hasTextSelectors,
    [],
    `仍在用 stagehand 不支持的 :has-text() 选择器: ${JSON.stringify(hasTextSelectors)}`,
  );
});

test("回归（真机 2026-09-24）：添加按钮与「下一步」都走按文本点击，且「下一步」在弹层打开之后才点", async () => {
  const { engine, calls } = fakeEngine();
  await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  assert.ok(
    calls.clickByText.includes("添加两步验证备用电话号码"),
    `没有点开添加弹层: ${JSON.stringify(calls.clickByText)}`,
  );
  assert.ok(calls.clickByText.includes("下一步"), `没有点「下一步」: ${JSON.stringify(calls.clickByText)}`);
  assert.ok(
    calls.clickByText.indexOf("添加两步验证备用电话号码") < calls.clickByText.indexOf("下一步"),
    `点击顺序不对: ${JSON.stringify(calls.clickByText)}`,
  );
});

test("回归（真机 2026-09-24）：点「下一步」后还必须点「保存」，否则号码根本没写入", async () => {
  const { engine, calls } = fakeEngine();
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  // 真机实测（RP_NEW_PHONE 探针）：点「下一步」后页面变成「确认您的电话号码 / 请确认 +86 … 是您要
  // 保存的号码 / 上一步 / 保存」——不点「保存」的话 2SV 电话号码列表里根本不会出现新号码。
  assert.equal(result.success, true, result.message);
  assert.ok(calls.clickByText.includes("保存"), `没有点「保存」: ${JSON.stringify(calls.clickByText)}`);
  assert.ok(
    calls.clickByText.indexOf("下一步") < calls.clickByText.indexOf("保存"),
    `必须先点「下一步」再点「保存」: ${JSON.stringify(calls.clickByText)}`,
  );
});

test("回归（审查 2026-09-24）：确认页判定必须收窄——弹层里出现「请确认」时不得点「保存」", async () => {
  const { engine, calls } = fakeEngine({ dialogHasConfirmWord: true, nextDoesNothing: true });
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  // 「请确认」在 Google 账号页上是很常见的措辞：「下一步」若没生效（弹层仍在），
  // 只按 /请确认/ 判定会让流程在弹层上盲点「保存」，接着还会无条件再发一次 AI act
  //（在没有保存按钮的页面上让模型自由点，可能点到「上一步 / 取消 / 删除电话号码」）。
  assert.ok(
    !calls.clickByText.includes("保存"),
    `弹层还开着就点了「保存」: ${JSON.stringify(calls.clickByText)}`,
  );
  assert.equal(result.success, false, "弹层没推进时不应报成功");
});

test("回归（审查 2026-09-24）：复核用的 navigate 失败时，不得把「确认页上本来就有的新号码」当成成功", async () => {
  const { engine } = fakeEngine({ saveDoesNothing: true, navigateFails: true });
  const result = await new Modify2SVOperation(engine).execute(NEW_PHONE, null, {
    password: PASSWORD,
    totpSecret: SECRET,
  });

  // 保存没生效 + 复核跳转失败 → 页面还停在「确认您的电话号码」页，而那页正文里本来就有完整新号码
  //（「请确认 +8613800001234 是您要保存的号码」）。不检查 navigate 成败就会读成「列表里有新号码」→ 假成功。
  assert.equal(result.success, false, `导航失败时不应报成功: ${result.message}`);
});
