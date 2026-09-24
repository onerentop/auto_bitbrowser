/**
 * StagehandGoogleEngine.clickByText / textClickScript
 *
 * 真机（2026-09-24）暴露：stagehand 的选择器引擎不支持 Playwright 的 `:has-text()` 伪类，
 * `locator(':is(a,button,[role="button"]):has-text("电话号码")').count()` 恒为 0
 * 并抛 StagehandElementNotFoundError，`click()` / `jsClick()` 只能静默返回 false。
 * 于是改为在页面内按可见文本找元素并派发 DOM 点击（真机已验证能触发 Google 条目的导航）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { StagehandGoogleEngine, textClickScript } from "../src/engine/stagehand-engine.ts";

/** 在 Node 里跑页面内脚本：注入 document / getComputedStyle 两个全局 */
function runScript(script, elements) {
  const fn = new Function(
    "document",
    "getComputedStyle",
    `return ${script}`,
  );
  const document = {
    // 脚本开头会清掉上一次的标记（按属性选择器查）；假 DOM 里返回空数组即可
    querySelectorAll: (selector) => (String(selector).includes("data-abb-text-hit") ? [] : elements),
  };
  return fn(document, (el) => el.style);
}

/** 真机（2026-09-24）这一项的完整文本，注意它是「Get a verification code from the …」开头 */
const AUTH_OPTION_TEXT = "Get a verification code from the Google Authenticator app";

test("clickByText 脚本：contains 模式能命中「Get a verification code from the Google Authenticator app」（真机登录卡在这里）", () => {
  const div = el({ tagName: "DIV", innerText: AUTH_OPTION_TEXT, children: [] });
  const li = el({ tagName: "LI", innerText: AUTH_OPTION_TEXT, children: [div] });

  // prefix（默认）模式：候选文本不以目标开头 → 找不到。真机上就是这一步返回 null，
  // 于是登录停在「选择验证方式」页，验证码根本没机会被填。
  assert.equal(runScript(textClickScript("Google Authenticator app"), [li, div]), null);

  // contains 模式：命中内层可点元素（不是外层 li）
  const hit = runScript(textClickScript("Google Authenticator app", "contains"), [li, div]);
  assert.equal(hit.tag, "DIV");
  assert.equal(div.clicked, true);
  assert.equal(li.clicked, false);
});

test("clickByText 脚本：命中的元素会被打上标记，供坐标点击兜底使用", () => {
  const div = el({ tagName: "DIV", innerText: AUTH_OPTION_TEXT });
  runScript(textClickScript("Authenticator", "contains"), [div]);
  assert.equal(div.attrs["data-abb-text-hit"], "1");
});


/** 造一个页面内元素替身 */
function el({
  tagName = "DIV",
  innerText = "",
  width = 10,
  height = 10,
  href = null,
  children = [],
  style = { visibility: "visible", display: "block" },
} = {}) {
  return {
    tagName,
    innerText,
    children,
    style,
    attrs: {},
    clicked: false,
    getBoundingClientRect: () => ({ width, height }),
    getAttribute: (name) => (name === "href" ? href : null),
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
    click() {
      this.clicked = true;
    },
  };
}

test("clickByText 脚本：多个匹配时优先点带 href 的 <a>（真机条目就是 <a href=…>）", () => {
  const div = el({ tagName: "DIV", innerText: "电话号码 07521 000100" });
  const li = el({ tagName: "LI", innerText: "电话号码 07521 000100", children: [div] });
  const anchor = el({
    tagName: "A",
    innerText: "电话号码 07521 000100",
    href: "two-step-verification/phone-numbers",
  });

  const hit = runScript(textClickScript("电话号码"), [li, div, anchor]);

  assert.deepEqual(hit, { tag: "A", href: "two-step-verification/phone-numbers" });
  assert.equal(anchor.clicked, true);
  assert.equal(li.clicked, false);
  assert.equal(div.clicked, false);
});

test("clickByText 脚本：没有 <a href> 时点 children 最少的匹配元素（文本最具体）", () => {
  const outer = el({ tagName: "LI", innerText: "添加两步验证备用电话号码", children: [1, 2, 3] });
  const inner = el({ tagName: "DIV", innerText: "添加两步验证备用电话号码", children: [] });

  const hit = runScript(textClickScript("添加两步验证备用电话号码"), [outer, inner]);

  assert.equal(hit.tag, "DIV");
  assert.equal(inner.clicked, true);
  assert.equal(outer.clicked, false);
});

test("clickByText 脚本：尺寸为 0 或隐藏的候选被过滤；全不可见时返回 null", () => {
  const hidden = el({ innerText: "电话号码", style: { visibility: "hidden", display: "block" } });
  const zero = el({ innerText: "电话号码", width: 0 });
  assert.equal(runScript(textClickScript("电话号码"), [hidden, zero]), null);
  assert.equal(hidden.clicked, false);
  assert.equal(zero.clicked, false);
});

test("clickByText 脚本：文本必须是「以目标开头」，且没有候选时返回 null", () => {
  const other = el({ innerText: "辅助电话号码已删除" });
  assert.equal(runScript(textClickScript("电话号码"), [other]), null);

  const exact = el({ tagName: "BUTTON", innerText: "下一步" });
  assert.equal(runScript(textClickScript("下一步"), [exact]).tag, "BUTTON");
  assert.equal(exact.clicked, true);
});

test("textClickScript：目标文本经 JSON 转义后嵌入（防止引号破坏脚本）", () => {
  const script = textClickScript('电话号码 "备用"');
  assert.ok(script.includes(JSON.stringify('电话号码 "备用"')));
  assert.ok(script.includes("querySelectorAll"));
});

test("clickByText：拿不到 evaluate 能力时返回 null，不抛错", async () => {
  const engine = new StagehandGoogleEngine({ ixClient: {} });
  engine.sh = {};
  engine.page = { url: () => "https://myaccount.google.com/", locator: undefined };
  assert.equal(await engine.clickByText("电话号码"), null);
});

test("clickByText：页面内点击返回 null（没找到元素）时同样返回 null", async () => {
  const engine = new StagehandGoogleEngine({ ixClient: {} });
  engine.sh = {};
  engine.page = { url: () => "https://myaccount.google.com/", evaluate: async () => null };
  assert.equal(await engine.clickByText("电话号码"), null);
});

test("clickByText：把脚本交给 page.evaluate，命中时回传 {tag, href}", async () => {
  const scripts = [];
  const engine = new StagehandGoogleEngine({ ixClient: {} });
  engine.sh = {};
  engine.page = {
    url: () => "https://myaccount.google.com/",
    evaluate: async (script) => {
      scripts.push(script);
      return { tag: "A", href: "two-step-verification/phone-numbers" };
    },
  };

  const hit = await engine.clickByText("电话号码");

  assert.deepEqual(hit, { tag: "A", href: "two-step-verification/phone-numbers" });
  assert.equal(scripts.length, 1);
  assert.ok(scripts[0].includes(JSON.stringify("电话号码")));
});

test("clickByText 脚本：先精确匹配，避免点到「保存更改」这类更长标签", () => {
  const longer = el({ tagName: "BUTTON", innerText: "保存更改" });
  const exact = el({ tagName: "BUTTON", innerText: "保存" });

  const hit = runScript(textClickScript("保存"), [longer, exact]);

  assert.equal(hit.tag, "BUTTON");
  assert.equal(exact.clicked, true);
  assert.equal(longer.clicked, false);
});

test("clickByText 脚本：正在淡出（opacity:0）或 disabled 的候选不算可点", () => {
  const fading = el({
    innerText: "保存",
    style: { visibility: "visible", display: "block", opacity: "0" },
  });
  const disabled = Object.assign(el({ tagName: "BUTTON", innerText: "保存" }), { disabled: true });

  assert.equal(runScript(textClickScript("保存"), [fading, disabled]), null);
  assert.equal(fading.clicked, false);
  assert.equal(disabled.clicked, false);
});

test("clickByText 脚本：元素自带 checkVisibility 时以它为准（能识别祖先隐藏 / 透明度）", () => {
  const clipped = Object.assign(el({ innerText: "保存" }), { checkVisibility: () => false });
  assert.equal(runScript(textClickScript("保存"), [clipped]), null);
  assert.equal(clipped.clicked, false);
});

test("clickByText 脚本：不得选中「包含其它命中元素」的祖先（点在外层上、事件不会冒泡到控件）", () => {
  const innerBtn = el({ tagName: "BUTTON", innerText: "保存", children: [null, null, null] });
  const outer = Object.assign(el({ tagName: "LI", innerText: "保存", children: [innerBtn] }), {
    contains: (o) => o === innerBtn,
  });

  const hit = runScript(textClickScript("保存"), [outer, innerBtn]);

  assert.equal(hit.tag, "BUTTON");
  assert.equal(innerBtn.clicked, true);
  assert.equal(outer.clicked, false);
});

test("clickByText：page.evaluate 抛错时返回 null（吞错分支，不把异常抛给调用方）", async () => {
  const engine = new StagehandGoogleEngine({ ixClient: {} });
  engine.sh = {};
  engine.page = {
    url: () => "https://myaccount.google.com/",
    evaluate: async () => {
      throw new Error("Execution context was destroyed");
    },
  };
  assert.equal(await engine.clickByText("保存"), null);
});
