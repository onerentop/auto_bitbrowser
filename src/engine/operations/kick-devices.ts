/**
 * 踢出设备操作
 *
 * 提示词逐字沿用调试出来的版本——改一个字都可能影响 LLM 行为。
 *
 * 真机（2026-09-24，profile 7 / 真实 Google 账号）修正的缺陷：
 *   1) 设备页会要求 Google 的「重新验证身份」（真机形态：中文 TOTP 页 /v3/signin/challenge/totp，
 *      有时是密码页）。原实现把跳转后的 accounts.google.com/.../signin/... 判成「需要先登录账号」
 *      → 假失败（账号其实已登录）。新增重新验证身份（现为 reauth.ts 公共实现，6 个操作共用），
 *      凭据只经 fill 写入、不进 AI 指令。
 *   2) 设备列表原来靠 observe 的描述文本过滤（`desc.toLowerCase().includes("device")`）。真机页面是
 *      **中文**，observe 返回的描述是「Windows 计算机上的当前会话，位于美国加利福尼亚拉蓬特，使用
 *      Google Chrome 浏览器」→ 不含 "device" → 列表恒为空 → 任务永远报「未找到其他设备」成功，
 *      实际一个都没踢（**假成功**）。改为在页面内按**结构**读会话条目（`li.K6ZZTd`，与 2SV 页同款
 *      结构），与界面语言无关；读不到就如实报「没找到设备列表」，不再靠 AI 摘要凑数。
 *   3) 踢单个设备原来无条件 `return true`（哪怕三次 act 全没生效）→ 假成功。改为：
 *      **坐标点击**该条目（真机实测 DOM click 在该页面无效）→ 复核是否进入详情页 →
 *      点「退出账号」→ 复核是否已离开详情页；任一步没做到就如实返回 false。
 *   4) 结果核对：踢完重新读一次列表页，用**会话数是否减少**定论（原来完全不核对）。
 *
 * 真机设备页结构（实测）：
 *   /myaccount.google.com/device-activity → 会话条目 `li.K6ZZTd`（当前会话的条目文本含「您的当前会话」）
 *   → 点条目进入 /device-activity/id/XXX 详情页 → 页面上有「退出账号」按钮。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createKickDevicesResult, type KickDevicesResult } from "../types.ts";
import { GoogleReauth, type ReauthCredentials } from "./reauth.ts";

/** 设备页的会话条目选择器（真机实测；选择器缺失时由 verify:selectors 检查） */
export const DEVICE_ITEM_SELECTOR = "li.K6ZZTd";
/** 会话详情页 URL 特征 */
const DEVICE_DETAIL_URL_PATTERN = /\/device-activity\/id\//;

/**
 * 当前设备的标识关键词（多语言）。
 * keep_current=true 时命中这些词的会话会被跳过。
 */
export const CURRENT_DEVICE_KEYWORDS = [
  // 中文
  "(当前会话)", "当前会话", "当前设备", "此设备",
  // 英文
  "your current session", "current session", "this device",
  // 日文
  "現在のセッション", "このデバイス",
  // 韩文
  "현재 세션", "이 기기",
  // 越南语
  "phiên hiện tại", "thiết bị này",
];

/** 会话详情页「退出账号」按钮文案（真机中文界面是「退出账号」；英文界面 Sign out） */
export const SIGN_OUT_TEXTS = ["退出账号", "退出登录", "登出", "Sign out", "Log out"];
/** 会话「已退出」的标识文案（真机：列表条目与详情页都会出现） */
export const SIGNED_OUT_WORDS = ["已退出账号", "已退出", "signed out"];

/** 一个会话条目 */
export interface DeviceSession {
  index: number;
  text: string;
  isCurrent: boolean;
  /** 该会话是否已经退出（真机：退出后条目仍留在列表里，文案变成「已退出账号」） */
  signedOut: boolean;
}

/**
 * 页面内读取会话条目的脚本：**只认结构不认文案**（真机页面是中文，
 * 若改用英文关键词过滤会得到空列表 → 假成功）。导出供单测校验。
 */
export function deviceListScript(selector: string = DEVICE_ITEM_SELECTOR): string {
  return `(() => {
    const items = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const currentWords = ${JSON.stringify(CURRENT_DEVICE_KEYWORDS)};
    const signedOutWords = ${JSON.stringify(SIGNED_OUT_WORDS)};
    return items.map((el, index) => {
      const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
      const lower = text.toLowerCase();
      return {
        index,
        text,
        isCurrent: currentWords.some((w) => lower.includes(w.toLowerCase())),
        signedOut: signedOutWords.some((w) => lower.includes(w.toLowerCase())),
      };
    });
  })()`;
}

export class KickDevicesOperation {
  private readonly engine: StagehandGoogleEngine;
  /** 「重新验证身份」（与其它 operation 共用 reauth.ts） */
  private readonly reauth: GoogleReauth;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
    this.reauth = new GoogleReauth(engine);
  }

  async execute(
    options: { keepCurrent?: boolean; credentials?: ReauthCredentials } = {},
  ): Promise<KickDevicesResult> {
    const keepCurrent = options.keepCurrent ?? true;
    const credentials = options.credentials ?? {};
    const start = Date.now();
    const kicked: string[] = [];
    const failed: string[] = [];

    const done = (r: Partial<KickDevicesResult> & { success: boolean; message: string }): KickDevicesResult =>
      createKickDevicesResult({
        kicked_devices: kicked,
        failed_devices: failed,
        duration_ms: Date.now() - start,
        ...r,
      });

    try {
      // 1. 导航到设备管理页
      const nav = await this.engine.navigate(GoogleURLs.DEVICES, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return done({ success: false, message: "导航到设备页面失败", error: nav.error });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 2. 真机：该页会要求「重新验证身份」；不处理会被下面的登录态判定误判成「未登录」
      const reauth = await this.reauth.passIfRequired(credentials);
      if (reauth && !reauth.success) {
        return done({ success: false, message: reauth.message ?? "重新验证身份失败", error: reauth.error });
      }

      // 3. 检查登录态
      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return done({ success: false, message: "需要先登录账号", error: "未登录" });
      }

      // 4. 读会话列表（按结构，与界面语言无关）
      const sessions = await this.readSessions();
      if (sessions.length === 0) {
        return done({
          success: false,
          message: "没找到设备列表",
          error: `页面上没有匹配 '${DEVICE_ITEM_SELECTOR}' 的会话条目（Google 可能改版）`,
        });
      }
      const devicesFound = sessions.length;

      // 5. 逐个踢出非当前会话。
      //    每踢一个都**重新读列表**：踢掉后条目会重新编号（沿用初始下标会越界或点错）；
      //    真机里已退出的会话**仍留在列表里**（文案变成「已退出账号」），所以按「还没退出的会话」筛。
      const targets = keepCurrent ? sessions.filter((s) => !s.isCurrent) : sessions;
      const pending = targets.filter((s) => !s.signedOut);
      if (pending.length === 0) {
        return done({
          success: true,
          message:
            targets.length === 0
              ? "没有需要踢出的设备（只有当前会话）"
              : "没有需要踢出的设备（其余会话都已退出）",
          devices_found: devicesFound,
          devices_kicked: 0,
          devices_failed: 0,
        });
      }

      for (let guard = 0; guard <= devicesFound; guard++) {
        const list = await this.readSessionsFromList();
        const next = (keepCurrent ? list.filter((s) => !s.isCurrent) : list).find((s) => !s.signedOut);
        if (!next) break;
        const ok = await this.kickSingleDevice(next);
        if (ok) {
          kicked.push(next.text);
        } else {
          failed.push(next.text);
          break; // 同一个会话踢不动就不再重复试它
        }
        await this.engine.wait(1000);
      }

      // 6. 结果核对：重新读列表，用「还没退出的非当前会话」是否清零定论
      //    （真机：会话条数不会减少，只是文案变成「已退出账号」）
      const afterList = await this.readSessionsFromList();
      const afterTargets = keepCurrent ? afterList.filter((s) => !s.isCurrent) : afterList;
      const stillPending = afterTargets.filter((s) => !s.signedOut).length;
      const reduced = pending.length - stillPending;

      if (reduced <= 0) {
        return done({
          success: false,
          message: "没能踢出任何设备",
          error: "详情页的退出入口可能已变化，或点击没有生效",
          devices_found: devicesFound,
          devices_kicked: 0,
          devices_failed: failed.length || 1,
        });
      }

      return done({
        success: true,
        message: failed.length > 0 ? `成功踢出 ${reduced} 个设备，${failed.length} 个失败` : `成功踢出 ${reduced} 个设备`,
        devices_found: devicesFound,
        devices_kicked: reduced,
        devices_failed: failed.length,
      });
    } catch (err) {
      return done({
        success: false,
        message: "踢出设备操作异常",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 读会话列表；页面内脚本失败时返回空数组（由调用方如实报「没找到设备列表」） */
  private async readSessions(): Promise<DeviceSession[]> {
    const raw = await this.engine.evaluateScript<DeviceSession[]>(deviceListScript());
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s) => s && typeof s.text === "string" && s.text.trim().length > 0)
      .map((s, i) => ({
        index: typeof s.index === "number" ? s.index : i,
        text: String(s.text),
        isCurrent: Boolean(s.isCurrent),
        signedOut: Boolean(s.signedOut),
      }));
  }

  /** 读会话列表；若当前还停在会话详情页，先回到列表页（真机：踢完可能停在详情页，直接读会得到 0 条） */
  private async readSessionsFromList(): Promise<DeviceSession[]> {
    if (await this.onDetailPage()) {
      await this.engine.navigate(GoogleURLs.DEVICES, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);
    }
    return this.readSessions();
  }

  private async onDetailPage(): Promise<boolean> {
    return DEVICE_DETAIL_URL_PATTERN.test(await this.engine.getCurrentUrl());
  }

  /**
   * 踢出单个会话：点开条目 → 详情页点「退出账号」→ 复核已离开详情页。
   * 真机实测：点条目必须用**坐标点击**（`el.click()` 派发的 DOM 点击在该页面上无效）。
   */
  private async kickSingleDevice(session: DeviceSession): Promise<boolean> {
    try {
      const selector = `${DEVICE_ITEM_SELECTOR}:nth-of-type(${session.index + 1})`;
      const clicked = await this.engine.click(selector);
      await this.engine.wait(Timeouts.AFTER_CLICK * 3);
      if (!clicked || !(await this.onDetailPage())) {
        // 退回一次 AI act（用该条目的文本描述）
        await this.engine.act(`点击设备条目「${session.text}」`);
        await this.engine.wait(Timeouts.AFTER_CLICK * 3);
      }
      if (!(await this.onDetailPage())) return false;

      // 详情页点「退出账号」——真机：这一下只弹出确认框
      if (!(await this.clickSignOut())) return false;
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // 真机确认框：「要在"Windows"上退出账号吗？ 取消 / 退出账号」——按钮文案同样是「退出账号」，
      // 所以再点一次（确定性优先），实在不行才让 AI 去点确认
      if (!(await this.detailShowsSignedOut())) {
        await this.engine.clickByText("退出账号");
        await this.engine.wait(Timeouts.AFTER_CLICK * 2);
      }
      if (!(await this.detailShowsSignedOut())) {
        await this.engine.act("如果有确认对话框，点击确认或确定按钮");
        await this.engine.wait(Timeouts.AFTER_CLICK * 3);
      }
      // 真机：退出成功后仍停在详情页（文案变成「已退出」），不能用「离开详情页」判成功
      return this.detailShowsSignedOut();
    } catch {
      return false;
    }
  }

  /** 详情页点「退出账号」：先按文本确定性点击（真机按钮文案是「退出账号」），再退回 AI act */
  private async clickSignOut(): Promise<boolean> {
    for (const text of SIGN_OUT_TEXTS) {
      if (await this.engine.clickByText(text)) return true;
      if (!(await this.onDetailPage())) return true; // 已经离开详情页，视为点到了
    }
    const res = await this.engine.act("点击'退出账号'或'退出登录'或'Sign out'按钮");
    return res.success;
  }

  /** 详情页是否已显示「已退出」（真机：退出成功后仍停在详情页，只是文案变成「已退出」） */
  private async detailShowsSignedOut(): Promise<boolean> {
    const text = await this.engine.getPageContent();
    return SIGNED_OUT_WORDS.some((w) => text.toLowerCase().includes(w.toLowerCase()));
  }
}
