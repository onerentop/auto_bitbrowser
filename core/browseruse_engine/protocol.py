"""
BrowserUse Engine - 统一引擎协议

定义 EngineProtocol 接口，BrowserUseEngine 和 StagehandGoogleEngine 都实现此协议，
实现两个引擎的互换使用。

使用示例:
    ```python
    from core.browseruse_engine.protocol import EngineProtocol

    async def run_task(engine: EngineProtocol, task: str):
        # 可以传入 BrowserUseEngine 或 StagehandGoogleEngine
        result = await engine.run(task)
        return result
    ```
"""

from typing import Protocol, Optional, Any, Dict, List, Type, TypeVar, runtime_checkable
from dataclasses import dataclass, field
from enum import Enum


# ==================== 结果类型定义 ====================

class OperationStatus(Enum):
    """操作状态"""
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"
    TIMEOUT = "timeout"
    BLOCKED = "blocked"


@dataclass
class NavigationResult:
    """导航结果"""
    success: bool
    url: str
    final_url: Optional[str] = None
    error: Optional[str] = None
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


@dataclass
class ActionResult:
    """动作执行结果"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    extracted_content: Optional[str] = None
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


@dataclass
class ExtractResult:
    """数据提取结果"""
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


@dataclass
class ObserveResult:
    """页面观察结果"""
    success: bool
    elements: List[Dict[str, Any]] = field(default_factory=list)
    error: Optional[str] = None
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


@dataclass
class AgentStep:
    """Agent 执行步骤记录"""
    step_number: int
    thinking: str = ""
    action_name: str = ""
    action_params: Dict[str, Any] = field(default_factory=dict)
    result: Optional[ActionResult] = None
    browser_url: str = ""
    timestamp: float = 0.0


@dataclass
class AgentResult:
    """Agent 任务执行结果"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    extracted_content: Optional[str] = None
    steps: List[AgentStep] = field(default_factory=list)
    total_steps: int = 0
    duration_ms: float = 0.0

    def __bool__(self) -> bool:
        return self.success


# ==================== 引擎协议定义 ====================

T = TypeVar('T')


@runtime_checkable
class EngineProtocol(Protocol):
    """
    AI 浏览器引擎统一协议

    BrowserUseEngine 和 StagehandGoogleEngine 都应实现此协议，
    使得两个引擎可以互换使用。

    核心方法:
        - navigate: 导航到 URL
        - act: 执行自然语言指令 (单步)
        - extract: 提取页面数据
        - observe: 观察页面元素
        - run: 执行完整 Agent 任务 (多步)

    生命周期:
        - start: 启动引擎
        - stop: 关闭引擎
        - is_initialized: 检查初始化状态
    """

    @property
    def is_initialized(self) -> bool:
        """是否已初始化"""
        ...

    async def start(self) -> None:
        """启动引擎 (本地模式)"""
        ...

    async def stop(self) -> None:
        """关闭引擎"""
        ...

    async def navigate(
        self,
        url: str,
        wait_until: str = "domcontentloaded",
        timeout: float = 30000,
    ) -> NavigationResult:
        """
        导航到指定 URL

        Args:
            url: 目标 URL
            wait_until: 等待条件 ("load", "domcontentloaded", "networkidle")
            timeout: 超时时间（毫秒）

        Returns:
            NavigationResult
        """
        ...

    async def act(
        self,
        instruction: str,
        timeout: float = 30000,
    ) -> ActionResult:
        """
        执行自然语言指令 (单步)

        使用 AI 理解指令并在页面上执行相应操作。

        Args:
            instruction: 自然语言指令 (如 "点击登录按钮")
            timeout: 超时时间（毫秒）

        Returns:
            ActionResult
        """
        ...

    async def extract(
        self,
        instruction: str,
        schema: Optional[Type[T]] = None,
        timeout: float = 30000,
    ) -> ExtractResult:
        """
        提取页面数据

        使用 AI 从页面提取结构化数据。

        Args:
            instruction: 提取描述 (如 "提取所有商品价格")
            schema: Pydantic 模型类，用于结构化输出
            timeout: 超时时间（毫秒）

        Returns:
            ExtractResult
        """
        ...

    async def observe(
        self,
        instruction: str,
        timeout: float = 30000,
    ) -> ObserveResult:
        """
        观察页面元素

        使用 AI 分析页面并找到符合描述的元素。

        Args:
            instruction: 观察描述 (如 "找到所有输入框")
            timeout: 超时时间（毫秒）

        Returns:
            ObserveResult
        """
        ...

    async def run(
        self,
        task: str,
        max_steps: int = 50,
        on_step: Optional[Any] = None,
    ) -> AgentResult:
        """
        执行完整 Agent 任务 (多步)

        使用 Agent 循环自动完成复杂任务。

        Args:
            task: 任务描述
            max_steps: 最大步数
            on_step: 步骤回调函数

        Returns:
            AgentResult
        """
        ...


# ==================== 辅助函数 ====================

def is_engine(obj: Any) -> bool:
    """检查对象是否实现了 EngineProtocol"""
    return isinstance(obj, EngineProtocol)
