"""
BrowserUse Engine - Agent 视图模型

Agent 相关的数据结构定义。
注意: 主要的 AgentOutput 等模型定义在 types.py 中。
"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from enum import Enum

from ..types import AgentOutput, AgentStepRecord, AgentHistory, BrowserState
from ..protocol import ActionResult


class AgentStatus(Enum):
    """Agent 状态"""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class AgentState:
    """
    Agent 当前状态

    包含 Agent 的运行时状态信息。
    """
    status: AgentStatus = AgentStatus.IDLE
    current_step: int = 0
    max_steps: int = 50
    task: str = ""

    # 当前浏览器状态
    browser_state: Optional[BrowserState] = None

    # 最后的输出
    last_output: Optional[AgentOutput] = None
    last_results: List[ActionResult] = field(default_factory=list)

    # 历史
    history: Optional[AgentHistory] = None

    # 错误信息
    error: Optional[str] = None

    @property
    def is_running(self) -> bool:
        return self.status == AgentStatus.RUNNING

    @property
    def is_completed(self) -> bool:
        return self.status in (AgentStatus.COMPLETED, AgentStatus.FAILED, AgentStatus.STOPPED)

    @property
    def progress(self) -> float:
        """进度 (0-1)"""
        if self.max_steps <= 0:
            return 0.0
        return min(self.current_step / self.max_steps, 1.0)


@dataclass
class StepResult:
    """
    单步执行结果

    包含一个完整步骤的所有信息。
    """
    step_number: int
    agent_output: Optional[AgentOutput] = None
    action_results: List[ActionResult] = field(default_factory=list)
    browser_state_before: Optional[BrowserState] = None
    browser_state_after: Optional[BrowserState] = None
    error: Optional[str] = None
    duration_ms: float = 0.0

    @property
    def success(self) -> bool:
        """步骤是否成功"""
        if self.error:
            return False
        if not self.action_results:
            return True
        return all(r.success for r in self.action_results)

    @property
    def is_done(self) -> bool:
        """是否包含 done 动作"""
        if self.agent_output and self.agent_output.action:
            for action in self.agent_output.action:
                if action.done is not None:
                    return True
        return False

    @property
    def done_message(self) -> Optional[str]:
        """获取 done 动作的消息"""
        if self.agent_output and self.agent_output.action:
            for action in self.agent_output.action:
                if action.done is not None:
                    return action.done.message
        return None


@dataclass
class AgentRunResult:
    """
    Agent 运行结果

    完整任务执行的最终结果。
    """
    success: bool
    message: str = ""
    error: Optional[str] = None

    # 提取的内容
    extracted_content: Optional[str] = None

    # 执行统计
    total_steps: int = 0
    total_actions: int = 0
    duration_ms: float = 0.0

    # 详细历史
    steps: List[StepResult] = field(default_factory=list)

    # 最终状态
    final_url: str = ""
    final_state: Optional[AgentState] = None

    def __bool__(self) -> bool:
        return self.success

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "success": self.success,
            "message": self.message,
            "error": self.error,
            "extracted_content": self.extracted_content,
            "total_steps": self.total_steps,
            "total_actions": self.total_actions,
            "duration_ms": self.duration_ms,
            "final_url": self.final_url,
        }
