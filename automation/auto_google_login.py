"""
Google 账号一键登录

使用 AI Browser Agent 自动完成 Google 登录流程：
1. 打开浏览器窗口
2. 导航到 accounts.google.com
3. AI Agent 自动填写账号密码
4. 处理 2FA 验证（如有）
5. 验证登录成功
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass, field

from playwright.async_api import async_playwright, Page, Browser

from core.config_manager import ConfigManager
# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import (
        AIBrowserAgent,
        TaskResult,
        TaskContext,
        AgentState,
    )
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None
    TaskResult = None
    TaskContext = None
    AgentState = None
from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser


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
    agent_state: Optional[AgentState] = None


# Google 登录提示词模板
GOOGLE_LOGIN_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成 Google 账号登录任务。

## 账号信息
- 邮箱: {email}
- 密码: {password}
{totp_info}
{recovery_info}

## 任务目标
登录 Google 账号并确保登录成功。

## 操作步骤

### 1. 导航到登录页面
- 如果当前页面不是 Google 登录页面，导航到 https://accounts.google.com

### 2. 输入邮箱
- 在邮箱输入框中输入邮箱地址
- 点击"下一步"或按 Enter

### 3. 输入密码
- 等待密码输入框出现
- 输入密码
- 点击"下一步"或按 Enter

### 4. 处理 2FA 验证（如果需要）
{totp_instructions}

### 5. 验证登录成功
- 等待页面跳转
- 检查是否到达 myaccount.google.com 或看到用户头像
- 如果看到任何错误提示（如"密码错误"、"账号不存在"），报告失败

## 注意事项
- 每一步操作后等待页面响应
- 如果出现验证码，尝试完成或报告需要人工干预
- 如果遇到"选择账号"页面，选择对应的账号
- 如果已经登录（看到用户头像或 myaccount 页面），直接报告成功

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

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key, recovery_email}
        callback: 进度回调函数
        api_key: AI API Key（可选，默认从配置读取）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）
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

    # 检查 AI Browser Agent 是否可用
    if not AI_BROWSER_AGENT_AVAILABLE:
        log("❌ AI Browser Agent 不可用")
        return LoginResult(
            success=False,
            message="AI Browser Agent 不可用",
            email=email,
            browser_id=browser_id,
            login_status="login_failed",
            error_type="agent_unavailable",
        )

    # 更新数据库状态为登录中
    DBManager.update_login_status(email, "logging_in")

    browser = None
    page = None

    try:
        # 打开浏览器
        log("打开浏览器窗口...")
        result = openBrowser(browser_id)

        if not result.get("success"):
            error_msg = result.get("msg", "打开浏览器失败")
            log(f"❌ {error_msg}")
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
            log(f"❌ {error_msg}")
            DBManager.update_login_status(email, "login_failed", last_error=error_msg)
            return LoginResult(
                success=False,
                message=error_msg,
                email=email,
                browser_id=browser_id,
                login_status="login_failed",
                error_type="no_ws_endpoint",
            )

        log(f"浏览器已打开，连接 CDP...")

        # 连接浏览器
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                error_msg = "没有找到浏览器上下文"
                log(f"❌ {error_msg}")
                DBManager.update_login_status(email, "login_failed", last_error=error_msg)
                return LoginResult(
                    success=False,
                    message=error_msg,
                    email=email,
                    browser_id=browser_id,
                    login_status="login_failed",
                    error_type="no_context",
                )

            context = contexts[0]
            pages = context.pages
            if pages:
                page = pages[0]
            else:
                page = await context.new_page()

            log("浏览器连接成功，准备 AI Agent...")

            # 构建提示词
            totp_info = ""
            totp_instructions = ""
            if secret_key:
                totp_info = f"- 2FA 密钥: {secret_key}"
                totp_instructions = """
- 如果需要输入验证码，使用提供的 2FA 密钥生成 TOTP 验证码
- 在验证码输入框中输入 6 位数字验证码
- 验证码每 30 秒更新一次，请快速输入
"""
            else:
                totp_instructions = "- 如果需要 2FA 验证但没有密钥，报告需要人工干预"

            recovery_info = ""
            if recovery_email:
                recovery_info = f"- 辅助邮箱: {recovery_email}"

            prompt = GOOGLE_LOGIN_PROMPT.format(
                email=email,
                password=password,
                totp_info=totp_info,
                recovery_info=recovery_info,
                totp_instructions=totp_instructions,
            )

            # 获取 AI 配置
            if not provider:
                provider = ConfigManager.get_ai_default_provider()
            if not api_key:
                api_key = ConfigManager.get_ai_provider_api_key(provider)
            if not model:
                model = ConfigManager.get_ai_provider_model(provider)
            if not max_steps:
                max_steps = ConfigManager.get_ai_max_steps()

            base_url = ConfigManager.get_ai_provider_base_url(provider)

            # 创建 AI Browser Agent
            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )

            # 设置回调
            agent.on_step(lambda step, action: log(f"[Agent] 步骤{step}: {action}"))

            log("开始执行登录任务...")

            # 执行任务
            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url="https://accounts.google.com",
                max_steps=max_steps,
            )

            log(f"任务完成，步骤数: {task_result.total_steps}")

            # 验证登录成功
            current_url = page.url
            login_success = (
                "myaccount.google.com" in current_url or
                "mail.google.com" in current_url or
                task_result.success
            )

            if login_success:
                log("✅ 登录成功")
                DBManager.update_login_status(email, "logged_in")

                # 检测 Google One Pro 会员状态
                is_pro = await _check_google_one_pro_status(page, log)
                if is_pro is not None:
                    DBManager.update_pro_status(email, "yes" if is_pro else "no")
                    log(f"📊 Pro 会员状态: {'是' if is_pro else '否'}")

                return LoginResult(
                    success=True,
                    message="登录成功",
                    email=email,
                    browser_id=browser_id,
                    login_status="logged_in",
                    total_steps=task_result.total_steps,
                    agent_state=task_result.state,
                )
            else:
                error_msg = task_result.message or "登录失败"
                log(f"❌ 登录失败: {error_msg}")
                DBManager.update_login_status(email, "login_failed", last_error=error_msg)
                return LoginResult(
                    success=False,
                    message=error_msg,
                    email=email,
                    browser_id=browser_id,
                    login_status="login_failed",
                    error_type="login_failed",
                    total_steps=task_result.total_steps,
                    agent_state=task_result.state,
                )

    except Exception as e:
        error_msg = str(e)
        log(f"❌ 异常: {error_msg}")
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
        # 不关闭浏览器，保持登录状态供后续 OAuth 使用
        pass


async def _check_google_one_pro_status(
    page: Page,
    log: Callable[[str], None] = None,
) -> bool | None:
    """
    检测 Google One Pro 会员状态

    通过访问 Google One 页面检测当前账号是否是 Pro 会员

    Args:
        page: Playwright Page 对象
        log: 日志回调函数

    Returns:
        True = Pro 会员
        False = 非 Pro 会员
        None = 检测失败
    """
    def _log(msg: str):
        if log:
            log(msg)
        else:
            print(f"[ProCheck] {msg}")

    try:
        _log("正在检测 Google One 会员状态...")

        # 导航到 Google One 页面
        await page.goto("https://one.google.com/", wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(2000)

        # 检查页面内容，寻找 Pro 会员标识
        page_text = await page.inner_text("body")

        # Pro 会员标识关键词
        pro_indicators = [
            "Google One AI Premium",
            "AI Premium",
            "2 TB",
            "Premium plan",
            "Premium 方案",
            "高级会员",
            "您当前的方案",  # 有方案说明是会员
        ]

        # 非会员标识
        non_pro_indicators = [
            "升级",
            "Upgrade",
            "Get Google One",
            "加入 Google One",
            "Choose a plan",
            "选择方案",
            "开始使用",
        ]

        # 检查是否是 Pro 会员
        is_pro = False
        for indicator in pro_indicators:
            if indicator.lower() in page_text.lower():
                _log(f"检测到 Pro 标识: {indicator}")
                is_pro = True
                break

        # 如果没检测到 Pro 标识，检查是否明确是非会员
        if not is_pro:
            for indicator in non_pro_indicators:
                if indicator.lower() in page_text.lower():
                    _log(f"检测到非 Pro 标识: {indicator}")
                    return False

        return is_pro

    except Exception as e:
        _log(f"⚠️ 检测 Pro 状态失败: {e}")
        return None


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
        # 尝试查找用户头像或账号菜单
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
        print("Google Login 测试")
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
