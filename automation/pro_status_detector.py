"""
Google One Pro 会员状态检测器

提供统一的 Pro 状态检测功能，使用 StagehandGoogleEngine 进行 AI 检测。
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
    使用 StagehandGoogleEngine 检测 Pro 状态

    通过 StagehandGoogleEngine 连接到现有的 ixBrowser 窗口，
    使用 AI 智能提取 Google One 订阅信息。

    Args:
        page: Playwright Page 对象（已连接到 ixBrowser，用于兼容性保留）
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

    if not STAGEHAND_ENGINE_AVAILABLE:
        _log("StagehandGoogleEngine 不可用")
        return None

    engine: Optional["StagehandGoogleEngineType"] = None

    try:
        _log("[AI] 使用 StagehandGoogleEngine 检测 Pro 状态...")

        # 创建 StagehandGoogleEngine 实例并连接到现有浏览器
        engine = StagehandGoogleEngine(use_config=True)
        await engine.connect_cdp(ws_endpoint)

        _log("StagehandGoogleEngine 已连接")

        # 使用 engine 的 detect_pro_status 方法
        result = await engine.detect_pro_status(navigate_if_needed=True)

        _log(f"检测结果: is_pro={result.is_pro}, is_family_member={result.is_family_member}, "
             f"plan={result.plan_name}, confidence={result.confidence}")

        # 检查是否需要登录
        if result.method_used == "login_required":
            _log("[!] 账号未登录，无法检测 Pro 状态")
            return None

        # 根据结果返回状态
        if not result.is_pro:
            _log("[OK] 检测结果: 非 Pro 会员")
            return "no"

        if result.is_family_member:
            _log(f"[OK] 检测结果: 家庭组 Pro 会员 ({result.plan_name})")
            return "family_yes"
        else:
            _log(f"[OK] 检测结果: 普通 Pro 会员 ({result.plan_name})")
            return "yes"

    except Exception as e:
        _log(f"[!] StagehandGoogleEngine 检测失败: {e}")
        _log(f"错误详情: {traceback.format_exc()}")
        return None

    finally:
        # 确保清理资源（不关闭浏览器窗口）
        if engine and engine.is_initialized:
            try:
                await engine.stop(close_browser=False)
            except Exception:
                pass


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
