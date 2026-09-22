/**
 * 替换辅助邮箱（Node 重写）
 * 对标 core/stagehand_engine/operations/replace_email.py
 *
 * 提示词逐字照搬 Python 版。注意 Python 用 f-string 拼的指令（如带 new_email 的）
 * 在这里用模板字符串生成，前缀与分隔符必须一致。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createReplaceEmailResult, type ReplaceEmailResult } from "../types.ts";

/** 邮箱验证码服务接口，对应 Python 传入的 email_service */
export interface EmailCodeService {
  getCode(email: string): Promise<string | null>;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string | null;
}


export class ReplaceEmailOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(
    newEmail: string,
    emailService: EmailCodeService | null = null,
  ): Promise<ReplaceEmailResult> {
    const start = Date.now();
    try {
      const nav = await this.engine.navigate(GoogleURLs.RECOVERY_EMAIL, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) {
        return createReplaceEmailResult({
          success: false,
          message: "导航到恢复邮箱设置页面失败",
          error: nav.error,
          duration_ms: Date.now() - start,
        });
      }

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return createReplaceEmailResult({
          success: false,
          message: "需要先登录账号",
          error: "未登录",
          duration_ms: Date.now() - start,
        });
      }

      const replaced = await this.performReplace(newEmail, emailService);
      const durationMs = Date.now() - start;

      if (replaced.success) {
        return createReplaceEmailResult({
          success: true,
          message: "辅助邮箱替换成功",
          new_email: newEmail,
          duration_ms: durationMs,
        });
      }
      return createReplaceEmailResult({
        success: false,
        message: replaced.message ?? "替换失败",
        error: replaced.error,
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createReplaceEmailResult({ success: false, message: `操作失败: ${msg}`, error: msg, duration_ms: Date.now() - start });
    }
  }

  private async performReplace(
    newEmail: string,
    emailService: EmailCodeService | null,
  ): Promise<StepOutcome> {
    try {
      // Step 1: 检查当前状态
      await this.engine.extract(
        `
                检查当前恢复邮箱设置页面：
                1. 是否有现有的恢复邮箱
                2. 是否有 "Add recovery email" 或 "添加恢复邮箱" 按钮
                3. 是否有 "Edit" 或 "编辑" 按钮
                `,
      );

      // Step 2: 点击添加或编辑按钮
      await this.engine.act(
        "点击 'Add recovery email' 或 '添加恢复邮箱' 或 'Edit' 或 '编辑' 或铅笔图标按钮",
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 3: 清除现有邮箱并输入新邮箱
      await this.engine.act("清除邮箱输入框中的现有内容");
      await this.engine.wait(500);

      await this.engine.act(`在恢复邮箱输入框中输入: ${newEmail}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      // Step 4: 点击下一步/确认
      await this.engine.act(
        "点击 'Next' 或 '下一步' 或 'Confirm' 或 '确认' 或 'Save' 或 '保存' 按钮",
      );
      await this.engine.wait(3000);

      // Step 5: 检查是否需要验证
      const verifyCheck = await this.engine.extract(
        `
                检查页面是否显示：
                1. 验证码输入框 - 需要输入发送到新邮箱的验证码
                2. 成功消息 - 恢复邮箱已更新
                3. 错误消息 - 无效的邮箱等
                `,
      );

      if (verifyCheck.success && verifyCheck.data) {
        const resultText = String(JSON.stringify(verifyCheck.data)).toLowerCase();

        if (
          resultText.includes("verification") ||
          resultText.includes("验证码") ||
          resultText.includes("code")
        ) {
          if (emailService) {
            try {
              const code = await emailService.getCode(newEmail);
              if (code) {
                await this.engine.act(`在验证码输入框中输入: ${code}`);
                await this.engine.wait(Timeouts.AFTER_INPUT);
                await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮");
                await this.engine.wait(3000);
              }
            } catch {
              return createReplaceEmailResult({
                success: false,
                message: "需要手动输入验证码",
                error: "邮箱验证码获取失败",
              });
            }
          } else {
            return createReplaceEmailResult({ success: false, message: "需要手动输入验证码", error: "未提供邮件服务" });
          }
        }
      }

      // Step 6: 验证替换成功
      return await this.verifyReplacement(newEmail);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return createReplaceEmailResult({ success: false, message: msg, error: msg });
    }
  }

  /** 刷新页面后核对新邮箱是否生效 */
  private async verifyReplacement(newEmail: string): Promise<StepOutcome> {
    try {
      await this.engine.navigate(GoogleURLs.RECOVERY_EMAIL, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const extracted = await this.engine.extract(
        `
                检查页面是否显示：
                1. 新的恢复邮箱 ${newEmail}
                2. "Recovery email updated" 或 "恢复邮箱已更新" 消息
                3. "Success" 或 "成功" 提示

                也检查错误信息：
                4. "Invalid email" 或 "无效邮箱"
                5. "Error" 或 "错误"
                `,
      );

      if (!extracted.success) {
        return createReplaceEmailResult({ success: false, message: "无法验证替换结果" });
      }

      const resultText = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      if (resultText.includes(newEmail.toLowerCase())) return createReplaceEmailResult({ success: true });

      const okWords = ["updated", "已更新", "success", "成功"];
      if (okWords.some((k) => resultText.includes(k))) return createReplaceEmailResult({ success: true });

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => resultText.includes(k))) {
        return createReplaceEmailResult({ success: false, message: "邮箱验证失败", error: "无效的邮箱" });
      }

      return createReplaceEmailResult({ success: false, message: "无法确定替换结果" });
    } catch (err) {
      return createReplaceEmailResult({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
}