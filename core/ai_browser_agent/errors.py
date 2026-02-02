"""
错误分类与处理模块

提供：
- 统一的错误分类体系
- 错误恢复策略
- 结构化错误信息

参考 browser-use 的错误处理设计
"""

import asyncio
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, List, Callable, Type
from enum import Enum
from datetime import datetime
import traceback
import re


class ErrorCategory(str, Enum):
    """错误类别"""

    # 网络相关
    NETWORK = "network"
    NETWORK_TIMEOUT = "network_timeout"
    CONNECTION_REFUSED = "connection_refused"

    # 页面相关
    PAGE_NOT_FOUND = "page_not_found"
    PAGE_CRASH = "page_crash"
    PAGE_TIMEOUT = "page_timeout"

    # 元素相关
    ELEMENT_NOT_FOUND = "element_not_found"
    ELEMENT_NOT_VISIBLE = "element_not_visible"
    ELEMENT_NOT_INTERACTABLE = "element_not_interactable"
    ELEMENT_DETACHED = "element_detached"

    # LLM 相关
    LLM_API_ERROR = "llm_api_error"
    LLM_RATE_LIMIT = "llm_rate_limit"
    LLM_INVALID_RESPONSE = "llm_invalid_response"
    LLM_CONTEXT_TOO_LONG = "llm_context_too_long"

    # 浏览器相关
    BROWSER_CRASH = "browser_crash"
    BROWSER_DISCONNECTED = "browser_disconnected"

    # 任务相关
    TASK_TIMEOUT = "task_timeout"
    TASK_FAILED = "task_failed"
    TASK_CANCELLED = "task_cancelled"

    # 认证相关
    AUTH_REQUIRED = "auth_required"
    AUTH_FAILED = "auth_failed"
    CAPTCHA_REQUIRED = "captcha_required"

    # 其他
    UNKNOWN = "unknown"
    INTERNAL = "internal"


class RecoveryAction(str, Enum):
    """恢复动作"""
    RETRY = "retry"           # 重试
    REFRESH = "refresh"       # 刷新页面
    WAIT = "wait"            # 等待
    SKIP = "skip"            # 跳过
    RESTART = "restart"       # 重启
    ABORT = "abort"          # 中止
    MANUAL = "manual"         # 人工处理


@dataclass
class RecoveryStrategy:
    """恢复策略"""
    action: RecoveryAction
    max_retries: int = 3
    delay_seconds: float = 1.0
    escalate_after: int = 2  # 几次重试后升级策略

    def should_escalate(self, attempt: int) -> bool:
        return attempt >= self.escalate_after


# 错误类别到恢复策略的映射
DEFAULT_RECOVERY_STRATEGIES: Dict[ErrorCategory, RecoveryStrategy] = {
    ErrorCategory.NETWORK_TIMEOUT: RecoveryStrategy(
        RecoveryAction.RETRY, max_retries=3, delay_seconds=2.0
    ),
    ErrorCategory.CONNECTION_REFUSED: RecoveryStrategy(
        RecoveryAction.WAIT, max_retries=2, delay_seconds=5.0
    ),
    ErrorCategory.ELEMENT_NOT_FOUND: RecoveryStrategy(
        RecoveryAction.RETRY, max_retries=2, delay_seconds=1.0
    ),
    ErrorCategory.ELEMENT_NOT_VISIBLE: RecoveryStrategy(
        RecoveryAction.WAIT, max_retries=2, delay_seconds=2.0
    ),
    ErrorCategory.LLM_RATE_LIMIT: RecoveryStrategy(
        RecoveryAction.WAIT, max_retries=5, delay_seconds=10.0
    ),
    ErrorCategory.LLM_API_ERROR: RecoveryStrategy(
        RecoveryAction.RETRY, max_retries=3, delay_seconds=2.0
    ),
    ErrorCategory.PAGE_TIMEOUT: RecoveryStrategy(
        RecoveryAction.REFRESH, max_retries=2, delay_seconds=3.0
    ),
    ErrorCategory.BROWSER_DISCONNECTED: RecoveryStrategy(
        RecoveryAction.RESTART, max_retries=1, delay_seconds=5.0
    ),
    ErrorCategory.CAPTCHA_REQUIRED: RecoveryStrategy(
        RecoveryAction.MANUAL, max_retries=0
    ),
    ErrorCategory.AUTH_REQUIRED: RecoveryStrategy(
        RecoveryAction.MANUAL, max_retries=0
    ),
    ErrorCategory.UNKNOWN: RecoveryStrategy(
        RecoveryAction.RETRY, max_retries=2, delay_seconds=1.0
    ),
}


@dataclass
class ClassifiedError:
    """分类后的错误"""
    category: ErrorCategory
    message: str
    original_error: Optional[Exception] = None
    details: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.now)
    traceback_str: Optional[str] = None
    is_recoverable: bool = True
    recovery_strategy: Optional[RecoveryStrategy] = None

    def __post_init__(self):
        # 自动设置恢复策略
        if self.recovery_strategy is None:
            self.recovery_strategy = DEFAULT_RECOVERY_STRATEGIES.get(
                self.category,
                DEFAULT_RECOVERY_STRATEGIES[ErrorCategory.UNKNOWN]
            )

        # 设置是否可恢复
        if self.recovery_strategy.action in (RecoveryAction.ABORT, RecoveryAction.MANUAL):
            self.is_recoverable = False

    def to_dict(self) -> dict:
        return {
            "category": self.category.value,
            "message": self.message,
            "details": self.details,
            "timestamp": self.timestamp.isoformat(),
            "is_recoverable": self.is_recoverable,
            "recovery_action": self.recovery_strategy.action.value if self.recovery_strategy else None,
        }


class ErrorClassifier:
    """
    错误分类器

    根据异常类型和消息内容自动分类错误
    """

    # 错误模式匹配规则
    ERROR_PATTERNS: List[tuple] = [
        # (pattern, category)
        # 网络相关
        (r"timeout|timed out", ErrorCategory.NETWORK_TIMEOUT),
        (r"connection refused|ECONNREFUSED", ErrorCategory.CONNECTION_REFUSED),
        (r"network|ERR_NETWORK", ErrorCategory.NETWORK),

        # 元素相关（放在页面相关之前，避免 "element not found" 被误匹配）
        (r"element.*not found|no element|locator.*resolved to", ErrorCategory.ELEMENT_NOT_FOUND),
        (r"element.*not visible|invisible|hidden", ErrorCategory.ELEMENT_NOT_VISIBLE),
        (r"element.*not interactable|intercepts pointer", ErrorCategory.ELEMENT_NOT_INTERACTABLE),
        (r"element.*detached|stale element", ErrorCategory.ELEMENT_DETACHED),

        # 页面相关（更精确的匹配）
        (r"404|page.*not found|ERR_NAME_NOT_RESOLVED", ErrorCategory.PAGE_NOT_FOUND),
        (r"page crash|target closed", ErrorCategory.PAGE_CRASH),
        (r"navigation timeout", ErrorCategory.PAGE_TIMEOUT),

        # LLM 相关
        (r"rate limit|429|too many requests", ErrorCategory.LLM_RATE_LIMIT),
        (r"api.*error|500|502|503", ErrorCategory.LLM_API_ERROR),
        (r"invalid.*response|json.*parse|decode error", ErrorCategory.LLM_INVALID_RESPONSE),
        (r"context.*too long|token limit|max.*token", ErrorCategory.LLM_CONTEXT_TOO_LONG),

        # 浏览器相关
        (r"browser.*crash|chromium.*crash", ErrorCategory.BROWSER_CRASH),
        (r"browser.*disconnect|cdp.*disconnect|websocket.*close", ErrorCategory.BROWSER_DISCONNECTED),

        # 认证相关
        (r"login.*required|auth.*required|unauthorized|401", ErrorCategory.AUTH_REQUIRED),
        (r"login.*fail|auth.*fail|invalid.*password", ErrorCategory.AUTH_FAILED),
        (r"captcha|recaptcha|verify.*human", ErrorCategory.CAPTCHA_REQUIRED),
    ]

    # 异常类型映射
    EXCEPTION_TYPE_MAP: Dict[Type[Exception], ErrorCategory] = {
        TimeoutError: ErrorCategory.NETWORK_TIMEOUT,
        ConnectionError: ErrorCategory.CONNECTION_REFUSED,
        asyncio.TimeoutError: ErrorCategory.NETWORK_TIMEOUT,
    }

    def __init__(self):
        # 编译正则模式
        self._compiled_patterns = [
            (re.compile(pattern, re.IGNORECASE), category)
            for pattern, category in self.ERROR_PATTERNS
        ]

    def classify(
        self,
        error: Exception,
        context: Dict[str, Any] = None
    ) -> ClassifiedError:
        """
        分类错误

        Args:
            error: 原始异常
            context: 上下文信息

        Returns:
            ClassifiedError
        """
        error_message = str(error)
        error_type = type(error)

        # 首先检查异常类型
        category = self.EXCEPTION_TYPE_MAP.get(error_type)

        # 如果类型未匹配，检查消息模式
        if category is None:
            for pattern, cat in self._compiled_patterns:
                if pattern.search(error_message):
                    category = cat
                    break

        # 默认为未知
        if category is None:
            category = ErrorCategory.UNKNOWN

        return ClassifiedError(
            category=category,
            message=error_message,
            original_error=error,
            details=context or {},
            traceback_str=traceback.format_exc(),
        )

    def classify_from_message(
        self,
        message: str,
        context: Dict[str, Any] = None
    ) -> ClassifiedError:
        """
        从错误消息分类

        Args:
            message: 错误消息
            context: 上下文信息

        Returns:
            ClassifiedError
        """
        category = ErrorCategory.UNKNOWN

        for pattern, cat in self._compiled_patterns:
            if pattern.search(message):
                category = cat
                break

        return ClassifiedError(
            category=category,
            message=message,
            details=context or {},
        )


# ============ 错误处理装饰器 ============


def with_error_handling(
    classifier: ErrorClassifier = None,
    on_error: Callable[[ClassifiedError], None] = None,
    reraise: bool = True,
):
    """
    错误处理装饰器

    自动分类和记录错误

    Args:
        classifier: 错误分类器（默认创建新实例）
        on_error: 错误回调
        reraise: 是否重新抛出异常
    """
    if classifier is None:
        classifier = ErrorClassifier()

    def decorator(func):
        if asyncio.iscoroutinefunction(func):
            async def async_wrapper(*args, **kwargs):
                try:
                    return await func(*args, **kwargs)
                except Exception as e:
                    classified = classifier.classify(e)
                    if on_error:
                        on_error(classified)
                    if reraise:
                        raise

            return async_wrapper
        else:
            def sync_wrapper(*args, **kwargs):
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    classified = classifier.classify(e)
                    if on_error:
                        on_error(classified)
                    if reraise:
                        raise

            return sync_wrapper

    return decorator


# ============ 全局实例 ============

_default_classifier: Optional[ErrorClassifier] = None


def get_error_classifier() -> ErrorClassifier:
    """获取默认错误分类器"""
    global _default_classifier
    if _default_classifier is None:
        _default_classifier = ErrorClassifier()
    return _default_classifier


def classify_error(
    error: Exception,
    context: Dict[str, Any] = None
) -> ClassifiedError:
    """便捷函数：分类错误"""
    return get_error_classifier().classify(error, context)
