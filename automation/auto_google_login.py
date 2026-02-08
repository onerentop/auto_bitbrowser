"""
Google 账号一键登录

使用 StagehandGoogleEngine 自动完成 Google 登录流程：
1. 打开浏览器窗口
2. 导航到 accounts.google.com
3. AI 自动填写账号密码
4. 处理 2FA 验证（如有）
5. 验证登录成功
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from services.database import DBManager

# 导入共享的 Pro 状态检测器
from automation.pro_status_detector import (
    check_pro_status_via_stagehand,
    STAGEHAND_AVAILABLE,
)

# 导入 StagehandGoogleEngine
try:
    from core.stagehand_engine import StagehandGoogleEngine
    from core.stagehand_engine.types import LoginState
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None
    LoginState = None


@dataclass
class LoginResult:
    """登录结果"""
    success: bool
    message: str
    email: str
    browser_id: str
    login_status: str  # logged_in / login_failed / not_logged
    error_type: Optional[str] = None
    total_steps: int = 0


async def auto_google_login(
    browser_id: str,
    account: dict,
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = None,
) -> LoginResult:
    """
    执行 Google 账号一键登录

    使用 StagehandGoogleEngine 执行登录任务。

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key, recovery_email}
        callback: 进度回调函数
        api_key: 已废弃，AI 配置从 ConfigManager 读取
        model: 已废弃，AI 配置从 ConfigManager 读取
        provider: 已废弃，AI 配置从 ConfigManager 读取
        max_steps: 已废弃，由 StagehandGoogleEngine 内部控制

    Returns:
        LoginResult: 登录结果
    """
    email = account.get("email", "")
    password = account.get("password", "")
    secret_key = account.get("secret_key", "")
    recovery_email = account.get("recovery_email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[GoogleLogin] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始登录流程...")

    # 检查 StagehandGoogleEngine 是否可用
    if not STAGEHAND_ENGINE_AVAILABLE:
        log("[X] StagehandGoogleEngine 不可用")
        return LoginResult(
            success=False,
            message="StagehandGoogleEngine 不可用",
            email=email,
            browser_id=browser_id,
            login_status="login_failed",
            error_type="stagehand_unavailable",
        )

    # 更新数据库状态为登录中
    DBManager.update_login_status(email, "logging_in")

    engine = None

    try:
        # 连接到 ixBrowser 窗口
        log("连接到 ixBrowser 窗口...")
        engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=browser_id,
            use_config=True,  # 从 ConfigManager 读取 AI 配置
            close_browser_on_exit=False,  # 不关闭浏览器
        )

        log("StagehandGoogleEngine 已连接，开始登录...")

        # 执行登录
        login_result = await engine.login(
            email=email,
            password=password,
            totp_secret=secret_key if secret_key else None,
            recovery_email=recovery_email if recovery_email else None,
        )

        state_value = login_result.login_state.value if login_result.login_state else "unknown"
        log(f"登录结果: success={login_result.success}, state={state_value}")

        if login_result.success:
            log("[OK] 登录成功")
            DBManager.update_login_status(email, "logged_in")

            # 获取 WebSocket 端点用于 Pro 状态检测
            ws_endpoint = engine._cdp_url

            # 检测 Google One Pro 会员状态
            if ws_endpoint:
                pro_status = await check_pro_status_via_stagehand(
                    page=engine.page,  # 传递 page 对象（兼容性保留）
                    email=email,
                    ws_endpoint=ws_endpoint,
                    log=log,
                )

                # 更新数据库
                if pro_status in ("yes", "family_yes"):
                    DBManager.update_pro_status(email, pro_status)
                    status_text = "是" if pro_status == "yes" else "是(家庭组)"
                    log(f"Pro 会员状态: {status_text}")
                elif pro_status == "no":
                    DBManager.update_pro_status(email, "no")
                    log("Pro 会员状态: 否")
                else:
                    log("[!] Pro 会员状态检测失败，将在「检测 Pro」功能中重试")

            return LoginResult(
                success=True,
                message="登录成功",
                email=email,
                browser_id=browser_id,
                login_status="logged_in",
            )
        else:
            # 登录失败，根据状态确定错误类型
            error_msg = login_result.message or login_result.error or "登录失败"
            error_type = "login_failed"

            # 安全检查 login_state 是否为 None
            login_state = login_result.login_state
            if login_state is not None:
                if login_state == LoginState.WRONG_PASSWORD:
                    error_type = "wrong_password"
                    error_msg = "密码错误"
                elif login_state == LoginState.ACCOUNT_NOT_FOUND:
                    error_type = "account_not_found"
                    error_msg = "账号不存在"
                elif login_state == LoginState.ACCOUNT_DISABLED:
                    error_type = "account_disabled"
                    error_msg = "账号已被禁用"
                elif login_state == LoginState.CAPTCHA_REQUIRED:
                    error_type = "captcha_required"
                    error_msg = "需要验证码"
                elif login_state == LoginState.SECURITY_CHALLENGE:
                    error_type = "security_challenge"
                    error_msg = "需要安全挑战验证"
                elif login_state == LoginState.NEED_2FA:
                    error_type = "need_2fa"
                    error_msg = "需要两步验证"

            log(f"[X] {error_msg}")
            DBManager.update_login_status(email, "login_failed", last_error=error_msg)

            return LoginResult(
                success=False,
                message=error_msg,
                email=email,
                browser_id=browser_id,
                login_status="login_failed",
                error_type=error_type,
            )

    except Exception as e:
        error_msg = str(e)
        log(f"[X] 异常: {error_msg}")
        DBManager.update_login_status(email, "login_failed", last_error=error_msg)
        return LoginResult(
            success=False,
            message=f"登录异常: {error_msg}",
            email=email,
            browser_id=browser_id,
            login_status="login_failed",
            error_type="exception",
        )

    finally:
        # 确保清理资源（不关闭浏览器窗口）
        if engine and engine.is_initialized:
            try:
                await engine.stop(close_browser=False)
            except Exception:
                pass


async def check_login_status_quick(engine: "StagehandGoogleEngine") -> bool:
    """
    快速检查当前是否已登录 Google

    Args:
        engine: StagehandGoogleEngine 实例

    Returns:
        bool: 是否已登录
    """
    try:
        current_url = await engine.get_current_url()

        # 检查 URL
        if any(domain in current_url for domain in [
            "myaccount.google.com",
            "mail.google.com",
            "drive.google.com",
            "one.google.com",
        ]):
            return True

        return False

    except Exception:
        return False


# ==================== 测试代码 ====================

if __name__ == "__main__":
    import sys

    async def main():
        print("Google Login 测试 (StagehandGoogleEngine)")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        test_account = {
            "email": "test@gmail.com",
            "password": "test_password",
            "secret_key": "",
            "recovery_email": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        test_browser_id = "12345"

        result = await auto_google_login(
            browser_id=test_browser_id,
            account=test_account,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
