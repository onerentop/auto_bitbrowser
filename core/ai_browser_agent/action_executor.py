"""
动作执行器 - AI Browser Agent

负责将 AI 决策的动作转换为 Playwright 操作
"""

import asyncio
import re
from typing import Optional, Tuple
import traceback

from playwright.async_api import Page, Locator

from .types import ActionType, AgentAction


class ActionExecutor:
    """
    动作执行器

    将 AgentAction 转换为 Playwright 操作
    """

    def __init__(self, page: Page, timeout: int = 10000):
        """
        初始化执行器

        Args:
            page: Playwright Page 对象
            timeout: 默认超时时间（毫秒）
        """
        self.page = page
        self.timeout = timeout

    async def execute(self, action: AgentAction) -> Tuple[bool, str]:
        """
        执行动作

        Args:
            action: 要执行的动作

        Returns:
            (success: bool, message: str)
        """
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
                # 密钥提取动作由 agent.py 处理，不应该到达这里
                return True, f"已提取密钥: {action.extracted_secret[:20] if action.extracted_secret else ''}..."

            else:
                return False, f"未知动作类型: {action.action_type}"

        except Exception as e:
            traceback.print_exc()
            return False, f"执行失败: {str(e)}"

    async def _execute_click(self, action: AgentAction) -> Tuple[bool, str]:
        """执行点击操作"""
        # 如果有描述，优先尝试元素定位（比坐标更可靠）
        if action.target_description:
            element = await self._find_element(action.target_description)
            if element:
                try:
                    # 调试：打印找到的元素信息
                    try:
                        outer_html = await element.evaluate("el => el.outerHTML.substring(0, 200)")
                        print(f"[AI Agent] 找到元素: {outer_html}")
                    except Exception:
                        pass

                    # 首先尝试滚动到元素可见
                    await element.scroll_into_view_if_needed(timeout=3000)
                    await asyncio.sleep(0.2)

                    # 尝试普通点击
                    await element.click(timeout=self.timeout)
                    await asyncio.sleep(0.8)
                    return True, f"点击元素: {action.target_description}"
                except Exception as e1:
                    print(f"[AI Agent] 普通点击失败: {e1}, 尝试 force click...")
                    try:
                        # 尝试强制点击
                        await element.click(force=True, timeout=self.timeout)
                        await asyncio.sleep(0.8)
                        return True, f"点击元素(force): {action.target_description}"
                    except Exception as e2:
                        print(f"[AI Agent] Force click 失败: {e2}, 尝试 JS click...")
                        try:
                            # 尝试 JavaScript 点击
                            await element.evaluate("el => el.click()")
                            await asyncio.sleep(0.8)
                            return True, f"点击元素(JS): {action.target_description}"
                        except Exception as e3:
                            print(f"[AI Agent] JS click 失败: {e3}, 尝试 dispatch click event...")
                            try:
                                # 尝试 dispatch click 事件
                                await element.dispatch_event("click")
                                await asyncio.sleep(0.8)
                                return True, f"点击元素(dispatch): {action.target_description}"
                            except Exception as e4:
                                return False, f"所有点击方式均失败: {action.target_description}"

        # 回退到坐标点击
        if action.x is not None and action.y is not None:
            await self.page.mouse.click(action.x, action.y)
            # 坐标点击后等待页面响应
            await asyncio.sleep(0.5)
            return True, f"点击坐标 ({action.x}, {action.y})"

        # 如果有描述但未找到元素
        if action.target_description:
            return False, f"未找到元素: {action.target_description}"

        return False, "未指定点击目标"

    async def _execute_fill(self, action: AgentAction) -> Tuple[bool, str]:
        """执行填写操作"""
        if not action.value:
            return False, "未指定填写内容"

        if action.target_description:
            element = await self._find_element(action.target_description)
            if element:
                await element.fill(action.value, timeout=self.timeout)
                return True, f"填写内容到: {action.target_description}"
            else:
                return False, f"未找到输入框: {action.target_description}"

        return False, "未指定目标输入框"

    async def _execute_type(self, action: AgentAction) -> Tuple[bool, str]:
        """执行逐字输入操作"""
        if not action.value:
            return False, "未指定输入内容"

        if action.target_description:
            element = await self._find_element(action.target_description)
            if element:
                await element.click(timeout=self.timeout)
                await self.page.keyboard.type(action.value, delay=50)
                return True, f"逐字输入到: {action.target_description}"
            else:
                return False, f"未找到输入框: {action.target_description}"

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

        try:
            element = await self._find_element(
                action.target_description, wait_timeout=self.timeout
            )
            if element:
                return True, f"元素已出现: {action.target_description}"
            else:
                return False, f"等待超时: {action.target_description}"
        except Exception as e:
            return False, f"等待失败: {str(e)}"

    async def _execute_navigate(self, action: AgentAction) -> Tuple[bool, str]:
        """执行导航操作"""
        if not action.url:
            return False, "未指定 URL"

        await self.page.goto(action.url, wait_until="domcontentloaded", timeout=30000)
        return True, f"导航到: {action.url}"

    async def _execute_refresh(self, action: AgentAction) -> Tuple[bool, str]:
        """执行刷新操作"""
        await self.page.reload(wait_until="domcontentloaded", timeout=30000)
        return True, "页面已刷新"

    async def _find_element(
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

        # 从描述中提取关键短语（处理类似 "Phone number option with 'Add a phone number'" 的情况）
        key_phrases = [description]
        # 提取引号内的文字
        import re as regex_module
        quoted = regex_module.findall(r"['\"]([^'\"]+)['\"]", description)
        key_phrases.extend(quoted)
        # 提取 "with" 之后的部分
        if " with " in description:
            after_with = description.split(" with ", 1)[1].strip().strip("'\"")
            key_phrases.append(after_with)
        # 提取 "option" 之前的部分
        if " option" in desc_lower:
            before_option = description.split(" option")[0].strip()
            key_phrases.append(before_option)

        print(f"[AI Agent] 元素定位关键短语: {key_phrases}")

        # 检测是否是按钮相关的描述
        is_button = any(kw in desc_lower for kw in [
            "button", "next", "submit", "continue", "confirm", "ok", "sign in", "login",
            "下一步", "继续", "确认", "提交", "登录", "确定"
        ])

        # 检测是否是验证码相关的输入框
        is_code_input = any(kw in desc_lower for kw in [
            "code", "verification", "otp", "2fa", "authenticator", "pin", "totp",
            "验证码", "动态码", "安全码"
        ])

        # 检测是否是链接相关的描述（如 "Can't scan it?"）
        is_link = any(kw in desc_lower for kw in [
            "scan", "link", "click here", "learn more", "help",
            "can't", "cannot", "unable", "trouble",
            "无法扫描", "扫描", "了解详情", "帮助", "点击此处",
            "スキャン", "스캔", "scanner", "escanear", "digitalizar"
        ])

        # 定位策略列表
        strategies = []

        # 如果是链接，优先使用链接定位策略
        if is_link:
            # 清理描述中的特殊字符用于匹配
            clean_desc = description.replace("'", ".?").replace("?", ".?")

            strategies.extend([
                # 精确匹配链接文本（优先级最高）
                lambda: self.page.locator('a, button, [role="link"], [role="button"]').filter(has_text=re.compile(r"can.?t\s*scan", re.I)).first,
                # 链接角色 + 部分匹配
                lambda: self.page.get_by_role("link", name=re.compile(r"scan", re.I)),
                # 按钮角色 + 部分匹配（Google 有时用 button 做链接）
                lambda: self.page.get_by_role("button", name=re.compile(r"scan", re.I)),
                # a 标签 + 文本匹配
                lambda: self.page.locator('a').filter(has_text=re.compile(r"scan", re.I)).first,
                # span/div 小元素 + 文本匹配（排除大容器）
                lambda: self.page.locator('span, div:not([id="yDmH0d"])').filter(has_text=re.compile(r"can.?t\s*scan", re.I)).first,
                # Google 特有：带 jsaction 的小元素
                lambda: self.page.locator('span[jsaction], div[jsaction], a[jsaction]').filter(has_text=re.compile(r"scan", re.I)).first,
                # Google 特有：带 jscontroller 的链接元素
                lambda: self.page.locator('span[jscontroller], a[jscontroller]').filter(has_text=re.compile(r"scan", re.I)).first,
                # 任何包含完整 "Can't scan" 文本的非容器元素
                lambda: self.page.locator('span, a, button, [role="link"]').filter(has_text=re.compile(r"can.?t\s*scan\s*it", re.I)).first,
                # 中文匹配
                lambda: self.page.locator('span, a, button, [role="link"]').filter(has_text=re.compile(r"无法.?扫描", re.I)).first,
                # 通过 class 名称找链接样式元素
                lambda: self.page.locator('[class*="link"], [class*="Link"]').filter(has_text=re.compile(r"scan", re.I)).first,
                # 通过样式查找（蓝色文本通常是链接）
                lambda: self.page.locator('span[style*="color"], a[style*="color"]').filter(has_text=re.compile(r"scan", re.I)).first,
            ])

        # 如果是验证码输入，优先使用验证码输入框定位策略
        if is_code_input:
            strategies.extend([
                # Google 2FA 验证码输入框常用属性
                lambda: self.page.locator('input[type="tel"]'),
                lambda: self.page.locator('input[name="totpPin"]'),
                lambda: self.page.locator('input[name="pin"]'),
                lambda: self.page.locator('input[autocomplete="one-time-code"]'),
                lambda: self.page.locator('input[aria-label*="code" i]'),
                lambda: self.page.locator('input[aria-label*="Enter" i]'),
                lambda: self.page.locator('input[id*="code" i]'),
                lambda: self.page.locator('input[id*="pin" i]'),
                lambda: self.page.locator('input[id*="totp" i]'),
                # 数字输入框
                lambda: self.page.locator('input[inputmode="numeric"]'),
                lambda: self.page.locator('input[pattern*="[0-9]"]'),
                # Google 特有的验证码输入
                lambda: self.page.locator('input[data-initial-value]'),
                lambda: self.page.locator('input[jsname]').first,
            ])

        # 如果是按钮，优先使用按钮定位策略
        if is_button:
            # 提取按钮关键字用于更灵活匹配
            btn_keywords = []
            for kw in ["next", "continue", "submit", "sign in", "login", "ok", "confirm", "done", "verify"]:
                if kw in desc_lower:
                    btn_keywords.append(kw)

            strategies.extend([
                # 按钮角色 + 名称（最可靠）
                lambda: self.page.get_by_role("button", name=re.compile(description, re.I)),
                # 提交按钮
                lambda: self.page.locator('button[type="submit"]'),
                # 包含文本的按钮
                lambda: self.page.locator(f'button:has-text("{description}")'),
                # div/span 按钮（Google 常用）
                lambda: self.page.locator(f'div[role="button"]:has-text("{description}")'),
                lambda: self.page.locator(f'span[role="button"]:has-text("{description}")'),
                # 任何 role=button 的元素
                lambda: self.page.locator('[role="button"]').filter(has_text=re.compile(description, re.I)),
                # Google 特有：VfPpkd 类名的按钮
                lambda: self.page.locator('[class*="VfPpkd"]').filter(has_text=re.compile(description, re.I)),
                # Google 特有：RveJvd 类名的按钮
                lambda: self.page.locator('[class*="RveJvd"]').filter(has_text=re.compile(description, re.I)),
                # data-idom-class 按钮（Google 特有）
                lambda: self.page.locator('[data-idom-class*="button"]').filter(has_text=re.compile(description, re.I)),
                # jsaction 属性的元素（Google 常用）
                lambda: self.page.locator('[jsaction]').filter(has_text=re.compile(description, re.I)),
                # jscontroller 属性的按钮元素
                lambda: self.page.locator('[jscontroller][role="button"]'),
                # 通过精确文本查找任何可点击元素
                lambda: self.page.get_by_text(description, exact=True),
            ])

        # 通用策略
        strategies.extend([
            # 输入框角色 + 名称（最常用于表单输入）
            lambda: self.page.get_by_role("textbox", name=re.compile(description, re.I)),
            # 密码输入框（检测是否包含 password 关键字）
            lambda: self.page.locator('input[type="password"]') if "password" in desc_lower else None,
            # 输入框占位符
            lambda: self.page.get_by_placeholder(re.compile(description, re.I)),
            # 邮箱输入框
            lambda: self.page.locator('input[type="email"]') if "email" in desc_lower else None,
            # 通用 input 定位（基于 name/id 属性）
            lambda: self.page.locator(f'input[name*="{description}" i], input[id*="{description}" i]'),
            # aria-label
            lambda: self.page.locator(f'[aria-label*="{description}" i]'),
            # 精确文本匹配
            lambda: self.page.get_by_text(description, exact=True),
            # 模糊文本匹配
            lambda: self.page.get_by_text(description),
            # 按钮角色 + 名称（兜底）
            lambda: self.page.get_by_role("button", name=re.compile(description, re.I)),
            # 链接角色 + 名称
            lambda: self.page.get_by_role("link", name=re.compile(description, re.I)),
            # 通用选择器（如果描述看起来像选择器）
            lambda: self.page.locator(description) if self._is_selector(description) else None,
        ])

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
        for phrase in key_phrases[1:]:  # 跳过第一个（就是原始描述）
            if not phrase or len(phrase) < 3:
                continue
            print(f"[AI Agent] 尝试关键短语: {phrase}")
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

    async def take_screenshot(self) -> bytes:
        """
        截取当前页面截图

        Returns:
            PNG 格式的截图数据
        """
        return await self.page.screenshot(
            type="png",
            full_page=False,  # 只截取可视区域
        )
