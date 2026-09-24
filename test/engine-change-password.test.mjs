/**
 * 修改密码 operation（F1）的真机回归用例
 *
 * 真机（2026-09-24，真实账号 arr***@gmail.com / profile 7）两轮实测：
 *   第一轮：改密**其实成功了**（用户随后确认 Google 侧密码已被改），但 op 只认「已更改」类文案，
 *   而真机确认文案是「密码**已成功更改**」（不含连续的「已更改」）→ 报「无法确认密码是否已更改」
 *   → 调用方按约定不写本地 → **新密码丢失**，数据库/备注/窗口字段全是旧密码，账号凭据整体失效。
 *   同一轮还有第二个问题：那次运行**完全没有记录提交后的页面文本**，所以事后只能靠猜。
 *   第二轮（修好判定 + 记日志后复跑）：端到端通过，并拿到真机确认页原文
 *   （url=myaccount.google.com/security-checkup-welcome…，文本=「密码已成功更改」）。
 *
 * 本文件用**真机原文**当夹具，钉住：
 *   1) 提交后必须把页面文本记进日志；
 *   2) 真机文案（「已成功更改」）必须被词表直接命中；
 *   3) 兜底判据「已离开密码页 + 表单消失」取正例，且拿不到页面/不在 myaccount 主机时
 *      **一律不认成功**（引擎已死、chrome-error 页、登出落地页都是假成功的高危形态）；
 *   4) 真机表单页的静态提示「请至少使用 8 个字符」不得被当成「Google 拒绝」；
 *   5) 失败时把页面文本一并带回，人工一眼看出卡在哪。
 *
 * 注意：本文件是 .mjs（Node 不对 .mjs 做类型剥离），**不要写 TS 类型标注**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ChangePasswordOperation } from "../src/engine/operations/change-password.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const PASSWORD_URL = GoogleURLs.PASSWORD;
/** 真机改密成功后的落地页（原文里的一段 rapt 参数） */
const SUCCESS_URL =
  "https://myaccount.google.com/security-checkup-welcome?rapt=AEjHL4P6odqOpQ8SgOIccxcClejRPtxrAj0QN1XvMO7blzogPbthMf9q7iSAOlFt_1iW1THTGoot6R5m5dfleGQX3MaVJPW6-wxMRPVLdPJkISURw8d8OOM&apc=1";
const HOME_URL = "https://myaccount.google.com/";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier?continue=abc";
/** 登出后的落地页（本仓库 login.ts 把它判为「未登录」，绝不能当改密成功） */
const LANDING_URL = "https://www.google.com/account/about/?hl=en";
const ERROR_URL = "chrome-error://chromewebdata/";

/** 真机密码表单页**原文**（去换行）。注意「请至少使用 8 个字符」是静态提示，永远在这页上 */
const FORM_TEXT =
  "跳至主要内容 账号 帮助 返回上一页 密码 请选择安全系数高的密码，并且不要将其用于其他账号。了解详情 在某些设备上，您可能会被强制退出账号。不妨详细了解您会在哪些设备上保持登录状态 新密码 visibility_off 密码强度： 请至少使用 8 个字符。请勿使用您登录其他网站的密码或容易被猜到的密码（例如您宠物的名字）。为什么？ 确认新密码 visibility_off 更改密码 隐私权条款帮助关于";
/** 真机提交后确认页**原文**（「密码已成功更改」不含连续的「已更改」） */
const SUCCESS_TEXT =
  "账号 帮助  密码已成功更改 我们会确保您的账号安全无虞 “安全检查”中的安全设置很重要，请花点时间进行检查 开始使用 Google条款和隐私权政策帮助";
const REJECT_TEXT = "密码 新密码 确认新密码 这两个密码不一致，请重试。 更改密码";
const HOME_TEXT = "管理您的 Google 账号 隐私权条款 帮助 关于";
const LANDING_TEXT = "Google 账号 登录 使用您的 Google 账号";
const ERROR_TEXT = "无法访问此网站 chromewebdata ERR_CONNECTION_RESET 请检查网络连接";
const SIGNIN_TEXT = "登录 使用您的 Google 账号 电子邮件地址或电话号码";

const NEW_PASSWORD = "New-Passw0rd-abcdef";

/**
 * 假引擎：状态机 + 调用记录。
 * afterSubmit 决定点下「更改密码」之后页面变成什么：
 *   home         —— 离开密码页、表单消失、**没有**确认文案 → 走兜底判据
 *   success_text —— 真机那种：落在 security-checkup-welcome 且有确认文案
 *   success_stay —— 有确认文案但页面**仍停在密码页**（原地 toast）
 *   stuck        —— 点了但页面完全不动（提交被静默忽略，页面停在表单页）
 *   reject       —— Google 拒绝新密码（两次不一致）
 *   signin       —— 被赶到登录页（会话失效）
 *   landing      —— 登出落地页 www.google.com/account/about
 *   error_page   —— chrome-error:// 错误页
 *   dead         —— 提交后引擎就死了（取 URL / 页面文本都抛错）
 */
function fakeEngine({ afterSubmit = "home", hasSaveButton = true } = {}) {
  const calls = { clickByText: [], pressKey: [], fill: [], navigate: [] };
  let state = "form";
  let dead = false; // 仅「提交后引擎死掉」那条用例由 submit() 置位
  const onForm = () => !dead && (state === "form" || state === "reject");
  const textOf = () => {
    switch (state) {
      case "form":
        return FORM_TEXT;
      case "reject":
        return REJECT_TEXT;
      case "success_text":
      case "success_stay":
        return SUCCESS_TEXT;
      case "signin":
        return SIGNIN_TEXT;
      case "landing":
        return LANDING_TEXT;
      case "error_page":
        return ERROR_TEXT;
      default:
        return HOME_TEXT;
    }
  };
  const urlOf = () => {
    switch (state) {
      case "form":
      case "reject":
      case "success_stay":
        return PASSWORD_URL;
      case "success_text":
        return SUCCESS_URL;
      case "signin":
        return SIGNIN_URL;
      case "landing":
        return LANDING_URL;
      case "error_page":
        return ERROR_URL;
      default:
        return HOME_URL;
    }
  };
  /** 提交动作：把页面推到 afterSubmit 指定的状态（stuck = 什么都没发生） */
  const submit = () => {
    if (state !== "form" || afterSubmit === "stuck") return;
    if (afterSubmit === "dead") {
      dead = true;
      return;
    }
    state = afterSubmit;
  };
  return {
    calls,
    engine: {
      async navigate(url) {
        calls.navigate.push(url);
        state = "form";
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        if (dead) throw new Error("Target closed");
        return urlOf();
      },
      async getPageContent() {
        if (dead) throw new Error("Target closed");
        return textOf();
      },
      async isVisible(selector) {
        if (!onForm()) return false;
        return selector === 'input[name="password"]' || selector === 'input[name="confirmation_password"]';
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        return true;
      },
      async clickByText(label) {
        calls.clickByText.push(label);
        if (state !== "form" || label !== "更改密码") return false;
        if (!hasSaveButton) return false;
        submit();
        return true;
      },
      async pressKey(key) {
        calls.pressKey.push(key);
        if (key === "Enter") submit();
        return true;
      },
      async click() {
        return true;
      },
      async jsClick() {
        return true;
      },
      async wait() {},
      async stop() {},
    },
  };
}

function runOp(fake, newPassword = NEW_PASSWORD) {
  const logs = [];
  const op = new ChangePasswordOperation(fake.engine);
  op.setLog((m) => logs.push(m));
  return op
    .execute({ currentPassword: "old-must-not-leak", totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", newPassword })
    .then((result) => ({ result, logs, fake }));
}

/**
 * 让 Date.now() 快进：否则「判定超时」用例要真的等 20 秒。
 * 用完立刻还原。注意：这是进程级全局替换，本文件用例必须**串行**（不要加 concurrency）。
 */
async function withFastClock(fn) {
  const real = Date.now;
  let now = real();
  Date.now = () => (now += 1500);
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// ==================== 真机缺陷：改成功但判定失灵 ====================

test("真机确认文案「密码已成功更改」必须被词表命中 → 判成功，且依据进结果消息", async () => {
  const { result, logs, fake } = await runOp(fakeEngine({ afterSubmit: "success_text" }));

  assert.equal(result.success, true, `应判成功，实际: ${result.message}`);
  assert.equal(result.verified, true);
  // 结果消息里必须留下判定依据（它会进任务历史，是事后唯一能复盘的东西）
  assert.match(result.message, /页面出现确认文案「已成功」/);
  // 两个密码输入框都填了同一个新密码（只走 fill，不进日志）
  assert.equal(fake.calls.fill.length, 2);
  assert.equal(fake.calls.fill[0].value, NEW_PASSWORD);
  assert.equal(fake.calls.fill[1].value, NEW_PASSWORD);
  assert.ok(!logs.join("\n").includes(NEW_PASSWORD), "日志不得出现新密码");
});

test("提交后页面文本与 url 必须进日志（真机教训：不记文本就只能靠猜）", async () => {
  const { logs } = await runOp(fakeEngine({ afterSubmit: "success_text" }));
  const submitLog = logs.find((l) => l.startsWith("提交后页面:"));
  assert.ok(submitLog, "必须有「提交后页面」这条日志");
  assert.match(submitLog, /url=https:\/\/myaccount\.google\.com\/security-checkup-welcome/);
  assert.match(submitLog, /文本\(\d+ 字\)="账号 帮助/);
});

test("确认文案换了措辞（词表不中）但已离开密码页且表单消失 → 兜底判成功", async () => {
  const { result } = await runOp(fakeEngine({ afterSubmit: "home" }));

  assert.equal(result.success, true, `应判成功，实际: ${result.message}`);
  assert.match(result.message, /已离开密码页且密码表单消失（myaccount\.google\.com\//);
});

test("确认文案出现但页面仍停在密码页（原地 toast）→ 也判成功", async () => {
  const { result } = await runOp(fakeEngine({ afterSubmit: "success_stay" }));

  assert.equal(result.success, true, `应判成功，实际: ${result.message}`);
  assert.match(result.message, /页面出现确认文案「已成功」/);
});

// ==================== 反例：不得假成功（假成功会把没生效的密码写进本地） ====================

test("提交后被赶到登录页 → 不判成功（会话失效不是改密成功）", async () => {
  const { result, logs } = await withFastClock(() => runOp(fakeEngine({ afterSubmit: "signin" })));

  assert.equal(result.success, false, "会话失效时不能报成功，否则本地会写入根本没生效的密码");
  assert.equal(result.error_type, "verify_failed");
  assert.match(result.message, /无法确认密码是否已更改/);
  assert.match(logs.join("\n"), /判定超时，页面仍是: url=https:\/\/accounts\.google\.com/);
});

test("提交后落到登出落地页（www.google.com/account/about）→ 不判成功", async () => {
  const { result } = await withFastClock(() => runOp(fakeEngine({ afterSubmit: "landing" })));

  assert.equal(result.success, false, "登出落地页不是 myaccount，绝不能当改密成功");
  assert.equal(result.error_type, "verify_failed");
});

test("提交后是 chrome-error 错误页 → 不判成功", async () => {
  const { result } = await withFastClock(() => runOp(fakeEngine({ afterSubmit: "error_page" })));

  assert.equal(result.success, false, "错误页上「表单不可见」是零信息量的，不能据此判成功");
  assert.equal(result.error_type, "verify_failed");
});

test("提交后引擎就死了（取 URL / 页面文本都抛错）→ 不判成功（fail-closed）", async () => {
  const { result } = await withFastClock(() => runOp(fakeEngine({ afterSubmit: "dead" })));

  assert.equal(result.success, false, "拿不到页面证据时必须判失败，否则会写入 Google 侧没生效的密码");
  assert.match(result.message, /无法确认密码是否已更改/);
});

// ==================== 反例：不得假失败 ====================

test("真机表单页的静态提示「请至少使用 8 个字符」不得被当成「Google 拒绝」", async () => {
  const { result } = await withFastClock(() => runOp(fakeEngine({ afterSubmit: "stuck" })));

  assert.equal(result.success, false, "提交没生效就是没生效，不能报成功");
  assert.doesNotMatch(result.message, /拒绝了新密码/, "静态提示词不能触发「拒绝」判定");
  assert.match(result.message, /无法确认密码是否已更改/);
  assert.match(result.message, /提交后页面:/, "失败消息里要带上页面文本（人工一眼看出卡在哪）");
});

test("Google 真的拒绝新密码（页面出现「不一致」且连续两轮）→ 判失败，理由带原文", async () => {
  const { result, logs } = await runOp(fakeEngine({ afterSubmit: "reject" }));

  assert.equal(result.success, false);
  assert.equal(result.error_type, "verify_failed");
  assert.match(result.message, /Google 拒绝了新密码（页面出现「不一致」）/);
  assert.match(logs.join("\n"), /页面出现拒绝字样「不一致」（连续 2 轮）/);
});

// ==================== 提交按钮 ====================

test("找不到「更改密码」按钮时退回回车提交，仍能完成判定", async () => {
  const { result, fake } = await runOp(fakeEngine({ hasSaveButton: false, afterSubmit: "success_text" }));

  assert.deepEqual(fake.calls.pressKey, ["Enter"]);
  assert.equal(result.success, true, `回车提交通路应可用，实际: ${result.message}`);
});

test("既找不到按钮、回车也无效 → 明确失败，不写本地", async () => {
  const fake = fakeEngine({ hasSaveButton: false });
  fake.engine.pressKey = async () => false;
  const logs = [];
  const op = new ChangePasswordOperation(fake.engine);
  op.setLog((m) => logs.push(m));
  const result = await op.execute({ currentPassword: "old", totpSecret: null, newPassword: NEW_PASSWORD });

  assert.equal(result.success, false);
  assert.match(result.message, /找不到「更改密码」按钮/);
});

// ==================== 「重新验证身份」接线（C4 合并后补） ====================

/**
 * 改密的「重新验证身份」夹具：真机顺序是「导航到改密页 → Google 302 到 challenge 页」，
 * 而改密页自己的 URL 不是 /challenge/，所以只能靠文案「验证身份」认出来（extraTextPattern 接线）。
 * 页面文案刻意用「请验证身份」（不含「请先验证您的身份」/「输入您的密码」），
 * 否则公共模块的默认正则就能命中，这条用例就测不到 extraTextPattern 了。
 */
function reauthEngine({ stayOnTotp = false } = {}) {
  const calls = { fill: [], pressKey: [], clickByText: [], waits: [] };
  let clock = 1_700_000_000_000;
  let state = stayOnTotp ? "reauth_totp" : "reauth";
  let filled = false;
  const onReauth = () => state === "reauth" || state === "reauth_totp";
  const textOf = () => {
    switch (state) {
      case "reauth":
        return "为了保护您的账号，请验证身份";
      case "reauth_totp":
        return "输入身份验证器生成的验证码";
      case "form":
        return FORM_TEXT;
      default:
        return SUCCESS_TEXT;
    }
  };
  const urlOf = () => {
    switch (state) {
      case "reauth":
      case "form":
        return PASSWORD_URL;
      case "reauth_totp":
        return "https://accounts.google.com/v3/signin/challenge/totp";
      default:
        return SUCCESS_URL;
    }
  };
  const submit = () => {
    if (onReauth() && filled && !stayOnTotp) state = "form";
    return true;
  };
  return {
    calls,
    now: () => clock,
    engine: {
      async navigate() {
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urlOf();
      },
      async getPageContent() {
        return textOf();
      },
      async isVisible(selector) {
        if (state === "reauth") return selector === 'input[name="Passwd"]';
        if (state === "reauth_totp") return selector === "#totpPin";
        if (state === "form")
          return selector === 'input[name="password"]' || selector === 'input[name="confirmation_password"]';
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        filled = true;
        return true;
      },
      async pressKey(key) {
        calls.pressKey.push(key);
        return key === "Enter" ? submit() : true;
      },
      async click() {
        return true;
      },
      async jsClick() {
        return true;
      },
      async clickByText(label) {
        calls.clickByText.push(label);
        if (state === "form" && label === "更改密码") {
          state = "success_text";
          return true;
        }
        return false;
      },
      async wait(ms) {
        calls.waits.push(ms);
        clock += ms;
      },
      async stop() {},
    },
  };
}

/** 假时钟：否则「验证一直不过」要真的等 8 秒 × 轮数 */
async function withFakeClock(fake, fn) {
  const real = Date.now;
  Date.now = fake.now;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("重新验证身份（改密）：只凭文案「验证身份」认出验证页，填当前密码后继续改密；日志只记密码长度", async () => {
  const fake = reauthEngine();
  const logs = [];
  const op = new ChangePasswordOperation(fake.engine);
  op.setLog((m) => logs.push(m));
  const CURRENT = "old-must-not-leak";
  const result = await op.execute({ currentPassword: CURRENT, totpSecret: null, newPassword: NEW_PASSWORD });

  assert.equal(result.success, true, `应走通改密，实际: ${result.message}`);
  // 第一次填的是当前密码（验证页），后两次是新密码 → 证明验证环节真的跑了
  assert.deepEqual(fake.calls.fill.map((f) => f.selector), [
    'input[name="Passwd"]',
    'input[name="password"]',
    'input[name="confirmation_password"]',
  ]);
  assert.equal(fake.calls.fill[0].value, CURRENT);
  // log 接线：只有长度，没有内容
  assert.ok(logs.includes(`重新验证身份（第 1 轮）：输入当前密码（长度 ${CURRENT.length}）`), JSON.stringify(logs));
  for (const line of logs) assert.ok(!line.includes(CURRENT), `日志里出现了当前密码: ${line}`);
});

test("重新验证身份（改密）：验证码一直不被接受时按 3 轮尝试（留一轮余量），失败如实上报", async () => {
  const fake = reauthEngine({ stayOnTotp: true });
  const op = new ChangePasswordOperation(fake.engine);
  const logs = [];
  op.setLog((m) => logs.push(m));
  const result = await withFakeClock(fake, () =>
    op.execute({
      currentPassword: "old",
      totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      newPassword: NEW_PASSWORD,
    }),
  );

  assert.equal(result.success, false);
  assert.equal(result.error_type, "reauth_failed");
  assert.equal(fake.calls.fill.length, 3, `改密应尝试 3 轮，实际填写 ${fake.calls.fill.length} 次`);
  assert.deepEqual(
    logs.filter((l) => l.startsWith("重新验证身份")),
    [
      "重新验证身份（第 1 轮）：输入验证器验证码",
      "重新验证身份（第 2 轮）：输入验证器验证码",
      "重新验证身份（第 3 轮）：输入验证器验证码",
    ],
  );
});
