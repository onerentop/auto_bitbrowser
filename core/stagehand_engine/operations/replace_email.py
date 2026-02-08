"""
Stagehand Google Engine - 替换辅助邮箱操作

替换 Google 账号的恢复邮箱
"""

import logging
import time
from typing import Optional, Any, TYPE_CHECKING

from ..types import ReplaceEmailResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class ReplaceEmailOperation:
    """替换辅助邮箱操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        new_email: str,
        email_service: Optional[Any] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> ReplaceEmailResult:
        """
        替换辅助邮箱

        Args:
            new_email: 新的辅助邮箱
            email_service: 邮件服务 (用于接收验证码)
            timeout: 超时时间

        Returns:
            ReplaceEmailResult
        """
        start_time = time.time()
        logger.info(f"开始替换辅助邮箱为: {new_email}")

        try:
            # 1. 导航到恢复邮箱设置页面
            nav_result = await self.engine.navigate(
                GoogleURLs.RECOVERY_EMAIL,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return ReplaceEmailResult(
                    success=False,
                    message="导航到恢复邮箱设置页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return ReplaceEmailResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 执行替换流程
            replace_result = await self._perform_replace(new_email, email_service)

            duration_ms = (time.time() - start_time) * 1000

            if replace_result.get("success"):
                return ReplaceEmailResult(
                    success=True,
                    message="辅助邮箱替换成功",
                    new_email=new_email,
                    duration_ms=duration_ms,
                )
            else:
                return ReplaceEmailResult(
                    success=False,
                    message=replace_result.get("message", "替换失败"),
                    error=replace_result.get("error"),
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"替换辅助邮箱失败: {e}")
            return ReplaceEmailResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _perform_replace(
        self,
        new_email: str,
        email_service: Optional[Any],
    ) -> dict:
        """执行替换流程"""
        try:
            # Step 1: 检查当前状态
            status_result = await self.engine.extract(
                """
                检查当前恢复邮箱设置页面：
                1. 是否有现有的恢复邮箱
                2. 是否有 "Add recovery email" 或 "添加恢复邮箱" 按钮
                3. 是否有 "Edit" 或 "编辑" 按钮
                """
            )

            # Step 2: 点击添加或编辑按钮
            await self.engine.act(
                "点击 'Add recovery email' 或 '添加恢复邮箱' 或 'Edit' 或 '编辑' 或铅笔图标按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 3: 清除现有邮箱并输入新邮箱
            await self.engine.act(
                "清除邮箱输入框中的现有内容"
            )
            await self.engine.wait(500)

            await self.engine.act(
                f"在恢复邮箱输入框中输入: {new_email}"
            )
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 4: 点击下一步/确认
            await self.engine.act(
                "点击 'Next' 或 '下一步' 或 'Confirm' 或 '确认' 或 'Save' 或 '保存' 按钮"
            )
            await self.engine.wait(3000)

            # Step 5: 检查是否需要验证
            verify_check = await self.engine.extract(
                """
                检查页面是否显示：
                1. 验证码输入框 - 需要输入发送到新邮箱的验证码
                2. 成功消息 - 恢复邮箱已更新
                3. 错误消息 - 无效的邮箱等
                """
            )

            if verify_check.success and verify_check.data:
                result_text = str(verify_check.data).lower()

                # 如果需要验证码
                if "verification" in result_text or "验证码" in result_text or "code" in result_text:
                    if email_service:
                        try:
                            # 假设 email_service 有 get_code 方法
                            verification_code = await email_service.get_code(new_email)
                            if verification_code:
                                await self.engine.act(
                                    f"在验证码输入框中输入: {verification_code}"
                                )
                                await self.engine.wait(Timeouts.AFTER_INPUT)

                                await self.engine.act(
                                    "点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮"
                                )
                                await self.engine.wait(3000)
                        except Exception as e:
                            logger.warning(f"获取验证码失败: {e}")
                            return {
                                "success": False,
                                "message": "需要手动输入验证码",
                                "error": "邮箱验证码获取失败",
                            }
                    else:
                        return {
                            "success": False,
                            "message": "需要手动输入验证码",
                            "error": "未提供邮件服务",
                        }

            # Step 6: 验证替换成功
            verify_result = await self._verify_replacement(new_email)

            return verify_result

        except Exception as e:
            logger.warning(f"替换流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _verify_replacement(self, new_email: str) -> dict:
        """验证替换是否成功"""
        try:
            # 刷新页面
            await self.engine.navigate(GoogleURLs.RECOVERY_EMAIL, timeout=Timeouts.NAVIGATION)
            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            extract_result = await self.engine.extract(
                f"""
                检查页面是否显示：
                1. 新的恢复邮箱 {new_email}
                2. "Recovery email updated" 或 "恢复邮箱已更新" 消息
                3. "Success" 或 "成功" 提示

                也检查错误信息：
                4. "Invalid email" 或 "无效邮箱"
                5. "Error" 或 "错误"
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证替换结果"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            # 检查新邮箱是否出现在页面上
            if new_email.lower() in result_text:
                return {"success": True}

            if any(kw in result_text for kw in ["updated", "已更新", "success", "成功"]):
                return {"success": True}

            if any(kw in result_text for kw in ["invalid", "无效", "error", "错误"]):
                return {"success": False, "message": "邮箱验证失败", "error": "无效的邮箱"}

            return {"success": False, "message": "无法确定替换结果"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
