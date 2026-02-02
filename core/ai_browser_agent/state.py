"""
Agent 状态管理模块

提供可序列化的状态对象、步骤元数据和历史记录管理
参考 browser-use 的 AgentState 设计，增强状态持久化能力
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Any, Dict
from enum import Enum
import json

from .types import AgentAction, ActionType


class ExecutionState(str, Enum):
    """执行状态枚举"""
    IDLE = "idle"              # 空闲
    RUNNING = "running"        # 运行中
    PAUSED = "paused"          # 已暂停
    STOPPED = "stopped"        # 已停止
    COMPLETED = "completed"    # 已完成
    FAILED = "failed"          # 已失败
    WAITING_INPUT = "waiting_input"  # 等待输入


@dataclass
class StepMetadata:
    """步骤元数据"""
    step_number: int
    step_start_time: datetime = field(default_factory=datetime.now)
    step_end_time: Optional[datetime] = None
    duration_seconds: Optional[float] = None

    def complete(self):
        """标记步骤完成"""
        self.step_end_time = datetime.now()
        self.duration_seconds = (self.step_end_time - self.step_start_time).total_seconds()

    def to_dict(self) -> dict:
        """转换为字典（用于序列化）"""
        return {
            "step_number": self.step_number,
            "step_start_time": self.step_start_time.isoformat(),
            "step_end_time": self.step_end_time.isoformat() if self.step_end_time else None,
            "duration_seconds": self.duration_seconds,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "StepMetadata":
        """从字典创建"""
        return cls(
            step_number=data["step_number"],
            step_start_time=datetime.fromisoformat(data["step_start_time"]),
            step_end_time=datetime.fromisoformat(data["step_end_time"]) if data.get("step_end_time") else None,
            duration_seconds=data.get("duration_seconds"),
        )


@dataclass
class ActionResult:
    """动作执行结果"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    data: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "success": self.success,
            "message": self.message,
            "error": self.error,
            "data": self.data,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ActionResult":
        return cls(
            success=data["success"],
            message=data.get("message", ""),
            error=data.get("error"),
            data=data.get("data", {}),
        )


@dataclass
class StepRecord:
    """单步历史记录"""
    action: AgentAction
    result: ActionResult
    metadata: StepMetadata
    screenshot_path: Optional[str] = None
    elements_count: int = 0

    def to_dict(self) -> dict:
        """转换为字典（用于序列化）"""
        return {
            "action": {
                "action_type": self.action.action_type.value,
                "target_description": self.action.target_description,
                "value": self.action.value,
                "reasoning": self.action.reasoning,
                "confidence": self.action.confidence,
            },
            "result": self.result.to_dict(),
            "metadata": self.metadata.to_dict(),
            "screenshot_path": self.screenshot_path,
            "elements_count": self.elements_count,
        }


@dataclass
class AgentStateData:
    """
    可序列化的 Agent 状态

    支持状态检查点、持久化和恢复
    """
    # 执行状态
    execution_state: ExecutionState = ExecutionState.IDLE

    # 步骤计数
    n_steps: int = 0
    max_steps: int = 20

    # 失败管理
    consecutive_failures: int = 0
    max_failures: int = 5
    total_failures: int = 0

    # 控制标志
    paused: bool = False
    stopped: bool = False

    # 会话信息
    session_id: Optional[str] = None
    session_start_time: Optional[datetime] = None

    # 最后结果
    last_action: Optional[AgentAction] = None
    last_result: Optional[ActionResult] = None

    # 历史记录
    step_history: List[StepRecord] = field(default_factory=list)

    def __post_init__(self):
        if self.session_start_time is None:
            self.session_start_time = datetime.now()
        if self.session_id is None:
            self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

    # ============ 状态控制方法 ============

    def start(self):
        """开始执行"""
        self.execution_state = ExecutionState.RUNNING
        self.paused = False
        self.stopped = False

    def pause(self):
        """暂停执行"""
        self.paused = True
        self.execution_state = ExecutionState.PAUSED

    def resume(self):
        """恢复执行"""
        self.paused = False
        if self.execution_state == ExecutionState.PAUSED:
            self.execution_state = ExecutionState.RUNNING

    def stop(self):
        """停止执行"""
        self.stopped = True
        self.execution_state = ExecutionState.STOPPED

    def complete(self):
        """标记完成"""
        self.execution_state = ExecutionState.COMPLETED

    def fail(self):
        """标记失败"""
        self.execution_state = ExecutionState.FAILED

    def wait_input(self):
        """等待输入"""
        self.execution_state = ExecutionState.WAITING_INPUT

    # ============ 步骤管理方法 ============

    def increment_step(self):
        """增加步骤计数"""
        self.n_steps += 1

    def record_step(
        self,
        action: AgentAction,
        result: ActionResult,
        metadata: StepMetadata,
        screenshot_path: Optional[str] = None,
        elements_count: int = 0,
    ):
        """记录步骤"""
        record = StepRecord(
            action=action,
            result=result,
            metadata=metadata,
            screenshot_path=screenshot_path,
            elements_count=elements_count,
        )
        self.step_history.append(record)
        self.last_action = action
        self.last_result = result
        self.increment_step()

        # 更新失败计数
        if result.success:
            self.consecutive_failures = 0
        else:
            self.consecutive_failures += 1
            self.total_failures += 1

    def record_failure(self):
        """记录失败（不增加步骤）"""
        self.consecutive_failures += 1
        self.total_failures += 1

    def reset_consecutive_failures(self):
        """重置连续失败计数"""
        self.consecutive_failures = 0

    # ============ 状态检查方法 ============

    @property
    def is_running(self) -> bool:
        """是否正在运行"""
        return self.execution_state == ExecutionState.RUNNING

    @property
    def is_paused(self) -> bool:
        """是否已暂停"""
        return self.paused or self.execution_state == ExecutionState.PAUSED

    @property
    def is_stopped(self) -> bool:
        """是否已停止"""
        return self.stopped or self.execution_state == ExecutionState.STOPPED

    @property
    def is_finished(self) -> bool:
        """是否已结束（完成或失败）"""
        return self.execution_state in (
            ExecutionState.COMPLETED,
            ExecutionState.FAILED,
            ExecutionState.STOPPED,
        )

    @property
    def should_stop(self) -> bool:
        """是否应该停止（达到限制或被请求停止）"""
        if self.stopped or self.paused:
            return True
        if self.n_steps >= self.max_steps:
            return True
        if self.consecutive_failures >= self.max_failures:
            return True
        return False

    @property
    def remaining_steps(self) -> int:
        """剩余步骤数"""
        return max(0, self.max_steps - self.n_steps)

    @property
    def failure_rate(self) -> float:
        """失败率"""
        if self.n_steps == 0:
            return 0.0
        return self.total_failures / self.n_steps

    # ============ 序列化方法 ============

    def to_dict(self) -> dict:
        """转换为字典（用于 JSON 序列化）"""
        return {
            "execution_state": self.execution_state.value,
            "n_steps": self.n_steps,
            "max_steps": self.max_steps,
            "consecutive_failures": self.consecutive_failures,
            "max_failures": self.max_failures,
            "total_failures": self.total_failures,
            "paused": self.paused,
            "stopped": self.stopped,
            "session_id": self.session_id,
            "session_start_time": self.session_start_time.isoformat() if self.session_start_time else None,
            "step_history": [step.to_dict() for step in self.step_history],
        }

    def to_json(self) -> str:
        """转换为 JSON 字符串"""
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2)

    def save(self, filepath: str):
        """保存状态到文件"""
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(self.to_json())

    @classmethod
    def from_dict(cls, data: dict) -> "AgentStateData":
        """从字典创建"""
        state = cls(
            execution_state=ExecutionState(data.get("execution_state", "idle")),
            n_steps=data.get("n_steps", 0),
            max_steps=data.get("max_steps", 20),
            consecutive_failures=data.get("consecutive_failures", 0),
            max_failures=data.get("max_failures", 5),
            total_failures=data.get("total_failures", 0),
            paused=data.get("paused", False),
            stopped=data.get("stopped", False),
            session_id=data.get("session_id"),
        )
        if data.get("session_start_time"):
            state.session_start_time = datetime.fromisoformat(data["session_start_time"])
        return state

    @classmethod
    def load(cls, filepath: str) -> "AgentStateData":
        """从文件加载状态"""
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls.from_dict(data)

    # ============ 辅助方法 ============

    def get_history_summary(self, last_n: int = 5) -> str:
        """获取最近 N 步的摘要"""
        if not self.step_history:
            return "无历史操作"

        recent = self.step_history[-last_n:]
        lines = []
        for record in recent:
            status = "✓" if record.result.success else "✗"
            duration = f"{record.metadata.duration_seconds:.1f}s" if record.metadata.duration_seconds else "?"
            lines.append(f"[{status}] Step {record.metadata.step_number}: {record.action} ({duration})")

        return "\n".join(lines)

    def get_statistics(self) -> dict:
        """获取执行统计"""
        total_duration = 0.0
        for record in self.step_history:
            if record.metadata.duration_seconds:
                total_duration += record.metadata.duration_seconds

        return {
            "total_steps": self.n_steps,
            "total_failures": self.total_failures,
            "consecutive_failures": self.consecutive_failures,
            "failure_rate": self.failure_rate,
            "total_duration_seconds": total_duration,
            "average_step_duration": total_duration / self.n_steps if self.n_steps > 0 else 0,
            "session_id": self.session_id,
        }


# ============ 便捷函数 ============

def create_state(max_steps: int = 20, max_failures: int = 5) -> AgentStateData:
    """创建新的状态对象"""
    return AgentStateData(
        max_steps=max_steps,
        max_failures=max_failures,
    )
