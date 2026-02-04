"""
绑卡订阅界面 - Fluent Design 版本
AI 自动绑定支付卡并完成订阅
"""
import asyncio
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QWidget, QHeaderView,
    QAbstractItemView, QTreeWidgetItem,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    CardWidget, PushButton, PrimaryPushButton, TransparentPushButton,
    LineEdit, SpinBox, CheckBox, ComboBox, TreeWidget,
    ProgressBar, TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
    InfoBar, InfoBarPosition,
    FluentIcon as FIF,
)

from gui.base_interface import BaseDialogInterface
from gui.fluent_utils import show_success, show_error, show_warning

from services.ix_api import get_group_list
from services.ix_window import get_browser_list
from services.database import DBManager
from core.config_manager import ConfigManager
from automation.auto_bind_card_ai import auto_bind_card_ai


class LoadDataWorker(QThread):
    """异步加载数据的后台线程"""
    progressSignal = pyqtSignal(int, int, str)
    finishedSignal = pyqtSignal(dict)
    logSignal = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self._shouldStop = False

    def stop(self):
        self._shouldStop = True

    def run(self):
        try:
            result = {
                'cards': [],
                'browsers': [],
                'groups': {},
                'accounts': {},
            }

            # 获取卡片数据
            self.progressSignal.emit(1, 4, "正在读取卡片数据...")
            if self._shouldStop:
                return
            result['cards'] = DBManager.get_all_cards() or []

            # 获取数据库账号
            self.progressSignal.emit(2, 4, "正在读取数据库...")
            if self._shouldStop:
                return
            db_accounts = DBManager.get_all_accounts() or []
            result['accounts'] = {acc['email']: acc for acc in db_accounts}

            # 获取分组列表
            self.progressSignal.emit(3, 4, "正在获取分组列表...")
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
            self.progressSignal.emit(4, 4, "正在获取窗口列表...")
            if self._shouldStop:
                return
            result['browsers'] = get_browser_list() or []

            self.finishedSignal.emit(result)

        except Exception as e:
            self.logSignal.emit(f"[错误] 加载数据失败: {e}")
            self.finishedSignal.emit({
                'cards': [],
                'browsers': [],
                'groups': {},
                'accounts': {},
                'error': str(e)
            })


class BindCardWorker(QThread):
    """绑卡工作线程"""
    progressSignal = pyqtSignal(str, str, str)  # email, status, message
    finishedSignal = pyqtSignal()
    logSignal = pyqtSignal(str)

    def __init__(self, accounts: list, cards: list, config: dict):
        super().__init__()
        self.accounts = accounts
        self.cards = cards
        self.config = config
        self._shouldStop = False

    def stop(self):
        self._shouldStop = True

    def run(self):
        try:
            # 运行异步绑卡任务
            asyncio.run(self._run_bind_card())
        except Exception as e:
            self.logSignal.emit(f"[错误] 绑卡任务异常: {e}")
        finally:
            self.finishedSignal.emit()

    async def _run_bind_card(self):
        for acc in self.accounts:
            if self._shouldStop:
                break

            email = acc.get('email', '')
            profile_id = acc.get('profile_id', '')

            self.progressSignal.emit(email, "处理中", "开始绑卡...")

            try:
                result = await auto_bind_card_ai(
                    profile_id=profile_id,
                    account_info=acc,
                    cards=self.cards,
                    config=self.config
                )
                if result.get('success'):
                    self.progressSignal.emit(email, "成功", result.get('message', '绑卡成功'))
                else:
                    self.progressSignal.emit(email, "失败", result.get('message', '绑卡失败'))
            except Exception as e:
                self.progressSignal.emit(email, "错误", str(e))


class BindCardInterface(BaseDialogInterface):
    """绑卡订阅界面 - Fluent 版本"""

    def __init__(self, parent=None):
        super().__init__('bindCardInterface', parent)

        self.loadWorker = None
        self.bindWorker = None
        self._cards = []
        self._browsers = []
        self._groups = {}
        self._accounts = {}

        self._initUI()

    def _initUI(self):
        """初始化界面"""
        # ===== 配置卡片 =====
        configCard = CardWidget(self)
        configLayout = QVBoxLayout(configCard)
        configLayout.setContentsMargins(20, 15, 20, 15)
        configLayout.setSpacing(10)

        configTitle = SubtitleLabel("绑卡配置", configCard)
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

        # 卡片轮换
        rotateLayout = QHBoxLayout()
        self.rotateCardCheck = CheckBox("启用卡片轮换", configCard)
        self.rotateCardCheck.setChecked(True)
        rotateLayout.addWidget(self.rotateCardCheck)
        rotateLayout.addStretch()
        configLayout.addLayout(rotateLayout)

        self.mainLayout.addWidget(configCard)

        # ===== 操作按钮 =====
        actionLayout = QHBoxLayout()
        actionLayout.setSpacing(10)

        self.loadBtn = PushButton(FIF.DOWNLOAD, "加载数据", self)
        self.loadBtn.setFixedHeight(36)
        self.loadBtn.clicked.connect(self._loadData)
        actionLayout.addWidget(self.loadBtn)

        self.bindBtn = PrimaryPushButton(FIF.SHOPPING_CART, "开始绑卡", self)
        self.bindBtn.setFixedHeight(36)
        self.bindBtn.clicked.connect(self._onStartClicked)
        actionLayout.addWidget(self.bindBtn)

        self.stopBtn = PushButton(FIF.PAUSE, "停止", self)
        self.stopBtn.setFixedHeight(36)
        self.stopBtn.setEnabled(False)
        self.stopBtn.clicked.connect(self._onStopClicked)
        actionLayout.addWidget(self.stopBtn)

        actionLayout.addStretch()

        # 统计标签
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

        # ===== 进度条 =====
        self.addProgressBar()

        # ===== 日志区 =====
        self.addLogArea()

    def _loadData(self):
        """加载数据"""
        self.tree.clear()
        self.log("正在加载数据...")

        if self.loadWorker is not None and self.loadWorker.isRunning():
            self.loadWorker.stop()
            self.loadWorker.wait(1000)

        self.loadWorker = LoadDataWorker()
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
            self._cards = result.get('cards', [])
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
        # 按分组组织浏览器
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

            # 分组节点
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

            # 窗口子节点
            for browser in browser_list:
                email = browser.get('name', '')
                profile_id = browser.get('profile_id', '')

                # 检查数据库中的账号状态
                acc_info = self._accounts.get(email, {})
                status = acc_info.get('status', 'unknown')

                # 只显示 verified 状态的账号
                if status != 'verified':
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

        self.statsLabel.setText(f"共 {len(self._cards)} 张卡, {total_count} 个可绑卡账号")
        self.log(f"加载完成: {len(self._cards)} 张卡, {total_count} 个可绑卡账号")

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
        """开始绑卡"""
        selected = self._getSelectedAccounts()
        if not selected:
            show_warning(self, "提示", "请先选择要绑卡的账号")
            return

        if not self._cards:
            show_warning(self, "提示", "没有可用的支付卡，请先在配置中添加")
            return

        self.log(f"开始为 {len(selected)} 个账号绑卡...")
        self.setProgress(0)
        self.setRunning(True)

        config = {
            'concurrent': self.concurrentSpin.value(),
            'rotate_card': self.rotateCardCheck.isChecked(),
        }

        self.bindWorker = BindCardWorker(selected, self._cards, config)
        self.bindWorker.progressSignal.connect(self._onBindProgress)
        self.bindWorker.finishedSignal.connect(self._onBindFinished)
        self.bindWorker.logSignal.connect(self.log)
        self.bindWorker.start()

    def _onStopClicked(self):
        """停止绑卡"""
        if self.bindWorker and self.bindWorker.isRunning():
            self.bindWorker.stop()
            self.log("正在停止绑卡任务...")
        super()._onStopClicked()

    def _onBindProgress(self, email: str, status: str, message: str):
        """更新绑卡进度"""
        # 更新树形控件中的状态
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(1) == email:
                    child.setText(3, status)
                    child.setText(4, message)

                    # 设置颜色
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

    def _onBindFinished(self):
        """绑卡完成"""
        self.setRunning(False)
        self.setProgress(100)
        self.log("✅ 绑卡任务完成")
        show_success(self, "完成", "绑卡任务已完成")

    def setRunning(self, running: bool):
        """设置运行状态"""
        self._isRunning = running
        self.bindBtn.setEnabled(not running)
        self.stopBtn.setEnabled(running)
        self.loadBtn.setEnabled(not running)
