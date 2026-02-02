"""
LLM 重试机制增强模块

提供：
- 智能重试策略
- 错误分类与恢复
- 速率限制处理
- 指数退避

参考 browser-use 的 LLM 重试设计
"""

import asyncio
import logging
import time
import random
from dataclasses import dataclass, field
from typing import Optional, Callable, Any, Dict, TypeVar, Generic, Tuple
from enum import Enum
from functools import wraps

from .errors import ErrorCategory, ErrorClassifier, ClassifiedError, get_error_classifier

logger = logging.getLogger("ai_browser_agent.llm_retry")

T = TypeVar("T")


class RetryDecision(str, Enum):
    """重试决策"""
    RETRY = "retry"           # 重试
    RETRY_WITH_DELAY = "retry_with_delay"  # 延迟后重试
    FAIL = "fail"             # 失败，不再重试
    SKIP = "skip"             # 跳过此操作


@dataclass
class RetryConfig:
    """重试配置"""
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    backoff_factor: float = 2.0
    jitter: bool = True  # 添加随机抖动

    # 特定错误的重试配置
    rate_limit_delay: float = 10.0
    rate_limit_max_retries: int = 5
    context_too_long_retries: int = 1  # 上下文过长只重试一次


@dataclass
class RetryState:
    """重试状态"""
    attempt: int = 0
    total_delay: float = 0.0
    last_error: Optional[Exception] = None
    last_category: Optional[ErrorCategory] = None
    start_time: float = field(default_factory=time.time)

    @property
    def elapsed_seconds(self) -> float:
        return time.time() - self.start_time


@dataclass
class RetryResult(Generic[T]):
    """重试结果"""
    success: bool
    value: Optional[T] = None
    error: Optional[Exception] = None
    attempts: int = 0
    total_delay: float = 0.0
    classified_error: Optional[ClassifiedError] = None


class LLMRetryHandler:
    """
    LLM 重试处理器

    智能处理 LLM API 调用的重试逻辑
    """

    # 错误类别到重试策略的映射
    CATEGORY_CONFIG: Dict[ErrorCategory, Dict[str, Any]] = {
        ErrorCategory.LLM_RATE_LIMIT: {
            "max_retries": 5,
            "base_delay": 10.0,
            "backoff_factor": 2.0,
        },
        ErrorCategory.LLM_API_ERROR: {
            "max_retries": 3,
            "base_delay": 2.0,
            "backoff_factor": 2.0,
        },
        ErrorCategory.LLM_INVALID_RESPONSE: {
            "max_retries": 2,
            "base_delay": 1.0,
            "backoff_factor": 1.5,
        },
        ErrorCategory.LLM_CONTEXT_TOO_LONG: {
            "max_retries": 1,
            "base_delay": 0.0,
            "backoff_factor": 1.0,
        },
        ErrorCategory.NETWORK_TIMEOUT: {
            "max_retries": 3,
            "base_delay": 3.0,
            "backoff_factor": 2.0,
        },
        ErrorCategory.NETWORK: {
            "max_retries": 3,
            "base_delay": 2.0,
            "backoff_factor": 2.0,
        },
    }

    def __init__(
        self,
        config: RetryConfig = None,
        classifier: ErrorClassifier = None,
        on_retry: Callable[[int, Exception, float], None] = None,
    ):
        """
        初始化 LLM 重试处理器

        Args:
            config: 重试配置
            classifier: 错误分类器
            on_retry: 重试回调 (attempt, error, delay)
        """
        self.config = config or RetryConfig()
        self.classifier = classifier or get_error_classifier()
        self.on_retry = on_retry

    def _get_category_config(self, category: ErrorCategory) -> Dict[str, Any]:
        """获取特定错误类别的配置"""
        return self.CATEGORY_CONFIG.get(category, {
            "max_retries": self.config.max_retries,
            "base_delay": self.config.base_delay,
            "backoff_factor": self.config.backoff_factor,
        })

    def _calculate_delay(
        self,
        attempt: int,
        category: ErrorCategory,
    ) -> float:
        """计算重试延迟"""
        cat_config = self._get_category_config(category)
        base_delay = cat_config.get("base_delay", self.config.base_delay)
        backoff = cat_config.get("backoff_factor", self.config.backoff_factor)

        delay = base_delay * (backoff ** attempt)

        # 限制最大延迟
        delay = min(delay, self.config.max_delay)

        # 添加抖动
        if self.config.jitter:
            delay = delay * (0.5 + random.random())

        return delay

    def _should_retry(
        self,
        state: RetryState,
        classified: ClassifiedError,
    ) -> Tuple[bool, float]:
        """
        判断是否应该重试

        Returns:
            (should_retry, delay_seconds)
        """
        category = classified.category
        cat_config = self._get_category_config(category)
        max_retries = cat_config.get("max_retries", self.config.max_retries)

        # 检查是否超过最大重试次数
        if state.attempt >= max_retries:
            logger.warning(f"已达到最大重试次数 ({max_retries})")
            return False, 0.0

        # 检查是否可恢复
        if not classified.is_recoverable:
            logger.warning(f"错误不可恢复: {classified.category.value}")
            return False, 0.0

        # 计算延迟
        delay = self._calculate_delay(state.attempt, category)

        return True, delay

    async def execute_with_retry(
        self,
        func: Callable[..., Any],
        *args,
        context: Dict[str, Any] = None,
        **kwargs
    ) -> RetryResult:
        """
        带重试执行函数

        Args:
            func: 要执行的异步函数
            *args: 函数参数
            context: 错误上下文
            **kwargs: 函数关键字参数

        Returns:
            RetryResult
        """
        state = RetryState()

        while True:
            state.attempt += 1

            try:
                # 执行函数
                if asyncio.iscoroutinefunction(func):
                    result = await func(*args, **kwargs)
                else:
                    result = func(*args, **kwargs)

                return RetryResult(
                    success=True,
                    value=result,
                    attempts=state.attempt,
                    total_delay=state.total_delay,
                )

            except Exception as e:
                state.last_error = e

                # 分类错误
                classified = self.classifier.classify(e, context)
                state.last_category = classified.category

                logger.warning(
                    f"LLM 调用失败 (尝试 {state.attempt}): "
                    f"[{classified.category.value}] {e}"
                )

                # 判断是否重试
                should_retry, delay = self._should_retry(state, classified)

                if not should_retry:
                    return RetryResult(
                        success=False,
                        error=e,
                        attempts=state.attempt,
                        total_delay=state.total_delay,
                        classified_error=classified,
                    )

                # 执行重试
                logger.info(f"将在 {delay:.1f}s 后重试...")

                if self.on_retry:
                    self.on_retry(state.attempt, e, delay)

                await asyncio.sleep(delay)
                state.total_delay += delay

    def sync_execute_with_retry(
        self,
        func: Callable[..., Any],
        *args,
        context: Dict[str, Any] = None,
        **kwargs
    ) -> RetryResult:
        """
        同步版本的重试执行

        Args:
            func: 要执行的同步函数
            *args: 函数参数
            context: 错误上下文
            **kwargs: 函数关键字参数

        Returns:
            RetryResult
        """
        state = RetryState()

        while True:
            state.attempt += 1

            try:
                result = func(*args, **kwargs)
                return RetryResult(
                    success=True,
                    value=result,
                    attempts=state.attempt,
                    total_delay=state.total_delay,
                )

            except Exception as e:
                state.last_error = e
                classified = self.classifier.classify(e, context)
                state.last_category = classified.category

                logger.warning(
                    f"LLM 调用失败 (尝试 {state.attempt}): "
                    f"[{classified.category.value}] {e}"
                )

                should_retry, delay = self._should_retry(state, classified)

                if not should_retry:
                    return RetryResult(
                        success=False,
                        error=e,
                        attempts=state.attempt,
                        total_delay=state.total_delay,
                        classified_error=classified,
                    )

                logger.info(f"将在 {delay:.1f}s 后重试...")

                if self.on_retry:
                    self.on_retry(state.attempt, e, delay)

                time.sleep(delay)
                state.total_delay += delay


# ============ 重试装饰器 ============

def with_llm_retry(
    max_retries: int = 3,
    base_delay: float = 1.0,
    on_retry: Callable[[int, Exception, float], None] = None,
):
    """
    LLM 重试装饰器

    Args:
        max_retries: 最大重试次数
        base_delay: 基础延迟
        on_retry: 重试回调
    """
    config = RetryConfig(max_retries=max_retries, base_delay=base_delay)
    handler = LLMRetryHandler(config=config, on_retry=on_retry)

    def decorator(func):
        @wraps(func)
        async def async_wrapper(*args, **kwargs):
            result = await handler.execute_with_retry(func, *args, **kwargs)
            if result.success:
                return result.value
            else:
                raise result.error

        @wraps(func)
        def sync_wrapper(*args, **kwargs):
            result = handler.sync_execute_with_retry(func, *args, **kwargs)
            if result.success:
                return result.value
            else:
                raise result.error

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


def with_rate_limit_retry(
    max_retries: int = 5,
    base_delay: float = 10.0,
):
    """
    速率限制专用重试装饰器

    针对 429 Too Many Requests 优化
    """
    return with_llm_retry(max_retries=max_retries, base_delay=base_delay)


# ============ 便捷函数 ============

_default_handler: Optional[LLMRetryHandler] = None


def get_llm_retry_handler() -> LLMRetryHandler:
    """获取默认 LLM 重试处理器"""
    global _default_handler
    if _default_handler is None:
        _default_handler = LLMRetryHandler()
    return _default_handler


async def execute_with_retry(
    func: Callable[..., Any],
    *args,
    **kwargs
) -> RetryResult:
    """便捷函数：带重试执行"""
    handler = get_llm_retry_handler()
    return await handler.execute_with_retry(func, *args, **kwargs)


def create_retry_handler(
    max_retries: int = 3,
    base_delay: float = 1.0,
    on_retry: Callable[[int, Exception, float], None] = None,
) -> LLMRetryHandler:
    """创建自定义重试处理器"""
    config = RetryConfig(max_retries=max_retries, base_delay=base_delay)
    return LLMRetryHandler(config=config, on_retry=on_retry)
