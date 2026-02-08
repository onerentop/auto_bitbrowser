"""
替换辅助邮箱界面 - Fluent Design 版本
AI 自动替换账号的辅助邮箱
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import QHBoxLayout

from qfluentwidgets import FluentIcon as FIF, LineEdit, BodyLabel

from gui.ai_task_interface import AITaskInterface
from application.automation_engine_adapter import AutomationEngineAdapter


class ReplaceEmailWorker(QThread):
    """替换辅助邮箱工作线程"""
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
        new_email = self.config.get('new_email', '')

        for acc in self.accounts:
            if self._shouldStop:
                break

            email = acc.get('email', '')
            profile_id = acc.get('profile_id', '')

            self.progressSignal.emit(email, "处理中", "正在替换辅助邮箱...")

            try:
                result = await AutomationEngineAdapter.run_replace_email(
                    profile_id=profile_id,
                    account_info=acc.get('account_info', {}),
                    new_email=new_email
                )
                if result.get('success'):
                    self.progressSignal.emit(email, "成功", result.get('message', '辅助邮箱已替换'))
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '替换失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class ReplaceEmailInterface(AITaskInterface):
    """替换辅助邮箱界面"""

    def __init__(self, parent=None):
        super().__init__('replaceEmailInterface', parent)

    def _getTaskName(self) -> str:
        return "替换辅助邮箱"

    def _getTaskIcon(self):
        return FIF.MAIL

    def _getStatusFilter(self) -> list:
        return []

    def _addExtraConfig(self, card, layout):
        """添加新邮箱输入"""
        emailLayout = QHBoxLayout()
        emailLayout.addWidget(BodyLabel("新辅助邮箱:", card))
        self.newEmailInput = LineEdit(card)
        self.newEmailInput.setPlaceholderText("请输入新辅助邮箱（可选，留空则移除）")
        self.newEmailInput.setFixedWidth(250)
        emailLayout.addWidget(self.newEmailInput)
        emailLayout.addStretch()
        layout.addLayout(emailLayout)

    def _getTaskConfig(self) -> dict:
        config = super()._getTaskConfig()
        config['new_email'] = self.newEmailInput.text().strip()
        return config

    def _createTaskWorker(self, accounts: list, config: dict):
        return ReplaceEmailWorker(accounts, config)
