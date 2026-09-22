/**
 * OAuth 授权（Node 重写）
 * 对标 core/stagehand_engine/operations/oauth.py
 *
 * 流程：导航到授权 URL → 若非 Google 域则点「Sign in with Google」→
 *       处理账号选择 → 进入 Google 同意页 → 最多点 3 次「允许」→ 验证。
 *
 * 本操作的健壮性设计（照搬 Python）：
 * 每个关键节点都先用 _isValidUrl 检查页面有效性。OAuth 跳转链中
 * 页面可能短暂处于 about:blank / chrome-error://，此时任何 act/extract
 * 都会失败，所以宁可提前返回明确原因，也不要盲点。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createOAuthResult, type OAuthResult } from "../types.ts";

/** 默认授权 URL，可在构造时覆盖（对应 Python 从 ConfigManager 读取） */
export const DEFAULT_OAUTH_URLS: Record<string, string> = {
  antigravity: GoogleURLs.ANTIGRAVITY_OAUTH,
  sub2api: "https://api.sub2api.com/oauth/google",
};

/** 无法执行操作的页面前缀 */
const INVALID_URL_PREFIXES = [
  "about:blank",
  "about:srcdoc",
  "chrome://",
  "chrome-error://",
  "data:",
];

/** 检查 URL 是否可用于操作 */
export function isValidUrl(url: string): boolean {
  if (!url) return false;
  return !INVALID_URL_PREFIXES.some((p) => url.startsWith(p));
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string;
  redirect_url?: string;
}

export class OAuthOperation {
  private readonly engine: StagehandGoogleEngine;
  private readonly oauthUrls: Record<string, string>;

  constructor(engine: StagehandGoogleEngine, oauthUrls?: Record<string, string>) {
    this.engine = engine;
    this.oauthUrls = { ...DEFAULT_OAUTH_URLS, ...(oauthUrls ?? {}) };
  }

  async execute(service: string, oauthUrl?: string | null): Promise<OAuthResult> {
    const start = Date.now();
    const done = (r: Partial<OAuthResult> & { success: boolean; message: string }): OAuthResult =>
      createOAuthResult({ service, duration_ms: Date.now() - start, ...r });

    const targetUrl = oauthUrl || this.oauthUrls[service];
    if (!targetUrl) {
      return done({
        success: false,
        message: `未知的服务: ${service}`,
        error: "请提供 oauth_url 参数",
      });
    }

    try {
      const nav = await this.engine.navigate(targetUrl, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return done({ success: false, message: "导航到 OAuth 页面失败", error: nav.error });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const result = await this.performOauth();
      if (result.success) {
        return done({
          success: true,
          message: "OAuth 授权成功",
          redirect_url: result.redirect_url ?? null,
        });
      }
      return done({
        success: false,
        message: result.message ?? "授权失败",
        error: result.error,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `操作失败: ${msg}`, error: msg });
    }
  }

  private async performOauth(): Promise<StepOutcome> {
    try {
      let url = await this.engine.getCurrentUrl();
      if (!isValidUrl(url)) {
        return { success: false, message: `页面 URL 无效: ${url}` };
      }

      // 已经在 Google 授权域，直接处理同意页
      if (url.includes("accounts.google.com")) {
        return await this.handleGoogleConsent();
      }

      // 在第三方页面：点 Google 登录入口
      await this.engine.act("点击 'Sign in with Google' 或 '使用 Google 登录' 或 Google 图标按钮");
      await this.engine.wait(3000);

      url = await this.engine.getCurrentUrl();
      if (!isValidUrl(url)) {
        return { success: false, message: `跳转后页面无效: ${url}` };
      }
      if (url.includes("accounts.google.com")) {
        return await this.handleGoogleConsent();
      }

      // 可能要先选账号
      await this.handleAccountChooser();

      url = await this.engine.getCurrentUrl();
      if (!isValidUrl(url)) {
        return { success: false, message: `账号选择后页面无效: ${url}` };
      }
      if (url.includes("accounts.google.com")) {
        return await this.handleGoogleConsent();
      }

      return { success: false, message: "未能进入 Google 授权页面" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg };
    }
  }

  /** 点第一个账号即可；失败不阻断（后续会再判一次 URL） */
  private async handleAccountChooser(): Promise<void> {
    try {
      const observed = await this.engine.observe(
        `
                检查是否有账号选择页面：
                1. "Choose an account" 或 "选择账号"
                2. 邮箱列表
                3. "Use another account" 或 "使用其他账号"
                `,
      );
      if (observed.success && (observed.data ?? []).length > 0) {
        await this.engine.act("点击列表中的第一个账号");
        await this.engine.wait(2000);
      }
    } catch {
      /* 账号选择器不存在是正常情况 */
    }
  }

  /**
   * 同意页最多点 3 次「允许」（OAuth 可能有多步确认）。
   * 每轮先判页面有效性，再看是否已重定向离开 Google 域——
   * 离开即视为授权完成，这是本操作判定成功的主要依据。
   */
  private async handleGoogleConsent(): Promise<StepOutcome> {
    try {
      let url = await this.engine.getCurrentUrl();
      if (!isValidUrl(url)) {
        return { success: false, message: `授权页面无效: ${url}` };
      }

      for (let i = 0; i < 3; i += 1) {
        url = await this.engine.getCurrentUrl();
        if (!isValidUrl(url)) {
          return { success: false, message: `授权过程中页面变为无效: ${url}` };
        }

        if (!url.includes("accounts.google.com")) {
          return { success: true, redirect_url: url };
        }

        const click = await this.engine.act(
          "点击 'Allow' 或 '允许' 或 'Continue' 或 '继续' 或 'Confirm' 或 '确认' 按钮",
        );
        void click; // 点击失败不中断，下一轮会重新判 URL

        await this.engine.wait(2000);
      }

      return await this.verifyOauth();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg };
    }
  }

  private async verifyOauth(): Promise<StepOutcome> {
    try {
      const url = await this.engine.getCurrentUrl();
      if (!isValidUrl(url)) {
        return { success: false, message: `验证时页面无效: ${url}` };
      }

      // 已离开 Google 域 → 视为成功
      if (!url.includes("accounts.google.com")) {
        return { success: true, redirect_url: url };
      }

      const extracted = await this.engine.extract(
        `
                检查页面状态：
                1. "Authorization successful" 或 "授权成功"
                2. "Error" 或 "错误"
                3. "Access denied" 或 "访问被拒绝"
                `,
      );

      // extract 失败不等于授权失败，可能只是页面状态不稳
      if (!extracted.success) {
        return { success: false, message: `无法验证授权结果: ${extracted.error ?? ""}` };
      }

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      if (text.includes("successful") || text.includes("成功")) return { success: true };

      if (
        text.includes("error") ||
        text.includes("错误") ||
        text.includes("denied") ||
        text.includes("拒绝")
      ) {
        return { success: false, message: "授权被拒绝", error: "访问被拒绝" };
      }

      return { success: false, message: "无法确定授权结果" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}