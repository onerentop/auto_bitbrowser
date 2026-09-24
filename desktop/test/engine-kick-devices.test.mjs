/**
 * 踢出设备 operation 的真机回归用例（2026-09-24，profile 7 + 真实 Google 账号）
 *
 * 真机暴露的三个缺陷：
 *   1) 设备页会要求 Google 的「重新验证身份」（真机形态：中文 TOTP 页 /v3/signin/challenge/totp）。
 *      原实现把跳转后的 URL 判成「需要先登录账号」→ 假失败（账号其实已登录）。
 *   2) 设备列表靠 observe 的描述文本过滤 `desc.includes("device")`。真机页面是**中文**，
 *      observe 返回的描述是「Windows 计算机上的当前会话，位于美国加利福尼亚拉蓬特，使用 Google Chrome 浏览器」
 *      → 不含 "device" → 列表恒为空 → 任务永远报「未找到其他设备」成功，实际一个都没踢（**假成功**）。
 *   3) 踢单个设备无条件 return true（哪怕三次 act 全没生效）→ 假成功；且全流程不核对结果。
 *
 * 真机设备页结构（本用例据此建状态机）：
 *   - 会话条目 = li.K6ZZTd，当前会话的条目文本含「您的当前会话」；
 *   - 点条目（要**坐标点击**，DOM click 无效）→ 详情页 /device-activity/id/XXX，页面上有「退出账号」按钮；
 *   - 列表页文本里有「Windows 计算机上有 N 个会话」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { KickDevicesOperation, deviceListScript } from "../src/engine/operations/kick-devices.ts";
import { GoogleURLs } from "../src/engine/constants.ts";

const DEVICES_URL = GoogleURLs.DEVICES;
const DETAIL_URL = "https://myaccount.google.com/device-activity/id/INGj_fCot867Fw";
const REAUTH_TOTP_URL = "https://accounts.google.com/v3/signin/challenge/totp?continue=devices";
const REAUTH_PWD_URL = "https://accounts.google.com/v3/signin/challenge/pwd?continue=devices";
const SIGNIN_URL = "https://accounts.google.com/v3/signin/identifier";

const TOTP_SELECTOR = "#totpPin";
const PASSWORD_SELECTOR = 'input[name="Passwd"]';
const PASSWORD = "pw-must-not-reach-the-llm";
/** 合成测试向量（RFC 6238 样例密钥），不是任何真实账号的密钥 */
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CREDS = { password: PASSWORD, totpSecret: SECRET };

/**
 * 假引擎：按真机页面序列做状态机。
 * `signOutText` 用来制造「详情页上没有退出按钮」的场景（钉住「点不到必须如实失败」）。
 */
function fakeEngine({ needsReauth = null, signOutText = "退出账号" } = {}) {
  const calls = { navigate: [], act: [], click: [], jsClick: [], clickByText: [], fill: [] };
  const sessions = [
    { text: "Windows 美国加利福尼亚拉蓬特 Google Chrome 新 您的当前会话", signedOut: false },
    { text: "Windows 美国加利福尼亚拉蓬特 11 小时前 Google Chrome 新", signedOut: false },
    { text: "Windows 美国加利福尼亚拉蓬特 11 小时前 Google Chrome 新", signedOut: false },
  ];
  const urls = {
    devices: DEVICES_URL,
    detail: DETAIL_URL,
    reauth_totp: REAUTH_TOTP_URL,
    reauth_pwd: REAUTH_PWD_URL,
    signin: SIGNIN_URL,
  };
  let state = needsReauth ?? "devices";
  let openedIndex = null;
  let dialogOpen = false;
  let detailSignedOut = false;

  const listText = () =>
    `您的设备 您目前已在以下设备上登录 Google 账号，或过去 28 天内曾在这些设备上登录过 Google 账号。 ` +
    `可能会显示来自同一设备的多个活动会话。 Windows 计算机上有 ${sessions.length} 个会话 什么是会话？ ` +
    sessions.map((s) => (s.signedOut ? `${s.text} 上次活动时间：11 小时前 已退出账号` : s.text)).join(" ");
  const detailText = () =>
    detailSignedOut
      ? `Windows 美国加利福尼亚拉蓬特 上次活动时间：11 小时前 已退出 首次登录时间：11 小时前 没印象？ 近期活动 ` +
        `美国加利福尼亚拉蓬特 11 小时前 系统如何确定位置和时间 浏览器、应用和服务 Google Chrome`
      : `Windows 美国加利福尼亚拉蓬特 11 小时前 新 首次登录时间：11 小时前 ${signOutText} 没印象？ 近期活动 ` +
        `美国加利福尼亚拉蓬特 11 小时前 系统如何确定位置和时间 浏览器、应用和服务 Google Chrome` +
        (dialogOpen ? ` 要在"Windows"上退出账号吗？ 此操作会撤消设备对您 Google 账号的访问权限 取消 退出账号` : "");

  return {
    calls,
    sessionsLeft: () => sessions.length,
    /** 还没退出的非当前会话数（真机判据：已退出的条目仍留在列表里，数量不会减少） */
    pendingSessions: () => sessions.filter((s) => !s.signedOut && !s.text.includes("您的当前会话")).length,
    engine: {
      async navigate(url) {
        calls.navigate.push(url);
        // 导航到设备页后可能被 Google 拦到「重新验证身份」或登录页
        if (String(url).includes("device-activity")) {
          if (needsReauth === "reauth_totp") state = "reauth_totp";
          else if (needsReauth === "reauth_pwd") state = "reauth_pwd";
          else if (needsReauth === "signin") state = "signin";
          else state = "devices";
        }
        return { success: true, error: null };
      },
      async getCurrentUrl() {
        return urls[state];
      },
      async getPageContent() {
        if (state === "devices") return listText();
        if (state === "detail") return detailText();
        if (state === "reauth_totp") return "验证身份 为了确保您的账号安全，Google 希望确认是您本人在操作 从 Google 身份验证器应用获取验证码 输入验证码 下一步";
        if (state === "reauth_pwd") return "如需继续操作，请先验证您的身份 输入您的密码 下一步";
        return "登录 使用您的 Google 账号";
      },
      async isVisible(selector) {
        if (state === "reauth_totp") return selector === TOTP_SELECTOR;
        if (state === "reauth_pwd") return selector === PASSWORD_SELECTOR;
        return false;
      },
      async fill(selector, value) {
        calls.fill.push({ selector, value });
        return true;
      },
      async pressKey() {
        // 真机：TOTP / 密码页按 Enter 就能提交
        if (state === "reauth_totp" || state === "reauth_pwd") state = "devices";
        return true;
      },
      async click(selector) {
        calls.click.push(selector);
        const m = /:nth-of-type\((\d+)\)/.exec(String(selector));
        if (state === "devices" && m) {
          openedIndex = Number(m[1]) - 1;
          if (openedIndex >= sessions.length) return false;
          detailSignedOut = false; // 打开条目后详情页尚未退出
          state = "detail";
          return true;
        }
        return false;
      },
      async jsClick(selector) {
        calls.jsClick.push(selector);
        return false;
      },
      async clickByText(text) {
        calls.clickByText.push(text);
        if (state === "detail" && text === signOutText) {
          // 真机：第一次点「退出账号」先弹确认框，再点一次才真的退出；
          // 退出后会话变成「已退出账号」留在列表里（不会消失）
          if (!dialogOpen) {
            dialogOpen = true;
            return { tag: "BUTTON", href: null };
          }
          if (openedIndex !== null) sessions[openedIndex].signedOut = true;
          dialogOpen = false;
          openedIndex = null;
          detailSignedOut = true; // 真机：退出后仍停在详情页，只是文案变成「已退出」
          state = "detail";
          return { tag: "BUTTON", href: null };
        }
        return null;
      },
      async wait() {},
      async act(instruction) {
        calls.act.push(instruction);
        return { success: true };
      },
      async observe() {
        // 真机返回的是中文描述，不含 "device"
        return {
          success: true,
          data: [
            {
              description: "Windows 计算机上的当前会话，位于美国加利福尼亚拉蓬特，使用 Google Chrome 浏览器",
              method: "click",
            },
          ],
        };
      },
      async extract() {
        return { success: true, data: { devices: [] } };
      },
      async evaluateScript(script) {
        // 设备列表脚本按结构读条目（真机：li.K6ZZTd）；「已退出」的会话仍留在列表里
        if (state === "devices" && String(script).includes("K6ZZTd")) {
          return sessions.map((s, index) => ({
            index,
            text: s.signedOut ? `${s.text} 上次活动时间：11 小时前 已退出账号` : s.text,
            isCurrent: s.text.includes("您的当前会话"),
            signedOut: Boolean(s.signedOut),
          }));
        }
        return [];
      },
    },
  };
}

test("回归（真机 2026-09-24）：中文设备页必须列出会话并真的踢掉——旧实现按英文 'device' 过滤 → 假成功「未找到其他设备」", async () => {
  const { engine, calls, pendingSessions, sessionsLeft } = fakeEngine();
  const result = await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.equal(result.success, true, result.message);
  assert.equal(result.devices_found, 3, `应发现 3 个会话: ${JSON.stringify(result)}`);
  assert.equal(result.devices_kicked, 2, `应踢掉 2 个非当前会话: ${JSON.stringify(result)}`);
  assert.equal(pendingSessions(), 0, "两个非当前会话都应变成「已退出账号」");
  assert.equal(sessionsLeft(), 3, "真机：已退出的会话仍留在列表里，不会消失");

  // 两个非当前会话都要被点开（坐标点击第 2、3 个条目）
  const openedIndexes = calls.click
    .map((s) => /:nth-of-type\((\d+)\)/.exec(String(s)))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  // 真机：已退出的会话仍占位在列表里，所以第二个目标会落在下标 3：
  //   [当前, A, B] --点第 2 个--> A 退出 --> [当前, A(已退出), B] --点第 3 个--> B 退出
  assert.deepEqual(openedIndexes, [2, 3], `应依次点开第 2、3 个条目: ${JSON.stringify(calls.click)}`);
  // 每个会话要点两次「退出账号」：第一次点详情页按钮（真机会弹出确认框），第二次点确认框里的同名按钮
  assert.equal(
    calls.clickByText.filter((t) => t === "退出账号").length,
    4,
    `每个会话都要点「退出账号」（含确认框）: ${JSON.stringify(calls.clickByText)}`,
  );
  // 不得把当前会话也踢掉
  assert.ok(
    !calls.click.some((s) => /:nth-of-type\(1\)/.test(String(s))),
    `不应点第 1 个（当前会话）: ${JSON.stringify(calls.click)}`,
  );
});

test("回归（真机 2026-09-24）：设备页要求重新验证身份（TOTP）时先完成验证，而不是判「需要先登录账号」", async () => {
  const { engine, calls } = fakeEngine({ needsReauth: "reauth_totp" });
  const result = await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.ok(!result.message.includes("需要先登录账号"), result.message);
  assert.equal(calls.fill.filter((f) => f.selector === TOTP_SELECTOR).length, 1, "应写入一次验证码");
  assert.match(calls.fill[0].value, /^\d{6}$/);
  assert.equal(result.devices_kicked, 2, `验证通过后应继续踢设备: ${JSON.stringify(result)}`);

  // 凭据只经 fill 写入：AI 指令里不能出现密码
  for (const instruction of calls.act) {
    assert.ok(!instruction.includes(PASSWORD), `AI 指令里出现了密码: ${instruction}`);
  }
});

test("回归（真机 2026-09-24）：密码形式的重新验证同样要处理", async () => {
  const { engine, calls } = fakeEngine({ needsReauth: "reauth_pwd" });
  const result = await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.ok(!result.message.includes("需要先登录账号"), result.message);
  assert.equal(calls.fill.filter((f) => f.selector === PASSWORD_SELECTOR).length, 1);
  assert.equal(calls.fill[0].value, PASSWORD);
  assert.equal(result.devices_kicked, 2, JSON.stringify(result));
});

test("回归（真机 2026-09-24）：详情页点不到「退出账号」时必须如实失败，不能报成功", async () => {
  // 详情页上根本没有「退出账号」按钮（模拟 Google 改版 / 文案变化）
  const { engine, pendingSessions } = fakeEngine({ signOutText: "另外的文案" });
  const result = await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.equal(result.success, false, `点了退不出就应如实失败: ${JSON.stringify(result)}`);
  assert.equal(result.devices_kicked, 0, JSON.stringify(result));
  assert.equal(pendingSessions(), 2, "两个非当前会话都没退出，不能报成功");
});

test("确实未登录时仍报「需要先登录账号」（没有把登录态判定放宽）", async () => {
  const { engine } = fakeEngine({ needsReauth: "signin" });
  const result = await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.equal(result.success, false);
  assert.equal(result.message, "需要先登录账号");
});

test("地址沿用真机有效的 GoogleURLs.DEVICES", async () => {
  const { engine, calls } = fakeEngine();
  await new KickDevicesOperation(engine).execute({ credentials: CREDS });

  assert.equal(calls.navigate[0], DEVICES_URL);
  assert.equal(DEVICES_URL, "https://myaccount.google.com/device-activity");
});

/** 在 Node 里跑页面内脚本：注入 document */
function runScript(script, elements) {
  const fn = new Function("document", `return ${script}`);
  return fn({ querySelectorAll: () => elements });
}

const item = (innerText) => ({ innerText });

test("deviceListScript：按结构读条目 + 按「当前会话」关键词标记（真机是中文页面）", () => {
  const items = [
    item("Windows 美国加利福尼亚拉蓬特 Google Chrome 新 您的当前会话"),
    item("Windows 美国加利福尼亚拉蓬特 11 小时前 Google Chrome 新"),
  ];
  const res = runScript(deviceListScript(), items);

  assert.deepEqual(
    res.map((r) => r.isCurrent),
    [true, false],
  );
  assert.deepEqual(
    res.map((r) => r.index),
    [0, 1],
  );
});

test("deviceListScript：英文页面的「Your current session」同样识别", () => {
  const items = [item("Windows · Your current session"), item("Windows · 11 hours ago")];
  const res = runScript(deviceListScript(), items);
  assert.deepEqual(
    res.map((r) => r.isCurrent),
    [true, false],
  );
});

test("deviceListScript：条目文本把连续空白压成单空格", () => {
  const res = runScript(deviceListScript(), [item("  Windows\n\n  11 小时前  ")]);
  assert.equal(res[0].text, "Windows 11 小时前");
});

test("deviceListScript：选择器经 JSON 转义嵌入（防止引号破坏脚本）", () => {
  assert.ok(deviceListScript().includes(JSON.stringify("li.K6ZZTd")));
  assert.ok(deviceListScript().includes("querySelectorAll"));
});
