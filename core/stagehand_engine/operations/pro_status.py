"""
Stagehand Google Engine - Pro 状态检测

检测 Google One Pro 订阅状态
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from pydantic import BaseModel, Field

from ..types import (
    OperationStatus,
    FamilyRole,
    ProStatus,
    ProStatusResult,
)
from ..constants import GoogleURLs, Timeouts, ProKeywords, FamilyKeywords

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class ProStatusSchema(BaseModel):
    """Pro 状态提取 Schema"""
    is_subscribed: bool = Field(
        default=False,
        description="是否有 Google One 订阅"
    )
    is_family_member: bool = Field(
        default=False,
        description="是否是家庭组成员（通过别人的订阅获得，不是自己付费）"
    )
    plan_name: Optional[str] = Field(
        default=None,
        description="订阅计划名称，如 '100 GB', '2 TB', 'AI Premium'"
    )
    storage_used: Optional[str] = Field(
        default=None,
        description="已使用存储空间"
    )
    storage_total: Optional[str] = Field(
        default=None,
        description="总存储空间"
    )
    expiry_date: Optional[str] = Field(
        default=None,
        description="订阅到期日期"
    )
    is_trial: bool = Field(
        default=False,
        description="是否是试用期"
    )
    has_payment_options: bool = Field(
        default=False,
        description="页面是否有付款相关选项（Change payment method, Cancel membership等）"
    )
    has_manage_family_settings: bool = Field(
        default=False,
        description="是否出现 Manage family settings / 管理家庭设置 等家庭管理入口"
    )
    has_leave_family_button: bool = Field(
        default=False,
        description="是否出现 Leave family / 退出家庭 等成员侧按钮"
    )
    family_manager_email: Optional[str] = Field(
        default=None,
        description="若是家庭组共享订阅，提取管理员邮箱（如果页面可见）"
    )


class ProStatusOperation:
    """Pro 状态检测操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.EXTRACT,
    ) -> ProStatusResult:
        """
        检测 Pro 订阅状态

        Args:
            navigate_if_needed: 是否自动导航到 Google One 页面
            timeout: 超时时间

        Returns:
            ProStatusResult
        """
        start_time = time.time()
        logger.info("开始检测 Pro 状态")

        try:
            # 1. 检查是否需要导航
            current_url = await self.engine.get_current_url()

            if navigate_if_needed and "one.google.com" not in current_url:
                nav_result = await self.engine.navigate(
                    GoogleURLs.GOOGLE_ONE,
                    timeout=Timeouts.NAVIGATION,
                )

                if not nav_result.success:
                    return ProStatusResult(
                        status=ProStatus.UNKNOWN,
                        is_pro=False,
                        method_used="navigation_failed",
                    )

                await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            if await self._check_login_required():
                return ProStatusResult(
                    status=ProStatus.UNKNOWN,
                    is_pro=False,
                    method_used="login_required",
                )

            # 3. 使用关键词检测 (快速方法)
            keyword_result = await self._detect_by_keywords()
            if keyword_result.status != ProStatus.UNKNOWN:
                logger.info(f"关键词检测成功: {keyword_result.status.value}")
                return keyword_result

            # 4. 尝试使用 AI 提取 (更准确) - 如果失败则使用关键词结果作为降级
            try:
                extract_result = await self._detect_by_extraction()

                if extract_result.status != ProStatus.UNKNOWN:
                    duration_ms = (time.time() - start_time) * 1000
                    logger.info(f"Pro 状态检测完成 (AI 提取): {extract_result.status.value}")
                    return extract_result
                else:
                    # AI 提取返回 UNKNOWN，使用关键词结果
                    logger.warning("AI 提取返回未知状态，使用关键词检测结果")
                    if keyword_result.confidence > 0:
                        return keyword_result
            except Exception as extract_error:
                # AI 提取失败，记录错误但继续
                logger.warning(f"AI 提取失败，降级使用关键词检测: {extract_error}")
                # 如果关键词检测有任何结果（即使是 UNKNOWN），也返回它
                if keyword_result.confidence > 0:
                    keyword_result.method_used = f"keyword_fallback (AI error: {str(extract_error)[:50]})"
                    return keyword_result

            duration_ms = (time.time() - start_time) * 1000
            logger.info(f"Pro 状态检测完成: {keyword_result.status.value}")

            # 返回关键词结果（即使是 UNKNOWN）
            return keyword_result

        except Exception as e:
            logger.error(f"Pro 状态检测失败: {e}")
            return ProStatusResult(
                status=ProStatus.UNKNOWN,
                is_pro=False,
                method_used=f"error: {e}",
            )

    async def _check_login_required(self) -> bool:
        """检查是否需要登录"""
        current_url = await self.engine.get_current_url()
        return "accounts.google.com" in current_url and "signin" in current_url

    async def _detect_by_keywords(self) -> ProStatusResult:
        """使用关键词检测 Pro 状态"""
        try:
            page_content = await self.engine.get_page_content()
            page_lower = page_content.lower()

            matched_positive = []
            matched_negative = []
            matched_expired = []
            matched_family_member = []
            matched_independent = []

            # 检测正面关键词 (Pro 会员)
            for kw in ProKeywords.POSITIVE:
                if kw.lower() in page_lower:
                    matched_positive.append(kw)

            # 检测负面关键词 (非 Pro)
            for kw in ProKeywords.NEGATIVE:
                if kw.lower() in page_lower:
                    matched_negative.append(kw)

            # 检测过期关键词
            for kw in ProKeywords.EXPIRED:
                if kw.lower() in page_lower:
                    matched_expired.append(kw)

            # 检测家庭组成员关键词
            for kw in FamilyKeywords.FAMILY_MEMBER:
                if kw.lower() in page_lower:
                    matched_family_member.append(kw)

            # 检测独立订阅者关键词
            for kw in FamilyKeywords.INDEPENDENT_SUBSCRIBER:
                if kw.lower() in page_lower:
                    matched_independent.append(kw)

            # 判断状态
            if matched_expired:
                return ProStatusResult(
                    status=ProStatus.EXPIRED,
                    is_pro=False,
                    confidence=0.8,
                    method_used="keyword_detection",
                    raw_keywords=matched_expired,
                )

            # 检测具体的存储计划
            storage_plans = ["2 tb", "200 gb", "100 gb", "ai premium"]
            detected_plan = None
            for plan in storage_plans:
                if plan in page_lower:
                    detected_plan = plan.upper()
                    break

            if detected_plan:
                # 有付费计划，是 Pro
                # 判断是否为家庭组成员
                is_family_member = len(matched_family_member) > len(matched_independent)

                return ProStatusResult(
                    status=ProStatus.ACTIVE,
                    is_pro=True,
                    is_family_member=is_family_member,
                    plan_name=detected_plan,
                    confidence=0.9,
                    method_used="keyword_detection",
                    raw_keywords=matched_positive + matched_family_member,
                )

            # 检测免费用户
            if "15 gb" in page_lower and not matched_positive:
                return ProStatusResult(
                    status=ProStatus.FREE,
                    is_pro=False,
                    plan_name="15 GB (Free)",
                    confidence=0.85,
                    method_used="keyword_detection",
                    raw_keywords=matched_negative,
                )

            # 无法确定
            return ProStatusResult(
                status=ProStatus.UNKNOWN,
                is_pro=False,
                confidence=0.0,
                method_used="keyword_detection",
            )

        except Exception as e:
            logger.warning(f"关键词检测失败: {e}")
            return ProStatusResult(
                status=ProStatus.UNKNOWN,
                is_pro=False,
                method_used=f"keyword_error: {e}",
            )

    async def _detect_by_extraction(self) -> ProStatusResult:
        """使用 AI 提取检测 Pro 状态"""
        try:
            # 使用 Stagehand extract 提取结构化数据
            # 传入 ProStatusSchema 以生成 JSON Schema，帮助 AI 返回结构化数据
            extract_result = await self.engine.extract(
                instruction=(
                    "Extract Google One subscription info with high accuracy. "
                    "Return is_subscribed (false if 'Upgrade'/'Get started' buttons are visible), "
                    "is_family_member, plan_name, has_payment_options "
                    "(true when billing-owner actions like 'Cancel membership' or "
                    "'Change payment method' are visible), storage info, is_trial, "
                    "has_manage_family_settings, has_leave_family_button, family_manager_email."
                ),
                schema=ProStatusSchema,
            )

            if not extract_result.success or not extract_result.data:
                logger.warning("AI 提取失败，返回未知状态")
                return ProStatusResult(
                    status=ProStatus.UNKNOWN,
                    is_pro=False,
                    method_used="extraction_failed",
                )

            data = extract_result.data

            # 解析结果
            is_subscribed = data.get("is_subscribed", False)
            is_trial = data.get("is_trial", False)
            is_family_member = data.get("is_family_member", False)
            has_payment_options = data.get("has_payment_options", False)
            has_manage_family_settings = data.get("has_manage_family_settings", False)
            has_leave_family_button = data.get("has_leave_family_button", False)
            family_manager_email = data.get("family_manager_email")
            method_used = "ai_extraction"

            # 如果有付款选项，则不是家庭组成员
            if has_payment_options:
                is_family_member = False
            else:
                # 无付款入口时，结合家庭特征信号进行第一轮修正
                if has_leave_family_button:
                    is_family_member = True
                elif has_manage_family_settings:
                    is_family_member = False

            # 二次校验（强制）：只要是 Pro 用户，就额外走一次家庭组状态检测
            # Why:
            # - 业务规则要求：先判断是否 Pro，再判断是否家庭 Pro。
            # - 仅依赖一次 extract 的 is_family_member 在不同语言/布局下容易误判。
            if is_subscribed:
                try:
                    family_status = await self.engine.detect_family_status(navigate_if_needed=True)
                    if family_status.has_family:
                        if family_status.is_manager:
                            is_family_member = False
                            method_used = "ai_extraction+family_check(manager)"
                        else:
                            is_family_member = True
                            method_used = "ai_extraction+family_check(member)"
                            if not family_manager_email:
                                manager_email = next(
                                    (
                                        member.email
                                        for member in family_status.members
                                        if member.role == FamilyRole.MANAGER and member.email
                                    ),
                                    None,
                                )
                                family_manager_email = manager_email
                    else:
                        # 已订阅但未开通家庭组 => 普通 Pro
                        is_family_member = False
                        method_used = "ai_extraction+family_check(no_family)"
                except Exception as family_error:
                    logger.warning(f"家庭组二次校验失败，保留 AI 提取结果: {family_error}")

            if is_subscribed:
                if is_trial:
                    status = ProStatus.TRIAL
                else:
                    status = ProStatus.ACTIVE
            else:
                status = ProStatus.FREE

            return ProStatusResult(
                status=status,
                is_pro=is_subscribed,
                is_family_member=is_family_member,
                family_manager_email=family_manager_email,
                plan_name=data.get("plan_name"),
                storage_used=data.get("storage_used"),
                storage_total=data.get("storage_total"),
                expiry_date=data.get("expiry_date"),
                confidence=0.95,
                method_used=method_used,
            )

        except Exception as e:
            logger.error(f"AI 提取检测失败: {e}")
            return ProStatusResult(
                status=ProStatus.UNKNOWN,
                is_pro=False,
                method_used=f"extraction_error: {e}",
            )
