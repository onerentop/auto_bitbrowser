"""
智能重试框架
提供指数退避重试、失败任务队列管理等功能
"""
import asyncio
import time
import json
import os
import sys
import threading
from typing import Callable, Any, Tuple, Optional
from functools import wraps

# 获取基础路径
def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE_PATH = get_base_path()


class RetryHelper:
    """
    重试助手类
    支持同步和异步函数的自动重试，使用指数退避策略
    """

    # 可重试的异常类型
    RETRYABLE_EXCEPTIONS = (
        TimeoutError,
        ConnectionError,
        ConnectionResetError,
        OSError,
    )

    def __init__(
        self,
        max_retries: int = 3,
        base_delay: float = 2.0,
        backoff_factor: float = 2.0,
        max_delay: float = 60.0,
        retryable_exceptions: tuple = None,
        log_callback: Callable[[str], None] = None
    ):
        """
        初始化重试助手

        Args:
            max_retries: 最大重试次数
            base_delay: 基础延迟时间（秒）
            backoff_factor: 退避因子，每次重试延迟 = base_delay * (backoff_factor ^ attempt)
            max_delay: 最大延迟时间（秒）
            retryable_exceptions: 可重试的异常类型元组
            log_callback: 日志回调函数
        """
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.backoff_factor = backoff_factor
        self.max_delay = max_delay
        self.retryable_exceptions = retryable_exceptions or self.RETRYABLE_EXCEPTIONS
        self.log_callback = log_callback or print

    def _calculate_delay(self, attempt: int) -> float:
        """计算延迟时间（指数退避）"""
        delay = self.base_delay * (self.backoff_factor ** attempt)
        return min(delay, self.max_delay)

    def _is_retryable(self, exception: Exception) -> bool:
        """判断异常是否可重试"""
        # 检查异常类型
        if isinstance(exception, self.retryable_exceptions):
            return True

        # 检查异常消息中是否包含网络相关关键词
        error_msg = str(exception).lower()
        network_keywords = ['timeout', 'connection', 'network', 'socket', 'refused']
        return any(keyword in error_msg for keyword in network_keywords)

    async def execute_async(
        self,
        func: Callable,
        *args,
        **kwargs
    ) -> Tuple[bool, Any]:
        """
        执行异步函数并自动重试

        Returns:
            (success, result_or_error): 成功返回 (True, result)，失败返回 (False, error_message)
        """
        last_exception = None

        for attempt in range(self.max_retries + 1):
            try:
                if asyncio.iscoroutinefunction(func):
                    result = await func(*args, **kwargs)
                else:
                    result = func(*args, **kwargs)
                return True, result

            except Exception as e:
                last_exception = e

                if attempt < self.max_retries and self._is_retryable(e):
                    delay = self._calculate_delay(attempt)
                    self.log_callback(
                        f"[重试] 第{attempt + 1}次失败: {str(e)[:50]}... "
                        f"将在{delay:.1f}秒后重试 ({attempt + 1}/{self.max_retries})"
                    )
                    await asyncio.sleep(delay)
                else:
                    break

        error_msg = str(last_exception) if last_exception else "未知错误"
        return False, error_msg

    def execute_sync(
        self,
        func: Callable,
        *args,
        **kwargs
    ) -> Tuple[bool, Any]:
        """
        执行同步函数并自动重试

        Returns:
            (success, result_or_error): 成功返回 (True, result)，失败返回 (False, error_message)
        """
        last_exception = None

        for attempt in range(self.max_retries + 1):
            try:
                result = func(*args, **kwargs)
                return True, result

            except Exception as e:
                last_exception = e

                if attempt < self.max_retries and self._is_retryable(e):
                    delay = self._calculate_delay(attempt)
                    self.log_callback(
                        f"[重试] 第{attempt + 1}次失败: {str(e)[:50]}... "
                        f"将在{delay:.1f}秒后重试 ({attempt + 1}/{self.max_retries})"
                    )
                    time.sleep(delay)
                else:
                    break

        error_msg = str(last_exception) if last_exception else "未知错误"
        return False, error_msg


class FailedTaskQueue:
    """
    失败任务队列管理
    用于记录失败的任务，支持持久化和恢复
    """

    FAILED_TASKS_FILE = os.path.join(BASE_PATH, "failed_tasks.json")
    _failed_tasks = []
    _lock = threading.Lock()

    @classmethod
    def add(cls, task_id: str, task_type: str, context: dict = None):
        """
        添加失败任务

        Args:
            task_id: 任务ID（如窗口ID、账号邮箱等）
            task_type: 任务类型（如 'sheerlink', 'bind_card' 等）
            context: 任务上下文信息
        """
        with cls._lock:
            task = {
                "id": task_id,
                "type": task_type,
                "context": context or {},
                "failed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                "retry_count": 0
            }

            # 检查是否已存在
            for i, t in enumerate(cls._failed_tasks):
                if t["id"] == task_id and t["type"] == task_type:
                    # 更新重试次数
                    cls._failed_tasks[i]["retry_count"] += 1
                    cls._failed_tasks[i]["failed_at"] = task["failed_at"]
                    return

            cls._failed_tasks.append(task)

    @classmethod
    def remove(cls, task_id: str, task_type: str = None):
        """移除任务（成功后调用）"""
        with cls._lock:
            cls._failed_tasks = [
                t for t in cls._failed_tasks
                if not (t["id"] == task_id and (task_type is None or t["type"] == task_type))
            ]

    @classmethod
    def get_all(cls, task_type: str = None) -> list:
        """获取所有失败任务"""
        with cls._lock:
            if task_type:
                return [t for t in cls._failed_tasks if t["type"] == task_type]
            return cls._failed_tasks.copy()

    @classmethod
    def get_ids(cls, task_type: str = None) -> list:
        """获取失败任务的ID列表"""
        return [t["id"] for t in cls.get_all(task_type)]

    @classmethod
    def count(cls, task_type: str = None) -> int:
        """获取失败任务数量"""
        return len(cls.get_all(task_type))

    @classmethod
    def clear(cls, task_type: str = None):
        """清空失败任务"""
        with cls._lock:
            if task_type:
                cls._failed_tasks = [t for t in cls._failed_tasks if t["type"] != task_type]
            else:
                cls._failed_tasks = []

    @classmethod
    def save(cls):
        """保存到文件"""
        with cls._lock:
            try:
                with open(cls.FAILED_TASKS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(cls._failed_tasks, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"[FailedTaskQueue] 保存失败: {e}")

    @classmethod
    def load(cls):
        """从文件加载"""
        with cls._lock:
            if os.path.exists(cls.FAILED_TASKS_FILE):
                try:
                    with open(cls.FAILED_TASKS_FILE, 'r', encoding='utf-8') as f:
                        cls._failed_tasks = json.load(f)
                except Exception as e:
                    print(f"[FailedTaskQueue] 加载失败: {e}")
                    cls._failed_tasks = []


def with_retry(
    max_retries: int = 3,
    base_delay: float = 2.0,
    backoff_factor: float = 2.0
):
    """
    重试装饰器（用于同步函数）

    用法:
        @with_retry(max_retries=3)
        def my_function():
            ...
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            helper = RetryHelper(
                max_retries=max_retries,
                base_delay=base_delay,
                backoff_factor=backoff_factor
            )
            success, result = helper.execute_sync(func, *args, **kwargs)
            if success:
                return result
            raise Exception(result)
        return wrapper
    return decorator


def with_retry_async(
    max_retries: int = 3,
    base_delay: float = 2.0,
    backoff_factor: float = 2.0
):
    """
    重试装饰器（用于异步函数）

    用法:
        @with_retry_async(max_retries=3)
        async def my_async_function():
            ...
    """
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            helper = RetryHelper(
                max_retries=max_retries,
                base_delay=base_delay,
                backoff_factor=backoff_factor
            )
            success, result = await helper.execute_async(func, *args, **kwargs)
            if success:
                return result
            raise Exception(result)
        return wrapper
    return decorator


# 初始化时加载失败任务
FailedTaskQueue.load()


if __name__ == '__main__':
    # 测试代码
    print("Testing RetryHelper...")

    # 测试同步重试
    attempt_count = 0

    def flaky_function():
        global attempt_count
        attempt_count += 1
        if attempt_count < 3:
            raise ConnectionError("Network error")
        return "Success!"

    helper = RetryHelper(max_retries=5, base_delay=0.5)
    success, result = helper.execute_sync(flaky_function)
    print(f"Sync test: success={success}, result={result}, attempts={attempt_count}")

    # 测试失败任务队列
    print("\nTesting FailedTaskQueue...")
    FailedTaskQueue.clear()
    FailedTaskQueue.add("task1", "sheerlink", {"email": "test@example.com"})
    FailedTaskQueue.add("task2", "bind_card")
    print(f"Failed tasks: {FailedTaskQueue.get_all()}")
    print(f"Count: {FailedTaskQueue.count()}")

    FailedTaskQueue.remove("task1", "sheerlink")
    print(f"After remove: {FailedTaskQueue.get_all()}")

    FailedTaskQueue.save()
    print("Saved to file")
