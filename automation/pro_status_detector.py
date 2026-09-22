"""
Google One Pro 会员状态检测器

提供统一的 Pro 状态检测功能，支持 StagehandGoogleEngine 和 BrowserUseEngine。
"""

import traceback
from typing import Callable, Optional, Tuple, TYPE_CHECKING

from playwright.async_api import Page

from core.config_manager import ConfigManager

# 类型检查时导入
if TYPE_CHECKING:
    from core.stagehand_engine import StagehandGoogleEngine as StagehandGoogleEngineType

# 导入 StagehandGoogleEngine
try:
    from core.stagehand_engine import StagehandGoogleEngine
    from core.stagehand_engine.types import ProStatus
    from core.stagehand_engine.constants import GoogleURLs
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None
    ProStatus = None
    GoogleURLs = None

# 导入 BrowserUseEngine
try:
    from core.browseruse_engine import BrowserUseEngine
    BROWSERUSE_ENGINE_AVAILABLE = True
except ImportError:
    BrowserUseEngine = None
    BROWSERUSE_ENGINE_AVAILABLE = False

# 向后兼容别名
STAGEHAND_AVAILABLE = STAGEHAND_ENGINE_AVAILABLE


# 提供商名称映射 (ConfigManager 格式 -> Stagehand 格式)
PROVIDER_MAP = {
    "gemini": "google",
    "anthropic": "anthropic",
    "openai": "openai",
}


def get_stagehand_config(log: Callable[[str], None] = None) -> Tuple[str, str, str]:
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
    provider_prefix = PROVIDER_MAP.get(provider, provider)
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
    检测 Pro 状态（使用 BrowserUseEngine）

    通过 BrowserUseEngine 连接到现有的 ixBrowser 窗口，
    导航到 Google One 页面，使用 AI 提取订阅信息。

    Args:
        page: Playwright Page 对象（保留参数兼容性）
        email: 账号邮箱（用于日志）
        ws_endpoint: ixBrowser 的 WebSocket 端点
        log: 日志回调函数

    Returns:
        "yes" = 普通 Pro 会员（自己订阅）
        "family_yes" = 家庭组 Pro 会员（被邀请）
        "no" = 非 Pro 会员
        None = 检测失败
    """
    return await check_pro_status_via_browseruse(
        ws_endpoint=ws_endpoint,
        email=email,
        log=log,
    )


async def check_pro_status_simple(
    page: Page,
    log: Callable[[str], None] = None,
) -> bool | None:
    """
    简单的 Pro 状态检测（基于页面文本分析）

    作为 StagehandGoogleEngine 检测的备用方案。

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
        await page.goto(GoogleURLs.GOOGLE_ONE, wait_until="domcontentloaded", timeout=15000)
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
    使用 StagehandGoogleEngine 检测 Google 账号登录状态

    通过 StagehandGoogleEngine 连接到现有的 ixBrowser 窗口，
    使用 AI 智能判断当前浏览器是否已登录 Google 账号。

    Args:
        page: Playwright Page 对象（已连接到 ixBrowser，用于兼容性保留）
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

    if not STAGEHAND_ENGINE_AVAILABLE:
        _log("StagehandGoogleEngine 不可用")
        return None

    engine: Optional["StagehandGoogleEngineType"] = None

    try:
        _log("[AI] 使用 StagehandGoogleEngine 检测登录状态...")

        # 创建 StagehandGoogleEngine 实例并连接到现有浏览器
        engine = StagehandGoogleEngine(use_config=True)
        await engine.connect_cdp(ws_endpoint)

        _log("StagehandGoogleEngine 已连接")

        # 导航到 Google 账号页面检测登录状态
        _log("导航到 Google 账号页面...")
        nav_result = await engine.navigate(GoogleURLs.ACCOUNT)

        if not nav_result.success:
            _log(f"[!] 导航失败: {nav_result.error_message}")
            return None

        # 等待页面加载
        await engine.wait(2000)

        # 获取当前 URL
        current_url = await engine.get_current_url()
        _log(f"当前页面 URL: {current_url}")

        # 如果被重定向到登录页面，说明未登录
        if "accounts.google.com" in current_url and "signin" in current_url:
            _log("[OK] 检测结果: 未登录")
            return False

        # 如果在 myaccount 页面，检查是否是目标账号
        if "myaccount.google.com" in current_url:
            # 使用 AI 提取登录的邮箱
            extract_result = await engine.extract(
                instruction=f"""
                分析当前 Google 账号页面，判断用户是否已登录。

                **判断规则：**
                1. 如果页面显示邮箱地址，提取该邮箱
                2. 检查是否登录的是目标账号: {email}

                请返回：
                - is_logged_in: 是否已登录 (true/false)
                - logged_in_email: 已登录的邮箱地址
                - is_target_account: 是否是目标账号 {email} (true/false)
                """
            )

            if not extract_result.success:
                _log(f"[!] 提取登录状态失败: {extract_result.error}")
                # 如果在 myaccount 页面但无法提取，假设已登录
                _log("[OK] 检测结果: 已登录（无法确认邮箱）")
                return True

            data = extract_result.data or {}
            is_logged_in = data.get("is_logged_in", True)
            logged_in_email = data.get("logged_in_email", "")
            is_target_account = data.get("is_target_account", False)

            _log(f"AI 分析: 已登录={is_logged_in}, 登录邮箱={logged_in_email}, 是目标账号={is_target_account}")

            if not is_logged_in:
                _log("[OK] 检测结果: 未登录")
                return False

            if is_target_account:
                _log(f"[OK] 检测结果: 已登录目标账号 ({email})")
                return True
            else:
                _log(f"[!] 检测结果: 已登录其他账号 ({logged_in_email})，需要切换到 {email}")
                return False

        # 无法确定
        _log("[!] 无法确定登录状态")
        return None

    except Exception as e:
        _log(f"[!] StagehandGoogleEngine 登录检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None

    finally:
        # 确保清理资源（不关闭浏览器窗口）
        if engine and engine.is_initialized:
            try:
                await engine.stop(close_browser=False)
            except Exception:
                pass


async def check_pro_status_via_browseruse(
    ws_endpoint: str,
    email: str,
    log: Callable[[str], None] = None,
) -> str | None:
    """
    使用 BrowserUseEngine 检测 Pro 状态

    通过 BrowserUseEngine 连接到现有浏览器窗口，
    导航到 Google One 页面，使用 AI 提取订阅信息。

    Args:
        ws_endpoint: ixBrowser 的 WebSocket 端点
        email: 账号邮箱（用于日志）
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
            print(f"[ProDetector-BrowserUse] {msg}")

    if not BROWSERUSE_ENGINE_AVAILABLE:
        _log("BrowserUseEngine 不可用")
        return None

    engine = None

    try:
        _log("[AI] 使用 BrowserUseEngine 检测 Pro 状态...")

        engine = BrowserUseEngine()
        await engine.connect_cdp(ws_endpoint)
        _log("BrowserUseEngine 已连接")

        # 导航到 Google One 页面
        google_one_url = "https://one.google.com"
        nav_result = await engine.navigate(google_one_url, timeout=15000)
        if not nav_result.success:
            _log(f"[!] 导航 Google One 失败: {nav_result.error}")
            return None

        # 使用 AI 提取订阅信息
        _log("BrowserUseEngine: 使用 AI 提取 Pro 状态...")
        extract_result = await engine.extract(
            instruction="""Analyze the current Google One page and determine the subscription status.

**CRITICAL - How to distinguish family member vs individual subscriber:**

A FAMILY MEMBER (someone using a plan shared by another person) will see:
- "Shared by [Name]" or "由[姓名]共享" text on the page
- "plan manager" or "方案管理员" mentioned (referring to someone else)
- They will NOT see "Manage membership" or "Cancel membership" buttons
- They may see the plan name (e.g. "2 TB", "Google One AI Premium") but it's shared, not owned
- Storage section may show "Family storage" or "家庭存储空间"
- They may see other family members' storage usage

An INDIVIDUAL SUBSCRIBER (the plan owner/manager) will see:
- "Manage membership" or "管理会员" or "管理成员资格" buttons
- "Cancel membership" or "取消会员" or "取消成员资格" options
- "Your membership" or "您的成员资格"
- "Next payment" or "下次付款" or "Renews on" or "续订"
- They are the "plan manager" themselves

A NON-SUBSCRIBER will see:
- "Upgrade" or "升级" button
- "Get started" or "开始使用"
- "Choose a plan" or "选择方案"
- "Get Google One" or "获取 Google One"

**IMPORTANT**: If you see a plan name like "2 TB" but do NOT see "Manage membership" or "Cancel membership",
and instead see "Shared by" or "plan manager" (referring to someone else), the user is a FAMILY MEMBER, not an individual subscriber.

**Return a JSON object with these fields:**
- is_subscribed: boolean (true if user has an active subscription, either own or shared)
- is_family_member: boolean (true if the plan is SHARED BY someone else / user is NOT the plan manager)
- plan_name: string or null (the plan name if visible, e.g. "2 TB", "Google One AI Premium")

Return ONLY the JSON object, no markdown.""",
            max_steps=5,
        )

        if not extract_result.success:
            _log(f"[!] AI 提取失败: {extract_result.error}")
            return None

        data = extract_result.data or {}

        # 处理 {'content': '...'} 包装格式
        if isinstance(data, dict) and "content" in data and len(data) == 1:
            content_str = data.get("content", "")
            import re, json as _json
            json_match = re.search(r'\{[^{}]*"is_subscribed"[^{}]*\}', content_str, re.DOTALL)
            if json_match:
                try:
                    data = _json.loads(json_match.group())
                    _log(f"从 content 中提取 JSON: {data}")
                except _json.JSONDecodeError:
                    pass

        is_subscribed = data.get("is_subscribed", False)
        is_family_member = data.get("is_family_member", False)
        plan_name = data.get("plan_name")

        # ========== 二次验证：始终通过页面文本检测，修正 AI 判断不准的情况 ==========
        # 核心问题：家庭成员页面可能既没有 "Upgrade" 也没有 "Manage membership"，
        # 导致 AI 返回 is_subscribed=False。所以二次验证必须始终执行。
        try:
            page = engine._page  # 获取内部 page 对象
            if page:
                page_text = await page.inner_text("body")
                page_text_lower = page_text.lower()

                _log(f"页面文本长度: {len(page_text)}, 前200字: {page_text[:200].replace(chr(10), ' ')}")

                # ===== 家庭成员特征文本 =====
                # 这些标识只有家庭成员才会看到
                family_member_indicators = [
                    "shared by",           # 英文：由某人共享
                    "plan manager",        # 英文：方案管理员（作为描述出现，不是自己）
                    "由此共享",             # 中文：由此共享
                    "共享方案",             # 中文：共享方案
                    "方案管理员",           # 中文
                    "family storage",      # 家庭存储空间
                    "家庭存储",             # 中文
                    "family group member",  # 家庭组成员
                    "家庭群组成员",
                    "プランマネージャー",    # 日语
                ]

                # ===== 个人订阅者特征 =====
                # 只有个人订阅者/管理员才会看到
                owner_indicators = [
                    "manage membership",   # 管理会员
                    "cancel membership",   # 取消会员
                    "管理会员",
                    "管理成员资格",
                    "取消会员",
                    "取消成员资格",
                    "change membership",   # 更改会员
                    "更改成员资格",
                    "your membership",     # 您的会员
                    "您的成员资格",
                    "next payment",        # 下次付款
                    "下次付款",
                    "renews on",           # 续订
                    "续订日期",
                    "member since",        # 成为会员
                    "成为会员",
                ]

                # ===== 非订阅者特征 =====
                # 只有非订阅者才会看到
                non_subscriber_indicators = [
                    "upgrade",             # 升级按钮（只有非会员才有）
                    "升级",
                    "升級",
                    "get started",         # 开始使用
                    "开始使用",
                    "choose a plan",       # 选择方案
                    "选择方案",
                    "get google one",      # 获取 Google One
                    "获取 google one",
                    "pick a plan",
                ]

                # ===== 有订阅的一般性标识 =====
                # 有 Pro 订阅的账号（不管是个人还是家庭成员）通常会显示这些
                subscription_indicators = [
                    "google one ai premium",
                    "ai premium",
                    "premium plan",
                    "2 tb",
                    "100 gb",
                    "200 gb",
                    "your storage",        # 您的存储空间
                    "您的存储",
                    "storage used",        # 已使用的存储
                    "已使用",
                    "google photos",       # 具体福利
                    "vpn by google",       # VPN 福利（Pro 专属）
                    "google one vpn",
                ]

                has_family_indicator = any(
                    ind.lower() in page_text_lower for ind in family_member_indicators
                )
                has_owner_indicator = any(
                    ind.lower() in page_text_lower for ind in owner_indicators
                )
                has_non_subscriber_indicator = any(
                    ind.lower() in page_text_lower for ind in non_subscriber_indicators
                )
                has_subscription_indicator = any(
                    ind.lower() in page_text_lower for ind in subscription_indicators
                )

                _log(f"页面分析: 家庭成员标识={has_family_indicator}, 管理员标识={has_owner_indicator}, "
                     f"非订阅标识={has_non_subscriber_indicator}, 订阅标识={has_subscription_indicator}")

                # ===== 修正逻辑 =====

                # 情况1: AI 返回 is_subscribed=False，但页面有家庭成员标识 → 家庭成员
                if not is_subscribed and has_family_indicator and not has_non_subscriber_indicator:
                    _log("[!] 二次验证修正: AI 判断为非订阅，但检测到家庭成员标识 → 修正为家庭成员")
                    is_subscribed = True
                    is_family_member = True

                # 情况2: AI 返回 is_subscribed=False，但页面有订阅标识且无非订阅标识 → 可能有订阅
                elif not is_subscribed and has_subscription_indicator and not has_non_subscriber_indicator:
                    if has_owner_indicator:
                        _log("[!] 二次验证修正: AI 判断为非订阅，但检测到管理员标识 → 修正为个人订阅者")
                        is_subscribed = True
                        is_family_member = False
                    else:
                        # 有订阅标识但既无管理员也无非订阅标识 → 很可能是家庭成员
                        _log("[!] 二次验证修正: AI 判断为非订阅，检测到订阅标识但无管理按钮 → 修正为家庭成员")
                        is_subscribed = True
                        is_family_member = True

                # 情况3: AI 返回 is_subscribed=True, is_family_member=False，但有家庭成员标识
                elif is_subscribed and not is_family_member and has_family_indicator and not has_owner_indicator:
                    _log("[!] 二次验证修正: 检测到家庭成员标识，修正为 family_member")
                    is_family_member = True

                # 情况4: AI 返回 is_subscribed=True，但页面有非订阅标识且无订阅标识
                elif is_subscribed and has_non_subscriber_indicator and not has_owner_indicator and not has_subscription_indicator:
                    _log("[!] 二次验证修正: AI 判断为订阅，但检测到非订阅标识 → 修正为非订阅")
                    is_subscribed = False
                    is_family_member = False

        except Exception as e:
            _log(f"[!] 二次验证异常: {e}")

        _log(f"BrowserUseEngine 检测结果: subscribed={is_subscribed}, family={is_family_member}, plan={plan_name}")

        if not is_subscribed:
            _log("[OK] BrowserUseEngine: 非 Pro 会员")
            return "no"

        if is_family_member:
            _log(f"[OK] BrowserUseEngine: 家庭组 Pro 会员 ({plan_name})")
            return "family_yes"
        else:
            _log(f"[OK] BrowserUseEngine: 普通 Pro 会员 ({plan_name})")
            return "yes"

    except Exception as e:
        _log(f"[!] BrowserUseEngine 检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None

    finally:
        if engine:
            try:
                await engine.stop(close_browser=False)
            except Exception:
                pass


async def check_pro_status_with_engine(
    engine: "BrowserUseEngine",
    email: str,
    log: Callable[[str], None] = None,
) -> str | None:
    """
    使用已有的 BrowserUseEngine 实例检测 Pro 状态（不创建/销毁引擎）

    与 check_pro_status_via_browseruse 逻辑相同，但接受外部传入的引擎实例，
    避免重复创建/销毁 CDP 连接导致 SOCKS 代理失效。

    Args:
        engine: 已初始化的 BrowserUseEngine 实例
        email: 账号邮箱（用于日志）
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
            print(f"[ProDetector-Reuse] {msg}")

    try:
        _log("[AI] 使用已有 BrowserUseEngine 检测 Pro 状态...")

        # 导航到 Google One 页面
        google_one_url = "https://one.google.com"
        nav_result = await engine.navigate(google_one_url, timeout=15000)
        if not nav_result.success:
            _log(f"[!] 导航 Google One 失败: {nav_result.error}")
            return None

        # 使用 AI 提取订阅信息
        _log("BrowserUseEngine: 使用 AI 提取 Pro 状态...")
        extract_result = await engine.extract(
            instruction="""Analyze the current Google One page and determine the subscription status.

**CRITICAL - How to distinguish family member vs individual subscriber:**

A FAMILY MEMBER (someone using a plan shared by another person) will see:
- "Shared by [Name]" or "由[姓名]共享" text on the page
- "plan manager" or "方案管理员" mentioned (referring to someone else)
- They will NOT see "Manage membership" or "Cancel membership" buttons
- They may see the plan name (e.g. "2 TB", "Google One AI Premium") but it's shared, not owned
- Storage section may show "Family storage" or "家庭存储空间"
- They may see other family members' storage usage

An INDIVIDUAL SUBSCRIBER (the plan owner/manager) will see:
- "Manage membership" or "管理会员" or "管理成员资格" buttons
- "Cancel membership" or "取消会员" or "取消成员资格" options
- "Your membership" or "您的成员资格"
- "Next payment" or "下次付款" or "Renews on" or "续订"
- They are the "plan manager" themselves

A NON-SUBSCRIBER will see:
- "Upgrade" or "升级" button
- "Get started" or "开始使用"
- "Choose a plan" or "选择方案"
- "Get Google One" or "获取 Google One"

**IMPORTANT**: If you see a plan name like "2 TB" but do NOT see "Manage membership" or "Cancel membership",
and instead see "Shared by" or "plan manager" (referring to someone else), the user is a FAMILY MEMBER, not an individual subscriber.

**Return a JSON object with these fields:**
- is_subscribed: boolean (true if user has an active subscription, either own or shared)
- is_family_member: boolean (true if the plan is SHARED BY someone else / user is NOT the plan manager)
- plan_name: string or null (the plan name if visible, e.g. "2 TB", "Google One AI Premium")

Return ONLY the JSON object, no markdown.""",
            max_steps=5,
        )

        if not extract_result.success:
            _log(f"[!] AI 提取失败: {extract_result.error}")
            return None

        data = extract_result.data or {}

        # 处理 {'content': '...'} 包装格式
        if isinstance(data, dict) and "content" in data and len(data) == 1:
            content_str = data.get("content", "")
            import re, json as _json
            json_match = re.search(r'\{[^{}]*"is_subscribed"[^{}]*\}', content_str, re.DOTALL)
            if json_match:
                try:
                    data = _json.loads(json_match.group())
                    _log(f"从 content 中提取 JSON: {data}")
                except _json.JSONDecodeError:
                    pass

        is_subscribed = data.get("is_subscribed", False)
        is_family_member = data.get("is_family_member", False)
        plan_name = data.get("plan_name")

        # ========== 二次验证：始终通过页面文本检测，修正 AI 判断不准的情况 ==========
        try:
            page = engine._page
            if page:
                page_text = await page.inner_text("body")
                page_text_lower = page_text.lower()

                _log(f"页面文本长度: {len(page_text)}, 前200字: {page_text[:200].replace(chr(10), ' ')}")

                family_member_indicators = [
                    "shared by", "plan manager", "由此共享", "共享方案", "方案管理员",
                    "family storage", "家庭存储", "family group member", "家庭群组成员",
                    "プランマネージャー",
                ]
                owner_indicators = [
                    "manage membership", "cancel membership", "管理会员", "管理成员资格",
                    "取消会员", "取消成员资格", "change membership", "更改成员资格",
                    "your membership", "您的成员资格", "next payment", "下次付款",
                    "renews on", "续订日期", "member since", "成为会员",
                ]
                non_subscriber_indicators = [
                    "upgrade", "升级", "升級", "get started", "开始使用",
                    "choose a plan", "选择方案", "get google one", "获取 google one",
                    "pick a plan",
                ]
                subscription_indicators = [
                    "google one ai premium", "ai premium", "premium plan",
                    "2 tb", "100 gb", "200 gb", "your storage", "您的存储",
                    "storage used", "已使用", "google photos",
                    "vpn by google", "google one vpn",
                ]

                has_family_indicator = any(ind.lower() in page_text_lower for ind in family_member_indicators)
                has_owner_indicator = any(ind.lower() in page_text_lower for ind in owner_indicators)
                has_non_subscriber_indicator = any(ind.lower() in page_text_lower for ind in non_subscriber_indicators)
                has_subscription_indicator = any(ind.lower() in page_text_lower for ind in subscription_indicators)

                _log(f"页面分析: 家庭成员标识={has_family_indicator}, 管理员标识={has_owner_indicator}, "
                     f"非订阅标识={has_non_subscriber_indicator}, 订阅标识={has_subscription_indicator}")

                # 修正逻辑（与 check_pro_status_via_browseruse 相同）
                if not is_subscribed and has_family_indicator and not has_non_subscriber_indicator:
                    _log("[!] 二次验证修正: 检测到家庭成员标识 → 修正为家庭成员")
                    is_subscribed = True
                    is_family_member = True
                elif not is_subscribed and has_subscription_indicator and not has_non_subscriber_indicator:
                    if has_owner_indicator:
                        _log("[!] 二次验证修正: 检测到管理员标识 → 修正为个人订阅者")
                        is_subscribed = True
                        is_family_member = False
                    else:
                        _log("[!] 二次验证修正: 检测到订阅标识但无管理按钮 → 修正为家庭成员")
                        is_subscribed = True
                        is_family_member = True
                elif is_subscribed and not is_family_member and has_family_indicator and not has_owner_indicator:
                    _log("[!] 二次验证修正: 检测到家庭成员标识，修正为 family_member")
                    is_family_member = True
                elif is_subscribed and has_non_subscriber_indicator and not has_owner_indicator and not has_subscription_indicator:
                    _log("[!] 二次验证修正: 检测到非订阅标识 → 修正为非订阅")
                    is_subscribed = False
                    is_family_member = False

        except Exception as e:
            _log(f"[!] 二次验证异常: {e}")

        _log(f"检测结果: subscribed={is_subscribed}, family={is_family_member}, plan={plan_name}")

        if not is_subscribed:
            _log("[OK] 非 Pro 会员")
            return "no"

        if is_family_member:
            _log(f"[OK] 家庭组 Pro 会员 ({plan_name})")
            return "family_yes"
        else:
            _log(f"[OK] 普通 Pro 会员 ({plan_name})")
            return "yes"

    except Exception as e:
        _log(f"[!] Pro 状态检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None
