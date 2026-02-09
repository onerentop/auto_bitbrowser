"""
BrowserUse Engine - 动作注册器

提供动作注册装饰器和动作元数据管理。
"""

import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Any, Optional, Awaitable

logger = logging.getLogger(__name__)


@dataclass
class ActionSchema:
    """动作元数据"""
    name: str
    description: str
    parameters: Dict[str, Any] = field(default_factory=dict)
    handler: Optional[Callable[..., Awaitable[Any]]] = None


class ActionRegistry:
    """
    动作注册表

    使用装饰器模式注册动作处理器。

    使用示例:
        ```python
        @ActionRegistry.action("my_action", "执行自定义动作")
        async def my_action(page, param1: str) -> ActionResult:
            # 实现动作逻辑
            return ActionResult(success=True)
        ```
    """

    _actions: Dict[str, ActionSchema] = {}

    @classmethod
    def action(cls, name: str, description: str, parameters: Optional[Dict] = None):
        """
        动作注册装饰器

        Args:
            name: 动作名称
            description: 动作描述
            parameters: 参数 JSON Schema

        Returns:
            装饰器函数
        """
        def decorator(func: Callable[..., Awaitable[Any]]):
            schema = ActionSchema(
                name=name,
                description=description,
                parameters=parameters or {},
                handler=func,
            )
            cls._actions[name] = schema
            logger.debug(f"注册动作: {name}")
            return func
        return decorator

    @classmethod
    def register(
        cls,
        name: str,
        handler: Callable[..., Awaitable[Any]],
        description: str = "",
        parameters: Optional[Dict] = None,
    ) -> None:
        """
        编程式注册动作

        Args:
            name: 动作名称
            handler: 处理器函数
            description: 动作描述
            parameters: 参数 JSON Schema
        """
        schema = ActionSchema(
            name=name,
            description=description or f"执行 {name} 动作",
            parameters=parameters or {},
            handler=handler,
        )
        cls._actions[name] = schema
        logger.debug(f"注册动作: {name}")

    @classmethod
    def get_action(cls, name: str) -> Optional[ActionSchema]:
        """获取动作元数据"""
        return cls._actions.get(name)

    @classmethod
    def get_handler(cls, name: str) -> Optional[Callable]:
        """获取动作处理器"""
        schema = cls._actions.get(name)
        return schema.handler if schema else None

    @classmethod
    def list_actions(cls) -> List[str]:
        """列出所有已注册的动作名称"""
        return list(cls._actions.keys())

    @classmethod
    def get_all_schemas(cls) -> List[ActionSchema]:
        """获取所有动作元数据"""
        return list(cls._actions.values())

    @classmethod
    def get_action_descriptions(cls) -> str:
        """生成动作描述文本 (用于提示词)"""
        lines = []
        for schema in cls._actions.values():
            lines.append(f"- {schema.name}: {schema.description}")
        return "\n".join(lines)

    @classmethod
    def get_json_schema(cls) -> List[Dict[str, Any]]:
        """
        生成动作的 JSON Schema (用于 LLM 结构化输出)

        Returns:
            动作 JSON Schema 列表
        """
        schemas = []
        for schema in cls._actions.values():
            action_schema = {
                "name": schema.name,
                "description": schema.description,
            }
            if schema.parameters:
                action_schema["parameters"] = schema.parameters
            schemas.append(action_schema)
        return schemas

    @classmethod
    def clear(cls) -> None:
        """清空所有注册的动作 (主要用于测试)"""
        cls._actions.clear()
