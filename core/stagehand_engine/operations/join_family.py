"""
Stagehand Google Engine - 加入家庭组操作

接受家庭组邀请并加入
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from ..types import JoinFamilyResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class JoinFamilyOperation:
    """加入家庭组操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        inviter_email: str,
        timeout: float = Timeouts.OPERATION,
    ) -> JoinFamilyResult:
        """
        加入家庭组

        注意: 此操作需要邀请人先发送邀请，然后在被邀请人账号的 Gmail 中接受邀请

        Args:
            inviter_email: 邀请人邮箱
            timeout: 超时时间

        Returns:
            JoinFamilyResult
        """
        start_time = time.time()
        logger.info(f"开始加入家庭组操作，邀请人: {inviter_email}")

        try:
            # 1. 导航到 Gmail
            nav_result = await self.engine.navigate(
                GoogleURLs.GMAIL,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return JoinFamilyResult(
                    success=False,
                    message="导航到 Gmail 失败",
                    error=nav_result.error_message,
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 处理 Gmail 首次访问弹窗
            await self._handle_gmail_popups()

            # 3. 查找家庭邀请邮件
            email_found = await self._find_invite_email(inviter_email)
            if not email_found.get("success"):
                return JoinFamilyResult(
                    success=False,
                    message="未找到家庭邀请邮件",
                    error="请确保邀请人已发送邀请",
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 4. 点击接受邀请链接
            accept_result = await self._accept_invite()
            if not accept_result.get("success"):
                error_type = accept_result.get("error_type")
                if error_type == "already_in_family":
                    return JoinFamilyResult(
                        success=False,
                        message="已在其他家庭组中",
                        error="被邀请人已加入其他家庭组",
                        already_in_family=True,
                        inviter_email=inviter_email,
                        duration_ms=(time.time() - start_time) * 1000,
                    )
                return JoinFamilyResult(
                    success=False,
                    message=accept_result.get("message", "接受邀请失败"),
                    error=accept_result.get("error"),
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 5. 验证加入成功
            verify_result = await self._verify_join()

            if verify_result.get("success"):
                return JoinFamilyResult(
                    success=True,
                    message="成功加入家庭组",
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            return JoinFamilyResult(
                success=False,
                message="无法确认加入结果",
                inviter_email=inviter_email,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"加入家庭组失败: {e}")
            return JoinFamilyResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                inviter_email=inviter_email,
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _handle_gmail_popups(self) -> None:
        """处理 Gmail 首次访问弹窗"""
        popup_attempts = 8

        for _ in range(popup_attempts):
            observe_result = await self.engine.observe(
                """
                检查是否有以下弹窗：
                1. "Turn on smart features" → 查找 "Next" 按钮
                2. "Smart features in Google Workspace" → 查找 "Next" 按钮
                3. "Smart features in other Google products" → 查找 "Save" 按钮
                4. "Reload" 提示 → 查找 "Reload" 按钮
                5. "Get started with Gmail" → 查找关闭按钮（X）或 "Got it" 按钮
                6. "Enable desktop notifications" → 查找 "No thanks" 按钮

                也检测是否已显示收件箱：
                7. "Inbox" 或 "收件箱" 标签
                """
            )

            if not observe_result.success or not observe_result.actions:
                break

            # 检查是否已显示收件箱
            for action in observe_result.actions:
                if isinstance(action, dict):
                    desc = action.get("description", "").lower()
                    if "inbox" in desc or "收件箱" in desc:
                        logger.debug("Gmail 收件箱已显示")
                        return

            # 点击弹窗按钮
            click_result = await self.engine.act(
                "点击弹窗中的 'Next', 'Save', 'Got it', 'No thanks', 'Reload', 或关闭按钮"
            )

            await self.engine.wait(1500)

    async def _find_invite_email(self, inviter_email: str) -> dict:
        """查找家庭邀请邮件"""
        try:
            await self.engine.wait(2000)

            # 观察邮件列表
            observe_result = await self.engine.observe(
                """
                在 Gmail 收件箱中查找家庭邀请邮件：
                1. 来自 "Google" 或 "no-reply@google.com" 的邮件
                2. 主题包含 "family" 或 "家庭" 或 "invitation" 或 "邀请"
                3. 主题包含 "join" 或 "加入" 或 "Google One"
                4. 邮件内容预览包含 "family group" 或 "家庭群组"
                """
            )

            if not observe_result.success or not observe_result.actions:
                # 尝试刷新页面
                await self.engine.navigate(GoogleURLs.GMAIL)
                await self.engine.wait(3000)

                observe_result = await self.engine.observe(
                    "查找来自 Google 的家庭邀请邮件"
                )

            if observe_result.success and observe_result.actions:
                # 点击邮件
                click_result = await self.engine.act(
                    "点击家庭邀请邮件打开它"
                )
                await self.engine.wait(3000)
                return {"success": True}

            return {"success": False}

        except Exception as e:
            logger.warning(f"查找邀请邮件失败: {e}")
            return {"success": False, "error": str(e)}

    async def _accept_invite(self) -> dict:
        """接受邀请"""
        try:
            # 在邮件中查找接受链接
            observe_result = await self.engine.observe(
                """
                在邮件内容中查找接受邀请的链接或按钮：
                1. "Accept invitation" 按钮/链接
                2. "接受邀请" 按钮/链接
                3. "Join family" 链接
                4. "加入家庭" 链接
                5. "Join now" 按钮
                6. "立即加入" 按钮
                """
            )

            if not observe_result.success or not observe_result.actions:
                return {"success": False, "message": "邮件中未找到接受邀请链接"}

            # 点击接受链接
            click_result = await self.engine.act(
                "点击 'Accept invitation' 或 '接受邀请' 或 'Join' 链接"
            )
            await self.engine.wait(5000)  # 等待新页面加载

            # 处理确认页面
            for attempt in range(3):
                # 检查是否有错误
                check_result = await self.engine.extract(
                    """
                    检查页面是否显示：
                    1. "You're already in a family group" 错误
                    2. "已在家庭组中" 或 "只能加入一个家庭" 错误
                    3. "Join Family Group" 确认按钮
                    4. "加入家庭群组" 确认按钮
                    5. 成功加入的提示
                    """
                )

                if check_result.success and check_result.data:
                    result_text = str(check_result.data).lower()
                    if "already in" in result_text or "已在家庭组" in result_text:
                        return {"success": False, "error_type": "already_in_family", "message": "已在其他家庭组中"}

                # 点击加入按钮
                join_result = await self.engine.act(
                    "点击 'Join Family Group' 或 '加入家庭群组' 或 'Join' 或 '加入' 按钮"
                )
                await self.engine.wait(3000)

            return {"success": True}

        except Exception as e:
            logger.warning(f"接受邀请失败: {e}")
            return {"success": False, "error": str(e)}

    async def _verify_join(self) -> dict:
        """验证是否成功加入"""
        try:
            extract_result = await self.engine.extract(
                """
                检查页面是否显示成功加入家庭组的标志：
                1. "Welcome to the family" 文本
                2. "You joined" 或 "已加入" 文本
                3. "Success" 或 "成功" 提示
                4. 家庭成员页面（显示其他成员头像）

                也检测可能的错误：
                5. "already in a family" 或 "已在家庭组" 错误
                """
            )

            if not extract_result.success:
                return {"success": False}

            result_text = str(extract_result.data).lower()

            if any(kw in result_text for kw in ["welcome", "欢迎", "joined", "已加入", "success", "成功"]):
                return {"success": True}

            if "already in" in result_text or "已在" in result_text:
                return {"success": False, "error_type": "already_in_family"}

            return {"success": False}

        except Exception as e:
            logger.warning(f"验证加入失败: {e}")
            return {"success": False, "error": str(e)}
