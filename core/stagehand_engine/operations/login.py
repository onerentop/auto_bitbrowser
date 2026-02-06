"""
Stagehand Google Engine - 登录操作

实现 Google 账号登录流程，包括:
- 邮箱密码登录
- TOTP 两步验证
- 登录状态检测
- 错误处理
"""

import logging
import time
from typing import Optional, TYPE_CHECKING

import pyotp

from ..types import (
    OperationStatus,
    LoginState,
    LoginResult,
    TwoFactorMethod,
)
from ..constants import GoogleURLs, Timeouts, LoginKeywords

if TYPE_CHECKING:
    from ..engine import StagehandGoogleEngine

logger = logging.getLogger(__name__)


class LoginOperation:
    """Google 登录操作"""

    def __init__(self, engine: "StagehandGoogleEngine"):
        self.engine = engine

    async def execute(
        self,
        email: str,
        password: str,
        totp_secret: Optional[str] = None,
        recovery_email: Optional[str] = None,
        timeout: float = Timeouts.LOGIN_TOTAL,
    ) -> LoginResult:
        """
        执行 Google 登录

        Args:
            email: 邮箱地址
            password: 密码
            totp_secret: TOTP 密钥
            recovery_email: 辅助邮箱
            timeout: 超时时间

        Returns:
            LoginResult
        """
        start_time = time.time()
        logger.info(f"开始 Google 登录: {email}")

        try:
            # 1. 导航到登录页
            nav_result = await self.engine.navigate(
                GoogleURLs.LOGIN,
                timeout=Timeouts.NAVIGATION,
            )

            if not nav_result.success:
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.UNKNOWN,
                    error=f"无法导航到登录页: {nav_result.error_message}",
                    error_type="navigation_failed",
                    account_email=email,
                )

            await self.engine.wait(Timeouts.AFTER_NAVIGATION)

            # 2. 检查是否已登录
            if await self._check_already_logged_in():
                duration_ms = (time.time() - start_time) * 1000
                return LoginResult(
                    success=True,
                    status=OperationStatus.SUCCESS,
                    login_state=LoginState.LOGGED_IN,
                    message="已登录",
                    account_email=email,
                    duration_ms=duration_ms,
                )

            # 3. 处理账号选择器
            await self._handle_account_chooser()

            # 4. 输入邮箱
            email_result = await self._enter_email(email)
            if not email_result:
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.LOGGED_OUT,
                    error="无法输入邮箱",
                    error_type="email_input_failed",
                    account_email=email,
                )

            await self.engine.wait(Timeouts.AFTER_CLICK)

            # 5. 点击下一步
            await self.engine.act("点击下一步按钮")
            await self.engine.wait(Timeouts.AFTER_CLICK * 2)

            # 6. 检测页面状态
            page_state = await self._detect_page_state()

            # 账号不存在
            if page_state == "account_not_found":
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.ACCOUNT_NOT_FOUND,
                    error="账号不存在",
                    error_type="account_not_found",
                    account_email=email,
                )

            # 账号被禁用
            if page_state == "account_disabled":
                return LoginResult(
                    success=False,
                    status=OperationStatus.BLOCKED,
                    login_state=LoginState.ACCOUNT_DISABLED,
                    error="账号已被停用",
                    error_type="account_disabled",
                    account_email=email,
                )

            # 需要验证码
            if page_state == "captcha":
                return LoginResult(
                    success=False,
                    status=OperationStatus.BLOCKED,
                    login_state=LoginState.CAPTCHA_REQUIRED,
                    error="需要验证码",
                    error_type="captcha_required",
                    account_email=email,
                )

            # 7. 输入密码
            password_result = await self._enter_password(password)
            if not password_result:
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.NEED_PASSWORD,
                    error="无法输入密码",
                    error_type="password_input_failed",
                    account_email=email,
                )

            await self.engine.wait(Timeouts.AFTER_CLICK)

            # 8. 点击下一步
            await self.engine.act("点击下一步按钮或登录按钮")
            await self.engine.wait(Timeouts.AFTER_2FA)

            # 9. 检测登录后状态
            post_login_state = await self._detect_page_state()

            # 密码错误
            if post_login_state == "wrong_password":
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.WRONG_PASSWORD,
                    error="密码错误",
                    error_type="wrong_password",
                    can_retry=True,
                    retry_delay_seconds=5,
                    account_email=email,
                )

            # 安全挑战
            if post_login_state == "security_challenge":
                return LoginResult(
                    success=False,
                    status=OperationStatus.PARTIAL,
                    login_state=LoginState.SECURITY_CHALLENGE,
                    message="需要安全验证",
                    error_type="security_challenge",
                    account_email=email,
                )

            # 10. 处理两步验证
            if post_login_state == "2fa_totp":
                if totp_secret:
                    totp_result = await self._handle_totp(totp_secret)
                    if not totp_result:
                        return LoginResult(
                            success=False,
                            status=OperationStatus.FAILED,
                            login_state=LoginState.NEED_2FA,
                            error="两步验证失败",
                            error_type="totp_failed",
                            need_2fa=True,
                            two_fa_method="totp",
                            account_email=email,
                        )
                else:
                    return LoginResult(
                        success=False,
                        status=OperationStatus.PARTIAL,
                        login_state=LoginState.NEED_2FA,
                        message="需要 TOTP 两步验证",
                        need_2fa=True,
                        two_fa_method="totp",
                        account_email=email,
                    )

            elif post_login_state in ["2fa_sms", "2fa_email", "2fa_prompt"]:
                return LoginResult(
                    success=False,
                    status=OperationStatus.PARTIAL,
                    login_state=LoginState.NEED_2FA,
                    message=f"需要两步验证 ({post_login_state})",
                    need_2fa=True,
                    two_fa_method=post_login_state.replace("2fa_", ""),
                    account_email=email,
                )

            # 11. 验证登录成功
            await self.engine.wait(Timeouts.AFTER_2FA)

            if await self._verify_login_success():
                duration_ms = (time.time() - start_time) * 1000
                return LoginResult(
                    success=True,
                    status=OperationStatus.SUCCESS,
                    login_state=LoginState.LOGGED_IN,
                    message="登录成功",
                    account_email=email,
                    duration_ms=duration_ms,
                )
            else:
                return LoginResult(
                    success=False,
                    status=OperationStatus.FAILED,
                    login_state=LoginState.UNKNOWN,
                    error="登录验证失败",
                    error_type="verification_failed",
                    account_email=email,
                )

        except Exception as e:
            logger.error(f"登录失败: {e}")
            return LoginResult(
                success=False,
                status=OperationStatus.FAILED,
                login_state=LoginState.UNKNOWN,
                error=str(e),
                error_type="exception",
                account_email=email,
            )

    async def _check_already_logged_in(self) -> bool:
        """检查是否已登录"""
        current_url = await self.engine.get_current_url()
        if "myaccount.google.com" in current_url:
            return True

        page_content = await self.engine.get_page_content()
        page_lower = page_content.lower()

        for keyword in LoginKeywords.LOGIN_SUCCESS:
            if keyword.lower() in page_lower:
                return True

        return False

    async def _handle_account_chooser(self) -> bool:
        """处理账号选择器页面"""
        try:
            page_content = await self.engine.get_page_content()
            page_lower = page_content.lower()

            chooser_keywords = [
                "use another account",
                "使用其他账号",
                "add another account",
                "choose an account",
            ]

            is_chooser = any(kw.lower() in page_lower for kw in chooser_keywords)

            if is_chooser:
                logger.info("检测到账号选择器，点击使用其他账号")
                await self.engine.act("点击使用其他账号或添加其他账号")
                await self.engine.wait(Timeouts.AFTER_CLICK)
                return True

            return False

        except Exception as e:
            logger.warning(f"处理账号选择器失败: {e}")
            return False

    async def _enter_email(self, email: str) -> bool:
        """输入邮箱"""
        try:
            # 使用自然语言指令输入邮箱
            result = await self.engine.act(
                f"在邮箱或电话号码输入框中输入: {email}"
            )
            return result.success

        except Exception as e:
            logger.error(f"输入邮箱失败: {e}")
            return False

    async def _enter_password(self, password: str) -> bool:
        """输入密码"""
        try:
            # 使用自然语言指令输入密码
            # 注意：日志中不记录密码
            result = await self.engine.act(
                "在密码输入框中输入密码"
            )

            # 如果 act 不能直接输入，尝试使用 Playwright 的 fill
            if not result.success:
                # 尝试直接填充
                try:
                    await self.engine.page.fill(
                        'input[type="password"]',
                        password,
                        timeout=5000
                    )
                    return True
                except Exception:
                    pass

            # 使用更具体的指令
            await self.engine.page.keyboard.type(password)
            return True

        except Exception as e:
            logger.error(f"输入密码失败: {e}")
            return False

    async def _detect_page_state(self) -> str:
        """
        检测当前页面状态

        Returns:
            状态字符串: account_not_found, account_disabled, captcha,
                       wrong_password, security_challenge, 2fa_totp,
                       2fa_sms, 2fa_email, 2fa_prompt, password, success, unknown
        """
        try:
            page_content = await self.engine.get_page_content()
            page_lower = page_content.lower()

            # 账号不存在
            for kw in LoginKeywords.ACCOUNT_NOT_FOUND:
                if kw.lower() in page_lower:
                    return "account_not_found"

            # 账号被禁用
            for kw in LoginKeywords.ACCOUNT_DISABLED:
                if kw.lower() in page_lower:
                    return "account_disabled"

            # 验证码
            for kw in LoginKeywords.CAPTCHA:
                if kw.lower() in page_lower:
                    return "captcha"

            # 密码错误
            for kw in LoginKeywords.WRONG_PASSWORD:
                if kw.lower() in page_lower:
                    return "wrong_password"

            # 安全挑战
            for kw in LoginKeywords.SECURITY_CHALLENGE:
                if kw.lower() in page_lower:
                    return "security_challenge"

            # TOTP 两步验证
            for kw in LoginKeywords.TWO_FA_TOTP:
                if kw.lower() in page_lower:
                    return "2fa_totp"

            # SMS 两步验证
            for kw in LoginKeywords.TWO_FA_SMS:
                if kw.lower() in page_lower:
                    return "2fa_sms"

            # 邮箱两步验证
            for kw in LoginKeywords.TWO_FA_EMAIL:
                if kw.lower() in page_lower:
                    return "2fa_email"

            # Google Prompt
            for kw in LoginKeywords.TWO_FA_PROMPT:
                if kw.lower() in page_lower:
                    return "2fa_prompt"

            # 密码页面
            for kw in LoginKeywords.PASSWORD_PAGE:
                if kw.lower() in page_lower:
                    return "password"

            # 登录成功
            current_url = await self.engine.get_current_url()
            if "myaccount.google.com" in current_url or "one.google.com" in current_url:
                return "success"

            return "unknown"

        except Exception as e:
            logger.error(f"检测页面状态失败: {e}")
            return "unknown"

    async def _handle_totp(self, totp_secret: str) -> bool:
        """
        处理 TOTP 两步验证

        Args:
            totp_secret: TOTP 密钥 (Base32 编码)

        Returns:
            是否成功
        """
        try:
            # 生成 TOTP 验证码
            totp = pyotp.TOTP(totp_secret)
            code = totp.now()

            logger.info("生成 TOTP 验证码，准备输入")

            # 输入验证码
            result = await self.engine.act(
                f"在验证码输入框中输入: {code}"
            )

            if not result.success:
                # 尝试直接输入
                try:
                    await self.engine.page.keyboard.type(code)
                except Exception:
                    pass

            await self.engine.wait(Timeouts.AFTER_INPUT)

            # 点击下一步/验证
            await self.engine.act("点击下一步按钮或验证按钮")
            await self.engine.wait(Timeouts.AFTER_2FA)

            return True

        except Exception as e:
            logger.error(f"TOTP 验证失败: {e}")
            return False

    async def _verify_login_success(self) -> bool:
        """验证登录是否成功"""
        try:
            current_url = await self.engine.get_current_url()

            # 检查 URL
            success_urls = [
                "myaccount.google.com",
                "one.google.com",
                "accounts.google.com/b/",  # 多账号视图
            ]

            for url in success_urls:
                if url in current_url:
                    return True

            # 检查页面内容
            page_content = await self.engine.get_page_content()
            page_lower = page_content.lower()

            for kw in LoginKeywords.LOGIN_SUCCESS:
                if kw.lower() in page_lower:
                    return True

            return False

        except Exception:
            return False
