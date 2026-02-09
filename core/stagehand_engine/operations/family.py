"""
Stagehand Google Engine - 家庭组管理

检测和管理 Google 家庭组状态
"""

import logging
import time
from typing import Optional, List, TYPE_CHECKING

from pydantic import BaseModel, Field

from ..types import (
    OperationStatus,
    FamilyRole,
    FamilyMember,
    FamilyStatusResult,
)
from ..constants import GoogleURLs, Timeouts, FamilyKeywords

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class FamilyMemberSchema(BaseModel):
    """家庭成员 Schema"""
    email: str = Field(description="成员邮箱")
    name: Optional[str] = Field(default=None, description="成员名称")
    is_manager: bool = Field(default=False, description="是否是管理员")


class FamilyStatusSchema(BaseModel):
    """家庭组状态提取 Schema"""
    has_family: bool = Field(
        default=False,
        description="是否有家庭组"
    )
    is_manager: bool = Field(
        default=False,
        description="当前用户是否是家庭组管理员"
    )
    family_name: Optional[str] = Field(
        default=None,
        description="家庭组名称"
    )
    member_count: int = Field(
        default=0,
        description="家庭组成员数量"
    )
    members: List[FamilyMemberSchema] = Field(
        default_factory=list,
        description="家庭组成员列表"
    )
    sharing_enabled: bool = Field(
        default=False,
        description="是否启用了订阅共享"
    )


class FamilyOperation:
    """家庭组操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        navigate_if_needed: bool = True,
        timeout: float = Timeouts.EXTRACT,
    ) -> FamilyStatusResult:
        """
        检测家庭组状态

        Args:
            navigate_if_needed: 是否自动导航到家庭组页面
            timeout: 超时时间

        Returns:
            FamilyStatusResult
        """
        start_time = time.time()
        logger.info("开始检测家庭组状态")

        try:
            # 1. 检查是否需要导航
            current_url = await self.engine.get_current_url()

            if navigate_if_needed and "families.google.com" not in current_url:
                nav_result = await self.engine.navigate(
                    GoogleURLs.FAMILY,
                    timeout=Timeouts.NAVIGATION,
                )

                if not nav_result.success:
                    return FamilyStatusResult(
                        has_family=False,
                        role=FamilyRole.NONE,
                    )

                await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            if await self._check_login_required():
                return FamilyStatusResult(
                    has_family=False,
                    role=FamilyRole.NONE,
                )

            # 3. 使用关键词检测 (快速方法)
            keyword_result = await self._detect_by_keywords()
            extract_result = await self._detect_by_extraction()

            # 如果明确没有家庭组，直接返回
            if extract_result.has_family:
                return extract_result

            # 4. 使用 AI 提取详细信息
            if keyword_result.has_family:
                return keyword_result

            duration_ms = (time.time() - start_time) * 1000
            logger.info(f"家庭组状态检测完成: has_family={keyword_result.has_family}")

            return FamilyStatusResult(
                has_family=False,
                role=FamilyRole.NONE,
                is_manager=False,
            )

        except Exception as e:
            logger.error(f"家庭组状态检测失败: {e}")
            return FamilyStatusResult(
                has_family=False,
                role=FamilyRole.NONE,
            )

    async def _check_login_required(self) -> bool:
        """检查是否需要登录"""
        current_url = await self.engine.get_current_url()
        return "accounts.google.com" in current_url and "signin" in current_url

    async def _detect_by_keywords(self) -> FamilyStatusResult:
        """使用关键词检测家庭组状态"""
        try:
            page_content = await self.engine.get_page_content()
            page_lower = page_content.lower()

            # 检测无家庭组
            matched_no_family = [
                kw for kw in FamilyKeywords.NO_FAMILY if kw.lower() in page_lower
            ]

            # 检测有家庭组
            matched_has_family = [
                kw for kw in FamilyKeywords.HAS_FAMILY if kw.lower() in page_lower
            ]
            has_family = len(matched_has_family) > len(matched_no_family)

            if not has_family:
                return FamilyStatusResult(
                    has_family=False,
                    role=FamilyRole.NONE,
                    is_manager=False,
                )

            # 检测是否是管理员
            is_manager = False
            for kw in FamilyKeywords.MANAGER:
                if kw.lower() in page_lower:
                    is_manager = True
                    break

            # 检测共享状态
            sharing_enabled = False
            for kw in FamilyKeywords.SHARING_ENABLED:
                if kw.lower() in page_lower:
                    sharing_enabled = True
                    break

            return FamilyStatusResult(
                has_family=True,
                role=FamilyRole.MANAGER if is_manager else FamilyRole.MEMBER,
                is_manager=is_manager,
                sharing_enabled=sharing_enabled,
                can_share_subscription=is_manager,
            )

        except Exception as e:
            logger.warning(f"关键词检测失败: {e}")
            return FamilyStatusResult(
                has_family=False,
                role=FamilyRole.NONE,
            )

    async def _detect_by_extraction(self) -> FamilyStatusResult:
        """使用 AI 提取检测家庭组状态"""
        try:
            # 使用 Stagehand extract 提取结构化数据
            extract_result = await self.engine.extract(
                instruction="""
                提取当前页面的 Google 家庭组信息:
                1. 是否有家庭组 (has_family)
                2. 当前用户是否是管理员 (is_manager)
                3. 家庭组名称 (family_name)
                4. 成员数量 (member_count)
                5. 成员列表，包括邮箱和名称 (members)
                6. 是否启用了订阅共享 (sharing_enabled)

                如果页面显示"创建家庭组"等提示，说明没有家庭组。
                """,
                schema=FamilyStatusSchema,
            )

            if not extract_result.success or not extract_result.data:
                return FamilyStatusResult(
                    has_family=False,
                    role=FamilyRole.NONE,
                )

            data = extract_result.data

            # 解析成员列表
            members = []
            members_data = data.get("members", [])
            for m in members_data:
                if isinstance(m, dict):
                    member = FamilyMember(
                        email=m.get("email", ""),
                        name=m.get("name"),
                        role=FamilyRole.MANAGER if m.get("is_manager") else FamilyRole.MEMBER,
                    )
                    members.append(member)

            has_family = data.get("has_family", False)
            is_manager = data.get("is_manager", False)

            return FamilyStatusResult(
                has_family=has_family,
                role=FamilyRole.MANAGER if is_manager else (
                    FamilyRole.MEMBER if has_family else FamilyRole.NONE
                ),
                is_manager=is_manager,
                family_name=data.get("family_name"),
                member_count=data.get("member_count", len(members)),
                members=members,
                sharing_enabled=data.get("sharing_enabled", False),
                can_share_subscription=is_manager,
            )

        except Exception as e:
            logger.error(f"AI 提取检测失败: {e}")
            return FamilyStatusResult(
                has_family=False,
                role=FamilyRole.NONE,
            )

    async def create_family(self) -> bool:
        """
        创建家庭组

        Returns:
            是否成功创建
        """
        try:
            logger.info("开始创建家庭组")

            # 导航到家庭组页面
            await self.engine.navigate(GoogleURLs.FAMILY)
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 点击创建家庭组
            result = await self.engine.act(
                "点击创建家庭组按钮或开始按钮"
            )

            if not result.success:
                logger.warning("未找到创建家庭组按钮")
                return False

            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # 确认创建
            await self.engine.act("点击确认或继续按钮")
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # 验证创建成功
            status = await self.execute(navigate_if_needed=False)
            return status.has_family

        except Exception as e:
            logger.error(f"创建家庭组失败: {e}")
            return False

    async def invite_member(self, email: str) -> bool:
        """
        邀请成员加入家庭组

        Args:
            email: 邀请的邮箱地址

        Returns:
            是否成功发送邀请
        """
        try:
            logger.info(f"邀请成员加入家庭组: {email}")

            # 导航到家庭组成员页面
            await self.engine.navigate(GoogleURLs.FAMILY_MEMBERS)
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 点击邀请/添加成员
            result = await self.engine.act(
                "点击邀请成员或添加成员按钮"
            )

            if not result.success:
                logger.warning("未找到邀请成员按钮")
                return False

            await self.engine.wait(Timeouts.AFTER_CLICK)

            # 输入邮箱
            await self.engine.act(f"在邮箱输入框中输入: {email}")
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # 发送邀请
            await self.engine.act("点击发送邀请或确认按钮")
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            logger.info(f"已发送邀请到: {email}")
            return True

        except Exception as e:
            logger.error(f"邀请成员失败: {e}")
            return False

    async def enable_sharing(self) -> bool:
        """
        启用家庭订阅共享

        Returns:
            是否成功启用
        """
        try:
            logger.info("启用家庭订阅共享")

            # 导航到共享设置页面
            await self.engine.navigate(GoogleURLs.FAMILY_SHARING)
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 点击启用共享
            result = await self.engine.act(
                "点击启用共享或开启共享开关"
            )

            if not result.success:
                # 可能已经启用
                status = await self.execute(navigate_if_needed=False)
                return status.sharing_enabled

            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # 验证
            status = await self.execute(navigate_if_needed=False)
            return status.sharing_enabled

        except Exception as e:
            logger.error(f"启用共享失败: {e}")
            return False
