/**
 * 「重新进入」类接线（页面不能单测，这里按源码扫一遍）
 *
 * 两个入口都曾经「第一次好用、第二次失效」，而且是同一个根因的两副面孔——被外部请求/被切换的
 * 那一侧只做了「一次」初始化：
 *   1. 侧栏状态灯要求设置页打开「运行状态」标签：外壳与页面各持一份标签状态，外壳再点一次
 *      （值没变）React 直接 bail out，effect 不重跑 → 页面停在上次手点的标签，状态灯永久失效。
 *      所以外壳必须是标签的唯一持有者，页面受控。
 *   2. 账号页的两个视角（账号 / 窗口）曾经互斥挂载：切到窗口视角再切回来要重新拉 325 个窗口（约 3.5s），
 *      窗口视角的搜索 / 筛选 / 勾选也一起丢。现在两个视角都留在 DOM 里、用 display 互相隐藏（窗口视角
 *      首次进入才挂载），表体高度的 ResizeObserver 因此还要忽略隐藏期间的 0 高度测量。
 *
 * 断言只针对代码（先剥掉注释）：注释里正当地提到这些反例名字时，不该把测试弄红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../app/renderer/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
/** 剥掉块注释与行注释（保留 URL 里的 //） */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** 取一段函数体的源码：从 start 标记到其后的第一个 "};" */
function sliceFn(src, startMark) {
  const i = src.indexOf(startMark);
  assert.ok(i >= 0, `没找到 ${startMark}`);
  const end = src.indexOf("};", i);
  assert.ok(end > i, `${startMark} 后面没找到函数结尾`);
  return src.slice(i, end);
}

test("扫描本身有效（两个被扫的文件都在）", () => {
  for (const rel of ["App.tsx", "pages/SettingsPage.tsx", "pages/AccountsPage.tsx"]) {
    assert.ok(read(rel).length > 500, `${rel} 读不到内容`);
  }
});

test("设置页的标签由外壳单点持有（同值重复请求也不会被 React 丢弃）", () => {
  const settings = code(read("pages/SettingsPage.tsx"));
  // 页面自己再存一份标签 state，就会出现「外壳说 status、页面停 config」的双份状态
  assert.doesNotMatch(settings, /requestedTab/, "不应再保留一次性的 requestedTab 请求");
  assert.doesNotMatch(settings, /useState<SettingsTabKey>/, "标签不能由页面自己持有");
  assert.match(settings, /export function SettingsPage\(\{ tab, onTabChange \}/, "标签与变更回调都从 props 来");
  assert.match(settings, /activeKey=\{tab\}/, "Tabs 的选中标签必须受控于 props");
  assert.match(settings, /onTabChange\(k as SettingsTabKey\)/, "切换标签回调往外抛");
});

test("外壳的状态灯与导航共用同一份标签状态", () => {
  const app = code(read("App.tsx"));
  assert.match(app, /<SettingsPage tab=\{settingsTab\} onTabChange=\{setSettingsTab\} \/>/);
  const openStatus = sliceFn(app, "const openStatus =");
  assert.match(openStatus, /setSettingsTab\("status"\)/, "状态灯要把标签切成运行状态");
  assert.match(openStatus, /go\("settings"\)/, "状态灯还要进设置页");
});

test("账号表体高度在切换视角后重新测量", () => {
  const accounts = read("pages/AccountsPage.tsx");
  const i = accounts.indexOf("new ResizeObserver");
  assert.ok(i > 0, "没找到 ResizeObserver");
  const end = accounts.indexOf("]);", i);
  assert.ok(end > i, "没找到该 effect 的依赖数组");
  const tail = accounts.slice(i, end + 3);
  // 观测节点在两个互斥分支里，切回账号视角是新节点：依赖里少了 view 就再也不会被观测
  assert.match(tail, /\}, \[[^\]]*\bview\b[^\]]*\]\);/, "观测的 effect 必须依赖 view");
});

test("账号页两个视角都留在 DOM 里，用 display 互相隐藏（切回来不重新拉窗口列表）", () => {
  const accounts = code(read("pages/AccountsPage.tsx"));
  // 互斥挂载：切走再切回来是全新的组件实例，内部 state 与已加载的列表全丢
  assert.doesNotMatch(accounts, /\{view === "windows" \? <WindowsView/, "两个视角不能互斥挂载");
  assert.match(
    accounts,
    /const \[windowsMounted, setWindowsMounted\] = useState\(view === "windows"\)/,
    "窗口视角首次进入才挂载：启动即多拉一次窗口列表没必要",
  );
  assert.match(accounts, /if \(next === "windows"\) setWindowsMounted\(true\)/, "切到窗口视角时补挂载");
  assert.match(accounts, /\{windowsMounted && \(/, "窗口视角挂载后一直留着（用 display 隐藏）");
  assert.match(accounts, /display: view === "windows" \? "flex" : "none"/, "窗口视角靠 display 隐藏");
  assert.match(accounts, /display: view === "accounts" \? "flex" : "none"/, "账号视角靠 display 隐藏");
});

test("表体高度忽略隐藏期间的 0 高度测量（display:none 的容器量出来是 0）", () => {
  for (const rel of ["pages/AccountsPage.tsx", "pages/accounts/WindowsView.tsx"]) {
    const src = read(rel);
    const i = src.indexOf("new ResizeObserver");
    assert.ok(i > 0, `${rel} 没找到 ResizeObserver`);
    const end = src.indexOf("]);", i);
    assert.ok(end > i, `${rel} 没找到该 effect 的依赖数组`);
    const tail = src.slice(i, end + 3);
    assert.match(tail, /contentRect\.height < 1\) return;/, `${rel} 的测量必须忽略 0 高度`);
  }
});
