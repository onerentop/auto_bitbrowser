"""
Action 注册器模块

基于装饰器的 Action 注册机制，参考 browser-use 的设计
支持动态注册、参数验证和元数据管理
"""

from dataclasses import dataclass, field
from typing import (
    Callable,
    Dict,
    Any,
    Optional,
    List,
    Tuple,
    TypeVar,
    Awaitable,
    Union,
)
from functools import wraps
import asyncio
import inspect
import logging

from playwright.async_api import Page

from .types import ActionType, AgentAction

logger = logging.getLogger("ai_browser_agent.registry")

# 类型定义
ActionHandler = Callable[..., Awaitable[Tuple[bool, str]]]
T = TypeVar("T")


@dataclass
class ActionMetadata:
    """Action 元数据"""

    action_type: ActionType
    handler: ActionHandler
    description: str = ""
    requires_target: bool = False
    requires_value: bool = False
    requires_url: bool = False
    requires_coordinates: bool = False
    timeout_multiplier: float = 1.0  # 超时倍数
    retry_on_failure: bool = True  # 失败是否重试
    wait_after: float = 0.0  # 执行后等待时间（秒）
    tags: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            "action_type": self.action_type.value,
            "description": self.description,
            "requires_target": self.requires_target,
            "requires_value": self.requires_value,
            "requires_url": self.requires_url,
            "requires_coordinates": self.requires_coordinates,
            "timeout_multiplier": self.timeout_multiplier,
            "retry_on_failure": self.retry_on_failure,
            "wait_after": self.wait_after,
            "tags": self.tags,
        }


@dataclass
class ActionResult:
    """Action 执行结果（增强版）"""

    success: bool
    message: str
    data: Dict[str, Any] = field(default_factory=dict)
    error: Optional[Exception] = None
    retry_allowed: bool = True
    duration_ms: float = 0.0

    @classmethod
    def success_result(cls, message: str, **data) -> "ActionResult":
        """创建成功结果"""
        return cls(success=True, message=message, data=data)

    @classmethod
    def failure_result(
        cls, message: str, error: Exception = None, retry_allowed: bool = True
    ) -> "ActionResult":
        """创建失败结果"""
        return cls(
            success=False,
            message=message,
            error=error,
            retry_allowed=retry_allowed,
        )

    def to_tuple(self) -> Tuple[bool, str]:
        """转换为兼容旧接口的元组"""
        return (self.success, self.message)


class ActionRegistry:
    """
    Action 注册表（单例模式）

    管理所有注册的 Action 处理器，提供查找和验证功能
    """

    _instance: Optional["ActionRegistry"] = None
    _initialized: bool = False

    def __new__(cls) -> "ActionRegistry":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if not ActionRegistry._initialized:
            self._handlers: Dict[ActionType, ActionMetadata] = {}
            self._pre_hooks: List[Callable] = []
            self._post_hooks: List[Callable] = []
            ActionRegistry._initialized = True

    def register(
        self,
        action_type: ActionType,
        *,
        description: str = "",
        requires_target: bool = False,
        requires_value: bool = False,
        requires_url: bool = False,
        requires_coordinates: bool = False,
        timeout_multiplier: float = 1.0,
        retry_on_failure: bool = True,
        wait_after: float = 0.0,
        tags: List[str] = None,
    ) -> Callable[[ActionHandler], ActionHandler]:
        """
        注册 Action 处理器的装饰器

        Args:
            action_type: 动作类型
            description: 动作描述
            requires_target: 是否需要目标元素
            requires_value: 是否需要输入值
            requires_url: 是否需要 URL
            requires_coordinates: 是否需要坐标
            timeout_multiplier: 超时倍数（相对于默认超时）
            retry_on_failure: 失败是否允许重试
            wait_after: 执行后等待时间（秒）
            tags: 标签列表

        Example:
            @registry.register(
                ActionType.CLICK,
                description="点击元素",
                requires_target=True,
            )
            async def handle_click(page, action, **kwargs):
                # 实现点击逻辑
                return ActionResult.success_result("点击成功")
        """
        def decorator(handler: ActionHandler) -> ActionHandler:
            metadata = ActionMetadata(
                action_type=action_type,
                handler=handler,
                description=description,
                requires_target=requires_target,
                requires_value=requires_value,
                requires_url=requires_url,
                requires_coordinates=requires_coordinates,
                timeout_multiplier=timeout_multiplier,
                retry_on_failure=retry_on_failure,
                wait_after=wait_after,
                tags=tags or [],
            )
            self._handlers[action_type] = metadata
            logger.debug(f"Registered action handler: {action_type.value}")
            return handler

        return decorator

    def get_handler(self, action_type: ActionType) -> Optional[ActionMetadata]:
        """获取 Action 处理器元数据"""
        return self._handlers.get(action_type)

    def has_handler(self, action_type: ActionType) -> bool:
        """检查是否有处理器"""
        return action_type in self._handlers

    def validate_action(self, action: AgentAction) -> Tuple[bool, Optional[str]]:
        """
        验证 Action 参数

        Returns:
            (is_valid, error_message)
        """
        metadata = self.get_handler(action.action_type)
        if not metadata:
            return False, f"未知的动作类型: {action.action_type}"

        # 验证必需参数
        if metadata.requires_target and not action.target_description:
            return False, f"{action.action_type.value} 需要目标元素描述"

        if metadata.requires_value and not action.value:
            return False, f"{action.action_type.value} 需要输入值"

        if metadata.requires_url and not action.url:
            return False, f"{action.action_type.value} 需要 URL"

        if metadata.requires_coordinates:
            if action.x is None or action.y is None:
                # 坐标不是必须的，因为可能使用元素描述
                pass

        return True, None

    def list_actions(self) -> List[ActionMetadata]:
        """列出所有注册的 Action"""
        return list(self._handlers.values())

    def list_action_types(self) -> List[ActionType]:
        """列出所有注册的 Action 类型"""
        return list(self._handlers.keys())

    def add_pre_hook(self, hook: Callable):
        """添加执行前钩子"""
        self._pre_hooks.append(hook)

    def add_post_hook(self, hook: Callable):
        """添加执行后钩子"""
        self._post_hooks.append(hook)

    async def execute(
        self,
        page: Page,
        action: AgentAction,
        timeout: int = 10000,
        **kwargs,
    ) -> ActionResult:
        """
        执行 Action

        Args:
            page: Playwright Page 对象
            action: 要执行的动作
            timeout: 超时时间（毫秒）
            **kwargs: 额外参数（如 elements 列表）

        Returns:
            ActionResult 执行结果
        """
        import time
        start_time = time.time()

        # 验证动作
        is_valid, error = self.validate_action(action)
        if not is_valid:
            return ActionResult.failure_result(error, retry_allowed=False)

        metadata = self.get_handler(action.action_type)

        # 执行前钩子
        for hook in self._pre_hooks:
            try:
                if asyncio.iscoroutinefunction(hook):
                    await hook(action, metadata)
                else:
                    hook(action, metadata)
            except Exception as e:
                logger.warning(f"Pre-hook error: {e}")

        # 计算实际超时
        actual_timeout = int(timeout * metadata.timeout_multiplier)

        try:
            # 执行处理器
            handler = metadata.handler

            # 检查处理器签名，传递正确的参数
            sig = inspect.signature(handler)
            params = sig.parameters

            call_kwargs = {
                "page": page,
                "action": action,
                "timeout": actual_timeout,
            }
            call_kwargs.update(kwargs)

            # 过滤掉处理器不接受的参数
            filtered_kwargs = {}
            for key, value in call_kwargs.items():
                if key in params or any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
                    filtered_kwargs[key] = value

            result = await handler(**filtered_kwargs)

            # 处理返回值格式
            if isinstance(result, ActionResult):
                action_result = result
            elif isinstance(result, tuple) and len(result) == 2:
                # 兼容旧的 (bool, str) 返回格式
                success, message = result
                action_result = ActionResult(success=success, message=message)
            else:
                action_result = ActionResult(
                    success=True,
                    message=str(result) if result else "执行完成"
                )

            # 执行后等待
            if metadata.wait_after > 0:
                await asyncio.sleep(metadata.wait_after)

            # 记录执行时间
            action_result.duration_ms = (time.time() - start_time) * 1000

            return action_result

        except asyncio.TimeoutError:
            return ActionResult.failure_result(
                f"动作执行超时 ({actual_timeout}ms)",
                retry_allowed=metadata.retry_on_failure,
            )
        except Exception as e:
            logger.error(f"Action execution error: {e}")
            return ActionResult.failure_result(
                f"执行失败: {str(e)}",
                error=e,
                retry_allowed=metadata.retry_on_failure,
            )
        finally:
            # 执行后钩子
            for hook in self._post_hooks:
                try:
                    if asyncio.iscoroutinefunction(hook):
                        await hook(action, metadata)
                    else:
                        hook(action, metadata)
                except Exception as e:
                    logger.warning(f"Post-hook error: {e}")

    def clear(self):
        """清空所有注册（用于测试）"""
        self._handlers.clear()
        self._pre_hooks.clear()
        self._post_hooks.clear()


# 全局注册表实例
registry = ActionRegistry()


def action(
    action_type: ActionType,
    **kwargs,
) -> Callable[[ActionHandler], ActionHandler]:
    """
    便捷装饰器函数

    Example:
        @action(ActionType.CLICK, requires_target=True)
        async def handle_click(page, action, **kwargs):
            ...
    """
    return registry.register(action_type, **kwargs)


def get_registry() -> ActionRegistry:
    """获取全局注册表"""
    return registry


# ============ 终止类 Action 标记 ============

TERMINAL_ACTIONS = frozenset([
    ActionType.DONE,
    ActionType.ERROR,
    ActionType.NEED_VERIFICATION,
    ActionType.EXTRACT_SECRET,
])

NAVIGATION_ACTIONS = frozenset([
    ActionType.NAVIGATE,
    ActionType.REFRESH,
    ActionType.CLICK,  # 点击可能触发导航
])

INPUT_ACTIONS = frozenset([
    ActionType.FILL,
    ActionType.TYPE,
    ActionType.PRESS,
])


def is_terminal_action(action_type: ActionType) -> bool:
    """检查是否是终止类动作"""
    return action_type in TERMINAL_ACTIONS


def is_navigation_action(action_type: ActionType) -> bool:
    """检查是否是导航类动作"""
    return action_type in NAVIGATION_ACTIONS


def is_input_action(action_type: ActionType) -> bool:
    """检查是否是输入类动作"""
    return action_type in INPUT_ACTIONS
