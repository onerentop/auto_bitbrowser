"""
Google One Pro 会员状态检测器

提供统一的 Pro 状态检测功能，支持 Stagehand AI 检测。
"""

import traceback
from typing import Callable, Optional

from playwright.async_api import Page

from core.config_manager import ConfigManager

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    AsyncStagehand = None


def get_stagehand_config(log: Callable[[str], None] = None) -> tuple[str, str, str]:
    """
    从配置管理获取 Stagehand AI 配置

    使用配置管理中设置的默认 AI 提供商和模型，不硬编码任何模型名称。

    Args:
        log: 可选的日志回调函数

    Returns:
        tuple: (api_key, base_url, stagehand_model)
               如果未配置则返回 (None, None, None)
    """
    # 从配置获取默认提供商
    provider = ConfigManager.get_ai_default_provider()
    api_key = ConfigManager.get_ai_provider_api_key(provider)
    model = ConfigManager.get_ai_provider_model(provider)
    base_url = ConfigManager.get_ai_provider_base_url(provider)

    if not api_key or not model:
        if log:
            log(f"[!] AI 配置不完整: provider={provider}, has_key={bool(api_key)}, model={model}")
        return None, None, None

    # 构建 Stagehand 模型名称格式
    # Anthropic: anthropic/claude-xxx
    # Gemini: google/gemini-xxx
    provider_prefix = "google" if provider == "gemini" else provider
    stagehand_model = f"{provider_prefix}/{model}"

    # 处理 base_url（Anthropic 需要 /v1 后缀）
    model_base_url = None
    if base_url:
        if provider == "anthropic" and not base_url.endswith("/v1"):
            model_base_url = base_url.rstrip("/") + "/v1"
        else:
            model_base_url = base_url

    if log:
        log(f"使用 {provider} 模型: {stagehand_model}")
        if model_base_url:
            log(f"使用第三方 API: {model_base_url}")

    return api_key, model_base_url, stagehand_model


async def check_pro_status_via_stagehand(
    page: Page,
    email: str,
    ws_endpoint: str,
    log: Callable[[str], None] = None,
) -> str | None:
    """
    使用 Stagehand AI 检测 Pro 状态

    通过 Stagehand SDK 连接到现有的 ixBrowser 窗口，
    使用 AI 智能提取 Google One 订阅信息。

    Args:
        page: Playwright Page 对象（已连接到 ixBrowser）
        email: 账号邮箱（用于日志）
        ws_endpoint: ixBrowser 的 WebSocket 端点
        log: 日志回调函数

    Returns:
        "yes" = 普通 Pro 会员（自己订阅）
        "family_yes" = 家庭组 Pro 会员（被邀请）
        "no" = 非 Pro 会员
        None = 检测失败
    """
    def _log(msg: str):
        if log:
            log(msg)
        else:
            print(f"[ProDetector] {msg}")

    if not STAGEHAND_AVAILABLE:
        _log(f"Stagehand SDK 不可用")
        return None

    try:
        _log(f"[AI] 使用 Stagehand AI 检测 Pro 状态...")

        # 使用公共函数获取 AI 配置
        model_api_key, model_base_url, stagehand_model = get_stagehand_config(_log)

        if not model_api_key or not stagehand_model:
            _log(f"[!] 未配置 AI API Key，无法使用 Stagehand")
            return None

        # 构建 model_config（用于 extract 调用）
        model_config = {
            "model_name": stagehand_model,
            "api_key": model_api_key,
        }
        if model_base_url:
            model_config["base_url"] = model_base_url

        # 创建 Stagehand 客户端（使用本地模式）
        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            # 启动 session，连接到现有浏览器
            _log(f"启动 Stagehand session (连接到现有浏览器)...")
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # 同步 Stagehand 到当前 URL
                await session.navigate(url="https://one.google.com/")

                # 使用 AI 提取 Pro 状态
                _log(f"使用 AI 提取订阅信息...")
                extract_response = await session.extract(
                    instruction="""
                    仔细分析当前 Google One 页面，判断用户的会员订阅状态。

                    **重要判断规则（按优先级顺序）：**

                    1. 首先检查是否有"Upgrade"或"升级"按钮：
                       - 如果页面左侧导航栏或页面上有"Upgrade"、"升级"按钮 → 说明是**非会员**
                       - 非会员页面通常显示套餐选择、价格信息

                    2. 如果没有"Upgrade"按钮，检查是否是会员：
                       - 查找"Your membership"、"您的会员资格"、"Member benefits"、"会员福利"
                       - 查找存储空间信息如"100 GB"、"2 TB"、"AI Premium"
                       - 查找"Manage membership"、"管理会员"

                    3. 如果是会员，判断是独立订阅还是家庭组成员：

                       **家庭组成员特征（is_family_member=true）：**
                       - 看到"Shared with you"、"与您共享"
                       - 看到"Family plan"、"家庭方案"但没有付款/账单信息
                       - 看到"Leave family"、"退出家庭"选项
                       - 没有看到"Next payment"、"下次付款"信息
                       - 页面显示是通过其他人的订阅获得的福利

                       **独立订阅者特征（is_family_member=false）：**
                       - 看到"Next payment"、"下次付款"信息
                       - 看到"Cancel membership"、"取消会员"
                       - 看到"Payment method"、"付款方式"
                       - 看到"Manage family"、"管理家庭"（说明是家庭管理员）

                    请返回：
                    - is_subscribed: 是否有 Google One 会员（true/false）
                    - is_family_member: 是否是家庭组成员（被邀请加入的，不是管理员）（true/false）
                    - plan_name: 套餐名称（如"2 TB", "AI Premium", "100 GB"等）
                    - confidence: 判断置信度（0-1）
                    """,
                    schema={
                        "type": "object",
                        "properties": {
                            "is_subscribed": {
                                "type": "boolean",
                                "description": "用户是否有 Google One 会员资格（不论是自己订阅还是家庭共享）。如果页面有 Upgrade 按钮则为 false，如果显示会员福利或存储空间则为 true"
                            },
                            "is_family_member": {
                                "type": "boolean",
                                "description": "如果是会员，是否是通过家庭组共享获得的（被别人邀请加入）。如果没有付款信息或看到 shared with you 则为 true"
                            },
                            "plan_name": {
                                "type": "string",
                                "description": "会员套餐名称，如 2 TB, AI Premium, 100 GB 等"
                            },
                            "confidence": {
                                "type": "number",
                                "description": "判断置信度 0-1"
                            },
                        },
                        "required": ["is_subscribed", "is_family_member", "confidence"],
                    },
                    options={
                        "model": model_config,
                    },
                    page=page,
                )

                # 解析结果
                result_data = extract_response.data.result
                _log(f"Stagehand 提取结果: {result_data}")

                if result_data is None:
                    _log(f"[!] Stagehand 提取结果为空")
                    return None

                is_subscribed = result_data.get("is_subscribed", False)
                is_family_member = result_data.get("is_family_member", False)
                plan_name = result_data.get("plan_name", "")
                confidence = result_data.get("confidence", 0)

                _log(f"AI 分析: 已订阅={is_subscribed}, 家庭成员={is_family_member}, 方案={plan_name}, 置信度={confidence}")

                # 置信度检查
                if confidence < 0.5:
                    _log(f"[!] AI 置信度较低 ({confidence})，建议人工确认")

                # 返回结果
                if not is_subscribed:
                    _log(f"[OK] Stagehand 检测: 非 Pro 会员")
                    return "no"

                # 是 Pro 会员，需要二次确认家庭组状态
                # 导航到会员设置页面进行精确判断
                _log(f"检测到 Pro 会员，正在检查是否为独立订阅...")
                await session.navigate(url="https://one.google.com/settings")

                # 在设置页面检查是否有独立订阅者特有的选项
                settings_response = await session.extract(
                    instruction="""
                    分析当前 Google One 设置页面，判断用户是独立订阅者还是家庭组成员。

                    **关键判断规则：**

                    如果看到以下任一内容，说明是**独立订阅者**（自己付费）：
                    - "Share Google One with family" 开关
                    - "Change payment method" / "更改付款方式"
                    - "Cancel membership" / "取消会员"
                    - "Change membership plan" / "更改会员方案"
                    - "Manage family settings" / "管理家庭设置"

                    如果页面**没有**付款相关选项，或者显示：
                    - "Your membership is shared by..." / "您的会员由...共享"
                    - "Leave family" / "退出家庭"
                    - 只有基本的会员信息，没有付款/取消选项
                    说明是**家庭组成员**（通过别人的订阅获得）

                    请返回：
                    - has_payment_options: 页面是否有付款相关选项（Change payment method, Cancel membership等）
                    - has_share_family_toggle: 页面是否有 "Share Google One with family" 开关
                    - is_independent_subscriber: 是否是独立订阅者（自己付费的）
                    - confidence: 判断置信度
                    """,
                    schema={
                        "type": "object",
                        "properties": {
                            "has_payment_options": {
                                "type": "boolean",
                                "description": "页面是否有付款相关选项"
                            },
                            "has_share_family_toggle": {
                                "type": "boolean",
                                "description": "页面是否有 Share Google One with family 开关"
                            },
                            "is_independent_subscriber": {
                                "type": "boolean",
                                "description": "是否是独立订阅者（自己付费）"
                            },
                            "confidence": {
                                "type": "number",
                                "description": "判断置信度 0-1"
                            },
                        },
                        "required": ["has_payment_options", "has_share_family_toggle", "is_independent_subscriber", "confidence"],
                    },
                    options={
                        "model": model_config,
                    },
                )

                settings_data = settings_response.data.result
                _log(f"设置页面检测结果: {settings_data}")

                if settings_data:
                    has_payment = settings_data.get("has_payment_options", False)
                    has_share_toggle = settings_data.get("has_share_family_toggle", False)
                    is_independent = settings_data.get("is_independent_subscriber", False)
                    settings_confidence = settings_data.get("confidence", 0)

                    _log(f"设置分析: 付款选项={has_payment}, 家庭共享开关={has_share_toggle}, 独立订阅={is_independent}, 置信度={settings_confidence}")

                    # 判断逻辑优先级：
                    # 1. 付款选项或家庭共享开关是**客观 UI 元素**，可信度最高
                    # 2. is_independent_subscriber 是 AI 的主观判断，容易误判
                    # 3. 第一次检测的 is_family_member 如果为 True，应该作为重要参考

                    # 只有存在客观的付款/管理选项，才能判定为独立订阅者
                    if has_payment or has_share_toggle:
                        _log(f"[OK] Stagehand 检测: 普通 Pro 会员 ({plan_name})")
                        return "yes"

                    # 如果第一次检测认为是家庭成员，且设置页面没有付款选项，则信任第一次判断
                    if is_family_member:
                        _log(f"[OK] Stagehand 检测: 家庭组 Pro 会员 ({plan_name})")
                        return "family_yes"

                    # 如果第一次检测不是家庭成员，且 AI 认为是独立订阅者
                    if is_independent and settings_confidence >= 0.7:
                        _log(f"[OK] Stagehand 检测: 普通 Pro 会员 ({plan_name})")
                        return "yes"

                    # 无法确定时，默认为家庭组（保守判断）
                    _log(f"[!] 无法确定订阅类型，默认为家庭组 Pro")
                    return "family_yes"

                # 设置页面提取失败时，信任第一次判断
                if is_family_member:
                    _log(f"[OK] Stagehand 检测: 家庭组 Pro 会员 ({plan_name})")
                    return "family_yes"
                else:
                    _log(f"[OK] Stagehand 检测: 普通 Pro 会员 ({plan_name})")
                    return "yes"

            finally:
                # 确保 session 结束
                try:
                    await session.end()
                except Exception:
                    pass

    except Exception as e:
        _log(f"[!] Stagehand 检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None


async def check_pro_status_simple(
    page: Page,
    log: Callable[[str], None] = None,
) -> bool | None:
    """
    简单的 Pro 状态检测（基于页面文本分析）

    作为 Stagehand AI 检测的备用方案。

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
            print(f"[ProDetector] {msg}")

    try:
        _log("正在检测 Google One 会员状态...")

        # 导航到 Google One 页面
        await page.goto("https://one.google.com/", wait_until="domcontentloaded", timeout=15000)
        await page.wait_for_timeout(2000)

        # 检查页面内容，寻找会员标识
        page_text = await page.inner_text("body")
        page_text_lower = page_text.lower()

        # 非会员标识 - 明确表示用户尚未订阅的关键词
        non_pro_indicators = [
            "Upgrade",
            "升级",
            "升級",
            "Get started",
            "开始使用",
            "Sign up now",
            "Get Google One",
            "获取 Google One",
            "Choose a plan",
            "选择方案",
        ]

        # 第一步：先检查是否有明确的非会员标识
        for indicator in non_pro_indicators:
            if indicator.lower() in page_text_lower:
                _log(f"检测到非 Pro 标识: {indicator}")
                return False

        # Pro 会员标识
        pro_indicators = [
            "Manage membership",
            "管理会员",
            "Cancel membership",
            "取消会员",
            "Your membership",
            "您的会员",
            "Next payment",
            "下次付款",
        ]

        # 第二步：检查是否有 Pro 会员标识
        for indicator in pro_indicators:
            if indicator.lower() in page_text_lower:
                _log(f"检测到 Pro 标识: {indicator}")
                return True

        _log("未检测到明确的会员/非会员标识")
        return None

    except Exception as e:
        _log(f"[!] 检测 Pro 状态失败: {e}")
        return None


async def check_login_status_via_stagehand(
    page: Page,
    email: str,
    ws_endpoint: str,
    log: Callable[[str], None] = None,
) -> bool | None:
    """
    使用 Stagehand AI 检测 Google 账号登录状态

    通过 Stagehand SDK 连接到现有的 ixBrowser 窗口，
    使用 AI 智能判断当前浏览器是否已登录 Google 账号。

    Args:
        page: Playwright Page 对象（已连接到 ixBrowser）
        email: 账号邮箱（用于日志和验证）
        ws_endpoint: ixBrowser 的 WebSocket 端点
        log: 日志回调函数

    Returns:
        True = 已登录（且是目标账号）
        False = 未登录或登录了其他账号
        None = 检测失败
    """
    def _log(msg: str):
        if log:
            log(msg)
        else:
            print(f"[LoginDetector] {msg}")

    if not STAGEHAND_AVAILABLE:
        _log("Stagehand SDK 不可用")
        return None

    try:
        _log("[AI] 使用 Stagehand AI 检测登录状态...")

        # 使用公共函数获取 AI 配置
        model_api_key, model_base_url, stagehand_model = get_stagehand_config(_log)

        if not model_api_key or not stagehand_model:
            _log("[!] 未配置 AI API Key，无法使用 Stagehand")
            return None

        # 构建 model_config
        model_config = {
            "model_name": stagehand_model,
            "api_key": model_api_key,
        }
        if model_base_url:
            model_config["base_url"] = model_base_url

        # 创建 Stagehand 客户端
        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            _log("启动 Stagehand session (连接到现有浏览器)...")
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # 导航到 Google 账号页面检测登录状态
                _log("导航到 Google 账号页面...")
                await session.navigate(url="https://accounts.google.com/")

                # 使用 AI 提取登录状态
                _log("使用 AI 检测登录状态...")
                extract_response = await session.extract(
                    instruction=f"""
                    分析当前 Google 账号页面，判断用户是否已登录。

                    **判断规则：**

                    1. **已登录的特征**：
                       - 页面显示用户头像或用户名
                       - 页面显示邮箱地址（如 xxx@gmail.com）
                       - 页面 URL 是 myaccount.google.com
                       - 看到 "Manage your Google Account" 或 "管理您的 Google 账号"
                       - 看到账号设置选项（安全、隐私、数据等）

                    2. **未登录的特征**：
                       - 看到 "Sign in" 或 "登录" 按钮
                       - 看到邮箱输入框
                       - 页面要求输入密码
                       - 页面 URL 包含 accounts.google.com/signin

                    3. **验证目标账号**：
                       - 如果已登录，检查登录的邮箱是否是: {email}
                       - 如果登录的是其他账号，也视为"未登录目标账号"

                    请返回：
                    - is_logged_in: 是否已登录任意 Google 账号 (true/false)
                    - logged_in_email: 如果已登录，显示的邮箱地址（可能为空）
                    - is_target_account: 是否登录的是目标账号 {email} (true/false)
                    - confidence: 判断置信度 (0-1)
                    """,
                    schema={
                        "type": "object",
                        "properties": {
                            "is_logged_in": {
                                "type": "boolean",
                                "description": "是否已登录任意 Google 账号"
                            },
                            "logged_in_email": {
                                "type": "string",
                                "description": "已登录的邮箱地址，未登录则为空"
                            },
                            "is_target_account": {
                                "type": "boolean",
                                "description": "是否登录的是目标账号"
                            },
                            "confidence": {
                                "type": "number",
                                "description": "判断置信度 0-1"
                            },
                        },
                        "required": ["is_logged_in", "is_target_account", "confidence"],
                    },
                    options={
                        "model": model_config,
                    },
                )

                # 解析结果
                result_data = extract_response.data.result
                _log(f"Stagehand 提取结果: {result_data}")

                if result_data is None:
                    _log("[!] Stagehand 提取结果为空")
                    return None

                is_logged_in = result_data.get("is_logged_in", False)
                logged_in_email = result_data.get("logged_in_email", "")
                is_target_account = result_data.get("is_target_account", False)
                confidence = result_data.get("confidence", 0)

                _log(f"AI 分析: 已登录={is_logged_in}, 登录邮箱={logged_in_email}, 是目标账号={is_target_account}, 置信度={confidence}")

                # 置信度检查
                if confidence < 0.5:
                    _log(f"[!] AI 置信度较低 ({confidence})，建议人工确认")

                # 返回结果
                if not is_logged_in:
                    _log("[OK] Stagehand 检测: 未登录")
                    return False

                if is_target_account:
                    _log(f"[OK] Stagehand 检测: 已登录目标账号 ({email})")
                    return True
                else:
                    # 登录了其他账号
                    _log(f"[!] Stagehand 检测: 已登录其他账号 ({logged_in_email})，需要切换到 {email}")
                    return False

            finally:
                try:
                    await session.end()
                except Exception:
                    pass

    except Exception as e:
        _log(f"[!] Stagehand 登录检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None
