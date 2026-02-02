"""
截图管理器 - AI Browser Agent

统一管理页面截图和 SoM (Set-of-Mark) 元素标记功能。
提供截图捕获、元素提取、截图压缩等功能。

V2 增强：
- 智能 SoM 开关：根据页面复杂度自动决定是否启用
- 元素缓存：避免短时间内重复提取
- 性能统计：记录 SoM 提取耗时
"""

import hashlib
import time
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict, Any
from io import BytesIO

from playwright.async_api import Page

from .element_marker import ElementMarker, MarkedElement

# V2: CDP 增强标记器（可选依赖）
try:
    from .element_marker_v2 import (
        EnhancedElementMarker,
        ExtractionResult,
        create_enhanced_marker,
    )
    ENHANCED_MARKER_AVAILABLE = True
except ImportError:
    EnhancedElementMarker = None
    ExtractionResult = None
    create_enhanced_marker = None
    ENHANCED_MARKER_AVAILABLE = False

# Pillow 是可选依赖（用于截图压缩）
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    Image = None
    PIL_AVAILABLE = False

# 日志（可选依赖）
try:
    from .logging_config import get_agent_logger
    _logger = get_agent_logger()
except ImportError:
    import logging
    _logger = logging.getLogger("ai_browser_agent.screenshot")


@dataclass
class ScreenshotResult:
    """截图结果数据类"""

    screenshot: bytes                          # 截图数据（PNG 或压缩后的 JPEG）
    elements: List[MarkedElement] = field(default_factory=list)  # 提取的元素列表
    elements_summary: str = ""                 # 元素摘要文本（供 AI 参考）
    extraction_time_ms: float = 0.0            # V2: 元素提取耗时（毫秒）
    from_cache: bool = False                   # V2: 是否来自缓存
    som_enabled: bool = True                   # V2: 是否启用了 SoM

    @property
    def has_elements(self) -> bool:
        """是否包含元素信息"""
        return len(self.elements) > 0

    @property
    def element_count(self) -> int:
        """元素数量"""
        return len(self.elements)


@dataclass
class ElementCache:
    """V2: 元素缓存条目"""
    elements: List[MarkedElement]
    elements_summary: str
    url_hash: str
    timestamp: float
    screenshot_hash: str = ""

    def is_valid(self, max_age_seconds: float = 5.0) -> bool:
        """检查缓存是否有效"""
        return (time.time() - self.timestamp) < max_age_seconds


@dataclass
class SoMStats:
    """V2: SoM 性能统计"""
    total_extractions: int = 0
    total_time_ms: float = 0.0
    cache_hits: int = 0
    cache_misses: int = 0
    auto_disabled_count: int = 0  # 智能禁用次数
    avg_elements_count: float = 0.0

    def record_extraction(self, time_ms: float, elements_count: int):
        """记录一次提取"""
        self.total_extractions += 1
        self.total_time_ms += time_ms
        # 更新平均元素数
        self.avg_elements_count = (
            (self.avg_elements_count * (self.total_extractions - 1) + elements_count)
            / self.total_extractions
        )

    @property
    def avg_time_ms(self) -> float:
        """平均提取时间"""
        if self.total_extractions == 0:
            return 0.0
        return self.total_time_ms / self.total_extractions

    @property
    def cache_hit_rate(self) -> float:
        """缓存命中率"""
        total = self.cache_hits + self.cache_misses
        if total == 0:
            return 0.0
        return self.cache_hits / total

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "total_extractions": self.total_extractions,
            "total_time_ms": self.total_time_ms,
            "avg_time_ms": self.avg_time_ms,
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "cache_hit_rate": self.cache_hit_rate,
            "auto_disabled_count": self.auto_disabled_count,
            "avg_elements_count": self.avg_elements_count,
        }


class ScreenshotManager:
    """
    截图管理器

    统一管理页面截图和 SoM 元素标记，解决截图逻辑分散问题。

    功能：
    1. 统一截图入口
    2. 可选 SoM 元素标记
    3. 可选截图压缩
    4. 生成元素摘要供 AI 分析

    V2 增强：
    5. 智能 SoM 开关：根据页面复杂度自动决定
    6. 元素缓存：短时间内复用提取结果
    7. 性能统计：记录提取耗时

    Usage:
        manager = ScreenshotManager(use_som=True, smart_som=True)
        result = await manager.capture(page)
        # result.screenshot - 截图数据
        # result.elements - 元素列表
        # result.elements_summary - 元素摘要
        # result.extraction_time_ms - 提取耗时
    """

    def __init__(
        self,
        use_som: bool = True,
        compress: bool = False,
        compress_quality: int = 80,
        max_width: int = 1920,
        max_elements: int = 30,
        # V2 新参数
        smart_som: bool = False,
        cache_enabled: bool = True,
        cache_max_age: float = 5.0,
        som_timeout_threshold: float = 3000.0,  # SoM 超时阈值（毫秒）
        # V2.2 CDP 集成参数
        use_cdp: bool = False,
        use_accessibility_tree: bool = False,
        dpr_aware: bool = True,
    ):
        """
        初始化截图管理器

        Args:
            use_som: 是否启用 SoM 元素标记（默认 True）
            compress: 是否压缩截图（默认 False）
            compress_quality: 压缩质量 1-100（默认 80）
            max_width: 压缩后最大宽度（默认 1920）
            max_elements: 元素摘要中最大元素数（默认 30）
            smart_som: V2 - 智能 SoM 开关（默认 False）
            cache_enabled: V2 - 是否启用缓存（默认 True）
            cache_max_age: V2 - 缓存最大有效期（秒，默认 5.0）
            som_timeout_threshold: V2 - SoM 超时阈值（毫秒，默认 3000）
            use_cdp: V2.2 - 使用 CDP 增强标记器（默认 False）
            use_accessibility_tree: V2.2 - 使用可访问性树提取元素（默认 False）
            dpr_aware: V2.2 - 是否进行 DPR 坐标转换（默认 True）
        """
        self.use_som = use_som
        self.compress = compress
        self.compress_quality = compress_quality
        self.max_width = max_width
        self.max_elements = max_elements

        # V2 新属性
        self.smart_som = smart_som
        self.cache_enabled = cache_enabled
        self.cache_max_age = cache_max_age
        self.som_timeout_threshold = som_timeout_threshold

        # V2.2 CDP 集成属性
        self.use_cdp = use_cdp and ENHANCED_MARKER_AVAILABLE
        self.use_accessibility_tree = use_accessibility_tree
        self.dpr_aware = dpr_aware

        # 如果启用 SoM，创建元素标记器
        self._element_marker: Optional[ElementMarker] = None
        self._enhanced_marker: Optional["EnhancedElementMarker"] = None

        if self.use_som:
            if self.use_cdp and ENHANCED_MARKER_AVAILABLE:
                # 使用 CDP 增强标记器
                self._enhanced_marker = create_enhanced_marker(
                    use_cdp=True,
                    dpr_aware=dpr_aware,
                )
                _logger.debug("使用 CDP 增强标记器")
            else:
                # 使用标准 JS 标记器
                self._element_marker = ElementMarker()
                _logger.debug("使用标准 JS 标记器")

        # V2: 缓存和统计
        self._cache: Optional[ElementCache] = None
        self._stats = SoMStats()
        self._consecutive_slow_extractions = 0  # 连续慢提取次数
        self._som_temporarily_disabled = False  # 临时禁用标志

    # V2: 性能统计访问
    @property
    def stats(self) -> SoMStats:
        """获取 SoM 性能统计"""
        return self._stats

    def reset_stats(self):
        """重置统计"""
        self._stats = SoMStats()
        self._consecutive_slow_extractions = 0
        self._som_temporarily_disabled = False

    def clear_cache(self):
        """清除缓存"""
        self._cache = None

    async def capture(self, page: Page) -> ScreenshotResult:
        """
        捕获页面截图

        根据配置决定是否进行 SoM 标记和压缩。
        V2: 支持智能开关和缓存。
        V2.2: 支持 CDP 增强标记器。

        Args:
            page: Playwright Page 对象

        Returns:
            ScreenshotResult: 包含截图、元素列表和摘要
        """
        elements: List[MarkedElement] = []
        elements_summary: str = ""
        extraction_time_ms: float = 0.0
        from_cache: bool = False
        som_enabled: bool = False

        # V2: 决定是否使用 SoM
        should_use_som = self._should_use_som(page)

        # 判断使用哪个标记器
        marker = self._enhanced_marker or self._element_marker

        if should_use_som and marker:
            som_enabled = True

            # V2: 检查缓存
            cached_result = await self._check_cache(page)
            if cached_result:
                elements = cached_result.elements
                elements_summary = cached_result.elements_summary
                from_cache = True
                self._stats.cache_hits += 1
                _logger.debug(f"使用缓存元素: {len(elements)} 个")
            else:
                self._stats.cache_misses += 1

                # 使用 SoM 标记：提取元素 + 标注截图
                try:
                    start_time = time.time()

                    # V2.2: 根据标记器类型选择提取方式
                    if self._enhanced_marker:
                        # 使用 CDP 增强标记器
                        screenshot, extraction_result = await self._enhanced_marker.extract_and_mark_v2(
                            page, include_ax_tree=self.use_accessibility_tree
                        )
                        elements = extraction_result.elements
                        extraction_time_ms = extraction_result.extraction_time_ms
                        _logger.debug(
                            f"CDP 标记完成: {len(elements)} 个元素, "
                            f"方法={extraction_result.method}, DPR={extraction_result.dpr:.2f}"
                        )
                    else:
                        # 使用标准 JS 标记器
                        screenshot, elements = await self._element_marker.extract_and_mark(page)
                        extraction_time_ms = (time.time() - start_time) * 1000

                    # 生成元素摘要
                    if hasattr(marker, 'generate_elements_summary'):
                        elements_summary = marker.generate_elements_summary(
                            elements,
                            max_elements=self.max_elements
                        )
                    else:
                        elements_summary = self._generate_summary(elements)

                    # V2: 记录统计
                    self._stats.record_extraction(extraction_time_ms, len(elements))

                    # V2: 更新缓存
                    await self._update_cache(page, elements, elements_summary)

                    # V2: 智能开关检测
                    self._check_extraction_performance(extraction_time_ms)

                    _logger.debug(
                        f"SoM 标记完成: {len(elements)} 个元素, "
                        f"耗时 {extraction_time_ms:.1f}ms"
                    )

                    # 可选压缩
                    if self.compress:
                        screenshot = self._compress_screenshot(screenshot)

                    return ScreenshotResult(
                        screenshot=screenshot,
                        elements=elements,
                        elements_summary=elements_summary,
                        extraction_time_ms=extraction_time_ms,
                        from_cache=from_cache,
                        som_enabled=som_enabled,
                    )

                except Exception as e:
                    # SoM 失败时回退到普通截图
                    _logger.warning(f"SoM 标记失败，使用普通截图: {e}")
                    som_enabled = False

        # 普通截图（无 SoM 或 SoM 失败）
        screenshot = await page.screenshot(type="png", full_page=False)

        # 如果有缓存的元素（从缓存获取但需要新截图）
        if from_cache and elements:
            pass  # 保持缓存的元素
        else:
            elements = []
            elements_summary = ""

        # 可选压缩
        if self.compress:
            screenshot = self._compress_screenshot(screenshot)

        return ScreenshotResult(
            screenshot=screenshot,
            elements=elements,
            elements_summary=elements_summary,
            extraction_time_ms=extraction_time_ms,
            from_cache=from_cache,
            som_enabled=som_enabled,
        )

    def _should_use_som(self, page: Page) -> bool:
        """
        V2: 决定是否使用 SoM

        考虑因素：
        - use_som 配置
        - smart_som 智能开关
        - 临时禁用状态
        - V2.2: 支持增强标记器
        """
        if not self.use_som:
            return False

        # V2.2: 支持增强标记器
        if not self._element_marker and not self._enhanced_marker:
            return False

        # 智能开关：检查是否临时禁用
        if self.smart_som and self._som_temporarily_disabled:
            return False

        return True

    def _generate_summary(self, elements: List[MarkedElement]) -> str:
        """
        V2.2: 生成元素摘要（当标记器不支持时的回退方法）
        """
        if not elements:
            return ""

        lines = []
        for el in elements[:self.max_elements]:
            desc = f"[{el.id}] {el.tag}"
            if el.text:
                desc += f": {el.text[:50]}"
            if el.role:
                desc += f" (role={el.role})"
            lines.append(desc)

        return "\n".join(lines)

    def _check_extraction_performance(self, extraction_time_ms: float):
        """
        V2: 检查提取性能，决定是否临时禁用 SoM
        """
        if not self.smart_som:
            return

        if extraction_time_ms > self.som_timeout_threshold:
            self._consecutive_slow_extractions += 1
            if self._consecutive_slow_extractions >= 3:
                self._som_temporarily_disabled = True
                self._stats.auto_disabled_count += 1
                _logger.warning(
                    f"SoM 提取连续 {self._consecutive_slow_extractions} 次超时，"
                    f"临时禁用"
                )
        else:
            # 重置计数
            self._consecutive_slow_extractions = 0
            self._som_temporarily_disabled = False

    async def _check_cache(self, page: Page) -> Optional[ElementCache]:
        """
        V2: 检查缓存是否有效
        """
        if not self.cache_enabled or self._cache is None:
            return None

        if not self._cache.is_valid(self.cache_max_age):
            self._cache = None
            return None

        # 检查 URL 是否匹配
        current_url_hash = self._hash_url(page.url)
        if self._cache.url_hash != current_url_hash:
            self._cache = None
            return None

        return self._cache

    async def _update_cache(
        self,
        page: Page,
        elements: List[MarkedElement],
        elements_summary: str
    ):
        """
        V2: 更新缓存
        """
        if not self.cache_enabled:
            return

        self._cache = ElementCache(
            elements=elements,
            elements_summary=elements_summary,
            url_hash=self._hash_url(page.url),
            timestamp=time.time(),
        )

    def _hash_url(self, url: str) -> str:
        """计算 URL 哈希"""
        return hashlib.md5(url.encode()).hexdigest()[:16]

    async def capture_simple(self, page: Page) -> bytes:
        """
        简单截图（不进行 SoM 标记）

        用于需要快速截图的场景。

        Args:
            page: Playwright Page 对象

        Returns:
            截图数据
        """
        screenshot = await page.screenshot(type="png", full_page=False)

        if self.compress:
            screenshot = self._compress_screenshot(screenshot)

        return screenshot

    def _compress_screenshot(self, screenshot: bytes) -> bytes:
        """
        压缩截图

        将 PNG 转换为 JPEG 并调整大小以减少 API 调用成本。

        Args:
            screenshot: 原始 PNG 截图

        Returns:
            压缩后的截图（JPEG 格式）
        """
        if not PIL_AVAILABLE:
            _logger.warning("Pillow 不可用，跳过压缩")
            return screenshot

        try:
            # 打开图片
            img = Image.open(BytesIO(screenshot))

            # 调整大小（如果超过最大宽度）
            if img.width > self.max_width:
                ratio = self.max_width / img.width
                new_size = (self.max_width, int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)
                _logger.debug(f"调整截图大小: {img.width}x{img.height}")

            # 转换为 RGB（JPEG 不支持 alpha 通道）
            if img.mode in ('RGBA', 'LA', 'P'):
                # 创建白色背景
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                img = background
            elif img.mode != 'RGB':
                img = img.convert('RGB')

            # 压缩为 JPEG
            output = BytesIO()
            img.save(output, format="JPEG", quality=self.compress_quality, optimize=True)
            compressed = output.getvalue()

            # 计算压缩率
            original_size = len(screenshot)
            compressed_size = len(compressed)
            ratio = (1 - compressed_size / original_size) * 100
            _logger.debug(
                f"压缩完成: {original_size/1024:.1f}KB -> "
                f"{compressed_size/1024:.1f}KB ({ratio:.1f}% 减少)"
            )

            return compressed

        except Exception as e:
            _logger.warning(f"压缩失败: {e}")
            return screenshot

    def find_element_by_id(
        self,
        elements: List[MarkedElement],
        element_id: int
    ) -> Optional[MarkedElement]:
        """
        根据 ID 查找元素

        Args:
            elements: 元素列表
            element_id: 目标元素 ID

        Returns:
            匹配的元素或 None
        """
        if self._element_marker:
            return self._element_marker.find_element_by_id(elements, element_id)

        # 回退：手动查找
        for element in elements:
            if element.id == element_id:
                return element
        return None

    def parse_element_id_from_target(self, target: str) -> Optional[int]:
        """
        从 target 字符串解析元素 ID

        支持格式：
        - "[1]" -> 1
        - "[12]" -> 12
        - "Click [3] button" -> 3
        - "普通文本" -> None

        Args:
            target: AI 返回的 target 字符串

        Returns:
            解析出的元素 ID，或 None
        """
        import re

        if not target:
            return None

        # 匹配 [数字] 格式
        match = re.search(r'\[(\d+)\]', target)
        if match:
            return int(match.group(1))

        return None
