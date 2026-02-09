"""
BrowserUse Engine - 动作执行器

负责解析和执行动作。
"""

import asyncio
import logging
import time
from typing import Any, List, Dict, Optional

from .registry import ActionRegistry
from ..protocol import ActionResult
from ..types import ActionModel

logger = logging.getLogger(__name__)


class ActionExecutor:
    """
    动作执行器

    负责解析 ActionModel 并调用对应的处理器执行动作。
    """

    def __init__(
        self,
        page: Any,
        dom_service: Any = None,
        llm: Any = None,
    ):
        """
        初始化执行器

        Args:
            page: Playwright Page 对象
            dom_service: DOM 服务实例
            llm: LLM 适配器实例
        """
        self.page = page
        self.dom_service = dom_service
        self.llm = llm

    async def execute(self, action: ActionModel) -> ActionResult:
        """
        执行单个动作

        Args:
            action: 动作模型

        Returns:
            ActionResult
        """
        action_type = action.get_action_type()
        if not action_type:
            return ActionResult(success=False, error="无效的动作")

        # 获取动作参数
        params = action.get_action_params()

        # 获取处理器
        handler = ActionRegistry.get_handler(action_type)
        if not handler:
            return ActionResult(
                success=False,
                error=f"未知动作: {action_type}"
            )

        # 构建调用参数
        call_kwargs = {
            "page": self.page,
            "dom_service": self.dom_service,
            "llm": self.llm,
            **params
        }

        try:
            # 执行动作
            result = await handler(**call_kwargs)
            return result
        except Exception as e:
            logger.error(f"执行动作 {action_type} 失败: {e}")
            return ActionResult(
                success=False,
                error=str(e)
            )

    async def execute_batch(
        self,
        actions: List[ActionModel],
        stop_on_done: bool = True,
        stop_on_error: bool = False,
    ) -> List[ActionResult]:
        """
        批量执行动作序列

        Args:
            actions: 动作列表
            stop_on_done: 遇到 done 动作时停止
            stop_on_error: 遇到错误时停止

        Returns:
            ActionResult 列表
        """
        results = []

        for action in actions:
            result = await self.execute(action)
            results.append(result)

            # 检查是否需要停止
            if stop_on_done and action.done is not None:
                logger.info("遇到 done 动作，停止执行")
                break

            if stop_on_error and not result.success:
                logger.warning(f"动作执行失败，停止执行: {result.error}")
                break

            # 动作之间短暂等待，让页面响应
            await asyncio.sleep(0.2)

        return results

    async def execute_raw(
        self,
        action_type: str,
        **params
    ) -> ActionResult:
        """
        直接执行动作 (不经过 ActionModel)

        Args:
            action_type: 动作类型名称
            **params: 动作参数

        Returns:
            ActionResult
        """
        handler = ActionRegistry.get_handler(action_type)
        if not handler:
            return ActionResult(
                success=False,
                error=f"未知动作: {action_type}"
            )

        call_kwargs = {
            "page": self.page,
            "dom_service": self.dom_service,
            "llm": self.llm,
            **params
        }

        try:
            return await handler(**call_kwargs)
        except Exception as e:
            logger.error(f"执行动作 {action_type} 失败: {e}")
            return ActionResult(
                success=False,
                error=str(e)
            )

    @staticmethod
    def is_done_action(action: ActionModel) -> bool:
        """检查是否是完成动作"""
        return action.done is not None

    @staticmethod
    def get_done_result(action: ActionModel) -> Optional[str]:
        """获取完成动作的结果消息"""
        if action.done is not None:
            return action.done.message
        return None
