"""
账号管理界面 - Fluent Design 版本
完整迁移自 account_manager_gui.py，提供账号状态管理、批量登录、批量 OAuth 功能
"""

import asyncio
from typing import List, Optional
from datetime import datetime

from PyQt6.QtCore import Qt, pyqtSignal, QThread, QTimer
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidgetItem,
    QHeaderView, QAbstractItemView, QFormLayout, QSplitter,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    TableWidget, PrimaryPushButton, PushButton, TransparentPushButton,
    TransparentToolButton, BodyLabel, CaptionLabel, CardWidget,
    SubtitleLabel, MessageBox, InfoBar, InfoBarPosition, FluentIcon as FIF,
    LineEdit, ComboBox, SpinBox, CheckBox, TextEdit, ProgressBar,
    RoundMenu, Action,
)

from gui.base_interface import BaseInterface
from services.database import DBManager
from services.sub2api_client import Sub2APIClient
from services.ix_api import get_profile_list
from core.config_manager import ConfigManager
from application.account_manager_service import AccountManagerService
from application.account_task_orchestrator import AccountTaskOrchestrator


class AccountWorkerThread(QThread):
    """账号处理工作线程"""
    progress = pyqtSignal(str)  # 日志消息
    progress_value = pyqtSignal(int, int)  # current, total
    finished = pyqtSignal(dict)
    error = pyqtSignal(str)

    def __init__(
        self,
        task_type: str,
        accounts: List[dict],
        browser_ids: List[str],
        concurrency: int = 3,
        sms_token: str = None,
        country_id: int = None,
        project_id: int = None,
        max_retries: int = None,
        auto_bind_proxy: bool = True,
    ):
        super().__init__()
        self.task_type = task_type
        self.accounts = accounts
        self.browser_ids = browser_ids
        self.concurrency = concurrency
        self.sms_token = sms_token
        self.country_id = country_id
        self.project_id = project_id
        self.max_retries = max_retries
        self.auto_bind_proxy = auto_bind_proxy
        self._stop_flag = False

    def stop(self):
        """停止处理"""
        self._stop_flag = True

    def run(self):
        """执行任务"""
        try:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                result = loop.run_until_complete(self._run_async())
                self.finished.emit(result)
            finally:
                loop.close()

        except Exception as e:
            self.error.emit(str(e))

    async def _run_async(self):
        """异步执行任务"""
        from automation.batch_account_processor import BatchAccountProcessor
        import re

        total = len(self.accounts)
        self._completed_count = 0

        def progress_callback(msg: str):
            """进度回调，解析消息并发送进度"""
            self.progress.emit(msg)
            # 检测完成标记：成功/失败/跳过
            if any(keyword in msg for keyword in ["✓", "✗", "成功", "失败", "跳过", "完成:"]):
                # 尝试从消息中提取 [X/Y] 格式
                match = re.search(r'\[(\d+)/(\d+)\]', msg)
                if match:
                    current = int(match.group(1))
                    self.progress_value.emit(current, total)
                else:
                    # 简单计数
                    self._completed_count += 1
                    self.progress_value.emit(min(self._completed_count, total), total)

        processor = BatchAccountProcessor(
            concurrency=self.concurrency,
            callback=progress_callback,
        )

        if self.task_type == "login":
            result = await processor.batch_login(
                accounts=self.accounts,
                browser_ids=self.browser_ids,
            )
            return {"type": "login", "result": result.to_dict()}

        elif self.task_type == "oauth":
            async with Sub2APIClient() as client:
                result = await processor.batch_oauth(
                    accounts=self.accounts,
                    browser_ids=self.browser_ids,
                    sub2api_client=client,
                    auto_bind_proxy=self.auto_bind_proxy,
                )
                return {"type": "oauth", "result": result.to_dict()}

        elif self.task_type == "login_and_oauth":
            async with Sub2APIClient() as client:
                results = await processor.batch_login_and_oauth(
                    accounts=self.accounts,
                    browser_ids=self.browser_ids,
                    sub2api_client=client,
                    auto_bind_proxy=self.auto_bind_proxy,
                )
                return {
                    "type": "login_and_oauth",
                    "login_result": results["login"].to_dict(),
                    "oauth_result": results["oauth"].to_dict(),
                }

        elif self.task_type == "unlock_403":
            result = await processor.batch_unlock_403(
                accounts=self.accounts,
                browser_ids=self.browser_ids,
                sms_token=self.sms_token,
                country_id=self.country_id,
                project_id=self.project_id,
                max_retries=self.max_retries,
            )
            return {"type": "unlock_403", "result": result.to_dict()}

        elif self.task_type == "detect_pro":
            result = await processor.batch_detect_pro(
                accounts=self.accounts,
                browser_ids=self.browser_ids,
            )
            return {"type": "detect_pro", "result": result.to_dict()}

        return {"type": "unknown"}


class AccountManagerInterface(BaseInterface):
    """账号管理界面 - Fluent Design 版本"""

    def __init__(self, parent=None):
        super().__init__('accountManagerInterface', parent)
        self.worker_thread: Optional[AccountWorkerThread] = None
        self._detect_403_thread = None
        self._detect_403_stop_flag = False
        self._detect_403_results = AccountTaskOrchestrator.create_detect_403_results(0)
        self._detect_403_error = ""
        self._batch_bind_thread = None
        self._batch_bind_stop_flag = False
        self._batch_bind_results = AccountTaskOrchestrator.create_batch_bind_results(0)
        self._batch_bind_error = ""
        self._batch_delete_thread = None
        self._batch_delete_stop_flag = False
        self._batch_delete_results = AccountTaskOrchestrator.create_batch_delete_results(0)
        self._batch_delete_error = ""
        self._initUI()
        self._loadData()

    def _initUI(self):
        """初始化界面"""
        # 标题
        titleLabel = SubtitleLabel("Google 账号管理", self)
        self.mainLayout.addWidget(titleLabel)

        # 工具栏区域
        self._createToolbar()

        # 表格选择栏（全选复选框 + 选中计数）
        selectBarLayout = QHBoxLayout()
        selectBarLayout.setContentsMargins(0, 4, 0, 4)
        selectBarLayout.setSpacing(12)

        self.chkSelectAll = CheckBox("全选", self)
        self.chkSelectAll.setToolTip("全选/取消全选当前显示的账号")
        self.chkSelectAll.stateChanged.connect(self._onSelectAllChanged)
        selectBarLayout.addWidget(self.chkSelectAll)

        self.selectedCountLabel = CaptionLabel("已选: 0", self)
        selectBarLayout.addWidget(self.selectedCountLabel)

        selectBarLayout.addStretch()
        self.mainLayout.addLayout(selectBarLayout)

        # 主内容区（使用分割器）
        splitter = QSplitter(Qt.Orientation.Vertical)

        # 表格区域
        self.table = self._createTable()
        splitter.addWidget(self.table)

        # 日志区域
        logCard = CardWidget(self)
        logLayout = QVBoxLayout(logCard)
        logLayout.setContentsMargins(16, 12, 16, 12)

        logTitleLabel = CaptionLabel("日志输出", logCard)
        logLayout.addWidget(logTitleLabel)

        self.logText = TextEdit(logCard)
        self.logText.setReadOnly(True)
        self.logText.setMaximumHeight(150)
        logLayout.addWidget(self.logText)

        splitter.addWidget(logCard)
        splitter.setSizes([500, 150])

        self.mainLayout.addWidget(splitter)

        # 进度条
        self.progressBar = ProgressBar(self)
        self.progressBar.setVisible(False)
        self.mainLayout.addWidget(self.progressBar)

        # 状态栏
        self.statusLabel = CaptionLabel("就绪", self)
        self.mainLayout.addWidget(self.statusLabel)

    def _createToolbar(self):
        """创建工具栏"""
        # 第一行：主要操作按钮
        toolbar1Card = CardWidget(self)
        toolbar1Layout = QHBoxLayout(toolbar1Card)
        toolbar1Layout.setContentsMargins(16, 12, 16, 12)
        toolbar1Layout.setSpacing(8)

        # 批量登录
        self.btnBatchLogin = PrimaryPushButton(FIF.DOWNLOAD, "批量登录", self)
        self.btnBatchLogin.setToolTip("批量登录选中的账号")
        self.btnBatchLogin.clicked.connect(self.onBatchLogin)
        toolbar1Layout.addWidget(self.btnBatchLogin)

        # 批量 OAuth
        self.btnBatchOAuth = PushButton(FIF.LINK, "批量 OAuth", self)
        self.btnBatchOAuth.setToolTip("批量进行 OAuth 授权")
        self.btnBatchOAuth.clicked.connect(self.onBatchOAuth)
        toolbar1Layout.addWidget(self.btnBatchOAuth)

        # 一键登录+OAuth
        self.btnLoginOAuth = PushButton(FIF.SEND, "一键登录+OAuth", self)
        self.btnLoginOAuth.setToolTip("一键完成登录和OAuth")
        self.btnLoginOAuth.clicked.connect(self.onLoginAndOAuth)
        toolbar1Layout.addWidget(self.btnLoginOAuth)

        toolbar1Layout.addSpacing(16)

        # 批量绑定窗口
        self.btnBatchBind = PushButton(FIF.CONNECT, "批量绑定窗口", self)
        self.btnBatchBind.setToolTip("根据窗口名称匹配邮箱自动绑定")
        self.btnBatchBind.clicked.connect(self.onBatchBind)
        toolbar1Layout.addWidget(self.btnBatchBind)

        # 检测 Pro
        self.btnDetectPro = PushButton(FIF.CERTIFICATE, "检测 Pro", self)
        self.btnDetectPro.setToolTip("检测选中已登录账号的 Google One Pro 会员状态")
        self.btnDetectPro.clicked.connect(self.onDetectPro)
        toolbar1Layout.addWidget(self.btnDetectPro)

        # 一键加入家庭组
        self.btnBatchJoinFamily = PushButton(FIF.PEOPLE, "一键加入家庭组", self)
        self.btnBatchJoinFamily.setToolTip("批量将普通账户加入到 Pro 账户的家庭组")
        self.btnBatchJoinFamily.clicked.connect(self.onBatchJoinFamily)
        toolbar1Layout.addWidget(self.btnBatchJoinFamily)

        # 开启共享
        self.btnEnableFamilySharing = PushButton(FIF.SHARE, "开启共享", self)
        self.btnEnableFamilySharing.setToolTip("为普通 Pro 账户开启家庭组共享功能")
        self.btnEnableFamilySharing.clicked.connect(self.onEnableFamilySharing)
        toolbar1Layout.addWidget(self.btnEnableFamilySharing)

        toolbar1Layout.addStretch()
        self.mainLayout.addWidget(toolbar1Card)

        # 第二行：403解锁 + 删除 + 刷新/停止
        toolbar2Card = CardWidget(self)
        toolbar2Layout = QHBoxLayout(toolbar2Card)
        toolbar2Layout.setContentsMargins(16, 12, 16, 12)
        toolbar2Layout.setSpacing(8)

        # 检测 403
        self.btnDetect403 = PushButton(FIF.SEARCH, "检测 403", self)
        self.btnDetect403.clicked.connect(self.onDetect403)
        toolbar2Layout.addWidget(self.btnDetect403)

        # 批量解锁 403
        self.btnBatchUnlock = PushButton(FIF.ACCEPT_MEDIUM, "批量解锁 403", self)
        self.btnBatchUnlock.clicked.connect(self.onBatchUnlock403)
        toolbar2Layout.addWidget(self.btnBatchUnlock)

        toolbar2Layout.addSpacing(16)

        # 刷新
        self.btnRefresh = TransparentPushButton(FIF.SYNC, "刷新", self)
        self.btnRefresh.clicked.connect(self._loadData)
        toolbar2Layout.addWidget(self.btnRefresh)

        # 停止
        self.btnStop = PushButton(FIF.PAUSE, "停止", self)
        self.btnStop.setEnabled(False)
        self.btnStop.clicked.connect(self.onStop)
        toolbar2Layout.addWidget(self.btnStop)

        toolbar2Layout.addSpacing(16)

        # 删除选中
        self.btnDelete = PushButton(FIF.DELETE, "删除选中", self)
        self.btnDelete.clicked.connect(lambda: self._deleteSelectedAccounts(with_windows=False))
        toolbar2Layout.addWidget(self.btnDelete)

        # 删除+窗口
        self.btnDeleteWithWindow = PushButton(FIF.REMOVE, "删除+窗口", self)
        self.btnDeleteWithWindow.setToolTip("删除选中账号及其对应的浏览器窗口")
        self.btnDeleteWithWindow.clicked.connect(lambda: self._deleteSelectedAccounts(with_windows=True))
        toolbar2Layout.addWidget(self.btnDeleteWithWindow)

        toolbar2Layout.addStretch()

        # 筛选器
        filterLabel = CaptionLabel("筛选:", self)
        toolbar2Layout.addWidget(filterLabel)

        self.filterCombo = ComboBox(self)
        self.filterCombo.addItems([
            "全部", "未登录", "已登录", "登录失败",
            "Pro会员", "Pro(家庭组)", "非Pro", "Pro检测失败",
            "未关联", "已关联", "OAuth失败",
            "需要解锁", "解锁失败", "已解锁",
        ])
        self.filterCombo.setMinimumWidth(100)
        self.filterCombo.currentTextChanged.connect(self._applyFilter)
        toolbar2Layout.addWidget(self.filterCombo)

        toolbar2Layout.addSpacing(16)

        # 并发数
        concurrencyLabel = CaptionLabel("并发数:", self)
        toolbar2Layout.addWidget(concurrencyLabel)

        self.concurrencySpin = SpinBox(self)
        self.concurrencySpin.setRange(1, 10)
        self.concurrencySpin.setValue(ConfigManager.get_login_concurrency())
        self.concurrencySpin.setMinimumWidth(120)
        toolbar2Layout.addWidget(self.concurrencySpin)

        toolbar2Layout.addSpacing(8)

        # 自动绑定代理
        self.chkAutoBindProxy = CheckBox("自动绑定代理", self)
        self.chkAutoBindProxy.setChecked(True)
        self.chkAutoBindProxy.setToolTip("OAuth 成功后自动绑定到使用量最少的代理")
        toolbar2Layout.addWidget(self.chkAutoBindProxy)

        self.mainLayout.addWidget(toolbar2Card)

    def _createTable(self) -> TableWidget:
        """创建表格"""
        table = TableWidget(self)
        table.setColumnCount(10)
        table.setHorizontalHeaderLabels([
            "选择", "邮箱", "登录状态", "Pro", "窗口名称",
            "窗口ID", "Sub2API", "解锁状态", "更新时间", "操作"
        ])

        # 设置列宽 - 使用 Interactive 模式允许用户调整
        header = table.horizontalHeader()
        header.setStretchLastSection(False)

        # 列0: 选择 - 固定宽度（复选框）
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(0, 40)

        # 列1: 邮箱 - 可调整，初始宽度较大
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Interactive)
        table.setColumnWidth(1, 220)

        # 列2: 登录状态 - 按内容自适应
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)

        # 列3: Pro - 按内容自适应
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)

        # 列4: 窗口名称 - 拉伸填充剩余空间
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)

        # 列5: 窗口ID - 按内容自适应
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)

        # 列6: Sub2API - 按内容自适应
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.ResizeToContents)

        # 列7: 解锁状态 - 按内容自适应
        header.setSectionResizeMode(7, QHeaderView.ResizeMode.ResizeToContents)

        # 列8: 更新时间 - 按内容自适应
        header.setSectionResizeMode(8, QHeaderView.ResizeMode.ResizeToContents)

        # 列9: 操作 - 固定宽度（确保按钮完整显示）
        header.setSectionResizeMode(9, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(9, 110)

        # 启用右键菜单
        table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        table.customContextMenuRequested.connect(self._showContextMenu)

        # 允许多选
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)

        return table

    def _loadData(self):
        """加载数据"""
        self.log("正在加载账号数据...")

        # 获取所有账号
        accounts = DBManager.get_all_accounts()

        # 获取窗口列表，构建映射
        window_name_map = {}
        try:
            windows = get_profile_list(page=1, limit=500)
            if windows:
                for w in windows:
                    profile_id = str(w.get("profile_id", ""))
                    name = w.get("name", "")
                    if profile_id:
                        window_name_map[profile_id] = name
        except Exception as e:
            self.log(f"获取窗口列表失败: {e}")

        # 清空表格
        self.table.setRowCount(0)
        self.table.setRowCount(len(accounts))

        # 统计
        total = len(accounts)
        logged_in = 0
        linked = 0

        for row, account in enumerate(accounts):
            email = account.get("email", "")
            login_status = account.get("login_status", "not_logged")
            browser_id = account.get("browser_profile_id", "")
            sub2api_status = account.get("sub2api_status", "not_linked")
            unlock_status = account.get("unlock_status", "none")
            updated_at = account.get("updated_at", "")

            # 统计
            if login_status == "logged_in":
                logged_in += 1
            if sub2api_status == "linked":
                linked += 1

            # 选择框
            checkbox = CheckBox()
            checkboxWidget = QWidget()
            checkboxLayout = QHBoxLayout(checkboxWidget)
            checkboxLayout.addWidget(checkbox)
            checkboxLayout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkboxLayout.setContentsMargins(0, 0, 0, 0)
            self.table.setCellWidget(row, 0, checkboxWidget)

            # 邮箱
            self.table.setItem(row, 1, QTableWidgetItem(email))

            # 登录状态
            last_error = account.get("last_error", "")
            if login_status == "login_failed" and last_error:
                short_error = last_error[:20] + "..." if len(last_error) > 20 else last_error
                login_text = f"失败: {short_error}"
            else:
                login_text = self._getLoginStatusText(login_status)
            login_item = QTableWidgetItem(login_text)
            login_item.setForeground(self._getLoginStatusColor(login_status))
            if login_status == "login_failed" and last_error:
                login_item.setToolTip(f"错误原因: {last_error}")
            self.table.setItem(row, 2, login_item)

            # Pro 状态
            is_pro = account.get("is_pro", "unknown")
            pro_item = QTableWidgetItem(self._getProStatusText(is_pro))
            pro_item.setForeground(self._getProStatusColor(is_pro))
            pro_tooltip_map = {
                "unknown": "未检测 Pro 状态",
                "yes": "普通 Pro 会员（自己订阅）",
                "no": "非 Pro 会员",
                "family_yes": "家庭组 Pro 会员（被邀请加入）",
                "detection_failed": "Pro 检测失败（页面无法识别）",
            }
            pro_item.setToolTip(pro_tooltip_map.get(is_pro, "未知状态"))
            self.table.setItem(row, 3, pro_item)

            # 窗口名称
            window_name = window_name_map.get(browser_id, "") if browser_id else ""
            self.table.setItem(row, 4, QTableWidgetItem(window_name or "-"))

            # 窗口ID
            self.table.setItem(row, 5, QTableWidgetItem(browser_id or "-"))

            # Sub2API 状态
            sub2api_item = QTableWidgetItem(self._getSub2apiStatusText(sub2api_status))
            sub2api_item.setForeground(self._getSub2apiStatusColor(sub2api_status))
            self.table.setItem(row, 6, sub2api_item)

            # 解锁状态
            unlock_item = QTableWidgetItem(self._getUnlockStatusText(unlock_status))
            unlock_item.setForeground(self._getUnlockStatusColor(unlock_status))
            self.table.setItem(row, 7, unlock_item)

            # 更新时间
            self.table.setItem(row, 8, QTableWidgetItem(updated_at or "-"))

            # 操作按钮
            btnWidget = QWidget()
            btnLayout = QHBoxLayout(btnWidget)
            btnLayout.setContentsMargins(2, 2, 2, 2)
            btnLayout.setSpacing(0)

            if login_status != "logged_in":
                btn = TransparentPushButton(FIF.DOWNLOAD, "登录", self)
                btn.clicked.connect(lambda _, e=email: self._singleLogin(e))
            else:
                btn = TransparentPushButton(FIF.LINK, "OAuth", self)
                btn.clicked.connect(lambda _, e=email: self._singleOAuth(e))

            btnLayout.addWidget(btn)
            self.table.setCellWidget(row, 9, btnWidget)

        # 更新状态栏
        self.statusLabel.setText(f"总计 {total} 个 | 已登录 {logged_in} | 已关联 {linked}")
        self.log(f"加载完成，共 {total} 个账号")

        # 重新应用当前筛选条件（保持筛选状态）
        current_filter = self.filterCombo.currentText()
        if current_filter and current_filter != "全部":
            self._applyFilter(current_filter)

        # 重置全选复选框状态（因为表格行是新创建的，默认未选中）
        # 使用 blockSignals 避免触发 _onSelectAllChanged 信号
        self.chkSelectAll.blockSignals(True)
        self.chkSelectAll.setChecked(False)
        self.chkSelectAll.blockSignals(False)

        # 更新选中计数
        self._updateSelectedCount()

    # ==================== 状态文本和颜色方法 ====================

    def _getLoginStatusText(self, status: str) -> str:
        """获取登录状态显示文本"""
        mapping = {
            "not_logged": "未登录",
            "logging_in": "登录中",
            "logged_in": "已登录",
            "login_failed": "失败",
        }
        return mapping.get(status, status or "未登录")

    def _getLoginStatusColor(self, status: str) -> QColor:
        """获取登录状态颜色"""
        mapping = {
            "not_logged": QColor("#888888"),
            "logging_in": QColor("#2196F3"),
            "logged_in": QColor("#4CAF50"),
            "login_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    def _getProStatusText(self, status: str) -> str:
        """获取 Pro 状态显示文本"""
        mapping = {
            "unknown": "-",
            "yes": "Pro",
            "no": "非Pro",
            "family_yes": "家庭",
            "detection_failed": "检测失败",
        }
        return mapping.get(status, "-")

    def _getProStatusColor(self, status: str) -> QColor:
        """获取 Pro 状态颜色"""
        mapping = {
            "unknown": QColor("#888888"),
            "yes": QColor("#4CAF50"),
            "no": QColor("#F44336"),
            "family_yes": QColor("#2196F3"),
            "detection_failed": QColor("#FF9800"),  # 橙色表示检测失败
        }
        return mapping.get(status, QColor("#888888"))

    def _getSub2apiStatusText(self, status: str) -> str:
        """获取 Sub2API 状态显示文本"""
        mapping = {
            "not_linked": "未关联",
            "linking": "关联中",
            "linked": "已关联",
            "oauth_failed": "失败",
        }
        return mapping.get(status, status or "未关联")

    def _getSub2apiStatusColor(self, status: str) -> QColor:
        """获取 Sub2API 状态颜色"""
        mapping = {
            "not_linked": QColor("#888888"),
            "linking": QColor("#2196F3"),
            "linked": QColor("#4CAF50"),
            "oauth_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    def _getUnlockStatusText(self, status: str) -> str:
        """获取解锁状态显示文本"""
        mapping = {
            "none": "-",
            "needs_unlock": "需解锁",
            "unlocking": "解锁中",
            "unlocked": "已解锁",
            "unlock_failed": "失败",
        }
        return mapping.get(status, status or "-")

    def _getUnlockStatusColor(self, status: str) -> QColor:
        """获取解锁状态颜色"""
        mapping = {
            "none": QColor("#888888"),
            "needs_unlock": QColor("#FF9800"),
            "unlocking": QColor("#2196F3"),
            "unlocked": QColor("#4CAF50"),
            "unlock_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    # ==================== 筛选和右键菜单 ====================

    def _applyFilter(self, filter_text: str):
        """应用筛选"""
        for row in range(self.table.rowCount()):
            show = True

            if filter_text == "未登录":
                login_item = self.table.item(row, 2)
                show = login_item and login_item.text() == "未登录"
            elif filter_text == "已登录":
                login_item = self.table.item(row, 2)
                show = login_item and login_item.text() == "已登录"
            elif filter_text == "登录失败":
                login_item = self.table.item(row, 2)
                show = login_item and login_item.text().startswith("失败")
            elif filter_text == "Pro会员":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() in ("Pro", "家庭")
            elif filter_text == "Pro(家庭组)":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "家庭"
            elif filter_text == "非Pro":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "非Pro"
            elif filter_text == "Pro检测失败":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "检测失败"
            elif filter_text == "未关联":
                sub2api_item = self.table.item(row, 6)
                show = sub2api_item and sub2api_item.text() == "未关联"
            elif filter_text == "已关联":
                sub2api_item = self.table.item(row, 6)
                show = sub2api_item and sub2api_item.text() == "已关联"
            elif filter_text == "OAuth失败":
                sub2api_item = self.table.item(row, 6)
                show = sub2api_item and sub2api_item.text() == "失败"
            elif filter_text == "需要解锁":
                unlock_item = self.table.item(row, 7)
                show = unlock_item and unlock_item.text() == "需解锁"
            elif filter_text == "解锁失败":
                unlock_item = self.table.item(row, 7)
                show = unlock_item and unlock_item.text() == "失败"
            elif filter_text == "已解锁":
                unlock_item = self.table.item(row, 7)
                show = unlock_item and unlock_item.text() == "已解锁"

            self.table.setRowHidden(row, not show)

    def _showContextMenu(self, pos):
        """显示右键菜单"""
        row = self.table.rowAt(pos.y())
        if row < 0:
            return

        email_item = self.table.item(row, 1)
        if not email_item:
            return

        email = email_item.text()
        browser_item = self.table.item(row, 5)
        has_browser = browser_item and browser_item.text() != "-"

        menu = RoundMenu(parent=self)

        # 绑定/解绑窗口选项
        if not has_browser:
            actionBind = Action(FIF.LINK, "绑定窗口", self)
            actionBind.triggered.connect(lambda: self._bindBrowser(email))
            menu.addAction(actionBind)
        else:
            actionRebind = Action(FIF.SYNC, "重新绑定窗口", self)
            actionRebind.triggered.connect(lambda: self._bindBrowser(email))
            menu.addAction(actionRebind)

            actionUnbind = Action(FIF.CLOSE, "解绑窗口", self)
            actionUnbind.triggered.connect(lambda: self._unbindBrowser(email))
            menu.addAction(actionUnbind)

        menu.addSeparator()

        # 登录/OAuth
        actionLogin = Action(FIF.DOWNLOAD, "登录", self)
        actionLogin.triggered.connect(lambda: self._singleLogin(email))
        menu.addAction(actionLogin)

        actionOAuth = Action(FIF.LINK, "OAuth", self)
        actionOAuth.triggered.connect(lambda: self._singleOAuth(email))
        menu.addAction(actionOAuth)

        # 加入家庭组选项
        account = DBManager.get_account_by_email(email)
        if account:
            is_pro = account.get("is_pro", "unknown")
            login_status = account.get("login_status", "")

            if is_pro in ("no", "unknown") and login_status == "logged_in" and has_browser:
                actionJoinFamily = Action(FIF.PEOPLE, "加入家庭组", self)
                actionJoinFamily.triggered.connect(lambda: self._showJoinFamilyDialog(email))
                menu.addAction(actionJoinFamily)

        menu.addSeparator()

        actionRefresh = Action(FIF.SYNC, "刷新", self)
        actionRefresh.triggered.connect(self._loadData)
        menu.addAction(actionRefresh)

        menu.addSeparator()

        # 删除选项
        actionDelete = Action(FIF.DELETE, "删除账号", self)
        actionDelete.triggered.connect(lambda: self._deleteSingleAccount(email))
        menu.addAction(actionDelete)

        if has_browser:
            browser_id = browser_item.text()
            actionDeleteWithWindow = Action(FIF.REMOVE, "删除账号和窗口", self)
            actionDeleteWithWindow.triggered.connect(
                lambda: self._deleteAccountWithWindow(email, browser_id)
            )
            menu.addAction(actionDeleteWithWindow)

        menu.exec(self.table.mapToGlobal(pos))

    # ==================== 获取选中账号 ====================

    def _getSelectedAccounts(self) -> tuple[List[dict], List[str]]:
        """获取选中的账号和对应的浏览器 ID"""
        selected_rows = []

        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue

            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(CheckBox)
                if checkbox and checkbox.isChecked():
                    email_item = self.table.item(row, 1)
                    browser_item = self.table.item(row, 5)

                    if email_item:
                        email = email_item.text()
                        browser_id = browser_item.text() if browser_item else ""
                        selected_rows.append((email, browser_id))

        return AccountManagerService.resolve_selected_accounts(selected_rows)

    def _getSelectedRows(self) -> List[tuple[str, str]]:
        """获取选中行的 (email, browser_id) 列表"""
        selected_rows: List[tuple[str, str]] = []

        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue

            checkbox_widget = self.table.cellWidget(row, 0)
            if not checkbox_widget:
                continue

            checkbox = checkbox_widget.findChild(CheckBox)
            if not checkbox or not checkbox.isChecked():
                continue

            email_item = self.table.item(row, 1)
            browser_item = self.table.item(row, 5)
            if not email_item:
                continue

            email = email_item.text()
            browser_id = browser_item.text() if browser_item else ""
            selected_rows.append((email, browser_id))

        return selected_rows

    def _checkTaskConflicts(
        self,
        *,
        include_batch_bind: bool = False,
        include_detect_403: bool = False,
        include_batch_delete: bool = False,
        wait_action: str = "",
    ) -> bool:
        """统一检查任务冲突，避免重复分支判断"""
        ok, message = AccountManagerService.check_task_conflicts(
            worker_running=bool(self.worker_thread and self.worker_thread.isRunning()),
            batch_join_running=bool(
                hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive()
            ),
            enable_sharing_running=bool(
                hasattr(self, '_enable_sharing_thread') and self._enable_sharing_thread.is_alive()
            ),
            batch_bind_running=bool(
                include_batch_bind and hasattr(self, '_batch_bind_thread') and self._batch_bind_thread and self._batch_bind_thread.is_alive()
            ),
            detect_403_running=bool(
                include_detect_403 and hasattr(self, '_detect_403_thread') and self._detect_403_thread and self._detect_403_thread.is_alive()
            ),
            batch_delete_running=bool(
                include_batch_delete and hasattr(self, '_batch_delete_thread') and self._batch_delete_thread and self._batch_delete_thread.is_alive()
            ),
            wait_action=wait_action,
        )

        if not ok:
            self._showWarning("警告", message)
            return False

        return True

    # ==================== 单个账号操作 ====================

    def _singleLogin(self, email: str):
        """单个账号登录"""
        account, browser_id = AccountManagerService.get_account_and_browser(email)
        if not account:
            self.log(f"未找到账号: {email}")
            return

        if not browser_id:
            self.log(f"账号未绑定窗口: {email}")
            self._showWarning("警告", f"账号 {email} 未绑定浏览器窗口")
            return

        self._startTask("login", [account], [browser_id])

    def _singleOAuth(self, email: str):
        """单个账号 OAuth"""
        account, browser_id = AccountManagerService.get_account_and_browser(email)
        if not account:
            self.log(f"未找到账号: {email}")
            return

        if not browser_id:
            self.log(f"账号未绑定窗口: {email}")
            self._showWarning("警告", f"账号 {email} 未绑定浏览器窗口")
            return

        self._startTask("oauth", [account], [browser_id])

    # ==================== 批量操作入口 ====================

    def onBatchLogin(self):
        """批量登录"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先选择要登录的账号")
            return

        missing = AccountManagerService.collect_missing_browser_emails(accounts, browser_ids)
        if missing:
            self._showWarning(
                "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}" +
                (f"\n...等 {len(missing)} 个" if len(missing) > 5 else "")
            )
            return

        self._startTask("login", accounts, browser_ids)

    def onBatchOAuth(self):
        """批量 OAuth"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先选择要进行 OAuth 的账号")
            return

        missing = AccountManagerService.collect_missing_browser_emails(accounts, browser_ids)
        if missing:
            self._showWarning(
                "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}"
            )
            return

        self._startTask("oauth", accounts, browser_ids)

    def onLoginAndOAuth(self):
        """一键登录+OAuth"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先选择账号")
            return

        missing = AccountManagerService.collect_missing_browser_emails(accounts, browser_ids)
        if missing:
            self._showWarning(
                "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}"
            )
            return

        self._startTask("login_and_oauth", accounts, browser_ids)

    def onBatchBind(self):
        """批量绑定窗口（根据窗口名称匹配邮箱）"""
        if not self._checkTaskConflicts(include_batch_bind=True):
            return

        selected_rows = self._getSelectedRows()
        unbound_accounts = AccountManagerService.collect_unbound_emails(selected_rows)

        if not unbound_accounts:
            self._showInfo("提示", "请先选择未绑定窗口的账号")
            return

        try:
            windows = get_profile_list(page=1, limit=500)
            if not windows:
                self._showWarning("警告", "未找到可用的浏览器窗口\n请先在主界面创建窗口")
                return

            matched, not_matched, already_bound = AccountManagerService.match_accounts_to_windows(
                target_emails=unbound_accounts,
                windows=windows,
            )

            if not matched:
                msg = "未找到可用的匹配窗口!\n\n"
                if already_bound:
                    msg += f"⚠️ {len(already_bound)} 个窗口已被其他账号绑定\n"
                if not_matched:
                    msg += f"❌ {len(not_matched)} 个账号未找到匹配窗口"
                self._showWarning("警告", msg)
                return

            # 确认绑定
            msg = f"将绑定 {len(matched)} 个账号到对应窗口"
            if already_bound:
                msg += f"\n\n⚠️ {len(already_bound)} 个窗口已被其他账号绑定（已跳过）"
            if not_matched:
                msg += f"\n\n❌ {len(not_matched)} 个账号未找到匹配窗口:\n{', '.join(not_matched[:5])}"
                if len(not_matched) > 5:
                    msg += f"\n...等 {len(not_matched)} 个"

            w = MessageBox("确认", msg + "\n\n是否继续？", self)
            if not w.exec():
                return

            # 使用异步线程执行绑定
            self.log(f"开始批量绑定，共 {len(matched)} 个账号...")
            self.progressBar.setVisible(True)
            self.progressBar.setRange(0, len(matched))
            self.progressBar.setValue(0)
            self._setButtonsEnabled(False)

            # 保存未匹配数量用于完成回调
            self._batch_bind_results = AccountTaskOrchestrator.create_batch_bind_results(len(matched))
            self._batch_bind_error = ""
            self._batch_bind_stop_flag = False
            self._batch_bind_not_matched_count = len(not_matched)

            from threading import Thread
            from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

            def safe_log(msg: str):
                QMetaObject.invokeMethod(
                    self.logText,
                    "append",
                    QtCore_Qt.ConnectionType.QueuedConnection,
                    Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
                )

            def update_progress(value: int):
                QMetaObject.invokeMethod(
                    self.progressBar,
                    "setValue",
                    QtCore_Qt.ConnectionType.QueuedConnection,
                    Q_ARG(int, value)
                )
                QMetaObject.invokeMethod(
                    self.statusLabel,
                    "setText",
                    QtCore_Qt.ConnectionType.QueuedConnection,
                    Q_ARG(str, f"处理中: {value}/{len(matched)}")
                )

            def run_batch_bind():
                try:
                    self._batch_bind_results = AccountTaskOrchestrator.execute_batch_bind(
                        matched_pairs=matched,
                        should_stop=lambda: self._batch_bind_stop_flag,
                        bind_account_callback=DBManager.bind_account_to_browser,
                        log_callback=safe_log,
                        progress_callback=update_progress,
                    )
                except Exception as error:
                    self._batch_bind_error = str(error)
                finally:
                    QTimer.singleShot(0, self._onBatchBindThreadCompleted)

            self._batch_bind_thread = Thread(target=run_batch_bind, daemon=True)
            self._batch_bind_thread.start()

        except Exception as e:
            self.log(f"批量绑定失败: {e}")
            self._showError("错误", f"批量绑定失败:\n{e}")

    def _onBatchBindThreadCompleted(self):
        """批量绑定线程结束回调（主线程）"""
        if self._batch_bind_error:
            self._onBatchBindError(self._batch_bind_error)
            return
        self._onBatchBindFinished()

    def _onBatchBindFinished(self):
        """批量绑定完成回调"""
        self._setButtonsEnabled(True)
        self._batch_bind_thread = None

        total = self._batch_bind_results.get("total", 0)
        success_count = self._batch_bind_results.get("success_count", 0)
        failed_count = self._batch_bind_results.get("failed_count", 0)
        not_matched_count = getattr(self, '_batch_bind_not_matched_count', 0)

        self.log(f"批量绑定完成: {success_count}/{total}")
        if failed_count:
            self.log(f"绑定失败: {failed_count} 个")
        if not_matched_count:
            self.log(f"未匹配: {not_matched_count} 个")

        self._showInfo("绑定完成", f"成功绑定 {success_count}/{total} 个账号")
        self._loadData()

    def _onBatchBindError(self, error: str):
        """批量绑定错误回调"""
        self._setButtonsEnabled(True)
        self._batch_bind_thread = None
        self.progressBar.setVisible(False)
        self.log(f"批量绑定失败: {error}")
        self._showError("错误", f"批量绑定失败:\n{error}")

    def onDetectPro(self):
        """检测选中账号的 Pro 会员状态"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先选择要检测的账号")
            return

        (
            valid_accounts,
            valid_browser_ids,
            skipped_not_logged,
            skipped_no_browser,
        ) = AccountManagerService.prepare_detect_pro_candidates(accounts, browser_ids)

        if not valid_accounts:
            msg = AccountManagerService.build_no_detect_pro_candidates_message(
                skipped_not_logged=skipped_not_logged,
                skipped_no_browser=skipped_no_browser,
            )
            self._showWarning("警告", msg)
            return

        msg = AccountManagerService.build_detect_pro_confirm_message(
            valid_count=len(valid_accounts),
            skipped_not_logged_count=len(skipped_not_logged),
            skipped_no_browser_count=len(skipped_no_browser),
        )

        w = MessageBox("确认检测", msg + "\n\n是否继续？", self)
        if not w.exec():
            return

        self._startTask("detect_pro", valid_accounts, valid_browser_ids)

    def onDetect403(self):
        """检测 403 需要解锁的账号（异步执行）- 只检测选中的账号"""
        if not self._checkTaskConflicts(include_detect_403=True):
            return

        # 获取选中的账号
        selected_accounts, _ = self._getSelectedAccounts()

        if not selected_accounts:
            self._showInfo("提示", "请先选择要检测的账号")
            return

        # 筛选出已关联的账号
        linked_accounts = AccountManagerService.filter_linked_accounts_for_detect403(selected_accounts)

        if not linked_accounts:
            self._showWarning(
                "提示",
                AccountManagerService.build_no_linked_accounts_for_detect403_message(
                    len(selected_accounts)
                )
            )
            return

        self.log(f"正在检测选中账号的 403 状态，共 {len(linked_accounts)} 个已关联账号...")

        # 显示进度条
        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(linked_accounts))
        self.progressBar.setValue(0)
        self._setButtonsEnabled(False)

        self._detect_403_results = AccountTaskOrchestrator.create_detect_403_results(len(linked_accounts))
        self._detect_403_error = ""
        self._detect_403_stop_flag = False

        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            QMetaObject.invokeMethod(
                self.logText,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def update_progress(value: int):
            QMetaObject.invokeMethod(
                self.progressBar,
                "setValue",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(int, value)
            )
            QMetaObject.invokeMethod(
                self.statusLabel,
                "setText",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"处理中: {value}/{len(linked_accounts)}")
            )

        def run_detect_403():
            try:
                self._detect_403_results = AccountTaskOrchestrator.execute_detect_403(
                    accounts=linked_accounts,
                    should_stop=lambda: self._detect_403_stop_flag,
                    log_callback=safe_log,
                    progress_callback=update_progress,
                )
            except Exception as error:
                self._detect_403_error = str(error)
            finally:
                QTimer.singleShot(0, self._onDetect403ThreadCompleted)

        self._detect_403_thread = Thread(target=run_detect_403, daemon=True)
        self._detect_403_thread.start()

    def _onDetect403ThreadCompleted(self):
        """检测 403 线程结束回调（主线程）"""
        if self._detect_403_error:
            self._onDetect403Error(self._detect_403_error)
            return
        self._onDetect403Finished()

    def _onDetect403Finished(self):
        """检测 403 完成回调"""
        self._setButtonsEnabled(True)
        self._detect_403_thread = None

        total = self._detect_403_results.get("total", 0)
        needs_unlock = self._detect_403_results.get("needs_unlock", 0)
        accounts = self._detect_403_results.get("accounts", [])

        self.log(f"检测完成: 共 {total} 个账号，{needs_unlock} 个需要解锁")

        if needs_unlock > 0:
            self._showInfo(
                "检测完成",
                f"共检测 {total} 个已关联账号\n"
                f"发现 {needs_unlock} 个需要解锁\n\n"
                f"账号: {', '.join(accounts[:5])}"
                + (f"\n...等 {needs_unlock} 个" if needs_unlock > 5 else "")
            )
        else:
            self._showInfo("检测完成", f"共检测 {total} 个账号，无需解锁")

        self._loadData()

    def _onDetect403Error(self, error: str):
        """检测 403 错误回调"""
        self._setButtonsEnabled(True)
        self._detect_403_thread = None
        self.progressBar.setVisible(False)
        self.log(f"检测失败: {error}")
        self._showError("错误", f"检测失败:\n{error}")

    def onBatchUnlock403(self):
        """批量解锁 403 账号"""
        selected_accounts, selected_browser_ids = self._getSelectedAccounts()

        accounts_to_unlock: List[dict] = []
        browser_ids: List[str] = []

        if selected_accounts:
            accounts_to_unlock, browser_ids = AccountManagerService.collect_unlock_targets_from_selected(
                selected_accounts,
                selected_browser_ids,
            )

            if not accounts_to_unlock:
                self._showInfo("提示", AccountManagerService.build_no_selected_unlock_targets_message())
                return

            self.log(f"用户选中了 {len(selected_accounts)} 个账号，其中 {len(accounts_to_unlock)} 个需要解锁")
        else:
            all_needing_unlock = DBManager.get_accounts_needing_unlock()

            if not all_needing_unlock:
                self._showInfo("提示", "没有需要解锁的账号\n请先点击「检测 403」按钮")
                return

            w = MessageBox(
                "确认",
                AccountManagerService.build_unlock_all_confirm_message(len(all_needing_unlock)),
                self
            )
            if not w.exec():
                return

            accounts_to_unlock, browser_ids = AccountManagerService.collect_unlock_targets_from_all(
                all_needing_unlock
            )

        # 检查 SMS-Bus Token
        sms_token = ConfigManager.get_sms_bus_token()
        if not sms_token:
            self._showWarning(
                "警告",
                "请先配置 SMS-Bus Token\n\n"
                "在「配置管理」→「Sub2API 设置」→「SMS-Bus」中设置 API Token"
            )
            return

        accounts_with_browser, valid_browser_ids, no_browser = (
            AccountManagerService.split_accounts_with_browser(accounts_to_unlock, browser_ids)
        )

        if not accounts_with_browser:
            self._showWarning("警告", "所有需要解锁的账号都未绑定窗口")
            return

        country_id = ConfigManager.get_sms_bus_default_country_id()
        project_id = ConfigManager.get_sms_bus_default_project_id()
        self.log(f"SMS-Bus 配置: country_id={country_id}, project_id={project_id}")

        msg = AccountManagerService.build_unlock_confirm_message(
            unlockable_count=len(accounts_with_browser),
            no_browser_count=len(no_browser),
            country_id=country_id,
            project_id=project_id,
        )

        w = MessageBox("确认解锁", msg + "\n\n是否继续？", self)
        if not w.exec():
            return

        self._startUnlockTask(accounts_with_browser, valid_browser_ids, sms_token)

    def onStop(self):
        """停止任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            self.log("正在停止...")
            self.worker_thread.stop()

        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            self.log("正在停止批量加入家庭组...")
            self._batch_join_stop_flag = True

        if hasattr(self, '_enable_sharing_thread') and self._enable_sharing_thread.is_alive():
            self.log("正在停止开启共享任务...")
            self._enable_sharing_stop_flag = True

        if hasattr(self, '_detect_403_thread') and self._detect_403_thread and self._detect_403_thread.is_alive():
            self.log("正在停止 403 检测...")
            self._detect_403_stop_flag = True

        if hasattr(self, '_batch_bind_thread') and self._batch_bind_thread and self._batch_bind_thread.is_alive():
            self.log("正在停止批量绑定...")
            self._batch_bind_stop_flag = True

        if hasattr(self, '_batch_delete_thread') and self._batch_delete_thread and self._batch_delete_thread.is_alive():
            self.log("正在停止批量删除...")
            self._batch_delete_stop_flag = True

    # ==================== 任务执行 ====================

    def _startTask(self, task_type: str, accounts: List[dict], browser_ids: List[str]):
        """启动任务"""
        if not self._checkTaskConflicts():
            return

        self.log(f"开始 {task_type} 任务，共 {len(accounts)} 个账号...")

        self._setButtonsEnabled(False)

        # 设置进度条范围和初始值
        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(accounts))
        self.progressBar.setValue(0)

        self.worker_thread = AccountWorkerThread(
            task_type=task_type,
            accounts=accounts,
            browser_ids=browser_ids,
            concurrency=self.concurrencySpin.value(),
            auto_bind_proxy=self.chkAutoBindProxy.isChecked(),
        )

        self.worker_thread.progress.connect(self.log)
        self.worker_thread.progress_value.connect(self._onProgressValue)
        self.worker_thread.finished.connect(self._onTaskFinished)
        self.worker_thread.error.connect(self._onTaskError)

        self.worker_thread.start()

    def _startUnlockTask(
        self,
        accounts: List[dict],
        browser_ids: List[str],
        sms_token: str,
    ):
        """启动解锁任务"""
        if not self._checkTaskConflicts():
            return

        self.log(f"开始解锁任务，共 {len(accounts)} 个账号...")

        self._setButtonsEnabled(False)

        # 设置进度条范围和初始值
        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(accounts))
        self.progressBar.setValue(0)

        self.worker_thread = AccountWorkerThread(
            task_type="unlock_403",
            accounts=accounts,
            browser_ids=browser_ids,
            concurrency=self.concurrencySpin.value(),
            sms_token=sms_token,
            country_id=ConfigManager.get_sms_bus_default_country_id(),
            project_id=ConfigManager.get_sms_bus_default_project_id(),
            max_retries=ConfigManager.get_sms_bus_max_retries(),
        )

        self.worker_thread.progress.connect(self.log)
        self.worker_thread.progress_value.connect(self._onProgressValue)
        self.worker_thread.finished.connect(self._onTaskFinished)
        self.worker_thread.error.connect(self._onTaskError)

        self.worker_thread.start()

    def _onTaskFinished(self, result: dict):
        """任务完成"""
        self._setButtonsEnabled(True)
        # 进度条保持显示，显示完成状态
        # self.progressBar.setVisible(False)  # 不再隐藏

        task_type = result.get("type", "")

        if task_type == "login":
            r = result.get("result", {})
            self.log(f"登录完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "oauth":
            r = result.get("result", {})
            self.log(f"OAuth 完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "login_and_oauth":
            lr = result.get("login_result", {})
            or_ = result.get("oauth_result", {})
            self.log(f"登录+OAuth 完成")
            self.log(f"   登录: 成功 {lr.get('success_count', 0)}, 失败 {lr.get('failed_count', 0)}")
            self.log(f"   OAuth: 成功 {or_.get('success_count', 0)}, 失败 {or_.get('failed_count', 0)}")
        elif task_type == "unlock_403":
            r = result.get("result", {})
            self.log(f"403 解锁完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "detect_pro":
            r = result.get("result", {})
            results_list = r.get("results", [])
            summary = next((item for item in results_list if item.get("_summary")), {})
            pro_regular_count = summary.get("pro_regular_count", 0)
            pro_family_count = summary.get("pro_family_count", 0)
            non_pro_count = summary.get("non_pro_count", 0)
            self.log(f"Pro 检测完成: Pro {pro_regular_count}, Pro(家庭组) {pro_family_count}, 非Pro {non_pro_count}, 失败 {r.get('failed_count', 0)}")

        self._loadData()

    def _onTaskError(self, error: str):
        """任务错误"""
        self._setButtonsEnabled(True)
        self.progressBar.setVisible(False)
        self.log(f"错误: {error}")
        self._showError("错误", f"任务执行出错:\n{error}")

    def _onProgressValue(self, current: int, total: int):
        """进度值更新"""
        self.progressBar.setValue(current)
        self.statusLabel.setText(f"处理中: {current}/{total}")

    def _setButtonsEnabled(self, enabled: bool):
        """设置按钮启用状态"""
        self.btnBatchLogin.setEnabled(enabled)
        self.btnBatchOAuth.setEnabled(enabled)
        self.btnLoginOAuth.setEnabled(enabled)
        self.btnBatchBind.setEnabled(enabled)
        self.btnDetectPro.setEnabled(enabled)
        self.btnBatchJoinFamily.setEnabled(enabled)
        self.btnEnableFamilySharing.setEnabled(enabled)
        self.btnDetect403.setEnabled(enabled)
        self.btnBatchUnlock.setEnabled(enabled)
        self.btnRefresh.setEnabled(enabled)
        self.btnDelete.setEnabled(enabled)
        self.btnDeleteWithWindow.setEnabled(enabled)
        self.btnStop.setEnabled(not enabled)

    # ==================== 全选功能 ====================

    def _onSelectAllChanged(self, state):
        """全选复选框状态变化"""
        is_checked = state == Qt.CheckState.Checked.value

        checked_count = 0
        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(CheckBox)
                if checkbox:
                    checkbox.setChecked(is_checked)
                    if is_checked:
                        checked_count += 1

        self._updateSelectedCount()

    def _updateSelectedCount(self):
        """更新选中计数"""
        count = 0
        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(CheckBox)
                if checkbox and checkbox.isChecked():
                    count += 1

        self.selectedCountLabel.setText(f"已选: {count}")

    # ==================== 日志和消息 ====================

    def log(self, msg: str):
        """添加日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.logText.append(f"[{timestamp}] {msg}")
        scrollbar = self.logText.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _showInfo(self, title: str, content: str):
        """显示信息提示"""
        InfoBar.info(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=3000,
            parent=self
        )

    def _showWarning(self, title: str, content: str):
        """显示警告提示"""
        InfoBar.warning(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=4000,
            parent=self
        )

    def _showError(self, title: str, content: str):
        """显示错误提示"""
        InfoBar.error(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=5000,
            parent=self
        )

    # ==================== 绑定/解绑窗口 ====================

    def _bindBrowser(self, email: str):
        """绑定浏览器窗口到账号"""
        from qfluentwidgets import ComboBoxDialog

        try:
            windows = get_profile_list(page=1, limit=500)
            if not windows:
                self._showWarning("警告", "未找到可用的浏览器窗口\n请先在主界面创建窗口")
                return

            current_account = DBManager.get_account_by_email(email)
            current_browser_id = current_account.get("browser_profile_id", "") if current_account else ""

            all_accounts = DBManager.get_all_accounts()
            bound_browser_ids = {
                acc.get("browser_profile_id", "")
                for acc in all_accounts
                if acc.get("browser_profile_id") and acc.get("email") != email
            }

            available_windows = [
                w for w in windows
                if str(w.get("profile_id", "")) not in bound_browser_ids
            ]

            if not available_windows:
                self._showWarning("警告", "所有窗口都已被其他账号绑定\n请先创建新窗口")
                return

            items = [
                f"{w.get('profile_id', '')} - {w.get('name', '未命名')}"
                for w in available_windows
            ]

            # 使用简单的 MessageBox 选择
            w = MessageBox(
                "选择窗口",
                f"为账号 {email} 选择窗口:\n\n" + "\n".join(items[:10]) +
                (f"\n...等 {len(items)} 个" if len(items) > 10 else ""),
                self
            )

            if w.exec():
                # 默认选择第一个
                if items:
                    browser_id = items[0].split(" - ")[0].strip()
                    DBManager.bind_account_to_browser(email, browser_id)
                    if current_browser_id:
                        self.log(f"已将账号 {email} 从窗口 {current_browser_id} 重新绑定到 {browser_id}")
                    else:
                        self.log(f"已将账号 {email} 绑定到窗口 {browser_id}")
                    self._loadData()

        except Exception as e:
            self.log(f"绑定窗口失败: {e}")
            self._showError("错误", f"绑定窗口失败:\n{e}")

    def _unbindBrowser(self, email: str):
        """解绑浏览器窗口"""
        try:
            account = DBManager.get_account_by_email(email)
            if not account:
                self.log(f"未找到账号: {email}")
                return

            browser_id = account.get("browser_profile_id", "")
            if not browser_id:
                self.log(f"账号 {email} 未绑定窗口")
                return

            w = MessageBox(
                "确认解绑",
                f"确定要解绑账号 {email} 与窗口 {browser_id} 的绑定吗？",
                self
            )
            if not w.exec():
                return

            DBManager.bind_account_to_browser(email, "")
            self.log(f"已解绑账号 {email} 与窗口 {browser_id}")
            self._loadData()

        except Exception as e:
            self.log(f"解绑窗口失败: {e}")
            self._showError("错误", f"解绑窗口失败:\n{e}")

    # ==================== 删除账号 ====================

    def _deleteSingleAccount(self, email: str):
        """删除单个账号"""
        w = MessageBox(
            "确认删除",
            f"确定要删除账号 {email} 吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。",
            self
        )
        if not w.exec():
            return

        try:
            DBManager.delete_account(email)
            self.log(f"已删除账号: {email}")
            self._loadData()
        except Exception as e:
            self.log(f"删除账号失败: {e}")
            self._showError("错误", f"删除账号失败:\n{e}")

    def _deleteAccountWithWindow(self, email: str, browser_id: str):
        """删除账号和对应的浏览器窗口"""
        from services.ix_api import closeBrowser, deleteBrowser

        w = MessageBox(
            "确认删除",
            f"确定要删除账号 {email} 及其对应的浏览器窗口吗？\n\n"
            f"窗口 ID: {browser_id}\n\n"
            "⚠️ 此操作不可恢复！",
            self
        )
        if not w.exec():
            return

        try:
            try:
                closeBrowser(browser_id)
                self.log(f"已关闭窗口: {browser_id}")
            except Exception:
                pass

            try:
                result = deleteBrowser(browser_id)
                if result.get("success"):
                    self.log(f"已删除窗口: {browser_id}")
                else:
                    self.log(f"删除窗口失败: {result.get('msg', '未知错误')}")
            except Exception as e:
                self.log(f"删除窗口时出错: {e}")

            DBManager.delete_account(email)
            self.log(f"已删除账号: {email}")
            self._loadData()

        except Exception as e:
            self.log(f"删除操作失败: {e}")
            self._showError("错误", f"删除操作失败:\n{e}")

    def _deleteSelectedAccounts(self, with_windows: bool = False):
        """批量删除选中的账号（异步执行）"""
        if not self._checkTaskConflicts(include_batch_delete=True, wait_action="删除"):
            return

        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先勾选要删除的账号")
            return

        msg = AccountManagerService.build_batch_delete_confirm_message(
            total=len(accounts),
            with_windows=with_windows,
        )

        w = MessageBox("确认删除", msg, self)
        if not w.exec():
            return

        # 使用异步线程执行删除
        self.log(f"开始批量删除，共 {len(accounts)} 个账号...")
        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(accounts))
        self.progressBar.setValue(0)
        self._setButtonsEnabled(False)

        # 保存 with_windows 标志用于完成回调
        self._batch_delete_with_windows = with_windows

        self._batch_delete_results = AccountTaskOrchestrator.create_batch_delete_results(len(accounts))
        self._batch_delete_error = ""
        self._batch_delete_stop_flag = False

        from services.ix_api import closeBrowser, deleteBrowser
        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            QMetaObject.invokeMethod(
                self.logText,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def update_progress(value: int):
            QMetaObject.invokeMethod(
                self.progressBar,
                "setValue",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(int, value)
            )
            QMetaObject.invokeMethod(
                self.statusLabel,
                "setText",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"处理中: {value}/{len(accounts)}")
            )

        def run_batch_delete():
            try:
                self._batch_delete_results = AccountTaskOrchestrator.execute_batch_delete(
                    accounts=accounts,
                    browser_ids=browser_ids,
                    with_windows=with_windows,
                    should_stop=lambda: self._batch_delete_stop_flag,
                    delete_account_callback=DBManager.delete_account,
                    close_browser_callback=closeBrowser,
                    delete_browser_callback=deleteBrowser,
                    log_callback=safe_log,
                    progress_callback=update_progress,
                )
            except Exception as error:
                self._batch_delete_error = str(error)
            finally:
                QTimer.singleShot(0, self._onBatchDeleteThreadCompleted)

        self._batch_delete_thread = Thread(target=run_batch_delete, daemon=True)
        self._batch_delete_thread.start()

    def _onBatchDeleteThreadCompleted(self):
        """批量删除线程结束回调（主线程）"""
        if self._batch_delete_error:
            self._onBatchDeleteError(self._batch_delete_error)
            return
        self._onBatchDeleteFinished()

    def _onBatchDeleteFinished(self):
        """批量删除完成回调"""
        self._setButtonsEnabled(True)
        self._batch_delete_thread = None

        total = self._batch_delete_results.get("total", 0)
        deleted_accounts = self._batch_delete_results.get("deleted_accounts", 0)
        deleted_windows = self._batch_delete_results.get("deleted_windows", 0)
        failed_count = self._batch_delete_results.get("failed_count", 0)
        with_windows = getattr(self, '_batch_delete_with_windows', False)

        self.log(f"批量删除完成: 删除账号 {deleted_accounts}/{total}, 失败 {failed_count}")
        self._loadData()

        if with_windows:
            self._showInfo("删除完成", f"已删除 {deleted_accounts} 个账号\n已删除 {deleted_windows} 个窗口")
        else:
            self._showInfo("删除完成", f"已删除 {deleted_accounts} 个账号")

    def _onBatchDeleteError(self, error: str):
        """批量删除错误回调"""
        self._setButtonsEnabled(True)
        self._batch_delete_thread = None
        self.progressBar.setVisible(False)
        self.log(f"批量删除失败: {error}")
        self._showError("错误", f"批量删除失败:\n{error}")

    # ==================== 家庭组功能 ====================

    def _showJoinFamilyDialog(self, email: str):
        """显示加入家庭组对话框"""
        available_pro_accounts = DBManager.get_available_pro_accounts()

        if not available_pro_accounts:
            self._showInfo(
                "提示",
                "没有可用的普通 Pro 账户可以邀请\n\n"
                "需要满足条件:\n"
                "1. is_pro = 'yes' (普通 Pro)\n"
                "2. 家庭成员数量 < 6\n"
                "3. 已登录状态"
            )
            return

        items = []
        for acc in available_pro_accounts:
            pro_email = acc.get("email", "")
            # family_member_count: 0=未检测, 1-6=实际成员数(包括管理员)
            # Pro账户至少有管理员自己，所以最小值应该是1
            raw_count = acc.get("family_member_count", 0) or 0
            count = max(raw_count, 1)  # Pro账户至少有1人(管理员自己)
            available = 6 - count
            items.append(f"{pro_email} ({count}/6) - 可邀请 {available} 人")

        # 使用自定义对话框替代简单的 MessageBox，让用户可以选择具体的 Pro 账户
        from PyQt6.QtWidgets import QDialog, QVBoxLayout as QVBoxLayout2, QLabel, QDialogButtonBox

        dialog = QDialog(self)
        dialog.setWindowTitle("选择 Pro 账户")
        dialog.setMinimumWidth(400)

        layout = QVBoxLayout2(dialog)

        # 提示标签
        layout.addWidget(BodyLabel(f"选择要邀请 {email} 加入的 Pro 家庭组:"))

        # 下拉选择框
        combo = ComboBox()
        combo.addItems(items)
        layout.addWidget(combo)

        # 按钮
        button_box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        button_box.accepted.connect(dialog.accept)
        button_box.rejected.connect(dialog.reject)
        layout.addWidget(button_box)

        if dialog.exec() == QDialog.DialogCode.Accepted and items:
            selected_item = combo.currentText()
            selected_email = selected_item.split(" (")[0]
            selected_account = None
            for acc in available_pro_accounts:
                if acc.get("email") == selected_email:
                    selected_account = acc
                    break

            if selected_account:
                self._joinFamily(email, selected_account)

    def _joinFamily(self, invitee_email: str, inviter_account: dict):
        """执行加入家庭组操作"""
        invitee_account = DBManager.get_account_by_email(invitee_email)
        if not invitee_account:
            self.log(f"未找到账号: {invitee_email}")
            return

        invitee_browser_id = invitee_account.get("browser_profile_id", "")
        inviter_browser_id = inviter_account.get("browser_profile_id", "")

        if not invitee_browser_id:
            self._showWarning("警告", f"被邀请人 {invitee_email} 未绑定浏览器窗口")
            return

        if not inviter_browser_id:
            inviter_email = inviter_account.get("email", "")
            self._showWarning("警告", f"邀请人 {inviter_email} 未绑定浏览器窗口")
            return

        self.log(f"开始加入家庭组: {invitee_email} -> {inviter_account.get('email', '')}")

        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            QMetaObject.invokeMethod(
                self.logText,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def run_async_join():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                from automation.auto_join_family import auto_join_family
                result = loop.run_until_complete(
                    auto_join_family(
                        inviter_account=inviter_account,
                        invitee_account=invitee_account,
                        inviter_browser_id=inviter_browser_id,
                        invitee_browser_id=invitee_browser_id,
                        callback=safe_log,
                    )
                )

                if result.success:
                    safe_log(f"{invitee_email} 成功加入 {inviter_account.get('email', '')} 的家庭组")
                    QTimer.singleShot(0, self._loadData)
                else:
                    safe_log(f"加入家庭组失败: {result.message}")

            except Exception as e:
                safe_log(f"加入家庭组异常: {e}")
            finally:
                loop.close()

        thread = Thread(target=run_async_join, daemon=True)
        thread.start()

    def _allocateToProAccounts(self, invitees: list, pro_accounts: list) -> list:
        """将普通账户分配到 Pro 账户家庭组

        注意：会过滤掉正在被其他任务处理的账户（通过 invite_lock_manager 检查）
        """
        assignments, skipped_locked_count = AccountManagerService.allocate_to_pro_accounts(
            invitees=invitees,
            pro_accounts=pro_accounts,
        )
        self._last_skipped_locked_count = skipped_locked_count
        return assignments

    def onBatchJoinFamily(self):
        """一键加入家庭组"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先勾选要加入家庭组的账号")
            return

        (
            normal_accounts,
            normal_browser_ids,
            skipped_already_pro,
            skipped_not_logged,
            skipped_no_browser,
        ) = AccountManagerService.prepare_family_join_candidates(accounts, browser_ids)

        if not normal_accounts:
            msg = AccountManagerService.build_no_family_candidates_message(
                skipped_already_pro=skipped_already_pro,
                skipped_not_logged=skipped_not_logged,
                skipped_no_browser=skipped_no_browser,
            )
            self._showWarning("警告", msg)
            return

        pro_accounts = AccountManagerService.get_available_pro_accounts()

        if not pro_accounts:
            self._showWarning(
                "警告",
                "没有可用的普通 Pro 账户\n\n"
                "需要满足条件:\n"
                "• is_pro = 'yes' (普通 Pro)\n"
                "• 家庭成员数量 < 6\n"
                "• 已登录状态\n"
                "• 已绑定浏览器窗口"
            )
            return

        assignments = self._allocateToProAccounts(normal_accounts, pro_accounts)

        # 获取被锁定跳过的账户数量
        skipped_locked_count = getattr(self, '_last_skipped_locked_count', 0)

        if not assignments:
            msg = "Pro 账户可用名额不足，无法分配任何账户"
            if skipped_locked_count > 0:
                msg += f"\n\n⚠️ 另有 {skipped_locked_count} 个账户正在被其他任务处理"
            self._showWarning("警告", msg)
            return

        msg = AccountManagerService.build_family_assignments_preview_message(
            assignments=assignments,
            normal_accounts_count=len(normal_accounts),
            skipped_locked_count=skipped_locked_count,
        )

        w = MessageBox("确认加入家庭组", msg, self)
        if not w.exec():
            return

        self._startBatchJoinFamily(assignments)

    def _startBatchJoinFamily(self, assignments: list):
        """启动批量加入家庭组任务"""
        if not self._checkTaskConflicts():
            return

        self.log(f"开始批量加入家庭组，共 {len(assignments)} 个账户...")

        self._setButtonsEnabled(False)

        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(assignments))
        self.progressBar.setValue(0)

        self._batch_join_assignments = assignments
        self._batch_join_results = AccountTaskOrchestrator.create_batch_join_results(len(assignments))
        self._batch_join_stop_flag = False

        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            QMetaObject.invokeMethod(
                self.logText,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def update_progress(value: int):
            QMetaObject.invokeMethod(
                self.progressBar,
                "setValue",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(int, value)
            )

        def run_batch_join():
            try:
                self._batch_join_results = AccountTaskOrchestrator.execute_batch_join_family(
                    assignments=self._batch_join_assignments,
                    should_stop=lambda: self._batch_join_stop_flag,
                    log_callback=safe_log,
                    progress_callback=update_progress,
                )
            finally:
                QTimer.singleShot(0, self._onBatchJoinFamilyFinished)

        self._batch_join_thread = Thread(target=run_batch_join, daemon=True)
        self._batch_join_thread.start()

    def _onBatchJoinFamilyFinished(self):
        """批量加入家庭组完成回调"""
        self._setButtonsEnabled(True)
        self.progressBar.setVisible(False)

        results = self._batch_join_results

        self.log(f"批量加入家庭组完成: 成功 {results['success_count']}, 失败 {results['failed_count']}")

        msg = f"批量加入家庭组完成\n\n"
        msg += f"成功: {results['success_count']}\n"
        msg += f"失败: {results['failed_count']}\n"

        if results['pro_usage']:
            msg += "\nPro 账户使用情况:\n"
            for pro_email, count in results['pro_usage'].items():
                msg += f"  • {pro_email}: +{count}\n"

        if results['failed_list']:
            msg += "\n失败账户:\n"
            for item in results['failed_list'][:5]:
                error_text = item['error']
                if len(error_text) > 30:
                    error_text = error_text[:30] + "..."
                msg += f"  • {item['email']}: {error_text}\n"
            if len(results['failed_list']) > 5:
                msg += f"  ... 等 {len(results['failed_list'])} 个\n"

        self._showInfo("完成", msg)
        self._loadData()

    def refresh(self):
        """刷新数据（供外部调用）"""
        self._loadData()

    # ==================== 开启家庭共享功能 ====================

    def onEnableFamilySharing(self):
        """开启家庭共享按钮点击事件"""
        accounts, browser_ids = self._getSelectedAccounts()

        if not accounts:
            self._showInfo("提示", "请先勾选要开启共享的 Pro 账号")
            return

        (
            valid_accounts,
            valid_browser_ids,
            skipped_not_pro,
            skipped_not_logged,
            skipped_no_browser,
        ) = AccountManagerService.prepare_enable_family_sharing_candidates(accounts, browser_ids)

        if not valid_accounts:
            msg = AccountManagerService.build_no_enable_family_sharing_candidates_message(
                skipped_not_pro=skipped_not_pro,
                skipped_not_logged=skipped_not_logged,
                skipped_no_browser=skipped_no_browser,
            )
            self._showWarning("警告", msg)
            return

        msg = AccountManagerService.build_enable_family_sharing_confirm_message(
            valid_count=len(valid_accounts),
            skipped_not_pro_count=len(skipped_not_pro),
            skipped_not_logged_count=len(skipped_not_logged),
            skipped_no_browser_count=len(skipped_no_browser),
        )

        w = MessageBox("确认开启共享", msg + "\n\n是否继续？", self)
        if not w.exec():
            return

        self._startEnableFamilySharingTask(valid_accounts, valid_browser_ids)

    def _startEnableFamilySharingTask(self, accounts: list, browser_ids: list):
        """启动开启家庭共享任务"""
        if not self._checkTaskConflicts():
            return

        self.log(f"开始批量开启家庭共享，共 {len(accounts)} 个账户...")

        self._setButtonsEnabled(False)

        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(accounts))
        self.progressBar.setValue(0)

        self._enable_sharing_accounts = accounts
        self._enable_sharing_browser_ids = browser_ids
        self._enable_sharing_results = AccountTaskOrchestrator.create_enable_family_sharing_results(len(accounts))
        self._enable_sharing_stop_flag = False

        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            QMetaObject.invokeMethod(
                self.logText,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def update_progress(value: int):
            QMetaObject.invokeMethod(
                self.progressBar,
                "setValue",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(int, value)
            )

        def run_enable_sharing():
            try:
                self._enable_sharing_results = AccountTaskOrchestrator.execute_enable_family_sharing(
                    accounts=self._enable_sharing_accounts,
                    browser_ids=self._enable_sharing_browser_ids,
                    should_stop=lambda: self._enable_sharing_stop_flag,
                    log_callback=safe_log,
                    progress_callback=update_progress,
                )
            finally:
                QTimer.singleShot(0, self._onEnableFamilySharingFinished)

        self._enable_sharing_thread = Thread(target=run_enable_sharing, daemon=True)
        self._enable_sharing_thread.start()

    def _onEnableFamilySharingFinished(self):
        """开启家庭共享完成回调"""
        self._setButtonsEnabled(True)
        self.progressBar.setVisible(False)

        results = self._enable_sharing_results

        # 日志记录（包含创建家庭组数量）
        family_created_info = ""
        if results.get('family_created_count', 0) > 0:
            family_created_info = f", 创建家庭组 {results['family_created_count']}"

        self.log(
            f"开启家庭共享完成: 成功 {results['success_count']}{family_created_info}, "
            f"已开启 {results['already_enabled_count']}, "
            f"失败 {results['failed_count']}"
        )

        msg = f"开启家庭共享完成\n\n"
        msg += f"成功: {results['success_count']}\n"
        # 显示创建家庭组数量（如果有）
        if results.get('family_created_count', 0) > 0:
            msg += f"  ↳ 其中新建家庭组: {results['family_created_count']}\n"
        msg += f"已开启（跳过）: {results['already_enabled_count']}\n"
        msg += f"失败: {results['failed_count']}\n"

        if results['failed_list']:
            msg += "\n失败账户:\n"
            for item in results['failed_list'][:5]:
                error_text = item['error']
                if len(error_text) > 30:
                    error_text = error_text[:30] + "..."
                msg += f"  • {item['email']}: {error_text}\n"
            if len(results['failed_list']) > 5:
                msg += f"  ... 等 {len(results['failed_list'])} 个\n"

        self._showInfo("完成", msg)
        self._loadData()
