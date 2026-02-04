"""
获取 SheerLink 界面 - Fluent Design 版本
AI 自动获取 SheerID 验证链接
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal

from qfluentwidgets import FluentIcon as FIF

from gui.ai_task_interface import AITaskInterface
from automation.auto_get_sheerlink_ai import auto_get_sheerlink_ai


class GetSheerlinkWorker(QThread):
    """获取 SheerLink 工作线程"""
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

            self.progressSignal.emit(email, "处理中", "正在获取 SheerLink...")

            try:
                result = await auto_get_sheerlink_ai(
                    profile_id=profile_id,
                    account_info=acc.get('account_info', {})
                )
                if result.get('success'):
                    link = result.get('link', '')
                    self.progressSignal.emit(email, "成功", f"已获取链接: {link[:50]}...")
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '获取失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class GetSheerlinkInterface(AITaskInterface):
    """获取 SheerLink 界面"""

    def __init__(self, parent=None):
        super().__init__('sheerlinkInterface', parent)

    def _getTaskName(self) -> str:
        return "获取SheerLink"

    def _getTaskIcon(self):
        return FIF.LINK

    def _getStatusFilter(self) -> list:
        # 筛选 pending 或 link_ready 状态的账号
        return ['pending', 'link_ready']

    def _createTaskWorker(self, accounts: list, config: dict):
        return GetSheerlinkWorker(accounts, config)
