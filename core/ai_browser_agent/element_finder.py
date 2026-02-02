"""
元素查找器 - AI Browser Agent

负责根据 AI 返回的描述文本定位页面元素
支持多种定位策略、iframe 查找、对话框按钮查找

V2.3: 新增 CDP Backend Node ID 支持
"""

import asyncio
import re
from typing import Optional, List, TYPE_CHECKING, Tuple

from playwright.async_api import Page, Locator

if TYPE_CHECKING:
    from .element_marker import MarkedElement

# V2.3: CDP 服务（可选依赖）
try:
    from .cdp_service import CDPDOMService
    CDP_SERVICE_AVAILABLE = True
except ImportError:
    CDPDOMService = None
    CDP_SERVICE_AVAILABLE = False


class ElementFinder:
    """
    元素查找器

    根据 AI 返回的描述文本定位页面元素，支持多种定位策略

    V2.3: 新增 CDP Backend Node ID 点击支持
    """

    def __init__(self, page: Page, timeout: int = 10000):
        """
        初始化元素查找器

        Args:
            page: Playwright Page 对象
            timeout: 默认超时时间（毫秒）
        """
        self.page = page
        self.timeout = timeout
        self._current_elements: Optional[List["MarkedElement"]] = None
        # V2.3: CDP 服务实例（延迟初始化）
        self._cdp_service: Optional["CDPDOMService"] = None

    def set_elements(self, elements: Optional[List["MarkedElement"]]):
        """设置当前元素列表（用于元素 ID 定位）"""
        self._current_elements = elements

    # ============ V2.3: CDP Backend Node ID 支持 ============

    async def _get_cdp_service(self) -> Optional["CDPDOMService"]:
        """获取或创建 CDP 服务实例"""
        if not CDP_SERVICE_AVAILABLE:
            return None

        if self._cdp_service is None:
            self._cdp_service = CDPDOMService(self.page)
            # V2.3 修复：预热 CDP 会话，获取 DPR 等信息
            try:
                await self._cdp_service._ensure_cdp_session()
            except Exception:
                pass  # 预热失败不影响后续操作

        return self._cdp_service

    async def close_cdp_service(self):
        """关闭 CDP 服务"""
        if self._cdp_service:
            await self._cdp_service.close()
            self._cdp_service = None

    def get_element_backend_node_id(self, target: str) -> Optional[int]:
        """
        获取元素的 Backend Node ID

        Args:
            target: 包含元素 ID 的 target 字符串

        Returns:
            Backend Node ID 或 None
        """
        element_id = self._parse_element_id_from_target(target)
        if element_id is None:
            return None

        element = self._find_element_by_id(element_id)
        if element is None:
            return None

        return element.backend_node_id

    async def click_by_backend_node_id(
        self,
        backend_node_id: int,
        scroll_into_view: bool = True
    ) -> Tuple[bool, str]:
        """
        通过 Backend Node ID 点击元素

        这是最精确的点击方式，借鉴 browser-use 的实现。

        Args:
            backend_node_id: CDP Backend Node ID
            scroll_into_view: 是否先滚动到视图

        Returns:
            (success, message) 元组
        """
        cdp_service = await self._get_cdp_service()
        if not cdp_service:
            return False, "CDP 服务不可用"

        return await cdp_service.click_by_backend_node_id(
            backend_node_id,
            scroll_into_view=scroll_into_view
        )

    async def click_by_element_id_cdp(self, target: str) -> Tuple[bool, str]:
        """
        通过元素 ID 使用 CDP 点击

        Args:
            target: 包含元素 ID 的 target 字符串

        Returns:
            (success, message) 元组
        """
        backend_node_id = self.get_element_backend_node_id(target)
        if backend_node_id is None:
            return False, f"无法获取元素 Backend Node ID: {target}"

        return await self.click_by_backend_node_id(backend_node_id)

    def has_backend_node_id(self, target: str) -> bool:
        """
        检查元素是否有 Backend Node ID

        Args:
            target: 包含元素 ID 的 target 字符串

        Returns:
            是否有 Backend Node ID
        """
        return self.get_element_backend_node_id(target) is not None

    # ============ 元素 ID 定位 ============

    def _find_element_by_id(self, element_id: int) -> Optional["MarkedElement"]:
        """
        根据 ID 查找元素

        Args:
            element_id: 目标元素 ID

        Returns:
            匹配的元素或 None
        """
        if not self._current_elements:
            return None

        for element in self._current_elements:
            if element.id == element_id:
                return element
        return None

    def _parse_element_id_from_target(self, target: str) -> Optional[int]:
        """
        从 target 字符串解析元素 ID

        支持格式：
        - "[1]" -> 1
        - "[12]" -> 12
        - "Click [3] button" -> 3

        Args:
            target: AI 返回的 target 字符串

        Returns:
            解析出的元素 ID，或 None
        """
        if not target:
            return None

        # 匹配 [数字] 格式
        match = re.search(r'\[(\d+)\]', target)
        if match:
            return int(match.group(1))

        return None

    async def locate_by_element_id(self, target: str) -> Optional[Locator]:
        """
        尝试通过元素 ID 定位

        如果 target 包含 [ID] 格式，尝试使用对应元素的 xpath 定位

        Args:
            target: AI 返回的 target 字符串

        Returns:
            Locator 或 None（如果不是元素 ID 格式或定位失败）
        """
        element_id = self._parse_element_id_from_target(target)
        if element_id is None:
            return None

        element = self._find_element_by_id(element_id)
        if element is None:
            return None

        # 优先使用 xpath 定位
        if element.xpath:
            try:
                locator = self.page.locator(f"xpath={element.xpath}")
                if await locator.count() > 0:
                    return locator.first
            except Exception:
                pass

        # 回退：使用中心坐标点击
        if element.center and element.center != (0, 0):
            # 返回 None，让调用方使用坐标点击
            return None

        return None

    def get_element_coordinates(self, target: str) -> Optional[tuple]:
        """
        获取元素 ID 对应的坐标

        Args:
            target: 包含元素 ID 的 target 字符串

        Returns:
            (x, y) 元组或 None
        """
        element_id = self._parse_element_id_from_target(target)
        if element_id is None:
            return None

        element = self._find_element_by_id(element_id)
        if element is None:
            return None

        if element.center and element.center != (0, 0):
            return element.center

        return None

    # ============ 描述文本定位 ============

    async def find_element(
        self, description: str, wait_timeout: Optional[int] = None
    ) -> Optional[Locator]:
        """
        根据描述查找元素

        使用多种策略尝试定位元素：
        1. 文本内容匹配
        2. 占位符匹配
        3. aria-label 匹配
        4. 角色 + 名称匹配
        5. 输入框类型匹配

        Args:
            description: 元素描述
            wait_timeout: 等待超时（毫秒）

        Returns:
            找到的 Locator 或 None
        """
        timeout = wait_timeout or self.timeout

        # 清理描述文本
        description = description.strip()
        desc_lower = description.lower()

        # 从描述中提取关键短语
        key_phrases = self._extract_key_phrases(description)

        # 检测元素类型
        is_button = self._is_button_description(desc_lower)
        is_code_input = self._is_code_input_description(desc_lower)
        is_link = self._is_link_description(desc_lower)
        is_delete = self._is_delete_description(desc_lower)

        # 构建定位策略
        strategies = self._build_strategies(
            description, desc_lower, is_button, is_code_input, is_link, is_delete
        )

        # 尝试使用主描述的策略
        for strategy in strategies:
            try:
                locator = strategy()
                if locator is None:
                    continue

                # 检查元素是否存在且可见
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

        # 如果主描述没找到，尝试使用提取的关键短语
        result = await self._try_key_phrases(key_phrases)
        if result:
            return result

        # 如果在主页面没找到，尝试在 iframe 中查找
        element = await self.find_element_in_frames(
            description, key_phrases, is_button, is_link, is_delete, is_code_input
        )
        if element:
            return element

        return None

    def _extract_key_phrases(self, description: str) -> List[str]:
        """从描述中提取关键短语"""
        key_phrases = [description]

        # 提取引号内的文字
        quoted = re.findall(r"['\"]([^'\"]+)['\"]", description)
        key_phrases.extend(quoted)

        # 提取 "with" 之后的部分
        if " with " in description:
            after_with = description.split(" with ", 1)[1].strip().strip("'\"")
            key_phrases.append(after_with)

        # 提取 "option" 之前的部分
        if " option" in description.lower():
            before_option = description.split(" option")[0].strip()
            key_phrases.append(before_option)

        return key_phrases

    def _is_button_description(self, desc_lower: str) -> bool:
        """检测是否是按钮相关的描述"""
        return any(kw in desc_lower for kw in [
            "button", "next", "submit", "continue", "confirm", "ok", "sign in", "login",
            "下一步", "继续", "确认", "提交", "登录", "确定"
        ])

    def _is_code_input_description(self, desc_lower: str) -> bool:
        """检测是否是验证码相关的输入框"""
        return any(kw in desc_lower for kw in [
            "code", "verification", "otp", "2fa", "authenticator", "pin", "totp",
            "验证码", "动态码", "安全码"
        ])

    def _is_link_description(self, desc_lower: str) -> bool:
        """检测是否是链接相关的描述"""
        return any(kw in desc_lower for kw in [
            "scan", "link", "click here", "learn more", "help",
            "can't", "cannot", "unable", "trouble",
            "无法扫描", "扫描", "了解详情", "帮助", "点击此处",
            "スキャン", "스캔", "scanner", "escanear", "digitalizar"
        ])

    def _is_delete_description(self, desc_lower: str) -> bool:
        """检测是否是删除/移除相关的描述"""
        return any(kw in desc_lower for kw in [
            "delete", "remove", "trash", "bin", "garbage",
            "删除", "移除", "移除电话", "删除电话", "删除手机"
        ])

    def _build_strategies(
        self,
        description: str,
        desc_lower: str,
        is_button: bool,
        is_code_input: bool,
        is_link: bool,
        is_delete: bool
    ) -> list:
        """构建定位策略列表"""
        strategies = []

        # 链接定位策略
        if is_link:
            strategies.extend(self._get_link_strategies(description))

        # 删除按钮策略
        if is_delete:
            strategies.extend(self._get_delete_strategies())

        # 验证码输入框策略
        if is_code_input:
            strategies.extend(self._get_code_input_strategies())

        # 按钮策略
        if is_button:
            strategies.extend(self._get_button_strategies(description))

        # 通用策略
        strategies.extend(self._get_common_strategies(description, desc_lower))

        return strategies

    def _get_link_strategies(self, description: str) -> list:
        """获取链接定位策略"""
        return [
            lambda: self.page.locator('a, button, [role="link"], [role="button"]').filter(
                has_text=re.compile(r"can.?t\s*scan", re.I)
            ).first,
            lambda: self.page.get_by_role("link", name=re.compile(r"scan", re.I)),
            lambda: self.page.get_by_role("button", name=re.compile(r"scan", re.I)),
            lambda: self.page.locator('a').filter(has_text=re.compile(r"scan", re.I)).first,
            lambda: self.page.locator('span, div:not([id="yDmH0d"])').filter(
                has_text=re.compile(r"can.?t\s*scan", re.I)
            ).first,
            lambda: self.page.locator('span[jsaction], div[jsaction], a[jsaction]').filter(
                has_text=re.compile(r"scan", re.I)
            ).first,
            lambda: self.page.locator('span[jscontroller], a[jscontroller]').filter(
                has_text=re.compile(r"scan", re.I)
            ).first,
            lambda: self.page.locator('span, a, button, [role="link"]').filter(
                has_text=re.compile(r"can.?t\s*scan\s*it", re.I)
            ).first,
            lambda: self.page.locator('span, a, button, [role="link"]').filter(
                has_text=re.compile(r"无法.?扫描", re.I)
            ).first,
            lambda: self.page.locator('[class*="link"], [class*="Link"]').filter(
                has_text=re.compile(r"scan", re.I)
            ).first,
            lambda: self.page.locator('span[style*="color"], a[style*="color"]').filter(
                has_text=re.compile(r"scan", re.I)
            ).first,
        ]

    def _get_delete_strategies(self) -> list:
        """获取删除按钮定位策略"""
        return [
            lambda: self.page.locator(
                '[aria-label*="remove" i], [aria-label*="delete" i], '
                '[aria-label*="Remove" i], [aria-label*="Delete" i]'
            ).first,
            lambda: self.page.locator(
                'button[aria-label*="trash" i], button[aria-label*="bin" i]'
            ).first,
            lambda: self.page.locator(
                '[class*="delete" i], [class*="trash" i], [class*="remove" i]'
            ).first,
            lambda: self.page.locator(
                'i:has-text("delete"), span:has-text("delete_forever"), span:has-text("remove_circle")'
            ).first,
            lambda: self.page.locator('button:has(svg), [role="button"]:has(svg)').filter(
                has_text=re.compile(r"remove|delete|删除|移除", re.I)
            ).first,
            lambda: self.page.locator('[role="button"]').filter(
                has_text=re.compile(r"remove|delete|删除|移除", re.I)
            ).first,
            lambda: self.page.locator('button').filter(
                has_text=re.compile(r"remove|delete|删除|移除", re.I)
            ).first,
            lambda: self.page.locator('[jsaction]').filter(
                has_text=re.compile(r"remove|delete|删除|移除", re.I)
            ).first,
            lambda: self.page.get_by_role("button", name=re.compile(r"remove|delete", re.I)),
            lambda: self.page.locator(
                '[data-action*="delete" i], [data-action*="remove" i]'
            ).first,
            lambda: self.page.get_by_role("link", name=re.compile(r"remove|delete|删除|移除", re.I)),
            lambda: self.page.locator('button, a, [role="button"], [role="link"]').filter(
                has_text=re.compile(r"remove|delete|删除|移除", re.I)
            ).first,
        ]

    def _get_code_input_strategies(self) -> list:
        """获取验证码输入框定位策略"""
        return [
            lambda: self.page.locator('input[type="tel"]'),
            lambda: self.page.locator('input[name="totpPin"]'),
            lambda: self.page.locator('input[name="pin"]'),
            lambda: self.page.locator('input[autocomplete="one-time-code"]'),
            lambda: self.page.locator('input[aria-label*="code" i]'),
            lambda: self.page.locator('input[aria-label*="Enter" i]'),
            lambda: self.page.locator('input[id*="code" i]'),
            lambda: self.page.locator('input[id*="pin" i]'),
            lambda: self.page.locator('input[id*="totp" i]'),
            lambda: self.page.locator('input[inputmode="numeric"]'),
            lambda: self.page.locator('input[pattern*="[0-9]"]'),
            lambda: self.page.locator('input[data-initial-value]'),
            lambda: self.page.locator('input[jsname]').first,
        ]

    def _get_button_strategies(self, description: str) -> list:
        """获取按钮定位策略"""
        return [
            lambda: self.page.get_by_role("button", name=re.compile(description, re.I)),
            lambda: self.page.locator('button[type="submit"]'),
            lambda: self.page.locator(f'button:has-text("{description}")'),
            lambda: self.page.locator(f'div[role="button"]:has-text("{description}")'),
            lambda: self.page.locator(f'span[role="button"]:has-text("{description}")'),
            lambda: self.page.locator('[role="button"]').filter(
                has_text=re.compile(description, re.I)
            ),
            lambda: self.page.locator('[class*="VfPpkd"]').filter(
                has_text=re.compile(description, re.I)
            ),
            lambda: self.page.locator('[class*="RveJvd"]').filter(
                has_text=re.compile(description, re.I)
            ),
            lambda: self.page.locator('[data-idom-class*="button"]').filter(
                has_text=re.compile(description, re.I)
            ),
            lambda: self.page.locator('[jsaction]').filter(
                has_text=re.compile(description, re.I)
            ),
            lambda: self.page.locator('[jscontroller][role="button"]'),
            lambda: self.page.get_by_text(description, exact=True),
        ]

    def _get_common_strategies(self, description: str, desc_lower: str) -> list:
        """获取通用定位策略"""
        return [
            lambda: self.page.get_by_role("textbox", name=re.compile(description, re.I)),
            lambda: self.page.locator('input[type="password"]') if "password" in desc_lower else None,
            lambda: self.page.get_by_placeholder(re.compile(description, re.I)),
            lambda: self.page.locator('input[type="email"]') if "email" in desc_lower else None,
            lambda: self.page.locator(f'input[name*="{description}" i], input[id*="{description}" i]'),
            lambda: self.page.locator(f'[aria-label*="{description}" i]'),
            lambda: self.page.get_by_text(description, exact=True),
            lambda: self.page.get_by_text(description),
            lambda: self.page.get_by_role("button", name=re.compile(description, re.I)),
            lambda: self.page.get_by_role("link", name=re.compile(description, re.I)),
            lambda: self.page.locator(description) if self._is_selector(description) else None,
        ]

    async def _try_key_phrases(self, key_phrases: List[str]) -> Optional[Locator]:
        """尝试使用提取的关键短语定位"""
        for phrase in key_phrases[1:]:  # 跳过第一个（就是原始描述）
            if not phrase or len(phrase) < 3:
                continue

            try:
                # 尝试精确文本匹配
                locator = self.page.get_by_text(phrase, exact=True)
                count = await locator.count()
                if count > 0:
                    first = locator.first
                    if await first.is_visible():
                        return first

                # 尝试模糊文本匹配
                locator = self.page.get_by_text(phrase)
                count = await locator.count()
                if count > 0:
                    first = locator.first
                    if await first.is_visible():
                        return first

                # 尝试按钮/链接角色
                locator = self.page.get_by_role("button", name=re.compile(phrase, re.I))
                count = await locator.count()
                if count > 0:
                    first = locator.first
                    if await first.is_visible():
                        return first

                locator = self.page.get_by_role("link", name=re.compile(phrase, re.I))
                count = await locator.count()
                if count > 0:
                    first = locator.first
                    if await first.is_visible():
                        return first

            except Exception:
                continue

        return None

    def _is_selector(self, text: str) -> bool:
        """检查文本是否看起来像 CSS 选择器"""
        selector_patterns = [
            r"^[#\.]",  # 以 # 或 . 开头
            r"\[.*\]",  # 包含属性选择器
            r"^[a-z]+$",  # 纯标签名
            r">",  # 子选择器
            r"\s+",  # 后代选择器
        ]
        return any(re.search(pattern, text) for pattern in selector_patterns)

    # ============ iframe 查找 ============

    async def find_element_in_frames(
        self,
        description: str,
        key_phrases: list,
        is_button: bool,
        is_link: bool,
        is_delete: bool,
        is_code_input: bool
    ) -> Optional[Locator]:
        """
        在所有 iframe 中查找元素

        Args:
            description: 元素描述
            key_phrases: 关键短语列表
            is_button: 是否是按钮
            is_link: 是否是链接
            is_delete: 是否是删除按钮
            is_code_input: 是否是验证码输入框

        Returns:
            找到的 Locator 或 None
        """
        try:
            # 获取所有 frame
            frames = self.page.frames

            for frame in frames:
                # 跳过主 frame
                if frame == self.page.main_frame:
                    continue

                frame_url = frame.url
                # 只在支付相关的 iframe 中查找
                if not any(domain in frame_url for domain in [
                    'google.com', 'gstatic.com', 'googleapis.com'
                ]):
                    continue

                try:
                    # 尝试在 frame 中查找元素
                    for phrase in key_phrases:
                        if not phrase or len(phrase) < 2:
                            continue

                        # 尝试各种定位策略
                        strategies = []

                        if is_button:
                            strategies.extend([
                                lambda p=phrase: frame.get_by_role("button", name=re.compile(p, re.I)),
                                lambda p=phrase: frame.locator(f'button:has-text("{p}")'),
                                lambda p=phrase: frame.locator(f'[role="button"]:has-text("{p}")'),
                            ])

                        # 通用策略
                        strategies.extend([
                            lambda p=phrase: frame.get_by_text(p, exact=True),
                            lambda p=phrase: frame.get_by_text(p),
                            lambda p=phrase: frame.locator(f'[aria-label*="{p}" i]'),
                            lambda p=phrase: frame.get_by_role("link", name=re.compile(p, re.I)),
                        ])

                        # 输入框策略
                        if is_code_input or 'card' in description.lower() or 'number' in description.lower():
                            strategies.extend([
                                lambda p=phrase: frame.get_by_role("textbox", name=re.compile(p, re.I)),
                                lambda p=phrase: frame.get_by_placeholder(re.compile(p, re.I)),
                                lambda p=phrase: frame.locator(f'input[aria-label*="{p}" i]'),
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

                except Exception:
                    continue

        except Exception:
            pass

        return None

    async def find_element_in_all_frames(self, description: str) -> Optional[Locator]:
        """
        在所有 frame（包括 iframe）中查找元素

        专门用于处理被 iframe 遮挡的情况，在 iframe 中查找目标元素
        """
        try:
            frames = self.page.frames

            for frame in frames:
                if frame == self.page.main_frame:
                    continue

                frame_url = frame.url
                # 支持 Google Pay/Play 相关的 iframe
                if not any(domain in frame_url for domain in [
                    'google.com', 'gstatic.com', 'googleapis.com',
                    'play.google.com', 'pay.google.com'
                ]):
                    continue

                try:
                    # 尝试多种定位策略
                    strategies = [
                        lambda: frame.get_by_role("button", name=re.compile(f"^{re.escape(description)}$", re.I)),
                        lambda: frame.locator('button, [role="button"]').filter(
                            has_text=re.compile(f"^{re.escape(description)}$", re.I)
                        ),
                        lambda: frame.get_by_text(description, exact=True),
                        lambda: frame.get_by_role("link", name=re.compile(description, re.I)),
                    ]

                    for strategy in strategies:
                        try:
                            locator = strategy()
                            count = await locator.count()
                            if count > 0:
                                first = locator.first
                                if await first.is_visible():
                                    return first
                        except Exception:
                            continue

                except Exception:
                    continue

        except Exception:
            pass

        return None

    # ============ 对话框按钮查找 ============

    async def find_dialog_button(self, original_target: str) -> Optional[Locator]:
        """
        在对话框中查找按钮

        当检测到遮罩层阻止点击时，尝试在对话框中查找相同含义的按钮。
        支持多语言按钮文字映射。

        Args:
            original_target: 原始目标按钮文字

        Returns:
            找到的 Locator 或 None
        """
        # 按钮文字的多语言映射
        button_translations = {
            # Sign out 类
            "sign out": ["退出账号", "登出", "退出", "ログアウト", "로그아웃", "Đăng xuất", "Cerrar sesión", "Se déconnecter", "Abmelden", "Sair"],
            "退出账号": ["Sign out", "登出", "退出", "ログアウト", "로그아웃"],
            "登出": ["Sign out", "退出账号", "退出", "ログアウト"],
            # Remove 类
            "remove": ["删除", "移除", "移除电话", "削除", "삭제", "Xóa", "Eliminar", "Supprimer", "Entfernen", "Remover"],
            "删除": ["Remove", "Delete", "移除", "削除", "삭제"],
            # OK/Confirm 类
            "ok": ["确定", "确认", "好", "好的", "知道了", "OK", "確定"],
            "确定": ["OK", "确认", "好", "Got it"],
            "got it": ["知道了", "确定", "好的", "OK"],
            # Cancel 类
            "cancel": ["取消", "キャンセル", "취소", "Hủy", "Cancelar", "Annuler", "Abbrechen"],
            "取消": ["Cancel", "キャンセル", "취소"],
            # Continue 类
            "continue": ["继续", "続行", "계속", "Tiếp tục", "Continuar", "Continuer", "Weiter"],
            "继续": ["Continue", "続行", "계속"],
        }

        original_lower = original_target.lower().strip()

        # 获取可能的翻译
        possible_texts = [original_target]
        for key, translations in button_translations.items():
            if key in original_lower or original_lower in key:
                possible_texts.extend(translations)
                break

        # 去重
        possible_texts = list(dict.fromkeys(possible_texts))

        # 对话框选择器
        dialog_selectors = [
            '[role="dialog"]',
            '[role="alertdialog"]',
            '[class*="dialog" i]',
            '[class*="modal" i]',
            '[class*="overlay" i]',
            'div[jsaction*="dismiss"]',
            'div[class*="pZzBJe"]',
            'div[class*="TRBpHd"]',
            'div[class*="g3VIld"]',
            'div[class*="XfpsVe"]',
        ]

        # 先尝试直接查找按钮区域中的精确短文本按钮
        for text in possible_texts:
            if not text or len(text) < 2:
                continue

            try:
                buttons = self.page.locator('button, [role="button"]')
                count = await buttons.count()

                for i in range(count):
                    btn = buttons.nth(i)
                    try:
                        if not await btn.is_visible():
                            continue

                        btn_text = await btn.inner_text()
                        btn_text_clean = btn_text.strip()

                        if len(btn_text_clean) < 30 and text.lower() in btn_text_clean.lower():
                            if btn_text_clean.lower() == text.lower() or len(btn_text_clean) < 15:
                                return btn
                    except Exception:
                        continue
            except Exception:
                pass

        # 在对话框容器内查找
        for text in possible_texts:
            if not text or len(text) < 2:
                continue

            for dialog_sel in dialog_selectors:
                try:
                    dialog = self.page.locator(dialog_sel)
                    count = await dialog.count()
                    if count > 0:
                        button = dialog.locator('button, [role="button"], a').filter(has_text=text)
                        btn_count = await button.count()
                        if btn_count > 0:
                            for i in range(btn_count):
                                btn = button.nth(i)
                                try:
                                    if await btn.is_visible():
                                        return btn
                                except Exception:
                                    continue
                except Exception:
                    continue

            # 直接查找可见的按钮
            try:
                button = self.page.locator('button, [role="button"]').filter(has_text=text)
                count = await button.count()

                # 从后往前遍历（对话框中的按钮通常在 DOM 后面）
                for i in range(count - 1, -1, -1):
                    btn = button.nth(i)
                    try:
                        if await btn.is_visible():
                            box = await btn.bounding_box()
                            if box:
                                return btn
                    except Exception:
                        continue
            except Exception:
                continue

        # 最后尝试在所有 iframe 中查找按钮
        try:
            frames = self.page.frames
            for frame in frames:
                if frame == self.page.main_frame:
                    continue

                frame_url = frame.url
                if not any(domain in frame_url for domain in [
                    'google.com', 'gstatic.com', 'googleapis.com',
                    'play.google.com', 'pay.google.com', 'tokenized.play'
                ]):
                    continue

                for text in possible_texts:
                    if not text or len(text) < 2:
                        continue

                    try:
                        buttons = frame.locator('button, [role="button"]')
                        count = await buttons.count()

                        for i in range(count):
                            btn = buttons.nth(i)
                            try:
                                if not await btn.is_visible():
                                    continue

                                btn_text = await btn.inner_text()
                                btn_text_clean = btn_text.strip()

                                if len(btn_text_clean) < 30 and text.lower() in btn_text_clean.lower():
                                    if btn_text_clean.lower() == text.lower() or len(btn_text_clean) < 15:
                                        return btn
                            except Exception:
                                continue

                    except Exception:
                        continue

        except Exception:
            pass

        return None
