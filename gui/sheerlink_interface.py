"""
获取 SheerLink 界面 - Fluent Design 版本
AI 自动获取 SheerID 验证链接
"""
import asyncio
from PyQt6.QtCore import QThread, pyqtSignal

from qfluentwidgets import FluentIcon as FIF, CheckBox

from gui.ai_task_interface import AITaskInterface
from automation.auto_get_sheerlink_ai import auto_get_sheerlink_ai
from core.config_manager import ConfigManager


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
        # 获取 AI 配置
        provider = ConfigManager.get_ai_default_provider()
        provider_config = ConfigManager.get_ai_provider_config(provider)
        api_key = provider_config.get('api_key', '')
        base_url = provider_config.get('base_url', '')
        model = provider_config.get('model', '')

        # 获取关闭浏览器配置
        close_after = self.config.get('close_after', False)

        self.logSignal.emit(f"使用 AI 提供商: {provider}, 模型: {model}")
        if close_after:
            self.logSignal.emit("⚠️ 已启用: 完成后关闭浏览器")

        for acc in self.accounts:
            if self._shouldStop:
                break

            email = acc.get('email', '')
            profile_id = acc.get('profile_id', '')

            self.progressSignal.emit(email, "处理中", "正在获取 SheerLink...")

            try:
                # auto_get_sheerlink_ai 返回元组: (success, message, status, link)
                success, message, status, link = await auto_get_sheerlink_ai(
                    browser_id=str(profile_id),
                    account_info=acc.get('account_info', {}),
                    close_after=close_after,
                    api_key=api_key,
                    base_url=base_url if base_url else None,
                    model=model if model else None,
                    provider=provider,
                )
                if success:
                    link_display = link[:50] + "..." if link and len(link) > 50 else (link or "无链接")
                    self.progressSignal.emit(email, "成功", f"[{status}] {link_display}")
                else:
                    self.progressSignal.emit(email, "失败", f"[{status}] {message}")
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
        # 不限制状态，显示所有账号
        return []

    def _addExtraConfig(self, card, layout):
        """添加完成后关闭浏览器复选框"""
        self.closeAfterCheck = CheckBox("完成后关闭浏览器", card)
        self.closeAfterCheck.setChecked(False)
        layout.addWidget(self.closeAfterCheck)

    def _getTaskConfig(self) -> dict:
        config = super()._getTaskConfig()
        config['close_after'] = self.closeAfterCheck.isChecked()
        return config

    def _createTaskWorker(self, accounts: list, config: dict):
        return GetSheerlinkWorker(accounts, config)
