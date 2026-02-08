"""
Stagehand Google Engine - 开启家庭共享操作

为 Google One Pro 账户开启家庭共享功能
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from ..types import EnableSharingResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class EnableSharingOperation:
    """开启家庭共享操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        timeout: float = Timeouts.OPERATION,
    ) -> EnableSharingResult:
        """
        开启家庭共享

        Args:
            timeout: 超时时间

        Returns:
            EnableSharingResult
        """
        start_time = time.time()
        logger.info("开始开启家庭共享操作")

        try:
            # 1. 导航到 Google One 设置页面
            nav_result = await self.engine.navigate(
                GoogleURLs.GOOGLE_ONE_SETTINGS,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return EnableSharingResult(
                    success=False,
                    message="导航到设置页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return EnableSharingResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 检查当前状态
            status_result = await self._check_sharing_status()

            if status_result.get("already_enabled"):
                return EnableSharingResult(
                    success=True,
                    message="家庭共享已开启",
                    was_already_enabled=True,
                    sharing_enabled=True,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if status_result.get("needs_create_family"):
                # 需要先创建家庭组
                create_result = await self._create_family_group()
                if not create_result.get("success"):
                    return EnableSharingResult(
                        success=False,
                        message="需要先创建家庭组",
                        error=create_result.get("error", "创建家庭组失败"),
                        duration_ms=(time.time() - start_time) * 1000,
                    )

            # 4. 开启共享
            enable_result = await self._enable_sharing()

            if enable_result.get("success"):
                return EnableSharingResult(
                    success=True,
                    message="成功开启家庭共享",
                    sharing_enabled=True,
                    family_created=status_result.get("needs_create_family", False),
                    duration_ms=(time.time() - start_time) * 1000,
                )

            return EnableSharingResult(
                success=False,
                message=enable_result.get("message", "开启共享失败"),
                error=enable_result.get("error"),
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"开启家庭共享失败: {e}")
            return EnableSharingResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _check_sharing_status(self) -> dict:
        """检查共享状态"""
        try:
            extract_result = await self.engine.extract(
                """
                在当前 Google One 设置页面，检查以下状态：

                1. 共享已开启标识：
                   - "Share Google One with family" 开关显示为 ON/开启状态
                   - "与家人共享 Google One" 开关已开启
                   - "Sharing with X family members" / "正在与 X 位家庭成员共享"

                2. 需要创建家庭组标识：
                   - "Create a family group" / "创建家庭群组" 按钮
                   - "Start a family group" / "开始使用家庭" 按钮
                   - "Get started" / "开始使用" 按钮

                3. 可以开启共享标识：
                   - "Manage family settings" / "管理家庭设置"
                   - "Share Google One with family" 开关显示为 OFF/关闭状态

                返回检测到的状态。
                """
            )

            if not extract_result.success:
                return {}

            data = extract_result.data or {}
            result_text = str(data).lower()

            # 检测已开启
            if any(kw in result_text for kw in ["sharing with", "正在共享", "共享中", "enabled", "已开启"]):
                return {"already_enabled": True}

            # 检测需要创建家庭组
            if any(kw in result_text for kw in ["create a family", "创建家庭", "start a family", "get started", "开始使用"]):
                return {"needs_create_family": True}

            return {}

        except Exception as e:
            logger.warning(f"检查状态失败: {e}")
            return {}

    async def _create_family_group(self) -> dict:
        """创建家庭组"""
        try:
            # 导航到 People & sharing 页面
            await self.engine.navigate(
                GoogleURLs.PEOPLE_SHARING,
                timeout=Timeouts.NAVIGATION,
            )
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 点击 Get started 按钮
            click_result = await self.engine.act(
                "在 'Your family on Google' 区域点击 'Get started' 或 '开始使用' 按钮"
            )
            await self.engine.wait(3000)

            # 完成创建流程
            for _ in range(5):
                confirm_result = await self.engine.act(
                    "点击 'Create a Family Group' 或 '创建家庭群组' 或 'Confirm' 或 '确认' 或 'Create' 或 '创建' 按钮"
                )

                if not confirm_result.success:
                    break

                await self.engine.wait(2000)

            # 验证创建成功
            await self.engine.navigate(
                GoogleURLs.GOOGLE_ONE_SETTINGS,
                timeout=Timeouts.NAVIGATION,
            )
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            verify_result = await self.engine.extract(
                "检查是否有 'Manage family settings' 或 '管理家庭设置' 或 'Share Google One' 开关"
            )

            if verify_result.success and verify_result.data:
                result_text = str(verify_result.data).lower()
                if any(kw in result_text for kw in ["manage family", "管理家庭", "share"]):
                    return {"success": True}

            return {"success": False, "error": "创建家庭组失败"}

        except Exception as e:
            logger.warning(f"创建家庭组失败: {e}")
            return {"success": False, "error": str(e)}

    async def _enable_sharing(self) -> dict:
        """开启共享"""
        try:
            # Step 1: 展开 Manage family settings（如果需要）
            await self.engine.act(
                "如果看到 'Manage family settings' 或 '管理家庭设置'，点击展开它"
            )
            await self.engine.wait(2000)

            # Step 2: 查找并点击开关
            toggle_result = await self.engine.act(
                "找到 'Share Google One with family' 或 '与家人共享 Google One' 开关，如果是关闭状态就点击开启"
            )
            await self.engine.wait(1500)

            # Step 3: 处理确认弹窗
            await self.engine.act(
                "如果有确认弹窗，点击 'Continue' 或 '继续' 或 'Got it' 或 '知道了' 按钮"
            )
            await self.engine.wait(1000)

            # Step 4: 验证开关状态
            verify_result = await self.engine.extract(
                """
                检查 'Share Google One with family' 开关的当前状态：
                1. 是否显示为 ON/已开启/enabled 状态
                2. 或者页面显示 'Sharing with family' / '正在与家人共享'
                """
            )

            if verify_result.success and verify_result.data:
                result_text = str(verify_result.data).lower()
                if any(kw in result_text for kw in ["enabled", "on", "已开启", "sharing", "共享"]):
                    return {"success": True}

            return {"success": False, "message": "开关状态验证失败"}

        except Exception as e:
            logger.warning(f"开启共享失败: {e}")
            return {"success": False, "error": str(e)}
