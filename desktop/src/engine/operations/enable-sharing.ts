/**
 * 开启家庭共享（Node 重写）
 * 对标 core/stagehand_engine/operations/enable_sharing.py
 *
 * 流程：检查状态 → 若需建组先建 → 开共享开关 → 验证开关状态。
 * 创建流程用固定 5 次循环点确认（Google 的多步向导会连续弹若干次），
 * 任一次点击失败即中断——这是 Python 侧的收敛策略，不可改成 while(true)。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createEnableSharingResult, type EnableSharingResult } from "../types.ts";

type CheckOutcome = { already_enabled?: boolean; needs_create_family?: boolean };
type StepOutcome = { success: boolean; message?: string; error?: string | null };


export class EnableSharingOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(): Promise<EnableSharingResult> {
    const start = Date.now();
    try {
      const nav = await this.engine.navigate(GoogleURLs.GOOGLE_ONE_SETTINGS, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) {
        return createEnableSharingResult({
          success: false,
          message: "导航到设置页面失败",
          error: nav.error,
          duration_ms: Date.now() - start,
        });
      }

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return createEnableSharingResult({ success: false, message: "需要先登录账号", error: "未登录", duration_ms: Date.now() - start });
      }

      const status = await this.checkSharingStatus();

      if (status.already_enabled) {
        return createEnableSharingResult({
          success: true,
          message: "家庭共享已开启",
          was_already_enabled: true,
          sharing_enabled: true,
          duration_ms: Date.now() - start,
        });
      }

      if (status.needs_create_family) {
        const created = await this.createFamilyGroup();
        if (!created.success) {
          return createEnableSharingResult({
            success: false,
            message: "需要先创建家庭组",
            error: created.error ?? "创建家庭组失败",
            duration_ms: Date.now() - start,
          });
        }
      }

      const enabled = await this.enableSharing();
      if (enabled.success) {
        return createEnableSharingResult({
          success: true,
          message: "成功开启家庭共享",
          sharing_enabled: true,
          family_created: Boolean(status.needs_create_family),
          duration_ms: Date.now() - start,
        });
      }

      return createEnableSharingResult({
        success: false,
        message: enabled.message ?? "开启共享失败",
        error: enabled.error,
        duration_ms: Date.now() - start,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createEnableSharingResult({ success: false, message: `操作失败: ${msg}`, error: msg, duration_ms: Date.now() - start });
    }
  }

  /** 判定顺序：已开启优先于需要建组 */
  private async checkSharingStatus(): Promise<CheckOutcome> {
    try {
      const extracted = await this.engine.extract(
        `
                在当前 Google One 设置页面，检查以下状态：

                1. 共享已开启标识：
                   - "Share Google One with family" 开关显示为 ON/开启状态
                   - "与家人共享 Google One" 开关已开启
                   - "Sharing with X family members" / "正在与 X 位家庭成员共享"

                2. 需要创建家庭组标识：
                   - "Create a family group" / "创建家庭群组" 按钮
                   - "Start a family group" / "开始使用家庭" 按钮
                   - "Get started" / "开始使用" 按钮

                3. 可以开启共享标识：
                   - "Manage family settings" / "管理家庭设置"
                   - "Share Google One with family" 开关显示为 OFF/关闭状态

                返回检测到的状态。
                `,
      );
      if (!extracted.success) return {};

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      const enabledWords = ["sharing with", "正在共享", "共享中", "enabled", "已开启"];
      if (enabledWords.some((k) => text.includes(k))) return { already_enabled: true };

      const createWords = ["create a family", "创建家庭", "start a family", "get started", "开始使用"];
      if (createWords.some((k) => text.includes(k))) return { needs_create_family: true };

      return {};
    } catch {
      return {};
    }
  }

  /** 走到 People & sharing 点 Get started，随后循环点确认（最多 5 次） */
  private async createFamilyGroup(): Promise<StepOutcome> {
    try {
      await this.engine.navigate(GoogleURLs.PEOPLE_SHARING, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      await this.engine.act(
        "在 'Your family on Google' 区域点击 'Get started' 或 '开始使用' 按钮",
      );
      await this.engine.wait(3000);

      for (let i = 0; i < 5; i += 1) {
        const confirm = await this.engine.act(
          "点击 'Create a Family Group' 或 '创建家庭群组' 或 'Confirm' 或 '确认' 或 'Create' 或 '创建' 按钮",
        );
        if (!confirm.success) break;
        await this.engine.wait(2000);
      }

      // 回设置页验证建组是否生效
      await this.engine.navigate(GoogleURLs.GOOGLE_ONE_SETTINGS, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const verify = await this.engine.extract(
        "检查是否有 'Manage family settings' 或 '管理家庭设置' 或 'Share Google One' 开关",
      );
      if (verify.success && verify.data) {
        const text = String(JSON.stringify(verify.data)).toLowerCase();
        const okWords = ["manage family", "管理家庭", "share"];
        if (okWords.some((k) => text.includes(k))) return createEnableSharingResult({ success: true });
      }

      return createEnableSharingResult({ success: false, error: "创建家庭组失败" });
    } catch (err) {
      return createEnableSharingResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 展开家庭设置 → 拨开关 → 处理弹窗 → 验证 */
  private async enableSharing(): Promise<StepOutcome> {
    try {
      await this.engine.act("如果看到 'Manage family settings' 或 '管理家庭设置'，点击展开它");
      await this.engine.wait(2000);

      await this.engine.act(
        "找到 'Share Google One with family' 或 '与家人共享 Google One' 开关，如果是关闭状态就点击开启",
      );
      await this.engine.wait(1500);

      await this.engine.act(
        "如果有确认弹窗，点击 'Continue' 或 '继续' 或 'Got it' 或 '知道了' 按钮",
      );
      await this.engine.wait(1000);

      const verify = await this.engine.extract(
        `
                检查 'Share Google One with family' 开关的当前状态：
                1. 是否显示为 ON/已开启/enabled 状态
                2. 或者页面显示 'Sharing with family' / '正在与家人共享'
                `,
      );

      if (verify.success && verify.data) {
        const text = String(JSON.stringify(verify.data)).toLowerCase();
        const okWords = ["enabled", "on", "已开启", "sharing", "共享"];
        if (okWords.some((k) => text.includes(k))) return createEnableSharingResult({ success: true });
      }

      return createEnableSharingResult({ success: false, message: "开关状态验证失败" });
    } catch (err) {
      return createEnableSharingResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}