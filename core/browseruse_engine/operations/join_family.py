"""
BrowserUse Engine - 加入家庭组操作

接受家庭组邀请并加入，以及发送家庭邀请
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

from ..types import JoinFamilyResult

if TYPE_CHECKING:
    from ..engine import BrowserUseEngine

logger = logging.getLogger(__name__)

# URL 常量
FAMILY_INVITE_URL = "https://myaccount.google.com/family/invitemembers"
FAMILY_DETAILS_URL = "https://families.google.com/families"
GMAIL_URL = "https://mail.google.com"


class JoinFamilyOperation:
    """加入家庭组操作"""

    def __init__(self, engine: "BrowserUseEngine"):
        self.engine = engine

    async def send_invite(
        self,
        invitee_email: str,
        timeout: float = 60000,
    ) -> JoinFamilyResult:
        """
        发送家庭邀请

        Args:
            invitee_email: 被邀请人邮箱
            timeout: 超时时间 (毫秒)

        Returns:
            JoinFamilyResult
        """
        start_time = time.time()
        logger.info(f"开始发送家庭邀请给: {invitee_email}")

        try:
            # 1. 导航到家庭邀请页面
            nav_result = await self.engine.navigate(
                FAMILY_INVITE_URL,
                timeout=30000,
            )

            if not nav_result.success:
                return JoinFamilyResult(
                    success=False,
                    message="导航到家庭邀请页面失败",
                    error=nav_result.error,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(2000)

            # 2. 检测是否需要创建家庭组
            page_content = await self.engine.get_page_content()
            needs_create = self._check_needs_create_family(page_content)

            if needs_create:
                logger.info("检测到需要创建家庭组，开始创建...")
                create_result = await self._create_family()
                if not create_result.get("success"):
                    return JoinFamilyResult(
                        success=False,
                        message="创建家庭组失败",
                        error=create_result.get("error"),
                        duration_ms=(time.time() - start_time) * 1000,
                    )
                logger.info("家庭组创建成功，重新导航到邀请页面...")
                await self.engine.wait(2000)

                # 重新导航到邀请页面
                await self.engine.navigate(FAMILY_INVITE_URL, timeout=30000)
                await self.engine.wait(2000)

            # 3. 检测家庭组是否已满
            if await self._check_family_full():
                return JoinFamilyResult(
                    success=False,
                    message="家庭组已满",
                    error="家庭组成员已达上限 (6人)",
                    error_type="family_full",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 4. 使用 Agent 输入邮箱并发送邀请
            send_result = await self.engine.run(
                task=f"""
                在当前家庭邀请页面完成以下操作：
                1. 找到邮箱输入框（通常有 placeholder 如 "Enter email" 或 "输入电子邮件"）
                2. 在输入框中输入邮箱地址: {invitee_email}
                3. 点击 "Send" 或 "发送" 或 "Invite" 或 "邀请" 按钮

                如果看到确认对话框，点击确认按钮。
                如果看到成功消息如 "Invitation sent"，任务完成。
                如果看到错误消息如 "already in family" 或 "已在家庭组"，报告错误。
                """,
                max_steps=10,
            )

            if not send_result.success:
                return JoinFamilyResult(
                    success=False,
                    message="发送邀请失败",
                    error=send_result.error,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 5. 验证邀请已发送
            await self.engine.wait(2000)
            page_content = await self.engine.get_page_content()

            if self._check_invite_sent(page_content):
                return JoinFamilyResult(
                    success=True,
                    message=f"已发送家庭邀请给 {invitee_email}",
                    invite_sent=True,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            return JoinFamilyResult(
                success=True,
                message=f"邀请操作完成，等待 {invitee_email} 接受",
                invite_sent=True,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"发送家庭邀请失败: {e}")
            return JoinFamilyResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def accept_invite(
        self,
        inviter_email: str,
        timeout: float = 60000,
    ) -> JoinFamilyResult:
        """
        接受家庭邀请

        Args:
            inviter_email: 邀请人邮箱
            timeout: 超时时间 (毫秒)

        Returns:
            JoinFamilyResult
        """
        start_time = time.time()
        logger.info(f"开始接受家庭邀请，邀请人: {inviter_email}")

        try:
            # 1. 导航到 Gmail
            nav_result = await self.engine.navigate(
                GMAIL_URL,
                timeout=30000,
            )

            if not nav_result.success:
                return JoinFamilyResult(
                    success=False,
                    message="导航到 Gmail 失败",
                    error=nav_result.error,
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(3000)

            # 2. 处理 Gmail 首次访问弹窗
            await self._handle_gmail_popups()

            # 3. 使用 Agent 查找并接受邀请
            accept_result = await self.engine.run(
                task=f"""
                在 Gmail 收件箱中完成以下操作：

                步骤 1 - 查找邀请邮件：
                - 在收件箱中查找来自 Google 的家庭邀请邮件
                - 邮件主题通常包含 "family" "invitation" "Google One" "家庭" "邀请"
                - 发件人通常是 "Google" 或 "no-reply@google.com"
                - 点击该邮件打开它

                步骤 2 - 接受邀请：
                - 在邮件内容中找到 "Accept invitation" 或 "接受邀请" 或 "Join" 链接/按钮
                - 点击该链接

                步骤 3 - 确认加入：
                - 在跳转后的页面点击 "Join Family Group" 或 "加入家庭群组" 或 "Join" 按钮
                - 如果看到 "Welcome to the family" 或 "已加入" 表示成功

                注意：
                - 如果看到 "already in a family" 或 "已在家庭组" 错误，报告错误
                - 如果找不到邀请邮件，尝试刷新页面后再查找
                """,
                max_steps=15,
            )

            await self.engine.wait(2000)

            # 4. 验证加入结果
            verify_result = await self._verify_join()

            if verify_result.get("success"):
                return JoinFamilyResult(
                    success=True,
                    message="成功加入家庭组",
                    inviter_email=inviter_email,
                    invite_accepted=True,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            if verify_result.get("error_type") == "already_in_family":
                return JoinFamilyResult(
                    success=False,
                    message="已在其他家庭组中",
                    error="被邀请人已加入其他家庭组",
                    error_type="already_in_family",
                    already_in_family=True,
                    inviter_email=inviter_email,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # Agent 执行结果作为备选判断
            if accept_result.success:
                return JoinFamilyResult(
                    success=True,
                    message="家庭邀请已处理",
                    inviter_email=inviter_email,
                    invite_accepted=True,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            return JoinFamilyResult(
                success=False,
                message="接受邀请失败",
                error=accept_result.error or "无法确认加入结果",
                inviter_email=inviter_email,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            logger.error(f"接受家庭邀请失败: {e}")
            return JoinFamilyResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                inviter_email=inviter_email,
                duration_ms=(time.time() - start_time) * 1000,
            )

    def _check_needs_create_family(self, page_content: str) -> bool:
        """检查是否需要创建家庭组"""
        content_lower = page_content.lower()
        create_keywords = [
            # 英文
            "create a family",
            "create family",
            "create a family group",
            "bring your family together",
            "start a family",
            "no family group",
            "you don't have a family",
            "get more with a family group",
            # 西班牙语
            "crear un grupo familiar",
            "comenzar",
            # 中文
            "创建家庭",
            "创建家庭组",
            "创建家庭群组",
        ]
        return any(kw in content_lower for kw in create_keywords)

    async def _create_family(self) -> dict:
        """创建家庭组"""
        try:
            result = await self.engine.run(
                task="""
                创建一个新的 Google 家庭组：

                1. 查找并点击 "Create a Family Group" 或 "创建家庭组" 或 "Crear un grupo familiar" 蓝色按钮
                2. 如果有确认对话框或条款，点击 "Confirm" 或 "Create" 或确认按钮
                3. 等待家庭组创建完成

                注意：按钮通常是蓝色的，文字可能是：
                - "Create a Family Group"
                - "Create"
                - "Confirm"
                - "创建家庭组"
                - "Crear un grupo familiar"
                """,
                max_steps=8,
            )
            return {"success": result.success, "error": result.error}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _check_family_full(self) -> bool:
        """检查家庭组是否已满"""
        try:
            page_content = await self.engine.get_page_content()
            content_lower = page_content.lower()
            full_keywords = [
                "family is full",
                "已达上限",
                "maximum members",
                "6 members",
                "no more members",
            ]
            return any(kw in content_lower for kw in full_keywords)
        except Exception:
            return False

    def _check_invite_sent(self, page_content: str) -> bool:
        """检查邀请是否已发送"""
        content_lower = page_content.lower()
        sent_keywords = [
            "invitation sent",
            "invite sent",
            "已发送邀请",
            "邀请已发送",
            "pending",
            "待处理",
        ]
        return any(kw in content_lower for kw in sent_keywords)

    async def _handle_gmail_popups(self) -> None:
        """处理 Gmail 首次访问弹窗"""
        try:
            # 使用 Agent 处理可能的弹窗
            await self.engine.run(
                task="""
                如果看到任何 Gmail 弹窗或提示，处理它们：
                - "Turn on smart features" → 点击 "Next"
                - "Smart features in Google Workspace" → 点击 "Next"
                - "Smart features in other Google products" → 点击 "Save"
                - "Reload" 提示 → 点击 "Reload"
                - "Get started with Gmail" → 点击关闭 (X) 或 "Got it"
                - "Enable desktop notifications" → 点击 "No thanks"

                如果没有弹窗或已看到收件箱 (Inbox)，完成任务。
                """,
                max_steps=8,
            )
        except Exception as e:
            logger.debug(f"处理 Gmail 弹窗时出错 (可忽略): {e}")

    async def _verify_join(self) -> dict:
        """验证是否成功加入"""
        try:
            # 检查当前页面 URL
            current_url = await self.engine.get_current_url()
            if "families.google.com" in current_url:
                page_content = await self.engine.get_page_content()
                content_lower = page_content.lower()

                # 成功标志
                success_keywords = [
                    "welcome",
                    "欢迎",
                    "joined",
                    "已加入",
                    "family members",
                    "家庭成员",
                ]
                if any(kw in content_lower for kw in success_keywords):
                    return {"success": True}

                # 错误标志
                if "already in" in content_lower or "已在" in content_lower:
                    return {"success": False, "error_type": "already_in_family"}

            # 导航到家庭页面确认
            await self.engine.navigate(FAMILY_DETAILS_URL)
            await self.engine.wait(2000)

            page_content = await self.engine.get_page_content()
            content_lower = page_content.lower()

            # 检查是否显示家庭成员
            if "family members" in content_lower or "家庭成员" in content_lower:
                return {"success": True}

            return {"success": False}

        except Exception as e:
            logger.warning(f"验证加入失败: {e}")
            return {"success": False, "error": str(e)}
