"""
类型定义 - AI Browser Agent
"""

from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Any


class ActionType(str, Enum):
    """AI Agent 可执行的动作类型"""

    # 基础交互
    CLICK = "click"  # 点击元素
    FILL = "fill"  # 填写输入框
    TYPE = "type"  # 逐字符输入（触发键盘事件）
    PRESS = "press"  # 按键（如 Enter, Tab）
    SCROLL = "scroll"  # 滚动页面

    # 等待
    WAIT = "wait"  # 等待指定时间
    WAIT_FOR = "wait_for"  # 等待元素出现

    # 导航
    NAVIGATE = "navigate"  # 导航到 URL
    REFRESH = "refresh"  # 刷新页面

    # 数据提取
    EXTRACT_SECRET = "extract_secret"  # 提取身份验证器密钥

    # 终止状态
    DONE = "done"  # 任务完成
    ERROR = "error"  # 无法继续，需要人工介入
    NEED_VERIFICATION = "need_verification"  # 需要短信/邮件验证码


class AgentState(str, Enum):
    """Agent 运行状态"""

    IDLE = "idle"  # 空闲
    RUNNING = "running"  # 运行中
    WAITING_INPUT = "waiting_input"  # 等待外部输入（如验证码）
    COMPLETED = "completed"  # 已完成
    FAILED = "failed"  # 已失败
    STOPPED = "stopped"  # 被停止


@dataclass
class AgentAction:
    """AI 决策的单个动作"""

    action_type: ActionType
    # 目标元素描述（用于定位）
    target_description: Optional[str] = None
    # 坐标（可选，用于精确点击）
    x: Optional[int] = None
    y: Optional[int] = None
    # 输入值
    value: Optional[str] = None
    # 等待时间（秒）
    wait_seconds: Optional[float] = None
    # 按键名称
    key: Optional[str] = None
    # URL（用于导航）
    url: Optional[str] = None
    # AI 的思考过程
    reasoning: str = ""
    # 置信度 (0-1)
    confidence: float = 1.0
    # 错误信息（当 action_type 为 ERROR 时）
    error_message: Optional[str] = None
    # 验证码类型（当 action_type 为 NEED_VERIFICATION 时）
    verification_type: Optional[str] = None  # "sms" | "email" | "captcha"
    # 提取的密钥（当 action_type 为 EXTRACT_SECRET 时）
    extracted_secret: Optional[str] = None

    def __str__(self) -> str:
        if self.action_type == ActionType.CLICK:
            if self.x is not None and self.y is not None:
                return f"CLICK at ({self.x}, {self.y}): {self.target_description}"
            return f"CLICK: {self.target_description}"
        elif self.action_type == ActionType.FILL:
            return f"FILL '{self.value}' into: {self.target_description}"
        elif self.action_type == ActionType.TYPE:
            return f"TYPE '{self.value}' into: {self.target_description}"
        elif self.action_type == ActionType.PRESS:
            return f"PRESS key: {self.key}"
        elif self.action_type == ActionType.WAIT:
            return f"WAIT {self.wait_seconds}s"
        elif self.action_type == ActionType.NAVIGATE:
            return f"NAVIGATE to: {self.url}"
        elif self.action_type == ActionType.DONE:
            return f"DONE: {self.reasoning}"
        elif self.action_type == ActionType.ERROR:
            return f"ERROR: {self.error_message}"
        elif self.action_type == ActionType.NEED_VERIFICATION:
            return f"NEED_VERIFICATION ({self.verification_type}): {self.reasoning}"
        elif self.action_type == ActionType.EXTRACT_SECRET:
            return f"EXTRACT_SECRET: {self.extracted_secret[:20]}..." if self.extracted_secret and len(self.extracted_secret) > 20 else f"EXTRACT_SECRET: {self.extracted_secret}"
        return f"{self.action_type.value}: {self.reasoning}"


@dataclass
class TaskContext:
    """任务上下文"""

    # 任务目标描述
    goal: str
    # 起始 URL
    start_url: str
    # 账号信息
    account: dict = field(default_factory=dict)
    # 额外参数
    params: dict = field(default_factory=dict)
    # 历史动作（用于上下文）
    action_history: list[AgentAction] = field(default_factory=list)
    # 当前步骤数
    current_step: int = 0
    # 最大步骤数
    max_steps: int = 20

    def add_action(self, action: AgentAction):
        """添加动作到历史"""
        self.action_history.append(action)
        self.current_step += 1

    def get_history_summary(self, last_n: int = 5) -> str:
        """获取最近N步的摘要"""
        if not self.action_history:
            return "无历史操作"

        recent = self.action_history[-last_n:]
        lines = [f"步骤 {i + 1}: {action}" for i, action in enumerate(recent)]
        return "\n".join(lines)


@dataclass
class TaskResult:
    """任务执行结果"""

    success: bool
    message: str
    state: AgentState = AgentState.COMPLETED
    # 执行的总步骤数
    total_steps: int = 0
    # 动作历史
    action_history: list[AgentAction] = field(default_factory=list)
    # 额外数据
    data: dict = field(default_factory=dict)
    # 最终截图路径
    final_screenshot: Optional[str] = None
    # 错误详情
    error_details: Optional[str] = None

    @classmethod
    def success_result(
        cls, message: str, steps: int = 0, data: dict = None
    ) -> "TaskResult":
        """创建成功结果"""
        return cls(
            success=True,
            message=message,
            state=AgentState.COMPLETED,
            total_steps=steps,
            data=data or {},
        )

    @classmethod
    def failure_result(
        cls, message: str, error_details: str = None, steps: int = 0
    ) -> "TaskResult":
        """创建失败结果"""
        return cls(
            success=False,
            message=message,
            state=AgentState.FAILED,
            total_steps=steps,
            error_details=error_details,
        )

    @classmethod
    def stopped_result(cls, message: str = "任务被停止", steps: int = 0) -> "TaskResult":
        """创建停止结果"""
        return cls(
            success=False,
            message=message,
            state=AgentState.STOPPED,
            total_steps=steps,
        )
