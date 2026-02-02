"""
一键修改身份验证器 (Authenticator App) GUI 窗口
支持批量修改 Google 账号的身份验证器并提取新密钥

使用 AI Agent 模式（Gemini Vision）
AI 配置请在「配置管理 → 全局设置」中设置
"""
import sys
import asyncio
import traceback

from PyQt6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QTextEdit,
    QTreeWidget,
    QTreeWidgetItem,
    QMessageBox,
    QCheckBox,
    QSpinBox,
    QGroupBox,
    QFormLayout,
    QAbstractItemView,
    QComboBox,
    QProgressBar,
    QWidget,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QColor, QBrush

from datetime import datetime, timedelta

from services.ix_api import get_group_list
from services.ix_window import get_browser_list
from services.database import DBManager
from core.config_manager import ConfigManager
from automation.auto_modify_authenticator import auto_modify_authenticator


class LoadDataWorker(QThread):
    """异步加载数据的后台线程"""
    progress_signal = pyqtSignal(int, int, str)  # current, total, message
    finished_signal = pyqtSignal(dict)  # result data
    log_signal = pyqtSignal(str)

    def __init__(self, db_manager):
        super().__init__()
        self.db_manager = db_manager
        self.is_running = True

    def stop(self):
        self.is_running = False

    def run(self):
        try:
            result = {
                'modification_history': {},
                'cached_browsers': [],
                'cached_account_map': {},
                'cached_group_names': {},
                'all_account_data': [],
            }

            # 阶段 1: 获取身份验证器修改历史
            self.progress_signal.emit(1, 4, "正在读取修改历史...")
            if not self.is_running:
                return

            result['modification_history'] = self.db_manager.get_authenticator_modification_history()

            # 阶段 2: 获取数据库账号
            self.progress_signal.emit(2, 4, "正在读取数据库...")
            if not self.is_running:
                return

            db_accounts = self.db_manager.get_all_accounts()
            result['cached_account_map'] = {acc['email']: acc for acc in db_accounts}

            # 阶段 3: 获取分组列表
            self.progress_signal.emit(3, 4, "正在获取分组列表...")
            if not self.is_running:
                return

            all_groups = get_group_list() or []
            cached_group_names = {}
            for g in all_groups:
                gid = g.get('id')
                title = g.get('title', '')
                clean_title = ''.join(c for c in str(title) if c.isprintable())
                if not clean_title or '\ufffd' in clean_title:
                    clean_title = f"分组 {gid}"
                cached_group_names[gid] = clean_title
            cached_group_names[0] = "未分组"
            cached_group_names[1] = "默认分组"
            result['cached_group_names'] = cached_group_names

            # 阶段 4: 获取浏览器列表
            self.progress_signal.emit(4, 4, "正在获取窗口列表...")
            if not self.is_running:
                return

            browsers = get_browser_list(page=1, limit=1000) or []
            result['cached_browsers'] = browsers

            # 预处理所有账号数据
            all_account_data = []
            for browser in browsers:
                gid = browser.get('group_id', 0) or 0

                # 动态添加分组名称
                if gid not in cached_group_names:
                    gname = browser.get('group_name', '') or ''
                    clean_gname = ''.join(c for c in str(gname) if c.isprintable())
                    if not clean_gname or '\ufffd' in clean_gname:
                        clean_gname = f"分组 {gid}"
                    cached_group_names[gid] = clean_gname

                browser_id = browser.get('id', '') or browser.get('profile_id', '')
                browser_name = browser.get('name', '')

                # 从名称或备注中提取邮箱
                email = browser_name
                note = browser.get('note', '') or ''
                if '----' in note:
                    email = note.split('----')[0].strip()
                elif '----' in browser_name:
                    email = browser_name.split('----')[0].strip()

                if '@' not in email:
                    continue

                # 获取对应的账号信息
                account = result['cached_account_map'].get(email, {})

                account_data = {
                    'browser_id': str(browser_id),
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', '') or account.get('secret_key', ''),
                    'group_id': gid,
                }
                all_account_data.append(account_data)

            result['all_account_data'] = all_account_data
            result['cached_group_names'] = cached_group_names

            self.finished_signal.emit(result)

        except Exception as e:
            self.log_signal.emit(f"❌ 加载数据失败: {e}")
            import traceback
            traceback.print_exc()
            self.finished_signal.emit({
                'modification_history': {},
                'cached_browsers': [],
                'cached_account_map': {},
                'cached_group_names': {},
                'all_account_data': [],
                'error': str(e),
            })


class ModifyAuthenticatorWorker(QThread):
    """后台工作线程"""
    progress_signal = pyqtSignal(str, str, str, str)  # browser_id, status, message, new_secret
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)

    def __init__(
        self,
        accounts: list[dict],
        thread_count: int,
        close_after: bool,
        ai_config: dict = None,
        save_to_file: bool = True,
        output_file: str = "已修改密钥.txt",
    ):
        super().__init__()
        self.accounts = accounts
        self.thread_count = max(1, thread_count)
        self.close_after = close_after
        self.ai_config = ai_config or {}
        self.save_to_file = save_to_file
        self.output_file = output_file
        self.is_running = True

    def stop(self):
        self.is_running = False

    def _log(self, message: str):
        self.log_signal.emit(message)

    def run(self):
        try:
            asyncio.run(self._process_all())
        except Exception as e:
            self._log(f"❌ 工作线程异常: {e}")
            traceback.print_exc()
        finally:
            self.finished_signal.emit()

    async def _process_all(self):
        if not self.accounts:
            self._log("⚠️ 没有可处理账号")
            return

        self._log(f"开始处理 {len(self.accounts)} 个账号，并发数: {self.thread_count}")

        # 使用信号量控制并发
        semaphore = asyncio.Semaphore(self.thread_count)

        async def process_one(index: int, account: dict):
            async with semaphore:
                if not self.is_running:
                    return

                browser_id = account.get('browser_id', '')
                email = account.get('email', 'Unknown')

                self._log(f"[{index + 1}] 开始修改身份验证器: {email} ({browser_id})")
                self.progress_signal.emit(browser_id, "处理中", "正在修改...", "")

                try:
                    account_info = {
                        'email': account.get('email', ''),
                        'password': account.get('password', ''),
                        'secret': account.get('secret', ''),
                    }

                    success, msg, new_secret = await auto_modify_authenticator(
                        browser_id,
                        account_info,
                        self.close_after,
                        api_key=self.ai_config.get('api_key'),
                        base_url=self.ai_config.get('base_url'),
                        model=self.ai_config.get('model'),
                        provider=self.ai_config.get('provider'),
                        max_steps=self.ai_config.get('max_steps', 30),
                        save_to_file=self.save_to_file,
                        output_file=self.output_file,
                    )

                    if success:
                        secret_display = f"新密钥: {new_secret[:16]}..." if new_secret and len(new_secret) > 16 else (new_secret or "")
                        self._log(f"[{index + 1}] ✅ {email}: {msg} ({secret_display})")
                        self.progress_signal.emit(browser_id, "成功", msg, new_secret or "")
                    else:
                        self._log(f"[{index + 1}] ❌ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "失败", msg, "")

                except Exception as e:
                    self._log(f"[{index + 1}] ❌ {email}: {e}")
                    self.progress_signal.emit(browser_id, "错误", str(e), "")

        # 并发执行
        tasks = [process_one(i, acc) for i, acc in enumerate(self.accounts)]
        await asyncio.gather(*tasks)

        self._log("✅ 所有账号处理完成")


class ModifyAuthenticatorDialog(QDialog):
    """修改身份验证器主对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键修改身份验证器 (Authenticator App)")
        self.setMinimumSize(950, 700)

        self.worker = None
        self.load_data_worker = None  # 异步加载线程
        self.db_manager = DBManager()
        self.accounts = []
        self.modification_history = {}  # 保存已修改账户的历史记录

        # 数据缓存（避免每次刷新都重新调用 API）
        self._cached_browsers = []
        self._cached_account_map = {}
        self._cached_group_names = {}
        self._all_account_data = []

        self._init_ui()
        # 延迟异步加载数据
        QTimer.singleShot(100, self._start_async_load)

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 说明区域
        info_group = QGroupBox("功能说明")
        info_layout = QVBoxLayout(info_group)
        info_label = QLabel(
            "🔐 此功能用于批量修改 Google 账号的身份验证器（Authenticator App）\n"
            "• 自动提取新的 TOTP 密钥并保存到数据库和文件\n"
            "• 支持已有身份验证器的更换和新增设置\n"
            "• 新密钥会自动用于生成验证码完成验证"
        )
        info_label.setStyleSheet("color: #333; padding: 5px;")
        info_layout.addWidget(info_label)
        layout.addWidget(info_group)

        # 设置区域
        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout(settings_group)

        # 并发数
        self.thread_spin = QSpinBox()
        self.thread_spin.setRange(1, 10)
        self.thread_spin.setValue(1)
        settings_layout.addRow("并发数:", self.thread_spin)

        # 完成后关闭浏览器
        self.close_after_check = QCheckBox("完成后关闭浏览器")
        self.close_after_check.setChecked(False)
        settings_layout.addRow("", self.close_after_check)

        # 保存到文件
        self.save_to_file_check = QCheckBox("同时保存到文件 (已修改密钥.txt)")
        self.save_to_file_check.setChecked(True)
        settings_layout.addRow("", self.save_to_file_check)

        # AI 配置提示
        ai_hint = QLabel("💡 AI 配置请在「配置管理 → 全局设置」中设置")
        ai_hint.setStyleSheet("color: #666; font-size: 11px;")
        settings_layout.addRow("", ai_hint)

        layout.addWidget(settings_group)

        # 账号列表
        list_group = QGroupBox("账号列表（按分组显示）")
        list_layout = QVBoxLayout(list_group)

        # 工具栏
        toolbar = QHBoxLayout()

        self.select_all_btn = QPushButton("全选")
        self.select_all_btn.clicked.connect(self._select_all)
        toolbar.addWidget(self.select_all_btn)

        self.deselect_all_btn = QPushButton("取消全选")
        self.deselect_all_btn.clicked.connect(self._deselect_all)
        toolbar.addWidget(self.deselect_all_btn)

        self.refresh_btn = QPushButton("刷新列表")
        self.refresh_btn.clicked.connect(self._refresh_all)
        toolbar.addWidget(self.refresh_btn)

        self.clear_history_btn = QPushButton("清除已修改记录")
        self.clear_history_btn.clicked.connect(self._clear_modification_history)
        self.clear_history_btn.setStyleSheet("color: #e65100;")
        toolbar.addWidget(self.clear_history_btn)

        # 筛选下拉菜单
        toolbar.addWidget(QLabel("筛选:"))
        self.filter_combo = QComboBox()
        self.filter_combo.addItems([
            "全部",
            "7天内未修改",
            "30天内未修改",
            "90天内未修改",
            "从未修改",
            "自定义天数",
        ])
        self.filter_combo.setMinimumWidth(120)
        self.filter_combo.currentIndexChanged.connect(self._on_filter_changed)
        toolbar.addWidget(self.filter_combo)

        # 自定义天数输入框
        self.custom_days_spin = QSpinBox()
        self.custom_days_spin.setRange(1, 365)
        self.custom_days_spin.setValue(14)
        self.custom_days_spin.setSuffix(" 天")
        self.custom_days_spin.setMinimumWidth(80)
        self.custom_days_spin.setVisible(False)  # 默认隐藏
        self.custom_days_spin.valueChanged.connect(self._apply_filter)
        toolbar.addWidget(self.custom_days_spin)

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        list_layout.addLayout(toolbar)

        # 树形控件（按分组显示）
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "邮箱", "窗口ID", "状态", "上次修改", "新密钥"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 250)
        self.tree.setColumnWidth(2, 120)
        self.tree.setColumnWidth(3, 80)
        self.tree.setColumnWidth(4, 130)  # 上次修改列宽
        self.tree.header().setStretchLastSection(True)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setRootIsDecorated(True)
        self.tree.setIndentation(15)
        self.tree.itemChanged.connect(lambda: self._update_selection_count())

        # 骨架屏加载覆盖层
        self.tree_loading_overlay = QWidget(self.tree)
        self.tree_loading_overlay.setStyleSheet("""
            QWidget {
                background-color: rgba(255, 255, 255, 0.95);
            }
        """)
        overlay_layout = QVBoxLayout(self.tree_loading_overlay)
        overlay_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.loading_label = QLabel("⏳ 正在加载账号列表...")
        self.loading_label.setStyleSheet("""
            QLabel {
                font-size: 14px;
                color: #666;
                padding: 20px;
            }
        """)
        self.loading_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        overlay_layout.addWidget(self.loading_label)

        self.tree_loading_progress = QProgressBar()
        self.tree_loading_progress.setRange(0, 100)
        self.tree_loading_progress.setValue(0)
        self.tree_loading_progress.setFixedWidth(200)
        self.tree_loading_progress.setStyleSheet("""
            QProgressBar {
                border: 1px solid #ddd;
                border-radius: 5px;
                text-align: center;
                height: 16px;
            }
            QProgressBar::chunk {
                background-color: #4CAF50;
                border-radius: 4px;
            }
        """)
        overlay_layout.addWidget(self.tree_loading_progress, alignment=Qt.AlignmentFlag.AlignCenter)

        self.tree_loading_overlay.hide()  # 默认隐藏

        list_layout.addWidget(self.tree)

        layout.addWidget(list_group)

        # 日志区域
        log_group = QGroupBox("执行日志")
        log_layout = QVBoxLayout(log_group)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(150)
        log_layout.addWidget(self.log_text)
        layout.addWidget(log_group)

        # 按钮区域
        btn_layout = QHBoxLayout()

        self.start_btn = QPushButton("开始执行")
        self.start_btn.clicked.connect(self._start_process)
        self.start_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold; padding: 10px;")
        btn_layout.addWidget(self.start_btn)

        self.stop_btn = QPushButton("停止")
        self.stop_btn.clicked.connect(self._stop_process)
        self.stop_btn.setEnabled(False)
        self.stop_btn.setStyleSheet("background-color: #f44336; color: white; padding: 10px;")
        btn_layout.addWidget(self.stop_btn)

        self.close_btn = QPushButton("关闭")
        self.close_btn.clicked.connect(self.close)
        btn_layout.addWidget(self.close_btn)

        layout.addLayout(btn_layout)

    def _start_async_load(self):
        """启动异步数据加载"""
        self._show_loading(True)
        self.tree.clear()

        # 清理旧线程
        if self.load_data_worker is not None:
            if self.load_data_worker.isRunning():
                self.load_data_worker.stop()
                try:
                    self.load_data_worker.progress_signal.disconnect()
                    self.load_data_worker.finished_signal.disconnect()
                    self.load_data_worker.log_signal.disconnect()
                except (TypeError, RuntimeError):
                    pass
                self.load_data_worker.wait(1000)
            self.load_data_worker = None

        self.load_data_worker = LoadDataWorker(self.db_manager)
        self.load_data_worker.progress_signal.connect(self._on_load_progress)
        self.load_data_worker.finished_signal.connect(self._on_load_finished)
        self.load_data_worker.log_signal.connect(self._log)
        self.load_data_worker.start()

    def _show_loading(self, show: bool):
        """显示/隐藏加载状态"""
        if show:
            def adjust_overlay():
                self.tree_loading_overlay.setGeometry(0, 0, self.tree.width(), self.tree.height())
            QTimer.singleShot(10, adjust_overlay)
            self.tree_loading_progress.setValue(0)
            self.loading_label.setText("⏳ 正在加载账号列表...")
            self.tree_loading_overlay.show()
            self.tree_loading_overlay.raise_()
            # 禁用工具栏按钮
            self.refresh_btn.setEnabled(False)
            self.select_all_btn.setEnabled(False)
            self.deselect_all_btn.setEnabled(False)
            self.clear_history_btn.setEnabled(False)
            self.filter_combo.setEnabled(False)
            self.custom_days_spin.setEnabled(False)
            self.start_btn.setEnabled(False)
        else:
            self.tree_loading_overlay.hide()
            # 恢复工具栏按钮
            self.refresh_btn.setEnabled(True)
            self.select_all_btn.setEnabled(True)
            self.deselect_all_btn.setEnabled(True)
            self.clear_history_btn.setEnabled(True)
            self.filter_combo.setEnabled(True)
            self.custom_days_spin.setEnabled(True)
            self.start_btn.setEnabled(True)

    def _on_load_progress(self, current: int, total: int, message: str):
        """加载进度更新"""
        if total > 0:
            pct = int(current / total * 100)
            self.tree_loading_progress.setValue(pct)
            self.loading_label.setText(f"⏳ {message}")

    def _on_load_finished(self, result: dict):
        """加载完成回调"""
        try:
            # 更新缓存
            self.modification_history = result.get('modification_history', {})
            self._cached_browsers = result.get('cached_browsers', [])
            self._cached_account_map = result.get('cached_account_map', {})
            self._cached_group_names = result.get('cached_group_names', {})
            self._all_account_data = result.get('all_account_data', [])

            if result.get('error'):
                self._log(f"⚠️ 加载数据时发生错误: {result.get('error')}")

            # 填充账号树（使用缓存数据）
            self._populate_account_tree()

        except Exception as e:
            self._log(f"❌ 处理加载结果失败: {e}")
            traceback.print_exc()
        finally:
            self._show_loading(False)

    def _refresh_all(self):
        """刷新所有数据（异步）"""
        self._log("正在刷新数据...")
        self._start_async_load()

    def _populate_account_tree(self):
        """
        使用缓存数据填充账号树（本地过滤，不调用 API）
        """
        self.tree.clear()
        self.accounts = []

        # 获取筛选条件
        filter_index = self.filter_combo.currentIndex()
        filter_days = None  # None 表示不筛选
        filter_never_modified = False

        if filter_index == 1:  # 7天内未修改
            filter_days = 7
        elif filter_index == 2:  # 30天内未修改
            filter_days = 30
        elif filter_index == 3:  # 90天内未修改
            filter_days = 90
        elif filter_index == 4:  # 从未修改
            filter_never_modified = True
        elif filter_index == 5:  # 自定义天数
            filter_days = self.custom_days_spin.value()

        now = datetime.now()

        # 按分组组织缓存数据
        grouped = {}
        for account_data in self._all_account_data:
            gid = account_data.get('group_id', 0)
            if gid not in grouped:
                grouped[gid] = []
            grouped[gid].append(account_data)

        # 创建树形结构
        total_count = 0
        modified_count = 0

        for gid in sorted(grouped.keys()):
            account_list = grouped[gid]
            if not account_list:
                continue  # 跳过空分组

            group_name = self._cached_group_names.get(gid, f"分组 {gid}")

            # 分组节点（延迟创建，只有有符合筛选条件的账号才创建）
            group_item = None
            group_account_count = 0

            # 账号子节点
            for account in account_list:
                email = account["email"]

                # 获取修改历史
                history = self.modification_history.get(email)
                modified_at = None
                modified_time_str = ""

                if history:
                    # 解析修改时间
                    modified_at_str = history.get('modified_at', '')
                    if modified_at_str:
                        try:
                            modified_at = datetime.fromisoformat(modified_at_str.replace('Z', '+00:00').replace(' ', 'T'))
                            # 转换为 naive datetime（移除时区信息以便与 now 比较）
                            if modified_at.tzinfo is not None:
                                modified_at = modified_at.replace(tzinfo=None)
                            # 转换为本地时间显示
                            modified_time_str = modified_at.strftime("%Y-%m-%d %H:%M")
                        except Exception:
                            modified_time_str = modified_at_str[:16] if len(modified_at_str) > 16 else modified_at_str

                # 应用筛选条件
                if filter_never_modified:
                    # 只显示从未修改过的
                    if history:
                        continue  # 跳过已修改的
                elif filter_days is not None:
                    # 显示 X 天内未修改的（包括从未修改的）
                    if history and modified_at:
                        days_since_modified = (now - modified_at).days
                        if days_since_modified < filter_days:
                            continue  # 跳过近期修改过的

                # 创建分组节点（延迟创建）
                if group_item is None:
                    group_item = QTreeWidgetItem(self.tree)
                    group_item.setText(0, "")
                    group_item.setFlags(
                        group_item.flags() |
                        Qt.ItemFlag.ItemIsAutoTristate |
                        Qt.ItemFlag.ItemIsUserCheckable
                    )
                    group_item.setCheckState(0, Qt.CheckState.Unchecked)
                    group_item.setExpanded(True)
                    group_item.setData(0, Qt.ItemDataRole.UserRole, {"type": "group", "id": gid})

                    # 设置分组行样式
                    font = group_item.font(1)
                    font.setBold(True)
                    group_item.setFont(1, font)

                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                child.setCheckState(0, Qt.CheckState.Unchecked)  # 默认不选中
                child.setText(1, account["email"])
                child.setText(2, account["browser_id"])

                # 检查是否已修改过
                if history:
                    child.setText(3, "已修改")
                    child.setText(4, modified_time_str)
                    # 显示修改后的新密钥（截取显示）
                    new_secret = history['new_secret']
                    display_secret = f"{new_secret[:12]}..." if len(new_secret) > 12 else new_secret
                    child.setText(5, display_secret)

                    # 设置置灰样式
                    gray_color = QColor(150, 150, 150)
                    gray_brush = QBrush(gray_color)
                    for col in range(6):
                        child.setForeground(col, gray_brush)

                    modified_count += 1
                else:
                    child.setText(3, "待处理")
                    child.setText(4, "")
                    child.setText(5, "")

                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "account": account
                })
                self.accounts.append(account)
                total_count += 1
                group_account_count += 1

            # 更新分组标题（显示筛选后的数量）
            if group_item is not None:
                group_item.setText(1, f"📁 {group_name} ({group_account_count})")

        self._update_selection_count()
        filter_desc = self.filter_combo.currentText()
        if filter_index == 5:  # 自定义天数
            filter_desc = f"{self.custom_days_spin.value()}天内未修改"
        if filter_index > 0:
            self._log(f"已加载 {total_count} 个账号（筛选: {filter_desc}，已修改: {modified_count} 个）")
        else:
            self._log(f"已加载 {total_count} 个账号（已修改: {modified_count} 个）")

    def _on_filter_changed(self, index: int):
        """筛选下拉菜单变化时的处理"""
        # 显示/隐藏自定义天数输入框
        is_custom = (index == 5)  # "自定义天数" 选项索引
        self.custom_days_spin.setVisible(is_custom)
        # 应用筛选
        self._apply_filter()

    def _apply_filter(self):
        """应用筛选条件（使用缓存数据，无 API 调用）"""
        self._populate_account_tree()

    def _select_all(self):
        """全选"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            group_item.setCheckState(0, Qt.CheckState.Checked)
        self._update_selection_count()

    def _deselect_all(self):
        """取消全选"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            group_item.setCheckState(0, Qt.CheckState.Unchecked)
        self._update_selection_count()

    def _update_selection_count(self):
        """更新选中数量"""
        count = 0
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    count += 1
        self.selected_label.setText(f"已选择: {count} 个账号")

    def _get_selected_accounts(self) -> list[dict]:
        """获取选中的账号列表"""
        selected = []
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    data = child.data(0, Qt.ItemDataRole.UserRole)
                    if data and data.get("type") == "browser":
                        selected.append(data.get("account"))
        return selected

    def _log(self, message: str):
        self.log_text.append(message)
        self.log_text.ensureCursorVisible()

    def _get_ai_config(self) -> dict:
        """从全局配置获取 AI 配置"""
        api_key = ConfigManager.get_ai_api_key()
        if not api_key:
            self._log("⚠️ 未检测到 AI API Key，请在「配置管理 → 全局设置」中设置")
        return {
            'api_key': api_key or None,
            'base_url': ConfigManager.get_ai_base_url() or None,
            'model': ConfigManager.get_ai_model(),
            'provider': ConfigManager.get_ai_default_provider(),
            'max_steps': ConfigManager.get_ai_max_steps(),
        }

    def _start_process(self):
        """开始执行"""
        accounts = self._get_selected_accounts()
        if not accounts:
            QMessageBox.warning(self, "警告", "请选择要处理的账号")
            return

        # 获取 AI 配置并检查
        ai_config = self._get_ai_config()
        if not ai_config.get('api_key'):
            QMessageBox.warning(
                self, "AI 配置缺失",
                "未检测到 AI API Key！\n\n"
                "请在「配置管理 → 全局设置 → AI Agent 配置」中：\n"
                "1. 输入 Gemini API Key\n"
                "2. 点击「保存设置」按钮\n\n"
                "或者设置环境变量 GEMINI_API_KEY"
            )
            return

        # 确认
        reply = QMessageBox.question(
            self,
            "确认",
            f"确定要修改 {len(accounts)} 个账号的身份验证器？\n\n"
            "⚠️ 此操作会更换身份验证器密钥，旧密钥将失效！\n"
            "新密钥会自动保存到数据库和文件。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 重置状态
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    child.setText(3, "等待中")
                    child.setText(4, "")  # 上次修改列
                    child.setText(5, "")  # 新密钥列

        # 显示 AI 配置信息
        if ai_config.get('base_url'):
            self._log(f"API Base URL: {ai_config['base_url']}")
        self._log(f"模型: {ai_config.get('model', 'default')}")

        # 创建工作线程
        self.worker = ModifyAuthenticatorWorker(
            accounts,
            self.thread_spin.value(),
            self.close_after_check.isChecked(),
            ai_config=ai_config,
            save_to_file=self.save_to_file_check.isChecked(),
        )
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.log_signal.connect(self._log)

        # 更新 UI 状态
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.thread_spin.setEnabled(False)
        self.close_after_check.setEnabled(False)
        self.save_to_file_check.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.select_all_btn.setEnabled(False)
        self.deselect_all_btn.setEnabled(False)
        self.clear_history_btn.setEnabled(False)
        self.filter_combo.setEnabled(False)
        self.custom_days_spin.setEnabled(False)

        self._log(f"开始处理 {len(accounts)} 个账号...")
        self.worker.start()

    def _stop_process(self):
        """停止执行"""
        if self.worker:
            self.worker.stop()
            self._log("⚠️ 正在停止...")

    def _on_progress(self, browser_id: str, status: str, message: str, new_secret: str):
        """处理进度更新"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(2) == browser_id:
                    child.setText(3, status)
                    # 显示新密钥（截取显示）
                    if new_secret:
                        display_secret = f"{new_secret[:12]}..." if len(new_secret) > 12 else new_secret
                        child.setText(5, display_secret)  # 新密钥列索引5
                    else:
                        child.setText(5, message[:30] if len(message) > 30 else message)

                    # 根据状态设置颜色
                    if status == "成功":
                        child.setBackground(3, Qt.GlobalColor.green)

                        # 更新本地缓存和 UI（数据库已在 auto_modify_authenticator 中保存，这里只更新缓存）
                        if new_secret:
                            data = child.data(0, Qt.ItemDataRole.UserRole)
                            if data and data.get("type") == "browser":
                                email = data.get("account", {}).get("email", "")
                                if email:
                                    # 更新本地缓存（用于筛选和显示，避免重复调用数据库）
                                    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
                                    self.modification_history[email] = {
                                        'new_secret': new_secret,
                                        'modified_at': datetime.now().isoformat()
                                    }
                                    # 更新上次修改列
                                    child.setText(4, now_str)
                                    # 设置置灰样式（跳过状态列，保留绿色背景的可读性）
                                    gray_color = QColor(150, 150, 150)
                                    gray_brush = QBrush(gray_color)
                                    for col in [0, 1, 2, 4, 5]:  # 跳过状态列(3)
                                        child.setForeground(col, gray_brush)

                    elif status == "失败" or status == "错误":
                        child.setBackground(3, Qt.GlobalColor.red)
                    return

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.thread_spin.setEnabled(True)
        self.close_after_check.setEnabled(True)
        self.save_to_file_check.setEnabled(True)
        self.refresh_btn.setEnabled(True)
        self.select_all_btn.setEnabled(True)
        self.deselect_all_btn.setEnabled(True)
        self.clear_history_btn.setEnabled(True)
        self.filter_combo.setEnabled(True)
        self.custom_days_spin.setEnabled(True)

        self._log("✅ 处理完成")
        self.worker = None

    def _clear_modification_history(self):
        """清除已修改记录"""
        if not self.modification_history:
            QMessageBox.information(self, "提示", "没有已修改的记录")
            return

        reply = QMessageBox.question(
            self,
            "确认清除",
            f"确定要清除 {len(self.modification_history)} 条已修改记录？\n\n"
            "这将重置所有账号的修改状态，但不会撤销已完成的验证器修改。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 清除数据库记录
        deleted = self.db_manager.clear_authenticator_modification_history()
        self.modification_history = {}

        # 刷新列表（使用缓存数据重新填充，无需重新加载）
        self._populate_account_tree()
        self._log(f"✅ 已清除 {deleted} 条修改记录")

    def closeEvent(self, event):
        """关闭窗口时停止工作线程"""
        # 停止数据加载线程
        if self.load_data_worker and self.load_data_worker.isRunning():
            self.load_data_worker.stop()
            self.load_data_worker.wait(1000)
        # 停止任务处理线程
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(3000)
        event.accept()

    def resizeEvent(self, event):
        """窗口大小变化时调整覆盖层"""
        super().resizeEvent(event)
        if hasattr(self, 'tree_loading_overlay') and self.tree_loading_overlay.isVisible():
            self.tree_loading_overlay.setGeometry(0, 0, self.tree.width(), self.tree.height())


# 测试入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    dialog = ModifyAuthenticatorDialog()
    dialog.show()
    sys.exit(app.exec())
