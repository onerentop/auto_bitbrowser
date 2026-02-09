"""
BrowserUse Engine - 类型定义

定义所有数据类型，包括 Agent 状态、动作模型、浏览器状态等。
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field


# ==================== 枚举类型 ====================

class ActionType(Enum):
    """动作类型"""
    NAVIGATE = "navigate"
    CLICK = "click"
    INPUT = "input"
    SCROLL = "scroll"
    EXTRACT = "extract"
    SCREENSHOT = "screenshot"
    WAIT = "wait"
    DONE = "done"
    PRESS_KEY = "press_key"
    GO_BACK = "go_back"


class ScrollDirection(Enum):
    """滚动方向"""
    UP = "up"
    DOWN = "down"
    LEFT = "left"
    RIGHT = "right"


# ==================== 动作模型 (Pydantic) ====================

class NavigateAction(BaseModel):
    """导航动作"""
    url: str = Field(..., description="目标 URL")


class ClickAction(BaseModel):
    """点击动作"""
    index: int = Field(..., description="元素索引号")


class InputAction(BaseModel):
    """输入动作"""
    index: int = Field(..., description="元素索引号")
    text: str = Field(..., description="输入文本")
    clear: bool = Field(default=True, description="是否先清空")


class ScrollAction(BaseModel):
    """滚动动作"""
    direction: str = Field(default="down", description="滚动方向: up/down")
    amount: float = Field(default=0.5, description="滚动量 (页面比例)")


class ExtractAction(BaseModel):
    """提取动作"""
    query: str = Field(..., description="提取查询描述")


class ScreenshotAction(BaseModel):
    """截图动作"""
    filename: Optional[str] = Field(default=None, description="保存文件名")


class WaitAction(BaseModel):
    """等待动作"""
    milliseconds: int = Field(default=1000, description="等待毫秒数")


class DoneAction(BaseModel):
    """完成动作"""
    message: str = Field(..., description="完成消息/提取结果")
    success: bool = Field(default=True, description="是否成功完成")


class PressKeyAction(BaseModel):
    """按键动作"""
    key: str = Field(..., description="按键名称 (如 Enter, Tab, Escape)")


class GoBackAction(BaseModel):
    """后退动作"""
    pass


class ActionModel(BaseModel):
    """统一动作模型"""
    navigate: Optional[NavigateAction] = None
    click: Optional[ClickAction] = None
    input: Optional[InputAction] = None
    scroll: Optional[ScrollAction] = None
    extract: Optional[ExtractAction] = None
    screenshot: Optional[ScreenshotAction] = None
    wait: Optional[WaitAction] = None
    done: Optional[DoneAction] = None
    press_key: Optional[PressKeyAction] = None
    go_back: Optional[GoBackAction] = None

    def get_action_type(self) -> Optional[str]:
        """获取当前动作类型"""
        for action_type in ["navigate", "click", "input", "scroll", "extract", "screenshot", "wait", "done", "press_key", "go_back"]:
            if getattr(self, action_type) is not None:
                return action_type
        return None

    def get_action_params(self) -> Dict[str, Any]:
        """获取动作参数"""
        action_type = self.get_action_type()
        if action_type:
            action = getattr(self, action_type)
            return action.model_dump() if action else {}
        return {}


# ==================== Agent 输出模型 ====================

class AgentOutput(BaseModel):
    """
    LLM Agent 输出结构

    这是 LLM 返回的结构化输出格式，包含推理过程和动作序列。
    """
    thinking: str = Field(
        ...,
        description="推理过程：分析当前状态，思考下一步该做什么"
    )
    evaluation_previous_goal: Optional[str] = Field(
        default=None,
        description="评估上一步目标是否达成"
    )
    memory: Optional[str] = Field(
        default=None,
        description="需要记住的重要信息"
    )
    next_goal: str = Field(
        ...,
        description="下一步的具体目标"
    )
    action: List[ActionModel] = Field(
        default_factory=list,
        description="要执行的动作序列（最多3个）"
    )


# ==================== DOM 相关类型 ====================

@dataclass
class Rect:
    """矩形区域"""
    x: float
    y: float
    width: float
    height: float

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.width / 2, self.y + self.height / 2)


@dataclass
class DOMElement:
    """DOM 元素"""
    index: int                              # 元素索引 [1], [2], ...
    tag_name: str                           # 标签名 (button, input, a, etc.)
    text: str = ""                          # 文本内容
    role: str = ""                          # ARIA 角色
    attributes: Dict[str, str] = field(default_factory=dict)  # 属性
    is_interactive: bool = True             # 是否可交互
    is_visible: bool = True                 # 是否可见
    is_new: bool = False                    # 是否是新出现的元素
    bounding_box: Optional[Rect] = None     # 边界框
    selector: str = ""                      # CSS 选择器

    def __str__(self) -> str:
        """生成 LLM 可读的元素描述"""
        prefix = "*" if self.is_new else ""
        parts = [f"{prefix}[{self.index}]", self.tag_name]

        if self.text:
            parts.append(f'"{self.text[:50]}"')
        if self.role and self.role != self.tag_name:
            parts.append(f"role={self.role}")
        for key in ["placeholder", "value", "href", "type"]:
            if key in self.attributes and self.attributes[key]:
                val = self.attributes[key][:30]
                parts.append(f'{key}="{val}"')

        return " ".join(parts)


@dataclass
class DOMTree:
    """DOM 树"""
    elements: List[DOMElement] = field(default_factory=list)
    page_url: str = ""
    page_title: str = ""
    timestamp: float = 0.0

    def get_element(self, index: int) -> Optional[DOMElement]:
        """根据索引获取元素"""
        for el in self.elements:
            if el.index == index:
                return el
        return None

    def serialize(self) -> str:
        """序列化为文本格式"""
        lines = []
        for el in self.elements:
            lines.append(str(el))
        return "\n".join(lines)


# ==================== 浏览器状态 ====================

@dataclass
class BrowserState:
    """浏览器当前状态"""
    url: str = ""
    title: str = ""
    dom_tree: Optional[DOMTree] = None
    screenshot_base64: Optional[str] = None
    tabs: List[Dict[str, str]] = field(default_factory=list)
    active_tab_index: int = 0

    def get_state_description(self) -> str:
        """生成状态描述文本"""
        lines = [
            f"URL: {self.url}",
            f"Title: {self.title}",
        ]
        if len(self.tabs) > 1:
            lines.append(f"Tabs: {len(self.tabs)} (active: {self.active_tab_index})")
        if self.dom_tree:
            lines.append(f"\nInteractive Elements ({len(self.dom_tree.elements)}):")
            lines.append(self.dom_tree.serialize())
        return "\n".join(lines)


# ==================== Agent 状态 ====================

@dataclass
class AgentStepRecord:
    """Agent 步骤记录"""
    step_number: int
    agent_output: Optional[AgentOutput] = None
    action_results: List[Dict[str, Any]] = field(default_factory=list)
    browser_state: Optional[BrowserState] = None
    error: Optional[str] = None
    timestamp: float = 0.0


@dataclass
class AgentHistory:
    """Agent 执行历史"""
    task: str
    steps: List[AgentStepRecord] = field(default_factory=list)
    start_time: float = 0.0
    end_time: Optional[float] = None

    def get_history_description(self, max_steps: int = 10) -> str:
        """生成历史描述 (用于提示词)"""
        if not self.steps:
            return "No previous actions."

        recent_steps = self.steps[-max_steps:]
        lines = []
        for step in recent_steps:
            if step.agent_output:
                lines.append(f"Step {step.step_number}:")
                lines.append(f"  Goal: {step.agent_output.next_goal}")
                for i, action in enumerate(step.agent_output.action):
                    action_type = action.get_action_type()
                    if action_type:
                        lines.append(f"  Action {i+1}: {action_type} {action.get_action_params()}")
                if step.action_results:
                    for result in step.action_results:
                        success = result.get("success", False)
                        msg = result.get("message", "")
                        lines.append(f"  Result: {'✓' if success else '✗'} {msg}")
        return "\n".join(lines)


# ==================== 配置类型 ====================

@dataclass
class AgentConfig:
    """Agent 配置"""
    max_steps: int = 50
    max_actions_per_step: int = 3
    use_vision: bool = True
    language: str = "en"  # "en" or "zh"
    retry_on_error: bool = True
    max_retries: int = 3


@dataclass
class LLMConfig:
    """LLM 配置"""
    model_name: str = ""
    api_key: str = ""
    base_url: Optional[str] = None
    temperature: float = 0.0
    max_tokens: int = 4096


# ==================== 操作结果类型 ====================

@dataclass
class JoinFamilyResult:
    """加入家庭组操作结果"""
    success: bool
    message: str = ""
    error: Optional[str] = None
    error_type: Optional[str] = None
    duration_ms: float = 0.0

    # 家庭组信息
    inviter_email: Optional[str] = None
    already_in_family: bool = False
    invite_sent: bool = False
    invite_accepted: bool = False

    def __bool__(self) -> bool:
        return self.success
