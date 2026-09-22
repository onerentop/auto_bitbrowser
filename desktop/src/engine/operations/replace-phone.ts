/**
 * 替换恢复手机号（Node 重写）
 * 对标 core/stagehand_engine/operations/replace_phone.py
 *
 * 与 replace-email 结构几乎一致，差异在 URL、按钮文案、以及验证时比对手机号后四位。
 * operation_type 固定为 "recovery"。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";

/** 短信验证码服务接口，对应 Python 传入的 sms_service */
export interface SmsCodeService {
  getCode(phone: string): Promise<string | null>;
}

export interface ModifyPhoneResult {
  success: boolean;
  message: string;
  error?: string | null;
  new_phone?: string;
  operation_type: "recovery";
  duration_ms: number;
}

export class ReplacePhoneOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(
    newPhone: string,
    smsService: SmsCodeService | null = null,
  ): Promise<ModifyPhoneResult> {
    const start = Date.now();
    const fail = (message: string, error?: string | null): ModifyPhoneResult => ({
      success: false,
      message,
      error,
      operation_type: "recovery",
      duration_ms: Date.now() - start,
    });

    try {
      const nav = await this.engine.navigate(GoogleURLs.RECOVERY_PHONE, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) return fail("导航到恢复手机设置页面失败", nav.error);

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return fail("需要先登录账号", "未登录");
      }

      const replaced = await this.performReplace(newPhone, smsService);
      const durationMs = Date.now() - start;

      if (replaced.success) {
        return {
          success: true,
          message: "恢复手机号替换成功",
          new_phone: newPhone,
          operation_type: "recovery",
          duration_ms: durationMs,
        };
      }
      return {
        success: false,
        message: replaced.message ?? "替换失败",
        error: replaced.error,
        operation_type: "recovery",
        duration_ms: durationMs,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`操作失败: ${msg}`, msg);
    }
  }

  private async performReplace(
    newPhone: string,
    smsService: SmsCodeService | null,
  ): Promise<{ success: boolean; message?: string; error?: string | null }> {
    try {
      await this.engine.extract(
        `
                检查当前恢复手机设置页面：
                1. 是否有现有的恢复手机号
                2. 是否有 "Add recovery phone" 或 "添加恢复手机" 按钮
                3. 是否有 "Edit" 或 "编辑" 按钮
                4. 是否有 "Update" 或 "更新" 按钮
                `,
      );

      await this.engine.act(
        "点击 'Add recovery phone' 或 '添加恢复手机' 或 'Edit' 或 '编辑' 或 'Update' 或 '更新' 或铅笔图标按钮",
      );
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      await this.engine.act("清除手机号输入框中的现有内容");
      await this.engine.wait(500);

      await this.engine.act(`在恢复手机号输入框中输入: ${newPhone}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      await this.engine.act(
        "点击 'Next' 或 '下一步' 或 'Get code' 或 '获取验证码' 或 'Send' 或 '发送' 按钮",
      );
      await this.engine.wait(3000);

      const verifyCheck = await this.engine.extract(
        `
                检查页面是否显示：
                1. 验证码输入框 - 需要输入发送到新手机的验证码
                2. 成功消息 - 恢复手机已更新
                3. 错误消息 - 无效的手机号等
                `,
      );

      if (verifyCheck.success && verifyCheck.data) {
        const resultText = String(JSON.stringify(verifyCheck.data)).toLowerCase();

        if (
          resultText.includes("verification") ||
          resultText.includes("验证码") ||
          resultText.includes("code")
        ) {
          if (smsService) {
            try {
              const code = await smsService.getCode(newPhone);
              if (code) {
                await this.engine.act(`在验证码输入框中输入: ${code}`);
                await this.engine.wait(Timeouts.AFTER_INPUT);
                await this.engine.act("点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮");
                await this.engine.wait(3000);
              }
            } catch {
              return {
                success: false,
                message: "需要手动输入验证码",
                error: "短信验证码获取失败",
              };
            }
          } else {
            return { success: false, message: "需要手动输入验证码", error: "未提供短信服务" };
          }
        }
      }

      return await this.verifyReplacement(newPhone);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg };
    }
  }

  /** 刷新后核对：手机号后四位出现即视为成功（页面通常做脱敏显示） */
  private async verifyReplacement(newPhone: string): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    try {
      await this.engine.navigate(GoogleURLs.RECOVERY_PHONE, { timeoutMs: Timeouts.NAVIGATION });
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const extracted = await this.engine.extract(
        `
                检查页面是否显示：
                1. 新的恢复手机号（可能是部分隐藏的格式，如 ***1234）
                2. "Recovery phone updated" 或 "恢复手机已更新" 消息
                3. "Success" 或 "成功" 提示

                也检查错误信息：
                4. "Invalid phone" 或 "无效手机号"
                5. "Error" 或 "错误"
                `,
      );

      if (!extracted.success) return { success: false, message: "无法验证替换结果" };

      const resultText = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      if (newPhone.length >= 4) {
        const lastFour = newPhone.slice(-4);
        if (resultText.includes(lastFour)) return { success: true };
      }

      const okWords = ["updated", "已更新", "success", "成功"];
      if (okWords.some((k) => resultText.includes(k))) return { success: true };

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => resultText.includes(k))) {
        return { success: false, message: "手机号验证失败", error: "无效的手机号" };
      }

      return { success: false, message: "无法确定替换结果" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}