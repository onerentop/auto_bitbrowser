"""
一键获取 SheerID Link (AI Agent 版) GUI 窗口
支持批量为 Google 账号检测学生资格并提取 SheerID 验证链接

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
    QProgressBar,
    QWidget,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QColor, QBrush

from services.ix_api import get_group_list
from services.ix_window import get_browser_list
from services.database import DBManager
from core.config_manager import ConfigManager
from automation.auto_get_sheerlink_ai import auto_get_sheerlink_ai


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
            }

            # 阶段 1: 获取数据库账号
            self.progress_signal.emit(1, 3, "正在读取数据库...")
            if not self.is_running:
                return

            db_accounts = self.db_manager.get_all_accounts()
            result['cached_account_map'] = {acc['email']: acc for acc in db_accounts}

            # 阶段 2: 获取分组列表
            self.progress_signal.emit(2, 3, "正在获取分组列表...")
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
            self.progress_signal.emit(3, 3, "正在获取窗口列表...")
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
                status = account.get('status', 'pending')

                account_data = {
                    'browser_id': str(browser_id),
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', '') or account.get('secret_key', ''),
                    'status': status,
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
                'error': str(e),
            })


class GetSheerlinkAIWorker(QThread):
    """后台工作线程"""
    progress_signal = pyqtSignal(str, str, str, str)  # browser_id, status, message, link
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
            'subscribed': 0,
            'verified': 0,
            'link_ready': 0,
            'ineligible': 0,
            'error': 0,
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

                self._log(f"[{index + 1}] 开始检测: {email} ({browser_id})")
                self.progress_signal.emit(browser_id, "处理中", "正在检测...", "")

                try:
                    account_info = {
                        'email': account.get('email', ''),
                        'password': account.get('password', ''),
                        'secret': account.get('secret', ''),
                    }

                    success, msg, status, link = await auto_get_sheerlink_ai(
                        browser_id,
                        account_info,
                        self.close_after,
                        api_key=self.ai_config.get('api_key'),
                        base_url=self.ai_config.get('base_url'),
                        model=self.ai_config.get('model'),
                        provider=self.ai_config.get('provider'),
                        max_steps=self.ai_config.get('max_steps', 20),
                    )

                    # 更新统计
                    self.stats['total'] += 1
                    if status in self.stats:
                        self.stats[status] += 1

                    if success:
                        self._log(f"[{index + 1}] ✅ {email}: {status} - {msg}")
                        self.progress_signal.emit(browser_id, status, msg, link or "")
                    else:
                        self._log(f"[{index + 1}] ❌ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "error", msg, "")

                except Exception as e:
                    self._log(f"[{index + 1}] ❌ {email}: {e}")
                    self.progress_signal.emit(browser_id, "error", str(e), "")
                    self.stats['error'] += 1
                    self.stats['total'] += 1

        # 并发执行
        tasks = [process_one(i, acc) for i, acc in enumerate(self.accounts)]
        await asyncio.gather(*tasks)

        self._log("✅ 所有账号处理完成")


class GetSheerlinkAIDialog(QDialog):
    """获取 SheerLink AI 版主对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键获取 SheerID Link (AI Agent 版)")
        self.setMinimumSize(1000, 750)

        self.worker = None
        self.load_data_worker = None  # 异步加载线程
        self.db_manager = DBManager()
        self.accounts = []  # 当前过滤后的账号列表

        # 数据缓存（避免每次过滤都重新调用 API）
        self._cached_browsers = []  # 缓存浏览器列表
        self._cached_account_map = {}  # 缓存数据库账号映射
        self._cached_group_names = {}  # 缓存分组名称
        self._all_account_data = []  # 所有账号数据（未过滤）

        self._init_ui()
        # 延迟异步加载数据
        QTimer.singleShot(100, self._start_async_load)

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 说明区域
        info_group = QGroupBox("功能说明")
        info_layout = QVBoxLayout(info_group)
        info_label = QLabel(
            "🔍 此功能用于批量检测 Google 账号的 Google One AI Student 资格状态\n"
            "• 使用 AI Agent 自动检测页面状态，无需维护选择器\n"
            "• 自动提取 SheerID 验证链接（如有资格）\n"
            "• 自动分类: 已绑卡/已验证/有链接/无资格"
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
        self.close_after_check.setChecked(True)
        settings_layout.addRow("", self.close_after_check)

        # AI 配置提示（模型使用全局配置）
        ai_hint = QLabel("💡 AI 模型和 API Key 请在「配置管理 → 全局设置」中设置")
        ai_hint.setStyleSheet("color: #666; font-size: 11px;")
        settings_layout.addRow("", ai_hint)

        layout.addWidget(settings_group)

        # 状态过滤器
        filter_group = QGroupBox("状态过滤器")
        filter_layout = QHBoxLayout(filter_group)

        self.filter_pending = QCheckBox("pending (待处理)")
        self.filter_pending.setChecked(True)  # 默认选中
        self.filter_pending.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_pending)

        self.filter_error = QCheckBox("error (错误)")
        self.filter_error.setChecked(True)  # 默认选中
        self.filter_error.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_error)

        self.filter_link_ready = QCheckBox("link_ready (待验证)")
        self.filter_link_ready.setChecked(False)
        self.filter_link_ready.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_link_ready)

        self.filter_verified = QCheckBox("verified (已验证)")
        self.filter_verified.setChecked(False)
        self.filter_verified.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_verified)

        self.filter_subscribed = QCheckBox("subscribed (已绑卡)")
        self.filter_subscribed.setChecked(False)
        self.filter_subscribed.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_subscribed)

        self.filter_ineligible = QCheckBox("ineligible (无资格)")
        self.filter_ineligible.setChecked(False)
        self.filter_ineligible.stateChanged.connect(self._apply_filter)
        filter_layout.addWidget(self.filter_ineligible)

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

        # 树形控件（按分组显示）
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "邮箱", "窗口ID", "状态", "链接"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 280)
        self.tree.setColumnWidth(2, 120)
        self.tree.setColumnWidth(3, 100)
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
        self.log_text.setMaximumHeight(150)
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

    def _get_selected_status_filters(self) -> set:
        """获取选中的状态过滤器"""
        filters = set()
        if hasattr(self, 'filter_pending') and self.filter_pending.isChecked():
            filters.add('pending')
        if hasattr(self, 'filter_error') and self.filter_error.isChecked():
            filters.add('error')
        if hasattr(self, 'filter_link_ready') and self.filter_link_ready.isChecked():
            filters.add('link_ready')
        if hasattr(self, 'filter_verified') and self.filter_verified.isChecked():
            filters.add('verified')
        if hasattr(self, 'filter_subscribed') and self.filter_subscribed.isChecked():
            filters.add('subscribed')
        if hasattr(self, 'filter_ineligible') and self.filter_ineligible.isChecked():
            filters.add('ineligible')
        # 如果没有选中任何过滤器，默认显示 pending
        if not filters:
            filters.add('pending')
        return filters

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
        else:
            self.tree_loading_overlay.hide()
            # 恢复工具栏按钮
            self.refresh_btn.setEnabled(True)
            self.select_all_btn.setEnabled(True)
            self.deselect_all_btn.setEnabled(True)
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

    def _refresh_data(self):
        """刷新数据（异步）"""
        self._log("正在刷新数据...")
        self._start_async_load()

    def _apply_filter(self):
        """
        根据当前过滤器设置，在缓存数据上应用过滤并更新 UI
        此方法不执行 HTTP 调用，响应速度快
        """
        self.tree.clear()
        self.accounts = []

        # 获取选中的状态过滤器
        status_filters = self._get_selected_status_filters()

        # 按分组组织过滤后的账号
        grouped = {}
        for account_data in self._all_account_data:
            status = account_data.get('status', 'pending')
            if status not in status_filters:
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
                continue  # 跳过空分组

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

            # 设置分组行样式
            font = group_item.font(1)
            font.setBold(True)
            group_item.setFont(1, font)

            # 账号子节点
            for account_data in account_list:
                email = account_data['email']
                browser_id = account_data['browser_id']
                status = account_data.get('status', 'pending')

                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                child.setCheckState(0, Qt.CheckState.Checked)  # 默认选中
                child.setText(1, email)
                child.setText(2, browser_id)

                # 显示当前状态
                status_display = {
                    'pending': '待处理',
                    'subscribed': '已绑卡',
                    'verified': '已验证',
                    'link_ready': '待验证',
                    'ineligible': '无资格',
                    'error': '错误',
                }.get(status, status)
                child.setText(3, status_display)

                # 状态颜色
                if status == "subscribed":
                    child.setBackground(3, QColor("#2196F3"))
                    child.setForeground(3, QColor("#ffffff"))
                elif status == "verified":
                    child.setBackground(3, QColor("#4CAF50"))
                    child.setForeground(3, QColor("#ffffff"))
                elif status == "link_ready":
                    child.setBackground(3, QColor("#FF9800"))
                    child.setForeground(3, QColor("#ffffff"))
                elif status == "ineligible":
                    child.setBackground(3, QColor("#9E9E9E"))
                    child.setForeground(3, QColor("#ffffff"))
                elif status == "error":
                    child.setBackground(3, QColor("#f44336"))
                    child.setForeground(3, QColor("#ffffff"))
                elif status == "pending":
                    child.setBackground(3, QColor("#607D8B"))
                    child.setForeground(3, QColor("#ffffff"))

                child.setText(4, "")
                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "data": account_data
                })

                self.accounts.append(account_data)
                total_count += 1

        filter_str = ", ".join(status_filters) if status_filters else "pending"
        self.stats_label.setText(f"📊 显示: {total_count} / 总计: {len(self._all_account_data)} (过滤器: {filter_str})")
        self._update_selection_count()

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
        selected = self._get_selected_accounts()
        if not selected:
            QMessageBox.warning(self, "提示", "请先选择要处理的账号")
            return

        # 获取 AI 配置
        ai_config = self._get_ai_config()

        # 检查 API Key
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
            f"确定要对 {len(selected)} 个账号执行 AI SheerLink 检测吗？\n\n"
            f"并发数: {self.thread_spin.value()}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 日志输出配置信息
        if ai_config.get('base_url'):
            self._log(f"API Base URL: {ai_config['base_url']}")
        self._log(f"模型: {ai_config.get('model', 'default')}")

        # 禁用控件
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.refresh_btn.setEnabled(False)
        self.select_all_btn.setEnabled(False)
        self.deselect_all_btn.setEnabled(False)

        # 创建工作线程
        self.worker = GetSheerlinkAIWorker(
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

    def _on_progress(self, browser_id: str, status: str, message: str, link: str):
        """进度更新"""
        # 更新列表项状态
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(2) == browser_id:
                    # 状态显示
                    status_display = {
                        'pending': '待处理',
                        'subscribed': '已绑卡',
                        'verified': '已验证',
                        'link_ready': '待验证',
                        'ineligible': '无资格',
                        'error': '失败',
                        '处理中': '处理中...',
                    }.get(status, status)
                    child.setText(3, status_display)

                    # 链接
                    if link:
                        child.setText(4, link[:50] + "..." if len(link) > 50 else link)

                    # 颜色
                    if status == "subscribed":
                        child.setBackground(3, QColor("#2196F3"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "verified":
                        child.setBackground(3, QColor("#4CAF50"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "link_ready":
                        child.setBackground(3, QColor("#FF9800"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "ineligible":
                        child.setBackground(3, QColor("#9E9E9E"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "error":
                        child.setBackground(3, QColor("#f44336"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "pending":
                        child.setBackground(3, QColor("#607D8B"))
                        child.setForeground(3, QColor("#ffffff"))
                    elif status == "处理中":
                        child.setForeground(3, QColor("#FF9800"))
                    return

    def _on_stats(self, stats: dict):
        """统计更新"""
        self.stats_label.setText(
            f"📊 总计: {stats.get('total', 0)} | "
            f"💳 已绑卡: {stats.get('subscribed', 0)} | "
            f"✅ 已验证: {stats.get('verified', 0)} | "
            f"🔗 待验证: {stats.get('link_ready', 0)} | "
            f"❌ 无资格: {stats.get('ineligible', 0)} | "
            f"⚠️ 错误: {stats.get('error', 0)}"
        )

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.refresh_btn.setEnabled(True)
        self.select_all_btn.setEnabled(True)
        self.deselect_all_btn.setEnabled(True)

        self._log("=" * 50)
        self._log("任务执行完成！")

        # 统计本次处理结果
        success_count = 0
        fail_count = 0
        pending_count = 0
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                status_text = child.text(3)
                if status_text in ("已绑卡", "已验证", "待验证"):
                    success_count += 1
                elif status_text in ("失败", "无资格", "错误"):
                    fail_count += 1
                elif status_text == "待处理":
                    pending_count += 1
                # 其他状态（如 "处理中..."）表示任务被中途停止

        # 计算被中断的数量
        total_items = sum(
            root.child(i).childCount() for i in range(root.childCount())
        )
        interrupted_count = total_items - success_count - fail_count - pending_count

        # 显示结果统计
        msg = f"AI SheerLink 检测任务已完成\n\n成功: {success_count} 个\n失败: {fail_count} 个"
        if interrupted_count > 0:
            msg += f"\n中断: {interrupted_count} 个"
        if fail_count > 0 or interrupted_count > 0:
            msg += "\n\n💡 提示: 结果已保留在列表中，可查看详情后手动刷新"

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

    app = QApplication(sys.argv)
    dialog = GetSheerlinkAIDialog()
    dialog.show()
    sys.exit(app.exec())
