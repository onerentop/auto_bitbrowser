"""
修改 2SV 手机界面 - Fluent Design 版本
AI 自动修改两步验证手机号
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import QHBoxLayout

from qfluentwidgets import FluentIcon as FIF, LineEdit, BodyLabel

from gui.ai_task_interface import AITaskInterface
from application.automation_engine_adapter import AutomationEngineAdapter


class Modify2SVWorker(QThread):
    """修改 2SV 手机工作线程"""
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
        new_phone = self.config.get('new_phone', '')

        for acc in self.accounts:
            if self._shouldStop:
                break

            email = acc.get('email', '')
            profile_id = acc.get('profile_id', '')

            self.progressSignal.emit(email, "处理中", "正在修改 2SV 手机...")

            try:
                result = await AutomationEngineAdapter.run_modify_2sv_phone(
                    profile_id=profile_id,
                    account_info=acc.get('account_info', {}),
                    new_phone=new_phone
                )
                if result.get('success'):
                    self.progressSignal.emit(email, "成功", result.get('message', '2SV 手机已修改'))
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '修改失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class Modify2SVInterface(AITaskInterface):
    """修改 2SV 手机界面"""

    def __init__(self, parent=None):
        super().__init__('modify2svInterface', parent)

    def _getTaskName(self) -> str:
        return "修改2SV手机"

    def _getTaskIcon(self):
        return FIF.FINGERPRINT

    def _getStatusFilter(self) -> list:
        return []

    def _addExtraConfig(self, card, layout):
        """添加新手机号输入"""
        phoneLayout = QHBoxLayout()
        phoneLayout.addWidget(BodyLabel("新 2SV 手机:", card))
        self.newPhoneInput = LineEdit(card)
        self.newPhoneInput.setPlaceholderText("请输入新的两步验证手机号")
        self.newPhoneInput.setFixedWidth(250)
        phoneLayout.addWidget(self.newPhoneInput)
        phoneLayout.addStretch()
        layout.addLayout(phoneLayout)

    def _getTaskConfig(self) -> dict:
        config = super()._getTaskConfig()
        config['new_phone'] = self.newPhoneInput.text().strip()
        return config

    def _createTaskWorker(self, accounts: list, config: dict):
        return Modify2SVWorker(accounts, config)
