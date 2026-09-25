/**
 * 「重新验证身份」公共模块（src/engine/operations/reauth.ts）的分支用例
 *
 * 6 个 operation 的真机回归用例（test/engine-*.test.mjs）从外部覆盖了主路径；
 * 这里直接测公共模块，逐条覆盖 C4 设计里差异表的每个分支（每条都对应一次真机修复或一处合并口径）。
 * 假引擎按真机页面形态建模：/challenge/pwd → /challenge/totp → 回到设置页；时钟由 engine.wait 推进。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GoogleReauth,
  REAUTH_STEP_TIMEOUT_MS,
  visibleSelector,
  waitUntil,
} from "../src/engine/operations/reauth.ts";

const PWD = 'input[name="Passwd"]';
const PWD_NEXT = "#passwordNext button";
const TOTP = "#totpPin";
const TOTP_NEXT = "#totpNext button";
const PASSWORD = "pw-must-not-leak";
const SECRET = "JBSWY3DPEHPK3PXP";

const PAGES = {
  pwd: {
    url: "https://accounts.google.com/v3/signin/challenge/pwd",
    text: "欢迎\n如需继续操作，请先验证您的身份\n输入您的密码",
    visible: [PWD, PWD_NEXT],
  },
  totp: {
    url: "https://accounts.google.com/v3/signin/challenge/totp",
    text: "输入身份验证器生成的验证码",
    visible: [TOTP, TOTP_NEXT],
  },
  // 验证页已落地但输入框一直没渲染出来
  blank: { url: "https://accounts.google.com/v3/signin/challenge/ipp", text: "", visible: [] },
  // 登录页形态：URL 在 accounts.google.com 上，但不是验证页（用来测探测阶段的截止时间）
  signin: { url: "https://accounts.google.com/v3/signin/identifier", text: "登录 使用您的 Google 账号", visible: [] },
  // 改密页形态：URL 不是 /challenge/，只有页面文案提示要验证
  textOnly: {
    url: "https://myaccount.google.com/signinoptions/password",
    text: "为了保护您的账号，请验证身份",
    visible: [PWD, PWD_NEXT],
  },
  // 两种输入框同时可见（合并口径：验证码优先，与 5 份实现一致）
  both: {
    url: "https://accounts.google.com/v3/signin/challenge/totp",
    text: "输入身份验证器生成的验证码",
    visible: [TOTP, TOTP_NEXT, PWD, PWD_NEXT],
  },
  settings: { url: "https://myaccount.google.com/security", text: "安全性\n登录 Google 的方式", visible: [] },
};

/** 30 秒窗口的起点：保证同一轮里重新生成拿到的是同一个码 */
const WINDOW_START = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);

/**
 * 假引擎：
 *   next[页面] = 在该页提交后去哪（留在原页 = 被拒）；
 *   pressKeyOk / clickOk / jsClickOk 控制三种提交方式是否生效。
 * @param {string} start 起始页面（PAGES 的键）
 * @param {{ next?: Record<string, string>, pressKeyOk?: boolean, clickOk?: boolean, jsClickOk?: boolean, onWait?: (n: number, setState: (s: string) => void) => void, backgroundTab?: boolean }} [options]
 */
function fakeEngine(start, { next = {}, pressKeyOk = true, clickOk = true, jsClickOk = true, onWait, backgroundTab = false } = {}) {
  let clock = WINDOW_START;
  let state = start;
  let filled = false;
  /** @type {{ fill: any[], press: number, click: any[], jsClick: any[], waits: any[], act: any[], front: number }} */
  const calls = { fill: [], press: 0, click: [], jsClick: [], waits: [], act: [], front: 0 };
  let background = backgroundTab;
  const submit = (ok) => {
    if (ok && filled) {
      state = next[state] ?? state;
      filled = false;
    }
    return ok;
  };
  const engine = {
    async getCurrentUrl() {
      return PAGES[state].url;
    },
    async getPageContent() {
      return PAGES[state].text;
    },
    async isVisible(selector) {
      // 后台标签页（document.hidden）：Stagehand 的可见性检查一律判不可见（真机窗口 120）
      if (background) return false;
      return PAGES[state].visible.includes(selector);
    },
    async fill(selector, value) {
      calls.fill.push({ selector, value });
      filled = true;
      return true;
    },
    async pressKey() {
      calls.press += 1;
      return submit(pressKeyOk);
    },
    async click(selector) {
      calls.click.push(selector);
      return submit(clickOk);
    },
    async jsClick(selector) {
      calls.jsClick.push(selector);
      return submit(jsClickOk);
    },
    async wait(ms) {
      calls.waits.push(ms);
      clock += ms;
      // 让用例可以在轮询途中改页面（模拟「Google 的 302 晚一拍才落地」）
      onWait?.(calls.waits.length, (s) => (state = s));
    },
    async bringToFront() {
      calls.front += 1;
      background = false;
    },
    async act(instruction) {
      calls.act.push(instruction);
      return { success: true };
    },
  };
  return {
    engine,
    calls,
    now: () => clock,
    goto: (s) => (state = s),
    elapsed: () => clock - WINDOW_START,
  };
}

/** 把 Date.now 接到假引擎的时钟上（reauth 的超时与验证码都按它算） */
async function withClock(fake, fn) {
  const real = Date.now;
  Date.now = fake.now;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const CREDS = { password: PASSWORD, totpSecret: SECRET };

test("不是验证页：返回 null，不填任何东西", async () => {
  const fake = fakeEngine("settings");
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.equal(r, null);
  assert.deepEqual(fake.calls.fill, []);
});

test("探测阶段：页面停在非登录域名两拍即认为没有验证要求，不空等 6 秒", async () => {
  const fake = fakeEngine("settings");
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.equal(r, null);
  // 第一拍 settledTicks=1 → 等一次 500ms；第二拍 settledTicks=2 → 判定「没有验证要求」
  assert.equal(fake.calls.waits.length, 1, `等待次数 ${JSON.stringify(fake.calls.waits)}`);
  assert.equal(fake.elapsed(), 500);
});

test("探测阶段：Google 的 302 晚一拍才落地时继续轮询，验证页出现即处理", async () => {
  const fake = fakeEngine("settings", {
    next: { pwd: "settings" },
    onWait: (n, setState) => {
      if (n === 1) setState("pwd"); // 第一次等待之后才跳到 challenge 页
    },
  });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true }, "晚一拍落地的验证页必须照常处理，不能被当成「没有验证要求」");
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [PWD]);
});

test("探测阶段：URL 一直在「登录域名 / 设置页」之间跳时靠截止时间退出，不会一直轮询", async () => {
  const fake = fakeEngine("settings", {
    onWait: (n, setState) => {
      // 正常最多 ~13 次（6000 / 500 + 1）；超过就说明截止时间没生效，直接判失败而不是挂住
      if (n > 40) throw new Error("轮询没有截止时间，一直在转");
      setState(n % 2 === 1 ? "signin" : "settings");
    },
  });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.equal(r, null);
  assert.ok(fake.elapsed() >= 6000, `应等满探测上限，实际只等了 ${fake.elapsed()}ms`);
  assert.ok(fake.calls.fill.length === 0);
});

test("直接给验证码框（替换邮箱 / 踢设备真机形态）：先填验证码，不碰密码", async () => {
  const fake = fakeEngine("totp", { next: { totp: "settings" } });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true });
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [TOTP]);
  assert.match(fake.calls.fill[0].value, /^\d{6}$/);
});

test("两种输入框同时可见时先填验证码（合并口径）", async () => {
  const fake = fakeEngine("both", { next: { both: "settings" } });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true });
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [TOTP]);
});

test("只要密码（修改验证器 / 2SV 真机形态）：填密码后离开验证页即通过", async () => {
  const fake = fakeEngine("pwd", { next: { pwd: "settings" } });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true });
  assert.deepEqual(fake.calls.fill, [{ selector: PWD, value: PASSWORD }]);
});

test("密码 → 验证码（替换手机 / 改密真机形态）：出现验证码框立即进入下一轮，不空等到超时", async () => {
  const fake = fakeEngine("pwd", { next: { pwd: "totp", totp: "settings" } });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true });
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [PWD, TOTP]);
  assert.ok(
    fake.elapsed() < REAUTH_STEP_TIMEOUT_MS,
    `提交密码后空等了 ${fake.elapsed()}ms（等待记录 ${JSON.stringify(fake.calls.waits)}）`,
  );
});

test("验证一直不被接受：用完轮数后如实失败，轮间停顿 1 秒；轮数可配置（改密 3 轮）", async () => {
  for (const [maxRounds, expected] of [
    [undefined, 2],
    [3, 3],
  ]) {
    const fake = fakeEngine("totp", { next: { totp: "totp" } });
    const reauth = new GoogleReauth(fake.engine, maxRounds ? { maxRounds } : {});
    const r = await withClock(fake, () => reauth.passIfRequired(CREDS));
    assert.equal(r.success, false);
    assert.equal(r.error, "重新验证未通过");
    assert.equal(fake.calls.fill.length, expected, `maxRounds=${maxRounds}`);
    assert.ok(fake.calls.waits.includes(1000), `轮间没有停顿: ${JSON.stringify(fake.calls.waits)}`);
  }
});

test("验证页上一直没有输入框：等满一步的上限后报「未找到输入框」", async () => {
  const fake = fakeEngine("blank");
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.equal(r.success, false);
  assert.equal(r.error, "未找到输入框");
  assert.deepEqual(fake.calls.fill, []);
});

test("真机回归（2026-09-25）：验证页在后台标签页（document.hidden）时输入框判不可见 → 先切到前台再找", async () => {
  const fake = fakeEngine("pwd", { next: { pwd: "settings" }, backgroundTab: true });
  const r = await withClock(fake, () => new GoogleReauth(fake.engine).passIfRequired(CREDS));
  assert.deepEqual(r, { success: true }, "切到前台后应能找到密码框并通过");
  assert.equal(fake.calls.front, 1);
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [PWD]);
});

test("缺凭据：缺密码 / 缺密钥各自如实报错，不提交", async () => {
  const pwd = fakeEngine("pwd", { next: { pwd: "settings" } });
  const r1 = await withClock(pwd, () => new GoogleReauth(pwd.engine).passIfRequired({ totpSecret: SECRET }));
  assert.equal(r1.error, "缺少密码");
  assert.equal(pwd.calls.press, 0);

  const totp = fakeEngine("totp", { next: { totp: "settings" } });
  const r2 = await withClock(totp, () => new GoogleReauth(totp.engine).passIfRequired({ password: PASSWORD }));
  assert.equal(r2.error, "缺少 TOTP 密钥");
  assert.equal(totp.calls.press, 0);
});

test("提交顺序 Enter → 点按钮 → 派发 click：前一种没生效才用下一种", async () => {
  const enterOk = fakeEngine("pwd", { next: { pwd: "settings" } });
  await withClock(enterOk, () => new GoogleReauth(enterOk.engine).passIfRequired(CREDS));
  assert.equal(enterOk.calls.press, 1);
  assert.deepEqual(enterOk.calls.click, []);

  const clickOnly = fakeEngine("pwd", { next: { pwd: "settings" }, pressKeyOk: false });
  const r1 = await withClock(clickOnly, () => new GoogleReauth(clickOnly.engine).passIfRequired(CREDS));
  assert.deepEqual(r1, { success: true });
  assert.deepEqual(clickOnly.calls.click, [PWD_NEXT]);
  assert.deepEqual(clickOnly.calls.jsClick, []);

  const jsOnly = fakeEngine("pwd", { next: { pwd: "settings" }, pressKeyOk: false, clickOk: false });
  const r2 = await withClock(jsOnly, () => new GoogleReauth(jsOnly.engine).passIfRequired(CREDS));
  assert.deepEqual(r2, { success: true });
  assert.deepEqual(jsOnly.calls.jsClick, [PWD_NEXT]);
});

test("同一 30 秒窗口不重复提交同一个验证码（2SV 真机）：同一实例第二次遇到验证页要等到下一个窗口", async () => {
  const fake = fakeEngine("totp", { next: { totp: "settings" } });
  const reauth = new GoogleReauth(fake.engine);
  await withClock(fake, async () => {
    assert.deepEqual(await reauth.passIfRequired(CREDS), { success: true });
    fake.goto("totp"); // 核对结果时重新导航，Google 又要一次验证
    assert.deepEqual(await reauth.passIfRequired(CREDS), { success: true });
  });
  const codes = fake.calls.fill.map((f) => f.value);
  assert.equal(codes.length, 2);
  assert.notEqual(codes[0], codes[1], "第二次提交复用了同一个验证码");
  assert.ok(fake.calls.waits.some((ms) => ms >= 10_000), `没有等到下一个窗口: ${JSON.stringify(fake.calls.waits)}`);
});

test("extraTextPattern：改密页只凭文案「验证身份」认出验证页；不传时不认", async () => {
  const withExtra = fakeEngine("textOnly", { next: { textOnly: "settings" } });
  const r1 = await withClock(withExtra, () =>
    new GoogleReauth(withExtra.engine, { extraTextPattern: /验证身份/ }).passIfRequired(CREDS),
  );
  assert.deepEqual(r1, { success: true });
  assert.deepEqual(withExtra.calls.fill.map((f) => f.selector), [PWD]);

  const without = fakeEngine("textOnly", { next: { textOnly: "settings" } });
  const r2 = await withClock(without, () => new GoogleReauth(without.engine).passIfRequired(CREDS));
  assert.equal(r2, null);
  assert.deepEqual(without.calls.fill, []);
});

test("凭据只经 fill：不进 AI 指令、不进返回值；日志只有轮次与密码长度", async () => {
  const fake = fakeEngine("pwd", { next: { pwd: "totp", totp: "totp" } });
  const logs = [];
  const r = await withClock(fake, () =>
    new GoogleReauth(fake.engine, { maxRounds: 3, log: (m) => logs.push(m) }).passIfRequired(CREDS),
  );
  assert.equal(r.success, false);
  assert.deepEqual(fake.calls.act, []);
  const codes = fake.calls.fill.filter((f) => f.selector === TOTP).map((f) => f.value);
  const leaked = [PASSWORD, SECRET, ...codes];
  for (const text of [JSON.stringify(r), ...logs]) {
    for (const secret of leaked) assert.ok(!text.includes(secret), `泄露了凭据: ${text}`);
  }
  assert.ok(logs.includes(`重新验证身份（第 1 轮）：输入当前密码（长度 ${PASSWORD.length}）`), JSON.stringify(logs));
  assert.ok(logs.includes("重新验证身份（第 2 轮）：输入验证器验证码"), JSON.stringify(logs));
});

test("visibleSelector / waitUntil：取第一个可见的；条件成立立即返回，超时返回 false", async () => {
  const fake = fakeEngine("totp");
  assert.equal(await visibleSelector(fake.engine, ["#nope", TOTP_NEXT, TOTP]), TOTP_NEXT);
  assert.equal(await visibleSelector(fake.engine, ["#nope"]), null);
  await withClock(fake, async () => {
    assert.equal(await waitUntil(fake.engine, async () => true, 1000), true);
    assert.deepEqual(fake.calls.waits, []);
    assert.equal(await waitUntil(fake.engine, async () => false, 1000), false);
    assert.ok(fake.calls.waits.length >= 2);
  });
});

test("extraTextPattern 带 g 标志也能稳定命中（.test() 不记忆 lastIndex）", async () => {
  const fake = fakeEngine("textOnly", { next: { textOnly: "settings" } });
  const reauth = new GoogleReauth(fake.engine, { extraTextPattern: /验证身份/g });
  await withClock(fake, async () => {
    assert.equal(await reauth.isReauthPage(), true);
    assert.equal(await reauth.isReauthPage(), true, "第二次判定不能因为 lastIndex 变成 false");
  });
});
