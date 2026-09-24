/**
 * 修改账号密码（F1）
 *
 * 真机（2026-09-24，真实账号）实测的页面形态：
 *   1. 导航到 https://myaccount.google.com/signinoptions/password
 *   2. 会先跳「重新验证身份」，而且是**两步**：
 *      /challenge/pwd（input[name="Passwd"]）→ /challenge/totp（#totpPin）
 *      不把两步都过掉，后面就会被判成「未登录」的假失败（与「修改验证器」同一类坑）。
 *   3. 验证后回到密码页，表单是：
 *        input[name="password"]              ← 新密码
 *        input[name="confirmation_password"] ← 确认新密码
 *        <button>「更改密码」                 ← 保存（jsname 与「帮助 / 返回上一页」共用，只能按文本点）
 *      页面自己就写着「在某些设备上，您可能会被强制退出账号」——这正是本功能要付的代价。
 *
 * 安全约定（改动前先看这三条）：
 *   - 新旧密码**只经 fill() 写入**，绝不进 act() 的 AI 指令、绝不进日志；
 *   - 结果里不带新密码（由调用方持有，写本地时直接用）；
 *   - 只有确认页面出现「已更改」类字样才算成功；拿不准时报失败 ——
 *     调用方据此**不写本地**，宁可人工复核，也不能让本地密码与 Google 侧不一致。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { GoogleReauth, visibleSelector, waitUntil } from "./reauth.ts";
import { createChangePasswordResult, type ChangePasswordResult } from "../types.ts";

export interface ChangePasswordCredentials {
  /** 当前密码（重新验证身份用） */
  currentPassword: string;
  /** 当前的 TOTP 密钥（重新验证第二步用） */
  totpSecret?: string | null;
}

export interface ChangePasswordOptions extends ChangePasswordCredentials {
  /** 新密码：由调用方生成（系统自动生成强随机密码），操作只负责填进去 */
  newPassword: string;
}

/** 新密码 / 确认新密码输入框（真机实测的名字） */
const NEW_PASSWORD_SELECTORS = ['input[name="password"]', 'input[autocomplete="new-password"]'] as const;
const CONFIRM_PASSWORD_SELECTORS = [
  'input[name="confirmation_password"]',
  'input[name="confirm_password"]',
  'input[name="passwordConfirmation"]',
] as const;
/** 保存按钮的文案（真机是「更改密码」，不是「保存」） */
const SAVE_BUTTON_TEXTS = ["更改密码", "Change password", "保存", "Save"] as const;

/** 表单出现 / 提交后页面变化的等待上限 */
const FORM_TIMEOUT_MS = 15_000;
/** 提交后等待页面给出结果的上限（真机：Google 改完密码后页面变化较慢） */
const VERIFY_TIMEOUT_MS = 20_000;
/**
 * 页面出现「两次不一致」这类**动态报错**时的词表 —— 命中且**连续两轮**稳定才判失败。
 *
 * 静态提示词绝不能进这个表：真机密码表单页原文里就有「密码强度： 请至少使用 8 个字符」，
 * 而提交后第一轮检查时页面很可能还停在表单上 —— 把静态提示当拒绝，会把「还在提交中」
 * 判成「Google 拒绝了新密码」，调用方据此不写本地 → 新密码再次丢失。
 * 同理 `invalid` / `无效` 太宽泛（任何「…无效…」的提示都会命中），一律不要。
 */
const REJECT_WORDS = [
  "不一致",
  "不匹配",
  "必须匹配",
  "太短",
  "don't match",
  "do not match",
  "must match",
  "too short",
] as const;
/** 拒绝判定要求连续命中的轮数（提交后页面可能先停在仍在提交中的表单页） */
const REJECT_STABLE_ROUNDS = 2;
/**
 * 成功词表：真机确认文案是「密码已成功更改」（落在 myaccount 的 security-checkup-welcome）。
 * 注意「已成功更改」**不含**连续的「已更改」—— 少这一条就会把成功判成失败。
 */
const SUCCESS_WORDS = [
  "已成功", // 覆盖「已成功更改 / 已成功更新 / 已成功修改」等变体
  "成功更改",
  "已更改",
  "已更新",
  "修改成功",
  "密码已更新",
  "password changed",
  "password updated",
  "已保存",
] as const;
/** 兜底判据要求的页面文本长度下限（空白页 / 错误页不能当证据） */
const MIN_PAGE_TEXT_LEN = 20;
/** 兜底判据只认这个主机（真机：改成功后落在 myaccount.google.com/security-checkup-welcome） */
const MYACCOUNT_HOST = "myaccount.google.com";

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string | null;
}

export class ChangePasswordOperation {
  private readonly engine: StagehandGoogleEngine;
  /** 「重新验证身份」（共用 reauth.ts）：密码 → 验证码 两步留一轮余量；改密页多认「验证身份」；日志只记轮次与密码长度 */
  private readonly reauth: GoogleReauth;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
    this.reauth = new GoogleReauth(engine, {
      maxRounds: 3,
      extraTextPattern: /验证身份/,
      log: (msg) => this.log?.(msg),
    });
  }

  async execute(options: ChangePasswordOptions): Promise<ChangePasswordResult> {
    const start = Date.now();
    const done = (
      r: Partial<ChangePasswordResult> & { success: boolean; message: string },
    ): ChangePasswordResult =>
      createChangePasswordResult({ duration_ms: Date.now() - start, ...r });
    const log = (msg: string): void => this.log?.(msg);

    try {
      log(`打开密码设置页: ${GoogleURLs.PASSWORD}`);
      const nav = await this.engine.navigate(GoogleURLs.PASSWORD, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) return done({ success: false, message: "导航到密码设置页失败", error: nav.error ?? null });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const reauth = await this.reauth.passIfRequired({
        password: options.currentPassword,
        totpSecret: options.totpSecret ?? null,
      });
      if (reauth && !reauth.success) {
        return done({
          success: false,
          message: reauth.message ?? "重新验证身份失败",
          error: reauth.error ?? null,
          error_type: "reauth_failed",
        });
      }

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com")) {
        return done({ success: false, message: "需要先登录账号", error: "未登录", error_type: "not_logged_in" });
      }

      const filled = await this.fillNewPassword(options.newPassword);
      if (!filled.success) {
        return done({
          success: false,
          message: filled.message ?? "填写新密码失败",
          error: filled.error ?? null,
          error_type: "fill_failed",
        });
      }

      const verified = await this.verifyChanged();
      if (!verified.success) {
        return done({
          success: false,
          message: verified.message ?? "无法确认密码是否已更改",
          error: verified.error ?? null,
          error_type: "verify_failed",
        });
      }

      return done({ success: true, message: verified.message || "密码已更改", verified: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `操作失败: ${msg}`, error: msg, error_type: "exception" });
    }
  }

  /** 日志通道由调用方注入（automation 层传任务 callback） */
  private log: ((msg: string) => void) | null = null;
  setLog(fn: ((msg: string) => void) | null): void {
    this.log = fn;
  }
  // ==================== 填新密码并提交 ====================

  private async fillNewPassword(newPassword: string): Promise<StepOutcome> {
    const appeared = await waitUntil(
      this.engine,
      async () => (await visibleSelector(this.engine, NEW_PASSWORD_SELECTORS)) !== null,
      FORM_TIMEOUT_MS,
    );
    if (!appeared) return { success: false, message: "密码页没有出现新密码输入框", error: "未找到新密码输入框" };

    const newSelector = await visibleSelector(this.engine, NEW_PASSWORD_SELECTORS);
    if (!newSelector || !(await this.engine.fill(newSelector, newPassword))) {
      return { success: false, message: "新密码未能写入", error: "新密码写入失败" };
    }

    const confirmSelector = await visibleSelector(this.engine, CONFIRM_PASSWORD_SELECTORS);
    if (!confirmSelector) return { success: false, message: "找不到确认新密码输入框", error: "未找到确认输入框" };
    if (!(await this.engine.fill(confirmSelector, newPassword))) {
      return { success: false, message: "确认新密码未能写入", error: "确认密码写入失败" };
    }

    // 保存按钮只能按文本点（真机：jsname 与「帮助 / 返回上一页」共用）
    let submitted = false;
    for (const text of SAVE_BUTTON_TEXTS) {
      if (await this.engine.clickByText(text)) {
        submitted = true;
        this.log?.(`已点击「${text}」提交`);
        break;
      }
    }
    if (!submitted) {
      // 按钮找不到时退回回车提交（表单自身的 Enter 提交）
      submitted = await this.engine.pressKey("Enter");
      this.log?.(submitted ? "未找到保存按钮，改用回车提交" : "未找到「更改密码」按钮，也未能回车提交");
    }
    if (!submitted) return { success: false, message: "找不到「更改密码」按钮", error: "未找到保存按钮" };

    await this.engine.wait(8000);
    return { success: true };
  }

  /**
   * 判定 Google 侧到底改没改。
   *
   * 真机教训（2026-09-24）：上一版只认「已更改」类文案，而真机确认文案是「密码**已成功更改**」
   * （不含连续的「已更改」）→ 报「无法确认」→ 三处落点一个都没写 → 新密码丢失、
   * 账号本地凭据整体失效。现在：
   *   ① 提交后把页面文本记进日志，判断依据不靠猜；
   *   ② 词表覆盖真机文案，另有兜底判据「已离开密码页且密码表单消失」；
   *   ③ 兜底判据**取正例**：拿不到 URL / 页面文本、或不在 myaccount 主机上，一律不认成功。
   *      引擎已死（getCurrentUrl 抛错、isVisible 恒 false）、chrome-error 页、登出落地页
   *      都不能算改密成功 —— 假成功会把一个 Google 侧没生效的密码写进本地，是本功能最坏的形态；
   *   ④ 失败时把页面文本一并带回，人工一眼看出卡在哪。
   */
  private async verifyChanged(): Promise<StepOutcome> {
    interface Snap {
      /** 是否真的取到了页面（false = 引擎已死 / 导航中，任何判据都不得据此判成功） */
      ok: boolean;
      url: string;
      text: string;
    }
    const snapshot = async (): Promise<Snap> => {
      try {
        const raw = await this.engine.getPageContent();
        const url = await this.engine.getCurrentUrl();
        return { ok: Boolean(url), url, text: raw.replace(/\s+/g, " ").trim() };
      } catch (err) {
        return { ok: false, url: "", text: `(取页面文本失败: ${String(err).slice(0, 60)})` };
      }
    };
    /** 「已离开密码页」的正证据：落在 myaccount 主机、且不在密码页路径上 */
    const onMyAccount = (url: string): { ok: boolean; where: string } => {
      try {
        const u = new URL(url);
        if (u.hostname !== MYACCOUNT_HOST) return { ok: false, where: u.hostname };
        if (u.pathname.startsWith("/signinoptions/password")) return { ok: false, where: "密码页" };
        return { ok: true, where: `${u.hostname}${u.pathname}` };
      } catch {
        return { ok: false, where: "非法 URL" }; // chrome-error:// 、about:blank 等
      }
    };

    let logged = false;
    let rejectHits = 0;
    const check = async (): Promise<StepOutcome | null> => {
      const snap = await snapshot();
      if (!logged) {
        logged = true;
        this.log?.(`提交后页面: url=${snap.url} 文本(${snap.text.length} 字)="${snap.text.slice(0, 300)}"`);
      }
      const lower = snap.text.toLowerCase();
      const reject = REJECT_WORDS.find((w) => lower.includes(w.toLowerCase()));
      // 连续两轮都命中才算拒绝：提交后第一轮页面很可能还停在「仍在提交中」的表单页上
      rejectHits = reject ? rejectHits + 1 : 0;
      if (reject && rejectHits >= REJECT_STABLE_ROUNDS) {
        this.log?.(`页面出现拒绝字样「${reject}」（连续 ${rejectHits} 轮）`);
        return {
          success: false,
          message: `Google 拒绝了新密码（页面出现「${reject}」）`,
          error: `密码被拒绝: ${reject}`,
        };
      }
      const hit = SUCCESS_WORDS.find((w) => lower.includes(w.toLowerCase()));
      if (hit) return { success: true, message: `页面出现确认文案「${hit}」` };

      const where = onMyAccount(snap.url);
      if (
        snap.ok &&
        where.ok &&
        snap.text.length >= MIN_PAGE_TEXT_LEN &&
        (await visibleSelector(this.engine, NEW_PASSWORD_SELECTORS)) === null &&
        (await visibleSelector(this.engine, CONFIRM_PASSWORD_SELECTORS)) === null
      ) {
        return { success: true, message: `已离开密码页且密码表单消失（${where.where}）` };
      }
      return null;
    };

    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    for (;;) {
      const verdict = await check();
      if (verdict) {
        if (verdict.success) {
          if (verdict.message) this.log?.(verdict.message);
          return verdict;
        }
        const { url, text } = await snapshot();
        this.log?.(`判定失败: url=${url} 文本="${text.slice(0, 300)}"`);
        return {
          success: false,
          message: `${verdict.message}（提交后页面: "${text.slice(0, 120)}"）`,
          error: verdict.error ?? "失败",
        };
      }
      if (Date.now() >= deadline) {
        const { url, text } = await snapshot();
        this.log?.(`判定超时，页面仍是: url=${url} 文本="${text.slice(0, 300)}"`);
        return {
          success: false,
          message: `无法确认密码是否已更改（页面没有出现确认文案）；提交后页面: "${text.slice(0, 120)}"`,
          error: `结果不确定: ${text.slice(0, 120)}`,
        };
      }
      await this.engine.wait(1000);
    }
  }
}
