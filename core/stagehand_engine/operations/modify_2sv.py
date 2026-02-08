"""
Stagehand Google Engine - 修改两步验证手机号操作

修改 Google 账号的 2-Step Verification 手机号
"""

import logging
import time
from typing import Optional, Any, TYPE_CHECKING

from ..types import ModifyPhoneResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class Modify2SVOperation:
    """修改两步验证手机号操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        new_phone: str,
        sms_service: Optional[Any] = None,
        timeout: float = Timeouts.OPERATION,
    ) -> ModifyPhoneResult:
        """
        修改两步验证手机号

        Args:
            new_phone: 新手机号
            sms_service: 短信验证服务 (用于接收验证码)
            timeout: 超时时间

        Returns:
            ModifyPhoneResult
        """
        start_time = time.time()
        logger.info(f"开始修改 2SV 手机号为: {new_phone}")

        try:
            # 1. 导航到 2SV 设置页面
            nav_result = await self.engine.navigate(
                GoogleURLs.TWO_STEP_VERIFICATION,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return ModifyPhoneResult(
                    success=False,
                    message="导航到 2SV 设置页面失败",
                    error=nav_result.error_message,
                    operation_type="2sv",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否需要登录
            current_url = await self.engine.get_current_url()
            if "accounts.google.com" in current_url and "signin" in current_url:
                return ModifyPhoneResult(
                    success=False,
                    message="需要先登录账号",
                    error="未登录",
                    operation_type="2sv",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 3. 检查当前 2SV 状态
            status_result = await self._check_2sv_status()

            if status_result.get("needs_password"):
                # 可能需要重新验证密码
                return ModifyPhoneResult(
                    success=False,
                    message="需要重新验证密码",
                    error="需要密码验证",
                    operation_type="2sv",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            # 4. 执行修改流程
            modify_result = await self._perform_modify(new_phone, sms_service)

            duration_ms = (time.time() - start_time) * 1000

            if modify_result.get("success"):
                return ModifyPhoneResult(
                    success=True,
                    message="2SV 手机号修改成功",
                    new_phone=new_phone,
                    operation_type="2sv",
                    duration_ms=duration_ms,
                )
            else:
                return ModifyPhoneResult(
                    success=False,
                    message=modify_result.get("message", "修改失败"),
                    error=modify_result.get("error"),
                    operation_type="2sv",
                    duration_ms=duration_ms,
                )

        except Exception as e:
            logger.error(f"修改 2SV 手机号失败: {e}")
            return ModifyPhoneResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                operation_type="2sv",
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _check_2sv_status(self) -> dict:
        """检查 2SV 状态"""
        try:
            extract_result = await self.engine.extract(
                """
                检查当前 2-Step Verification 页面状态：
                1. 是否显示密码验证页面
                2. 是否显示现有的手机号
                3. 是否有 "Add a phone" 或 "更改手机号" 按钮
                4. 2SV 是否已启用
                """
            )

            if not extract_result.success:
                return {}

            data = extract_result.data or {}
            result_text = str(data).lower()

            return {
                "needs_password": any(kw in result_text for kw in ["enter your password", "输入密码", "verify"]),
                "has_phone": any(kw in result_text for kw in ["phone", "手机", "number"]),
                "is_enabled": any(kw in result_text for kw in ["2-step", "两步", "enabled", "已启用"]),
            }

        except Exception as e:
            logger.warning(f"检查 2SV 状态失败: {e}")
            return {}

    async def _perform_modify(
        self,
        new_phone: str,
        sms_service: Optional[Any],
    ) -> dict:
        """执行修改流程"""
        try:
            # Step 1: 查找并点击修改/更改按钮
            click_result = await self.engine.act(
                "点击 'Change phone' 或 '更改手机号' 或 'Edit' 或 '编辑' 按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # Step 2: 如果有现有手机号，可能需要先移除
            observe_result = await self.engine.observe(
                "查找页面上的手机号输入框或删除现有手机的选项"
            )

            if observe_result.success and observe_result.actions:
                # 检查是否需要先删除
                for action in observe_result.actions:
                    if isinstance(action, dict):
                        desc = action.get("description", "").lower()
                        if "remove" in desc or "delete" in desc or "移除" in desc or "删除" in desc:
                            await self.engine.act("点击移除或删除现有手机号的按钮")
                            await self.engine.wait(2000)
                            await self.engine.act("确认删除")
                            await self.engine.wait(2000)
                            break

            # Step 3: 添加新手机号
            await self.engine.act(
                "点击 'Add a phone' 或 '添加手机号' 按钮"
            )
            await self.engine.wait(Timeouts.AFTER_CLICK)

            # Step 4: 输入新手机号
            input_result = await self.engine.act(
                f"在手机号输入框中输入: {new_phone}"
            )
            await self.engine.wait(Timeouts.AFTER_INPUT)

            # Step 5: 点击下一步/发送验证码
            await self.engine.act(
                "点击 'Next' 或 '下一步' 或 'Send' 或 '发送验证码' 按钮"
            )
            await self.engine.wait(3000)

            # Step 6: 如果有短信服务，获取验证码
            if sms_service:
                try:
                    # 假设 sms_service 有 get_code 方法
                    verification_code = await sms_service.get_code(new_phone)
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
                        "error": "短信验证码获取失败",
                    }
            else:
                return {
                    "success": False,
                    "message": "需要手动输入验证码",
                    "error": "未提供短信服务",
                }

            # Step 7: 验证修改成功
            verify_result = await self._verify_modification(new_phone)

            return verify_result

        except Exception as e:
            logger.warning(f"修改流程失败: {e}")
            return {"success": False, "message": str(e), "error": str(e)}

    async def _verify_modification(self, new_phone: str) -> dict:
        """验证修改是否成功"""
        try:
            extract_result = await self.engine.extract(
                f"""
                检查页面是否显示修改成功的标志：
                1. 显示新的手机号 {new_phone}
                2. "Success" 或 "成功" 提示
                3. "Phone added" 或 "已添加手机号"

                也检查错误信息：
                4. "Invalid number" 或 "无效号码"
                5. "Error" 或 "错误"
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证修改结果"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            if any(kw in result_text for kw in ["success", "成功", "added", "已添加"]):
                return {"success": True}

            if any(kw in result_text for kw in ["invalid", "无效", "error", "错误"]):
                return {"success": False, "message": "手机号验证失败", "error": "无效的手机号或验证码"}

            return {"success": False, "message": "无法确定修改结果"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
