"""
一键替换辅助手机号 (Recovery Phone) GUI 窗口
支持批量替换 Google 账号的辅助手机号

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
    QLineEdit,
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
from automation.auto_replace_recovery_phone import auto_replace_recovery_phone


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

            # 阶段 1: 获取手机修改历史
            self.progress_signal.emit(1, 4, "正在读取修改历史...")
            if not self.is_running:
                return

            result['modification_history'] = self.db_manager.get_phone_modification_history()

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


class ReplacePhoneWorker(QThread):
    """后台工作线程"""
    progress_signal = pyqtSignal(str, str, str)  # browser_id, status, message
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)

    def __init__(
        self,
        accounts: list[dict],
        new_phone: str,
        thread_count: int,
        close_after: bool,
        ai_config: dict = None,
    ):
        super().__init__()
        self.accounts = accounts
        self.new_phone = new_phone
        self.thread_count = max(1, thread_count)
        self.close_after = close_after
        self.ai_config = ai_config or {}
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

                self._log(f"[{index + 1}] 开始替换辅助手机号: {email} ({browser_id})")
                self.progress_signal.emit(browser_id, "处理中", "正在替换...")

                try:
                    account_info = {
                        'email': account.get('email', ''),
                        'password': account.get('password', ''),
                        'secret': account.get('secret', ''),
                    }

                    success, msg = await auto_replace_recovery_phone(
                        browser_id,
                        account_info,
                        self.new_phone,
                        self.close_after,
                        api_key=self.ai_config.get('api_key'),
                        base_url=self.ai_config.get('base_url'),
                        model=self.ai_config.get('model', 'gemini-2.5-flash'),
                        max_steps=self.ai_config.get('max_steps', 25),
                    )

                    if success:
                        self._log(f"[{index + 1}] ✅ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "成功", msg)
                    else:
                        self._log(f"[{index + 1}] ❌ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "失败", msg)

                except Exception as e:
                    self._log(f"[{index + 1}] ❌ {email}: {e}")
                    self.progress_signal.emit(browser_id, "错误", str(e))

        # 并发执行
        tasks = [process_one(i, acc) for i, acc in enumerate(self.accounts)]
        await asyncio.gather(*tasks)

        self._log("✅ 所有账号处理完成")


class ReplacePhoneWindow(QDialog):
    """替换辅助手机号主对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键替换辅助手机号 (Recovery Phone)")
        self.setMinimumSize(900, 700)

        self.worker = None
        self.load_data_worker = None  # 异步加载线程
        self.db_manager = DBManager()
        self.accounts = []
        self.modification_history = {}  # 保存已修改账户的历史记录
        self.current_new_phone = ""  # 当前操作的新手机号

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

        # 设置区域
        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout(settings_group)

        # 新手机号输入
        self.phone_input = QLineEdit()
        self.phone_input.setPlaceholderText("输入新的辅助手机号（如 +1234567890）")
        settings_layout.addRow("新手机号:", self.phone_input)

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

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        list_layout.addLayout(toolbar)

        # 树形控件（按分组显示）
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "邮箱", "窗口ID", "状态", "消息"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 250)
        self.tree.setColumnWidth(2, 120)
        self.tree.setColumnWidth(3, 80)
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
                background-color: #00BCD4;
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
            self.start_btn.setEnabled(False)
        else:
            self.tree_loading_overlay.hide()
            # 恢复工具栏按钮
            self.refresh_btn.setEnabled(True)
            self.select_all_btn.setEnabled(True)
            self.deselect_all_btn.setEnabled(True)
            self.clear_history_btn.setEnabled(True)
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

            # 填充账号树
            self._populate_account_tree()

        except Exception as e:
            self._log(f"❌ 处理加载结果失败: {e}")
            traceback.print_exc()
        finally:
            self._show_loading(False)

    def _populate_account_tree(self):
        """填充账号树（使用缓存数据）"""
        self.tree.clear()
        self.accounts = []

        # 按分组组织账号
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

                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                child.setCheckState(0, Qt.CheckState.Unchecked)  # 默认不选中
                child.setText(1, email)
                child.setText(2, browser_id)

                # 检查是否已修改过
                if email in self.modification_history:
                    history = self.modification_history[email]
                    child.setText(3, "已修改")
                    # 显示修改的手机号
                    child.setText(4, f"→ {history['new_phone']}")

                    # 设置置灰样式
                    gray_color = QColor(150, 150, 150)
                    gray_brush = QBrush(gray_color)
                    for col in range(5):
                        child.setForeground(col, gray_brush)

                    modified_count += 1
                else:
                    child.setText(3, "待处理")
                    child.setText(4, "")

                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "account": account_data
                })
                self.accounts.append(account_data)
                total_count += 1

        self._log(f"已加载 {total_count} 个账号（已修改: {modified_count} 个）")
        self._update_selection_count()

    def _refresh_all(self):
        """刷新所有数据（异步）"""
        self._log("正在刷新数据...")
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
        return {
            'api_key': ConfigManager.get_ai_api_key() or None,
            'base_url': ConfigManager.get_ai_base_url() or None,
            'model': ConfigManager.get_ai_model(),
            'max_steps': ConfigManager.get_ai_max_steps(),
        }

    def _start_process(self):
        """开始执行"""
        new_phone = self.phone_input.text().strip()
        if not new_phone:
            QMessageBox.warning(self, "警告", "请输入新的辅助手机号")
            return

        accounts = self._get_selected_accounts()
        if not accounts:
            QMessageBox.warning(self, "警告", "请选择要处理的账号")
            return

        # 确认
        reply = QMessageBox.question(
            self,
            "确认",
            f"确定要替换 {len(accounts)} 个账号的辅助手机号为 {new_phone}？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 保存当前操作的新手机号
        self.current_new_phone = new_phone

        # 重置状态
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    child.setText(3, "等待中")
                    child.setText(4, "")

        # 获取 AI 配置
        ai_config = self._get_ai_config()
        if ai_config.get('base_url'):
            self._log(f"API Base URL: {ai_config['base_url']}")
        self._log(f"模型: {ai_config.get('model', 'default')}")

        # 创建工作线程
        self.worker = ReplacePhoneWorker(
            accounts,
            new_phone,
            self.thread_spin.value(),
            self.close_after_check.isChecked(),
            ai_config=ai_config,
        )
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.log_signal.connect(self._log)

        # 更新 UI 状态
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.phone_input.setEnabled(False)
        self.refresh_btn.setEnabled(False)
        self.select_all_btn.setEnabled(False)
        self.deselect_all_btn.setEnabled(False)
        self.clear_history_btn.setEnabled(False)

        self._log(f"开始处理 {len(accounts)} 个账号...")
        self.worker.start()

    def _stop_process(self):
        """停止执行"""
        if self.worker:
            self.worker.stop()
            self._log("⚠️ 正在停止...")

    def _on_progress(self, browser_id: str, status: str, message: str):
        """处理进度更新"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(2) == browser_id:
                    child.setText(3, status)
                    child.setText(4, message)

                    # 根据状态设置颜色
                    if status == "成功":
                        child.setBackground(3, Qt.GlobalColor.green)

                        # 保存修改记录到数据库
                        data = child.data(0, Qt.ItemDataRole.UserRole)
                        if data and data.get("type") == "browser":
                            email = data.get("account", {}).get("email", "")
                            if email and self.current_new_phone:
                                self.db_manager.add_phone_modification(email, self.current_new_phone)
                                # 更新本地缓存
                                self.modification_history[email] = {
                                    'new_phone': self.current_new_phone,
                                    'modified_at': 'now'
                                }
                                # 更新显示
                                child.setText(4, f"→ {self.current_new_phone}")
                                # 设置置灰样式（跳过状态列，保留绿色背景的可读性）
                                gray_color = QColor(150, 150, 150)
                                gray_brush = QBrush(gray_color)
                                for col in [0, 1, 2, 4]:  # 跳过状态列(3)
                                    child.setForeground(col, gray_brush)

                    elif status == "失败" or status == "错误":
                        child.setBackground(3, Qt.GlobalColor.red)
                    return

    def _clear_modification_history(self):
        """清除已修改记录"""
        if not self.modification_history:
            QMessageBox.information(self, "提示", "没有已修改的记录")
            return

        reply = QMessageBox.question(
            self,
            "确认清除",
            f"确定要清除 {len(self.modification_history)} 条已修改记录？\n\n"
            "这将重置所有账号的修改状态，但不会撤销已完成的手机号修改。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 清除数据库记录
        deleted = self.db_manager.clear_phone_modification_history()
        self.modification_history = {}

        # 刷新列表（使用缓存数据重新填充，无需重新加载）
        self._populate_account_tree()
        self._log(f"✅ 已清除 {deleted} 条修改记录")

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.phone_input.setEnabled(True)
        self.refresh_btn.setEnabled(True)
        self.select_all_btn.setEnabled(True)
        self.deselect_all_btn.setEnabled(True)
        self.clear_history_btn.setEnabled(True)

        self._log("✅ 处理完成")
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


# 测试入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    dialog = ReplacePhoneWindow()
    dialog.show()
    sys.exit(app.exec())
