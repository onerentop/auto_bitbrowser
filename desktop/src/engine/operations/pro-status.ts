/**
 * Pro 状态检测（Node 重写）
 * 对标 core/stagehand_engine/operations/pro_status.py
 *
 * 双路径：先关键词快速判定，未确定再走 AI extract。两条路径在判定为 Pro 后
 * 都强制执行一次家庭组二次校验——这是业务规则「先判断是否 Pro，再判断是否家庭 Pro」，
 * 仅靠一次 extract 的 is_family_member 在不同语言/布局下会误判。
 */
import { z } from "zod";
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts, ProKeywords, FamilyKeywords } from "../constants.ts";
import { createProStatusResult, type ProStatus, type FamilyRole, type ProStatusResult } from "../types.ts";

/** 对标 ProStatusSchema（pydantic 字段逐一对应） */
export const ProStatusSchema = z.object({
  is_subscribed: z.boolean().optional(),
  plan_name: z.string().nullish(),
  storage_used: z.string().nullish(),
  storage_total: z.string().nullish(),
  expiry_date: z.string().nullish(),
  is_trial: z.boolean().optional(),
  has_payment_options: z.boolean().optional(),
  has_manage_family_settings: z.boolean().optional(),
  has_leave_family_button: z.boolean().optional(),
  family_manager_email: z.string().nullish(),
});

/** 家庭组状态（仅本文件需要的最小结构，避免循环依赖） */
export interface FamilyStatusLike {
  has_family: boolean;
  is_manager: boolean;
  members: { email?: string | null; role: FamilyRole }[];
}

/** 引擎需额外提供 detectFamilyStatus；此处声明以解耦 */
export interface EngineWithFamily extends StagehandGoogleEngine {
  detectFamilyStatus(options?: { navigateIfNeeded?: boolean }): Promise<FamilyStatusLike>;
}

/** 统一走自动生成的工厂函数，默认值对齐 Python dataclass */
function makeResult(partial: Partial<ProStatusResult> & { status: ProStatus }): ProStatusResult {
  return createProStatusResult(partial);
}

export class ProStatusOperation {
  private readonly engine: EngineWithFamily;

  constructor(engine: EngineWithFamily) {
    this.engine = engine;
  }

  async execute(options: { navigateIfNeeded?: boolean } = {}): Promise<ProStatusResult> {
    const navigateIfNeeded = options.navigateIfNeeded ?? true;
    const start = Date.now();

    try {
      // 1. 按需导航
      const currentUrl = await this.engine.getCurrentUrl();
      if (navigateIfNeeded && !currentUrl.includes("one.google.com")) {
        const nav = await this.engine.navigate(GoogleURLs.GOOGLE_ONE, {
          timeoutMs: Timeouts.NAVIGATION,
        });
        if (!nav.success) {
          return makeResult({ status: "unknown", method_used: "navigation_failed" });
        }
        await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      }

      // 2. 登录检查
      if (await this.checkLoginRequired()) {
        return makeResult({ status: "unknown", method_used: "login_required" });
      }

      // 3. 关键词快速检测
      const keywordResult = await this.detectByKeywords();
      if (keywordResult.status !== "unknown") {
        if (keywordResult.is_pro) {
          await this.applyFamilySecondCheck(keywordResult, "keyword");
        }
        return keywordResult;
      }

      // 4. AI 提取（失败则降级为关键词结果）
      try {
        const extractResult = await this.detectByExtraction();
        if (extractResult.status !== "unknown") return extractResult;
        if (keywordResult.confidence > 0) return keywordResult;
      } catch (err) {
        if (keywordResult.confidence > 0) {
          const msg = err instanceof Error ? err.message : String(err);
          keywordResult.method_used = `keyword_fallback (AI error: ${msg.slice(0, 50)})`;
          return keywordResult;
        }
      }

      return keywordResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeResult({ status: "unknown", method_used: `error: ${msg}` });
    }
  }

  private async checkLoginRequired(): Promise<boolean> {
    const url = await this.engine.getCurrentUrl();
    return url.includes("accounts.google.com") && url.includes("signin");
  }

  /**
   * 家庭组二次校验（原地修改 result）。
   * 三种结论：manager → 非家庭成员；member → 家庭成员并回填管理员邮箱；无家庭组 → 普通 Pro。
   * 校验抛错时保留原结果，只记日志（与 Python 一致）。
   */
  private async applyFamilySecondCheck(
    result: ProStatusResult,
    source: "keyword" | "ai",
  ): Promise<void> {
    const prefix = source === "keyword" ? result.method_used : "ai_extraction";
    try {
      const family = await this.engine.detectFamilyStatus({ navigateIfNeeded: true });
      if (family.has_family) {
        if (family.is_manager) {
          result.is_family_member = false;
          result.method_used = `${prefix}+family_check(manager)`;
        } else {
          result.is_family_member = true;
          result.method_used = `${prefix}+family_check(member)`;
          if (!result.family_manager_email) {
            const manager = family.members.find(
              (m) => m.role === "manager" && Boolean(m.email),
            );
            result.family_manager_email = manager?.email ?? null;
          }
        }
      } else {
        result.is_family_member = false;
        result.method_used = `${prefix}+family_check(no_family)`;
      }
    } catch {
      // 家庭组校验失败，保留原结果
    }
  }

  /** 关键词检测。判定顺序：过期 → 付费计划 → 免费 → 未知，不可调换 */
  private async detectByKeywords(): Promise<ProStatusResult> {
    try {
      const pageLower = (await this.engine.getPageContent()).toLowerCase();
      const hit = (kws: readonly string[]) => kws.filter((k) => pageLower.includes(k.toLowerCase()));

      const matchedPositive = hit(ProKeywords.POSITIVE);
      const matchedNegative = hit(ProKeywords.NEGATIVE);
      const matchedExpired = hit(ProKeywords.EXPIRED);
      const matchedFamilyMember = hit(FamilyKeywords.FAMILY_MEMBER);
      const matchedIndependent = hit(FamilyKeywords.INDEPENDENT_SUBSCRIBER);

      if (matchedExpired.length > 0) {
        return makeResult({
          status: "expired",
          confidence: 0.8,
          method_used: "keyword_detection",
          raw_keywords: matchedExpired,
        });
      }

      const storagePlans = ["2 tb", "200 gb", "100 gb", "ai premium"];
      let detectedPlan: string | null = null;
      for (const plan of storagePlans) {
        if (pageLower.includes(plan)) {
          detectedPlan = plan.toUpperCase();
          break;
        }
      }

      if (detectedPlan) {
        return makeResult({
          status: "active",
          is_pro: true,
          is_family_member: matchedFamilyMember.length > matchedIndependent.length,
          plan_name: detectedPlan,
          confidence: 0.9,
          method_used: "keyword_detection",
          raw_keywords: [...matchedPositive, ...matchedFamilyMember],
        });
      }

      if (pageLower.includes("15 gb") && matchedPositive.length === 0) {
        return makeResult({
          status: "free",
          plan_name: "15 GB (Free)",
          confidence: 0.85,
          method_used: "keyword_detection",
          raw_keywords: matchedNegative,
        });
      }

      return makeResult({ status: "unknown", method_used: "keyword_detection" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeResult({ status: "unknown", method_used: `keyword_error: ${msg}` });
    }
  }

  /** AI 提取检测 */
  private async detectByExtraction(): Promise<ProStatusResult> {
    try {
      const extracted = await this.engine.extract<Record<string, unknown>>(
        "Extract Google One subscription info with high accuracy. " +
          "Return is_subscribed (false if 'Upgrade'/'Get started' buttons are visible), " +
          "is_family_member, plan_name, has_payment_options " +
          "(true when billing-owner actions like 'Cancel membership' or " +
          "'Change payment method' are visible), storage info, is_trial, " +
          "has_manage_family_settings, has_leave_family_button, family_manager_email.",
        ProStatusSchema,
      );

      if (!extracted.success || !extracted.data) {
        return makeResult({ status: "unknown", method_used: "extraction_failed" });
      }

      const data = extracted.data as Record<string, unknown>;
      const isSubscribed = Boolean(data["is_subscribed"]);
      const isTrial = Boolean(data["is_trial"]);
      let isFamilyMember = Boolean(data["is_family_member"]);
      const hasPaymentOptions = Boolean(data["has_payment_options"]);
      const hasManageFamilySettings = Boolean(data["has_manage_family_settings"]);
      const hasLeaveFamilyButton = Boolean(data["has_leave_family_button"]);
      let familyManagerEmail = (data["family_manager_email"] as string | null) ?? null;
      let methodUsed = "ai_extraction";

      // 有付款入口 → 不是家庭成员；否则结合家庭特征首轮修正
      if (hasPaymentOptions) {
        isFamilyMember = false;
      } else if (hasLeaveFamilyButton) {
        isFamilyMember = true;
      } else if (hasManageFamilySettings) {
        isFamilyMember = false;
      }

      // 强制二次校验：只要是 Pro 就额外走一次家庭组检测
      if (isSubscribed) {
        const holder = makeResult({
          status: "active",
          is_pro: true,
          is_family_member: isFamilyMember,
          family_manager_email: familyManagerEmail,
          method_used: methodUsed,
        });
        await this.applyFamilySecondCheck(holder, "ai");
        isFamilyMember = holder.is_family_member;
        familyManagerEmail = holder.family_manager_email;
        methodUsed = holder.method_used;
      }

      const status: ProStatus = isSubscribed ? (isTrial ? "trial" : "active") : "free";

      return makeResult({
        status,
        is_pro: isSubscribed,
        is_family_member: isFamilyMember,
        family_manager_email: familyManagerEmail,
        plan_name: (data["plan_name"] as string) ?? null,
        storage_used: (data["storage_used"] as string) ?? null,
        storage_total: (data["storage_total"] as string) ?? null,
        expiry_date: (data["expiry_date"] as string) ?? null,
        confidence: 0.95,
        method_used: methodUsed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return makeResult({ status: "unknown", method_used: `extraction_error: ${msg}` });
    }
  }
}