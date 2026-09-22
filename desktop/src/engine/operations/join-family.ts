/**
 * 加入家庭组（Node 重写）
 * 对标 core/stagehand_engine/operations/join_family.py
 *
 * 流程：进 Gmail → 清弹窗 → 找邀请邮件 → 点接受 → 循环点加入 → 验证。
 * 前提是邀请人已发过邀请，本操作只负责被邀请人侧接受。
 *
 * 两个固定次数循环不可改成"有就点"式无限循环：
 *   - Gmail 弹窗最多清 8 轮（Python 的 popup_attempts）
 *   - 接受邀请后最多点 3 次加入按钮（多步确认页）
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createJoinFamilyResult, type JoinFamilyResult } from "../types.ts";

/** 内部步骤的返回结构，对应 Python 的 dict */
interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string;
  error_type?: string;
}

export class JoinFamilyOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(inviterEmail: string): Promise<JoinFamilyResult> {
    const start = Date.now();
    const base = { inviter_email: inviterEmail, duration_ms: 0 };
    const done = (r: Partial<JoinFamilyResult> & { success: boolean; message: string }): JoinFamilyResult =>
      createJoinFamilyResult({ ...base, duration_ms: Date.now() - start, ...r });

    try {
      // 1. 导航到 Gmail
      const nav = await this.engine.navigate(GoogleURLs.GMAIL, { timeoutMs: Timeouts.NAVIGATION });
      if (!nav.success) {
        return done({ success: false, message: "导航到 Gmail 失败", error: nav.error });
      }
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      // 2. 清掉 Gmail 首次访问的引导弹窗
      await this.handleGmailPopups();

      // 3. 找邀请邮件
      const found = await this.findInviteEmail(inviterEmail);
      if (!found.success) {
        return done({
          success: false,
          message: "未找到家庭邀请邮件",
          error: "请确保邀请人已发送邀请",
        });
      }

      // 4. 接受邀请
      const accepted = await this.acceptInvite();
      if (!accepted.success) {
        if (accepted.error_type === "already_in_family") {
          return done({
            success: false,
            message: "已在其他家庭组中",
            error: "被邀请人已加入其他家庭组",
            already_in_family: true,
          });
        }
        return done({
          success: false,
          message: accepted.message ?? "接受邀请失败",
          error: accepted.error,
        });
      }

      // 5. 验证
      const verified = await this.verifyJoin();
      if (verified.success) {
        return done({ success: true, message: "成功加入家庭组" });
      }

      return done({ success: false, message: "无法确认加入结果" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return done({ success: false, message: `操作失败: ${msg}`, error: msg });
    }
  }

  /**
   * 反复清 Gmail 引导弹窗。
   * 每轮先看是否已进收件箱（是则直接返回），否则点一次弹窗按钮。
   * observe 失败或无候选元素即认为没有弹窗，退出。
   */
  private async handleGmailPopups(): Promise<void> {
    const popupAttempts = 8;

    for (let i = 0; i < popupAttempts; i += 1) {
      const observed = await this.engine.observe(
        `
                检查是否有以下弹窗：
                1. "Turn on smart features" → 查找 "Next" 按钮
                2. "Smart features in Google Workspace" → 查找 "Next" 按钮
                3. "Smart features in other Google products" → 查找 "Save" 按钮
                4. "Reload" 提示 → 查找 "Reload" 按钮
                5. "Get started with Gmail" → 查找关闭按钮（X）或 "Got it" 按钮
                6. "Enable desktop notifications" → 查找 "No thanks" 按钮

                也检测是否已显示收件箱：
                7. "Inbox" 或 "收件箱" 标签
                `,
      );

      if (!observed.success || (observed.data ?? []).length === 0) break;

      // 已进收件箱就不用再点
      for (const action of observed.data ?? []) {
        if (action && typeof action === "object") {
          const desc = String((action as { description?: string }).description ?? "").toLowerCase();
          if (desc.includes("inbox") || desc.includes("收件箱")) return;
        }
      }

      await this.engine.act(
        "点击弹窗中的 'Next', 'Save', 'Got it', 'No thanks', 'Reload', 或关闭按钮",
      );
      await this.engine.wait(1500);
    }
  }

  /** 在收件箱定位家庭邀请邮件；首轮没看到候选就先刷新一次再找 */
  private async findInviteEmail(inviterEmail: string): Promise<StepOutcome> {
    try {
      await this.engine.wait(2000);

      let observed = await this.engine.observe(
        `
                在 Gmail 收件箱中查找家庭邀请邮件：
                1. 来自 "Google" 或 "no-reply@google.com" 的邮件
                2. 主题包含 "family" 或 "家庭" 或 "invitation" 或 "邀请"
                3. 主题包含 "join" 或 "加入" 或 "Google One"
                4. 邮件内容预览包含 "family group" 或 "家庭群组"
                `,
      );

      if (!observed.success || (observed.data ?? []).length === 0) {
        await this.engine.navigate(GoogleURLs.GMAIL);
        await this.engine.wait(3000);
        observed = await this.engine.observe("查找来自 Google 的家庭邀请邮件");
      }

      if (observed.success && (observed.data ?? []).length > 0) {
        await this.engine.act("点击家庭邀请邮件打开它");
        await this.engine.wait(3000);
        return { success: true };
      }

      void inviterEmail; // Python 侧该参数未参与筛选，仅用于日志
      return { success: false };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 打开邮件后点接受，并在确认页最多点 3 次加入按钮。
   * 每轮先查是否出现「已在家庭组」错误——这个要立刻返回，不能继续点。
   */
  private async acceptInvite(): Promise<StepOutcome> {
    try {
      const observed = await this.engine.observe(
        `
                在邮件内容中查找接受邀请的链接或按钮：
                1. "Accept invitation" 按钮/链接
                2. "接受邀请" 按钮/链接
                3. "Join family" 链接
                4. "加入家庭" 链接
                5. "Join now" 按钮
                6. "立即加入" 按钮
                `,
      );

      if (!observed.success || (observed.data ?? []).length === 0) {
        return { success: false, message: "邮件中未找到接受邀请链接" };
      }

      await this.engine.act("点击 'Accept invitation' 或 '接受邀请' 或 'Join' 链接");
      await this.engine.wait(5000);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const check = await this.engine.extract(
          `
                    检查页面是否显示：
                    1. "You're already in a family group" 错误
                    2. "已在家庭组中" 或 "只能加入一个家庭" 错误
                    3. "Join Family Group" 确认按钮
                    4. "加入家庭群组" 确认按钮
                    5. 成功加入的提示
                    `,
        );

        if (check.success && check.data) {
          const text = String(JSON.stringify(check.data)).toLowerCase();
          if (text.includes("already in") || text.includes("已在家庭组")) {
            return { success: false, error_type: "already_in_family", message: "已在其他家庭组中" };
          }
        }

        await this.engine.act("点击 'Join Family Group' 或 '加入家庭群组' 或 'Join' 或 '加入' 按钮");
        await this.engine.wait(3000);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async verifyJoin(): Promise<StepOutcome> {
    try {
      const extracted = await this.engine.extract(
        `
                检查页面是否显示成功加入家庭组的标志：
                1. "Welcome to the family" 文本
                2. "You joined" 或 "已加入" 文本
                3. "Success" 或 "成功" 提示
                4. 家庭成员页面（显示其他成员头像）

                也检测可能的错误：
                5. "already in a family" 或 "已在家庭组" 错误
                `,
      );

      if (!extracted.success) return { success: false };

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      const okWords = ["welcome", "欢迎", "joined", "已加入", "success", "成功"];
      if (okWords.some((k) => text.includes(k))) return { success: true };

      if (text.includes("already in") || text.includes("已在")) {
        return { success: false, error_type: "already_in_family" };
      }

      return { success: false };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}