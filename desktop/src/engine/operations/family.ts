/**
 * 家庭组状态检测与操作（Node 重写）
 * 对标 core/stagehand_engine/operations/family.py
 *
 * execute() 的判定顺序有意为之：先看 AI 提取是否确认有家庭组，
 * 再看关键词结果——因为关键词的 NO_FAMILY（如 "get started"）在
 * 已建组页面上也可能出现，误判率高于 AI 提取。
 */
import { z } from "zod";
import type { StagehandGoogleEngine } from "../stagehand-engine.ts";
import { GoogleURLs, Timeouts, FamilyKeywords } from "../constants.ts";
import {
  createFamilyStatusResult,
  createFamilyMember,
  type FamilyStatusResult,
  type FamilyRole,
} from "../types.ts";

const FamilyMemberSchema = z.object({
  email: z.string().optional(),
  name: z.string().nullish(),
  is_manager: z.boolean().optional(),
});

/** 对标 FamilyStatusSchema */
export const FamilyStatusSchema = z.object({
  has_family: z.boolean().optional(),
  is_manager: z.boolean().optional(),
  family_name: z.string().nullish(),
  member_count: z.number().optional(),
  members: z.array(FamilyMemberSchema).optional(),
  sharing_enabled: z.boolean().optional(),
  can_share_subscription: z.boolean().optional(),
});

export class FamilyOperation {
  private readonly engine: StagehandGoogleEngine;

  constructor(engine: StagehandGoogleEngine) {
    this.engine = engine;
  }

  /** 检测家庭组状态 */
  async execute(options: { navigateIfNeeded?: boolean } = {}): Promise<FamilyStatusResult> {
    const navigateIfNeeded = options.navigateIfNeeded ?? true;
    try {
      const currentUrl = await this.engine.getCurrentUrl();

      if (navigateIfNeeded && !currentUrl.includes("families.google.com")) {
        const nav = await this.engine.navigate(GoogleURLs.FAMILY, {
          timeoutMs: Timeouts.NAVIGATION,
        });
        if (!nav.success) {
          return createFamilyStatusResult({ has_family: false, role: "none" });
        }
        await this.engine.wait(Timeouts.AFTER_NAVIGATION);
      }

      if (await this.checkLoginRequired()) {
        return createFamilyStatusResult({ has_family: false, role: "none" });
      }

      const keywordResult = await this.detectByKeywords();
      const extractResult = await this.detectByExtraction();

      // AI 提取确认有家庭组 → 采信它（信息更完整）
      if (extractResult.has_family) return extractResult;
      // 否则关键词说有的也采信
      if (keywordResult.has_family) return keywordResult;

      return createFamilyStatusResult({ has_family: false, role: "none", is_manager: false });
    } catch {
      return createFamilyStatusResult({ has_family: false, role: "none" });
    }
  }

  private async checkLoginRequired(): Promise<boolean> {
    const url = await this.engine.getCurrentUrl();
    return url.includes("accounts.google.com") && url.includes("signin");
  }

  /** 关键词检测：有家庭组的关键词需多于无家庭组的关键词才算有 */
  private async detectByKeywords(): Promise<FamilyStatusResult> {
    try {
      const pageLower = (await this.engine.getPageContent()).toLowerCase();

      const matchedNoFamily = FamilyKeywords.NO_FAMILY.filter((k) =>
        pageLower.includes(k.toLowerCase()),
      );
      const matchedHasFamily = FamilyKeywords.HAS_FAMILY.filter((k) =>
        pageLower.includes(k.toLowerCase()),
      );
      const hasFamily = matchedHasFamily.length > matchedNoFamily.length;

      if (!hasFamily) {
        return createFamilyStatusResult({ has_family: false, role: "none", is_manager: false });
      }

      const isManager = FamilyKeywords.MANAGER.some((k) => pageLower.includes(k.toLowerCase()));
      const sharingEnabled = FamilyKeywords.SHARING_ENABLED.some((k) =>
        pageLower.includes(k.toLowerCase()),
      );

      return createFamilyStatusResult({
        has_family: true,
        role: isManager ? "manager" : "member",
        is_manager: isManager,
        sharing_enabled: sharingEnabled,
        can_share_subscription: isManager,
      });
    } catch {
      return createFamilyStatusResult({ has_family: false, role: "none" });
    }
  }

  /** AI 提取：成员列表逐个映射，is_manager 决定角色 */
  private async detectByExtraction(): Promise<FamilyStatusResult> {
    try {
      const extracted = await this.engine.extract<Record<string, unknown>>(
        `
                提取当前页面的 Google 家庭组信息:
                1. 是否有家庭组 (has_family)
                2. 当前用户是否是管理员 (is_manager)
                3. 家庭组名称 (family_name)
                4. 成员数量 (member_count)
                5. 成员列表，包括邮箱和名称 (members)
                6. 是否启用了订阅共享 (sharing_enabled)

                如果页面显示"创建家庭组"等提示，说明没有家庭组。
                `,
        FamilyStatusSchema,
      );

      if (!extracted.success || !extracted.data) {
        return createFamilyStatusResult({ has_family: false, role: "none" });
      }

      const data = extracted.data as Record<string, unknown>;
      const membersData = (data["members"] ?? []) as Record<string, unknown>[];
      const members = membersData
        .filter((m) => m && typeof m === "object")
        .map((m) =>
          createFamilyMember({
            email: (m["email"] as string) ?? "",
            name: (m["name"] as string | null) ?? null,
            role: (m["is_manager"] ? "manager" : "member") as FamilyRole,
          }),
        );

      const hasFamily = Boolean(data["has_family"]);
      const isManager = Boolean(data["is_manager"]);

      return createFamilyStatusResult({
        has_family: hasFamily,
        role: isManager ? "manager" : hasFamily ? "member" : "none",
        is_manager: isManager,
        family_name: (data["family_name"] as string | null) ?? null,
        member_count: (data["member_count"] as number) ?? members.length,
        members,
        sharing_enabled: Boolean(data["sharing_enabled"]),
        can_share_subscription: isManager,
      });
    } catch {
      return createFamilyStatusResult({ has_family: false, role: "none" });
    }
  }

  /** 创建家庭组；创建后重查状态确认真实生效 */
  async createFamily(): Promise<boolean> {
    try {
      await this.engine.navigate(GoogleURLs.FAMILY);
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const click = await this.engine.act("点击创建家庭组按钮或开始按钮");
      if (!click.success) return false;

      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      await this.engine.act("点击确认或继续按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      const status = await this.execute({ navigateIfNeeded: false });
      return status.has_family;
    } catch {
      return false;
    }
  }

  /** 邀请成员加入家庭组 */
  async inviteMember(email: string): Promise<boolean> {
    try {
      await this.engine.navigate(GoogleURLs.FAMILY_MEMBERS);
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const click = await this.engine.act("点击邀请成员或添加成员按钮");
      if (!click.success) return false;

      await this.engine.wait(Timeouts.AFTER_CLICK);

      await this.engine.act(`在邮箱输入框中输入: ${email}`);
      await this.engine.wait(Timeouts.AFTER_INPUT);

      await this.engine.act("点击发送邀请或确认按钮");
      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      return true;
    } catch {
      return false;
    }
  }

  /**
   * 启用家庭订阅共享。
   * 点击失败时不直接报失败——可能本来就已启用，改为读取实际共享状态。
   */
  async enableSharing(): Promise<boolean> {
    try {
      await this.engine.navigate(GoogleURLs.FAMILY_SHARING);
      await this.engine.wait(Timeouts.AFTER_NAVIGATION);

      const click = await this.engine.act("点击启用共享或开启共享开关");
      if (!click.success) {
        const status = await this.execute({ navigateIfNeeded: false });
        return status.sharing_enabled;
      }

      await this.engine.wait(Timeouts.AFTER_CLICK * 2);

      const status = await this.execute({ navigateIfNeeded: false });
      return status.sharing_enabled;
    } catch {
      return false;
    }
  }
}