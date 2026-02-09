"""
BrowserUse Engine - 内置动作

定义所有内置的浏览器动作。
"""

import asyncio
import base64
import logging
import time
from typing import Any, Optional

from .registry import ActionRegistry
from ..protocol import ActionResult
from ..types import DOMTree

logger = logging.getLogger(__name__)


# ==================== 导航动作 ====================

@ActionRegistry.action(
    "navigate",
    "导航到指定 URL",
    parameters={
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "目标 URL"}
        },
        "required": ["url"]
    }
)
async def navigate(
    page: Any,
    url: str,
    wait_until: str = "domcontentloaded",
    timeout: float = 30000,
    **kwargs
) -> ActionResult:
    """导航到 URL"""
    start_time = time.time()
    try:
        await page.goto(url, wait_until=wait_until, timeout=timeout)
        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message=f"已导航到 {url}",
            duration_ms=duration_ms,
        )
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"导航失败: {url} - {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 点击动作 ====================

@ActionRegistry.action(
    "click",
    "点击指定索引的元素",
    parameters={
        "type": "object",
        "properties": {
            "index": {"type": "integer", "description": "元素索引号"}
        },
        "required": ["index"]
    }
)
async def click(
    page: Any,
    index: int,
    dom_service: Any = None,
    **kwargs
) -> ActionResult:
    """点击元素"""
    start_time = time.time()

    if not dom_service:
        return ActionResult(success=False, error="DOM 服务不可用")

    try:
        # 获取选择器或坐标
        selector = dom_service.get_selector_by_index(index)
        coordinates = dom_service.get_coordinates_by_index(index)

        if selector:
            # 优先使用选择器
            try:
                await page.click(selector, timeout=5000)
                duration_ms = (time.time() - start_time) * 1000
                return ActionResult(
                    success=True,
                    message=f"已点击元素 [{index}]",
                    duration_ms=duration_ms,
                )
            except Exception as e:
                logger.debug(f"选择器点击失败: {e}, 尝试坐标点击")

        if coordinates:
            # 使用坐标点击
            x, y = coordinates
            await page.mouse.click(x, y)
            duration_ms = (time.time() - start_time) * 1000
            return ActionResult(
                success=True,
                message=f"已点击元素 [{index}] (坐标: {x:.0f}, {y:.0f})",
                duration_ms=duration_ms,
            )

        return ActionResult(
            success=False,
            error=f"找不到索引为 {index} 的元素",
            duration_ms=(time.time() - start_time) * 1000,
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"点击失败: [{index}] - {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 输入动作 ====================

@ActionRegistry.action(
    "input",
    "在指定元素中输入文本",
    parameters={
        "type": "object",
        "properties": {
            "index": {"type": "integer", "description": "元素索引号"},
            "text": {"type": "string", "description": "要输入的文本"},
            "clear": {"type": "boolean", "description": "是否先清空", "default": True}
        },
        "required": ["index", "text"]
    }
)
async def input_text(
    page: Any,
    index: int,
    text: str,
    clear: bool = True,
    dom_service: Any = None,
    **kwargs
) -> ActionResult:
    """输入文本"""
    start_time = time.time()

    if not dom_service:
        return ActionResult(success=False, error="DOM 服务不可用")

    try:
        selector = dom_service.get_selector_by_index(index)
        coordinates = dom_service.get_coordinates_by_index(index)

        if selector:
            try:
                if clear:
                    await page.fill(selector, text, timeout=5000)
                else:
                    await page.click(selector, timeout=5000)
                    await page.keyboard.type(text)
                duration_ms = (time.time() - start_time) * 1000
                return ActionResult(
                    success=True,
                    message=f"已在元素 [{index}] 输入文本",
                    duration_ms=duration_ms,
                )
            except Exception as e:
                logger.debug(f"选择器输入失败: {e}, 尝试坐标输入")

        if coordinates:
            x, y = coordinates
            await page.mouse.click(x, y)
            await asyncio.sleep(0.1)
            if clear:
                await page.keyboard.press("Control+a")
                await page.keyboard.press("Backspace")
            await page.keyboard.type(text)
            duration_ms = (time.time() - start_time) * 1000
            return ActionResult(
                success=True,
                message=f"已在元素 [{index}] 输入文本 (坐标)",
                duration_ms=duration_ms,
            )

        return ActionResult(
            success=False,
            error=f"找不到索引为 {index} 的元素",
            duration_ms=(time.time() - start_time) * 1000,
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"输入失败: [{index}] - {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 滚动动作 ====================

@ActionRegistry.action(
    "scroll",
    "滚动页面",
    parameters={
        "type": "object",
        "properties": {
            "direction": {"type": "string", "enum": ["up", "down"], "default": "down"},
            "amount": {"type": "number", "description": "滚动量 (页面比例)", "default": 0.5}
        }
    }
)
async def scroll(
    page: Any,
    direction: str = "down",
    amount: float = 0.5,
    **kwargs
) -> ActionResult:
    """滚动页面"""
    start_time = time.time()
    try:
        # 获取视口高度
        viewport = page.viewport_size
        scroll_amount = int(viewport["height"] * amount) if viewport else 500

        if direction == "up":
            scroll_amount = -scroll_amount

        await page.evaluate(f"window.scrollBy(0, {scroll_amount})")
        await asyncio.sleep(0.3)  # 等待滚动完成

        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message=f"已滚动 {direction} {abs(scroll_amount)}px",
            duration_ms=duration_ms,
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"滚动失败: {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 提取动作 ====================

@ActionRegistry.action(
    "extract",
    "从页面提取信息",
    parameters={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "要提取的信息描述"}
        },
        "required": ["query"]
    }
)
async def extract(
    page: Any,
    query: str,
    llm: Any = None,
    **kwargs
) -> ActionResult:
    """提取页面信息"""
    start_time = time.time()
    try:
        # 获取页面文本内容
        content = await page.evaluate("() => document.body.innerText")

        # 如果有 LLM，使用 LLM 提取
        if llm:
            from ..llm.base import SystemMessage, UserMessage
            messages = [
                SystemMessage("你是一个信息提取助手。从给定的页面内容中提取用户需要的信息。只返回提取的信息，不要添加额外说明。"),
                UserMessage(f"页面内容:\n{content[:5000]}\n\n请提取: {query}")
            ]
            response = await llm.ainvoke(messages)
            extracted = response.content
        else:
            # 没有 LLM，返回原始内容的摘要
            extracted = content[:500] + "..." if len(content) > 500 else content

        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message="信息提取成功",
            extracted_content=extracted,
            duration_ms=duration_ms,
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"提取失败: {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 截图动作 ====================

@ActionRegistry.action(
    "screenshot",
    "截取页面截图",
    parameters={
        "type": "object",
        "properties": {
            "filename": {"type": "string", "description": "保存文件名 (可选)"}
        }
    }
)
async def screenshot(
    page: Any,
    filename: Optional[str] = None,
    **kwargs
) -> ActionResult:
    """截取页面截图"""
    start_time = time.time()
    try:
        screenshot_bytes = await page.screenshot(type="png", full_page=False)
        screenshot_base64 = base64.b64encode(screenshot_bytes).decode()

        if filename:
            with open(filename, "wb") as f:
                f.write(screenshot_bytes)

        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message=f"截图成功" + (f"，已保存到 {filename}" if filename else ""),
            extracted_content=screenshot_base64,
            duration_ms=duration_ms,
        )

    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        logger.error(f"截图失败: {e}")
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 等待动作 ====================

@ActionRegistry.action(
    "wait",
    "等待指定时间",
    parameters={
        "type": "object",
        "properties": {
            "milliseconds": {"type": "integer", "description": "等待毫秒数", "default": 1000}
        }
    }
)
async def wait(
    milliseconds: int = 1000,
    **kwargs
) -> ActionResult:
    """等待"""
    start_time = time.time()
    await asyncio.sleep(milliseconds / 1000)
    duration_ms = (time.time() - start_time) * 1000
    return ActionResult(
        success=True,
        message=f"已等待 {milliseconds}ms",
        duration_ms=duration_ms,
    )


# ==================== 完成动作 ====================

@ActionRegistry.action(
    "done",
    "标记任务完成",
    parameters={
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "完成消息或提取结果"},
            "success": {"type": "boolean", "description": "是否成功完成", "default": True}
        },
        "required": ["message"]
    }
)
async def done(
    message: str,
    success: bool = True,
    **kwargs
) -> ActionResult:
    """标记任务完成"""
    return ActionResult(
        success=success,
        message=message,
        extracted_content=message if success else None,
        duration_ms=0,
    )


# ==================== 按键动作 ====================

@ActionRegistry.action(
    "press_key",
    "按下键盘按键",
    parameters={
        "type": "object",
        "properties": {
            "key": {"type": "string", "description": "按键名称 (如 Enter, Tab, Escape)"}
        },
        "required": ["key"]
    }
)
async def press_key(
    page: Any,
    key: str,
    **kwargs
) -> ActionResult:
    """按下键盘按键"""
    start_time = time.time()
    try:
        await page.keyboard.press(key)
        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message=f"已按下 {key}",
            duration_ms=duration_ms,
        )
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )


# ==================== 后退/前进动作 ====================

@ActionRegistry.action(
    "go_back",
    "返回上一页"
)
async def go_back(
    page: Any,
    **kwargs
) -> ActionResult:
    """返回上一页"""
    start_time = time.time()
    try:
        await page.go_back()
        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=True,
            message="已返回上一页",
            duration_ms=duration_ms,
        )
    except Exception as e:
        duration_ms = (time.time() - start_time) * 1000
        return ActionResult(
            success=False,
            error=str(e),
            duration_ms=duration_ms,
        )
