"""
Action 处理器实现模块

使用装饰器注册所有 Action 处理器
将原 action_executor.py 中的逻辑迁移到这里
"""

import asyncio
import re
import traceback
from typing import Optional, Tuple, List

from playwright.async_api import Page, Locator

from .types import ActionType, AgentAction
from .action_registry import action, ActionResult, get_registry

# MarkedElement 用于元素 ID 定位（可选依赖）
try:
    from .element_marker import MarkedElement
    ELEMENT_MARKER_AVAILABLE = True
except ImportError:
    MarkedElement = None
    ELEMENT_MARKER_AVAILABLE = False


# ============ 辅助函数 ============

def _parse_element_id_from_target(target: str) -> Optional[int]:
    """从 target 字符串解析元素 ID"""
    if not target:
        return None
    match = re.search(r'\[(\d+)\]', target)
    if match:
        return int(match.group(1))
    return None


def _find_element_by_id(
    element_id: int,
    elements: Optional[List["MarkedElement"]]
) -> Optional["MarkedElement"]:
    """根据 ID 查找元素"""
    if not elements:
        return None
    for element in elements:
        if element.id == element_id:
            return element
    return None


async def _wait_for_page_stable(
    page: Page,
    timeout: int = 10000,
    min_wait: float = 0.3
):
    """等待页面稳定"""
    try:
        await asyncio.sleep(min_wait)

        # 尝试等待网络空闲
        network_timeout = min(3000, timeout)
        try:
            await page.wait_for_load_state("networkidle", timeout=network_timeout)
            await asyncio.sleep(0.5)
            return
        except Exception:
            pass

        # 回退到 DOM 加载
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=2000)
        except Exception:
            pass

        # 最终等待
        await asyncio.sleep(0.5)

    except Exception:
        await asyncio.sleep(0.5)


async def _find_element(
    page: Page,
    description: str,
    timeout: int = 10000,
) -> Optional[Locator]:
    """
    根据描述查找元素

    使用多种策略尝试定位元素
    """
    description = description.strip()
    desc_lower = description.lower()

    # 检测元素类型
    is_button = any(kw in desc_lower for kw in [
        "button", "next", "submit", "continue", "confirm", "ok", "sign in", "login",
        "下一步", "继续", "确认", "提交", "登录", "确定"
    ])

    is_code_input = any(kw in desc_lower for kw in [
        "code", "verification", "otp", "2fa", "authenticator", "pin", "totp",
        "验证码", "动态码", "安全码"
    ])

    # 定位策略列表
    strategies = []

    if is_code_input:
        strategies.extend([
            lambda: page.locator('input[type="tel"]'),
            lambda: page.locator('input[name="totpPin"]'),
            lambda: page.locator('input[name="pin"]'),
            lambda: page.locator('input[autocomplete="one-time-code"]'),
            lambda: page.locator('input[aria-label*="code" i]'),
            lambda: page.locator('input[inputmode="numeric"]'),
        ])

    if is_button:
        strategies.extend([
            lambda: page.get_by_role("button", name=re.compile(description, re.I)),
            lambda: page.locator('button[type="submit"]'),
            lambda: page.locator(f'button:has-text("{description}")'),
            lambda: page.locator('[role="button"]').filter(has_text=re.compile(description, re.I)),
        ])

    # 通用策略
    strategies.extend([
        lambda: page.get_by_role("textbox", name=re.compile(description, re.I)),
        lambda: page.locator('input[type="password"]') if "password" in desc_lower else None,
        lambda: page.get_by_placeholder(re.compile(description, re.I)),
        lambda: page.locator('input[type="email"]') if "email" in desc_lower else None,
        lambda: page.locator(f'[aria-label*="{description}" i]'),
        lambda: page.get_by_text(description, exact=True),
        lambda: page.get_by_text(description),
        lambda: page.get_by_role("button", name=re.compile(description, re.I)),
        lambda: page.get_by_role("link", name=re.compile(description, re.I)),
    ])

    for strategy in strategies:
        try:
            locator = strategy()
            if locator is None:
                continue

            count = await locator.count()
            if count > 0:
                first = locator.first
                try:
                    is_visible = await first.is_visible()
                    if is_visible:
                        return first
                except Exception:
                    continue
        except Exception:
            continue

    return None


async def _locate_by_element_id(
    page: Page,
    target: str,
    elements: Optional[List["MarkedElement"]]
) -> Optional[Locator]:
    """尝试通过元素 ID 定位"""
    element_id = _parse_element_id_from_target(target)
    if element_id is None:
        return None

    element = _find_element_by_id(element_id, elements)
    if element is None:
        return None

    # 优先使用 xpath
    if element.xpath:
        try:
            locator = page.locator(f"xpath={element.xpath}")
            if await locator.count() > 0:
                return locator.first
        except Exception:
            pass

    return None


# ============ Action 处理器注册 ============

@action(
    ActionType.CLICK,
    description="点击页面元素",
    requires_target=True,
    wait_after=0.5,
)
async def handle_click(
    page: Page,
    action: AgentAction,
    elements: Optional[List] = None,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行点击操作"""
    # 首先尝试通过元素 ID 定位
    if action.target_description:
        locator = await _locate_by_element_id(page, action.target_description, elements)
        if locator:
            try:
                await locator.scroll_into_view_if_needed(timeout=3000)
                await asyncio.sleep(0.2)
                await locator.click(timeout=timeout)
                await _wait_for_page_stable(page)
                return True, f"通过元素 ID 点击: {action.target_description}"
            except Exception as e:
                pass  # 继续尝试其他方法

        # 尝试元素描述定位
        element = await _find_element(page, action.target_description, timeout)
        if element:
            try:
                await element.scroll_into_view_if_needed(timeout=3000)
                await asyncio.sleep(0.2)
                await element.click(timeout=timeout)
                await _wait_for_page_stable(page)
                return True, f"点击元素: {action.target_description}"
            except Exception as e1:
                # 尝试强制点击
                try:
                    await element.click(force=True, timeout=timeout)
                    await _wait_for_page_stable(page)
                    return True, f"点击元素(force): {action.target_description}"
                except Exception as e2:
                    # 尝试 JS 点击
                    try:
                        await element.evaluate("el => el.click()")
                        await _wait_for_page_stable(page)
                        return True, f"点击元素(JS): {action.target_description}"
                    except Exception:
                        pass

    # 回退到坐标点击
    if action.x is not None and action.y is not None:
        await page.mouse.click(action.x, action.y)
        await _wait_for_page_stable(page)
        return True, f"点击坐标 ({action.x}, {action.y})"

    # 尝试使用元素 ID 的坐标
    if action.target_description and elements:
        element_id = _parse_element_id_from_target(action.target_description)
        if element_id is not None:
            element = _find_element_by_id(element_id, elements)
            if element and element.center and element.center != (0, 0):
                x, y = element.center
                await page.mouse.click(x, y)
                await _wait_for_page_stable(page)
                return True, f"通过坐标点击元素 [{element_id}] @ ({x}, {y})"

    if action.target_description:
        return False, f"未找到元素: {action.target_description}"

    return False, "未指定点击目标"


@action(
    ActionType.FILL,
    description="填写输入框",
    requires_target=True,
    requires_value=True,
)
async def handle_fill(
    page: Page,
    action: AgentAction,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行填写操作"""
    if not action.value:
        return False, "未指定填写内容"

    if action.target_description:
        element = await _find_element(page, action.target_description, timeout)
        if element:
            await element.fill(action.value, timeout=timeout)
            return True, f"填写内容到: {action.target_description}"
        else:
            return False, f"未找到输入框: {action.target_description}"

    return False, "未指定目标输入框"


@action(
    ActionType.TYPE,
    description="逐字符输入",
    requires_value=True,
)
async def handle_type(
    page: Page,
    action: AgentAction,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行逐字输入操作"""
    if not action.value:
        return False, "未指定输入内容"

    if action.target_description:
        element = await _find_element(page, action.target_description, timeout)
        if element:
            await element.click(timeout=timeout)
            await page.keyboard.type(action.value, delay=50)
            return True, f"逐字输入到: {action.target_description}"
        else:
            return False, f"未找到输入框: {action.target_description}"

    # 直接在当前焦点输入
    await page.keyboard.type(action.value, delay=50)
    return True, f"逐字输入: {action.value}"


@action(
    ActionType.PRESS,
    description="按键操作",
    requires_value=True,
)
async def handle_press(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """执行按键操作"""
    key = action.key or action.value
    if not key:
        return False, "未指定按键"

    await page.keyboard.press(key)
    return True, f"按键: {key}"


@action(
    ActionType.SCROLL,
    description="滚动页面",
)
async def handle_scroll(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """执行滚动操作"""
    direction = (action.value or "down").lower()
    delta = 300 if direction == "down" else -300
    await page.mouse.wheel(0, delta)
    return True, f"滚动页面: {direction}"


@action(
    ActionType.WAIT,
    description="等待指定时间",
)
async def handle_wait(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """执行等待操作"""
    seconds = action.wait_seconds or 2
    await asyncio.sleep(seconds)
    return True, f"等待 {seconds} 秒"


@action(
    ActionType.WAIT_FOR,
    description="等待元素出现",
    requires_target=True,
)
async def handle_wait_for(
    page: Page,
    action: AgentAction,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行等待元素出现操作"""
    if not action.target_description:
        return False, "未指定等待目标"

    try:
        element = await _find_element(page, action.target_description, timeout)
        if element:
            return True, f"元素已出现: {action.target_description}"
        else:
            return False, f"等待超时: {action.target_description}"
    except Exception as e:
        return False, f"等待失败: {str(e)}"


@action(
    ActionType.NAVIGATE,
    description="导航到 URL",
    requires_url=True,
    timeout_multiplier=3.0,
    wait_after=1.0,
)
async def handle_navigate(
    page: Page,
    action: AgentAction,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行导航操作"""
    if not action.url:
        return False, "未指定 URL"

    await page.goto(action.url, wait_until="domcontentloaded", timeout=30000)
    await _wait_for_page_stable(page)
    return True, f"导航到: {action.url}"


@action(
    ActionType.REFRESH,
    description="刷新页面",
    timeout_multiplier=3.0,
    wait_after=1.0,
)
async def handle_refresh(
    page: Page,
    action: AgentAction,
    timeout: int = 10000,
    **kwargs
) -> Tuple[bool, str]:
    """执行刷新操作"""
    await page.reload(wait_until="domcontentloaded", timeout=30000)
    await _wait_for_page_stable(page)
    return True, "页面已刷新"


@action(
    ActionType.DONE,
    description="任务完成",
    retry_on_failure=False,
)
async def handle_done(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """处理任务完成"""
    return True, f"任务完成: {action.reasoning}"


@action(
    ActionType.ERROR,
    description="报告错误",
    retry_on_failure=False,
)
async def handle_error(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """处理错误报告"""
    return False, f"AI 报告错误: {action.error_message}"


@action(
    ActionType.NEED_VERIFICATION,
    description="需要验证码",
    retry_on_failure=False,
)
async def handle_need_verification(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """处理验证码需求"""
    return False, f"需要验证码 ({action.verification_type}): {action.reasoning}"


@action(
    ActionType.EXTRACT_SECRET,
    description="提取身份验证器密钥",
    retry_on_failure=False,
)
async def handle_extract_secret(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """处理密钥提取"""
    secret = action.extracted_secret or ""
    display = f"{secret[:20]}..." if len(secret) > 20 else secret
    return True, f"已提取密钥: {display}"


@action(
    ActionType.EXTRACT_LINK,
    description="提取页面链接",
)
async def handle_extract_link(
    page: Page,
    action: AgentAction,
    **kwargs
) -> Tuple[bool, str]:
    """从页面提取 SheerID 验证链接"""
    try:
        # 查找 sheerid.com 链接
        sheerid_patterns = [
            'a[href*="sheerid.com"]',
            'a[href*="services.sheerid.com"]',
            'a[href*="offers.sheerid.com"]',
        ]

        for pattern in sheerid_patterns:
            try:
                locator = page.locator(pattern)
                count = await locator.count()
                if count > 0:
                    href = await locator.first.get_attribute("href")
                    if href:
                        action.extracted_link = href
                        return True, f"已提取链接: {href}"
            except Exception:
                continue

        # 查找 Verify eligibility 按钮
        verify_patterns = [
            'a[aria-label*="Verify" i]',
            'a:has-text("Verify eligibility")',
            '[role="link"]:has-text("Verify")',
        ]

        for pattern in verify_patterns:
            try:
                locator = page.locator(pattern)
                count = await locator.count()
                if count > 0:
                    href = await locator.first.get_attribute("href")
                    if href and "sheerid" in href.lower():
                        action.extracted_link = href
                        return True, f"已提取链接: {href}"
            except Exception:
                continue

        # 如果 AI 已提供链接
        if action.extracted_link:
            return True, f"使用 AI 提供的链接: {action.extracted_link}"

        return False, "未找到 SheerID 链接"

    except Exception as e:
        traceback.print_exc()
        return False, f"提取链接失败: {str(e)}"


# ============ 初始化：确保所有处理器已注册 ============

def ensure_actions_registered():
    """确保所有 Action 处理器已注册"""
    registry = get_registry()

    # 检查是否所有 ActionType 都有处理器
    missing = []
    for action_type in ActionType:
        if not registry.has_handler(action_type):
            missing.append(action_type)

    if missing:
        import logging
        logger = logging.getLogger("ai_browser_agent.actions")
        logger.warning(f"Missing action handlers: {[a.value for a in missing]}")

    return len(missing) == 0


# 模块加载时自动注册
ensure_actions_registered()
