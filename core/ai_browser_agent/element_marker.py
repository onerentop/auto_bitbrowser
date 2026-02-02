"""
Set-of-Mark (SoM) 元素标记器模块

提供可交互元素的提取、标注和元数据生成功能，
用于提升 AI 浏览器操作的定位准确率。
"""

import asyncio
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict, Any
from io import BytesIO

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    Image = None
    ImageDraw = None
    ImageFont = None


@dataclass
class MarkedElement:
    """标记的可交互元素"""

    id: int                                    # 唯一标记 ID [1] [2] [3]
    tag: str                                   # 标签名 button/input/a
    text: str                                  # 文本内容（截断50字符）
    role: Optional[str] = None                 # ARIA role
    bbox: Tuple[int, int, int, int] = (0, 0, 0, 0)  # 边界框 (x, y, width, height)
    center: Tuple[int, int] = (0, 0)           # 中心点坐标
    xpath: str = ""                            # 唯一 XPath 选择器
    css_selector: str = ""                     # CSS 选择器（备用）
    attributes: Dict[str, str] = field(default_factory=dict)  # 重要属性
    is_input: bool = False                     # 是否是输入元素
    is_visible: bool = True                    # 是否可见
    # V2.3: Backend Node ID 支持 (借鉴 browser-use)
    backend_node_id: Optional[int] = None      # CDP Backend Node ID（用于精确点击）
    node_id: Optional[int] = None              # CDP Node ID（会话内有效）
    # V2.3: 可交互性检测
    is_clickable: bool = False                 # 是否可点击（多层检测结果）
    cursor_style: Optional[str] = None         # CSS cursor 样式
    has_event_listener: bool = False           # 是否有事件监听器

    def to_summary(self) -> str:
        """生成元素摘要文本"""
        parts = [f"[{self.id}]"]

        # iframe 来源标记（帮助 AI 区分不同 iframe 的元素）
        frame_info = self.attributes.get("_frame")
        if frame_info:
            # 解析 iframe 前缀，提取关键信息
            # 格式: iframe[index:name] -> 显示为 [iframe:name]
            if ":" in frame_info:
                frame_name = frame_info.split(":", 1)[1].rstrip("]")
                frame_name_lower = frame_name.lower()
                # 简化常见的 iframe 名称
                if any(kw in frame_name_lower for kw in ["tokenized.play", "pay.google", "payments.google", "eacquire"]):
                    parts.append("[💳支付iframe]")
                elif any(kw in frame_name_lower for kw in ["ogs.google", "widget/app"]):
                    parts.append("[菜单iframe]")
                else:
                    parts.append(f"[iframe:{frame_name[:15]}]")
            else:
                parts.append(f"[{frame_info}]")

        # 标签类型
        if self.role:
            parts.append(f"<{self.tag} role={self.role}>")
        else:
            parts.append(f"<{self.tag}>")

        # 文本内容
        if self.text:
            display_text = self.text[:40] + "..." if len(self.text) > 40 else self.text
            parts.append(f'"{display_text}"')

        # 重要属性
        if self.attributes.get("placeholder"):
            parts.append(f'placeholder="{self.attributes["placeholder"][:30]}"')
        if self.attributes.get("aria-label"):
            parts.append(f'aria-label="{self.attributes["aria-label"][:30]}"')
        if self.attributes.get("type"):
            parts.append(f'type="{self.attributes["type"]}"')
        if self.attributes.get("name"):
            parts.append(f'name="{self.attributes["name"]}"')

        return " ".join(parts)


class ElementMarker:
    """Set-of-Mark 元素标记器"""

    # 可交互元素选择器
    INTERACTIVE_SELECTORS = [
        'button:visible',
        'a:visible',
        'input:visible',
        'textarea:visible',
        'select:visible',
        '[role="button"]:visible',
        '[role="link"]:visible',
        '[role="textbox"]:visible',
        '[role="checkbox"]:visible',
        '[role="radio"]:visible',
        '[role="menuitem"]:visible',
        '[role="tab"]:visible',
        '[role="option"]:visible',
        '[onclick]:visible',
        '[tabindex]:not([tabindex="-1"]):visible',
        '[contenteditable="true"]:visible',
    ]

    # 标记样式配置
    BORDER_COLOR = (255, 0, 0)       # 红色边框
    BORDER_WIDTH = 2                  # 边框宽度
    LABEL_BG_COLOR = (255, 0, 0)     # 标签背景色
    LABEL_TEXT_COLOR = (255, 255, 255)  # 标签文字色
    LABEL_FONT_SIZE = 12              # 标签字号
    LABEL_PADDING = 2                 # 标签内边距

    # 过滤配置
    MIN_ELEMENT_SIZE = 10             # 最小元素尺寸 (px)
    MAX_ELEMENTS = 80                 # 最大元素数量（增加以确保不遗漏重要按钮）
    MAX_TEXT_LENGTH = 50              # 文本截断长度

    def __init__(self):
        """初始化标记器"""
        self._font = None
        self._init_font()

    def _init_font(self):
        """初始化字体"""
        if ImageFont is None:
            return

        try:
            # 尝试加载系统字体
            self._font = ImageFont.truetype("arial.ttf", self.LABEL_FONT_SIZE)
        except (OSError, IOError):
            try:
                # Linux 备选
                self._font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", self.LABEL_FONT_SIZE)
            except (OSError, IOError):
                # 使用默认字体
                self._font = ImageFont.load_default()

    async def extract_elements(self, page) -> List[MarkedElement]:
        """
        从页面提取所有可交互元素（包括 iframe 内元素）

        Args:
            page: Playwright Page 对象

        Returns:
            MarkedElement 列表
        """
        elements = []
        element_id = 1
        seen_xpaths = set()  # 去重

        # 合并选择器以减少查询次数
        combined_selector = ", ".join(
            selector.replace(":visible", "")
            for selector in self.INTERACTIVE_SELECTORS
        )

        # 提取主页面元素
        main_elements = await self._extract_from_frame(
            page, combined_selector, seen_xpaths, element_id, frame_prefix=""
        )
        elements.extend(main_elements)
        element_id += len(main_elements)

        # 提取 iframe 内元素（支持 Google Pay 等支付弹窗）
        try:
            frames = page.frames

            # 等待 iframe 加载完成（最多等待 2 秒）
            if len(frames) > 1:
                try:
                    # 尝试等待网络空闲，让 iframe 有时间加载
                    await page.wait_for_load_state("networkidle", timeout=2000)
                except Exception:
                    # 超时也继续，不阻塞
                    pass
                # 重新获取 frames（可能有新加载的）
                frames = page.frames

            frame_index = 0  # 用于生成唯一标识
            for frame in frames:
                if frame == page.main_frame:
                    continue

                frame_url = frame.url
                # 只处理可信来源的 iframe
                trusted_domains = [
                    'google.com', 'gstatic.com', 'googleapis.com',
                    'pay.google.com', 'play.google.com',
                    'tokenized.play.google.com',  # 支付表单 iframe
                    'payments.google.com',  # 嵌套支付 iframe
                    'accounts.google.com', 'myaccount.google.com'
                ]
                if not any(domain in frame_url for domain in trusted_domains):
                    frame_index += 1
                    continue

                # 调试日志：显示正在处理的 iframe
                print(f"[ElementMarker] 处理 iframe[{frame_index}]: {frame_url[:80]}...")

                # 支付相关 iframe 需要额外等待加载
                is_payment_iframe = any(kw in frame_url.lower() for kw in [
                    "tokenized.play", "pay.google", "payments.google", "eacquire"
                ])
                if is_payment_iframe:
                    print(f"[ElementMarker] 检测到支付 iframe，等待加载...")
                    try:
                        await frame.wait_for_load_state("domcontentloaded", timeout=3000)
                    except Exception:
                        pass
                    await asyncio.sleep(0.5)  # 额外等待渲染

                try:
                    # 生成唯一的 iframe 前缀（结合 index 和 URL 域名）
                    # 格式: iframe[index:domain_or_path]
                    # 优先使用 URL 域名，因为 frame.name 可能是无意义的（如 "app"）
                    frame_name = ""
                    try:
                        from urllib.parse import urlparse
                        parsed = urlparse(frame_url)
                        # 使用域名（去掉 www.）
                        domain = parsed.netloc.replace("www.", "")
                        if domain:
                            frame_name = domain[:25]
                        else:
                            # fallback 到路径
                            frame_name = parsed.path.split("/")[-1][:20] or frame.name or "unknown"
                    except Exception:
                        frame_name = frame.name or frame_url.split("/")[-1][:20] or "unknown"
                    frame_prefix = f"iframe[{frame_index}:{frame_name}]"

                    # 获取 iframe 元素在主页面的位置偏移
                    frame_offset = (0, 0)
                    try:
                        # 查找 iframe 元素
                        frame_element = await page.query_selector(f'iframe[name="{frame.name}"]') if frame.name else None
                        if not frame_element:
                            # 尝试通过 src 查找
                            # 从 URL 提取有效的后缀片段，避免空字符串匹配所有 iframe
                            url_suffix = frame_url.rstrip("/").split("/")[-1][:30] if frame_url else ""
                            if url_suffix:  # 只有非空才进行查询
                                frame_element = await page.query_selector(f'iframe[src*="{url_suffix}"]')
                        if frame_element:
                            box = await frame_element.bounding_box()
                            if box:
                                frame_offset = (int(box["x"]), int(box["y"]))
                                print(f"[ElementMarker] iframe 偏移: {frame_offset}")
                    except Exception as e:
                        print(f"[ElementMarker] 获取 iframe 偏移失败: {e}")

                    frame_elements = await self._extract_from_frame(
                        frame, combined_selector, seen_xpaths, element_id, frame_prefix,
                        frame_offset=frame_offset
                    )
                    if frame_elements:
                        print(f"[ElementMarker] 从 iframe 提取到 {len(frame_elements)} 个元素")
                        elements.extend(frame_elements)
                        element_id += len(frame_elements)
                except Exception as e:
                    print(f"[ElementMarker] iframe 元素提取失败: {e}")
                finally:
                    frame_index += 1  # 确保索引递增
        except Exception as e:
            print(f"[ElementMarker] 获取 frames 失败: {e}")

        return elements

    async def _extract_from_frame(
        self,
        frame,
        combined_selector: str,
        seen_xpaths: set,
        start_id: int,
        frame_prefix: str = "",
        frame_offset: Tuple[int, int] = (0, 0)
    ) -> List[MarkedElement]:
        """
        从单个 frame 提取元素

        Args:
            frame: Playwright Frame 对象
            combined_selector: CSS 选择器
            seen_xpaths: 已见 XPath 集合（用于去重）
            start_id: 起始元素 ID
            frame_prefix: iframe 前缀（用于 XPath）
            frame_offset: iframe 在主页面的偏移量 (x, y)，用于计算绝对坐标

        Returns:
            MarkedElement 列表
        """
        elements = []
        element_id = start_id

        try:
            # 使用 JavaScript 提取元素信息（更高效）
            # is_iframe: 是否是 iframe 内的提取（放宽视口检测）
            is_iframe = bool(frame_prefix)

            # 调试：先检查选择器匹配到的原始元素数量
            if is_iframe:
                try:
                    raw_count = await frame.evaluate("""
                        (selector) => document.querySelectorAll(selector).length
                    """, combined_selector)
                    print(f"[ElementMarker] {frame_prefix} 原始选择器匹配: {raw_count} 个元素")
                except Exception as e:
                    print(f"[ElementMarker] 调试查询失败: {e}")

            elements_data = await frame.evaluate("""
                (config) => {
                    const selector = config.selector;
                    const minSize = config.minSize;
                    const maxElements = config.maxElements;
                    const maxTextLength = config.maxTextLength;
                    const isIframe = config.isIframe;

                    const elements = document.querySelectorAll(selector);
                    const results = [];

                    for (const el of elements) {
                        if (results.length >= maxElements) break;

                        // 检查可见性
                        const rect = el.getBoundingClientRect();
                        const style = window.getComputedStyle(el);

                        if (style.display === 'none' ||
                            style.visibility === 'hidden' ||
                            style.opacity === '0' ||
                            rect.width < minSize ||
                            rect.height < minSize) {
                            continue;
                        }

                        // 检查是否在视口内
                        // 对于 iframe 内的元素，放宽视口检测（iframe 可能有自己的滚动）
                        if (!isIframe) {
                            if (rect.bottom < 0 || rect.top > window.innerHeight ||
                                rect.right < 0 || rect.left > window.innerWidth) {
                                continue;
                            }
                        } else {
                            // iframe 内：只检查元素是否有有效尺寸（已在上面检查）
                            // 不严格检查视口，因为 iframe 可能需要内部滚动
                        }

                        // 生成 XPath
                        const getXPath = (element) => {
                            if (element.id) {
                                return `//*[@id="${element.id}"]`;
                            }

                            const parts = [];
                            let current = element;

                            while (current && current.nodeType === Node.ELEMENT_NODE) {
                                let index = 1;
                                let sibling = current.previousElementSibling;

                                while (sibling) {
                                    if (sibling.tagName === current.tagName) {
                                        index++;
                                    }
                                    sibling = sibling.previousElementSibling;
                                }

                                const tagName = current.tagName.toLowerCase();
                                const part = index > 1 ? `${tagName}[${index}]` : tagName;
                                parts.unshift(part);
                                current = current.parentElement;
                            }

                            return '/' + parts.join('/');
                        };

                        // 获取文本内容
                        let text = el.innerText || el.textContent || '';
                        text = text.trim().replace(/\\s+/g, ' ');
                        if (text.length > maxTextLength) {
                            text = text.substring(0, maxTextLength);
                        }

                        // 生成 CSS 选择器
                        const getCssSelector = (element) => {
                            if (element.id) {
                                return `#${element.id}`;
                            }

                            const tag = element.tagName.toLowerCase();
                            const classes = Array.from(element.classList).slice(0, 2).join('.');

                            if (classes) {
                                return `${tag}.${classes}`;
                            }

                            return tag;
                        };

                        const tagName = el.tagName.toLowerCase();
                        const isInput = ['input', 'textarea', 'select'].includes(tagName);

                        results.push({
                            tag: tagName,
                            text: text,
                            role: el.getAttribute('role'),
                            bbox: {
                                x: Math.round(rect.x),
                                y: Math.round(rect.y),
                                width: Math.round(rect.width),
                                height: Math.round(rect.height)
                            },
                            center: {
                                x: Math.round(rect.x + rect.width / 2),
                                y: Math.round(rect.y + rect.height / 2)
                            },
                            xpath: getXPath(el),
                            css_selector: getCssSelector(el),
                            attributes: {
                                type: el.getAttribute('type'),
                                name: el.getAttribute('name'),
                                placeholder: el.getAttribute('placeholder'),
                                'aria-label': el.getAttribute('aria-label'),
                                value: isInput ? el.value : null,
                                href: el.getAttribute('href')
                            },
                            is_input: isInput
                        });
                    }

                    return results;
                }
            """, {
                "selector": combined_selector,
                "minSize": self.MIN_ELEMENT_SIZE,
                "maxElements": self.MAX_ELEMENTS,
                "maxTextLength": self.MAX_TEXT_LENGTH,
                "isIframe": is_iframe
            })

            # 转换为 MarkedElement 对象
            for data in elements_data:
                xpath = data["xpath"]

                # 添加 iframe 前缀（用于区分来源）
                if frame_prefix:
                    xpath = f"{frame_prefix}:{xpath}"

                # 去重
                if xpath in seen_xpaths:
                    continue
                seen_xpaths.add(xpath)

                # 清理 attributes 中的 None 值
                attributes = {k: v for k, v in data["attributes"].items() if v is not None}

                # 如果是 iframe 元素，添加来源标记
                if frame_prefix:
                    attributes["_frame"] = frame_prefix

                # 计算绝对坐标（加上 iframe 偏移）
                offset_x, offset_y = frame_offset
                abs_bbox_x = data["bbox"]["x"] + offset_x
                abs_bbox_y = data["bbox"]["y"] + offset_y
                abs_center_x = data["center"]["x"] + offset_x
                abs_center_y = data["center"]["y"] + offset_y

                element = MarkedElement(
                    id=element_id,
                    tag=data["tag"],
                    text=data["text"],
                    role=data["role"],
                    bbox=(
                        abs_bbox_x,
                        abs_bbox_y,
                        data["bbox"]["width"],
                        data["bbox"]["height"]
                    ),
                    center=(abs_center_x, abs_center_y),
                    xpath=xpath,
                    css_selector=data["css_selector"],
                    attributes=attributes,
                    is_input=data["is_input"],
                    is_visible=True
                )

                elements.append(element)
                element_id += 1

        except Exception as e:
            if frame_prefix:
                print(f"[ElementMarker] iframe 元素提取失败 ({frame_prefix}): {e}")
            else:
                print(f"[ElementMarker] 元素提取失败: {e}")

        return elements

    def mark_screenshot(self, screenshot: bytes, elements: List[MarkedElement]) -> bytes:
        """
        在截图上绘制元素标记

        Args:
            screenshot: 原始截图字节
            elements: 元素列表

        Returns:
            标注后的截图字节
        """
        if Image is None or ImageDraw is None:
            print("[ElementMarker] Pillow 未安装，跳过标注")
            return screenshot

        try:
            # 加载图片
            img = Image.open(BytesIO(screenshot))
            draw = ImageDraw.Draw(img)

            for element in elements:
                x, y, width, height = element.bbox

                # 绘制边框
                draw.rectangle(
                    [(x, y), (x + width, y + height)],
                    outline=self.BORDER_COLOR,
                    width=self.BORDER_WIDTH
                )

                # 绘制标签
                label_text = str(element.id)

                # 计算标签尺寸
                if self._font:
                    try:
                        bbox = self._font.getbbox(label_text)
                        text_width = bbox[2] - bbox[0]
                        text_height = bbox[3] - bbox[1]
                    except AttributeError:
                        # 旧版 Pillow
                        text_width, text_height = draw.textsize(label_text, font=self._font)
                else:
                    text_width, text_height = len(label_text) * 7, 12

                label_width = text_width + self.LABEL_PADDING * 2
                label_height = text_height + self.LABEL_PADDING * 2

                # 标签位置（左上角）
                label_x = x
                label_y = max(0, y - label_height)

                # 绘制标签背景
                draw.rectangle(
                    [(label_x, label_y), (label_x + label_width, label_y + label_height)],
                    fill=self.LABEL_BG_COLOR
                )

                # 绘制标签文字
                draw.text(
                    (label_x + self.LABEL_PADDING, label_y + self.LABEL_PADDING),
                    label_text,
                    fill=self.LABEL_TEXT_COLOR,
                    font=self._font
                )

            # 转换回字节
            output = BytesIO()
            img.save(output, format='PNG')
            return output.getvalue()

        except Exception as e:
            print(f"[ElementMarker] 截图标注失败: {e}")
            return screenshot

    async def extract_and_mark(self, page) -> Tuple[bytes, List[MarkedElement]]:
        """
        一步完成元素提取和截图标注

        Args:
            page: Playwright Page 对象

        Returns:
            (标注截图, 元素列表)
        """
        # 提取元素
        elements = await self.extract_elements(page)

        # 截图
        screenshot = await page.screenshot(type='png')

        # 标注
        if elements:
            marked_screenshot = self.mark_screenshot(screenshot, elements)
        else:
            marked_screenshot = screenshot

        return marked_screenshot, elements

    def generate_elements_summary(
        self,
        elements: List[MarkedElement],
        max_elements: int = 30
    ) -> str:
        """
        生成元素列表摘要（供 AI 参考）

        Args:
            elements: 元素列表
            max_elements: 最大显示数量

        Returns:
            格式化的元素摘要字符串
        """
        if not elements:
            return "（无可交互元素）"

        lines = []

        # 按类型分组
        inputs = [e for e in elements if e.is_input]
        buttons = [e for e in elements if e.tag in ('button', 'a') or e.role in ('button', 'link')]
        others = [e for e in elements if e not in inputs and e not in buttons]

        # 输入框（优先显示更多，因为填写表单是常见任务）
        if inputs:
            lines.append("**输入框:**")
            for e in inputs[:20]:
                lines.append(f"  {e.to_summary()}")

        # 按钮/链接
        if buttons:
            lines.append("**按钮/链接:**")
            for e in buttons[:20]:
                lines.append(f"  {e.to_summary()}")

        # 其他
        if others and len(lines) < max_elements:
            remaining = max_elements - len(lines)
            lines.append("**其他:**")
            for e in others[:remaining]:
                lines.append(f"  {e.to_summary()}")

        # 添加总数提示
        total = len(elements)
        shown = min(total, max_elements)
        if total > shown:
            lines.append(f"\n（共 {total} 个元素，显示前 {shown} 个）")

        return "\n".join(lines)

    def find_element_by_id(
        self,
        elements: List[MarkedElement],
        element_id: int
    ) -> Optional[MarkedElement]:
        """
        根据 ID 查找元素

        Args:
            elements: 元素列表
            element_id: 目标 ID

        Returns:
            匹配的元素或 None
        """
        for element in elements:
            if element.id == element_id:
                return element
        return None
