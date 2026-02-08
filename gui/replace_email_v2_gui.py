"""
一键替换辅助邮箱 V2 (邮箱池版) GUI 窗口
支持多个辅助邮箱轮换、每日绑定限制管理

使用 AI Agent 模式（Gemini Vision）
AI 配置请在「配置管理 → 全局设置」中设置
"""
import sys
import asyncio
import traceback
from datetime import datetime

from PyQt6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QLineEdit,
    QTextEdit,
    QTreeWidget,
    QTreeWidgetItem,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QMessageBox,
    QCheckBox,
    QSpinBox,
    QGroupBox,
    QFormLayout,
    QAbstractItemView,
    QSplitter,
    QTabWidget,
    QWidget,
    QInputDialog,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QColor, QBrush
from PyQt6.QtWidgets import QProgressBar

from services.ix_api import get_group_list, update_profile
from services.ix_window import get_browser_list
from services.database import DBManager
from core.config_manager import ConfigManager
from application.automation_engine_adapter import AutomationEngineAdapter
from services.recovery_email_manager import RecoveryEmailManager, DAILY_BIND_LIMIT

# 最大轮换重试次数
MAX_ROTATION_RETRIES = 5


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
                'cached_browsers': [],
                'cached_account_map': {},
                'cached_group_names': {},
                'all_account_data': [],
                'bindings': {},
                'pool_emails': set(),
            }

            # 阶段 1: 获取数据库账号
            self.progress_signal.emit(1, 5, "正在读取数据库账号...")
            if not self.is_running:
                return

            db_accounts = self.db_manager.get_all_accounts()
            result['cached_account_map'] = {acc['email']: acc for acc in db_accounts}

            # 阶段 2: 获取分组列表
            self.progress_signal.emit(2, 5, "正在获取分组列表...")
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

            # 阶段 3: 获取浏览器列表
            self.progress_signal.emit(3, 5, "正在获取窗口列表...")
            if not self.is_running:
                return

            browsers = get_browser_list(page=1, limit=1000) or []
            result['cached_browsers'] = browsers

            # 阶段 4: 获取绑定关系和邮箱池
            self.progress_signal.emit(4, 5, "正在获取绑定关系...")
            if not self.is_running:
                return

            result['bindings'] = DBManager.get_all_account_recovery_bindings()
            result['pool_emails'] = set(RecoveryEmailManager.get_pool_emails())

            # 阶段 5: 预处理所有账号数据
            self.progress_signal.emit(5, 5, "正在处理账号数据...")
            if not self.is_running:
                return

            all_account_data = []
            for browser in browsers:
                gid = browser.get('group_id', 0) or 0

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

                # 获取当前绑定的辅助邮箱
                current_recovery = account.get('recovery_email', '')
                binding_info = result['bindings'].get(email, {})
                if binding_info:
                    bound_email = binding_info.get('bound_recovery_email', '')
                    if bound_email:
                        current_recovery = bound_email

                # 判断绑定状态
                if current_recovery in result['pool_emails']:
                    bind_status = 'bound_pool'  # 已绑定池中邮箱
                elif current_recovery:
                    bind_status = 'bound_other'  # 绑定其他邮箱
                else:
                    bind_status = 'unbound'  # 未绑定

                account_data = {
                    'browser_id': str(browser_id),
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', '') or account.get('secret_key', ''),
                    'current_recovery_email': current_recovery,
                    'bind_status': bind_status,
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
                'cached_browsers': [],
                'cached_account_map': {},
                'cached_group_names': {},
                'all_account_data': [],
                'bindings': {},
                'pool_emails': set(),
                'error': str(e),
            })


class ReplaceEmailV2Worker(QThread):
    """后台工作线程 V2 - 支持邮箱池轮换"""
    progress_signal = pyqtSignal(str, str, str, str)  # browser_id, status, message, used_email
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)
    stats_signal = pyqtSignal(dict)  # 统计信息

    def __init__(
        self,
        accounts: list[dict],
        thread_count: int,
        close_after: bool,
        ai_config: dict = None,
    ):
        super().__init__()
        self.accounts = accounts
        self.thread_count = max(1, thread_count)
        self.close_after = close_after
        self.ai_config = ai_config or {}
        self.is_running = True
        # 统计
        self.stats = {
            'success': 0,
            'failed': 0,
            'skipped': 0,
            'no_quota': 0,
            'total': 0,
        }

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
            self.stats_signal.emit(self.stats)
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
                current_recovery = account.get('current_recovery_email', '')
                total_counted = False  # 跟踪是否已计入 total 统计

                self._log(f"[{index + 1}] 检查账号: {email}")
                self.progress_signal.emit(browser_id, "检查中", "正在检测当前绑定状态...", "")

                try:
                    # 检查绑定状态并获取建议的邮箱
                    status, suggested_email = RecoveryEmailManager.check_account_binding(
                        email, current_recovery
                    )

                    # 统计: total 只在此处增加一次，异常处理块不再重复增加
                    self.stats['total'] += 1
                    total_counted = True

                    if status == 'already_bound':
                        # 已绑定池中邮箱，跳过
                        self._log(f"[{index + 1}] ⏭️ {email}: 已绑定 {suggested_email}，跳过")
                        self.progress_signal.emit(browser_id, "已绑定", f"当前已绑定: {suggested_email}", suggested_email)
                        self.stats['skipped'] += 1
                        return

                    if status == 'no_available':
                        # 无可用邮箱
                        self._log(f"[{index + 1}] ⚠️ {email}: 今日额度已用完")
                        self.progress_signal.emit(browser_id, "无额度", "今日所有邮箱额度已用完", "")
                        self.stats['no_quota'] += 1
                        return

                    # 需要绑定，使用轮换逻辑
                    tried_emails = []  # 已尝试的邮箱列表
                    bind_success = False
                    final_email = suggested_email
                    final_msg = ""

                    for rotation_attempt in range(MAX_ROTATION_RETRIES):
                        # 选择下一个可用邮箱（排除已尝试的）
                        if rotation_attempt == 0:
                            new_email = suggested_email
                        else:
                            next_email_info = RecoveryEmailManager.select_next_available_email(tried_emails)
                            if not next_email_info:
                                self._log(f"[{index + 1}] ⚠️ {email}: 邮箱池已耗尽，无可用邮箱")
                                self.progress_signal.emit(browser_id, "无额度", "邮箱池已耗尽", "")
                                self.stats['no_quota'] += 1
                                break
                            new_email = next_email_info['email']
                            self._log(f"[{index + 1}] 🔄 轮换第 {rotation_attempt} 次: {email} → {new_email}")

                        final_email = new_email
                        self.progress_signal.emit(browser_id, "处理中", f"正在绑定: {new_email}", new_email)

                        # 获取 IMAP 配置
                        imap_config = RecoveryEmailManager.get_imap_config(new_email)

                        # 获取邮箱池列表（让 AI 知道哪些邮箱是可接受的）
                        pool_emails = RecoveryEmailManager.get_pool_emails()

                        account_info = {
                            'email': account.get('email', ''),
                            'password': account.get('password', ''),
                            'secret': account.get('secret', ''),
                        }

                        success, msg, error_type = await AutomationEngineAdapter.run_replace_recovery_email(
                            browser_id,
                            account_info,
                            new_email,
                            self.close_after,
                            api_key=self.ai_config.get('api_key'),
                            base_url=self.ai_config.get('base_url'),
                            model=self.ai_config.get('model'),
                            provider=self.ai_config.get('provider'),
                            max_steps=self.ai_config.get('max_steps', 25),
                            email_imap_config=imap_config,
                            pool_emails=pool_emails,
                        )

                        if success:
                            # 绑定成功
                            RecoveryEmailManager.record_bind_success(email, new_email)

                            # 同步更新数据库 accounts 表的 recovery_email 字段
                            try:
                                DBManager.update_account_recovery_email(email, new_email)
                                self._log(f"[{index + 1}] 📝 数据库已更新: {email} → {new_email}")
                            except Exception as db_err:
                                self._log(f"[{index + 1}] ⚠️ 数据库更新失败: {db_err}")

                            # 同步更新 ixBrowser 窗口备注
                            try:
                                password = account.get('password', '')
                                secret = account.get('secret', '')
                                new_note = f"{email}----{password}----{new_email}----{secret}"
                                update_profile(int(browser_id), note=new_note)
                                self._log(f"[{index + 1}] 📝 窗口备注已更新")
                            except Exception as note_err:
                                self._log(f"[{index + 1}] ⚠️ 窗口备注更新失败: {note_err}")

                            self._log(f"[{index + 1}] ✅ {email}: 绑定成功 → {new_email}")
                            self.progress_signal.emit(browser_id, "成功", f"已绑定: {new_email}", new_email)
                            self.stats['success'] += 1
                            bind_success = True
                            break
                        elif error_type == "email_unavailable":
                            # AI 识别出邮箱不可用错误，标记为今日已满并轮换
                            self._log(f"[{index + 1}] ⚠️ {new_email} 不可用 (AI识别): {msg}")
                            RecoveryEmailManager.mark_email_full_today(new_email)
                            tried_emails.append(new_email)
                            final_msg = msg
                            # 继续循环尝试下一个邮箱
                        else:
                            # 其他错误（非邮箱不可用），不再轮换
                            RecoveryEmailManager.record_bind_failure(email, new_email)
                            self._log(f"[{index + 1}] ❌ {email}: {msg} (error_type={error_type})")
                            self.progress_signal.emit(browser_id, "失败", msg, new_email)
                            self.stats['failed'] += 1
                            bind_success = True  # 标记已处理，避免下面重复计数
                            break

                    # 如果所有轮换都失败了（邮箱不可用错误）
                    if not bind_success and tried_emails:
                        self._log(f"[{index + 1}] ❌ {email}: 尝试 {len(tried_emails)} 个邮箱均不可用")
                        self.progress_signal.emit(browser_id, "失败", f"已尝试 {len(tried_emails)} 个邮箱: {final_msg}", final_email)
                        self.stats['failed'] += 1

                except Exception as e:
                    self._log(f"[{index + 1}] ❌ {email}: {e}")
                    self.progress_signal.emit(browser_id, "错误", str(e), "")
                    self.stats['failed'] += 1
                    # 仅当 total 未在 try 块中增加时才增加（异常发生在 check_account_binding 之前）
                    if not total_counted:
                        self.stats['total'] += 1

        # 并发执行
        tasks = [process_one(i, acc) for i, acc in enumerate(self.accounts)]
        await asyncio.gather(*tasks)

        self._log("✅ 所有账号处理完成")


class ReplaceEmailV2Window(QDialog):
    """替换辅助邮箱 V2 主对话框 - 支持邮箱池"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键替换辅助邮箱 V2 (邮箱池版)")
        self.setMinimumSize(1100, 800)

        self.worker = None
        self.load_data_worker = None  # 异步加载线程
        self.db_manager = DBManager()
        self.accounts = []  # 当前过滤后的账号列表

        # 数据缓存
        self._cached_browsers = []
        self._cached_account_map = {}
        self._cached_group_names = {}
        self._all_account_data = []

        self._init_ui()
        self._refresh_pool_table()
        # 延迟异步加载数据
        QTimer.singleShot(100, self._start_async_load)

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 使用 Tab 分割邮箱池管理和账号处理
        self.tabs = QTabWidget()
        layout.addWidget(self.tabs)

        # Tab 1: 邮箱池管理
        pool_tab = QWidget()
        self._init_pool_tab(pool_tab)
        self.tabs.addTab(pool_tab, "📧 邮箱池管理")

        # Tab 2: 账号处理
        account_tab = QWidget()
        self._init_account_tab(account_tab)
        self.tabs.addTab(account_tab, "👤 账号处理")

    def _init_pool_tab(self, parent):
        """初始化邮箱池管理标签页"""
        layout = QVBoxLayout(parent)

        # 说明区域
        info_group = QGroupBox("功能说明")
        info_layout = QVBoxLayout(info_group)
        info_label = QLabel(
            "📧 管理用于绑定的辅助邮箱池\n"
            f"• 每个邮箱每天最多可被绑定 {DAILY_BIND_LIMIT} 次\n"
            "• 系统会自动选择使用次数最少的邮箱\n"
            "• IMAP 密码用于自动读取邮箱验证码（应用专用密码）"
        )
        info_label.setStyleSheet("color: #333; padding: 5px;")
        info_layout.addWidget(info_label)
        layout.addWidget(info_group)

        # 今日配额统计
        quota_group = QGroupBox("今日配额")
        quota_layout = QHBoxLayout(quota_group)
        self.quota_label = QLabel("加载中...")
        self.quota_label.setStyleSheet("font-size: 14px; font-weight: bold;")
        quota_layout.addWidget(self.quota_label)
        quota_layout.addStretch()

        self.reset_usage_btn = QPushButton("重置今日用量")
        self.reset_usage_btn.setStyleSheet("color: #e65100;")
        self.reset_usage_btn.clicked.connect(self._reset_daily_usage)
        quota_layout.addWidget(self.reset_usage_btn)

        layout.addWidget(quota_group)

        # 邮箱池表格
        pool_group = QGroupBox("邮箱池列表")
        pool_layout = QVBoxLayout(pool_group)

        # 工具栏
        toolbar = QHBoxLayout()

        self.add_email_btn = QPushButton("➕ 添加邮箱")
        self.add_email_btn.clicked.connect(self._add_email_to_pool)
        toolbar.addWidget(self.add_email_btn)

        self.remove_email_btn = QPushButton("➖ 移除选中")
        self.remove_email_btn.clicked.connect(self._remove_selected_emails)
        toolbar.addWidget(self.remove_email_btn)

        self.refresh_pool_btn = QPushButton("🔄 刷新")
        self.refresh_pool_btn.clicked.connect(self._refresh_pool_table)
        toolbar.addWidget(self.refresh_pool_btn)

        toolbar.addStretch()
        pool_layout.addLayout(toolbar)

        # 邮箱池表格
        self.pool_table = QTableWidget()
        self.pool_table.setColumnCount(6)
        self.pool_table.setHorizontalHeaderLabels([
            "邮箱地址", "IMAP密码", "今日用量", "剩余", "状态", "备注"
        ])
        self.pool_table.setColumnWidth(0, 220)
        self.pool_table.setColumnWidth(1, 150)
        self.pool_table.setColumnWidth(2, 80)
        self.pool_table.setColumnWidth(3, 80)
        self.pool_table.setColumnWidth(4, 60)
        self.pool_table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.Stretch)
        self.pool_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.pool_table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        pool_layout.addWidget(self.pool_table)

        layout.addWidget(pool_group)

        # 快速添加区域
        quick_add_group = QGroupBox("快速添加")
        quick_add_layout = QFormLayout(quick_add_group)

        self.new_email_input = QLineEdit()
        self.new_email_input.setPlaceholderText("输入邮箱地址")
        quick_add_layout.addRow("邮箱:", self.new_email_input)

        self.new_imap_input = QLineEdit()
        self.new_imap_input.setPlaceholderText("输入 IMAP 应用专用密码（可选）")
        self.new_imap_input.setEchoMode(QLineEdit.EchoMode.Password)
        quick_add_layout.addRow("IMAP密码:", self.new_imap_input)

        self.new_note_input = QLineEdit()
        self.new_note_input.setPlaceholderText("备注（可选）")
        quick_add_layout.addRow("备注:", self.new_note_input)

        add_btn = QPushButton("添加到邮箱池")
        add_btn.clicked.connect(self._quick_add_email)
        add_btn.setStyleSheet("background-color: #4CAF50; color: white; padding: 8px;")
        quick_add_layout.addRow("", add_btn)

        layout.addWidget(quick_add_group)

    def _init_account_tab(self, parent):
        """初始化账号处理标签页"""
        layout = QVBoxLayout(parent)

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

        # AI 配置提示
        ai_hint = QLabel("💡 AI 配置请在「配置管理 → 全局设置」中设置")
        ai_hint.setStyleSheet("color: #666; font-size: 11px;")
        settings_layout.addRow("", ai_hint)

        layout.addWidget(settings_group)

        # 状态过滤器
        filter_group = QGroupBox("状态过滤器")
        filter_layout = QHBoxLayout(filter_group)

        self.filter_unbound = QCheckBox("未绑定")
        self.filter_unbound.setChecked(True)
        self.filter_unbound.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_unbound)

        self.filter_bound = QCheckBox("已绑定池中邮箱")
        self.filter_bound.setChecked(False)
        self.filter_bound.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_bound)

        self.filter_other = QCheckBox("绑定其他邮箱")
        self.filter_other.setChecked(True)
        self.filter_other.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_other)

        filter_layout.addStretch()
        layout.addWidget(filter_group)

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
        self.refresh_btn.clicked.connect(self._refresh_data)
        toolbar.addWidget(self.refresh_btn)

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        list_layout.addLayout(toolbar)

        # 树形控件
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "邮箱", "窗口ID", "当前辅助邮箱", "状态"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 250)
        self.tree.setColumnWidth(2, 100)
        self.tree.setColumnWidth(3, 220)
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
                background-color: #9C27B0;
                border-radius: 4px;
            }
        """)
        overlay_layout.addWidget(self.tree_loading_progress, alignment=Qt.AlignmentFlag.AlignCenter)

        self.tree_loading_overlay.hide()  # 默认隐藏

        list_layout.addWidget(self.tree)

        layout.addWidget(list_group)

        # 统计区域
        stats_group = QGroupBox("统计")
        stats_layout = QHBoxLayout(stats_group)
        self.stats_label = QLabel("待处理...")
        self.stats_label.setStyleSheet("font-size: 12px;")
        stats_layout.addWidget(self.stats_label)
        layout.addWidget(stats_group)

        # 日志区域
        log_group = QGroupBox("执行日志")
        log_layout = QVBoxLayout(log_group)
        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(120)
        self.log_text.setStyleSheet("background-color: #1e1e1e; color: #d4d4d4; font-family: Consolas;")
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

    # ==================== 邮箱池管理方法 ====================

    def _refresh_pool_table(self):
        """刷新邮箱池表格"""
        self.pool_table.setRowCount(0)

        pool_with_usage = RecoveryEmailManager.get_pool_with_usage()
        remaining, total = RecoveryEmailManager.get_total_remaining()

        # 更新配额显示
        self.quota_label.setText(
            f"📊 今日剩余: {remaining} / {total} "
            f"({len(pool_with_usage)} 个邮箱，每个限 {DAILY_BIND_LIMIT} 次)"
        )

        for item in pool_with_usage:
            row = self.pool_table.rowCount()
            self.pool_table.insertRow(row)

            # 邮箱地址
            self.pool_table.setItem(row, 0, QTableWidgetItem(item['email']))

            # IMAP 密码（脱敏显示）
            password = item.get('imap_password', '')
            if password:
                masked = password[:2] + '*' * (len(password) - 4) + password[-2:] if len(password) > 4 else '****'
            else:
                masked = "(未设置)"
            self.pool_table.setItem(row, 1, QTableWidgetItem(masked))

            # 今日用量
            usage_item = QTableWidgetItem(str(item['today_usage']))
            if item['is_full']:
                usage_item.setBackground(QColor("#ffebee"))
            self.pool_table.setItem(row, 2, usage_item)

            # 剩余
            remaining_item = QTableWidgetItem(str(item['remaining']))
            if item['remaining'] == 0:
                remaining_item.setBackground(QColor("#ffebee"))
            elif item['remaining'] <= 3:
                remaining_item.setBackground(QColor("#fff3e0"))
            self.pool_table.setItem(row, 3, remaining_item)

            # 状态
            if item['is_enabled']:
                status_item = QTableWidgetItem("启用")
                status_item.setForeground(QColor("#4CAF50"))
            else:
                status_item = QTableWidgetItem("禁用")
                status_item.setForeground(QColor("#9E9E9E"))
            self.pool_table.setItem(row, 4, status_item)

            # 备注
            self.pool_table.setItem(row, 5, QTableWidgetItem(item.get('note', '')))

    def _add_email_to_pool(self):
        """添加邮箱到池（通过对话框）"""
        email, ok = QInputDialog.getText(self, "添加邮箱", "请输入邮箱地址:")
        if ok and email:
            if '@' not in email:
                QMessageBox.warning(self, "错误", "请输入有效的邮箱地址")
                return

            imap_password, ok2 = QInputDialog.getText(
                self, "IMAP 密码",
                "请输入 IMAP 应用专用密码（可选，用于自动读取验证码）:",
                QLineEdit.EchoMode.Password
            )

            if RecoveryEmailManager.add_email_to_pool(email, imap_password or "", ""):
                self._log(f"✅ 已添加邮箱: {email}")
                self._refresh_pool_table()
            else:
                QMessageBox.warning(self, "错误", "添加失败")

    def _quick_add_email(self):
        """快速添加邮箱"""
        email = self.new_email_input.text().strip()
        if not email:
            QMessageBox.warning(self, "提示", "请输入邮箱地址")
            return

        if '@' not in email:
            QMessageBox.warning(self, "错误", "请输入有效的邮箱地址")
            return

        imap_password = self.new_imap_input.text().strip()
        note = self.new_note_input.text().strip()

        if RecoveryEmailManager.add_email_to_pool(email, imap_password, note):
            self._log(f"✅ 已添加邮箱: {email}")
            self.new_email_input.clear()
            self.new_imap_input.clear()
            self.new_note_input.clear()
            self._refresh_pool_table()
        else:
            QMessageBox.warning(self, "错误", "添加失败")

    def _remove_selected_emails(self):
        """移除选中的邮箱"""
        selected_rows = set()
        for item in self.pool_table.selectedItems():
            selected_rows.add(item.row())

        if not selected_rows:
            QMessageBox.warning(self, "提示", "请先选择要移除的邮箱")
            return

        emails_to_remove = []
        for row in selected_rows:
            email_item = self.pool_table.item(row, 0)
            if email_item:
                emails_to_remove.append(email_item.text())

        reply = QMessageBox.question(
            self, "确认移除",
            f"确定要从邮箱池中移除 {len(emails_to_remove)} 个邮箱？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        for email in emails_to_remove:
            RecoveryEmailManager.remove_email_from_pool(email)
            self._log(f"已移除邮箱: {email}")

        self._refresh_pool_table()

    def _reset_daily_usage(self):
        """重置今日用量"""
        reply = QMessageBox.question(
            self, "确认重置",
            "确定要重置今日所有邮箱的使用量？\n\n"
            "这将清除今日的绑定计数，所有邮箱额度将恢复。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        deleted = RecoveryEmailManager.reset_today_usage()
        self._log(f"✅ 已重置今日用量 ({deleted} 条记录)")
        self._refresh_pool_table()

    # ==================== 异步加载方法 ====================

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
            self.start_btn.setEnabled(False)
            # 禁用过滤器
            self.filter_unbound.setEnabled(False)
            self.filter_bound.setEnabled(False)
            self.filter_other.setEnabled(False)
        else:
            self.tree_loading_overlay.hide()
            # 恢复工具栏按钮
            self.refresh_btn.setEnabled(True)
            self.select_all_btn.setEnabled(True)
            self.deselect_all_btn.setEnabled(True)
            self.start_btn.setEnabled(True)
            # 恢复过滤器
            self.filter_unbound.setEnabled(True)
            self.filter_bound.setEnabled(True)
            self.filter_other.setEnabled(True)

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
            self._cached_browsers = result.get('cached_browsers', [])
            self._cached_account_map = result.get('cached_account_map', {})
            self._cached_group_names = result.get('cached_group_names', {})
            self._all_account_data = result.get('all_account_data', [])

            if result.get('error'):
                self._log(f"⚠️ 加载数据时发生错误: {result.get('error')}")
            else:
                self._log(f"数据加载完成：共 {len(self._all_account_data)} 个账号")

            # 应用过滤器
            self._apply_filter()

        except Exception as e:
            self._log(f"❌ 处理加载结果失败: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self._show_loading(False)

    # ==================== 账号处理方法 ====================

    def _apply_filter(self):
        """根据过滤器设置更新 UI"""
        self.tree.clear()
        self.accounts = []

        # 获取过滤条件
        show_unbound = self.filter_unbound.isChecked()
        show_bound_pool = self.filter_bound.isChecked()
        show_bound_other = self.filter_other.isChecked()

        # 按分组组织过滤后的账号
        grouped = {}
        for account_data in self._all_account_data:
            bind_status = account_data.get('bind_status', 'unbound')

            # 应用过滤
            if bind_status == 'unbound' and not show_unbound:
                continue
            if bind_status == 'bound_pool' and not show_bound_pool:
                continue
            if bind_status == 'bound_other' and not show_bound_other:
                continue

            gid = account_data.get('group_id', 0)
            if gid not in grouped:
                grouped[gid] = []
            grouped[gid].append(account_data)

        # 创建树形结构
        total_count = 0

        for gid in sorted(grouped.keys()):
            account_list = grouped[gid]
            if not account_list:
                continue

            group_name = self._cached_group_names.get(gid, f"分组 {gid}")

            # 分组节点
            group_item = QTreeWidgetItem(self.tree)
            group_item.setText(0, "")
            group_item.setText(1, f"📁 {group_name} ({len(account_list)})")
            group_item.setFlags(
                group_item.flags() |
                Qt.ItemFlag.ItemIsAutoTristate |
                Qt.ItemFlag.ItemIsUserCheckable
            )
            group_item.setCheckState(0, Qt.CheckState.Unchecked)
            group_item.setExpanded(True)
            group_item.setData(0, Qt.ItemDataRole.UserRole, {"type": "group", "id": gid})

            font = group_item.font(1)
            font.setBold(True)
            group_item.setFont(1, font)

            # 账号子节点
            for account_data in account_list:
                email = account_data['email']
                browser_id = account_data['browser_id']
                current_recovery = account_data.get('current_recovery_email', '')
                bind_status = account_data.get('bind_status', 'unbound')

                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)

                # 默认选中未绑定和绑定其他的
                if bind_status in ('unbound', 'bound_other'):
                    child.setCheckState(0, Qt.CheckState.Checked)
                else:
                    child.setCheckState(0, Qt.CheckState.Unchecked)

                child.setText(1, email)
                child.setText(2, browser_id)
                child.setText(3, current_recovery or "(无)")

                # 状态显示和颜色
                if bind_status == 'bound_pool':
                    child.setText(4, "已绑定池中")
                    child.setBackground(4, QColor("#e8f5e9"))
                    child.setForeground(4, QColor("#2E7D32"))
                elif bind_status == 'bound_other':
                    child.setText(4, "绑定其他")
                    child.setBackground(4, QColor("#fff3e0"))
                    child.setForeground(4, QColor("#E65100"))
                else:
                    child.setText(4, "未绑定")
                    child.setBackground(4, QColor("#ffebee"))
                    child.setForeground(4, QColor("#C62828"))

                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "data": account_data
                })

                self.accounts.append(account_data)
                total_count += 1

        self.stats_label.setText(f"📊 显示: {total_count} / 总计: {len(self._all_account_data)}")
        self._update_selection_count()

    def _refresh_data(self):
        """刷新数据（异步）"""
        self._log("正在刷新数据...")
        self._refresh_pool_table()
        self._start_async_load()

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
        """更新已选择数量"""
        count = len(self._get_selected_accounts())
        self.selected_label.setText(f"已选择: {count} 个账号")

    def _get_selected_accounts(self) -> list[dict]:
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
                        selected.append(data.get("data"))
        return selected

    def _log(self, message: str):
        """添加日志"""
        self.log_text.append(message)
        self.log_text.ensureCursorVisible()

    def _get_ai_config(self) -> dict:
        """从全局配置获取 AI 配置"""
        return {
            'api_key': ConfigManager.get_ai_api_key() or None,
            'base_url': ConfigManager.get_ai_base_url() or None,
            'model': ConfigManager.get_ai_model(),
            'provider': ConfigManager.get_ai_default_provider(),
            'max_steps': ConfigManager.get_ai_max_steps(),
        }

    def _start_process(self):
        """开始处理"""
        # 检查邮箱池
        remaining, total = RecoveryEmailManager.get_total_remaining()
        if total == 0:
            QMessageBox.warning(self, "提示", "邮箱池为空，请先添加辅助邮箱")
            self.tabs.setCurrentIndex(0)  # 切换到邮箱池管理标签
            return

        if remaining == 0:
            QMessageBox.warning(self, "提示", "今日所有邮箱额度已用完")
            return

        selected = self._get_selected_accounts()
        if not selected:
            QMessageBox.warning(self, "提示", "请先选择要处理的账号")
            return

        # 获取 AI 配置
        ai_config = self._get_ai_config()

        if not ai_config.get('api_key'):
            reply = QMessageBox.question(
                self,
                "API Key 未配置",
                "未在配置管理中设置 AI API Key。\n\n"
                "是否继续？（将尝试从环境变量 GEMINI_API_KEY 读取）",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

        reply = QMessageBox.question(
            self,
            "确认执行",
            f"确定要处理 {len(selected)} 个账号吗？\n\n"
            f"今日剩余额度: {remaining} / {total}\n"
            f"并发数: {self.thread_spin.value()}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 日志输出配置信息
        if ai_config.get('base_url'):
            self._log(f"API Base URL: {ai_config['base_url']}")
        self._log(f"模型: {ai_config.get('model', 'default')}")
        self._log(f"今日剩余额度: {remaining} / {total}")

        # 禁用控件
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.refresh_btn.setEnabled(False)
        self.select_all_btn.setEnabled(False)
        self.deselect_all_btn.setEnabled(False)
        # 禁用过滤器
        self.filter_unbound.setEnabled(False)
        self.filter_bound.setEnabled(False)
        self.filter_other.setEnabled(False)

        # 创建工作线程
        self.worker = ReplaceEmailV2Worker(
            accounts=selected,
            thread_count=self.thread_spin.value(),
            close_after=self.close_after_check.isChecked(),
            ai_config=ai_config,
        )
        self.worker.log_signal.connect(self._log)
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.stats_signal.connect(self._on_stats)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.start()

    def _stop_process(self):
        """停止处理"""
        if self.worker:
            self.worker.stop()
            self._log("正在停止任务...")
            self.stop_btn.setEnabled(False)

    def _on_progress(self, browser_id: str, status: str, message: str, used_email: str):
        """进度更新"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(2) == browser_id:
                    # 更新状态
                    child.setText(4, status)

                    # 如果绑定了新邮箱，更新显示
                    if used_email and status == "成功":
                        child.setText(3, used_email)
                        child.setBackground(4, QColor("#e8f5e9"))
                        child.setForeground(4, QColor("#2E7D32"))
                    elif status == "已绑定":
                        child.setBackground(4, QColor("#e3f2fd"))
                        child.setForeground(4, QColor("#1565C0"))
                    elif status in ("失败", "错误"):
                        child.setBackground(4, QColor("#ffebee"))
                        child.setForeground(4, QColor("#C62828"))
                    elif status == "无额度":
                        child.setBackground(4, QColor("#fff3e0"))
                        child.setForeground(4, QColor("#E65100"))
                    return

    def _on_stats(self, stats: dict):
        """统计更新"""
        self.stats_label.setText(
            f"📊 总计: {stats.get('total', 0)} | "
            f"✅ 成功: {stats.get('success', 0)} | "
            f"⏭️ 跳过: {stats.get('skipped', 0)} | "
            f"❌ 失败: {stats.get('failed', 0)} | "
            f"⚠️ 无额度: {stats.get('no_quota', 0)}"
        )

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.refresh_btn.setEnabled(True)
        self.select_all_btn.setEnabled(True)
        self.deselect_all_btn.setEnabled(True)
        # 恢复过滤器
        self.filter_unbound.setEnabled(True)
        self.filter_bound.setEnabled(True)
        self.filter_other.setEnabled(True)

        self._log("=" * 50)
        self._log("任务执行完成！")

        # 刷新邮箱池表格以更新用量
        self._refresh_pool_table()

        # 统计本次处理结果
        if self.worker:
            stats = self.worker.stats
            msg = (
                f"辅助邮箱绑定任务已完成\n\n"
                f"成功: {stats.get('success', 0)} 个\n"
                f"跳过: {stats.get('skipped', 0)} 个（已绑定池中邮箱）\n"
                f"失败: {stats.get('failed', 0)} 个\n"
                f"无额度: {stats.get('no_quota', 0)} 个"
            )
            QMessageBox.information(self, "完成", msg)

        self.worker = None

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


# 独立运行入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    # 初始化数据库
    DBManager.init_db()
    DBManager.init_recovery_email_pool_tables()

    app = QApplication(sys.argv)
    dialog = ReplaceEmailV2Window()
    dialog.show()
    sys.exit(app.exec())
