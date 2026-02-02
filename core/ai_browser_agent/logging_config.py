"""
结构化日志配置模块

提供：
- 统一的日志格式
- 结构化日志输出（JSON）
- 上下文日志记录器
- 性能跟踪日志

参考 browser-use 的日志设计
"""

import logging
import json
import time
from dataclasses import dataclass, field, asdict
from typing import Optional, Dict, Any, List
from datetime import datetime
from functools import wraps
import asyncio


# ============ 日志格式化器 ============

class StructuredFormatter(logging.Formatter):
    """
    结构化日志格式化器

    输出 JSON 格式日志，便于日志分析
    """

    def __init__(self, include_timestamp: bool = True, include_level: bool = True):
        super().__init__()
        self.include_timestamp = include_timestamp
        self.include_level = include_level

    def format(self, record: logging.LogRecord) -> str:
        log_data = {
            "message": record.getMessage(),
            "logger": record.name,
        }

        if self.include_timestamp:
            log_data["timestamp"] = datetime.fromtimestamp(record.created).isoformat()

        if self.include_level:
            log_data["level"] = record.levelname

        # 添加额外字段
        if hasattr(record, "extra_data"):
            log_data.update(record.extra_data)

        # 添加异常信息
        if record.exc_info:
            log_data["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_data, ensure_ascii=False, default=str)


class PrettyFormatter(logging.Formatter):
    """
    美化日志格式化器

    用于开发环境，输出可读性强的日志
    """

    COLORS = {
        "DEBUG": "\033[36m",     # Cyan
        "INFO": "\033[32m",      # Green
        "WARNING": "\033[33m",   # Yellow
        "ERROR": "\033[31m",     # Red
        "CRITICAL": "\033[35m",  # Magenta
    }
    RESET = "\033[0m"

    def __init__(self, use_colors: bool = True):
        super().__init__()
        self.use_colors = use_colors

    def format(self, record: logging.LogRecord) -> str:
        # 时间戳
        timestamp = datetime.fromtimestamp(record.created).strftime("%H:%M:%S.%f")[:-3]

        # 级别（带颜色）
        level = record.levelname
        if self.use_colors and level in self.COLORS:
            level = f"{self.COLORS[level]}{level:8}{self.RESET}"
        else:
            level = f"{level:8}"

        # 日志名称（简化）
        name = record.name
        if name.startswith("ai_browser_agent."):
            name = name.replace("ai_browser_agent.", "agent.")

        # 基础格式
        message = f"[{timestamp}] {level} {name}: {record.getMessage()}"

        # 添加额外数据
        if hasattr(record, "extra_data") and record.extra_data:
            extra_str = " ".join(f"{k}={v}" for k, v in record.extra_data.items())
            message += f" | {extra_str}"

        # 添加异常信息
        if record.exc_info:
            message += f"\n{self.formatException(record.exc_info)}"

        return message


# ============ 上下文日志适配器 ============

class ContextLogger(logging.LoggerAdapter):
    """
    带上下文的日志适配器

    自动在日志中添加上下文信息（如 step_id, task_id 等）
    """

    def __init__(self, logger: logging.Logger, context: Dict[str, Any] = None):
        super().__init__(logger, context or {})

    def process(self, msg, kwargs):
        # 合并上下文到 extra
        extra = kwargs.get("extra", {})
        extra_data = {**self.extra, **extra.get("extra_data", {})}

        if extra_data:
            kwargs["extra"] = {"extra_data": extra_data}

        return msg, kwargs

    def with_context(self, **context) -> "ContextLogger":
        """创建带额外上下文的新日志器"""
        new_context = {**self.extra, **context}
        return ContextLogger(self.logger, new_context)


# ============ 日志事件 ============

@dataclass
class LogEvent:
    """结构化日志事件"""
    event_type: str
    message: str
    timestamp: datetime = field(default_factory=datetime.now)
    level: str = "INFO"
    details: Dict[str, Any] = field(default_factory=dict)
    duration_ms: Optional[float] = None
    step_number: Optional[int] = None
    action_type: Optional[str] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        data = asdict(self)
        data["timestamp"] = self.timestamp.isoformat()
        # 移除 None 值
        return {k: v for k, v in data.items() if v is not None}

    def __str__(self) -> str:
        parts = [f"[{self.event_type}] {self.message}"]
        if self.duration_ms is not None:
            parts.append(f"({self.duration_ms:.1f}ms)")
        if self.step_number is not None:
            parts.append(f"step={self.step_number}")
        if self.action_type:
            parts.append(f"action={self.action_type}")
        return " ".join(parts)


# ============ Agent 日志器 ============

class AgentLogger:
    """
    Agent 专用日志器

    提供结构化的日志记录方法
    """

    def __init__(
        self,
        name: str = "ai_browser_agent",
        level: int = logging.INFO,
        structured: bool = False,
    ):
        """
        初始化 Agent 日志器

        Args:
            name: 日志器名称
            level: 日志级别
            structured: 是否使用 JSON 格式
        """
        self.logger = logging.getLogger(name)
        self.logger.setLevel(level)
        self.structured = structured

        self._events: List[LogEvent] = []
        self._step_number: int = 0
        self._task_id: Optional[str] = None

    def configure_handler(
        self,
        handler: logging.Handler = None,
        structured: bool = None,
        use_colors: bool = True,
    ):
        """配置日志处理器"""
        if handler is None:
            handler = logging.StreamHandler()

        if structured is None:
            structured = self.structured

        if structured:
            handler.setFormatter(StructuredFormatter())
        else:
            handler.setFormatter(PrettyFormatter(use_colors=use_colors))

        # 移除现有处理器
        self.logger.handlers.clear()
        self.logger.addHandler(handler)

    def set_context(self, task_id: str = None, step_number: int = None):
        """设置日志上下文"""
        if task_id is not None:
            self._task_id = task_id
        if step_number is not None:
            self._step_number = step_number

    def _log(
        self,
        level: int,
        event_type: str,
        message: str,
        **kwargs
    ):
        """内部日志记录方法"""
        # 创建事件
        event = LogEvent(
            event_type=event_type,
            message=message,
            level=logging.getLevelName(level),
            step_number=self._step_number if self._step_number > 0 else None,
            **{k: v for k, v in kwargs.items() if k in LogEvent.__dataclass_fields__}
        )

        # 保存事件
        self._events.append(event)

        # 记录日志
        extra_data = {
            "event_type": event_type,
            **kwargs.get("details", {}),
        }
        if self._task_id:
            extra_data["task_id"] = self._task_id
        if self._step_number > 0:
            extra_data["step"] = self._step_number
        if "duration_ms" in kwargs:
            extra_data["duration_ms"] = kwargs["duration_ms"]

        self.logger.log(
            level,
            str(event),
            extra={"extra_data": extra_data}
        )

    # ============ 便捷日志方法 ============

    def step_start(self, step_number: int, description: str = ""):
        """记录步骤开始"""
        self._step_number = step_number
        self._log(
            logging.INFO,
            "STEP_START",
            f"步骤 {step_number} 开始" + (f": {description}" if description else ""),
        )

    def step_end(self, success: bool, duration_ms: float, message: str = ""):
        """记录步骤结束"""
        level = logging.INFO if success else logging.WARNING
        self._log(
            level,
            "STEP_END",
            f"步骤 {self._step_number} {'成功' if success else '失败'}" + (f": {message}" if message else ""),
            duration_ms=duration_ms,
            details={"success": success},
        )

    def action_start(self, action_type: str, target: str = ""):
        """记录动作开始"""
        self._log(
            logging.DEBUG,
            "ACTION_START",
            f"执行 {action_type}" + (f" -> {target}" if target else ""),
            action_type=action_type,
        )

    def action_end(self, action_type: str, success: bool, duration_ms: float, error: str = None):
        """记录动作结束"""
        level = logging.DEBUG if success else logging.WARNING
        self._log(
            level,
            "ACTION_END",
            f"{action_type} {'成功' if success else '失败'}",
            action_type=action_type,
            duration_ms=duration_ms,
            error=error,
        )

    def llm_call(self, provider: str, model: str, duration_ms: float, tokens: int = 0):
        """记录 LLM 调用"""
        self._log(
            logging.DEBUG,
            "LLM_CALL",
            f"LLM 调用: {provider}/{model}",
            duration_ms=duration_ms,
            details={"provider": provider, "model": model, "tokens": tokens},
        )

    def screenshot(self, duration_ms: float, elements_count: int = 0):
        """记录截图操作"""
        self._log(
            logging.DEBUG,
            "SCREENSHOT",
            f"截图完成，检测到 {elements_count} 个元素",
            duration_ms=duration_ms,
            details={"elements_count": elements_count},
        )

    def navigation(self, url: str, duration_ms: float):
        """记录页面导航"""
        self._log(
            logging.INFO,
            "NAVIGATION",
            f"导航到: {url[:80]}{'...' if len(url) > 80 else ''}",
            duration_ms=duration_ms,
            details={"url": url},
        )

    def error(self, message: str, error_type: str = None, recoverable: bool = True):
        """记录错误"""
        self._log(
            logging.ERROR,
            "ERROR",
            message,
            error=error_type,
            details={"recoverable": recoverable},
        )

    def warning(self, message: str, **details):
        """记录警告"""
        self._log(logging.WARNING, "WARNING", message, details=details)

    def info(self, message: str, **details):
        """记录信息"""
        self._log(logging.INFO, "INFO", message, details=details)

    def debug(self, message: str, **details):
        """记录调试信息"""
        self._log(logging.DEBUG, "DEBUG", message, details=details)

    def task_start(self, task_id: str, goal: str):
        """记录任务开始"""
        self._task_id = task_id
        self._step_number = 0
        self._events.clear()
        self._log(
            logging.INFO,
            "TASK_START",
            f"任务开始: {goal[:50]}{'...' if len(goal) > 50 else ''}",
            details={"goal": goal},
        )

    def task_end(self, success: bool, total_steps: int, total_duration_ms: float, message: str = ""):
        """记录任务结束"""
        level = logging.INFO if success else logging.ERROR
        self._log(
            level,
            "TASK_END",
            f"任务{'成功' if success else '失败'}: {message}" if message else f"任务{'成功' if success else '失败'}",
            duration_ms=total_duration_ms,
            details={
                "success": success,
                "total_steps": total_steps,
            },
        )

    def get_events(self, limit: int = None) -> List[LogEvent]:
        """获取日志事件"""
        if limit:
            return self._events[-limit:]
        return self._events.copy()

    def get_summary(self) -> Dict[str, Any]:
        """获取日志摘要"""
        if not self._events:
            return {}

        return {
            "total_events": len(self._events),
            "errors": sum(1 for e in self._events if e.level == "ERROR"),
            "warnings": sum(1 for e in self._events if e.level == "WARNING"),
            "steps": max((e.step_number or 0) for e in self._events),
            "first_event": self._events[0].timestamp.isoformat(),
            "last_event": self._events[-1].timestamp.isoformat(),
        }


# ============ 性能跟踪装饰器 ============

def log_performance(logger: AgentLogger = None, event_type: str = "PERFORMANCE"):
    """
    性能跟踪装饰器

    自动记录函数执行时间

    Args:
        logger: AgentLogger 实例
        event_type: 事件类型
    """
    def decorator(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = await func(*args, **kwargs)
                duration_ms = (time.time() - start_time) * 1000
                if logger:
                    logger._log(
                        logging.DEBUG,
                        event_type,
                        f"{func.__name__} 完成",
                        duration_ms=duration_ms,
                    )
                return result
            except Exception as e:
                duration_ms = (time.time() - start_time) * 1000
                if logger:
                    logger._log(
                        logging.ERROR,
                        event_type,
                        f"{func.__name__} 失败: {e}",
                        duration_ms=duration_ms,
                        error=str(e),
                    )
                raise

        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            start_time = time.time()
            try:
                result = func(*args, **kwargs)
                duration_ms = (time.time() - start_time) * 1000
                if logger:
                    logger._log(
                        logging.DEBUG,
                        event_type,
                        f"{func.__name__} 完成",
                        duration_ms=duration_ms,
                    )
                return result
            except Exception as e:
                duration_ms = (time.time() - start_time) * 1000
                if logger:
                    logger._log(
                        logging.ERROR,
                        event_type,
                        f"{func.__name__} 失败: {e}",
                        duration_ms=duration_ms,
                        error=str(e),
                    )
                raise

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


# ============ 全局实例和便捷函数 ============

_default_logger: Optional[AgentLogger] = None


def get_agent_logger() -> AgentLogger:
    """获取默认 Agent 日志器"""
    global _default_logger
    if _default_logger is None:
        _default_logger = AgentLogger()
        _default_logger.configure_handler(structured=False)
    return _default_logger


def configure_logging(
    level: int = logging.INFO,
    structured: bool = False,
    use_colors: bool = True,
):
    """
    配置全局日志

    Args:
        level: 日志级别
        structured: 是否使用 JSON 格式
        use_colors: 是否使用颜色（仅非 JSON 模式）
    """
    logger = get_agent_logger()
    logger.logger.setLevel(level)
    logger.configure_handler(structured=structured, use_colors=use_colors)
    return logger


def create_agent_logger(
    name: str = "ai_browser_agent",
    level: int = logging.INFO,
    structured: bool = False,
) -> AgentLogger:
    """创建新的 Agent 日志器"""
    logger = AgentLogger(name=name, level=level, structured=structured)
    logger.configure_handler()
    return logger
