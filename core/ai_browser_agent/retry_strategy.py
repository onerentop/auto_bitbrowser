"""
AI Agent 重试策略模块

提供统一的重试逻辑，解决原有代码中三处重试策略不一致的问题：
1. vision_analyzer.py: 3次重试，1秒固定延迟
2. retry_helper.py: 可配置，指数退避
3. agent.py: 3次重试，2秒固定延迟

本模块统一为：分类错误 + 全局重试预算 + 指数退避
"""

import asyncio
from dataclasses import dataclass, field
from typing import Callable, Any, Tuple, Optional, List
from enum import Enum


class ErrorCategory(Enum):
    """错误分类"""
    NETWORK = "network"      # 网络错误（超时、连接失败）
    API = "api"              # API 错误（限流、空响应）
    ELEMENT = "element"      # 元素错误（未找到、不可见）
    UNKNOWN = "unknown"      # 未知错误


@dataclass
class RetryConfig:
    """重试配置"""
    max_retries: int = 3
    base_delay: float = 1.0
    backoff_factor: float = 1.5
    max_delay: float = 10.0


@dataclass
class RetryStats:
    """重试统计"""
    total_attempts: int = 0
    successful_retries: int = 0
    failed_retries: int = 0
    by_category: dict = field(default_factory=dict)


class AgentRetryStrategy:
    """
    AI Agent 统一重试策略管理器

    特性：
    1. 错误分类：不同类型错误使用不同重试配置
    2. 全局重试预算：防止无限重试
    3. 指数退避：避免频繁重试
    4. 统计追踪：记录重试情况

    Usage:
        strategy = AgentRetryStrategy()

        # 方式1：手动重试
        for attempt in strategy.attempts("api"):
            try:
                result = await api_call()
                break
            except Exception as e:
                if not strategy.should_retry(e, "api"):
                    raise

        # 方式2：自动重试
        success, result = await strategy.execute_with_retry(
            async_func, "network", arg1, arg2
        )
    """

    # 错误关键词分类
    ERROR_KEYWORDS = {
        ErrorCategory.NETWORK: [
            "timeout", "timed out", "connection", "network",
            "socket", "refused", "reset", "unreachable"
        ],
        ErrorCategory.API: [
            "rate_limit", "rate limit", "429", "500", "502", "503",
            "empty response", "空响应", "server error"
        ],
        ErrorCategory.ELEMENT: [
            "not found", "not visible", "intercepted", "detached",
            "stale", "no such element", "未找到"
        ],
    }

    # 默认重试配置（按错误类别）
    DEFAULT_CONFIGS = {
        ErrorCategory.NETWORK: RetryConfig(max_retries=3, base_delay=2.0, backoff_factor=2.0),
        ErrorCategory.API: RetryConfig(max_retries=3, base_delay=1.0, backoff_factor=1.5),
        ErrorCategory.ELEMENT: RetryConfig(max_retries=2, base_delay=0.5, backoff_factor=1.0),
        ErrorCategory.UNKNOWN: RetryConfig(max_retries=2, base_delay=1.0, backoff_factor=1.5),
    }

    # 全局重试预算
    MAX_TOTAL_RETRIES = 10

    def __init__(
        self,
        configs: Optional[dict] = None,
        max_total_retries: int = None,
    ):
        """
        初始化重试策略

        Args:
            configs: 自定义重试配置 {ErrorCategory: RetryConfig}
            max_total_retries: 全局最大重试次数
        """
        self.configs = {**self.DEFAULT_CONFIGS}
        if configs:
            self.configs.update(configs)

        self.max_total_retries = max_total_retries or self.MAX_TOTAL_RETRIES
        self._total_retries = 0
        self._stats = RetryStats()

    def classify_error(self, error: Exception) -> ErrorCategory:
        """
        分类错误

        Args:
            error: 异常对象

        Returns:
            错误类别
        """
        error_str = str(error).lower()

        for category, keywords in self.ERROR_KEYWORDS.items():
            if any(kw in error_str for kw in keywords):
                return category

        return ErrorCategory.UNKNOWN

    def should_retry(
        self,
        error: Exception,
        category: Optional[ErrorCategory] = None,
        attempt: int = 1,
    ) -> bool:
        """
        判断是否应该重试

        Args:
            error: 异常对象
            category: 错误类别（可选，自动分类）
            attempt: 当前尝试次数

        Returns:
            是否应该重试
        """
        # 检查全局预算
        if self._total_retries >= self.max_total_retries:
            print(f"[RetryStrategy] 达到全局重试上限 ({self.max_total_retries})")
            return False

        # 分类错误
        if category is None:
            category = self.classify_error(error)

        # 获取配置
        config = self.configs.get(category, self.DEFAULT_CONFIGS[ErrorCategory.UNKNOWN])

        # 检查是否超过类别重试上限
        if attempt >= config.max_retries:
            return False

        return True

    def get_delay(
        self,
        category: ErrorCategory,
        attempt: int,
    ) -> float:
        """
        获取重试延迟时间

        Args:
            category: 错误类别
            attempt: 当前尝试次数（从1开始）

        Returns:
            延迟秒数
        """
        config = self.configs.get(category, self.DEFAULT_CONFIGS[ErrorCategory.UNKNOWN])
        delay = config.base_delay * (config.backoff_factor ** (attempt - 1))
        return min(delay, config.max_delay)

    async def execute_with_retry(
        self,
        func: Callable,
        category: ErrorCategory = ErrorCategory.NETWORK,
        *args,
        **kwargs
    ) -> Tuple[bool, Any]:
        """
        带重试执行异步函数

        Args:
            func: 要执行的异步函数
            category: 预期错误类别
            *args, **kwargs: 函数参数

        Returns:
            (success, result_or_error)
        """
        config = self.configs.get(category, self.DEFAULT_CONFIGS[ErrorCategory.UNKNOWN])
        last_error = None

        for attempt in range(1, config.max_retries + 1):
            # 检查全局预算
            if self._total_retries >= self.max_total_retries:
                return False, f"达到全局重试上限 ({self.max_total_retries})"

            try:
                result = await func(*args, **kwargs)
                if attempt > 1:
                    self._stats.successful_retries += 1
                return True, result

            except Exception as e:
                last_error = e
                actual_category = self.classify_error(e)

                # 更新统计
                self._stats.total_attempts += 1
                self._stats.by_category[actual_category.value] = \
                    self._stats.by_category.get(actual_category.value, 0) + 1

                # 检查是否应该重试
                if not self.should_retry(e, actual_category, attempt):
                    self._stats.failed_retries += 1
                    break

                # 计算延迟
                delay = self.get_delay(actual_category, attempt)
                print(f"[RetryStrategy] 第 {attempt} 次失败 ({actual_category.value}): {e}")
                print(f"[RetryStrategy] {delay:.1f}s 后重试...")

                self._total_retries += 1
                await asyncio.sleep(delay)

        self._stats.failed_retries += 1
        return False, last_error

    def reset(self):
        """重置重试计数（新任务开始时调用）"""
        self._total_retries = 0

    def get_stats(self) -> RetryStats:
        """获取重试统计"""
        return self._stats

    @property
    def remaining_budget(self) -> int:
        """剩余重试预算"""
        return max(0, self.max_total_retries - self._total_retries)


# 全局单例（可选使用）
_global_strategy: Optional[AgentRetryStrategy] = None


def get_global_retry_strategy() -> AgentRetryStrategy:
    """获取全局重试策略单例"""
    global _global_strategy
    if _global_strategy is None:
        _global_strategy = AgentRetryStrategy()
    return _global_strategy


def reset_global_retry_strategy():
    """重置全局重试策略"""
    global _global_strategy
    if _global_strategy:
        _global_strategy.reset()
