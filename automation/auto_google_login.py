"""
Google 账号一键登录

使用 Stagehand AI 自动完成 Google 登录流程：
1. 打开浏览器窗口
2. 导航到 accounts.google.com
3. Stagehand Agent 自动填写账号密码
4. 处理 2FA 验证（如有）
5. 验证登录成功
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from playwright.async_api import async_playwright, Page

from core.config_manager import ConfigManager
from services.database import DBManager
from services.ix_api import openBrowser

# 导入共享的 Pro 状态检测器和 AI 配置函数
from automation.pro_status_detector import (
    check_pro_status_via_stagehand,
    get_stagehand_config,
    STAGEHAND_AVAILABLE,
)

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
except ImportError:
    AsyncStagehand = None


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


# Google 登录指令模板
GOOGLE_LOGIN_INSTRUCTION = """
登录 Google 账号，完成以下步骤：

## 账号信息
- 邮箱: {email}
- 密码: {password}
{totp_info}
{recovery_info}

## 操作步骤

1. **导航到登录页面**
   - 如果当前不在 Google 登录页面，访问 https://accounts.google.com

2. **输入邮箱**
   - 在邮箱输入框中输入: {email}
   - 点击"下一步"按钮

3. **输入密码**
   - 等待密码输入框出现
   - 输入密码: {password}
   - 点击"下一步"按钮

4. **处理 2FA 验证（如果出现）**
{totp_instructions}

5. **验证登录成功**
   - 等待页面跳转完成
   - 确认到达 myaccount.google.com 或看到用户头像
   - 如果看到错误提示（如"密码错误"、"账号不存在"），报告失败

## 注意事项
- 每一步操作后等待页面响应
- 如果遇到"选择账号"页面，选择 {email}
- 如果已经登录（看到用户头像或 myaccount 页面），直接完成任务

## 成功标准
- 页面 URL 包含 myaccount.google.com
- 或者看到用户账号头像/邮箱显示
"""


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

    使用 Stagehand AI agent.execute() 执行登录任务。

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key, recovery_email}
        callback: 进度回调函数
        api_key: 已废弃，AI 配置从 ConfigManager 读取
        model: 已废弃，AI 配置从 ConfigManager 读取
        provider: 已废弃，AI 配置从 ConfigManager 读取
        max_steps: 最大步骤数（可选）

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

    # 检查 Stagehand 是否可用
    if not STAGEHAND_AVAILABLE:
        log("[X] Stagehand SDK 不可用")
        return LoginResult(
            success=False,
            message="Stagehand SDK 不可用",
            email=email,
            browser_id=browser_id,
            login_status="login_failed",
            error_type="stagehand_unavailable",
        )

    # 更新数据库状态为登录中
    DBManager.update_login_status(email, "logging_in")

    try:
        # 打开浏览器
        log("打开浏览器窗口...")
        result = openBrowser(browser_id)

        if not result.get("success"):
            error_msg = result.get("msg", "打开浏览器失败")
            log(f"[X] {error_msg}")
            DBManager.update_login_status(email, "login_failed", last_error=error_msg)
            return LoginResult(
                success=False,
                message=error_msg,
                email=email,
                browser_id=browser_id,
                login_status="login_failed",
                error_type="browser_open_failed",
            )

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            error_msg = "无法获取浏览器 WebSocket 端点"
            log(f"[X] {error_msg}")
            DBManager.update_login_status(email, "login_failed", last_error=error_msg)
            return LoginResult(
                success=False,
                message=error_msg,
                email=email,
                browser_id=browser_id,
                login_status="login_failed",
                error_type="no_ws_endpoint",
            )

        log("浏览器已打开，连接 Stagehand...")

        # 使用公共函数获取 AI 配置
        model_api_key, model_base_url, stagehand_model = get_stagehand_config(log)

        if not model_api_key or not stagehand_model:
            error_msg = "AI 配置不完整，请在设置中配置 AI 提供商和 API Key"
            log(f"[X] {error_msg}")
            DBManager.update_login_status(email, "login_failed", last_error=error_msg)
            return LoginResult(
                success=False,
                message=error_msg,
                email=email,
                browser_id=browser_id,
                login_status="login_failed",
                error_type="no_api_key",
            )

        # 构建登录指令
        totp_info = ""
        totp_instructions = ""
        if secret_key:
            totp_info = f"- TOTP 密钥: {secret_key}"
            totp_instructions = f"""
   - 如果需要输入验证码，使用 TOTP 密钥 {secret_key} 生成 6 位验证码
   - 在验证码输入框中输入验证码
   - 验证码每 30 秒更新，请快速输入"""
        else:
            totp_instructions = "   - 如果需要 2FA 验证但没有密钥，报告需要人工干预"

        recovery_info = ""
        if recovery_email:
            recovery_info = f"- 辅助邮箱: {recovery_email}"

        instruction = GOOGLE_LOGIN_INSTRUCTION.format(
            email=email,
            password=password,
            totp_info=totp_info,
            recovery_info=recovery_info,
            totp_instructions=totp_instructions,
        )

        # 获取最大步骤数
        if not max_steps:
            max_steps = ConfigManager.get_ai_max_steps() or 25

        # 构建 model_config
        model_config = {
            "model_name": stagehand_model,
            "api_key": model_api_key,
        }
        if model_base_url:
            model_config["base_url"] = model_base_url

        # 使用 Stagehand 执行登录
        log("启动 Stagehand session...")

        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=60.0,
        ) as stagehand:
            # 启动 session，连接到现有浏览器
            log("连接到 ixBrowser 窗口...")
            session = await stagehand.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # 先导航到 Google 登录页
                log("导航到 Google 登录页...")
                await session.navigate(
                    url="https://accounts.google.com",
                    options={"wait_until": "domcontentloaded"},
                )

                # 执行登录任务
                log("执行 Stagehand Agent 登录任务...")

                execute_result = await session.execute(
                    agent_config={
                        "model": model_config,
                    },
                    execute_options={
                        "instruction": instruction,
                        "max_steps": max_steps,
                    },
                )

                log(f"Agent 执行完成")

            finally:
                # 结束 session
                try:
                    await session.end()
                except Exception:
                    pass

        # 获取当前 URL 验证登录状态（在 Stagehand session 结束后）
        # 需要重新连接以获取最新页面状态
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if contexts:
                pages = contexts[0].pages
                if pages:
                    current_page = pages[0]
                    current_url = current_page.url

                    # 验证登录成功
                    login_success = (
                        "myaccount.google.com" in current_url or
                        "mail.google.com" in current_url or
                        "drive.google.com" in current_url or
                        "one.google.com" in current_url
                    )

                    if login_success:
                        log("[OK] 登录成功")
                        DBManager.update_login_status(email, "logged_in")

                        # 检测 Google One Pro 会员状态（使用 Stagehand AI）
                        pro_status = await check_pro_status_via_stagehand(
                            page=current_page,
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
                            total_steps=max_steps,
                        )
                    else:
                        # 检查是否还在登录页面（可能登录失败）
                        if "accounts.google.com" in current_url:
                            error_msg = "登录失败，仍在登录页面"
                        else:
                            error_msg = f"登录状态不确定，当前URL: {current_url}"

                        log(f"[X] {error_msg}")
                        DBManager.update_login_status(email, "login_failed", last_error=error_msg)
                        return LoginResult(
                            success=False,
                            message=error_msg,
                            email=email,
                            browser_id=browser_id,
                            login_status="login_failed",
                            error_type="login_failed",
                            total_steps=max_steps,
                        )

        # 如果无法验证，返回不确定结果
        error_msg = "无法验证登录状态"
        log(f"[X] {error_msg}")
        DBManager.update_login_status(email, "login_failed", last_error=error_msg)
        return LoginResult(
            success=False,
            message=error_msg,
            email=email,
            browser_id=browser_id,
            login_status="login_failed",
            error_type="verification_failed",
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


async def check_login_status(page: Page) -> bool:
    """
    检查当前页面是否已登录 Google

    Args:
        page: Playwright Page 对象

    Returns:
        bool: 是否已登录
    """
    try:
        current_url = page.url

        # 检查 URL
        if any(domain in current_url for domain in [
            "myaccount.google.com",
            "mail.google.com",
            "drive.google.com",
        ]):
            return True

        # 检查页面元素
        avatar = await page.query_selector('[data-identifier]')
        if avatar:
            return True

        return False

    except Exception:
        return False


# ==================== 测试代码 ====================

if __name__ == "__main__":
    import sys

    async def main():
        print("Google Login 测试 (Stagehand)")
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
