"""
性能监控模块 - AI Browser Agent V2

提供运行时性能指标收集和分析：
- 步骤执行时间统计
- LLM API 调用延迟
- SoM 元素提取性能
- 内存使用追踪
- 性能报告生成
"""

import time
import statistics
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
from collections import deque
from datetime import datetime
import logging

logger = logging.getLogger("ai_browser_agent.performance")


@dataclass
class TimingMetric:
    """单项计时指标"""
    name: str
    samples: deque = field(default_factory=lambda: deque(maxlen=100))
    total_time_ms: float = 0.0
    count: int = 0
    min_time_ms: float = float("inf")
    max_time_ms: float = 0.0

    def record(self, duration_ms: float):
        """记录一次计时"""
        self.samples.append(duration_ms)
        self.total_time_ms += duration_ms
        self.count += 1
        self.min_time_ms = min(self.min_time_ms, duration_ms)
        self.max_time_ms = max(self.max_time_ms, duration_ms)

    @property
    def avg_time_ms(self) -> float:
        """平均时间"""
        if self.count == 0:
            return 0.0
        return self.total_time_ms / self.count

    @property
    def p50_time_ms(self) -> float:
        """50 分位时间"""
        if len(self.samples) == 0:
            return 0.0
        sorted_samples = sorted(self.samples)
        return sorted_samples[len(sorted_samples) // 2]

    @property
    def p95_time_ms(self) -> float:
        """95 分位时间"""
        if len(self.samples) == 0:
            return 0.0
        sorted_samples = sorted(self.samples)
        idx = int(len(sorted_samples) * 0.95)
        return sorted_samples[min(idx, len(sorted_samples) - 1)]

    @property
    def std_dev_ms(self) -> float:
        """标准差"""
        if len(self.samples) < 2:
            return 0.0
        return statistics.stdev(self.samples)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "count": self.count,
            "total_time_ms": round(self.total_time_ms, 2),
            "avg_time_ms": round(self.avg_time_ms, 2),
            "min_time_ms": round(self.min_time_ms, 2) if self.min_time_ms != float("inf") else 0,
            "max_time_ms": round(self.max_time_ms, 2),
            "p50_time_ms": round(self.p50_time_ms, 2),
            "p95_time_ms": round(self.p95_time_ms, 2),
            "std_dev_ms": round(self.std_dev_ms, 2),
        }


@dataclass
class PerformanceSnapshot:
    """性能快照"""
    timestamp: datetime = field(default_factory=datetime.now)
    step_number: int = 0
    metrics: Dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "step_number": self.step_number,
            "metrics": self.metrics,
        }


class PerformanceMonitor:
    """
    性能监控器

    追踪 Agent 运行时的各项性能指标
    """

    # 预定义的指标名称
    METRIC_STEP_TOTAL = "step_total"
    METRIC_LLM_CALL = "llm_call"
    METRIC_SCREENSHOT = "screenshot"
    METRIC_SOM_EXTRACTION = "som_extraction"
    METRIC_ACTION_EXECUTION = "action_execution"
    METRIC_PAGE_WAIT = "page_wait"

    def __init__(
        self,
        max_snapshots: int = 50,
        enable_detailed: bool = True,
    ):
        """
        初始化性能监控器

        Args:
            max_snapshots: 保留的最大快照数
            enable_detailed: 是否启用详细记录
        """
        self.max_snapshots = max_snapshots
        self.enable_detailed = enable_detailed

        # 计时指标
        self._metrics: Dict[str, TimingMetric] = {}

        # 快照历史
        self._snapshots: deque = deque(maxlen=max_snapshots)

        # 会话统计
        self._session_start: Optional[float] = None
        self._session_end: Optional[float] = None
        self._total_steps: int = 0
        self._successful_steps: int = 0
        self._failed_steps: int = 0

        # 当前计时器（用于嵌套计时）
        self._active_timers: Dict[str, float] = {}

        # 初始化预定义指标
        for metric_name in [
            self.METRIC_STEP_TOTAL,
            self.METRIC_LLM_CALL,
            self.METRIC_SCREENSHOT,
            self.METRIC_SOM_EXTRACTION,
            self.METRIC_ACTION_EXECUTION,
            self.METRIC_PAGE_WAIT,
        ]:
            self._metrics[metric_name] = TimingMetric(name=metric_name)

    def start_session(self):
        """开始新会话"""
        self._session_start = time.time()
        self._session_end = None
        self._total_steps = 0
        self._successful_steps = 0
        self._failed_steps = 0
        self._snapshots.clear()
        logger.debug("性能监控会话已启动")

    def end_session(self):
        """结束会话"""
        self._session_end = time.time()
        logger.debug(f"性能监控会话结束，总步数: {self._total_steps}")

    def start_timer(self, metric_name: str) -> float:
        """
        开始计时器

        Args:
            metric_name: 指标名称

        Returns:
            开始时间戳
        """
        start_time = time.time()
        self._active_timers[metric_name] = start_time
        return start_time

    def stop_timer(self, metric_name: str) -> float:
        """
        停止计时器并记录

        Args:
            metric_name: 指标名称

        Returns:
            持续时间（毫秒）
        """
        end_time = time.time()
        start_time = self._active_timers.pop(metric_name, end_time)
        duration_ms = (end_time - start_time) * 1000
        self.record_timing(metric_name, duration_ms)
        return duration_ms

    def record_timing(self, metric_name: str, duration_ms: float):
        """
        记录计时

        Args:
            metric_name: 指标名称
            duration_ms: 持续时间（毫秒）
        """
        if metric_name not in self._metrics:
            self._metrics[metric_name] = TimingMetric(name=metric_name)
        self._metrics[metric_name].record(duration_ms)

        if self.enable_detailed:
            logger.debug(f"[性能] {metric_name}: {duration_ms:.1f}ms")

    def record_step(self, success: bool, duration_ms: float, step_number: int):
        """
        记录步骤完成

        Args:
            success: 是否成功
            duration_ms: 步骤持续时间
            step_number: 步骤编号
        """
        self._total_steps += 1
        if success:
            self._successful_steps += 1
        else:
            self._failed_steps += 1

        self.record_timing(self.METRIC_STEP_TOTAL, duration_ms)

        # 创建快照
        snapshot = PerformanceSnapshot(
            step_number=step_number,
            metrics={
                "step_duration_ms": duration_ms,
                "success": 1 if success else 0,
            }
        )
        self._snapshots.append(snapshot)

    def record_llm_call(self, duration_ms: float, tokens_used: int = 0):
        """记录 LLM 调用"""
        self.record_timing(self.METRIC_LLM_CALL, duration_ms)
        if tokens_used > 0:
            self.record_timing("llm_tokens", tokens_used)

    def record_screenshot(self, duration_ms: float, size_bytes: int = 0):
        """记录截图操作"""
        self.record_timing(self.METRIC_SCREENSHOT, duration_ms)
        if size_bytes > 0:
            self.record_timing("screenshot_size_kb", size_bytes / 1024)

    def record_som_extraction(self, duration_ms: float, elements_count: int = 0):
        """记录 SoM 元素提取"""
        self.record_timing(self.METRIC_SOM_EXTRACTION, duration_ms)
        if elements_count > 0:
            self.record_timing("som_elements", elements_count)

    def record_action_execution(self, action_type: str, duration_ms: float, success: bool):
        """记录动作执行"""
        self.record_timing(self.METRIC_ACTION_EXECUTION, duration_ms)
        self.record_timing(f"action_{action_type.lower()}", duration_ms)

    def get_metric(self, metric_name: str) -> Optional[TimingMetric]:
        """获取指定指标"""
        return self._metrics.get(metric_name)

    def get_all_metrics(self) -> Dict[str, dict]:
        """获取所有指标"""
        return {name: metric.to_dict() for name, metric in self._metrics.items()}

    @property
    def session_duration_seconds(self) -> float:
        """会话持续时间（秒）"""
        if self._session_start is None:
            return 0.0
        end = self._session_end or time.time()
        return end - self._session_start

    @property
    def success_rate(self) -> float:
        """成功率"""
        if self._total_steps == 0:
            return 0.0
        return self._successful_steps / self._total_steps

    @property
    def steps_per_minute(self) -> float:
        """每分钟步骤数"""
        duration = self.session_duration_seconds
        if duration == 0:
            return 0.0
        return (self._total_steps / duration) * 60

    def get_summary(self) -> Dict[str, Any]:
        """
        获取性能摘要

        Returns:
            性能摘要字典
        """
        step_metric = self._metrics.get(self.METRIC_STEP_TOTAL)
        llm_metric = self._metrics.get(self.METRIC_LLM_CALL)
        som_metric = self._metrics.get(self.METRIC_SOM_EXTRACTION)

        return {
            "session": {
                "duration_seconds": round(self.session_duration_seconds, 2),
                "total_steps": self._total_steps,
                "successful_steps": self._successful_steps,
                "failed_steps": self._failed_steps,
                "success_rate": round(self.success_rate * 100, 1),
                "steps_per_minute": round(self.steps_per_minute, 2),
            },
            "step_timing": step_metric.to_dict() if step_metric else {},
            "llm_timing": llm_metric.to_dict() if llm_metric else {},
            "som_timing": som_metric.to_dict() if som_metric else {},
            "all_metrics": {
                name: metric.to_dict()
                for name, metric in self._metrics.items()
                if metric.count > 0
            },
        }

    def get_report(self) -> str:
        """
        生成性能报告（文本格式）

        Returns:
            格式化的性能报告
        """
        summary = self.get_summary()
        session = summary["session"]

        lines = [
            "=" * 50,
            "AI Browser Agent 性能报告",
            "=" * 50,
            "",
            "【会话统计】",
            f"  持续时间: {session['duration_seconds']:.1f}s",
            f"  总步骤: {session['total_steps']} (成功: {session['successful_steps']}, 失败: {session['failed_steps']})",
            f"  成功率: {session['success_rate']:.1f}%",
            f"  执行速度: {session['steps_per_minute']:.1f} 步/分钟",
            "",
        ]

        # 步骤计时
        if summary["step_timing"]:
            step = summary["step_timing"]
            lines.extend([
                "【步骤执行时间】",
                f"  平均: {step['avg_time_ms']:.0f}ms",
                f"  最小/最大: {step['min_time_ms']:.0f}ms / {step['max_time_ms']:.0f}ms",
                f"  P50/P95: {step['p50_time_ms']:.0f}ms / {step['p95_time_ms']:.0f}ms",
                "",
            ])

        # LLM 计时
        if summary["llm_timing"]:
            llm = summary["llm_timing"]
            lines.extend([
                "【LLM 调用时间】",
                f"  调用次数: {llm['count']}",
                f"  平均: {llm['avg_time_ms']:.0f}ms",
                f"  P95: {llm['p95_time_ms']:.0f}ms",
                "",
            ])

        # SoM 计时
        if summary["som_timing"]:
            som = summary["som_timing"]
            lines.extend([
                "【SoM 提取时间】",
                f"  提取次数: {som['count']}",
                f"  平均: {som['avg_time_ms']:.0f}ms",
                f"  P95: {som['p95_time_ms']:.0f}ms",
                "",
            ])

        lines.append("=" * 50)
        return "\n".join(lines)

    def reset(self):
        """重置所有指标"""
        for metric in self._metrics.values():
            metric.samples.clear()
            metric.total_time_ms = 0.0
            metric.count = 0
            metric.min_time_ms = float("inf")
            metric.max_time_ms = 0.0
        self._snapshots.clear()
        self._session_start = None
        self._session_end = None
        self._total_steps = 0
        self._successful_steps = 0
        self._failed_steps = 0


# ============ 全局实例和便捷函数 ============

_global_monitor: Optional[PerformanceMonitor] = None


def get_performance_monitor() -> PerformanceMonitor:
    """获取全局性能监控器"""
    global _global_monitor
    if _global_monitor is None:
        _global_monitor = PerformanceMonitor()
    return _global_monitor


def create_performance_monitor(**kwargs) -> PerformanceMonitor:
    """创建新的性能监控器"""
    return PerformanceMonitor(**kwargs)


class Timer:
    """
    计时器上下文管理器

    Usage:
        with Timer(monitor, "llm_call") as t:
            result = await llm.call()
        print(f"Duration: {t.duration_ms}ms")
    """

    def __init__(self, monitor: PerformanceMonitor, metric_name: str):
        self.monitor = monitor
        self.metric_name = metric_name
        self.start_time: float = 0.0
        self.duration_ms: float = 0.0

    def __enter__(self) -> "Timer":
        self.start_time = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.duration_ms = (time.time() - self.start_time) * 1000
        self.monitor.record_timing(self.metric_name, self.duration_ms)
        return False


class AsyncTimer:
    """
    异步计时器上下文管理器

    Usage:
        async with AsyncTimer(monitor, "llm_call") as t:
            result = await llm.call()
        print(f"Duration: {t.duration_ms}ms")
    """

    def __init__(self, monitor: PerformanceMonitor, metric_name: str):
        self.monitor = monitor
        self.metric_name = metric_name
        self.start_time: float = 0.0
        self.duration_ms: float = 0.0

    async def __aenter__(self) -> "AsyncTimer":
        self.start_time = time.time()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.duration_ms = (time.time() - self.start_time) * 1000
        self.monitor.record_timing(self.metric_name, self.duration_ms)
        return False
