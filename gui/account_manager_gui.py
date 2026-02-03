"""
账号管理 GUI

提供账号状态管理、批量登录、批量 OAuth 功能的图形界面。
"""

import asyncio
from typing import List, Optional
from datetime import datetime

from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QTableWidget, QTableWidgetItem,
    QPushButton, QComboBox, QLabel, QTextEdit, QHeaderView, QCheckBox,
    QProgressBar, QMessageBox, QMenu, QWidget, QSpinBox, QGroupBox,
    QSplitter, QAbstractItemView, QInputDialog,
)
from PyQt6.QtCore import Qt, pyqtSignal, QThread, QTimer
from PyQt6.QtGui import QColor, QAction

from services.database import DBManager
from services.sub2api_client import Sub2APIClient
from services.ix_api import get_profile_list
from core.config_manager import ConfigManager


class AccountWorkerThread(QThread):
    """账号处理工作线程"""
    progress = pyqtSignal(str)
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
        max_retries: int = None,  # None = 从配置读取
        auto_bind_proxy: bool = True,  # 自动绑定代理
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
            # 创建事件循环
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

        processor = BatchAccountProcessor(
            concurrency=self.concurrency,
            callback=lambda msg: self.progress.emit(msg),
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


class AccountManagerDialog(QDialog):
    """账号管理对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Google 账号管理")
        self.setMinimumSize(1000, 700)

        self.worker_thread: Optional[AccountWorkerThread] = None
        self._init_ui()
        self._load_data()

    def _init_ui(self):
        """初始化界面"""
        layout = QVBoxLayout(self)

        # 工具栏
        toolbar = self._create_toolbar()
        layout.addWidget(toolbar)

        # 主内容区（使用分割器）
        splitter = QSplitter(Qt.Orientation.Vertical)

        # 表格区域
        self.table = self._create_table()
        splitter.addWidget(self.table)

        # 日志区域
        log_group = QGroupBox("日志输出")
        log_layout = QVBoxLayout(log_group)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(150)
        log_layout.addWidget(self.log_text)
        splitter.addWidget(log_group)

        # 设置分割比例
        splitter.setSizes([500, 150])
        layout.addWidget(splitter)

        # 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        # 状态栏
        self.status_label = QLabel("就绪")
        layout.addWidget(self.status_label)

    def _create_toolbar(self) -> QWidget:
        """创建工具栏"""
        toolbar = QWidget()
        layout = QHBoxLayout(toolbar)
        layout.setContentsMargins(0, 0, 0, 0)

        # 批量登录按钮
        self.btn_batch_login = QPushButton("📥 批量登录")
        self.btn_batch_login.clicked.connect(self.on_batch_login)
        layout.addWidget(self.btn_batch_login)

        # 批量 OAuth 按钮
        self.btn_batch_oauth = QPushButton("🔗 批量 OAuth")
        self.btn_batch_oauth.clicked.connect(self.on_batch_oauth)
        layout.addWidget(self.btn_batch_oauth)

        # 一键登录+OAuth
        self.btn_login_oauth = QPushButton("🚀 一键登录+OAuth")
        self.btn_login_oauth.clicked.connect(self.on_login_and_oauth)
        layout.addWidget(self.btn_login_oauth)

        layout.addSpacing(10)

        # 批量绑定窗口
        self.btn_batch_bind = QPushButton("🔗 批量绑定窗口")
        self.btn_batch_bind.clicked.connect(self.on_batch_bind)
        layout.addWidget(self.btn_batch_bind)

        # 检测 Pro 会员按钮
        self.btn_detect_pro = QPushButton("👑 检测 Pro")
        self.btn_detect_pro.setToolTip("检测选中已登录账号的 Google One Pro 会员状态")
        self.btn_detect_pro.clicked.connect(self.on_detect_pro)
        layout.addWidget(self.btn_detect_pro)

        # 一键加入家庭组按钮
        self.btn_batch_join_family = QPushButton("👨‍👩‍👧 一键加入家庭组")
        self.btn_batch_join_family.setToolTip("批量将普通账户加入到 Pro 账户的家庭组")
        self.btn_batch_join_family.clicked.connect(self.on_batch_join_family)
        layout.addWidget(self.btn_batch_join_family)

        layout.addSpacing(10)

        # 403 解锁按钮
        self.btn_detect_403 = QPushButton("🔍 检测 403")
        self.btn_detect_403.clicked.connect(self.on_detect_403)
        layout.addWidget(self.btn_detect_403)

        self.btn_batch_unlock = QPushButton("🔓 批量解锁 403")
        self.btn_batch_unlock.clicked.connect(self.on_batch_unlock_403)
        layout.addWidget(self.btn_batch_unlock)

        layout.addSpacing(20)

        # 刷新按钮
        self.btn_refresh = QPushButton("🔄 刷新")
        self.btn_refresh.clicked.connect(self._load_data)
        layout.addWidget(self.btn_refresh)

        # 停止按钮
        self.btn_stop = QPushButton("⏹️ 停止")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self.on_stop)
        layout.addWidget(self.btn_stop)

        layout.addSpacing(10)

        # 批量删除按钮
        self.btn_delete = QPushButton("🗑️ 删除选中")
        self.btn_delete.clicked.connect(lambda: self._delete_selected_accounts(with_windows=False))
        layout.addWidget(self.btn_delete)

        self.btn_delete_with_window = QPushButton("🗑️ 删除+窗口")
        self.btn_delete_with_window.setToolTip("删除选中账号及其对应的浏览器窗口")
        self.btn_delete_with_window.clicked.connect(lambda: self._delete_selected_accounts(with_windows=True))
        layout.addWidget(self.btn_delete_with_window)

        layout.addStretch()

        # 筛选器
        layout.addWidget(QLabel("筛选:"))
        self.filter_combo = QComboBox()
        self.filter_combo.addItems([
            "全部",
            "未登录",
            "已登录",
            "登录失败",
            "Pro会员",
            "Pro(普通)",
            "Pro(家庭组)",
            "非Pro",
            "未关联",
            "已关联",
            "OAuth失败",
            "需要解锁",
            "解锁失败",
            "已解锁",
        ])
        self.filter_combo.currentTextChanged.connect(self._apply_filter)
        layout.addWidget(self.filter_combo)

        layout.addSpacing(20)

        # 并发数设置
        layout.addWidget(QLabel("并发数:"))
        self.concurrency_spin = QSpinBox()
        self.concurrency_spin.setRange(1, 10)
        self.concurrency_spin.setValue(ConfigManager.get_login_concurrency())
        layout.addWidget(self.concurrency_spin)

        layout.addSpacing(10)

        # 自动绑定代理复选框
        self.chk_auto_bind_proxy = QCheckBox("自动绑定代理")
        self.chk_auto_bind_proxy.setChecked(True)
        self.chk_auto_bind_proxy.setToolTip("OAuth 成功后自动绑定到使用量最少的代理")
        layout.addWidget(self.chk_auto_bind_proxy)

        return toolbar

    def _create_table(self) -> QTableWidget:
        """创建表格"""
        table = QTableWidget()
        table.setColumnCount(10)
        table.setHorizontalHeaderLabels([
            "选择", "邮箱", "登录状态", "Pro", "窗口名称", "窗口ID", "Sub2API", "解锁状态", "更新时间", "操作"
        ])

        # 设置列宽
        header = table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(7, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(8, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(9, QHeaderView.ResizeMode.Fixed)

        table.setColumnWidth(0, 50)
        table.setColumnWidth(2, 80)
        table.setColumnWidth(3, 50)
        table.setColumnWidth(5, 80)
        table.setColumnWidth(6, 80)
        table.setColumnWidth(7, 80)
        table.setColumnWidth(8, 140)
        table.setColumnWidth(9, 100)

        # 启用右键菜单
        table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        table.customContextMenuRequested.connect(self._show_context_menu)

        # 允许多选
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)

        return table

    def _load_data(self):
        """加载数据"""
        self.log("正在加载账号数据...")

        # 获取所有账号
        accounts = DBManager.get_all_accounts()

        # 获取窗口列表，构建 browser_id -> window_name 映射
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
            self.log(f"⚠️ 获取窗口列表失败: {e}")

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
            checkbox = QCheckBox()
            checkbox_widget = QWidget()
            checkbox_layout = QHBoxLayout(checkbox_widget)
            checkbox_layout.addWidget(checkbox)
            checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkbox_layout.setContentsMargins(0, 0, 0, 0)
            self.table.setCellWidget(row, 0, checkbox_widget)

            # 邮箱
            self.table.setItem(row, 1, QTableWidgetItem(email))

            # 登录状态（失败时显示原因）
            last_error = account.get("last_error", "")
            if login_status == "login_failed" and last_error:
                # 截断过长的错误信息
                short_error = last_error[:20] + "..." if len(last_error) > 20 else last_error
                login_text = f"失败: {short_error}"
            else:
                login_text = self._get_login_status_text(login_status)
            login_item = QTableWidgetItem(login_text)
            login_item.setForeground(self._get_login_status_color(login_status))
            # 设置工具提示显示完整错误信息
            if login_status == "login_failed" and last_error:
                login_item.setToolTip(f"错误原因: {last_error}")
            self.table.setItem(row, 2, login_item)

            # Pro 会员状态
            is_pro = account.get("is_pro", "unknown")
            pro_item = QTableWidgetItem(self._get_pro_status_text(is_pro))
            pro_item.setForeground(self._get_pro_status_color(is_pro))
            # 设置 Tooltip 显示详细说明
            pro_tooltip_map = {
                "unknown": "未检测 Pro 状态",
                "yes": "普通 Pro 会员（自己订阅）",
                "no": "非 Pro 会员",
                "family_yes": "家庭组 Pro 会员（被邀请加入）",
            }
            pro_item.setToolTip(pro_tooltip_map.get(is_pro, "未知状态"))
            self.table.setItem(row, 3, pro_item)

            # 窗口名称（从映射中获取）
            window_name = window_name_map.get(browser_id, "") if browser_id else ""
            self.table.setItem(row, 4, QTableWidgetItem(window_name or "-"))

            # 窗口ID
            self.table.setItem(row, 5, QTableWidgetItem(browser_id or "-"))

            # Sub2API 状态
            sub2api_item = QTableWidgetItem(self._get_sub2api_status_text(sub2api_status))
            sub2api_item.setForeground(self._get_sub2api_status_color(sub2api_status))
            self.table.setItem(row, 6, sub2api_item)

            # 解锁状态
            unlock_item = QTableWidgetItem(self._get_unlock_status_text(unlock_status))
            unlock_item.setForeground(self._get_unlock_status_color(unlock_status))
            self.table.setItem(row, 7, unlock_item)

            # 更新时间
            self.table.setItem(row, 8, QTableWidgetItem(updated_at or "-"))

            # 操作按钮
            btn_widget = QWidget()
            btn_layout = QHBoxLayout(btn_widget)
            btn_layout.setContentsMargins(2, 2, 2, 2)

            if login_status != "logged_in":
                btn = QPushButton("登录")
                btn.setProperty("email", email)
                btn.clicked.connect(lambda _, e=email: self._single_login(e))
            else:
                btn = QPushButton("OAuth")
                btn.setProperty("email", email)
                btn.clicked.connect(lambda _, e=email: self._single_oauth(e))

            btn_layout.addWidget(btn)
            self.table.setCellWidget(row, 9, btn_widget)

        # 更新状态栏
        self.status_label.setText(f"总计 {total} 个 | 已登录 {logged_in} | 已关联 {linked}")
        self.log(f"加载完成，共 {total} 个账号")

    def _get_login_status_text(self, status: str) -> str:
        """获取登录状态显示文本"""
        mapping = {
            "not_logged": "未登录",
            "logging_in": "登录中",
            "logged_in": "已登录",
            "login_failed": "失败",
        }
        return mapping.get(status, status or "未登录")

    def _get_login_status_color(self, status: str) -> QColor:
        """获取登录状态颜色"""
        mapping = {
            "not_logged": QColor("#888888"),
            "logging_in": QColor("#2196F3"),
            "logged_in": QColor("#4CAF50"),
            "login_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    def _get_pro_status_text(self, status: str) -> str:
        """获取 Pro 会员状态显示文本"""
        mapping = {
            "unknown": "-",
            "yes": "✓",
            "no": "✗",
            "family_yes": "👨‍👩‍👧",
        }
        return mapping.get(status, "-")

    def _get_pro_status_color(self, status: str) -> QColor:
        """获取 Pro 会员状态颜色"""
        mapping = {
            "unknown": QColor("#888888"),
            "yes": QColor("#4CAF50"),
            "no": QColor("#F44336"),
            "family_yes": QColor("#2196F3"),
        }
        return mapping.get(status, QColor("#888888"))

    def _get_sub2api_status_text(self, status: str) -> str:
        """获取 Sub2API 状态显示文本"""
        mapping = {
            "not_linked": "未关联",
            "linking": "关联中",
            "linked": "已关联",
            "oauth_failed": "失败",
        }
        return mapping.get(status, status or "未关联")

    def _get_sub2api_status_color(self, status: str) -> QColor:
        """获取 Sub2API 状态颜色"""
        mapping = {
            "not_linked": QColor("#888888"),
            "linking": QColor("#2196F3"),
            "linked": QColor("#4CAF50"),
            "oauth_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    def _get_unlock_status_text(self, status: str) -> str:
        """获取解锁状态显示文本"""
        mapping = {
            "none": "-",
            "needs_unlock": "需解锁",
            "unlocking": "解锁中",
            "unlocked": "已解锁",
            "unlock_failed": "失败",
        }
        return mapping.get(status, status or "-")

    def _get_unlock_status_color(self, status: str) -> QColor:
        """获取解锁状态颜色"""
        mapping = {
            "none": QColor("#888888"),
            "needs_unlock": QColor("#FF9800"),
            "unlocking": QColor("#2196F3"),
            "unlocked": QColor("#4CAF50"),
            "unlock_failed": QColor("#F44336"),
        }
        return mapping.get(status, QColor("#888888"))

    def _apply_filter(self, filter_text: str):
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
                # 登录失败可能显示为"失败"或"失败: xxx"
                show = login_item and login_item.text().startswith("失败")
            elif filter_text == "Pro会员":
                pro_item = self.table.item(row, 3)
                # Pro会员包括普通Pro和家庭组Pro
                show = pro_item and pro_item.text() in ("✓", "👨‍👩‍👧")
            elif filter_text == "Pro(普通)":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "✓"
            elif filter_text == "Pro(家庭组)":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "👨‍👩‍👧"
            elif filter_text == "非Pro":
                pro_item = self.table.item(row, 3)
                show = pro_item and pro_item.text() == "✗"
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

    def _show_context_menu(self, pos):
        """显示右键菜单"""
        menu = QMenu(self)

        # 获取选中行
        row = self.table.rowAt(pos.y())
        if row < 0:
            return

        email_item = self.table.item(row, 1)
        if not email_item:
            return

        email = email_item.text()
        browser_item = self.table.item(row, 5)  # 窗口ID列
        has_browser = browser_item and browser_item.text() != "-"

        # 绑定/解绑窗口选项
        if not has_browser:
            action_bind = QAction("🔗 绑定窗口", self)
            action_bind.triggered.connect(lambda: self._bind_browser(email))
            menu.addAction(action_bind)
        else:
            action_rebind = QAction("🔄 重新绑定窗口", self)
            action_rebind.triggered.connect(lambda: self._bind_browser(email))
            menu.addAction(action_rebind)

            action_unbind = QAction("❌ 解绑窗口", self)
            action_unbind.triggered.connect(lambda: self._unbind_browser(email))
            menu.addAction(action_unbind)

        menu.addSeparator()

        # 添加菜单项
        action_login = QAction("登录", self)
        action_login.triggered.connect(lambda: self._single_login(email))
        menu.addAction(action_login)

        action_oauth = QAction("OAuth", self)
        action_oauth.triggered.connect(lambda: self._single_oauth(email))
        menu.addAction(action_oauth)

        # 获取账号详情以检查 Pro 状态
        account = DBManager.get_account_by_email(email)
        if account:
            is_pro = account.get("is_pro", "unknown")
            login_status = account.get("login_status", "")

            # 为非 Pro 账户添加"加入家庭组"选项
            # 条件：未拥有 Pro (no/unknown)、已登录、已绑定窗口
            if is_pro in ("no", "unknown") and login_status == "logged_in" and has_browser:
                action_join_family = QAction("👨‍👩‍👧 加入家庭组", self)
                action_join_family.triggered.connect(lambda: self._show_join_family_dialog(email))
                menu.addAction(action_join_family)

        menu.addSeparator()

        action_refresh = QAction("刷新", self)
        action_refresh.triggered.connect(self._load_data)
        menu.addAction(action_refresh)

        menu.addSeparator()

        # 删除选项
        action_delete = QAction("🗑️ 删除账号", self)
        action_delete.triggered.connect(lambda: self._delete_single_account(email))
        menu.addAction(action_delete)

        if has_browser:
            browser_id = browser_item.text()
            action_delete_with_window = QAction("🗑️ 删除账号和窗口", self)
            action_delete_with_window.triggered.connect(
                lambda: self._delete_account_with_window(email, browser_id)
            )
            menu.addAction(action_delete_with_window)

        menu.exec(self.table.mapToGlobal(pos))

    def _get_selected_accounts(self) -> tuple[List[dict], List[str]]:
        """获取选中的账号和对应的浏览器 ID"""
        accounts = []
        browser_ids = []

        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue

            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    email_item = self.table.item(row, 1)
                    browser_item = self.table.item(row, 5)  # 窗口ID列

                    if email_item:
                        email = email_item.text()
                        browser_id = browser_item.text() if browser_item else ""

                        # 获取完整账号信息
                        account = DBManager.get_account_by_email(email)
                        if account:
                            accounts.append(account)
                            browser_ids.append(browser_id if browser_id != "-" else "")

        return accounts, browser_ids

    def _single_login(self, email: str):
        """单个账号登录"""
        account = DBManager.get_account_by_email(email)
        if not account:
            self.log(f"❌ 未找到账号: {email}")
            return

        browser_id = account.get("browser_profile_id", "")
        if not browser_id:
            self.log(f"❌ 账号未绑定窗口: {email}")
            QMessageBox.warning(self, "警告", f"账号 {email} 未绑定浏览器窗口")
            return

        self._start_task("login", [account], [browser_id])

    def _single_oauth(self, email: str):
        """单个账号 OAuth"""
        account = DBManager.get_account_by_email(email)
        if not account:
            self.log(f"❌ 未找到账号: {email}")
            return

        browser_id = account.get("browser_profile_id", "")
        if not browser_id:
            self.log(f"❌ 账号未绑定窗口: {email}")
            QMessageBox.warning(self, "警告", f"账号 {email} 未绑定浏览器窗口")
            return

        self._start_task("oauth", [account], [browser_id])

    def _show_join_family_dialog(self, email: str):
        """
        显示加入家庭组对话框

        Args:
            email: 要加入家庭组的普通账号（is_pro = 'no' 或 'unknown'）
        """
        # 获取可用的普通 Pro 账户
        available_pro_accounts = DBManager.get_available_pro_accounts()

        if not available_pro_accounts:
            QMessageBox.information(
                self, "提示",
                "没有可用的普通 Pro 账户可以邀请\n\n"
                "需要满足条件:\n"
                "1. is_pro = 'yes' (普通 Pro)\n"
                "2. 家庭成员数量 < 6\n"
                "3. 已登录状态"
            )
            return

        # 构建选项列表
        items = []
        for acc in available_pro_accounts:
            pro_email = acc.get("email", "")
            count = acc.get("family_member_count", 0) or 1
            available = 6 - count
            items.append(f"{pro_email} ({count}/6) - 可邀请 {available} 人")

        # 显示选择对话框
        item, ok = QInputDialog.getItem(
            self,
            "选择 Pro 账户",
            f"选择要邀请 {email} 加入的 Pro 家庭组:",
            items,
            0,
            False
        )

        if not ok or not item:
            return

        # 解析选中的账户
        selected_email = item.split(" (")[0]
        selected_account = None
        for acc in available_pro_accounts:
            if acc.get("email") == selected_email:
                selected_account = acc
                break

        if not selected_account:
            self.log(f"❌ 未找到选中的 Pro 账户: {selected_email}")
            return

        # 确认操作
        reply = QMessageBox.question(
            self, "确认加入家庭组",
            f"确定要将 {email} 加入 {selected_email} 的家庭组吗?\n\n"
            f"流程:\n"
            f"1. 在 {selected_email} 窗口发送邀请\n"
            f"2. 在 {email} 窗口接受邀请\n\n"
            f"⚠️ 请确保两个账号都已登录且有绑定窗口",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )

        if reply != QMessageBox.StandardButton.Yes:
            return

        # 执行加入操作
        self._join_family(email, selected_account)

    def _join_family(self, invitee_email: str, inviter_account: dict):
        """
        执行加入家庭组操作

        Args:
            invitee_email: 被邀请人邮箱（family_yes 账户）
            inviter_account: 邀请人账户信息（普通 Pro）
        """
        # 获取被邀请人账户
        invitee_account = DBManager.get_account_by_email(invitee_email)
        if not invitee_account:
            self.log(f"❌ 未找到账号: {invitee_email}")
            return

        # 检查窗口绑定
        invitee_browser_id = invitee_account.get("browser_profile_id", "")
        inviter_browser_id = inviter_account.get("browser_profile_id", "")

        if not invitee_browser_id:
            QMessageBox.warning(self, "警告", f"被邀请人 {invitee_email} 未绑定浏览器窗口")
            return

        if not inviter_browser_id:
            inviter_email = inviter_account.get("email", "")
            QMessageBox.warning(self, "警告", f"邀请人 {inviter_email} 未绑定浏览器窗口")
            return

        # 创建工作线程执行异步任务
        self.log(f"开始加入家庭组: {invitee_email} -> {inviter_account.get('email', '')}")

        # 使用单独的线程执行
        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            """线程安全的日志函数"""
            # 使用 QMetaObject.invokeMethod 在主线程执行
            QMetaObject.invokeMethod(
                self.log_text,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def run_async_join():
            import asyncio
            from automation.auto_join_family import auto_join_family

            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
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
                    safe_log(f"✅ {invitee_email} 成功加入 {inviter_account.get('email', '')} 的家庭组")
                    # 刷新表格
                    QTimer.singleShot(0, self._load_data)
                else:
                    safe_log(f"❌ 加入家庭组失败: {result.message}")

            except Exception as e:
                safe_log(f"❌ 加入家庭组异常: {e}")
            finally:
                loop.close()

        thread = Thread(target=run_async_join, daemon=True)
        thread.start()

    def on_batch_login(self):
        """批量登录"""
        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先选择要登录的账号")
            return

        # 检查是否都有绑定窗口
        missing = [a["email"] for a, b in zip(accounts, browser_ids) if not b]
        if missing:
            QMessageBox.warning(
                self, "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}" +
                (f"\n...等 {len(missing)} 个" if len(missing) > 5 else "")
            )
            return

        self._start_task("login", accounts, browser_ids)

    def on_batch_oauth(self):
        """批量 OAuth"""
        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先选择要进行 OAuth 的账号")
            return

        # 检查是否都有绑定窗口
        missing = [a["email"] for a, b in zip(accounts, browser_ids) if not b]
        if missing:
            QMessageBox.warning(
                self, "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}"
            )
            return

        self._start_task("oauth", accounts, browser_ids)

    def on_login_and_oauth(self):
        """一键登录+OAuth"""
        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先选择账号")
            return

        # 检查是否都有绑定窗口
        missing = [a["email"] for a, b in zip(accounts, browser_ids) if not b]
        if missing:
            QMessageBox.warning(
                self, "警告",
                f"以下账号未绑定窗口:\n{', '.join(missing[:5])}"
            )
            return

        self._start_task("login_and_oauth", accounts, browser_ids)

    def on_batch_bind(self):
        """批量绑定窗口（根据窗口名称匹配邮箱）"""
        # 获取未绑定窗口的选中账号
        unbound_accounts = []
        for row in range(self.table.rowCount()):
            if self.table.isRowHidden(row):
                continue

            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    browser_item = self.table.item(row, 5)  # 窗口ID列
                    if not browser_item or browser_item.text() == "-":
                        email_item = self.table.item(row, 1)
                        if email_item:
                            unbound_accounts.append(email_item.text())

        if not unbound_accounts:
            QMessageBox.information(self, "提示", "请先选择未绑定窗口的账号")
            return

        # 获取所有窗口
        try:
            windows = get_profile_list(page=1, limit=500)
            if not windows:
                QMessageBox.warning(self, "警告", "未找到可用的浏览器窗口\n请先在主界面创建窗口")
                return

            # 获取已绑定的窗口ID列表
            all_accounts = DBManager.get_all_accounts()
            bound_browser_ids = {
                acc.get("browser_profile_id", "")
                for acc in all_accounts
                if acc.get("browser_profile_id")
            }

            # 构建窗口名称到ID的映射（忽略大小写）
            window_map = {}
            for w in windows:
                name = w.get("name", "").strip().lower()
                profile_id = str(w.get("profile_id", ""))
                if name and profile_id:
                    window_map[name] = profile_id

            # 匹配账号和窗口
            matched = []
            not_matched = []
            already_bound = []
            for email in unbound_accounts:
                email_lower = email.strip().lower()
                if email_lower in window_map:
                    browser_id = window_map[email_lower]
                    # 检查窗口是否已被其他账号绑定
                    if browser_id in bound_browser_ids:
                        already_bound.append((email, browser_id))
                    else:
                        matched.append((email, browser_id))
                else:
                    not_matched.append(email)

            if not matched:
                msg = "未找到可用的匹配窗口！\n\n"
                if already_bound:
                    msg += f"⚠️ {len(already_bound)} 个窗口已被其他账号绑定\n"
                if not_matched:
                    msg += f"❌ {len(not_matched)} 个账号未找到匹配窗口"
                QMessageBox.warning(self, "警告", msg)
                return

            # 确认绑定
            msg = f"将绑定 {len(matched)} 个账号到对应窗口"
            if already_bound:
                msg += f"\n\n⚠️ {len(already_bound)} 个窗口已被其他账号绑定（已跳过）"
            if not_matched:
                msg += f"\n\n❌ {len(not_matched)} 个账号未找到匹配窗口:\n{', '.join(not_matched[:5])}"
                if len(not_matched) > 5:
                    msg += f"\n...等 {len(not_matched)} 个"

            reply = QMessageBox.question(
                self, "确认",
                msg + "\n\n是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

            # 执行绑定
            success_count = 0
            for email, browser_id in matched:
                DBManager.bind_account_to_browser(email, browser_id)
                self.log(f"✅ 绑定: {email} -> {browser_id}")
                success_count += 1

            self.log(f"批量绑定完成: {success_count}/{len(unbound_accounts)}")
            if not_matched:
                self.log(f"⚠️ 未匹配: {len(not_matched)} 个")
            self._load_data()

        except Exception as e:
            self.log(f"❌ 批量绑定失败: {e}")
            QMessageBox.critical(self, "错误", f"批量绑定失败:\n{e}")

    def on_detect_pro(self):
        """检测选中账号的 Pro 会员状态"""
        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先选择要检测的账号")
            return

        # 筛选已登录且有窗口绑定的账号
        valid_accounts = []
        valid_browser_ids = []
        skipped_not_logged = []
        skipped_no_browser = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            login_status = account.get("login_status", "")

            if login_status != "logged_in":
                skipped_not_logged.append(email)
                continue

            if not browser_id:
                skipped_no_browser.append(email)
                continue

            valid_accounts.append(account)
            valid_browser_ids.append(browser_id)

        if not valid_accounts:
            msg = "没有可检测的账号\n\n"
            if skipped_not_logged:
                msg += f"❌ {len(skipped_not_logged)} 个未登录\n"
            if skipped_no_browser:
                msg += f"❌ {len(skipped_no_browser)} 个未绑定窗口"
            QMessageBox.warning(self, "警告", msg)
            return

        # 确认执行
        msg = f"将检测 {len(valid_accounts)} 个已登录账号的 Pro 状态"
        if skipped_not_logged:
            msg += f"\n\n⚠️ 跳过 {len(skipped_not_logged)} 个未登录账号"
        if skipped_no_browser:
            msg += f"\n⚠️ 跳过 {len(skipped_no_browser)} 个未绑定窗口账号"

        reply = QMessageBox.question(
            self, "确认检测",
            msg + "\n\n是否继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 启动检测任务
        self._start_task("detect_pro", valid_accounts, valid_browser_ids)

    def on_detect_403(self):
        """检测 403 需要解锁的账号"""
        self.log("正在检测需要解锁的账号...")

        try:
            import asyncio

            async def detect_403_accounts():
                """异步检测 403 账号"""
                async with Sub2APIClient() as client:
                    # 获取已关联 Sub2API 的账号
                    linked_accounts = DBManager.get_accounts_by_sub2api_status("linked")
                    if not linked_accounts:
                        return {"total": 0, "needs_unlock": 0, "accounts": []}

                    needs_unlock = []
                    for account in linked_accounts:
                        email = account.get("email", "")
                        account_id = account.get("sub2api_account_id")

                        # 如果没有 account_id，尝试从 Sub2API 查询
                        if not account_id:
                            self.log(f"[{email}] 缺少 account_id，正在查询...")
                            account_id = await client.check_account_exists(email)
                            if account_id:
                                # 更新到数据库
                                DBManager.update_sub2api_status(email, "linked", account_id=account_id)
                                self.log(f"[{email}] 已获取 account_id: {account_id}")
                            else:
                                # 账号在 Sub2API 中不存在，修正状态
                                self.log(f"[{email}] ⚠️ 在 Sub2API 中未找到，修正状态为未关联")
                                DBManager.update_sub2api_status(email, "not_linked")
                                continue

                        self.log(f"[{email}] 检测中...")
                        response = await client.test_account_connection(account_id)

                        if not response.success:
                            data = response.data or {}
                            if data.get("needs_unlock"):
                                validation_url = data.get("validation_url", "")
                                DBManager.update_unlock_status(email, "needs_unlock", validation_url)
                                needs_unlock.append(email)
                                self.log(f"[{email}] ⚠️ 需要解锁")
                            else:
                                self.log(f"[{email}] ❌ 检测失败: {response.error}")
                        else:
                            self.log(f"[{email}] ✅ 正常")

                    return {
                        "total": len(linked_accounts),
                        "needs_unlock": len(needs_unlock),
                        "accounts": needs_unlock,
                    }

            # 运行异步任务
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                result = loop.run_until_complete(detect_403_accounts())
            finally:
                loop.close()

            self.log(f"检测完成: 共 {result['total']} 个账号，{result['needs_unlock']} 个需要解锁")

            if result['needs_unlock'] > 0:
                QMessageBox.information(
                    self, "检测完成",
                    f"共检测 {result['total']} 个已关联账号\n"
                    f"发现 {result['needs_unlock']} 个需要解锁\n\n"
                    f"账号: {', '.join(result['accounts'][:5])}"
                    + (f"\n...等 {result['needs_unlock']} 个" if result['needs_unlock'] > 5 else "")
                )
            else:
                QMessageBox.information(self, "检测完成", f"共检测 {result['total']} 个账号，无需解锁")

            self._load_data()

        except Exception as e:
            self.log(f"❌ 检测失败: {e}")
            QMessageBox.critical(self, "错误", f"检测失败:\n{e}")

    def on_batch_unlock_403(self):
        """批量解锁 403 账号 - 支持选择特定账号或处理全部"""
        # 首先尝试获取用户选中的账号
        selected_accounts, selected_browser_ids = self._get_selected_accounts()

        # 筛选出需要解锁的账号（unlock_status 为 needs_unlock 或 unlock_failed）
        accounts_to_unlock = []
        browser_ids = []

        if selected_accounts:
            # 用户选中了账号，只处理选中且需要解锁的账号
            for account, browser_id in zip(selected_accounts, selected_browser_ids):
                unlock_status = account.get("unlock_status", "")
                if unlock_status in ("needs_unlock", "unlock_failed"):
                    accounts_to_unlock.append(account)
                    browser_ids.append(browser_id)

            if not accounts_to_unlock:
                QMessageBox.information(
                    self, "提示",
                    "选中的账号中没有需要解锁的\n\n"
                    "请选择 unlock_status 为 needs_unlock 或 unlock_failed 的账号"
                )
                return

            self.log(f"用户选中了 {len(selected_accounts)} 个账号，其中 {len(accounts_to_unlock)} 个需要解锁")
        else:
            # 用户没有选中账号，询问是否处理全部需要解锁的账号
            all_needing_unlock = DBManager.get_accounts_needing_unlock()

            if not all_needing_unlock:
                QMessageBox.information(self, "提示", "没有需要解锁的账号\n请先点击「检测 403」按钮")
                return

            reply = QMessageBox.question(
                self, "确认",
                f"未选择账号，是否解锁全部 {len(all_needing_unlock)} 个需要解锁的账号？\n\n"
                "提示: 可以先勾选要解锁的账号再点击此按钮",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

            for account in all_needing_unlock:
                browser_id = account.get("browser_profile_id", "")
                if browser_id:
                    accounts_to_unlock.append(account)
                    browser_ids.append(browser_id)

        # 检查 SMS-Bus Token
        sms_token = ConfigManager.get_sms_bus_token()
        if not sms_token:
            QMessageBox.warning(
                self, "警告",
                "请先配置 SMS-Bus Token\n\n"
                "在「配置管理」→「Sub2API 设置」→「SMS-Bus」中设置 API Token"
            )
            return

        # 筛选有浏览器绑定的账号
        accounts_with_browser = []
        valid_browser_ids = []
        no_browser = []

        for account, browser_id in zip(accounts_to_unlock, browser_ids):
            if browser_id and browser_id != "-":
                accounts_with_browser.append(account)
                valid_browser_ids.append(browser_id)
            else:
                no_browser.append(account.get("email", ""))

        if not accounts_with_browser:
            QMessageBox.warning(self, "警告", "所有需要解锁的账号都未绑定窗口")
            return

        # 显示配置信息（调试用）
        country_id = ConfigManager.get_sms_bus_default_country_id()
        project_id = ConfigManager.get_sms_bus_default_project_id()
        self.log(f"SMS-Bus 配置: country_id={country_id}, project_id={project_id}")

        # 确认执行
        msg = f"将解锁 {len(accounts_with_browser)} 个账号"
        if no_browser:
            msg += f"\n\n⚠️ {len(no_browser)} 个账号未绑定窗口（已跳过）"
        msg += f"\n\n国家ID: {country_id or '自动'} | 服务ID: {project_id or '自动'}"

        reply = QMessageBox.question(
            self, "确认解锁",
            msg + "\n\n是否继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 启动解锁任务
        self._start_unlock_task(accounts_with_browser, valid_browser_ids, sms_token)

    def _start_unlock_task(
        self,
        accounts: List[dict],
        browser_ids: List[str],
        sms_token: str,
    ):
        """启动解锁任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            QMessageBox.warning(self, "警告", "已有任务在执行中")
            return

        # 检查批量加入家庭组任务是否在执行
        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            QMessageBox.warning(self, "警告", "批量加入家庭组任务正在执行中")
            return

        self.log(f"开始解锁任务，共 {len(accounts)} 个账号...")

        # 禁用按钮
        self._set_buttons_enabled(False)

        # 显示进度条
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, 0)

        # 创建工作线程
        self.worker_thread = AccountWorkerThread(
            task_type="unlock_403",
            accounts=accounts,
            browser_ids=browser_ids,
            concurrency=self.concurrency_spin.value(),
            sms_token=sms_token,
            country_id=ConfigManager.get_sms_bus_default_country_id(),
            project_id=ConfigManager.get_sms_bus_default_project_id(),
            max_retries=ConfigManager.get_sms_bus_max_retries(),
        )

        self.worker_thread.progress.connect(self.log)
        self.worker_thread.finished.connect(self._on_task_finished)
        self.worker_thread.error.connect(self._on_task_error)

        self.worker_thread.start()

    def on_stop(self):
        """停止任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            self.log("正在停止...")
            self.worker_thread.stop()

        # 停止批量加入家庭组任务
        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            self.log("正在停止批量加入家庭组...")
            self._batch_join_stop_flag = True

    def _start_task(self, task_type: str, accounts: List[dict], browser_ids: List[str]):
        """启动任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            QMessageBox.warning(self, "警告", "已有任务在执行中")
            return

        # 检查批量加入家庭组任务是否在执行
        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            QMessageBox.warning(self, "警告", "批量加入家庭组任务正在执行中")
            return

        self.log(f"开始 {task_type} 任务，共 {len(accounts)} 个账号...")

        # 禁用按钮
        self._set_buttons_enabled(False)

        # 显示进度条
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, 0)  # 不确定进度

        # 创建工作线程
        self.worker_thread = AccountWorkerThread(
            task_type=task_type,
            accounts=accounts,
            browser_ids=browser_ids,
            concurrency=self.concurrency_spin.value(),
            auto_bind_proxy=self.chk_auto_bind_proxy.isChecked(),
        )

        self.worker_thread.progress.connect(self.log)
        self.worker_thread.finished.connect(self._on_task_finished)
        self.worker_thread.error.connect(self._on_task_error)

        self.worker_thread.start()

    def _on_task_finished(self, result: dict):
        """任务完成"""
        self._set_buttons_enabled(True)
        self.progress_bar.setVisible(False)

        task_type = result.get("type", "")

        if task_type == "login":
            r = result.get("result", {})
            self.log(f"✅ 登录完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "oauth":
            r = result.get("result", {})
            self.log(f"✅ OAuth 完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "login_and_oauth":
            lr = result.get("login_result", {})
            or_ = result.get("oauth_result", {})
            self.log(f"✅ 登录+OAuth 完成")
            self.log(f"   登录: 成功 {lr.get('success_count', 0)}, 失败 {lr.get('failed_count', 0)}")
            self.log(f"   OAuth: 成功 {or_.get('success_count', 0)}, 失败 {or_.get('failed_count', 0)}")
        elif task_type == "unlock_403":
            r = result.get("result", {})
            self.log(f"✅ 403 解锁完成: 成功 {r.get('success_count', 0)}, 失败 {r.get('failed_count', 0)}, 跳过 {r.get('skipped_count', 0)}")
        elif task_type == "detect_pro":
            r = result.get("result", {})
            # 从 results 数组中查找 _summary 条目获取统计
            results_list = r.get("results", [])
            summary = next((item for item in results_list if item.get("_summary")), {})
            pro_regular_count = summary.get("pro_regular_count", 0)
            pro_family_count = summary.get("pro_family_count", 0)
            non_pro_count = summary.get("non_pro_count", 0)
            self.log(f"✅ Pro 检测完成: Pro(普通) {pro_regular_count}, Pro(家庭组) {pro_family_count}, 非Pro {non_pro_count}, 失败 {r.get('failed_count', 0)}")

        # 刷新数据
        self._load_data()

    def _on_task_error(self, error: str):
        """任务错误"""
        self._set_buttons_enabled(True)
        self.progress_bar.setVisible(False)
        self.log(f"❌ 错误: {error}")
        QMessageBox.critical(self, "错误", f"任务执行出错:\n{error}")

    def _set_buttons_enabled(self, enabled: bool):
        """设置按钮启用状态"""
        self.btn_batch_login.setEnabled(enabled)
        self.btn_batch_oauth.setEnabled(enabled)
        self.btn_login_oauth.setEnabled(enabled)
        self.btn_batch_bind.setEnabled(enabled)
        self.btn_detect_pro.setEnabled(enabled)
        self.btn_batch_join_family.setEnabled(enabled)
        self.btn_detect_403.setEnabled(enabled)
        self.btn_batch_unlock.setEnabled(enabled)
        self.btn_refresh.setEnabled(enabled)
        self.btn_delete.setEnabled(enabled)
        self.btn_delete_with_window.setEnabled(enabled)
        self.btn_stop.setEnabled(not enabled)

    def log(self, msg: str):
        """添加日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.log_text.append(f"[{timestamp}] {msg}")
        # 滚动到底部
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _bind_browser(self, email: str):
        """绑定浏览器窗口到账号（支持重新绑定）"""
        from PyQt6.QtWidgets import QInputDialog

        # 获取可用窗口列表
        try:
            windows = get_profile_list(page=1, limit=500)
            if not windows:
                QMessageBox.warning(self, "警告", "未找到可用的浏览器窗口\n请先在主界面创建窗口")
                return

            # 获取当前账号信息
            current_account = DBManager.get_account_by_email(email)
            current_browser_id = current_account.get("browser_profile_id", "") if current_account else ""

            # 获取已绑定的窗口ID列表（排除当前账号已绑定的窗口）
            all_accounts = DBManager.get_all_accounts()
            bound_browser_ids = {
                acc.get("browser_profile_id", "")
                for acc in all_accounts
                if acc.get("browser_profile_id") and acc.get("email") != email
            }

            # 过滤出未绑定的窗口
            available_windows = [
                w for w in windows
                if str(w.get("profile_id", "")) not in bound_browser_ids
            ]

            if not available_windows:
                QMessageBox.warning(self, "警告", "所有窗口都已被其他账号绑定\n请先创建新窗口")
                return

            # 构建选项列表
            items = [
                f"{w.get('profile_id', '')} - {w.get('name', '未命名')}"
                for w in available_windows
            ]

            # 显示选择对话框
            title = "重新绑定窗口" if current_browser_id else "绑定窗口"
            item, ok = QInputDialog.getItem(
                self, title,
                f"为账号 {email} 选择要绑定的窗口:",
                items, 0, False
            )

            if ok and item:
                # 解析窗口ID
                browser_id = item.split(" - ")[0].strip()
                if browser_id:
                    # 执行绑定（会自动覆盖旧绑定）
                    DBManager.bind_account_to_browser(email, browser_id)
                    if current_browser_id:
                        self.log(f"✅ 已将账号 {email} 从窗口 {current_browser_id} 重新绑定到 {browser_id}")
                    else:
                        self.log(f"✅ 已将账号 {email} 绑定到窗口 {browser_id}")
                    self._load_data()  # 刷新数据

        except Exception as e:
            self.log(f"❌ 绑定窗口失败: {e}")
            QMessageBox.critical(self, "错误", f"绑定窗口失败:\n{e}")

    def _unbind_browser(self, email: str):
        """解绑浏览器窗口"""
        try:
            account = DBManager.get_account_by_email(email)
            if not account:
                self.log(f"❌ 未找到账号: {email}")
                return

            browser_id = account.get("browser_profile_id", "")
            if not browser_id:
                self.log(f"⚠️ 账号 {email} 未绑定窗口")
                return

            # 确认解绑
            reply = QMessageBox.question(
                self, "确认解绑",
                f"确定要解绑账号 {email} 与窗口 {browser_id} 的绑定吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

            # 执行解绑（设置为空字符串）
            DBManager.bind_account_to_browser(email, "")
            self.log(f"✅ 已解绑账号 {email} 与窗口 {browser_id}")
            self._load_data()  # 刷新数据

        except Exception as e:
            self.log(f"❌ 解绑窗口失败: {e}")
            QMessageBox.critical(self, "错误", f"解绑窗口失败:\n{e}")

    def _delete_single_account(self, email: str):
        """删除单个账号（不删除窗口）"""
        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除账号 {email} 吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        try:
            DBManager.delete_account(email)
            self.log(f"✅ 已删除账号: {email}")
            self._load_data()
        except Exception as e:
            self.log(f"❌ 删除账号失败: {e}")
            QMessageBox.critical(self, "错误", f"删除账号失败:\n{e}")

    def _delete_account_with_window(self, email: str, browser_id: str):
        """删除账号和对应的浏览器窗口"""
        from services.ix_api import closeBrowser, deleteBrowser

        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除账号 {email} 及其对应的浏览器窗口吗？\n\n"
            f"窗口 ID: {browser_id}\n\n"
            "⚠️ 此操作不可恢复！",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        try:
            # 先关闭窗口（如果正在运行）
            try:
                closeBrowser(browser_id)
                self.log(f"已关闭窗口: {browser_id}")
            except Exception:
                pass  # 忽略关闭错误

            # 删除窗口
            try:
                result = deleteBrowser(browser_id)
                if result.get("success"):
                    self.log(f"✅ 已删除窗口: {browser_id}")
                else:
                    self.log(f"⚠️ 删除窗口失败: {result.get('msg', '未知错误')}")
            except Exception as e:
                self.log(f"⚠️ 删除窗口时出错: {e}")

            # 删除账号
            DBManager.delete_account(email)
            self.log(f"✅ 已删除账号: {email}")
            self._load_data()

        except Exception as e:
            self.log(f"❌ 删除操作失败: {e}")
            QMessageBox.critical(self, "错误", f"删除操作失败:\n{e}")

    def _delete_selected_accounts(self, with_windows: bool = False):
        """批量删除选中的账号"""
        from services.ix_api import closeBrowser, deleteBrowser

        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先勾选要删除的账号")
            return

        # 确认删除
        if with_windows:
            msg = f"确定要删除选中的 {len(accounts)} 个账号及其对应的浏览器窗口吗？\n\n⚠️ 此操作不可恢复！"
        else:
            msg = f"确定要删除选中的 {len(accounts)} 个账号吗？\n\n注意：仅删除账号记录，不会删除对应的浏览器窗口。"

        reply = QMessageBox.question(
            self, "确认删除",
            msg,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        deleted_accounts = 0
        deleted_windows = 0

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")

            try:
                # 如果需要删除窗口
                if with_windows and browser_id:
                    # 先关闭窗口
                    try:
                        closeBrowser(browser_id)
                    except Exception:
                        pass

                    # 删除窗口
                    try:
                        result = deleteBrowser(browser_id)
                        if result.get("success"):
                            deleted_windows += 1
                    except Exception:
                        pass

                # 删除账号
                DBManager.delete_account(email)
                deleted_accounts += 1
                self.log(f"✅ 已删除: {email}")

            except Exception as e:
                self.log(f"❌ 删除 {email} 失败: {e}")

        # 刷新数据
        self._load_data()

        # 显示结果
        if with_windows:
            QMessageBox.information(
                self, "删除完成",
                f"已删除 {deleted_accounts} 个账号\n已删除 {deleted_windows} 个窗口"
            )
        else:
            QMessageBox.information(
                self, "删除完成",
                f"已删除 {deleted_accounts} 个账号"
            )

    # ==================== 批量加入家庭组功能 ====================

    def _allocate_to_pro_accounts(
        self, invitees: list, pro_accounts: list
    ) -> list:
        """
        将普通账户分配到 Pro 账户家庭组

        Args:
            invitees: 待加入的普通账户列表
            pro_accounts: 可用的 Pro 账户列表（已按 family_member_count 升序排序）

        Returns:
            List[(invitee, pro_account)] 分配结果
        """
        assignments = []
        pro_index = 0

        # 复制一份用于追踪当前容量
        pro_slots = {
            acc['email']: 6 - (acc.get('family_member_count') or 1)
            for acc in pro_accounts
        }

        for invitee in invitees:
            # 找到有空位的 Pro 账户
            while pro_index < len(pro_accounts):
                pro_email = pro_accounts[pro_index]['email']
                if pro_slots[pro_email] > 0:
                    # 分配
                    assignments.append((invitee, pro_accounts[pro_index]))
                    pro_slots[pro_email] -= 1
                    break
                else:
                    # 当前 Pro 已满，切换下一个
                    pro_index += 1
            else:
                # 所有 Pro 都满了，停止分配
                break

        return assignments

    def on_batch_join_family(self):
        """一键加入家庭组 - 主入口"""
        # 1. 获取选中账户
        accounts, browser_ids = self._get_selected_accounts()

        if not accounts:
            QMessageBox.information(self, "提示", "请先勾选要加入家庭组的账号")
            return

        # 2. 过滤出普通账户（is_pro = 'no' 或 'unknown'）
        normal_accounts = []
        normal_browser_ids = []
        skipped_already_pro = []
        skipped_not_logged = []
        skipped_no_browser = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            is_pro = account.get("is_pro", "unknown")
            login_status = account.get("login_status", "")

            # 检查是否已是 Pro
            if is_pro in ("yes", "family_yes"):
                skipped_already_pro.append(email)
                continue

            # 检查是否已登录
            if login_status != "logged_in":
                skipped_not_logged.append(email)
                continue

            # 检查是否绑定窗口
            if not browser_id:
                skipped_no_browser.append(email)
                continue

            normal_accounts.append(account)
            normal_browser_ids.append(browser_id)

        if not normal_accounts:
            msg = "没有可加入家庭组的普通账户\n\n"
            if skipped_already_pro:
                msg += f"⚠️ {len(skipped_already_pro)} 个已是 Pro 会员\n"
            if skipped_not_logged:
                msg += f"⚠️ {len(skipped_not_logged)} 个未登录\n"
            if skipped_no_browser:
                msg += f"⚠️ {len(skipped_no_browser)} 个未绑定窗口"
            QMessageBox.warning(self, "警告", msg)
            return

        # 3. 获取可用的 Pro 账户
        pro_accounts = DBManager.get_available_pro_accounts()

        if not pro_accounts:
            QMessageBox.warning(
                self, "警告",
                "没有可用的普通 Pro 账户\n\n"
                "需要满足条件:\n"
                "• is_pro = 'yes' (普通 Pro)\n"
                "• 家庭成员数量 < 6\n"
                "• 已登录状态\n"
                "• 已绑定浏览器窗口"
            )
            return

        # 4. 分配账户到 Pro 家庭组
        assignments = self._allocate_to_pro_accounts(normal_accounts, pro_accounts)

        if not assignments:
            QMessageBox.warning(self, "警告", "Pro 账户可用名额不足，无法分配任何账户")
            return

        # 计算每个 Pro 账户的分配数量
        pro_usage_preview = {}
        for invitee, pro in assignments:
            pro_email = pro.get("email", "")
            pro_usage_preview[pro_email] = pro_usage_preview.get(pro_email, 0) + 1

        # 5. 显示确认对话框
        unassigned_count = len(normal_accounts) - len(assignments)

        msg = f"即将分配 {len(assignments)} 个普通账户到家庭组\n\n"
        msg += "可用 Pro 账户:\n"
        for pro in pro_accounts[:5]:  # 最多显示5个
            pro_email = pro.get("email", "")
            count = pro.get("family_member_count") or 1
            available = 6 - count
            usage = pro_usage_preview.get(pro_email, 0)
            msg += f"  • {pro_email} ({count}/6)"
            if usage > 0:
                msg += f" ← 分配 {usage} 个"
            msg += "\n"
        if len(pro_accounts) > 5:
            msg += f"  ... 等 {len(pro_accounts)} 个\n"

        msg += "\n分配预览:\n"
        for i, (invitee, pro) in enumerate(assignments[:10]):  # 最多显示10个
            msg += f"  • {invitee.get('email', '')} → {pro.get('email', '')}\n"
        if len(assignments) > 10:
            msg += f"  ... 等 {len(assignments)} 个\n"

        if unassigned_count > 0:
            msg += f"\n⚠️ {unassigned_count} 个账户因 Pro 名额不足未能分配\n"

        if skipped_already_pro or skipped_not_logged or skipped_no_browser:
            msg += "\n跳过的账户:\n"
            if skipped_already_pro:
                msg += f"  • {len(skipped_already_pro)} 个已是 Pro\n"
            if skipped_not_logged:
                msg += f"  • {len(skipped_not_logged)} 个未登录\n"
            if skipped_no_browser:
                msg += f"  • {len(skipped_no_browser)} 个未绑定窗口\n"

        msg += "\n⚠️ 操作将串行执行，每个账户约需 1-2 分钟"

        reply = QMessageBox.question(
            self, "确认加入家庭组",
            msg,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 6. 启动执行
        self._start_batch_join_family(assignments)

    def _start_batch_join_family(self, assignments: list):
        """启动批量加入家庭组任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            QMessageBox.warning(self, "警告", "已有任务在执行中")
            return

        # 检查批量加入家庭组任务是否在执行
        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            QMessageBox.warning(self, "警告", "批量加入家庭组任务正在执行中")
            return

        self.log(f"开始批量加入家庭组，共 {len(assignments)} 个账户...")

        # 禁用按钮
        self._set_buttons_enabled(False)

        # 显示进度条
        self.progress_bar.setVisible(True)
        self.progress_bar.setRange(0, len(assignments))
        self.progress_bar.setValue(0)

        # 保存分配信息用于线程
        self._batch_join_assignments = assignments
        self._batch_join_results = {
            "total": len(assignments),
            "success_count": 0,
            "failed_count": 0,
            "failed_list": [],
            "pro_usage": {},
        }
        self._batch_join_stop_flag = False

        # 使用单独线程执行
        from threading import Thread
        from PyQt6.QtCore import QMetaObject, Q_ARG, Qt as QtCore_Qt

        def safe_log(msg: str):
            """线程安全的日志函数"""
            QMetaObject.invokeMethod(
                self.log_text,
                "append",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(str, f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
            )

        def update_progress(value: int):
            """线程安全的进度更新"""
            QMetaObject.invokeMethod(
                self.progress_bar,
                "setValue",
                QtCore_Qt.ConnectionType.QueuedConnection,
                Q_ARG(int, value)
            )

        def run_batch_join():
            import asyncio
            from automation.auto_join_family import auto_join_family

            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            try:
                for i, (invitee, pro) in enumerate(self._batch_join_assignments):
                    if self._batch_join_stop_flag:
                        safe_log("⏹️ 用户停止任务")
                        break

                    invitee_email = invitee.get("email", "")
                    pro_email = pro.get("email", "")
                    invitee_browser_id = invitee.get("browser_profile_id", "")
                    pro_browser_id = pro.get("browser_profile_id", "")

                    safe_log(f"[{i+1}/{len(self._batch_join_assignments)}] {invitee_email} → {pro_email}")

                    try:
                        result = loop.run_until_complete(
                            auto_join_family(
                                inviter_account=pro,
                                invitee_account=invitee,
                                inviter_browser_id=pro_browser_id,
                                invitee_browser_id=invitee_browser_id,
                                callback=safe_log,
                                close_browser_on_success=False,  # 批量模式不关闭窗口
                            )
                        )

                        if result.success:
                            self._batch_join_results["success_count"] += 1
                            # 更新 Pro 使用量统计
                            self._batch_join_results["pro_usage"][pro_email] = \
                                self._batch_join_results["pro_usage"].get(pro_email, 0) + 1
                            safe_log(f"✅ {invitee_email} 成功加入 {pro_email} 的家庭组")
                        else:
                            self._batch_join_results["failed_count"] += 1
                            self._batch_join_results["failed_list"].append({
                                "email": invitee_email,
                                "error": result.message or "未知错误"
                            })
                            safe_log(f"❌ {invitee_email} 加入失败: {result.message}")

                    except Exception as e:
                        self._batch_join_results["failed_count"] += 1
                        self._batch_join_results["failed_list"].append({
                            "email": invitee_email,
                            "error": str(e)
                        })
                        safe_log(f"❌ {invitee_email} 异常: {e}")

                    # 更新进度
                    update_progress(i + 1)

            finally:
                loop.close()
                # 完成后在主线程更新 UI
                QTimer.singleShot(0, self._on_batch_join_family_finished)

        self._batch_join_thread = Thread(target=run_batch_join, daemon=True)
        self._batch_join_thread.start()

    def _on_batch_join_family_finished(self):
        """批量加入家庭组完成回调"""
        self._set_buttons_enabled(True)
        self.progress_bar.setVisible(False)

        results = self._batch_join_results

        # 显示统计
        msg = f"批量加入家庭组完成\n\n"
        msg += f"✅ 成功: {results['success_count']}\n"
        msg += f"❌ 失败: {results['failed_count']}\n"

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

        self.log(f"✅ 批量加入家庭组完成: 成功 {results['success_count']}, 失败 {results['failed_count']}")

        QMessageBox.information(self, "完成", msg)

        # 刷新数据
        self._load_data()

    def closeEvent(self, event):
        """关闭事件"""
        # 检查 worker_thread
        if self.worker_thread and self.worker_thread.isRunning():
            reply = QMessageBox.question(
                self, "确认",
                "有任务正在执行，确定要关闭吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply == QMessageBox.StandardButton.No:
                event.ignore()
                return

            self.worker_thread.stop()
            self.worker_thread.wait(3000)

        # 检查批量加入家庭组线程
        if hasattr(self, '_batch_join_thread') and self._batch_join_thread.is_alive():
            reply = QMessageBox.question(
                self, "确认",
                "批量加入家庭组任务正在执行，确定要关闭吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply == QMessageBox.StandardButton.No:
                event.ignore()
                return

            self._batch_join_stop_flag = True

        event.accept()


# ==================== 测试代码 ====================

if __name__ == "__main__":
    import sys
    from PyQt6.QtWidgets import QApplication

    # 初始化数据库
    DBManager.init_db()

    app = QApplication(sys.argv)
    dialog = AccountManagerDialog()
    dialog.show()
    sys.exit(app.exec())
