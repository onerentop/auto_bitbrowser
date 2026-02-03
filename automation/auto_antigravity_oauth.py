"""
Antigravity OAuth 自动化

自动完成 Sub2API Antigravity 平台账号添加：
1. 前置检查（去重）
2. 启动 OAuth 流程
3. AI Agent 完成授权
4. 捕获 code 参数
5. 完成 OAuth 并保存状态
"""

import asyncio
import re
from typing import Callable, Optional
from dataclasses import dataclass
from urllib.parse import urlparse, parse_qs

from playwright.async_api import async_playwright, Page, Browser

from core.config_manager import ConfigManager
# 尝试导入 AI Browser Agent 模块
try:
    from core.ai_browser_agent import AIBrowserAgent
    AI_BROWSER_AGENT_AVAILABLE = True
except ImportError:
    AI_BROWSER_AGENT_AVAILABLE = False
    AIBrowserAgent = None
from services.database import DBManager
from services.ix_api import openBrowser
from services.sub2api_client import Sub2APIClient
from automation.auto_google_login import auto_google_login, LoginResult


@dataclass
class OAuthResult:
    """OAuth 结果"""
    success: bool
    message: str
    email: str
    sub2api_account_id: Optional[int] = None
    sub2api_status: str = "not_linked"
    error_type: Optional[str] = None
    total_steps: int = 0


# OAuth 授权提示词模板
OAUTH_AUTHORIZE_PROMPT = """
你是一个专业的浏览器自动化助手，需要完成 Google OAuth 授权任务。

## 当前状态
- 账号: {email}
- 目标: 完成 Antigravity 平台的 OAuth 授权

## 任务目标
在当前页面完成 Google OAuth 授权流程，直到页面跳转到 localhost 回调 URL。

## 操作步骤

### 1. 检查当前页面
- 如果看到"选择账号"页面，选择 {email} 对应的账号
- 如果看到"登录"页面，说明需要先登录（报告此情况）

### 2. 授权页面
- 如果看到授权确认页面（"允许 XXX 访问您的 Google 账号"）
- 点击"允许"或"继续"按钮完成授权
- 可能需要勾选权限复选框

### 3. 等待跳转到回调 URL
- 授权完成后，页面会自动跳转到 localhost:8085/callback?...
- 回调 URL 包含 code= 和 state= 参数

## 注意事项
- 不要点击"取消"或"拒绝"
- 如果看到安全警告，选择继续
- 每一步操作后等待页面响应

## 成功标准（非常重要！）
当页面 URL 变为 localhost:8085/callback?...&code=... 格式时，任务就已经成功！

**特别注意**: 跳转到 localhost 后，页面可能显示:
- "This site can't be reached"
- "localhost refused to connect"
- "ERR_CONNECTION_REFUSED"

这些都是**正常现象**，表示 OAuth 授权已成功完成！
只要 URL 中包含 `code=` 参数，就报告 DONE（任务成功）。
不要报告 ERROR，这不是错误！
"""


async def auto_antigravity_oauth(
    browser_id: str,
    account: dict,
    sub2api_client: Sub2APIClient = None,
    callback: Callable[[str], None] = None,
    api_key: str = None,
    model: str = None,
    provider: str = None,
    max_steps: int = None,
    skip_login_check: bool = False,
) -> OAuthResult:
    """
    执行 Antigravity OAuth 自动化

    Args:
        browser_id: ixBrowser 窗口 ID
        account: 账号信息 {email, password, secret_key, recovery_email}
        sub2api_client: Sub2API 客户端（可选，会自动创建）
        callback: 进度回调函数
        api_key: AI API Key（可选）
        model: AI 模型名称（可选）
        provider: AI 提供商（可选）
        max_steps: 最大步骤数（可选）
        skip_login_check: 是否跳过登录检查

    Returns:
        OAuthResult: OAuth 结果
    """
    email = account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[OAuth] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始 OAuth 流程...")

    # 检查 AI Browser Agent 是否可用
    if not AI_BROWSER_AGENT_AVAILABLE:
        log("❌ AI Browser Agent 不可用")
        return OAuthResult(
            success=False,
            message="AI Browser Agent 不可用",
            email=email,
            error_type="agent_unavailable",
        )

    # 前置检查 1: 检查本地数据库状态
    db_account = DBManager.get_account_by_email(email)
    if db_account and db_account.get("sub2api_account_id"):
        log("⏭️ 账号已关联 Sub2API，跳过")
        return OAuthResult(
            success=True,
            message="账号已关联",
            email=email,
            sub2api_account_id=db_account.get("sub2api_account_id"),
            sub2api_status="linked",
        )

    # 创建或使用传入的客户端
    client_created = False
    if sub2api_client is None:
        sub2api_client = Sub2APIClient()
        await sub2api_client._ensure_session()
        client_created = True

    try:
        # 前置检查 2: 检查 Sub2API 是否已存在该账号
        log("检查账号是否已存在于 Sub2API...")
        existing_id = await sub2api_client.check_account_exists(email)
        if existing_id:
            log(f"⏭️ 账号已存在于 Sub2API (ID: {existing_id})")
            # 更新本地数据库
            DBManager.update_sub2api_status(email, "linked", account_id=existing_id)
            return OAuthResult(
                success=True,
                message="账号已存在于 Sub2API",
                email=email,
                sub2api_account_id=existing_id,
                sub2api_status="linked",
            )

        # 前置检查 3: 检查登录状态
        if not skip_login_check:
            login_status = db_account.get("login_status") if db_account else None
            if login_status != "logged_in":
                log("账号未登录，先执行登录...")
                login_result = await auto_google_login(
                    browser_id=browser_id,
                    account=account,
                    callback=callback,
                    api_key=api_key,
                    model=model,
                    provider=provider,
                )

                if not login_result.success:
                    log(f"❌ 登录失败: {login_result.message}")
                    DBManager.update_sub2api_status(email, "oauth_failed")
                    return OAuthResult(
                        success=False,
                        message=f"登录失败: {login_result.message}",
                        email=email,
                        sub2api_status="oauth_failed",
                        error_type="login_failed",
                    )

        # 更新状态为 OAuth 进行中
        DBManager.update_sub2api_status(email, "linking")

        # 步骤 1: 启动 OAuth 流程
        log("启动 OAuth 流程...")
        start_response = await sub2api_client.start_antigravity_oauth()

        if not start_response.success:
            error_msg = start_response.error or "启动 OAuth 失败"
            log(f"❌ {error_msg}")
            DBManager.update_sub2api_status(email, "oauth_failed")
            return OAuthResult(
                success=False,
                message=error_msg,
                email=email,
                sub2api_status="oauth_failed",
                error_type="oauth_start_failed",
            )

        auth_url = start_response.data.get("auth_url", "")
        session_id = start_response.data.get("session_id", "")
        state = start_response.data.get("state", "")

        if not auth_url or not session_id:
            log("❌ OAuth 响应缺少必要字段")
            DBManager.update_sub2api_status(email, "oauth_failed")
            return OAuthResult(
                success=False,
                message="OAuth 响应缺少必要字段",
                email=email,
                sub2api_status="oauth_failed",
                error_type="invalid_oauth_response",
            )

        log(f"获取到授权 URL，session_id: {session_id[:8]}...")

        # 保存 session_id 到数据库
        DBManager.update_sub2api_status(email, "linking", session_id=session_id)

        # 步骤 2: 打开浏览器并执行授权
        browser = None
        page = None

        result = openBrowser(browser_id)
        if not result.get("success"):
            error_msg = result.get("msg", "打开浏览器失败")
            log(f"❌ {error_msg}")
            DBManager.update_sub2api_status(email, "oauth_failed")
            return OAuthResult(
                success=False,
                message=error_msg,
                email=email,
                sub2api_status="oauth_failed",
                error_type="browser_open_failed",
            )

        ws_endpoint = result.get("data", {}).get("ws", "")

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(ws_endpoint)
            contexts = browser.contexts
            if not contexts:
                DBManager.update_sub2api_status(email, "oauth_failed")
                return OAuthResult(
                    success=False,
                    message="没有找到浏览器上下文",
                    email=email,
                    sub2api_status="oauth_failed",
                    error_type="no_context",
                )

            context = contexts[0]
            pages = context.pages
            page = pages[0] if pages else await context.new_page()

            # 导航到授权 URL
            log("导航到授权页面...")
            await page.goto(auth_url, wait_until="networkidle", timeout=60000)

            # 获取 AI 配置
            if not provider:
                provider = ConfigManager.get_ai_default_provider()
            if not api_key:
                api_key = ConfigManager.get_ai_provider_api_key(provider)
            if not model:
                model = ConfigManager.get_ai_provider_model(provider)
            if not max_steps:
                max_steps = 15  # OAuth 流程通常步骤较少

            base_url = ConfigManager.get_ai_provider_base_url(provider)

            # 构建提示词
            prompt = OAUTH_AUTHORIZE_PROMPT.format(email=email)

            # 创建 AI Agent
            agent = AIBrowserAgent(
                api_key=api_key,
                base_url=base_url,
                model=model,
                provider=provider,
            )

            # 设置回调
            agent.on_step(lambda step, action: log(f"[Agent] 步骤{step}: {action}"))

            # 设置 URL 监控，实时捕获 OAuth code
            # Chrome 在页面加载失败时会将 URL 改为 chrome-error://，所以需要在跳转时就捕获
            captured_code = None
            captured_url = None

            def on_request(request):
                """监控请求，捕获 OAuth 回调"""
                nonlocal captured_code, captured_url
                url = request.url
                if captured_code:
                    return  # 已经捕获了
                if "code=" in url and ("localhost" in url or "callback" in url):
                    try:
                        parsed = urlparse(url)
                        params = parse_qs(parsed.query)
                        if "code" in params:
                            captured_code = params["code"][0]
                            captured_url = url
                            log(f"🎯 [Request] 捕获到授权码 URL: {url[:100]}...")
                    except Exception as e:
                        log(f"解析请求 URL 失败: {e}")

            def on_frame_navigated(frame):
                """监控导航，备用捕获"""
                nonlocal captured_code, captured_url
                if captured_code:
                    return  # 已经捕获了
                try:
                    url = frame.url
                    log(f"[Navigate] 页面跳转: {url[:80]}...")
                    if "code=" in url and ("localhost" in url or "callback" in url):
                        parsed = urlparse(url)
                        params = parse_qs(parsed.query)
                        if "code" in params:
                            captured_code = params["code"][0]
                            captured_url = url
                            log(f"🎯 [Navigate] 捕获到授权码 URL: {url[:100]}...")
                except Exception as e:
                    log(f"处理导航事件失败: {e}")

            # 监听请求事件（最早触发）
            page.on("request", on_request)
            # 监听导航事件（备用）
            page.on("framenavigated", on_frame_navigated)

            log("开始执行授权任务...")

            # 执行授权任务
            task_result = await agent.execute_task(
                page=page,
                goal=prompt,
                start_url=auth_url,
                max_steps=max_steps,
                navigate_first=False,  # 已经导航到 auth_url 了
            )

            # 移除监听器
            try:
                page.remove_listener("request", on_request)
                page.remove_listener("framenavigated", on_frame_navigated)
            except Exception:
                pass  # 忽略移除失败

            log(f"授权任务完成，步骤数: {task_result.total_steps}")

            # 步骤 3: 获取 OAuth code
            # 优先使用实时捕获的 code
            code = captured_code

            if not code:
                # 如果没有捕获到，尝试从当前 URL 提取
                current_url = page.url
                log(f"当前页面 URL: {current_url}")
                code = await _extract_oauth_code(page, timeout=5, log_func=log)

            if not code:
                log("❌ 未能获取授权码")
                DBManager.update_sub2api_status(email, "oauth_failed")
                return OAuthResult(
                    success=False,
                    message="未能获取授权码",
                    email=email,
                    sub2api_status="oauth_failed",
                    error_type="no_oauth_code",
                    total_steps=task_result.total_steps,
                )

            if captured_code:
                log(f"✅ 实时捕获授权码: {code[:20]}...")
            else:
                log(f"✅ 从 URL 提取授权码: {code[:20]}...")

            # 步骤 4: 完成 OAuth
            log("完成 OAuth 流程...")
            complete_response = await sub2api_client.complete_antigravity_oauth(
                session_id=session_id,
                state=state,
                code=code,
            )

            if not complete_response.success:
                error_msg = complete_response.error or "完成 OAuth 失败"
                log(f"❌ {error_msg}")
                DBManager.update_sub2api_status(email, "oauth_failed")
                return OAuthResult(
                    success=False,
                    message=error_msg,
                    email=email,
                    sub2api_status="oauth_failed",
                    error_type="oauth_complete_failed",
                    total_steps=task_result.total_steps,
                )

            # 获取账号 ID
            sub2api_account_id = complete_response.data.get("account_id")

            log(f"✅ OAuth 成功，账号 ID: {sub2api_account_id}")

            # 更新数据库
            DBManager.update_sub2api_status(email, "linked", account_id=sub2api_account_id)

            return OAuthResult(
                success=True,
                message="OAuth 授权成功",
                email=email,
                sub2api_account_id=sub2api_account_id,
                sub2api_status="linked",
                total_steps=task_result.total_steps,
            )

    except Exception as e:
        error_msg = str(e)
        log(f"❌ 异常: {error_msg}")
        DBManager.update_sub2api_status(email, "oauth_failed")
        return OAuthResult(
            success=False,
            message=f"OAuth 异常: {error_msg}",
            email=email,
            sub2api_status="oauth_failed",
            error_type="exception",
        )

    finally:
        # 关闭自动创建的客户端
        if client_created and sub2api_client:
            await sub2api_client.close()


async def _extract_oauth_code(page: Page, timeout: int = 30, log_func: Callable[[str], None] = None) -> Optional[str]:
    """
    从页面 URL 中提取 OAuth code 参数

    Args:
        page: Playwright Page 对象
        timeout: 超时时间（秒）
        log_func: 日志函数

    Returns:
        str: OAuth code，如果未找到返回 None
    """
    def log(msg: str):
        if log_func:
            log_func(msg)
        else:
            print(f"[_extract_oauth_code] {msg}")

    start_time = asyncio.get_event_loop().time()

    while asyncio.get_event_loop().time() - start_time < timeout:
        try:
            current_url = page.url
            log(f"检查 URL: {current_url[:100]}...")

            # 解析 URL 查找 code 参数
            parsed = urlparse(current_url)
            params = parse_qs(parsed.query)

            if "code" in params:
                code = params["code"][0]
                log(f"✅ 找到授权码: {code[:20]}...")
                return code

            # 也检查 fragment（某些 OAuth 实现使用 fragment）
            if parsed.fragment:
                fragment_params = parse_qs(parsed.fragment)
                if "code" in fragment_params:
                    code = fragment_params["code"][0]
                    log(f"✅ 从 fragment 找到授权码: {code[:20]}...")
                    return code

            # 检查是否在回调页面但没有 code（可能是错误）
            if "callback" in current_url or "localhost" in current_url:
                log(f"在回调页面，但未找到 code 参数。query: {parsed.query[:100] if parsed.query else '无'}")

        except Exception as e:
            log(f"提取 code 时出错: {e}")

        await asyncio.sleep(1)

    log(f"超时 {timeout}s，未找到授权码")
    return None


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("OAuth 测试")
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

        async with Sub2APIClient() as client:
            result = await auto_antigravity_oauth(
                browser_id=test_browser_id,
                account=test_account,
                sub2api_client=client,
                callback=print,
            )

            print(f"\n结果: {result}")

    asyncio.run(main())
