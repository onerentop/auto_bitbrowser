"""
Stagehand Google Engine - 解锁 403 账号操作

解锁被 Google 限制的 403 状态账号
"""

import logging
import time
from typing import Optional, Any, TYPE_CHECKING

from ..types import UnlockResult
from ..constants import GoogleURLs, Timeouts

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class Unlock403Operation:
    """解锁 403 账号操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        validation_url: Optional[str] = None,
        phone_number: Optional[str] = None,
        country_name: str = "United States",
        sms_client: Optional[Any] = None,
        request_id: Optional[str] = None,
        sms_timeout: int = 120,
        sms_interval: int = 5,
        timeout: float = Timeouts.OPERATION,
    ) -> UnlockResult:
        """
        解锁 403 账号

        Args:
            validation_url: 验证 URL (如果已知)
            phone_number: 用于验证的手机号
            country_name: 国家名称
            sms_client: 短信验证服务客户端
            request_id: SMS 请求 ID
            sms_timeout: 等待验证码超时时间（秒）
            sms_interval: 轮询验证码间隔（秒）
            timeout: 超时时间

        Returns:
            UnlockResult
        """
        start_time = time.time()
        logger.info("开始解锁 403 账号操作")

        try:
            # 1. 导航到验证页面
            target_url = validation_url or GoogleURLs.ACCOUNT_VERIFY

            nav_result = await self.engine.navigate(
                target_url,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return UnlockResult(
                    success=False,
                    message="导航到验证页面失败",
                    error=nav_result.error_message,
                    duration_ms=(time.time() - start_time) * 1000,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检测页面状态
            status_result = await self._detect_challenge_type()
            challenge_type = status_result.get("challenge_type", "unknown")

            # 3. 根据挑战类型处理
            if challenge_type == "captcha":
                return await self._handle_captcha(start_time)

            elif challenge_type == "phone_verification":
                return await self._handle_phone_verification(
                    phone_number=phone_number,
                    sms_client=sms_client,
                    request_id=request_id,
                    sms_timeout=sms_timeout,
                    sms_interval=sms_interval,
                    start_time=start_time,
                )

            elif challenge_type == "email_verification":
                return await self._handle_email_verification(start_time)

            elif challenge_type == "identity_verification":
                return await self._handle_identity_verification(start_time)

            elif challenge_type == "no_challenge":
                return UnlockResult(
                    success=True,
                    message="账号无需解锁",
                    duration_ms=(time.time() - start_time) * 1000,
                )

            else:
                return UnlockResult(
                    success=False,
                    message=f"未知的挑战类型: {challenge_type}",
                    error="无法识别验证类型",
                    duration_ms=(time.time() - start_time) * 1000,
                )

        except Exception as e:
            logger.error(f"解锁 403 账号失败: {e}")
            return UnlockResult(
                success=False,
                message=f"操作失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _detect_challenge_type(self) -> dict:
        """检测挑战类型"""
        try:
            extract_result = await self.engine.extract(
                """
                检测当前页面的验证类型：
                1. reCAPTCHA / 验证码图片 / "I'm not a robot"
                2. 手机验证 / "Verify with phone" / "验证手机号"
                3. 邮箱验证 / "Verify with email" / "验证邮箱"
                4. 身份验证 / "Verify it's you" / "验证身份"
                5. 正常登录页面 / "Sign in" / 无特殊验证
                6. 账号被禁用 / "Account disabled" / "账号已被停用"
                """
            )

            if not extract_result.success:
                return {"challenge_type": "unknown"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            # 判断挑战类型
            if any(kw in result_text for kw in ["captcha", "robot", "验证码", "recaptcha"]):
                return {"challenge_type": "captcha"}

            if any(kw in result_text for kw in ["phone", "手机", "sms", "text message"]):
                return {"challenge_type": "phone_verification"}

            if any(kw in result_text for kw in ["email verification", "邮箱验证", "send email"]):
                return {"challenge_type": "email_verification"}

            if any(kw in result_text for kw in ["verify it", "验证身份", "identity"]):
                return {"challenge_type": "identity_verification"}

            if any(kw in result_text for kw in ["disabled", "suspended", "停用", "禁用"]):
                return {"challenge_type": "account_disabled"}

            if any(kw in result_text for kw in ["sign in", "登录", "welcome"]):
                return {"challenge_type": "no_challenge"}

            return {"challenge_type": "unknown"}

        except Exception as e:
            logger.warning(f"检测挑战类型失败: {e}")
            return {"challenge_type": "unknown"}

    async def _handle_captcha(self, start_time: float) -> UnlockResult:
        """处理验证码挑战"""
        try:
            # 尝试点击 reCAPTCHA 复选框
            await self.engine.act(
                "点击 'I'm not a robot' 复选框或 reCAPTCHA 验证区域"
            )
            await self.engine.wait(3000)

            # 检查是否需要图片验证
            check_result = await self.engine.extract(
                "检查是否出现图片验证（如选择交通灯、红绿灯等）"
            )

            if check_result.success and check_result.data:
                result_text = str(check_result.data).lower()
                if any(kw in result_text for kw in ["select", "选择", "click", "点击", "image", "图片"]):
                    return UnlockResult(
                        success=False,
                        message="需要手动完成图片验证",
                        error="需要人工介入完成 CAPTCHA",
                        needs_manual=True,
                        duration_ms=(time.time() - start_time) * 1000,
                    )

            # 检查是否通过验证
            verify_result = await self._verify_unlock()
            return UnlockResult(
                success=verify_result.get("success", False),
                message=verify_result.get("message", "验证码处理完成"),
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            return UnlockResult(
                success=False,
                message=f"验证码处理失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _handle_phone_verification(
        self,
        phone_number: Optional[str],
        sms_client: Optional[Any],
        request_id: Optional[str],
        sms_timeout: int,
        sms_interval: int,
        start_time: float,
    ) -> UnlockResult:
        """处理手机验证"""
        try:
            # 获取页面上显示的手机号（可能是部分隐藏的）
            extract_result = await self.engine.extract(
                "找到页面上显示的手机号（可能是 ***1234 格式）"
            )

            # 如果提供了手机号，输入手机号
            if phone_number:
                await self.engine.act(
                    f"在手机号输入框中输入: {phone_number}"
                )
                await self.engine.wait(1000)

            # 点击发送验证码
            await self.engine.act(
                "点击 'Send' 或 '发送' 或 'Get code' 或 '获取验证码' 按钮"
            )
            await self.engine.wait(3000)

            if sms_client:
                try:
                    import asyncio
                    # 等待并获取验证码
                    verification_code = None
                    elapsed = 0
                    while elapsed < sms_timeout:
                        try:
                            code = await sms_client.get_sms_code(request_id)
                            if code:
                                verification_code = code
                                break
                        except Exception:
                            pass
                        await asyncio.sleep(sms_interval)
                        elapsed += sms_interval

                    if verification_code:
                        await self.engine.act(
                            f"在验证码输入框中输入: {verification_code}"
                        )
                        await self.engine.wait(Timeouts.AFTER_INPUT)

                        await self.engine.act(
                            "点击 'Verify' 或 '验证' 或 'Next' 或 '下一步' 按钮"
                        )
                        await self.engine.wait(3000)

                        verify_result = await self._verify_unlock()
                        return UnlockResult(
                            success=verify_result.get("success", False),
                            message=verify_result.get("message", "手机验证完成"),
                            phone_used=phone_number,
                            sms_code_used=verification_code,
                            duration_ms=(time.time() - start_time) * 1000,
                        )
                    else:
                        return UnlockResult(
                            success=False,
                            message="等待验证码超时",
                            error=f"超过 {sms_timeout} 秒未收到验证码",
                            phone_used=phone_number,
                            can_retry=True,
                            duration_ms=(time.time() - start_time) * 1000,
                        )
                except Exception as e:
                    logger.warning(f"获取验证码失败: {e}")

            return UnlockResult(
                success=False,
                message="需要手动输入验证码",
                error="未提供短信服务或获取验证码失败",
                phone_used=phone_number,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            return UnlockResult(
                success=False,
                message=f"手机验证失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _handle_email_verification(self, start_time: float) -> UnlockResult:
        """处理邮箱验证"""
        try:
            # 点击发送邮件
            await self.engine.act(
                "点击 'Send' 或 '发送' 或 'Send email' 或 '发送邮件' 按钮"
            )
            await self.engine.wait(3000)

            return UnlockResult(
                success=False,
                message="已发送验证邮件，需要手动完成验证",
                error="需要在邮箱中点击验证链接",
                needs_manual=True,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            return UnlockResult(
                success=False,
                message=f"邮箱验证失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _handle_identity_verification(self, start_time: float) -> UnlockResult:
        """处理身份验证"""
        try:
            # 尝试选择验证方式
            observe_result = await self.engine.observe(
                "找到可用的验证方式选项（手机、邮箱、安全密钥等）"
            )

            if observe_result.success and observe_result.actions:
                # 优先选择手机或邮箱验证
                await self.engine.act(
                    "点击手机验证或邮箱验证选项"
                )
                await self.engine.wait(2000)

            return UnlockResult(
                success=False,
                message="需要完成身份验证",
                error="请手动选择并完成验证方式",
                needs_manual=True,
                duration_ms=(time.time() - start_time) * 1000,
            )

        except Exception as e:
            return UnlockResult(
                success=False,
                message=f"身份验证失败: {str(e)}",
                error=str(e),
                duration_ms=(time.time() - start_time) * 1000,
            )

    async def _verify_unlock(self) -> dict:
        """验证解锁是否成功"""
        try:
            current_url = await self.engine.get_current_url()

            # 如果已进入账号页面，解锁成功
            if "myaccount.google.com" in current_url:
                return {"success": True, "message": "解锁成功"}

            if "mail.google.com" in current_url or "google.com" in current_url:
                if "accounts" not in current_url:
                    return {"success": True, "message": "解锁成功"}

            extract_result = await self.engine.extract(
                """
                检查页面状态：
                1. 是否显示账号主页或正常服务页面
                2. 是否仍在验证页面
                3. 是否显示错误信息
                """
            )

            if not extract_result.success:
                return {"success": False, "message": "无法验证解锁结果"}

            data = extract_result.data or {}
            result_text = str(data).lower()

            if any(kw in result_text for kw in ["welcome", "欢迎", "account", "账号", "inbox", "收件箱"]):
                return {"success": True, "message": "解锁成功"}

            return {"success": False, "message": "解锁未完成"}

        except Exception as e:
            logger.warning(f"验证失败: {e}")
            return {"success": False, "error": str(e)}
