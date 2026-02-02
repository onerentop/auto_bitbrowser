"""
Action 参数模型模块

使用 dataclass 定义各种 Action 的参数模型，提供验证和序列化功能
参考 browser-use 的 Pydantic 模型设计，但使用标准库实现
"""

from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Any, Union, Literal
from abc import ABC, abstractmethod
import re

from .types import ActionType


class ValidationError(Exception):
    """参数验证错误"""

    def __init__(self, field: str, message: str):
        self.field = field
        self.message = message
        super().__init__(f"{field}: {message}")


@dataclass
class ActionParams(ABC):
    """Action 参数基类"""

    @abstractmethod
    def validate(self) -> List[ValidationError]:
        """验证参数，返回错误列表"""
        pass

    def is_valid(self) -> bool:
        """检查参数是否有效"""
        return len(self.validate()) == 0

    def to_dict(self) -> dict:
        """转换为字典"""
        return asdict(self)

    @classmethod
    @abstractmethod
    def action_type(cls) -> ActionType:
        """返回对应的 ActionType"""
        pass


@dataclass
class ClickParams(ActionParams):
    """点击动作参数"""

    # 目标元素描述（与坐标二选一）
    target: Optional[str] = None
    # 元素 ID（从 SoM 标记获取）
    element_id: Optional[int] = None
    # 坐标（与目标描述二选一）
    x: Optional[int] = None
    y: Optional[int] = None
    # 点击选项
    button: Literal["left", "right", "middle"] = "left"
    click_count: int = 1
    force: bool = False  # 强制点击（忽略可见性检查）

    def validate(self) -> List[ValidationError]:
        errors = []
        # 必须有目标或坐标
        has_target = self.target is not None or self.element_id is not None
        has_coords = self.x is not None and self.y is not None

        if not has_target and not has_coords:
            errors.append(ValidationError("target", "必须指定目标元素或坐标"))

        if self.click_count < 1:
            errors.append(ValidationError("click_count", "点击次数必须 >= 1"))

        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.CLICK

    @classmethod
    def from_target(cls, target: str, **kwargs) -> "ClickParams":
        """从目标描述创建"""
        # 尝试从目标中提取元素 ID
        element_id = None
        match = re.search(r'\[(\d+)\]', target)
        if match:
            element_id = int(match.group(1))

        return cls(target=target, element_id=element_id, **kwargs)

    @classmethod
    def from_coordinates(cls, x: int, y: int, **kwargs) -> "ClickParams":
        """从坐标创建"""
        return cls(x=x, y=y, **kwargs)


@dataclass
class FillParams(ActionParams):
    """填写动作参数"""

    # 目标输入框描述
    target: str = ""
    # 元素 ID
    element_id: Optional[int] = None
    # 填写的值
    value: str = ""
    # 是否清空现有内容
    clear_first: bool = True

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.target and self.element_id is None:
            errors.append(ValidationError("target", "必须指定目标输入框"))
        if not self.value:
            errors.append(ValidationError("value", "填写值不能为空"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.FILL


@dataclass
class TypeParams(ActionParams):
    """逐字输入动作参数"""

    # 目标输入框描述（可选，默认当前焦点）
    target: Optional[str] = None
    # 元素 ID
    element_id: Optional[int] = None
    # 输入的文本
    text: str = ""
    # 每个字符之间的延迟（毫秒）
    delay_ms: int = 50

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.text:
            errors.append(ValidationError("text", "输入文本不能为空"))
        if self.delay_ms < 0:
            errors.append(ValidationError("delay_ms", "延迟必须 >= 0"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.TYPE


@dataclass
class PressParams(ActionParams):
    """按键动作参数"""

    # 按键名称（如 "Enter", "Tab", "Escape", "Control+A"）
    key: str = ""
    # 修饰键
    modifiers: List[str] = field(default_factory=list)

    # 常用按键常量
    ENTER = "Enter"
    TAB = "Tab"
    ESCAPE = "Escape"
    BACKSPACE = "Backspace"
    DELETE = "Delete"
    ARROW_UP = "ArrowUp"
    ARROW_DOWN = "ArrowDown"
    ARROW_LEFT = "ArrowLeft"
    ARROW_RIGHT = "ArrowRight"

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.key:
            errors.append(ValidationError("key", "必须指定按键"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.PRESS

    def get_key_combination(self) -> str:
        """获取完整的按键组合"""
        if self.modifiers:
            return "+".join(self.modifiers + [self.key])
        return self.key


@dataclass
class ScrollParams(ActionParams):
    """滚动动作参数"""

    # 滚动方向
    direction: Literal["up", "down", "left", "right"] = "down"
    # 滚动距离（像素）
    distance: int = 300
    # 目标元素（可选，在元素内滚动）
    target: Optional[str] = None

    def validate(self) -> List[ValidationError]:
        errors = []
        if self.distance <= 0:
            errors.append(ValidationError("distance", "滚动距离必须 > 0"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.SCROLL

    def get_delta(self) -> tuple:
        """获取滚动偏移量 (delta_x, delta_y)"""
        if self.direction == "down":
            return (0, self.distance)
        elif self.direction == "up":
            return (0, -self.distance)
        elif self.direction == "right":
            return (self.distance, 0)
        elif self.direction == "left":
            return (-self.distance, 0)
        return (0, 0)


@dataclass
class WaitParams(ActionParams):
    """等待动作参数"""

    # 等待时间（秒）
    seconds: float = 2.0

    def validate(self) -> List[ValidationError]:
        errors = []
        if self.seconds <= 0:
            errors.append(ValidationError("seconds", "等待时间必须 > 0"))
        if self.seconds > 60:
            errors.append(ValidationError("seconds", "等待时间不能超过 60 秒"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.WAIT


@dataclass
class WaitForParams(ActionParams):
    """等待元素动作参数"""

    # 目标元素描述
    target: str = ""
    # 等待条件
    state: Literal["visible", "hidden", "attached", "detached"] = "visible"
    # 超时时间（毫秒）
    timeout_ms: int = 10000

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.target:
            errors.append(ValidationError("target", "必须指定等待目标"))
        if self.timeout_ms <= 0:
            errors.append(ValidationError("timeout_ms", "超时时间必须 > 0"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.WAIT_FOR


@dataclass
class NavigateParams(ActionParams):
    """导航动作参数"""

    # 目标 URL
    url: str = ""
    # 等待条件
    wait_until: Literal["load", "domcontentloaded", "networkidle", "commit"] = "domcontentloaded"
    # 超时时间（毫秒）
    timeout_ms: int = 30000

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.url:
            errors.append(ValidationError("url", "必须指定 URL"))
        elif not self._is_valid_url(self.url):
            errors.append(ValidationError("url", "无效的 URL 格式"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.NAVIGATE

    @staticmethod
    def _is_valid_url(url: str) -> bool:
        """简单的 URL 验证"""
        return url.startswith(("http://", "https://", "file://", "about:", "data:"))


@dataclass
class RefreshParams(ActionParams):
    """刷新动作参数"""

    # 等待条件
    wait_until: Literal["load", "domcontentloaded", "networkidle", "commit"] = "domcontentloaded"
    # 超时时间（毫秒）
    timeout_ms: int = 30000

    def validate(self) -> List[ValidationError]:
        return []  # 刷新操作无需参数验证

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.REFRESH


@dataclass
class ExtractSecretParams(ActionParams):
    """提取密钥动作参数"""

    # 提取到的密钥
    secret: str = ""
    # 密钥格式验证模式
    pattern: str = r"^[A-Z2-7]{16,32}$"  # TOTP 密钥格式

    def validate(self) -> List[ValidationError]:
        errors = []
        if self.secret and self.pattern:
            if not re.match(self.pattern, self.secret):
                # 不强制验证格式，仅作为提示
                pass
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.EXTRACT_SECRET


@dataclass
class ExtractLinkParams(ActionParams):
    """提取链接动作参数"""

    # 提取到的链接
    link: str = ""
    # 链接匹配模式
    pattern: Optional[str] = None  # 如 "sheerid.com"
    # 结果状态
    result_status: Optional[str] = None

    def validate(self) -> List[ValidationError]:
        return []  # 链接提取无需前置验证

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.EXTRACT_LINK


@dataclass
class DoneParams(ActionParams):
    """完成动作参数"""

    # 完成原因
    reason: str = ""
    # 结果状态
    result_status: Optional[str] = None
    # 额外数据
    data: Dict[str, Any] = field(default_factory=dict)

    def validate(self) -> List[ValidationError]:
        return []  # 完成操作无需验证

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.DONE


@dataclass
class ErrorParams(ActionParams):
    """错误动作参数"""

    # 错误消息
    message: str = ""
    # 错误类型
    error_type: Optional[str] = None
    # 是否可恢复
    recoverable: bool = False

    def validate(self) -> List[ValidationError]:
        errors = []
        if not self.message:
            errors.append(ValidationError("message", "必须指定错误消息"))
        return errors

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.ERROR


@dataclass
class NeedVerificationParams(ActionParams):
    """需要验证码动作参数"""

    # 验证码类型
    verification_type: Literal["sms", "email", "captcha", "authenticator"] = "email"
    # 验证说明
    instructions: str = ""

    def validate(self) -> List[ValidationError]:
        return []

    @classmethod
    def action_type(cls) -> ActionType:
        return ActionType.NEED_VERIFICATION


# ============ 参数模型映射 ============

ACTION_PARAMS_MAP: Dict[ActionType, type] = {
    ActionType.CLICK: ClickParams,
    ActionType.FILL: FillParams,
    ActionType.TYPE: TypeParams,
    ActionType.PRESS: PressParams,
    ActionType.SCROLL: ScrollParams,
    ActionType.WAIT: WaitParams,
    ActionType.WAIT_FOR: WaitForParams,
    ActionType.NAVIGATE: NavigateParams,
    ActionType.REFRESH: RefreshParams,
    ActionType.EXTRACT_SECRET: ExtractSecretParams,
    ActionType.EXTRACT_LINK: ExtractLinkParams,
    ActionType.DONE: DoneParams,
    ActionType.ERROR: ErrorParams,
    ActionType.NEED_VERIFICATION: NeedVerificationParams,
}


def get_params_class(action_type: ActionType) -> Optional[type]:
    """获取 ActionType 对应的参数类"""
    return ACTION_PARAMS_MAP.get(action_type)


def create_params(action_type: ActionType, **kwargs) -> Optional[ActionParams]:
    """根据 ActionType 创建参数实例"""
    params_class = get_params_class(action_type)
    if params_class:
        return params_class(**kwargs)
    return None


def validate_params(action_type: ActionType, **kwargs) -> List[ValidationError]:
    """验证参数"""
    params = create_params(action_type, **kwargs)
    if params:
        return params.validate()
    return [ValidationError("action_type", f"未知的动作类型: {action_type}")]
