/**
 * 登录流程（src/engine/operations/login.ts）的离线测试。
 * FakeGoogle 按真实 Google 登录页的 URL / 固定元素 / 文案模拟各个页面，
 * 覆盖：完整登录、不再误判「已登录」、密码只写一次、各类失败路径。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LoginOperation, LoginSelectors, SIGNIN_URL } from "../src/engine/operations/login.ts";
import { generateTotp } from "../src/engine/totp.ts";

const EMAIL = "tester@gmail.com";
const PASSWORD = "Pw!23456";
const SECRET = "JBSWY3DPEHPK3PXP";
/** 固定时间：窗口开头（剩余 30 秒），生成的验证码确定 */
const NOW = 1_700_000_010_000;

const SIGNIN_TEXT = "Sign in\nUse your Google Account\nEmail or phone\nForgot email?\nNot your computer?\nCreate account";

/** 页面定义：url / 可见元素 / 文本 */
function pageDef(g, name) {
  const acc = "https://accounts.google.com";
  switch (name) {
    case "blank":
      return { url: "about:blank", visible: [], text: "" };
    case "email":
      return {
        url: `${acc}/v3/signin/identifier?hl=en`,
        visible: ["#identifierId", "#identifierNext button"],
        text: SIGNIN_TEXT + (g.error ? `\n${g.error}` : ""),
      };
    case "chooser":
      return {
        url: `${acc}/v3/signin/accountchooser?hl=en`,
        visible: [],
        text: `Choose an account\nto continue to Google Account\n${EMAIL}\nSigned out\nUse another account\nCreate account`,
      };
    case "dead":
      // 登录页但输入框没出来：满屏都是 "account"
      return {
        url: `${acc}/v3/signin/identifier?hl=en`,
        visible: [],
        text: "Sign in\nUse your Google Account\nCreate account\nGoogle Account Help",
      };
    case "captcha":
      return {
        url: `${acc}/v3/signin/identifier?hl=en`,
        visible: ["#identifierId", "#captchaimg"],
        text: `${SIGNIN_TEXT}\nType the text you hear or see`,
      };
    case "recaptcha":
      return { url: `${acc}/v3/signin/challenge/recaptcha?hl=en`, visible: [], text: "Confirm you’re not a robot" };
    case "password":
      return {
        url: `${acc}/v3/signin/challenge/pwd?hl=en`,
        visible: ['input[name="Passwd"]', "#passwordNext button"],
        text: `Welcome\n${EMAIL}\nEnter your password\nShow password` + (g.error ? `\n${g.error}` : ""),
      };
    case "pwd_transition":
      // 真机实测：提交密码后页面过渡中——密码框已消失、TOTP 框尚未渲染，
      // 但 URL 仍停在密码页自身的 /v3/signin/challenge/pwd。此时不能判成「其他两步验证」。
      return {
        url: `${acc}/v3/signin/challenge/pwd?hl=en`,
        visible: [],
        text: "",
      };
    case "totp":
      return {
        url: `${acc}/v3/signin/challenge/totp?hl=en`,
        visible: ["#totpPin", "#totpNext button"],
        text: "2-Step Verification\nTo help keep your account safe, Google wants to make sure it’s really you\nEnter code\nGet a verification code from the Google Authenticator app" + (g.error ? `\n${g.error}` : ""),
      };
    case "sms":
      return {
        url: `${acc}/v3/signin/challenge/ipp/consent?hl=en`,
        visible: [],
        text: "2-Step Verification\nGoogle will send a verification code to your phone number\nStandard rates apply\nSend",
      };
    case "prompt":
      return {
        url: `${acc}/v3/signin/challenge/dp?hl=en`,
        visible: [],
        text: "2-Step Verification\nCheck your phone\nGoogle sent a notification to your phone. Tap Yes on the notification to verify it’s you.",
      };
    case "selection":
      return {
        url: `${acc}/v3/signin/challenge/selection?hl=en`,
        visible: [],
        text: "Verify it’s you\nChoose how you want to sign in:\nTap Yes on your phone\nGet a verification code at ••• ••• ••12",
      };
    case "selection_auth":
      // 真机（2026-09-24）实际形态：选择验证方式页里**有**验证器这一项，
      // 文本是「Get a verification code from the Google Authenticator app」，
      // 可点元素是内层 <div role="link">。
      return {
        url: `${acc}/v3/signin/challenge/selection?hl=en`,
        visible: [],
        clickTexts: ["Get a verification code from the Google Authenticator app", "Try another way"],
        text:
          "2-Step Verification\nTo help keep your account safe, Google wants to make sure it’s really you\n" +
          "Some of the ways you sign in are not available right now\nChoose how you want to sign in:\n" +
          "Get a verification code from the Google Authenticator app\n" +
          "Get a verification code at ••••• ••••48\n2-Step Verification phone\nStandard rates apply",
      };
    case "speedbump":
      return {
        url: `${acc}/speedbump/passkeyenrollment?hl=en`,
        visible: [],
        text: "Simplify your sign-in\nWith passkeys, you can sign in with your fingerprint\nNot now",
      };
    case "myaccount":
      return {
        url: "https://myaccount.google.com/?hl=en",
        visible: [],
        text: "Welcome, Tester\nManage your info, privacy, and security to make Google work better for you",
        html: `<a aria-label="Google Account: Tester  (${g.signedInAs})" href="#"></a>`,
      };
    case "about":
      return {
        url: "https://www.google.com/account/about/?hl=en",
        visible: [],
        text: "Google Account\nSign in\nCreate an account\nEverything you need, all in one place",
      };
    default:
      throw new Error(`未知页面 ${name}`);
  }
}

class FakeGoogle {
  constructor(opts = {}) {
    this.opts = {
      accountExists: true,
      secondFactor: "totp",
      captchaAt: null,
      /** 真机（2026-09-24）：登出后再登录，提交第一次邮箱会被送回账号选择页 */
      chooserAfterEmail: false,
      signinPage: "email",
      afterTotp: "myaccount",
      fillWorks: true,
      /** Enter 能提交当前表单 */
      enterWorks: true,
      /** 坐标点击落空（真机：登录页不在前台）：click 返回成功但什么都没发生 */
      clickNoop: false,
      /** 提交密码后停留在过渡态的轮询次数（真机：页面渲染有延迟） */
      passwordTransitionTicks: 0,
      /** 「选择验证方式」页点了验证器但页面没变（真机：Google 的 Material 列表项对 DOM click 不响应） */
      selectionDomClickNoop: false,
      ...opts,
    };
    this.signedInAs = opts.signedInAs ?? null;
    this.page = "blank";
    this.error = null;
    this.values = {};
    this.writes = [];
    this.typed = [];
    this.clicks = [];
    this.acts = [];
    this.navs = [];
    this.submits = [];
    this.textClicks = [];
    this.chooserUsed = false;
    this.fronted = 0;
  }
  get def() {
    return pageDef(this, this.page);
  }
  go(name) {
    this.page = name;
    this.error = null;
  }

  async navigate(url) {
    this.navs.push(url);
    const host = new URL(url).hostname;
    if (host === "myaccount.google.com") this.go(this.signedInAs ? "myaccount" : "about");
    else if (url === SIGNIN_URL) this.go(this.opts.signinPage);
    else throw new Error(`意外导航 ${url}`);
    return { success: true };
  }
  async wait() {
    // 过渡态随轮询推进：倒计时归零后渲染出真正的下一阶段
    if (this.page === "pwd_transition" && this.transitionLeft > 0) {
      this.transitionLeft -= 1;
      if (this.transitionLeft === 0) this.go(this.pendingPage);
    }
  }
  async getCurrentUrl() {
    return this.def.url;
  }
  async getPageContent() {
    return this.def.text;
  }
  async getPageHtml() {
    return `<html><body>${this.def.html ?? ""}<div>${this.def.text}</div></body></html>`;
  }
  async isVisible(sel) {
    return this.def.visible.includes(sel);
  }
  async fill(sel, value) {
    if (!this.def.visible.includes(sel)) return false;
    if (!this.opts.fillWorks) return false;
    this.writes.push([sel, value]);
    this.values[sel] = value;
    return true;
  }
  /** 按当前页面提交表单 */
  submitCurrent(via) {
    this.submits.push(`${via}:${this.page}`);
    if (this.page === "email" || this.page === "captcha") this.submitEmail();
    else if (this.page === "password") this.submitPassword();
    else if (this.page === "totp") this.submitTotp();
  }
  async click(sel) {
    // 坐标点击带标记的元素（login.ts 在 DOM 点击没效果时的兜底）
    if (sel === '[data-abb-text-hit="1"]') {
      this.clicks.push(sel);
      this.afterTextClick();
      return true;
    }
    if (!this.def.visible.includes(sel)) return false;
    this.clicks.push(sel);
    if (this.opts.clickNoop) return true;
    this.focused = sel;
    if (/Next/.test(sel)) this.submitCurrent("click");
    return true;
  }

  /**
   * 按可见文本点击（对标 StagehandGoogleEngine.clickByText）。
   * mode: prefix 要求文本以目标开头；contains 只要求包含 —— 真机那一项的文本是
   * 「Get a verification code from the …」，只有 contains 才命中。
   */
  async clickByText(text, mode = "prefix") {
    this.textClicks.push([text, mode]);
    const items = this.def.clickTexts ?? [];
    const hit = items.find((t) => (mode === "contains" ? t.includes(text) : t.startsWith(text)));
    if (!hit) return null;
    if (this.opts.selectionDomClickNoop) return { tag: "DIV", href: null };
    this.afterTextClick();
    return { tag: "DIV", href: null };
  }

  /** 点了验证器选项之后进入验证码页 */
  afterTextClick() {
    if (this.page === "selection_auth") this.go("totp");
  }
  async jsClick(sel) {
    if (!this.def.visible.includes(sel)) return false;
    if (/Next/.test(sel)) this.submitCurrent("js");
    return true;
  }
  async bringToFront() {
    this.fronted += 1;
  }
  async typeText(text) {
    this.typed.push([this.focused, text]);
    if (this.focused) {
      this.writes.push([this.focused, text]);
      this.values[this.focused] = (this.values[this.focused] ?? "") + text;
    }
    return true;
  }
  async pressKey(key) {
    if (key !== "Enter" || !this.opts.enterWorks) return false;
    this.submitCurrent("enter");
    return true;
  }
  async act(instruction) {
    this.acts.push(instruction);
    if (this.page === "chooser" && instruction.includes("使用其他账号")) this.go("email");
    return { success: true };
  }

  submitEmail() {
    // 真机形态：登出后第一次提交邮箱会被送回账号选择页（chooserAlways 用于模拟「一直不放行」）
    if (this.opts.chooserAfterEmail && (this.opts.chooserAlways || !this.chooserUsed)) {
      this.chooserUsed = true;
      return this.go("chooser");
    }
    if (this.opts.captchaAt === "email") return this.go("captcha");
    if (!this.opts.accountExists) {
      this.error = "Couldn’t find your Google Account";
      return;
    }
    this.go("password");
  }
  submitPassword() {
    if (this.values['input[name="Passwd"]'] !== PASSWORD) {
      this.error = "Wrong password. Try again or click Forgot password to reset it.";
      return;
    }
    if (this.opts.captchaAt === "password") return this.go("recaptcha");
    const f = this.opts.secondFactor;
    if (f === "none") {
      this.signedInAs = EMAIL;
      return this.go("myaccount");
    }
    // 真机：提交密码后先经过 N 次「过渡态」轮询，才渲染出下一阶段的输入框
    if (this.opts.passwordTransitionTicks > 0) {
      this.pendingPage = f;
      this.transitionLeft = this.opts.passwordTransitionTicks;
      return this.go("pwd_transition");
    }
    this.go(f);
  }
  submitTotp() {
    if (this.values["#totpPin"] !== generateTotp(SECRET, NOW)) {
      this.error = "Wrong code. Try again.";
      return;
    }
    this.signedInAs = EMAIL;
    this.go(this.opts.afterTotp);
  }
}

async function run(google, { totpSecret = SECRET, password = PASSWORD } = {}) {
  const logs = [];
  const op = new LoginOperation(google, { now: () => NOW, pollIntervalMs: 1000 });
  const result = await op.execute({ email: EMAIL, password, totpSecret, log: (m) => logs.push(m) });
  return { result, logs };
}

const passwordWrites = (g) => g.writes.filter(([sel]) => LoginSelectors.PASSWORD.includes(sel));
/** 任何日志、AI 指令都不能出现密码 */
function assertNoSecretLeak(g, logs) {
  for (const s of [...logs, ...g.acts]) {
    assert.ok(!s.includes(PASSWORD), `泄露密码: ${s}`);
    assert.ok(!s.includes(SECRET), `泄露密钥: ${s}`);
    assert.ok(!s.includes(generateTotp(SECRET, NOW)), `泄露验证码: ${s}`);
  }
}

// ==================== 成功路径 ====================

test("完整登录：输入邮箱 → 输入密码 → 提交验证器验证码 → myaccount 显示该账号", async () => {
  const g = new FakeGoogle();
  const { result, logs } = await run(g);
  assert.equal(result.success, true);
  assert.equal(result.login_state, "logged_in");
  assert.equal(result.message, "登录成功");
  const order = ["检查窗口当前登录状态", "输入邮箱", "输入密码", "提交密码", "输入验证器验证码", "提交验证器验证码", "登录成功"];
  let at = -1;
  for (const step of order) {
    const i = logs.findIndex((l, idx) => idx > at && l.includes(step));
    assert.ok(i > at, `日志缺少或顺序不对: ${step}\n${logs.join("\n")}`);
    at = i;
  }
  assert.deepEqual(g.values["#identifierId"], EMAIL);
  assert.deepEqual(g.submits, ["enter:email", "enter:password", "enter:totp"]);
  assert.ok(g.fronted >= 1, "登录页要切到前台");
  assert.deepEqual(g.acts, [], "固定元素都在，不应调用 AI");
  assertNoSecretLeak(g, logs);
});

test("坐标点击落空（真机：登录页不在前台）时改用派发点击事件，仍能完成登录", async () => {
  const g = new FakeGoogle({ enterWorks: false, clickNoop: true });
  const { result, logs } = await run(g);
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(g.submits, ["js:email", "js:password", "js:totp"]);
  assert.ok(logs.some((l) => l.includes("点击按钮提交后页面没有跳转")));
  assert.equal(passwordWrites(g).length, 1);
});

test("Enter 不可用时点击固定按钮提交", async () => {
  const g = new FakeGoogle({ enterWorks: false });
  const { result } = await run(g);
  assert.equal(result.success, true);
  assert.deepEqual(g.clicks, ["#identifierNext button", "#passwordNext button", "#totpNext button"]);
  assert.deepEqual(g.acts, []);
});

test("所有提交方式都没让页面跳转：判失败，不误报成功", async () => {
  const g = new FakeGoogle({ enterWorks: false, clickNoop: true });
  g.jsClick = async () => true; // 派发点击事件也落空
  g.act = async (instruction) => {
    g.acts.push(instruction);
    return { success: true }; // AI 声称点了，但页面没变
  };
  const { result } = await run(g);
  assert.equal(result.success, false);
  assert.equal(result.error_type, "email_submit_failed");
  assert.deepEqual(g.acts, ["点击下一步按钮"]);
});

test("密码只写入一次（fill 成功时不再 type，也不调用 AI 输入密码）", async () => {
  const g = new FakeGoogle();
  await run(g);
  const writes = passwordWrites(g);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], PASSWORD);
  assert.equal(g.typed.length, 0);
  assert.ok(!g.acts.some((a) => a.includes("密码")));
});

test("密码只写入一次（fill 失败时点击密码框后 type 一次）", async () => {
  const g = new FakeGoogle({ fillWorks: false });
  // 邮箱 fill 失败会走 AI；这里让 AI 真的填上邮箱
  g.act = async (instruction) => {
    g.acts.push(instruction);
    if (instruction.startsWith("在邮箱或电话号码输入框中输入")) g.values["#identifierId"] = EMAIL;
    if (instruction.startsWith("在验证码输入框中输入")) g.values["#totpPin"] = instruction.split(": ")[1];
    return { success: true };
  };
  const { result } = await run(g);
  const writes = passwordWrites(g);
  assert.equal(writes.length, 1, JSON.stringify(g.writes));
  assert.equal(writes[0][1], PASSWORD);
  assert.equal(result.success, true);
});

test("账号选择页：点「使用其他账号」后输入邮箱登录", async () => {
  const g = new FakeGoogle({ signinPage: "chooser" });
  const { result, logs } = await run(g);
  assert.equal(result.success, true);
  assert.deepEqual(g.acts, ["点击使用其他账号或添加其他账号"]);
  assert.ok(logs.some((l) => l.includes("输入邮箱")));
});

test("验证码之后出现通行密钥提示页（speedbump）：以 myaccount 验证为准判成功", async () => {
  const g = new FakeGoogle({ afterTotp: "speedbump" });
  const { result } = await run(g);
  assert.equal(result.success, true);
});

test("窗口已以该账号登录：直接返回，不输入任何东西", async () => {
  const g = new FakeGoogle({ signedInAs: EMAIL });
  const { result, logs } = await run(g);
  assert.equal(result.success, true);
  assert.equal(result.message, "已登录");
  assert.deepEqual(g.writes, []);
  assert.ok(!g.navs.includes(SIGNIN_URL));
  assert.ok(logs.some((l) => l.includes("已处于登录状态")));
});

test("窗口登录的是其他账号：不算已登录，继续登录目标账号", async () => {
  const g = new FakeGoogle({ signedInAs: "someone.else@gmail.com" });
  const { result, logs } = await run(g);
  assert.ok(logs.some((l) => l.includes("其他账号")));
  assert.equal(g.values["#identifierId"], EMAIL);
  assert.equal(result.success, true);
});

// ==================== 不再误判 ====================

test("不误判：登录页文本含 Use your Google Account / Create account / Choose an account 也不算已登录或成功", async () => {
  const g = new FakeGoogle({ signinPage: "dead" });
  const { result } = await run(g);
  assert.equal(result.success, false);
  assert.notEqual(result.login_state, "logged_in");
  assert.equal(result.error_type, "verification_failed");
  assert.deepEqual(g.writes, []);
});

test("不误判：checkSignedIn 只认 myaccount 域名 + 目标邮箱", async () => {
  const op = new LoginOperation(new FakeGoogle(), { now: () => NOW });
  // 未登录：myaccount 跳到 www.google.com/account/about（页面也满是 Google Account / Sign in）
  assert.deepEqual((await op.checkSignedIn(EMAIL)).signedIn, false);
  // 登录的是别人
  const other = await new LoginOperation(new FakeGoogle({ signedInAs: "x@gmail.com" })).checkSignedIn(EMAIL);
  assert.equal(other.signedIn, false);
  assert.equal(other.otherAccount, true);
});

test("不误判：登录页 / 账号选择页 / myaccount 未登录落地页的阶段识别", async () => {
  for (const [page, want] of [
    ["email", "email"],
    ["chooser", "chooser"],
    ["dead", "unknown"],
    ["about", "left_signin"],
  ]) {
    const g = new FakeGoogle();
    g.go(page);
    assert.equal(await new LoginOperation(g).detectStage(), want, page);
  }
});

test("不误判：密码提交后的过渡页不能判成「其他两步验证」（真机回归）", async () => {
  // 真机实测缺陷：提交密码后页面短暂处于「密码框已消失、TOTP 框未渲染」的中间态，
  // URL 仍是 /v3/signin/challenge/pwd。旧实现落进 /challenge/ 兜底分支返回 2fa_other，
  // 导致明明配置了 TOTP 的账号被判定为「需要其他方式的两步验证」而中止。
  const g = new FakeGoogle();
  g.go("pwd_transition");
  assert.equal(await new LoginOperation(g).detectStage(), "unknown");
});

test("真机回归：密码页过渡态后出现 TOTP，登录应当成功", async () => {
  // 走完整流程，且提交密码后先经过一次过渡态再进 TOTP 页
  const g = new FakeGoogle({ passwordTransitionTicks: 2 });
  const { result } = await run(g, {});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.login_state, "logged_in");
});

test("过渡态之后确实是短信验证时，仍要判成 need_2fa（防止修复放宽过度）", async () => {
  // 反向用例：/challenge/pwd 过渡态不再快速失败之后，必须确认「过渡完了真的是别的验证方式」
  // 这条路径没有被一并放过。
  const g = new FakeGoogle({ passwordTransitionTicks: 2, secondFactor: "sms" });
  const { result } = await run(g, {});
  assert.equal(result.success, false);
  assert.equal(result.login_state, "need_2fa");
  assert.equal(result.two_fa_method, "sms");
});

test("过渡态一直不结束时，报「提交密码后没跳转」而不是含糊的验证失败", async () => {
  // passwordTransitionTicks 大于总轮询次数 → 页面永远停在 /challenge/pwd。
  // 此时 submitAndWait 耗尽超时返回 "unknown"，必须归因到密码提交失败，
  // 否则会一路穿到最终 myaccount 验证，报一个丢失了语义的 verification_failed。
  const g = new FakeGoogle({ passwordTransitionTicks: 9999 });
  const { result } = await run(g, {});
  assert.equal(result.success, false);
  assert.equal(result.error_type, "password_submit_failed");
  assert.equal(result.login_state, "need_password");
});

// ==================== 失败路径 ====================

async function expectFail(opts, runOpts, { state, type, message }) {
  const g = new FakeGoogle(opts);
  const { result, logs } = await run(g, runOpts);
  assert.equal(result.success, false, JSON.stringify(result));
  assert.equal(result.login_state, state);
  assert.equal(result.error_type, type);
  if (message) assert.match(result.error ?? result.message ?? "", message);
  assert.ok(logs.some((l) => l.startsWith("[X]")), "失败要写日志");
  assert.ok(passwordWrites(g).length <= 1);
  assertNoSecretLeak(g, logs);
  return { g, result };
}

test("失败：密码错误", async () => {
  await expectFail({}, { password: "wrong-pass" }, { state: "wrong_password", type: "wrong_password", message: /密码错误/ });
});

test("失败：账号不存在", async () => {
  await expectFail({ accountExists: false }, {}, { state: "account_not_found", type: "account_not_found", message: /账号不存在/ });
});

test("失败：提交邮箱后出现人机验证", async () => {
  const { result } = await expectFail({ captchaAt: "email" }, {}, { state: "captcha_required", type: "captcha_required", message: /人机验证/ });
  assert.equal(result.status, "blocked");
});

test("失败：提交密码后出现 reCAPTCHA", async () => {
  await expectFail({ captchaAt: "password" }, {}, { state: "captcha_required", type: "captcha_required" });
});

test("失败：需要短信两步验证", async () => {
  const { result } = await expectFail({ secondFactor: "sms" }, {}, { state: "need_2fa", type: "need_2fa", message: /短信/ });
  assert.equal(result.two_fa_method, "sms");
});

test("失败：需要手机提示两步验证", async () => {
  await expectFail({ secondFactor: "prompt" }, {}, { state: "need_2fa", type: "need_2fa", message: /手机上确认/ });
});

test("失败：「Verify it’s you」选择页（没有验证器输入框）", async () => {
  const { result } = await expectFail({ secondFactor: "selection" }, {}, { state: "need_2fa", type: "need_2fa", message: /Verify it's you/ });
  assert.equal(result.two_fa_method, "selection");
});

test("真机回归：密码后落在「选择验证方式」页（含验证器选项）时自动选验证器并完成登录", async () => {
  const g = new FakeGoogle({ secondFactor: "selection_auth" });
  const { result, logs } = await run(g);

  assert.equal(result.success, true);
  assert.equal(result.login_state, "logged_in");
  // 必须用 contains 模式才可能命中（真机那一项的文本以「Get a verification code from the」开头）
  assert.ok(
    g.textClicks.some(([text, mode]) => mode === "contains" && text === "Google Authenticator app"),
    `应尝试用 contains 模式点验证器项，实际=${JSON.stringify(g.textClicks)}`,
  );
  assert.ok(logs.some((m) => m.includes("选择验证方式")));
  // 验证码确实被填进去了（不是只点了一下就判成功）
  assert.equal(g.values["#totpPin"], generateTotp(SECRET, NOW));
});

test("真机回归：选择验证器后页面没变时，用带标记的选择器坐标点击兜底", async () => {
  const g = new FakeGoogle({ secondFactor: "selection_auth", selectionDomClickNoop: true });
  const { result, logs } = await run(g);

  assert.equal(result.success, true);
  assert.ok(
    g.clicks.includes('[data-abb-text-hit="1"]'),
    `应回退到坐标点击，实际 clicks=${JSON.stringify(g.clicks)}`,
  );
  assert.ok(logs.some((m) => m.includes("坐标点击")));
});

test("选择页只有手机验证（点不到验证器项）时，仍然判 need_2fa", async () => {
  // 防止修复放宽过度：页面上没有验证器选项时不能假装成功
  const { result } = await expectFail(
    { secondFactor: "selection" },
    {},
    { state: "need_2fa", type: "need_2fa", message: /Verify it's you/ },
  );
  assert.equal(result.two_fa_method, "selection");
});

test("失败：遇到验证器页面但账号没有 TOTP 密钥", async () => {
  const { g } = await expectFail({}, { totpSecret: null }, { state: "need_2fa", type: "need_2fa", message: /未配置 2FA 密钥/ });
  assert.equal(g.values["#totpPin"], undefined);
});

test("失败：验证器验证码被拒绝", async () => {
  const g = new FakeGoogle();
  const { result } = await run(g, { totpSecret: "GEZDGNBVGY3TQOJQ" });
  assert.equal(result.success, false);
  assert.equal(result.error_type, "totp_failed");
  assert.match(result.error, /被拒绝/);
});

test("真机回归：登出后提交邮箱被送回账号选择页时，点「使用其他账号」重试并登录成功", async () => {
  // 真机（2026-09-24）：登出后 Google 会把账号放进选择页（显示「已退出」），
  // 第一次提交邮箱又被送回这一页；原实现会走到 myaccount 验证然后报含糊的「登录验证失败」。
  const g = new FakeGoogle({ chooserAfterEmail: true });
  const { result, logs } = await run(g);

  assert.equal(result.success, true);
  assert.equal(result.login_state, "logged_in");
  assert.ok(logs.some((m) => m.includes("检测到账号选择页")), `应处理过账号选择页，实际日志=${JSON.stringify(logs)}`);
  assert.ok(logs.some((m) => m.includes("又被送回账号选择页")));
  assert.equal(g.values['input[name="Passwd"]'], PASSWORD);
});

test("回归：账号选择页始终不放行时，给明确结论（不再报含糊的「登录验证失败」）", async () => {
  // 一直被送回选择页（第二次也不放行）：最多重试一轮，然后明确报出来
  const g = new FakeGoogle({ chooserAfterEmail: true });
  g.opts.chooserAlways = true;
  const { result } = await run(g);
  assert.equal(result.success, false);
  assert.match(result.error, /账号选择页没有放行/);
});
