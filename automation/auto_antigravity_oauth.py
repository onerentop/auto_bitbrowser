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
import time
from typing import Callable, Optional
from dataclasses import dataclass
from urllib.parse import urlparse, parse_qs

from playwright.async_api import async_playwright, Page
import pyotp

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    AsyncStagehand = None
from services.database import DBManager
from services.ix_api import openBrowser
from services.sub2api_client import Sub2APIClient
from services.proxy_smart_allocator import ProxySmartAllocator
from automation.auto_google_login import auto_google_login
from automation.pro_status_detector import check_login_status_via_stagehand, get_stagehand_config


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
    proxy_allocator: ProxySmartAllocator = None,
    auto_bind_proxy: bool = True,
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
        proxy_allocator: 代理智能分配器（可选）
        auto_bind_proxy: 是否自动绑定代理（默认 True）

    Returns:
        OAuthResult: OAuth 结果
    """
    email = account.get("email", "")
    secret_key = account.get("secret_key", "")

    def log(msg: str):
        """日志输出"""
        print(f"[OAuth] {email}: {msg}")
        if callback:
            callback(f"[{email}] {msg}")

    log("开始 OAuth 流程...")

    # 检查 Stagehand SDK 是否可用
    if not STAGEHAND_AVAILABLE:
        log("❌ Stagehand SDK 不可用")
        return OAuthResult(
            success=False,
            message="Stagehand SDK 不可用",
            email=email,
            error_type="stagehand_unavailable",
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

        # 前置检查 3: 登录状态检查将在打开浏览器后使用 Stagehand AI 进行
        # （移至步骤 2 之后）

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

            # 前置检查 3: 使用 Stagehand AI 检测登录状态
            if not skip_login_check:
                log("使用 Stagehand AI 检测登录状态...")
                is_logged_in = await check_login_status_via_stagehand(
                    page=page,
                    email=email,
                    ws_endpoint=ws_endpoint,
                    log=log,
                )

                # 如果检测失败（返回 None），视为未登录，执行登录流程
                if not is_logged_in:
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

            # 导航到授权 URL
            log("导航到授权页面...")
            await page.goto(auth_url, wait_until="networkidle", timeout=60000)

            # 使用公共函数获取 AI 配置
            model_api_key, model_base_url, stagehand_model = get_stagehand_config(log)

            if not model_api_key or not stagehand_model:
                log("❌ AI 配置不完整")
                DBManager.update_sub2api_status(email, "oauth_failed")
                return OAuthResult(
                    success=False,
                    message="AI 配置不完整，请在设置中配置 AI 提供商和 API Key",
                    email=email,
                    sub2api_status="oauth_failed",
                    error_type="no_api_key",
                )

            # 构建 model_config（用于 extract/act 调用，支持第三方 API）
            model_config = {
                "model_name": stagehand_model,
                "api_key": model_api_key,
            }
            if model_base_url:
                model_config["base_url"] = model_base_url

            if not max_steps:
                max_steps = 15  # OAuth 流程通常步骤较少

            # 设置 URL 监控，实时捕获 OAuth code
            # Chrome 在页面加载失败时会将 URL 改为 chrome-error://，所以需要在跳转时就捕获
            # 重要：OAuth 回调可能在新标签页打开，需要监听所有页面
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

            def setup_page_listeners(target_page):
                """为页面设置事件监听器"""
                target_page.on("request", on_request)
                target_page.on("framenavigated", on_frame_navigated)

            def on_new_page(new_page):
                """当新标签页创建时，为其添加监听器"""
                log(f"[Context] 检测到新标签页创建")
                setup_page_listeners(new_page)

            async def observe_and_click(session, instruction: str, fallback_act: bool = True) -> bool:
                """
                最佳实践：observe 获取元素 -> Playwright 直接点击
                这样只需要一次 LLM 调用，点击操作不需要 LLM

                Args:
                    session: Stagehand session
                    instruction: observe 指令
                    fallback_act: 如果 Playwright 点击失败，是否回退到 act

                Returns:
                    bool: 是否成功点击
                """
                try:
                    observe_response = await session.observe(
                        instruction=instruction,
                        options={"model": model_config},
                    )
                    if not observe_response.data.result:
                        log(f"[Stagehand] observe 未找到元素: {instruction[:50]}...")
                        return False

                    element = observe_response.data.result[0]
                    selector = element.selector if hasattr(element, 'selector') else None
                    description = element.description if hasattr(element, 'description') else str(element)
                    log(f"[Stagehand] 找到元素: {description}")

                    # 优先使用 Playwright 直接点击（无需 LLM）
                    if selector:
                        try:
                            locator = page.locator(f"xpath={selector}").first
                            await locator.wait_for(state="visible", timeout=5000)
                            await locator.click()
                            log(f"[Stagehand] Playwright 点击成功")
                            return True
                        except Exception as pw_error:
                            log(f"[Stagehand] Playwright 点击失败: {pw_error}")

                    # 回退：使用 act（需要 LLM）
                    if fallback_act:
                        try:
                            act_response = await session.act(
                                input=element.to_dict(exclude_none=True) if hasattr(element, 'to_dict') else element,
                            )
                            result_msg = getattr(act_response.data.result, 'message', 'OK') if act_response.data.result else 'OK'
                            log(f"[Stagehand] act 点击结果: {result_msg}")
                            return True
                        except Exception as act_error:
                            log(f"[Stagehand] act 点击失败: {act_error}")

                    return False
                except Exception as e:
                    log(f"[Stagehand] observe_and_click 失败: {e}")
                    return False

            # 监听 context 级别的新页面创建事件
            context.on("page", on_new_page)

            # 为所有已存在的标签页设置监听器
            for existing_page in context.pages:
                setup_page_listeners(existing_page)

            log("开始使用 Stagehand AI 执行授权任务...")

            # 使用 Stagehand AI 执行 OAuth 授权
            total_steps = 0
            async with AsyncStagehand(
                server="local",
                model_api_key=model_api_key,
                local_ready_timeout_s=30.0,
            ) as stagehand_client:
                log("启动 Stagehand session (连接到现有浏览器)...")
                stagehand_session = await stagehand_client.sessions.start(
                    model_name=stagehand_model,
                    browser={
                        "type": "local",
                        "cdp_url": ws_endpoint,
                    },
                )

                try:
                    # 同步 Stagehand 到当前 URL
                    await stagehand_session.navigate(url=auth_url)

                    # 执行 OAuth 授权流程
                    for step in range(1, max_steps + 1):
                        # 检查是否已捕获到授权码
                        if captured_code:
                            log(f"已捕获授权码，结束授权流程")
                            total_steps = step - 1
                            break

                        # 检查当前 URL 是否已跳转到回调
                        try:
                            current_url = page.url
                            if "code=" in current_url and ("localhost" in current_url or "callback" in current_url):
                                log(f"检测到回调 URL，授权完成")
                                total_steps = step - 1
                                break
                        except Exception:
                            pass

                        log(f"[Stagehand] 步骤 {step}/{max_steps}")

                        # 使用 AI 分析当前页面状态
                        extract_response = await stagehand_session.extract(
                            instruction=f"""
                            分析当前 Google OAuth 授权页面的状态。

                            目标账号: {email}

                            请判断当前页面处于哪个阶段，并返回相应的操作建议：

                            1. **选择账号页面**：
                               - 如果看到账号列表，需要选择 {email} 对应的账号
                               - 返回 action: "select_account"

                            2. **2FA/验证码页面**：
                               - 如果看到需要输入 6 位验证码
                               - 返回 action: "enter_totp", needs_totp: true

                            3. **应用确认页面**（重要！）：
                               - 如果看到 "Make sure that you downloaded this app from Google"
                               - 或者看到 "Sign in with Google" 标题和 "Sign in" 按钮
                               - 或者看到 "确保您已从 Google 下载此应用"
                               - 这是确认应用来源的页面，需要点击 "Sign in" 或 "登录" 按钮
                               - 返回 action: "confirm_app"

                            4. **授权确认页面**：
                               - 如果看到 "允许"、"继续"、"Allow"、"Continue" 按钮
                               - 可能需要勾选权限复选框
                               - 返回 action: "authorize"

                            5. **回调页面/完成**：
                               - 如果 URL 包含 localhost 或 callback，且有 code= 参数
                               - 页面可能显示 "无法访问此网站" - 这是正常的！
                               - 返回 action: "done"

                            6. **错误页面**：
                               - 如果看到明确的错误信息
                               - 返回 action: "error", error_message: "错误内容"

                            返回 JSON 格式。
                            """,
                            schema={
                                "type": "object",
                                "properties": {
                                    "action": {
                                        "type": "string",
                                        "description": "需要执行的操作: select_account, enter_totp, confirm_app, authorize, done, error"
                                    },
                                    "needs_totp": {
                                        "type": "boolean",
                                        "description": "是否需要输入 TOTP 验证码"
                                    },
                                    "error_message": {
                                        "type": "string",
                                        "description": "错误信息（如果有）"
                                    },
                                },
                                "required": ["action"],
                            },
                            options={
                                "model": model_config,
                            },
                        )

                        result_data = extract_response.data.result
                        log(f"[Stagehand] 页面分析: {result_data}")

                        if result_data is None:
                            log("[Stagehand] 分析结果为空，尝试通用操作...")
                            # 使用优化的 observe + Playwright 模式
                            clicked = await observe_and_click(
                                stagehand_session,
                                "找到页面上的 '允许'、'继续'、'Allow' 或 'Continue' 按钮"
                            )
                            if not clicked:
                                log("[Stagehand] 未找到可点击的按钮")
                            await page.wait_for_timeout(2000)
                            total_steps = step
                            continue

                        action = result_data.get("action", "")

                        if action == "done":
                            log("[Stagehand] OAuth 授权完成")
                            total_steps = step
                            break

                        elif action == "error":
                            error_msg = result_data.get("error_message", "未知错误")
                            log(f"[Stagehand] 检测到错误: {error_msg}")
                            # 不立即退出，可能是误判
                            total_steps = step
                            continue

                        elif action == "select_account":
                            log(f"[Stagehand] 选择账号: {email}")
                            # 使用优化的 observe + Playwright 模式
                            clicked = await observe_and_click(
                                stagehand_session,
                                f"找到包含 '{email}' 的账号选项或按钮"
                            )
                            if not clicked:
                                # 备选：尝试查找任意账号选项
                                clicked = await observe_and_click(
                                    stagehand_session,
                                    "找到账号选择页面上的账号列表项或账号按钮"
                                )
                            if not clicked:
                                log("[Stagehand] 未找到任何账号元素")
                            await page.wait_for_timeout(2000)
                            total_steps = step

                        elif action == "enter_totp":
                            if secret_key:
                                # 生成 TOTP 验证码
                                totp = pyotp.TOTP(secret_key)
                                totp_code = totp.now()
                                log(f"[Stagehand] 输入 TOTP 验证码: {totp_code}")

                                # 等待页面稳定（TOTP 页面可能刚跳转过来）
                                await page.wait_for_timeout(1500)

                                totp_input_success = False
                                try:
                                    # 最佳实践：先 observe 找到元素，再用 Playwright 直接操作
                                    # 这样只需要一次 LLM 调用，后续操作不需要 LLM
                                    log("[Stagehand] 使用 observe + Playwright 模式...")
                                    observe_response = await stagehand_session.observe(
                                        instruction="找到验证码输入框或 OTP 输入框",
                                        options={"model": model_config},
                                    )

                                    if observe_response.data.result:
                                        element = observe_response.data.result[0]
                                        selector = element.selector if hasattr(element, 'selector') else None
                                        log(f"[Stagehand] 找到输入框: {element.description if hasattr(element, 'description') else element}")

                                        if selector:
                                            # 使用 Playwright 的 XPath 定位器直接填充（无需 LLM）
                                            try:
                                                locator = page.locator(f"xpath={selector}").first
                                                await locator.wait_for(state="visible", timeout=5000)
                                                await locator.click()
                                                await locator.fill(totp_code)
                                                log(f"[Stagehand] Playwright XPath 填充成功")
                                                totp_input_success = True
                                            except Exception as xpath_error:
                                                log(f"[Stagehand] XPath 填充失败: {xpath_error}")

                                    # 备选方案1：使用 CSS 选择器
                                    if not totp_input_success:
                                        log("[Stagehand] 尝试 CSS 选择器...")
                                        totp_selectors = [
                                            'input[type="tel"]',
                                            'input[name="totpPin"]',
                                            'input[name="pin"]',
                                            'input[autocomplete="one-time-code"]',
                                            'input[type="text"][inputmode="numeric"]',
                                            'input[aria-label*="code"]',
                                            'input[aria-label*="验证"]',
                                        ]

                                        for selector in totp_selectors:
                                            try:
                                                locator = page.locator(selector).first
                                                if await locator.count() > 0:
                                                    await locator.wait_for(state="visible", timeout=3000)
                                                    await locator.click()
                                                    await locator.fill(totp_code)
                                                    log(f"[Stagehand] CSS 选择器 '{selector}' 输入成功")
                                                    totp_input_success = True
                                                    break
                                            except Exception:
                                                continue

                                    # 备选方案2：键盘直接输入
                                    if not totp_input_success:
                                        log("[Stagehand] 使用键盘直接输入...")
                                        await page.keyboard.type(totp_code, delay=80)
                                        log("[Stagehand] 键盘输入完成")
                                        totp_input_success = True

                                    # 提交验证码：observe 找按钮，Playwright 点击
                                    if totp_input_success:
                                        await page.wait_for_timeout(500)
                                        next_observe = await stagehand_session.observe(
                                            instruction="找到 'Next'、'下一步'、'Verify' 或 '验证' 按钮",
                                            options={"model": model_config},
                                        )
                                        if next_observe.data.result:
                                            next_element = next_observe.data.result[0]
                                            next_selector = next_element.selector if hasattr(next_element, 'selector') else None
                                            if next_selector:
                                                try:
                                                    next_locator = page.locator(f"xpath={next_selector}").first
                                                    await next_locator.click()
                                                    log("[Stagehand] 点击下一步按钮成功")
                                                except Exception:
                                                    # 回退：使用 act
                                                    await stagehand_session.act(
                                                        input=next_element.to_dict(exclude_none=True) if hasattr(next_element, 'to_dict') else next_element,
                                                    )
                                                    log("[Stagehand] 通过 act 点击下一步")
                                        else:
                                            await page.keyboard.press("Enter")
                                            log("[Stagehand] 按 Enter 键提交")

                                except Exception as e:
                                    log(f"[Stagehand] TOTP 输入失败: {e}")
                                    # 最后的备选：键盘输入
                                    try:
                                        await page.keyboard.type(totp_code, delay=80)
                                        await page.keyboard.press("Enter")
                                        log("[Stagehand] TOTP 通过备选键盘输入")
                                    except Exception:
                                        pass

                                await page.wait_for_timeout(2000)
                                total_steps = step
                            else:
                                log("[Stagehand] ❌ 需要 TOTP 但未配置密钥")
                                DBManager.update_sub2api_status(email, "oauth_failed")
                                return OAuthResult(
                                    success=False,
                                    message="需要 2FA 验证但未配置密钥",
                                    email=email,
                                    sub2api_status="oauth_failed",
                                    error_type="totp_required",
                                    total_steps=step,
                                )

                        elif action == "confirm_app":
                            # 处理应用确认页面（"Make sure that you downloaded this app from Google"）
                            log("[Stagehand] 检测到应用确认页面，点击 Sign in 按钮...")
                            # 使用优化的 observe + Playwright 模式
                            clicked = await observe_and_click(
                                stagehand_session,
                                "找到 'Sign in' 或 '登录' 按钮（不是 Cancel 按钮）"
                            )
                            if not clicked:
                                # 备选：尝试查找任何确认按钮
                                clicked = await observe_and_click(
                                    stagehand_session,
                                    "找到页面右侧的确认按钮（不是 Cancel）"
                                )
                            if not clicked:
                                log("[Stagehand] 未找到任何确认按钮")
                            await page.wait_for_timeout(2000)
                            total_steps = step

                        elif action == "authorize":
                            log("[Stagehand] 点击授权按钮...")
                            # 先尝试查找并勾选所有复选框
                            try:
                                checkbox_observe = await stagehand_session.observe(
                                    instruction="找到页面上所有未勾选的权限复选框",
                                    options={"model": model_config},
                                )
                                if checkbox_observe.data.result:
                                    for checkbox in checkbox_observe.data.result:
                                        try:
                                            # 优先使用 Playwright 点击
                                            selector = checkbox.selector if hasattr(checkbox, 'selector') else None
                                            if selector:
                                                try:
                                                    locator = page.locator(f"xpath={selector}").first
                                                    await locator.click()
                                                    log(f"[Stagehand] Playwright 勾选复选框成功")
                                                    continue
                                                except Exception:
                                                    pass
                                            # 回退到 act
                                            await stagehand_session.act(
                                                input=checkbox.to_dict(exclude_none=True) if hasattr(checkbox, 'to_dict') else checkbox,
                                            )
                                            log(f"[Stagehand] 勾选复选框: {checkbox.description if hasattr(checkbox, 'description') else 'checkbox'}")
                                        except Exception:
                                            pass  # 忽略单个复选框勾选失败
                            except Exception:
                                pass  # 可能没有复选框

                            # 使用优化的 observe + Playwright 模式点击授权按钮
                            clicked = await observe_and_click(
                                stagehand_session,
                                "找到 '允许'、'继续'、'Allow' 或 'Continue' 按钮"
                            )
                            if not clicked:
                                # 备选：尝试查找页面上的主要操作按钮
                                clicked = await observe_and_click(
                                    stagehand_session,
                                    "找到页面底部或右侧的主要操作按钮"
                                )
                            if not clicked:
                                log("[Stagehand] 未找到任何可操作按钮")
                            await page.wait_for_timeout(3000)
                            total_steps = step

                        else:
                            log(f"[Stagehand] 未知操作: {action}，尝试通用操作...")
                            # 使用优化的 observe + Playwright 模式
                            clicked = await observe_and_click(
                                stagehand_session,
                                "找到页面上最明显的确认或继续按钮"
                            )
                            if not clicked:
                                log("[Stagehand] 未找到可操作的按钮")
                            await page.wait_for_timeout(2000)
                            total_steps = step

                    else:
                        # 达到最大步骤数
                        log(f"[Stagehand] 达到最大步骤数 {max_steps}")
                        total_steps = max_steps

                finally:
                    try:
                        await stagehand_session.end()
                    except Exception:
                        pass

            # 移除监听器
            try:
                # 移除 context 级别的监听器
                context.remove_listener("page", on_new_page)
                # 移除所有页面的监听器
                for p in context.pages:
                    try:
                        p.remove_listener("request", on_request)
                        p.remove_listener("framenavigated", on_frame_navigated)
                    except Exception:
                        pass
            except Exception:
                pass  # 忽略移除失败

            log(f"授权任务完成，步骤数: {total_steps}")

            # 步骤 3: 获取 OAuth code
            # 优先使用实时捕获的 code
            code = captured_code

            if not code:
                # 如果没有捕获到，检查所有浏览器标签页
                # Google OAuth 可能在新标签页中打开回调 URL
                # 倒序遍历：最新创建的标签页通常在列表末尾，优先检查
                log("检查所有浏览器标签页（从最新到最旧）...")
                all_pages = context.pages
                log(f"共 {len(all_pages)} 个标签页")

                for idx in range(len(all_pages) - 1, -1, -1):
                    check_page = all_pages[idx]
                    try:
                        check_url = check_page.url
                        log(f"标签页 {idx + 1}: {check_url[:80]}...")

                        # 检查是否包含 OAuth 回调参数
                        if "code=" in check_url and ("localhost" in check_url or "callback" in check_url):
                            parsed = urlparse(check_url)
                            params = parse_qs(parsed.query)
                            if "code" in params:
                                code = params["code"][0]
                                log(f"🎯 在标签页 {idx + 1} 找到授权码: {code[:20]}...")
                                break
                    except Exception as e:
                        log(f"检查标签页 {idx + 1} 失败: {e}")
                        continue

            if not code:
                # 最后尝试：从当前页面提取（兼容旧逻辑）
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
                    total_steps=total_steps,
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
                    total_steps=total_steps,
                )

            # 获取账号 ID（尝试多种字段名）
            response_data = complete_response.data or {}
            sub2api_account_id = (
                response_data.get("account_id") or
                response_data.get("id") or
                response_data.get("accountId")
            )

            # 如果响应中没有账号 ID，尝试通过邮箱查询
            if not sub2api_account_id:
                log("响应中没有账号 ID，尝试通过邮箱查询...")
                sub2api_account_id = await sub2api_client.check_account_exists(email)

            log(f"✅ OAuth 成功，账号 ID: {sub2api_account_id}")

            # 更新数据库
            DBManager.update_sub2api_status(email, "linked", account_id=sub2api_account_id)

            # 自动绑定代理（如果启用且有分配器）
            log(f"代理绑定检查: auto_bind_proxy={auto_bind_proxy}, has_allocator={proxy_allocator is not None}, account_id={sub2api_account_id}")
            if auto_bind_proxy and proxy_allocator and sub2api_account_id:
                log("开始自动绑定代理...")
                try:
                    bind_success = await proxy_allocator.allocate_and_bind(
                        sub2api_account_id=sub2api_account_id,
                        browser_profile_id=browser_id,
                        callback=callback,
                    )
                    if bind_success:
                        log("✅ 代理绑定成功")
                    else:
                        log("⚠️ 代理绑定失败（不影响 OAuth 结果）")
                except Exception as e:
                    log(f"⚠️ 代理绑定异常: {e}（不影响 OAuth 结果）")

            return OAuthResult(
                success=True,
                message="OAuth 授权成功",
                email=email,
                sub2api_account_id=sub2api_account_id,
                sub2api_status="linked",
                total_steps=total_steps,
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

    start_time = time.time()

    while time.time() - start_time < timeout:
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
