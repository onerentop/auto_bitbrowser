"""
Watchdog 监控系统模块

提供：
- Agent 崩溃检测和恢复
- 网络超时监控
- 页面卡死检测
- 资源使用监控

参考 browser-use 的 crash watchdog 设计
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Optional, Callable, Any, Dict, List
from datetime import datetime, timedelta
from enum import Enum

logger = logging.getLogger("ai_browser_agent.watchdog")


class WatchdogEvent(str, Enum):
    """Watchdog 事件类型"""
    TIMEOUT = "timeout"
    CRASH = "crash"
    HANG = "hang"
    NETWORK_ERROR = "network_error"
    RECOVERY = "recovery"
    WARNING = "warning"


@dataclass
class WatchdogAlert:
    """Watchdog 告警"""
    event: WatchdogEvent
    message: str
    timestamp: datetime = field(default_factory=datetime.now)
    details: Dict[str, Any] = field(default_factory=dict)
    severity: str = "warning"  # "info", "warning", "error", "critical"

    def to_dict(self) -> dict:
        return {
            "event": self.event.value,
            "message": self.message,
            "timestamp": self.timestamp.isoformat(),
            "details": self.details,
            "severity": self.severity,
        }


class StepWatchdog:
    """
    步骤级 Watchdog

    监控单个步骤的执行，检测超时和卡死
    """

    def __init__(
        self,
        timeout_seconds: float = 120.0,
        warning_threshold: float = 60.0,
        on_timeout: Optional[Callable[[WatchdogAlert], None]] = None,
        on_warning: Optional[Callable[[WatchdogAlert], None]] = None,
    ):
        """
        初始化步骤 Watchdog

        Args:
            timeout_seconds: 超时时间（秒）
            warning_threshold: 警告阈值（秒）
            on_timeout: 超时回调
            on_warning: 警告回调
        """
        self.timeout_seconds = timeout_seconds
        self.warning_threshold = warning_threshold
        self.on_timeout = on_timeout
        self.on_warning = on_warning

        self._start_time: Optional[float] = None
        self._step_number: int = 0
        self._is_active: bool = False
        self._warning_sent: bool = False
        self._task: Optional[asyncio.Task] = None

    def start(self, step_number: int = 0):
        """开始监控步骤"""
        self._start_time = time.time()
        self._step_number = step_number
        self._is_active = True
        self._warning_sent = False

    def stop(self):
        """停止监控"""
        self._is_active = False
        self._start_time = None
        if self._task and not self._task.done():
            self._task.cancel()

    def check(self) -> Optional[WatchdogAlert]:
        """
        检查当前状态

        Returns:
            WatchdogAlert 如果检测到问题，否则 None
        """
        if not self._is_active or self._start_time is None:
            return None

        elapsed = time.time() - self._start_time

        # 检查超时
        if elapsed >= self.timeout_seconds:
            alert = WatchdogAlert(
                event=WatchdogEvent.TIMEOUT,
                message=f"步骤 {self._step_number} 超时 ({elapsed:.1f}s >= {self.timeout_seconds}s)",
                details={"step": self._step_number, "elapsed": elapsed},
                severity="error"
            )
            if self.on_timeout:
                self.on_timeout(alert)
            return alert

        # 检查警告阈值
        if elapsed >= self.warning_threshold and not self._warning_sent:
            self._warning_sent = True
            alert = WatchdogAlert(
                event=WatchdogEvent.WARNING,
                message=f"步骤 {self._step_number} 执行时间较长 ({elapsed:.1f}s)",
                details={"step": self._step_number, "elapsed": elapsed},
                severity="warning"
            )
            if self.on_warning:
                self.on_warning(alert)
            return alert

        return None

    @property
    def elapsed_seconds(self) -> float:
        """已用时间（秒）"""
        if self._start_time is None:
            return 0.0
        return time.time() - self._start_time

    @property
    def is_active(self) -> bool:
        return self._is_active


class NetworkWatchdog:
    """
    网络 Watchdog

    监控网络请求，检测超时和错误
    """

    def __init__(
        self,
        request_timeout: float = 30.0,
        max_pending_requests: int = 50,
        on_network_error: Optional[Callable[[WatchdogAlert], None]] = None,
    ):
        """
        初始化网络 Watchdog

        Args:
            request_timeout: 单个请求超时时间（秒）
            max_pending_requests: 最大挂起请求数
            on_network_error: 网络错误回调
        """
        self.request_timeout = request_timeout
        self.max_pending_requests = max_pending_requests
        self.on_network_error = on_network_error

        self._pending_requests: Dict[str, float] = {}  # url -> start_time
        self._failed_requests: List[Dict] = []
        self._is_active: bool = False

    def start(self):
        """开始监控"""
        self._is_active = True
        self._pending_requests.clear()
        self._failed_requests.clear()

    def stop(self):
        """停止监控"""
        self._is_active = False

    def on_request_start(self, url: str):
        """记录请求开始"""
        if self._is_active:
            self._pending_requests[url] = time.time()

    def on_request_end(self, url: str, success: bool = True, error: str = None):
        """记录请求结束"""
        if url in self._pending_requests:
            start_time = self._pending_requests.pop(url)
            if not success:
                self._failed_requests.append({
                    "url": url,
                    "duration": time.time() - start_time,
                    "error": error,
                    "timestamp": datetime.now().isoformat()
                })

    def check(self) -> Optional[WatchdogAlert]:
        """
        检查网络状态

        Returns:
            WatchdogAlert 如果检测到问题
        """
        if not self._is_active:
            return None

        current_time = time.time()
        timeout_requests = []

        for url, start_time in list(self._pending_requests.items()):
            if current_time - start_time > self.request_timeout:
                timeout_requests.append(url)
                self._pending_requests.pop(url)
                self._failed_requests.append({
                    "url": url,
                    "duration": current_time - start_time,
                    "error": "timeout",
                    "timestamp": datetime.now().isoformat()
                })

        if timeout_requests:
            alert = WatchdogAlert(
                event=WatchdogEvent.NETWORK_ERROR,
                message=f"{len(timeout_requests)} 个请求超时",
                details={"timeout_urls": timeout_requests[:5]},  # 只显示前 5 个
                severity="warning"
            )
            if self.on_network_error:
                self.on_network_error(alert)
            return alert

        # 检查挂起请求数
        if len(self._pending_requests) > self.max_pending_requests:
            return WatchdogAlert(
                event=WatchdogEvent.WARNING,
                message=f"挂起请求过多: {len(self._pending_requests)}",
                details={"pending_count": len(self._pending_requests)},
                severity="warning"
            )

        return None

    @property
    def pending_count(self) -> int:
        return len(self._pending_requests)

    @property
    def failed_count(self) -> int:
        return len(self._failed_requests)


class AgentWatchdog:
    """
    Agent 级 Watchdog

    综合监控 Agent 运行状态，包含步骤和网络监控
    """

    def __init__(
        self,
        step_timeout: float = 120.0,
        max_consecutive_failures: int = 5,
        health_check_interval: float = 5.0,
        on_alert: Optional[Callable[[WatchdogAlert], None]] = None,
    ):
        """
        初始化 Agent Watchdog

        Args:
            step_timeout: 步骤超时时间（秒）
            max_consecutive_failures: 最大连续失败次数
            health_check_interval: 健康检查间隔（秒）
            on_alert: 告警回调
        """
        self.step_timeout = step_timeout
        self.max_consecutive_failures = max_consecutive_failures
        self.health_check_interval = health_check_interval
        self.on_alert = on_alert

        self.step_watchdog = StepWatchdog(
            timeout_seconds=step_timeout,
            on_timeout=self._handle_step_timeout,
            on_warning=self._handle_step_warning,
        )

        self.network_watchdog = NetworkWatchdog(
            on_network_error=self._handle_network_error,
        )

        self._alerts: List[WatchdogAlert] = []
        self._is_running: bool = False
        self._health_task: Optional[asyncio.Task] = None
        self._consecutive_failures: int = 0
        self._last_heartbeat: float = 0.0

    def start(self):
        """启动 Watchdog"""
        self._is_running = True
        self._alerts.clear()
        self._consecutive_failures = 0
        self._last_heartbeat = time.time()
        self.network_watchdog.start()

    def stop(self):
        """停止 Watchdog"""
        self._is_running = False
        self.step_watchdog.stop()
        self.network_watchdog.stop()
        if self._health_task and not self._health_task.done():
            self._health_task.cancel()

    def heartbeat(self):
        """发送心跳"""
        self._last_heartbeat = time.time()

    def start_step(self, step_number: int):
        """开始监控步骤"""
        self.step_watchdog.start(step_number)
        self.heartbeat()

    def end_step(self, success: bool = True):
        """结束步骤监控"""
        self.step_watchdog.stop()
        if success:
            self._consecutive_failures = 0
        else:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self.max_consecutive_failures:
                self._add_alert(WatchdogAlert(
                    event=WatchdogEvent.CRASH,
                    message=f"连续失败 {self._consecutive_failures} 次",
                    severity="critical"
                ))
        self.heartbeat()

    def _handle_step_timeout(self, alert: WatchdogAlert):
        """处理步骤超时"""
        self._add_alert(alert)

    def _handle_step_warning(self, alert: WatchdogAlert):
        """处理步骤警告"""
        self._add_alert(alert)

    def _handle_network_error(self, alert: WatchdogAlert):
        """处理网络错误"""
        self._add_alert(alert)

    def _add_alert(self, alert: WatchdogAlert):
        """添加告警"""
        self._alerts.append(alert)
        logger.warning(f"[Watchdog] {alert.event.value}: {alert.message}")
        if self.on_alert:
            self.on_alert(alert)

    def check_health(self) -> Dict[str, Any]:
        """
        检查健康状态

        Returns:
            健康状态报告
        """
        # 检查步骤状态
        step_alert = self.step_watchdog.check()
        if step_alert:
            self._add_alert(step_alert)

        # 检查网络状态
        network_alert = self.network_watchdog.check()
        if network_alert:
            self._add_alert(network_alert)

        # 检查心跳
        time_since_heartbeat = time.time() - self._last_heartbeat
        is_responsive = time_since_heartbeat < self.health_check_interval * 3

        return {
            "is_running": self._is_running,
            "is_responsive": is_responsive,
            "consecutive_failures": self._consecutive_failures,
            "pending_requests": self.network_watchdog.pending_count,
            "failed_requests": self.network_watchdog.failed_count,
            "alert_count": len(self._alerts),
            "time_since_heartbeat": time_since_heartbeat,
        }

    def get_alerts(self, limit: int = 10) -> List[WatchdogAlert]:
        """获取最近的告警"""
        return self._alerts[-limit:]

    def clear_alerts(self):
        """清空告警"""
        self._alerts.clear()

    @property
    def is_healthy(self) -> bool:
        """是否健康"""
        health = self.check_health()
        return (
            health["is_responsive"] and
            health["consecutive_failures"] < self.max_consecutive_failures
        )


# ============ 便捷函数 ============

def create_agent_watchdog(
    step_timeout: float = 120.0,
    on_alert: Callable[[WatchdogAlert], None] = None
) -> AgentWatchdog:
    """创建 Agent Watchdog"""
    return AgentWatchdog(
        step_timeout=step_timeout,
        on_alert=on_alert
    )
