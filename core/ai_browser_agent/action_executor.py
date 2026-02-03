"""
动作执行器 - AI Browser Agent

负责将 AI 决策的动作转换为 Playwright 操作

V2 重构：将元素查找逻辑拆分到 element_finder.py
V2.3: 新增 CDP Backend Node ID 点击支持
"""

import asyncio
import traceback
from typing import Optional, Tuple, List

from playwright.async_api import Page, Locator

from .types import ActionType, AgentAction
from .element_finder import ElementFinder

# MarkedElement 用于元素 ID 定位（可选依赖）
try:
    from .element_marker import MarkedElement
    ELEMENT_MARKER_AVAILABLE = True
except ImportError:
    MarkedElement = None
    ELEMENT_MARKER_AVAILABLE = False


class ActionExecutor:
    """
    动作执行器

    将 AgentAction 转换为 Playwright 操作

    V2.3: 支持 CDP Backend Node ID 点击（更精确）
    """

    def __init__(
        self,
        page: Page,
        timeout: int = 10000,
        prefer_cdp_click: bool = True  # V2.3: 是否优先使用 CDP 点击
    ):
        """
        初始化执行器

        Args:
            page: Playwright Page 对象
            timeout: 默认超时时间（毫秒）
            prefer_cdp_click: V2.3 - 是否优先使用 CDP Backend Node ID 点击
        """
        self.page = page
        self.timeout = timeout
        self._finder = ElementFinder(page, timeout)
        self.prefer_cdp_click = prefer_cdp_click

    # ============ 公开方法 ============

    async def execute(
        self,
        action: AgentAction,
        elements: Optional[List["MarkedElement"]] = None
    ) -> Tuple[bool, str]:
        """
        执行动作

        Args:
            action: 要执行的动作
            elements: SoM 元素列表（可选，用于元素 ID 定位）

        Returns:
            (success: bool, message: str)
        """
        # 存储元素列表供元素查找器使用
        self._finder.set_elements(elements)

        try:
            if action.action_type == ActionType.CLICK:
                return await self._execute_click(action)

            elif action.action_type == ActionType.FILL:
                return await self._execute_fill(action)

            elif action.action_type == ActionType.TYPE:
                return await self._execute_type(action)

            elif action.action_type == ActionType.PRESS:
                return await self._execute_press(action)

            elif action.action_type == ActionType.SCROLL:
                return await self._execute_scroll(action)

            elif action.action_type == ActionType.WAIT:
                return await self._execute_wait(action)

            elif action.action_type == ActionType.WAIT_FOR:
                return await self._execute_wait_for(action)

            elif action.action_type == ActionType.NAVIGATE:
                return await self._execute_navigate(action)

            elif action.action_type == ActionType.REFRESH:
                return await self._execute_refresh(action)

            elif action.action_type == ActionType.DONE:
                return True, f"任务完成: {action.reasoning}"

            elif action.action_type == ActionType.ERROR:
                return False, f"AI 报告错误: {action.error_message}"

            elif action.action_type == ActionType.NEED_VERIFICATION:
                return False, f"需要验证码 ({action.verification_type}): {action.reasoning}"

            elif action.action_type == ActionType.EXTRACT_SECRET:
                return True, f"已提取密钥: {action.extracted_secret[:20] if action.extracted_secret else ''}..."

            elif action.action_type == ActionType.EXTRACT_LINK:
                return await self._execute_extract_link(action)

            else:
                return False, f"未知动作类型: {action.action_type}"

        except Exception as e:
            traceback.print_exc()
            return False, f"执行失败: {str(e)}"
        finally:
            # 清理 CDP 服务
            await self._finder.close_cdp_service()

    # ============ 点击操作 ============

    async def _execute_click(self, action: AgentAction) -> Tuple[bool, str]:
        """
        执行点击操作

        V2.3 点击策略优先级：
        1. CDP Backend Node ID 点击（如果元素有 backend_node_id）
        2. Playwright Locator 点击
        3. 坐标点击
        """
        target = action.target_description

        if target:
            # V2.3: 优先尝试 CDP Backend Node ID 点击
            if self.prefer_cdp_click and self._finder.has_backend_node_id(target):
                success, message = await self._finder.click_by_element_id_cdp(target)
                if success:
                    await self._wait_for_page_stable()
                    return True, f"点击元素 (CDP): {target}"
                # CDP 失败时回退到 Playwright

            # 尝试 Playwright Locator 定位
            element = await self._finder.find_element(target)
            if element:
                return await self._click_element(element, target)

            # 尝试获取元素坐标点击
            coords = self._finder.get_element_coordinates(target)
            if coords:
                x, y = coords
                await self.page.mouse.click(x, y)
                await self._wait_for_page_stable()
                return True, f"点击坐标 (元素 {target}): ({x}, {y})"

        # 回退到直接坐标点击
        if action.x is not None and action.y is not None:
            await self.page.mouse.click(action.x, action.y)
            await self._wait_for_page_stable()
            return True, f"点击坐标 ({action.x}, {action.y})"

        # 如果有描述但未找到元素
        if target:
            return False, f"未找到元素: {target}"

        return False, "未指定点击目标"

    async def _click_element(self, element: Locator, description: str) -> Tuple[bool, str]:
        """点击元素，尝试多种点击策略"""
        try:
            # 首先尝试滚动到元素可见
            await element.scroll_into_view_if_needed(timeout=3000)
            await asyncio.sleep(0.2)

            # 尝试普通点击
            await element.click(timeout=self.timeout)
            await self._wait_for_page_stable()
            return True, f"点击元素: {description}"

        except Exception as e1:
            error_msg = str(e1)

            # 检查是否被 iframe 遮罩层阻止
            if "intercepts pointer events" in error_msg:
                is_iframe_blocking = "<iframe" in error_msg

                if is_iframe_blocking:
                    # 优先在 iframe 中查找按钮
                    iframe_element = await self._finder.find_element_in_all_frames(description)
                    if iframe_element:
                        try:
                            await iframe_element.click(timeout=self.timeout)
                            await self._wait_for_page_stable()
                            return True, f"点击 iframe 内按钮: {description}"
                        except Exception:
                            pass

                # 尝试在对话框中查找按钮
                dialog_element = await self._finder.find_dialog_button(description)
                if dialog_element:
                    try:
                        await dialog_element.click(timeout=self.timeout)
                        await self._wait_for_page_stable()
                        return True, f"点击对话框按钮: {description}"
                    except Exception:
                        pass

                # 如果是 iframe 遮挡，不使用 force click
                if is_iframe_blocking:
                    return False, f"被 iframe 遮挡，无法点击: {description}"

            # 尝试强制点击
            try:
                await element.click(force=True, timeout=self.timeout)
                await self._wait_for_page_stable()
                return True, f"点击元素(force): {description}"
            except Exception:
                pass

            # 尝试 JavaScript 点击
            try:
                await element.evaluate("el => el.click()")
                await self._wait_for_page_stable()
                return True, f"点击元素(JS): {description}"
            except Exception:
                pass

            # 尝试 dispatch click 事件
            try:
                await element.dispatch_event("click")
                await self._wait_for_page_stable()
                return True, f"点击元素(dispatch): {description}"
            except Exception:
                return False, f"所有点击方式均失败: {description}"

    async def _click_by_element_coordinates(self, target: str) -> Tuple[bool, str]:
        """通过元素坐标点击"""
        coords = self._finder.get_element_coordinates(target)
        if coords is None:
            return False, f"未找到元素坐标: {target}"

        x, y = coords
        await self.page.mouse.click(x, y)
        return True, f"点击坐标 ({x}, {y})"

    # ============ 输入操作 ============

    async def _execute_fill(self, action: AgentAction) -> Tuple[bool, str]:
        """执行填写操作"""
        if not action.value:
            return False, "未指定填写内容"

        target = action.target_description
        if not target:
            return False, "未指定目标输入框"

        # V2.3: 优先尝试通过元素 ID 定位 (支持 [N] 格式)
        element = await self._finder.locate_by_element_id(target)
        if element:
            try:
                await element.fill(action.value, timeout=self.timeout)
                return True, f"填写内容到: {target}"
            except Exception as e:
                # 元素 ID 定位成功但 fill 失败，尝试点击后输入
                try:
                    await element.click(timeout=self.timeout)
                    await element.fill(action.value, timeout=self.timeout)
                    return True, f"填写内容到 (点击后): {target}"
                except Exception:
                    pass  # 继续尝试其他方法

        # 尝试通过元素坐标定位输入框
        coords = self._finder.get_element_coordinates(target)
        if coords:
            try:
                x, y = coords
                # 点击输入框获取焦点
                await self.page.mouse.click(x, y)
                await asyncio.sleep(0.2)
                # 清空现有内容并输入
                await self.page.keyboard.press("Control+a")
                await self.page.keyboard.type(action.value, delay=30)
                return True, f"填写内容到坐标 ({x}, {y}): {target}"
            except Exception:
                pass  # 继续尝试其他方法

        # 回退：使用描述文本查找元素
        try:
            element = await self._finder.find_element(target)
            if element:
                await element.fill(action.value, timeout=self.timeout)
                return True, f"填写内容到: {target}"
        except Exception:
            pass

        return False, f"未找到输入框: {target}"

    async def _execute_type(self, action: AgentAction) -> Tuple[bool, str]:
        """执行逐字输入操作"""
        if not action.value:
            return False, "未指定输入内容"

        target = action.target_description

        if target:
            # V2.3: 优先尝试通过元素 ID 定位 (支持 [N] 格式)
            element = await self._finder.locate_by_element_id(target)
            if element:
                try:
                    await element.click(timeout=self.timeout)
                    await self.page.keyboard.type(action.value, delay=50)
                    return True, f"逐字输入到: {target}"
                except Exception:
                    pass  # 继续尝试其他方法

            # 尝试通过元素坐标定位
            coords = self._finder.get_element_coordinates(target)
            if coords:
                try:
                    x, y = coords
                    await self.page.mouse.click(x, y)
                    await asyncio.sleep(0.2)
                    await self.page.keyboard.type(action.value, delay=50)
                    return True, f"逐字输入到坐标 ({x}, {y}): {target}"
                except Exception:
                    pass  # 继续尝试其他方法

            # 回退：使用描述文本查找元素
            try:
                element = await self._finder.find_element(target)
                if element:
                    await element.click(timeout=self.timeout)
                    await self.page.keyboard.type(action.value, delay=50)
                    return True, f"逐字输入到: {target}"
            except Exception:
                pass

            return False, f"未找到输入框: {target}"

        # 直接在当前焦点输入
        await self.page.keyboard.type(action.value, delay=50)
        return True, f"逐字输入: {action.value}"

    async def _execute_press(self, action: AgentAction) -> Tuple[bool, str]:
        """执行按键操作"""
        key = action.key or action.value
        if not key:
            return False, "未指定按键"

        await self.page.keyboard.press(key)
        return True, f"按键: {key}"

    # ============ 导航操作 ============

    async def _execute_scroll(self, action: AgentAction) -> Tuple[bool, str]:
        """执行滚动操作"""
        direction = (action.value or "down").lower()
        delta = 300 if direction == "down" else -300
        await self.page.mouse.wheel(0, delta)
        return True, f"滚动页面: {direction}"

    async def _execute_wait(self, action: AgentAction) -> Tuple[bool, str]:
        """执行等待操作"""
        seconds = action.wait_seconds or 2
        await asyncio.sleep(seconds)
        return True, f"等待 {seconds} 秒"

    async def _execute_wait_for(self, action: AgentAction) -> Tuple[bool, str]:
        """执行等待元素出现操作"""
        if not action.target_description:
            return False, "未指定等待目标"

        target = action.target_description

        try:
            # V2.3: 优先尝试通过元素 ID 定位 (支持 [N] 格式)
            element = await self._finder.locate_by_element_id(target)
            if element:
                # 等待元素可见
                try:
                    await element.wait_for(state="visible", timeout=self.timeout)
                    return True, f"元素已出现: {target}"
                except Exception:
                    return False, f"等待元素可见超时: {target}"

            # 回退：使用描述文本查找元素
            element = await self._finder.find_element(target, wait_timeout=self.timeout)
            if element:
                return True, f"元素已出现: {target}"
            else:
                return False, f"等待超时: {target}"
        except Exception as e:
            return False, f"等待失败: {str(e)}"

    async def _execute_navigate(self, action: AgentAction) -> Tuple[bool, str]:
        """执行导航操作"""
        if not action.url:
            return False, "未指定 URL"

        await self.page.goto(action.url, wait_until="domcontentloaded", timeout=30000)
        await self._wait_for_page_stable()
        return True, f"导航到: {action.url}"

    async def _execute_refresh(self, action: AgentAction) -> Tuple[bool, str]:
        """执行刷新操作"""
        await self.page.reload(wait_until="domcontentloaded", timeout=30000)
        await self._wait_for_page_stable()
        return True, "页面已刷新"

    # ============ 特殊操作 ============

    async def _execute_extract_link(self, action: AgentAction) -> Tuple[bool, str]:
        """
        从页面提取 SheerID 验证链接

        查找包含 sheerid.com 的链接并提取其 href 属性
        """
        try:
            # 查找包含 sheerid.com 的链接
            sheerid_patterns = [
                'a[href*="sheerid.com"]',
                'a[href*="services.sheerid.com"]',
                'a[href*="offers.sheerid.com"]',
            ]

            for pattern in sheerid_patterns:
                try:
                    locator = self.page.locator(pattern)
                    count = await locator.count()
                    if count > 0:
                        href = await locator.first.get_attribute("href")
                        if href:
                            action.extracted_link = href
                            return True, f"已提取链接: {href}"
                except Exception:
                    continue

            # 如果没有直接找到，尝试查找 "Verify eligibility" 按钮
            verify_patterns = [
                'a[aria-label*="Verify" i]',
                'a[aria-label*="eligibility" i]',
                'a:has-text("Verify eligibility")',
                'a:has-text("验证资格")',
                '[role="link"]:has-text("Verify")',
            ]

            for pattern in verify_patterns:
                try:
                    locator = self.page.locator(pattern)
                    count = await locator.count()
                    if count > 0:
                        href = await locator.first.get_attribute("href")
                        if href and "sheerid" in href.lower():
                            action.extracted_link = href
                            return True, f"已提取链接: {href}"
                except Exception:
                    continue

            # 如果 AI 已经提供了链接，直接使用
            if action.extracted_link:
                return True, f"使用 AI 提供的链接: {action.extracted_link}"

            return False, "未找到 SheerID 链接"

        except Exception as e:
            traceback.print_exc()
            return False, f"提取链接失败: {str(e)}"

    # ============ 页面工具 ============

    async def _wait_for_page_stable(self, timeout: int = 10000, min_wait: float = 0.3):
        """
        等待页面稳定（导航完成或网络空闲）

        在点击后调用，等待页面响应完成后再进行下一步操作。

        Args:
            timeout: 最大等待时间（毫秒），默认 10 秒
            min_wait: 最小等待时间（秒），默认 0.3 秒
        """
        try:
            # 首先等待最小时间
            await asyncio.sleep(min_wait)

            start_time = asyncio.get_event_loop().time()
            max_wait_seconds = timeout / 1000

            # 策略1：尝试等待网络空闲
            network_timeout = min(3000, timeout)
            try:
                await self.page.wait_for_load_state("networkidle", timeout=network_timeout)
                await asyncio.sleep(0.5)
                return
            except Exception:
                pass

            # 策略2：检查 DOM 加载状态
            try:
                await self.page.wait_for_load_state("domcontentloaded", timeout=2000)
            except Exception:
                pass

            # 策略3：检查待处理的网络请求
            elapsed = asyncio.get_event_loop().time() - start_time
            remaining = max_wait_seconds - elapsed

            if remaining > 0:
                try:
                    pending = await self.page.evaluate(
                        "() => window.performance.getEntriesByType('resource').filter(r => !r.responseEnd).length"
                    )
                    if pending == 0:
                        await asyncio.sleep(0.5)
                        return
                except Exception:
                    pass

            # 策略4：回退到固定等待
            fallback_wait = min(1.5, remaining) if remaining > 0 else 1.0
            await asyncio.sleep(fallback_wait)

        except Exception:
            await asyncio.sleep(1.0)

    async def take_screenshot(self) -> bytes:
        """
        截取当前页面截图

        .. deprecated::
            此方法已弃用，请使用 ScreenshotManager.capture() 代替。
            保留此方法仅为向后兼容。

        Returns:
            PNG 格式的截图数据
        """
        import warnings
        warnings.warn(
            "take_screenshot() 已弃用，请使用 ScreenshotManager.capture() 代替",
            DeprecationWarning,
            stacklevel=2
        )
        return await self.page.screenshot(
            type="png",
            full_page=False,
        )

    # ============ 兼容方法 ============

    # 以下方法为向后兼容保留，内部调用 element_finder

    def _find_element_by_id(self, element_id: int):
        """兼容方法：根据 ID 查找元素"""
        return self._finder._find_element_by_id(element_id)

    def _parse_element_id_from_target(self, target: str):
        """兼容方法：解析元素 ID"""
        return self._finder._parse_element_id_from_target(target)

    async def _locate_by_element_id(self, target: str):
        """兼容方法：通过元素 ID 定位"""
        return await self._finder.locate_by_element_id(target)

    async def _find_element(self, description: str, wait_timeout: Optional[int] = None):
        """兼容方法：查找元素"""
        return await self._finder.find_element(description, wait_timeout)

    async def _find_element_in_frames(self, description: str, key_phrases: list,
                                       is_button: bool, is_link: bool,
                                       is_delete: bool, is_code_input: bool):
        """兼容方法：在 iframe 中查找元素"""
        return await self._finder.find_element_in_frames(
            description, key_phrases, is_button, is_link, is_delete, is_code_input
        )

    async def _find_element_in_all_frames(self, description: str):
        """兼容方法：在所有 frame 中查找元素"""
        return await self._finder.find_element_in_all_frames(description)

    async def _find_dialog_button(self, original_target: str):
        """兼容方法：查找对话框按钮"""
        return await self._finder.find_dialog_button(original_target)

    def _is_selector(self, text: str) -> bool:
        """兼容方法：检查是否是选择器"""
        return self._finder._is_selector(text)
