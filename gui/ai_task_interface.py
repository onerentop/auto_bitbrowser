"""
AI 任务界面基类 - Fluent Design 版本
为 AI Agent 自动化任务提供通用界面模板
"""
import asyncio
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QAbstractItemView, QTreeWidgetItem,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    CardWidget, PushButton, PrimaryPushButton, SpinBox, CheckBox,
    TreeWidget, SubtitleLabel, BodyLabel, CaptionLabel,
    FluentIcon as FIF,
)

from gui.base_interface import BaseDialogInterface
from gui.fluent_utils import show_success, show_error, show_warning

from services.ix_api import get_group_list
from services.ix_window import get_browser_list
from services.database import DBManager
from core.config_manager import ConfigManager


class AITaskLoadWorker(QThread):
    """加载数据的通用工作线程"""
    progressSignal = pyqtSignal(int, int, str)
    finishedSignal = pyqtSignal(dict)
    logSignal = pyqtSignal(str)

    def __init__(self, status_filter: list = None):
        super().__init__()
        self._shouldStop = False
        self.status_filter = status_filter or []

    def stop(self):
        self._shouldStop = True

    def run(self):
        try:
            result = {
                'browsers': [],
                'groups': {},
                'accounts': {},
            }

            # 获取数据库账号
            self.progressSignal.emit(1, 3, "正在读取数据库...")
            if self._shouldStop:
                return
            db_accounts = DBManager.get_all_accounts() or []
            result['accounts'] = {acc['email']: acc for acc in db_accounts}

            # 获取分组列表
            self.progressSignal.emit(2, 3, "正在获取分组列表...")
            if self._shouldStop:
                return
            all_groups = get_group_list() or []
            for g in all_groups:
                gid = g.get('id')
                title = g.get('title', '')
                clean_title = ''.join(c for c in str(title) if c.isprintable())
                if not clean_title:
                    clean_title = f"分组 {gid}"
                result['groups'][gid] = clean_title
            result['groups'][0] = "未分组"

            # 获取浏览器列表
            self.progressSignal.emit(3, 3, "正在获取窗口列表...")
            if self._shouldStop:
                return
            result['browsers'] = get_browser_list() or []

            self.finishedSignal.emit(result)

        except Exception as e:
            self.logSignal.emit(f"[错误] 加载数据失败: {e}")
            self.finishedSignal.emit({
                'browsers': [],
                'groups': {},
                'accounts': {},
                'error': str(e)
            })


class AITaskInterface(BaseDialogInterface):
    """
    AI 任务界面基类 - Fluent 版本

    提供通用的 AI 自动化任务界面模板，子类需要实现：
    - _getTaskName(): 返回任务名称
    - _getTaskIcon(): 返回任务图标
    - _getStatusFilter(): 返回要筛选的账号状态列表
    - _createTaskWorker(accounts, config): 创建任务工作线程
    - _getTaskConfig(): 获取任务配置
    """

    def __init__(self, object_name: str, parent=None):
        super().__init__(object_name, parent)

        self.loadWorker = None
        self.taskWorker = None
        self._browsers = []
        self._groups = {}
        self._accounts = {}

        self._initUI()

    def _getTaskName(self) -> str:
        """返回任务名称，子类重写"""
        return "AI 任务"

    def _getTaskIcon(self):
        """返回任务图标，子类重写"""
        return FIF.ROBOT

    def _getStatusFilter(self) -> list:
        """返回要筛选的账号状态列表，子类重写"""
        return []

    def _createTaskWorker(self, accounts: list, config: dict):
        """创建任务工作线程，子类重写"""
        return None

    def _getTaskConfig(self) -> dict:
        """获取任务配置，子类重写"""
        return {
            'concurrent': self.concurrentSpin.value(),
        }

    def _initUI(self):
        """初始化界面"""
        # ===== 配置卡片 =====
        configCard = CardWidget(self)
        configLayout = QVBoxLayout(configCard)
        configLayout.setContentsMargins(20, 15, 20, 15)
        configLayout.setSpacing(10)

        configTitle = SubtitleLabel(f"{self._getTaskName()} 配置", configCard)
        configLayout.addWidget(configTitle)

        # 并发数
        concurrentLayout = QHBoxLayout()
        concurrentLayout.addWidget(BodyLabel("并发数:", configCard))
        self.concurrentSpin = SpinBox(configCard)
        self.concurrentSpin.setRange(1, 10)
        self.concurrentSpin.setValue(1)
        self.concurrentSpin.setFixedWidth(100)
        concurrentLayout.addWidget(self.concurrentSpin)
        concurrentLayout.addStretch()
        configLayout.addLayout(concurrentLayout)

        # 子类可以在这里添加更多配置
        self._addExtraConfig(configCard, configLayout)

        self.mainLayout.addWidget(configCard)

        # ===== 操作按钮 =====
        actionLayout = QHBoxLayout()
        actionLayout.setSpacing(10)

        self.loadBtn = PushButton(FIF.DOWNLOAD, "加载数据", self)
        self.loadBtn.setFixedHeight(36)
        self.loadBtn.clicked.connect(self._loadData)
        actionLayout.addWidget(self.loadBtn)

        self.startBtn = PrimaryPushButton(self._getTaskIcon(), f"开始{self._getTaskName()}", self)
        self.startBtn.setFixedHeight(36)
        self.startBtn.clicked.connect(self._onStartClicked)
        actionLayout.addWidget(self.startBtn)

        self.stopBtn = PushButton(FIF.PAUSE, "停止", self)
        self.stopBtn.setFixedHeight(36)
        self.stopBtn.setEnabled(False)
        self.stopBtn.clicked.connect(self._onStopClicked)
        actionLayout.addWidget(self.stopBtn)

        actionLayout.addStretch()

        self.statsLabel = CaptionLabel("", self)
        actionLayout.addWidget(self.statsLabel)

        self.mainLayout.addLayout(actionLayout)

        # ===== 账号树形列表 =====
        listCard = CardWidget(self)
        listLayout = QVBoxLayout(listCard)
        listLayout.setContentsMargins(10, 10, 10, 10)

        self.tree = TreeWidget(listCard)
        self.tree.setHeaderLabels(["选择", "名称/邮箱", "窗口ID", "状态", "消息"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 250)
        self.tree.setColumnWidth(2, 100)
        self.tree.setColumnWidth(3, 80)
        self.tree.header().setStretchLastSection(True)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setRootIsDecorated(True)

        listLayout.addWidget(self.tree)
        self.mainLayout.addWidget(listCard, 1)

        # 进度条
        self.addProgressBar()

        # 日志区
        self.addLogArea()

    def _addExtraConfig(self, card, layout):
        """子类可以重写此方法添加额外配置"""
        pass

    def _loadData(self):
        """加载数据"""
        self.tree.clear()
        self.log("正在加载数据...")

        if self.loadWorker is not None and self.loadWorker.isRunning():
            self.loadWorker.stop()
            self.loadWorker.wait(1000)

        self.loadWorker = AITaskLoadWorker(self._getStatusFilter())
        self.loadWorker.progressSignal.connect(self._onLoadProgress)
        self.loadWorker.finishedSignal.connect(self._onLoadFinished)
        self.loadWorker.logSignal.connect(self.log)
        self.loadWorker.start()

    def _onLoadProgress(self, current: int, total: int, message: str):
        if total > 0:
            pct = int(current / total * 100)
            self.setProgress(pct)
        self.log(message)

    def _onLoadFinished(self, result: dict):
        try:
            self._browsers = result.get('browsers', [])
            self._groups = result.get('groups', {})
            self._accounts = result.get('accounts', {})

            if result.get('error'):
                self.log(f"⚠️ 加载数据时发生错误: {result.get('error')}")
                return

            self._populateTree()

        except Exception as e:
            self.log(f"❌ 处理加载结果失败: {e}")
        finally:
            self.setProgress(100)

    def _populateTree(self):
        """填充树形控件"""
        status_filter = self._getStatusFilter()

        grouped = {}
        for b in self._browsers:
            gid = b.get('group_id', 0) or 0
            if gid not in grouped:
                grouped[gid] = []
            grouped[gid].append(b)

        total_count = 0
        for gid in sorted(grouped.keys()):
            browser_list = grouped[gid]
            group_name = self._groups.get(gid, f"分组 {gid}")

            group_item = QTreeWidgetItem(self.tree)
            group_item.setText(0, "")
            group_item.setText(1, f"📁 {group_name} ({len(browser_list)})")
            group_item.setFlags(
                group_item.flags() |
                Qt.ItemFlag.ItemIsAutoTristate |
                Qt.ItemFlag.ItemIsUserCheckable
            )
            group_item.setCheckState(0, Qt.CheckState.Unchecked)
            group_item.setExpanded(True)

            font = group_item.font(1)
            font.setBold(True)
            group_item.setFont(1, font)

            for browser in browser_list:
                email = browser.get('name', '')
                profile_id = browser.get('profile_id', '')

                acc_info = self._accounts.get(email, {})
                status = acc_info.get('status', 'unknown')

                # 根据状态筛选
                if status_filter and status not in status_filter:
                    continue

                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                child.setCheckState(0, Qt.CheckState.Unchecked)
                child.setText(1, email)
                child.setText(2, str(profile_id))
                child.setText(3, status)
                child.setText(4, "")
                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "profile_id": profile_id,
                    "email": email,
                    "account_info": acc_info
                })
                total_count += 1

        self.statsLabel.setText(f"共 {total_count} 个账号")
        self.log(f"加载完成: {total_count} 个账号")

    def _getSelectedAccounts(self) -> list:
        """获取选中的账号"""
        selected = []
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    data = child.data(0, Qt.ItemDataRole.UserRole)
                    if data and data.get("type") == "browser":
                        selected.append({
                            'email': data.get('email'),
                            'profile_id': data.get('profile_id'),
                            'account_info': data.get('account_info', {})
                        })
        return selected

    def _onStartClicked(self):
        """开始任务"""
        selected = self._getSelectedAccounts()
        if not selected:
            show_warning(self, "提示", "请先选择要处理的账号")
            return

        self.log(f"开始为 {len(selected)} 个账号执行{self._getTaskName()}...")
        self.setProgress(0)
        self.setRunning(True)

        config = self._getTaskConfig()
        self.taskWorker = self._createTaskWorker(selected, config)
        if self.taskWorker:
            self.taskWorker.progressSignal.connect(self._onTaskProgress)
            self.taskWorker.finishedSignal.connect(self._onTaskFinished)
            self.taskWorker.logSignal.connect(self.log)
            self.taskWorker.start()
        else:
            self.log("⚠️ 任务工作线程未实现")
            self.setRunning(False)

    def _onStopClicked(self):
        """停止任务"""
        if self.taskWorker and self.taskWorker.isRunning():
            self.taskWorker.stop()
            self.log(f"正在停止{self._getTaskName()}任务...")
        super()._onStopClicked()

    def _onTaskProgress(self, email: str, status: str, message: str):
        """更新任务进度"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(1) == email:
                    child.setText(3, status)
                    child.setText(4, message)

                    if status == "成功":
                        color = QColor(200, 255, 200)
                    elif status in ("失败", "错误"):
                        color = QColor(255, 200, 200)
                    else:
                        color = QColor(255, 255, 200)

                    for col in range(self.tree.columnCount()):
                        child.setBackground(col, color)
                    break

        self.log(f"[{email}] {status}: {message}")

    def _onTaskFinished(self):
        """任务完成"""
        self.setRunning(False)
        self.setProgress(100)
        self.log(f"✅ {self._getTaskName()}任务完成")
        show_success(self, "完成", f"{self._getTaskName()}任务已完成")

    def setRunning(self, running: bool):
        """设置运行状态"""
        self._isRunning = running
        self.startBtn.setEnabled(not running)
        self.stopBtn.setEnabled(running)
        self.loadBtn.setEnabled(not running)
