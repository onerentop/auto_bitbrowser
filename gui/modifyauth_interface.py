"""
修改身份验证器界面 - Fluent Design 版本
AI 自动修改 Google Authenticator
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal

from qfluentwidgets import FluentIcon as FIF

from gui.ai_task_interface import AITaskInterface
from automation.auto_modify_authenticator import auto_modify_authenticator


class ModifyAuthWorker(QThread):
    """修改身份验证器工作线程"""
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

            self.progressSignal.emit(email, "处理中", "正在修改身份验证器...")

            try:
                result = await auto_modify_authenticator(
                    profile_id=profile_id,
                    account_info=acc.get('account_info', {})
                )
                if result.get('success'):
                    new_secret = result.get('totp_secret', '')
                    msg = f"验证器已修改"
                    if new_secret:
                        msg += f" (新密钥: {new_secret[:8]}...)"
                    self.progressSignal.emit(email, "成功", msg)
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '修改失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class ModifyAuthInterface(AITaskInterface):
    """修改身份验证器界面"""

    def __init__(self, parent=None):
        super().__init__('modifyAuthInterface', parent)

    def _getTaskName(self) -> str:
        return "修改验证器"

    def _getTaskIcon(self):
        return FIF.VPN

    def _getStatusFilter(self) -> list:
        return []

    def _createTaskWorker(self, accounts: list, config: dict):
        return ModifyAuthWorker(accounts, config)
