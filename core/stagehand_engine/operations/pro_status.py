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
    ProStatus,
    ProStatusResult,
)
from ..constants import GoogleURLs, Timeouts, ProKeywords

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class ProStatusSchema(BaseModel):
    """Pro 状态提取 Schema"""
    is_subscribed: bool = Field(
        default=False,
        description="是否有 Google One 订阅"
    )
    plan_name: Optional[str] = Field(
        default=None,
        description="订阅计划名称，如 '100 GB', '2 TB'"
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
                return keyword_result

            # 4. 使用 AI 提取 (更准确)
            extract_result = await self._detect_by_extraction()

            duration_ms = (time.time() - start_time) * 1000
            logger.info(f"Pro 状态检测完成: {extract_result.status.value}")

            return extract_result

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
            storage_plans = ["2 tb", "200 gb", "100 gb"]
            for plan in storage_plans:
                if plan in page_lower:
                    # 有付费计划，是 Pro
                    return ProStatusResult(
                        status=ProStatus.ACTIVE,
                        is_pro=True,
                        plan_name=plan.upper(),
                        confidence=0.9,
                        method_used="keyword_detection",
                        raw_keywords=matched_positive,
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
            extract_result = await self.engine.extract(
                instruction="""
                提取当前页面的 Google One 订阅信息:
                1. 是否有订阅 (is_subscribed)
                2. 订阅计划名称，如 100 GB, 200 GB, 2 TB (plan_name)
                3. 已使用存储空间 (storage_used)
                4. 总存储空间 (storage_total)
                5. 是否是试用期 (is_trial)
                6. 到期日期 (expiry_date)

                如果是免费 15 GB 用户，is_subscribed 应为 False。
                """,
                schema=ProStatusSchema,
            )

            if not extract_result.success or not extract_result.data:
                return ProStatusResult(
                    status=ProStatus.UNKNOWN,
                    is_pro=False,
                    method_used="extraction_failed",
                )

            data = extract_result.data

            # 解析结果
            is_subscribed = data.get("is_subscribed", False)
            is_trial = data.get("is_trial", False)

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
                plan_name=data.get("plan_name"),
                storage_used=data.get("storage_used"),
                storage_total=data.get("storage_total"),
                expiry_date=data.get("expiry_date"),
                confidence=0.95,
                method_used="ai_extraction",
            )

        except Exception as e:
            logger.error(f"AI 提取检测失败: {e}")
            return ProStatusResult(
                status=ProStatus.UNKNOWN,
                is_pro=False,
                method_used=f"extraction_error: {e}",
            )
