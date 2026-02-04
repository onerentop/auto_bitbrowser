"""
踢出设备界面 - Fluent Design 版本
AI 自动移除账号中的已登录设备
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal

from qfluentwidgets import FluentIcon as FIF

from gui.ai_task_interface import AITaskInterface
from automation.auto_kick_devices import auto_kick_devices


class KickDevicesWorker(QThread):
    """踢出设备工作线程"""
    progressSignal = pyqtSignal(str, str, str)
    finishedSignal = pyqtSignal()
    logSignal = pyqtSignal(str)

    def __init__(self, accounts: list, config: dict):
        super().__init__()
        self.accounts = accounts
        self.config = config
        self._shouldStop = False

    def stop(self):
        self._shouldStop = True

    def run(self):
        try:
            asyncio.run(self._run_task())
        except Exception as e:
            self.logSignal.emit(f"[错误] 任务异常: {e}")
        finally:
            self.finishedSignal.emit()

    async def _run_task(self):
        for acc in self.accounts:
            if self._shouldStop:
                break

            email = acc.get('email', '')
            profile_id = acc.get('profile_id', '')

            self.progressSignal.emit(email, "处理中", "正在踢出设备...")

            try:
                result = await auto_kick_devices(
                    profile_id=profile_id,
                    account_info=acc.get('account_info', {})
                )
                if result.get('success'):
                    self.progressSignal.emit(email, "成功", result.get('message', '设备已踢出'))
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '踢出失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class KickDevicesInterface(AITaskInterface):
    """踢出设备界面"""

    def __init__(self, parent=None):
        super().__init__('kickDevicesInterface', parent)

    def _getTaskName(self) -> str:
        return "踢出设备"

    def _getTaskIcon(self):
        return FIF.REMOVE_FROM

    def _getStatusFilter(self) -> list:
        # 所有状态的账号都可以踢出设备
        return []

    def _createTaskWorker(self, accounts: list, config: dict):
        return KickDevicesWorker(accounts, config)
