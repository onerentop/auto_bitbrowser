/**
 * BrowserUse Engine - 加入家庭组操作（Node 重写）
 * 对标 core/browseruse_engine/operations/join_family.py
 *
 * 接受家庭组邀请并加入，以及发送家庭邀请。
 *
 * 移植说明：
 *   - 4 段 Agent task 提示词**逐字照搬**（含标点、引号内的中英文示例、步骤编号）。
 *     f-string 里的 `{invitee_email}` 保留成模板占位符，由 buildXxxTask() 替换，
 *     这样 scripts/verify-prompts.mjs 能直接与 Python 原文比对。
 *   - 操作只依赖引擎的 5 个能力（navigate/wait/run/getPageContent/getCurrentUrl），
 *     因此这里声明最小接口 JoinFamilyEngine，而不是 import engine.ts —— 避免循环依赖，
 *     也让单测能用假引擎离线跑。
 *   - Python 的 `time.time()*1000` → Node 的 `Date.now()`。
 */
import {
  ALREADY_IN_FAMILY_KEYWORDS,
  CREATE_FAMILY_KEYWORDS,
  CREATE_FAMILY_MAX_STEPS,
  FAMILY_DETAILS_URL,
  FAMILY_FULL_KEYWORDS,
  FAMILY_INVITE_URL,
  FAMILY_MEMBERS_KEYWORDS,
  GMAIL_POPUP_MAX_STEPS,
  GMAIL_URL,
  INVITE_SENT_KEYWORDS,
  JOIN_FAMILY_DEFAULT_TIMEOUT_MS,
  JOIN_FAMILY_NAV_TIMEOUT_MS,
  JOIN_FAMILY_WAIT_AFTER_GMAIL_MS,
  JOIN_FAMILY_WAIT_AFTER_NAV_MS,
  JOIN_SUCCESS_KEYWORDS,
  matchesAnyKeyword,
  ACCEPT_INVITE_MAX_STEPS,
  SEND_INVITE_MAX_STEPS,
} from "../constants.ts";
import { createJoinFamilyResult, type JoinFamilyResult } from "../types.ts";
import type { AgentResult, NavigationResult } from "../protocol.ts";
import { noopLog, type LogFn } from "../page.ts";

/** 本操作用到的引擎能力（BrowserUseEngine 的子集） */
export interface JoinFamilyEngine {
  navigate(url: string, options?: { waitUntil?: string; timeoutMs?: number }): Promise<NavigationResult>;
  wait(milliseconds: number): Promise<void>;
  run(task: string, options?: { maxSteps?: number }): Promise<AgentResult>;
  getPageContent(): Promise<string>;
  getCurrentUrl(): Promise<string>;
}

// ==================== Agent 提示词（与 Python 逐字一致） ====================

/** send_invite 的 task —— join_family.py L98-107，`{invitee_email}` 为占位符 */
export const SEND_INVITE_TASK_TEMPLATE = `
                在当前家庭邀请页面完成以下操作：
                1. 找到邮箱输入框（通常有 placeholder 如 "Enter email" 或 "输入电子邮件"）
                2. 在输入框中输入邮箱地址: {invitee_email}
                3. 点击 "Send" 或 "发送" 或 "Invite" 或 "邀请" 按钮

                如果看到确认对话框，点击确认按钮。
                如果看到成功消息如 "Invitation sent"，任务完成。
                如果看到错误消息如 "already in family" 或 "已在家庭组"，报告错误。
                `;

/** 按被邀请人邮箱生成 send_invite 的 task */
export function buildSendInviteTask(inviteeEmail: string): string {
  return SEND_INVITE_TASK_TEMPLATE.replace("{invitee_email}", inviteeEmail);
}

/** accept_invite 的 task —— join_family.py L188-208 */
export const ACCEPT_INVITE_TASK = `
                在 Gmail 收件箱中完成以下操作：

                步骤 1 - 查找邀请邮件：
                - 在收件箱中查找来自 Google 的家庭邀请邮件
                - 邮件主题通常包含 "family" "invitation" "Google One" "家庭" "邀请"
                - 发件人通常是 "Google" 或 "no-reply@google.com"
                - 点击该邮件打开它

                步骤 2 - 接受邀请：
                - 在邮件内容中找到 "Accept invitation" 或 "接受邀请" 或 "Join" 链接/按钮
                - 点击该链接

                步骤 3 - 确认加入：
                - 在跳转后的页面点击 "Join Family Group" 或 "加入家庭群组" 或 "Join" 按钮
                - 如果看到 "Welcome to the family" 或 "已加入" 表示成功

                注意：
                - 如果看到 "already in a family" 或 "已在家庭组" 错误，报告错误
                - 如果找不到邀请邮件，尝试刷新页面后再查找
                `;

/** _create_family 的 task —— join_family.py L292-305 */
export const CREATE_FAMILY_TASK = `
                创建一个新的 Google 家庭组：

                1. 查找并点击 "Create a Family Group" 或 "创建家庭组" 或 "Crear un grupo familiar" 蓝色按钮
                2. 如果有确认对话框或条款，点击 "Confirm" 或 "Create" 或确认按钮
                3. 等待家庭组创建完成

                注意：按钮通常是蓝色的，文字可能是：
                - "Create a Family Group"
                - "Create"
                - "Confirm"
                - "创建家庭组"
                - "Crear un grupo familiar"
                `;

/** _handle_gmail_popups 的 task —— join_family.py L346-356 */
export const GMAIL_POPUP_TASK = `
                如果看到任何 Gmail 弹窗或提示，处理它们：
                - "Turn on smart features" → 点击 "Next"
                - "Smart features in Google Workspace" → 点击 "Next"
                - "Smart features in other Google products" → 点击 "Save"
                - "Reload" 提示 → 点击 "Reload"
                - "Get started with Gmail" → 点击关闭 (X) 或 "Got it"
                - "Enable desktop notifications" → 点击 "No thanks"

                如果没有弹窗或已看到收件箱 (Inbox)，完成任务。
                `;

// ==================== 内部判定（导出以便单测） ====================

/** 检查是否需要创建家庭组 —— 对标 _check_needs_create_family() */
export function checkNeedsCreateFamily(pageContent: string): boolean {
  const contentLower = pageContent.toLowerCase();
  return matchesAnyKeyword(contentLower, CREATE_FAMILY_KEYWORDS);
}

/** 检查邀请是否已发送 —— 对标 _check_invite_sent() */
export function checkInviteSent(pageContent: string): boolean {
  const contentLower = pageContent.toLowerCase();
  return matchesAnyKeyword(contentLower, INVITE_SENT_KEYWORDS);
}

/** 内部子流程的返回结构，对标 Python 返回的 dict */
export interface SubResult {
  success: boolean;
  error?: string | null;
  error_type?: string;
}

// ==================== 操作主体 ====================

export class JoinFamilyOperation {
  private readonly engine: JoinFamilyEngine;
  private readonly log: LogFn;

  constructor(engine: JoinFamilyEngine, options: { log?: LogFn } = {}) {
    this.engine = engine;
    this.log = options.log ?? noopLog;
  }

  /**
   * 发送家庭邀请 —— 对标 send_invite()
   *
   * 注意 Python 的 timeout 参数只是签名上的默认值，函数体内并未使用
   * （实际导航用的是硬编码的 30000）。照搬，保留该参数。
   */
  async sendInvite(
    inviteeEmail: string,
    _timeoutMs: number = JOIN_FAMILY_DEFAULT_TIMEOUT_MS,
  ): Promise<JoinFamilyResult> {
    const startTime = Date.now();
    this.log(`开始发送家庭邀请给: ${inviteeEmail}`);

    try {
      // 1. 导航到家庭邀请页面
      const navResult = await this.engine.navigate(FAMILY_INVITE_URL, {
        timeoutMs: JOIN_FAMILY_NAV_TIMEOUT_MS,
      });

      if (!navResult.success) {
        return createJoinFamilyResult({
          success: false,
          message: "导航到家庭邀请页面失败",
          error: navResult.error,
          duration_ms: Date.now() - startTime,
        });
      }

      await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);

      // 2. 检测是否需要创建家庭组
      let pageContent = await this.engine.getPageContent();
      const needsCreate = checkNeedsCreateFamily(pageContent);

      if (needsCreate) {
        this.log("检测到需要创建家庭组，开始创建...");
        const createResult = await this.createFamily();
        if (!createResult.success) {
          return createJoinFamilyResult({
            success: false,
            message: "创建家庭组失败",
            error: createResult.error ?? null,
            duration_ms: Date.now() - startTime,
          });
        }
        this.log("家庭组创建成功，重新导航到邀请页面...");
        await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);

        // 重新导航到邀请页面
        await this.engine.navigate(FAMILY_INVITE_URL, { timeoutMs: JOIN_FAMILY_NAV_TIMEOUT_MS });
        await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);
      }

      // 3. 检测家庭组是否已满
      if (await this.checkFamilyFull()) {
        return createJoinFamilyResult({
          success: false,
          message: "家庭组已满",
          error: "家庭组成员已达上限 (6人)",
          error_type: "family_full",
          duration_ms: Date.now() - startTime,
        });
      }

      // 4. 使用 Agent 输入邮箱并发送邀请
      const sendResult = await this.engine.run(buildSendInviteTask(inviteeEmail), {
        maxSteps: SEND_INVITE_MAX_STEPS,
      });

      if (!sendResult.success) {
        return createJoinFamilyResult({
          success: false,
          message: "发送邀请失败",
          error: sendResult.error,
          duration_ms: Date.now() - startTime,
        });
      }

      // 5. 验证邀请已发送
      await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);
      pageContent = await this.engine.getPageContent();

      if (checkInviteSent(pageContent)) {
        return createJoinFamilyResult({
          success: true,
          message: `已发送家庭邀请给 ${inviteeEmail}`,
          invite_sent: true,
          duration_ms: Date.now() - startTime,
        });
      }

      return createJoinFamilyResult({
        success: true,
        message: `邀请操作完成，等待 ${inviteeEmail} 接受`,
        invite_sent: true,
        duration_ms: Date.now() - startTime,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`发送家庭邀请失败: ${msg}`);
      return createJoinFamilyResult({
        success: false,
        message: `操作失败: ${msg}`,
        error: msg,
        duration_ms: Date.now() - startTime,
      });
    }
  }

  /**
   * 接受家庭邀请 —— 对标 accept_invite()
   *
   * 同样保留未被函数体使用的 timeout 参数。
   */
  async acceptInvite(
    inviterEmail: string,
    _timeoutMs: number = JOIN_FAMILY_DEFAULT_TIMEOUT_MS,
  ): Promise<JoinFamilyResult> {
    const startTime = Date.now();
    this.log(`开始接受家庭邀请，邀请人: ${inviterEmail}`);

    try {
      // 1. 导航到 Gmail
      const navResult = await this.engine.navigate(GMAIL_URL, {
        timeoutMs: JOIN_FAMILY_NAV_TIMEOUT_MS,
      });

      if (!navResult.success) {
        return createJoinFamilyResult({
          success: false,
          message: "导航到 Gmail 失败",
          error: navResult.error,
          inviter_email: inviterEmail,
          duration_ms: Date.now() - startTime,
        });
      }

      await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_GMAIL_MS);

      // 2. 处理 Gmail 首次访问弹窗
      await this.handleGmailPopups();

      // 3. 使用 Agent 查找并接受邀请
      const acceptResult = await this.engine.run(ACCEPT_INVITE_TASK, {
        maxSteps: ACCEPT_INVITE_MAX_STEPS,
      });

      await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);

      // 4. 验证加入结果
      const verifyResult = await this.verifyJoin();

      if (verifyResult.success) {
        return createJoinFamilyResult({
          success: true,
          message: "成功加入家庭组",
          inviter_email: inviterEmail,
          invite_accepted: true,
          duration_ms: Date.now() - startTime,
        });
      }

      if (verifyResult.error_type === "already_in_family") {
        return createJoinFamilyResult({
          success: false,
          message: "已在其他家庭组中",
          error: "被邀请人已加入其他家庭组",
          error_type: "already_in_family",
          already_in_family: true,
          inviter_email: inviterEmail,
          duration_ms: Date.now() - startTime,
        });
      }

      // Agent 执行结果作为备选判断
      if (acceptResult.success) {
        return createJoinFamilyResult({
          success: true,
          message: "家庭邀请已处理",
          inviter_email: inviterEmail,
          invite_accepted: true,
          duration_ms: Date.now() - startTime,
        });
      }

      return createJoinFamilyResult({
        success: false,
        message: "接受邀请失败",
        error: acceptResult.error || "无法确认加入结果",
        inviter_email: inviterEmail,
        duration_ms: Date.now() - startTime,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`接受家庭邀请失败: ${msg}`);
      return createJoinFamilyResult({
        success: false,
        message: `操作失败: ${msg}`,
        error: msg,
        inviter_email: inviterEmail,
        duration_ms: Date.now() - startTime,
      });
    }
  }

  /** 创建家庭组 —— 对标 _create_family() */
  private async createFamily(): Promise<SubResult> {
    try {
      const result = await this.engine.run(CREATE_FAMILY_TASK, {
        maxSteps: CREATE_FAMILY_MAX_STEPS,
      });
      return { success: result.success, error: result.error };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 检查家庭组是否已满 —— 对标 _check_family_full() */
  private async checkFamilyFull(): Promise<boolean> {
    try {
      const pageContent = await this.engine.getPageContent();
      const contentLower = pageContent.toLowerCase();
      return matchesAnyKeyword(contentLower, FAMILY_FULL_KEYWORDS);
    } catch {
      return false;
    }
  }

  /** 处理 Gmail 首次访问弹窗 —— 对标 _handle_gmail_popups() */
  private async handleGmailPopups(): Promise<void> {
    try {
      // 使用 Agent 处理可能的弹窗
      await this.engine.run(GMAIL_POPUP_TASK, { maxSteps: GMAIL_POPUP_MAX_STEPS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`处理 Gmail 弹窗时出错 (可忽略): ${msg}`);
    }
  }

  /** 验证是否成功加入 —— 对标 _verify_join() */
  private async verifyJoin(): Promise<SubResult> {
    try {
      // 检查当前页面 URL
      const currentUrl = await this.engine.getCurrentUrl();
      if (currentUrl.includes("families.google.com")) {
        const pageContent = await this.engine.getPageContent();
        const contentLower = pageContent.toLowerCase();

        // 成功标志
        if (matchesAnyKeyword(contentLower, JOIN_SUCCESS_KEYWORDS)) {
          return { success: true };
        }

        // 错误标志
        if (matchesAnyKeyword(contentLower, ALREADY_IN_FAMILY_KEYWORDS)) {
          return { success: false, error_type: "already_in_family" };
        }
      }

      // 导航到家庭页面确认
      await this.engine.navigate(FAMILY_DETAILS_URL);
      await this.engine.wait(JOIN_FAMILY_WAIT_AFTER_NAV_MS);

      const pageContent = await this.engine.getPageContent();
      const contentLower = pageContent.toLowerCase();

      // 检查是否显示家庭成员
      if (matchesAnyKeyword(contentLower, FAMILY_MEMBERS_KEYWORDS)) {
        return { success: true };
      }

      return { success: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`验证加入失败: ${msg}`);
      return { success: false, error: msg };
    }
  }
}
