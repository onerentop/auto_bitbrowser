/**
 * 修改两步验证手机号（Node 重写）
 * 对标 core/stagehand_engine/operations/modify_2sv.py
 *
 * 流程：进 2SV 设置 → 查状态 → 点修改 → (必要时先删旧号) → 加新号 →
 *       输号码 → 发验证码 → 填码 → 验证结果。
 *
 * operation_type 固定为 "2sv"，与 replace-phone 的 "recovery" 区分。
 */
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts } from "../constants.ts";
import { createModifyPhoneResult, type ModifyPhoneResult } from "../types.ts";

/** 短信验证码服务，对应 Python 传入的 sms_service */
export interface SmsCodeService {
  getCode(phone: string): Promise<string | null>;
}

interface StepOutcome {
  success: boolean;
  message?: string;
  error?: string;
}

export class Modify2SVOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  async execute(
    newPhone: string,
    smsService: SmsCodeService | null = null,
  ): Promise<ModifyPhoneResult> {
    const start = Date.now();
    const fail = (message: string, error?: string | null): ModifyPhoneResult =>
      createModifyPhoneResult({
        success: false,
        message,
        error,
        operation_type: "2sv",
        duration_ms: Date.now() - start,
      });

    try {
      const nav = await this.engine.navigate(GoogleURLs.TWO_STEP_VERIFICATION, {
        timeoutMs: Timeouts.NAVIGATION,
      });
      if (!nav.success) return fail("导航到 2SV 设置页面失败", nav.error);

      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const url = await this.engine.getCurrentUrl();
      if (url.includes("accounts.google.com") && url.includes("signin")) {
        return fail("需要先登录账号", "未登录");
      }

      const status = await this.check2svStatus();
      if (status.needs_password) {
        return fail("需要重新验证密码", "需要密码验证");
      }

      const result = await this.performModify(newPhone, smsService);
      const durationMs = Date.now() - start;

      if (result.success) {
        return createModifyPhoneResult({
          success: true,
          message: "2SV 手机号修改成功",
          new_phone: newPhone,
          operation_type: "2sv",
          duration_ms: durationMs,
        });
      }
      return createModifyPhoneResult({
        success: false,
        message: result.message ?? "修改失败",
        error: result.error,
        operation_type: "2sv",
        duration_ms: durationMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`操作失败: ${msg}`, msg);
    }
  }

  /** 用一次 extract 判断页面处于哪种状态，关键词取并集后按组判定 */
  private async check2svStatus(): Promise<{
    needs_password?: boolean;
    has_phone?: boolean;
    is_enabled?: boolean;
  }> {
    try {
      const extracted = await this.engine.extract(
        `
                检查当前 2-Step Verification 页面状态：
                1. 是否显示密码验证页面
                2. 是否显示现有的手机号
                3. 是否有 "Add a phone" 或 "更改手机号" 按钮
                4. 2SV 是否已启用
                `,
      );
      if (!extracted.success) return {};

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();
      const has = (kws: string[]) => kws.some((k) => text.includes(k));

      return {
        needs_password: has(["enter your password", "输入密码", "verify"]),
        has_phone: has(["phone", "手机", "number"]),
        is_enabled: has(["2-step", "两步", "enabled", "已启用"]),
      };
    } catch {
      return {};
    }
  }

  private async performModify(
    newPhone: string,
    smsService: SmsCodeService | null,
  ): Promise<StepOutcome> {
    try {
      // Step 1: 进入修改入口
      await this.engine.act("点击 'Change phone' 或 '更改手机号' 或 'Edit' 或 '编辑' 按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      // Step 2: 若页面上有删除入口，先移除旧号（只处理第一个命中的）
      const observed = await this.engine.observe(
        "查找页面上的手机号输入框或删除现有手机的选项",
      );
      if (observed.success && (observed.data ?? []).length > 0) {
        for (const action of observed.data ?? []) {
          if (action && typeof action === "object") {
            const desc = String((action as { description?: string }).description ?? "").toLowerCase();
            if (
              desc.includes("remove") ||
              desc.includes("delete") ||
              desc.includes("移除") ||
              desc.includes("删除")
            ) {
              await this.engine.act("点击移除或删除现有手机号的按钮");
              await this.engine.wait(2000);
              await this.engine.act("确认删除");
              await this.engine.wait(2000);
              break;
            }
          }
        }
      }

      // Step 3: 添加新手机号
      await this.engine.act("点击 'Add a phone' 或 '添加手机号' 按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK);

      // Step 4: 输入号码
      await this.engine.act(`在手机号输入框中输入: ${newPhone}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      // Step 5: 发送验证码
      await this.engine.act("点击 'Next' 或 '下一步' 或 'Send' 或 '发送验证码' 按钮");
      await this.engine.wait(3000);

      // Step 6: 取码并提交
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
          return { success: false, message: "需要手动输入验证码", error: "短信验证码获取失败" };
        }
      } else {
        return { success: false, message: "需要手动输入验证码", error: "未提供短信服务" };
      }

      // Step 7: 验证
      return await this.verifyModification(newPhone);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg, error: msg };
    }
  }

  private async verifyModification(newPhone: string): Promise<StepOutcome> {
    try {
      const extracted = await this.engine.extract(
        `
                检查页面是否显示修改成功的标志：
                1. 显示新的手机号 ${newPhone}
                2. "Success" 或 "成功" 提示
                3. "Phone added" 或 "已添加手机号"

                也检查错误信息：
                4. "Invalid number" 或 "无效号码"
                5. "Error" 或 "错误"
                `,
      );
      if (!extracted.success) return { success: false, message: "无法验证修改结果" };

      const text = String(JSON.stringify(extracted.data ?? {})).toLowerCase();

      const okWords = ["success", "成功", "added", "已添加"];
      if (okWords.some((k) => text.includes(k))) return { success: true };

      const badWords = ["invalid", "无效", "error", "错误"];
      if (badWords.some((k) => text.includes(k))) {
        return { success: false, message: "手机号验证失败", error: "无效的手机号或验证码" };
      }

      return { success: false, message: "无法确定修改结果" };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}