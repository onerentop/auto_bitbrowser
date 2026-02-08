"""
一键全自动订阅 GUI

整合三个步骤为一次完整操作：
1. 获取 SheerID 链接 (AI Agent)
2. 批量验证 SheerID (API)
3. 绑卡订阅 (AI Agent)

支持断点续传：记录失败步骤，下次从失败处继续
"""
import sys
import os
import asyncio
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QTextEdit, QTableWidget, QTableWidgetItem,
    QHeaderView, QMessageBox, QCheckBox, QSpinBox, QGroupBox,
    QFormLayout, QComboBox, QSplitter, QProgressBar
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QColor, QFont

from services.database import DBManager
from services.ix_window import get_browser_list
from services.data_store import get_data_store
from core.config_manager import ConfigManager
from application.automation_engine_adapter import AutomationEngineAdapter


class AutoSubscribeWorker(QThread):
    """一键全自动订阅工作线程"""

    progress_signal = pyqtSignal(str, str, str)  # email, step, message
    log_signal = pyqtSignal(str)
    account_complete_signal = pyqtSignal(str, bool, str, str)  # email, success, status, message
    finished_signal = pyqtSignal()

    def __init__(
        self,
        accounts: list,
        cards: list,
        cards_per_account: int,
        concurrent_count: int,
        sheerid_api_key: str,
        close_browser_after: bool = False,
    ):
        super().__init__()
        self.accounts = accounts
        self.cards = cards
        self.cards_per_account = cards_per_account
        self.concurrent_count = concurrent_count
        self.sheerid_api_key = sheerid_api_key
        self.close_browser_after = close_browser_after
        self.is_running = True

    def run(self):
        try:
            asyncio.run(self._process_all())
        except Exception as e:
            self.log_signal.emit(f"❌ 工作线程错误: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.finished_signal.emit()

    async def _process_all(self):
        """处理所有账号"""
        self.log_signal.emit(f"\n{'='*60}")
        self.log_signal.emit(f"开始一键全自动订阅")
        self.log_signal.emit(f"账号数: {len(self.accounts)} | 卡片数: {len(self.cards)}")
        self.log_signal.emit(f"一卡几绑: {self.cards_per_account} | 并发数: {self.concurrent_count}")
        self.log_signal.emit(f"{'='*60}\n")

        def on_progress(email, step, message):
            self.progress_signal.emit(email, step, message)

        def on_log(message):
            self.log_signal.emit(message)

        def on_complete(email, result):
            self.account_complete_signal.emit(
                email,
                result.success,
                result.status,
                result.message
            )

        def stop_check():
            """检查是否请求停止"""
            return not self.is_running

        await AutomationEngineAdapter.run_auto_subscribe_batch(
            accounts=self.accounts,
            cards=self.cards,
            cards_per_account=self.cards_per_account,
            concurrent_count=self.concurrent_count,
            sheerid_api_key=self.sheerid_api_key,
            close_browser_after=self.close_browser_after,
            on_progress=on_progress,
            on_log=on_log,
            on_complete=on_complete,
            stop_check=stop_check,
        )

    def stop(self):
        """停止工作线程"""
        self.is_running = False


class LoadDataWorker(QThread):
    """异步加载数据的后台线程"""
    progress_signal = pyqtSignal(str)  # message
    finished_signal = pyqtSignal(dict)  # result data

    def __init__(self):
        super().__init__()
        self.is_running = True

    def stop(self):
        self.is_running = False

    def run(self):
        result = {
            'cards': [],
            'accounts': [],
            'logs': [],
        }
        try:
            # 阶段 1: 加载卡片
            self.progress_signal.emit("正在加载卡片数据...")
            if not self.is_running:
                result['logs'].append("⚠️ 加载已取消")
                self.finished_signal.emit(result)
                return

            try:
                data_store = get_data_store()
                data_store.reload()
                cards_raw = data_store.get_cards_as_dicts()

                if cards_raw:
                    for card in cards_raw:
                        number = card.get('number', '').strip()
                        exp_month = card.get('exp_month', '').strip()
                        exp_year = card.get('exp_year', '').strip()
                        cvv = card.get('cvv', '').strip()
                        name = card.get('name', 'John Smith').strip()
                        zip_code = card.get('zip_code', '10001').strip()

                        if not number or len(number) < 4:
                            continue

                        if len(exp_month) == 1:
                            exp_month = f'0{exp_month}'
                        if len(exp_year) == 4:
                            exp_year = exp_year[-2:]

                        result['cards'].append({
                            'number': number,
                            'exp_month': exp_month,
                            'exp_year': exp_year,
                            'cvv': cvv,
                            'name': name,
                            'zip_code': zip_code
                        })
                    result['logs'].append(f"✅ 加载了 {len(result['cards'])} 张卡片")
                else:
                    result['logs'].append("⚠️ 未找到卡片数据，请在配置管理中添加卡片")
            except Exception as e:
                result['logs'].append(f"❌ 加载卡片失败: {e}")

            # 阶段 2: 加载账号
            self.progress_signal.emit("正在加载账号数据...")
            if not self.is_running:
                result['logs'].append("⚠️ 加载已取消")
                self.finished_signal.emit(result)
                return

            try:
                DBManager.init_db()
                all_accounts = DBManager.get_all_accounts()
                result['logs'].append(f"📊 数据库中共 {len(all_accounts)} 个账号")

                # 阶段 3: 获取浏览器列表
                self.progress_signal.emit("正在获取浏览器列表...")
                if not self.is_running:
                    result['logs'].append("⚠️ 加载已取消")
                    self.finished_signal.emit(result)
                    return

                browsers = get_browser_list(page=1, limit=1000)

                if browsers is None or len(browsers) == 0:
                    result['logs'].append("⚠️ 未获取到浏览器列表，请确认 ixBrowser 已启动")
                else:
                    result['logs'].append(f"🌐 ixBrowser 中共 {len(browsers)} 个窗口")

                    # 建立邮箱到浏览器ID的映射
                    email_to_browser = {}
                    for browser in browsers:
                        remark = browser.get('note', '')
                        if '----' in remark:
                            parts = remark.split('----')
                            if parts and '@' in parts[0]:
                                browser_email = parts[0].strip()
                                browser_id = str(browser.get('profile_id', ''))
                                email_to_browser[browser_email] = browser_id

                    # 构建账号列表
                    skipped_no_browser = 0
                    skipped_finished = 0

                    for acc in all_accounts:
                        email = acc.get('email', '')
                        browser_id = email_to_browser.get(email, '')

                        if not browser_id:
                            skipped_no_browser += 1
                            continue

                        status = acc.get('status', 'pending')
                        if status in ('subscribed', 'ineligible'):
                            skipped_finished += 1
                            continue

                        result['accounts'].append({
                            'email': email,
                            'password': acc.get('password', ''),
                            'recovery_email': acc.get('recovery_email', ''),
                            'secret_key': acc.get('secret_key', ''),
                            'verification_link': acc.get('verification_link', ''),
                            'status': status,
                            'last_failed_step': acc.get('last_failed_step', ''),
                            'last_error': acc.get('last_error', ''),
                            'browser_id': browser_id,
                        })

                    if skipped_no_browser > 0:
                        result['logs'].append(f"⏭️ 跳过 {skipped_no_browser} 个无浏览器窗口的账号")
                    if skipped_finished > 0:
                        result['logs'].append(f"⏭️ 跳过 {skipped_finished} 个已完成/无资格的账号")

                    result['logs'].append(f"✅ 加载了 {len(result['accounts'])} 个待处理账号")

            except Exception as e:
                result['logs'].append(f"❌ 加载账号失败: {e}")

            self.finished_signal.emit(result)

        except Exception as e:
            self.finished_signal.emit({
                'cards': [],
                'accounts': [],
                'logs': [f"❌ 数据加载失败: {e}"]
            })


class AutoSubscribeWindow(QWidget):
    """一键全自动订阅窗口"""

    def __init__(self):
        super().__init__()
        self.worker = None
        self.load_worker = None  # 数据加载线程
        self.accounts = []
        self.cards = []
        self._first_show = True  # 首次显示标志
        self._is_loading = False  # 加载状态
        self.initUI()
        self.start_load_data()  # 使用异步加载

    def showEvent(self, event):
        """窗口显示时自动刷新数据"""
        super().showEvent(event)
        # 非首次显示时自动刷新数据（首次在 __init__ 中已加载）
        if not self._first_show:
            self.start_load_data()
        self._first_show = False

    def closeEvent(self, event):
        """窗口关闭时清理线程"""
        # 停止加载线程
        if self.load_worker and self.load_worker.isRunning():
            self.load_worker.stop()
            self.load_worker.wait(1000)  # 等待最多1秒

        # 停止工作线程
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(2000)  # 等待最多2秒

        super().closeEvent(event)

    def start_load_data(self):
        """启动异步数据加载"""
        if self._is_loading:
            return

        self._is_loading = True
        self.set_loading_state(True)
        self.log("⏳ 正在加载数据...")

        # 创建并启动加载线程
        self.load_worker = LoadDataWorker()
        self.load_worker.progress_signal.connect(self.on_load_progress)
        self.load_worker.finished_signal.connect(self.on_load_finished)
        self.load_worker.start()

    def on_load_progress(self, message: str):
        """加载进度回调"""
        self.log(f"⏳ {message}")

    def on_load_finished(self, result: dict):
        """加载完成回调"""
        self._is_loading = False
        self.set_loading_state(False)

        # 应用加载结果
        self.cards = result.get('cards', [])
        self.accounts = result.get('accounts', [])

        # 输出日志
        for log_msg in result.get('logs', []):
            self.log(log_msg)

        # 更新 UI
        self.card_count_label.setText(f"卡片: {len(self.cards)}")
        self.account_count_label.setText(f"账号: {len(self.accounts)}")
        self.refresh_table()

        self.load_worker = None

    def set_loading_state(self, loading: bool):
        """设置加载状态（禁用/启用按钮）"""
        self.btn_refresh.setEnabled(not loading)
        self.btn_start.setEnabled(not loading)
        if loading:
            self.btn_refresh.setText("加载中...")
        else:
            self.btn_refresh.setText("刷新列表")

    def initUI(self):
        self.setWindowTitle("一键全自动订阅")
        self.setGeometry(100, 100, 1200, 800)

        layout = QVBoxLayout()

        # 顶部设置区域
        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout()

        # 一卡几绑
        self.cards_per_account_spin = QSpinBox()
        self.cards_per_account_spin.setMinimum(1)
        self.cards_per_account_spin.setMaximum(100)
        self.cards_per_account_spin.setValue(1)
        settings_layout.addRow("一卡几绑:", self.cards_per_account_spin)

        # 并发数
        self.concurrent_spin = QSpinBox()
        self.concurrent_spin.setMinimum(1)
        self.concurrent_spin.setMaximum(10)
        self.concurrent_spin.setValue(3)
        settings_layout.addRow("并发数:", self.concurrent_spin)

        # 状态筛选
        self.status_filter = QComboBox()
        self.status_filter.addItems([
            "全部待处理",
            "仅 pending (未开始)",
            "仅 link_ready (待验证)",
            "仅 verified (待绑卡)",
            "仅 error (失败重试)",
        ])
        self.status_filter.currentIndexChanged.connect(self.filter_accounts)
        settings_layout.addRow("状态筛选:", self.status_filter)

        # 完成后关闭浏览器
        self.close_browser_check = QCheckBox("完成后关闭浏览器")
        self.close_browser_check.setChecked(False)
        settings_layout.addRow("", self.close_browser_check)

        settings_group.setLayout(settings_layout)
        layout.addWidget(settings_group)

        # 信息区域
        info_layout = QHBoxLayout()
        self.card_count_label = QLabel("卡片: 0")
        self.card_count_label.setStyleSheet("font-weight: bold; color: #2196F3;")
        info_layout.addWidget(self.card_count_label)

        self.account_count_label = QLabel("账号: 0")
        self.account_count_label.setStyleSheet("font-weight: bold; color: #4CAF50;")
        info_layout.addWidget(self.account_count_label)

        self.selected_count_label = QLabel("已选: 0")
        self.selected_count_label.setStyleSheet("font-weight: bold; color: #FF9800;")
        info_layout.addWidget(self.selected_count_label)

        info_layout.addStretch()

        # API Key 状态
        api_key = ConfigManager.get_api_key()
        if api_key:
            self.api_status_label = QLabel("✅ API Key 已配置")
            self.api_status_label.setStyleSheet("color: green;")
        else:
            self.api_status_label = QLabel("❌ 未配置 API Key")
            self.api_status_label.setStyleSheet("color: red;")
        info_layout.addWidget(self.api_status_label)

        layout.addLayout(info_layout)

        # 使用 QSplitter 分割表格和日志
        splitter = QSplitter(Qt.Orientation.Vertical)

        # 账号列表
        table_widget = QWidget()
        table_layout = QVBoxLayout(table_widget)
        table_layout.setContentsMargins(0, 0, 0, 0)

        # 全选复选框
        select_layout = QHBoxLayout()
        self.select_all_checkbox = QCheckBox("全选/取消全选")
        self.select_all_checkbox.stateChanged.connect(self.toggle_select_all)
        select_layout.addWidget(self.select_all_checkbox)
        select_layout.addStretch()
        table_layout.addLayout(select_layout)

        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels([
            "选择", "邮箱", "浏览器ID", "当前状态", "断点步骤", "处理状态", "消息"
        ])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        table_layout.addWidget(self.table)

        splitter.addWidget(table_widget)

        # 日志区域
        log_widget = QWidget()
        log_layout = QVBoxLayout(log_widget)
        log_layout.setContentsMargins(0, 0, 0, 0)

        log_label = QLabel("运行日志:")
        log_layout.addWidget(log_label)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setFont(QFont("Consolas", 9))
        log_layout.addWidget(self.log_text)

        splitter.addWidget(log_widget)

        # 设置初始比例
        splitter.setSizes([500, 200])

        layout.addWidget(splitter)

        # 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)

        # 按钮区域
        button_layout = QHBoxLayout()

        self.btn_refresh = QPushButton("刷新列表")
        self.btn_refresh.clicked.connect(self.start_load_data)
        button_layout.addWidget(self.btn_refresh)

        self.btn_start = QPushButton("🚀 开始一键订阅")
        self.btn_start.setStyleSheet("""
            QPushButton {
                background-color: #4CAF50;
                color: white;
                font-weight: bold;
                padding: 8px 20px;
                border-radius: 4px;
            }
            QPushButton:hover {
                background-color: #45a049;
            }
            QPushButton:disabled {
                background-color: #cccccc;
            }
        """)
        self.btn_start.clicked.connect(self.start_processing)
        button_layout.addWidget(self.btn_start)

        self.btn_stop = QPushButton("⏹ 停止")
        self.btn_stop.setEnabled(False)
        self.btn_stop.setStyleSheet("""
            QPushButton {
                background-color: #f44336;
                color: white;
                font-weight: bold;
                padding: 8px 20px;
                border-radius: 4px;
            }
            QPushButton:hover {
                background-color: #da190b;
            }
            QPushButton:disabled {
                background-color: #cccccc;
            }
        """)
        self.btn_stop.clicked.connect(self.stop_processing)
        button_layout.addWidget(self.btn_stop)

        layout.addLayout(button_layout)

        self.setLayout(layout)

    def refresh_table(self):
        """刷新表格显示"""
        self.table.setRowCount(0)

        # 应用筛选
        filter_index = self.status_filter.currentIndex()
        filtered_accounts = self.get_filtered_accounts(filter_index)

        for account in filtered_accounts:
            row_idx = self.table.rowCount()
            self.table.insertRow(row_idx)

            # 复选框
            checkbox = QCheckBox()
            checkbox.setChecked(True)
            checkbox.stateChanged.connect(self.update_selected_count)
            checkbox_widget = QWidget()
            checkbox_layout = QHBoxLayout(checkbox_widget)
            checkbox_layout.addWidget(checkbox)
            checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkbox_layout.setContentsMargins(0, 0, 0, 0)
            self.table.setCellWidget(row_idx, 0, checkbox_widget)

            # 邮箱
            self.table.setItem(row_idx, 1, QTableWidgetItem(account['email']))

            # 浏览器ID
            self.table.setItem(row_idx, 2, QTableWidgetItem(account['browser_id']))

            # 当前状态
            status = account.get('status', 'pending')
            status_item = QTableWidgetItem(self._get_status_display(status))
            status_item.setForeground(self._get_status_color(status))
            self.table.setItem(row_idx, 3, status_item)

            # 断点步骤
            last_step = account.get('last_failed_step', '')
            self.table.setItem(row_idx, 4, QTableWidgetItem(last_step or "-"))

            # 处理状态
            self.table.setItem(row_idx, 5, QTableWidgetItem("待处理"))

            # 消息
            last_error = account.get('last_error', '')
            self.table.setItem(row_idx, 6, QTableWidgetItem(last_error[:50] if last_error else ""))

        self.update_selected_count()

    def get_filtered_accounts(self, filter_index: int) -> list:
        """根据筛选条件获取账号"""
        if filter_index == 0:  # 全部待处理
            return self.accounts
        elif filter_index == 1:  # 仅 pending
            return [a for a in self.accounts if a.get('status') == 'pending']
        elif filter_index == 2:  # 仅 link_ready
            return [a for a in self.accounts if a.get('status') == 'link_ready']
        elif filter_index == 3:  # 仅 verified
            return [a for a in self.accounts if a.get('status') == 'verified']
        elif filter_index == 4:  # 仅 error
            return [a for a in self.accounts if a.get('status') == 'error']
        return self.accounts

    def filter_accounts(self):
        """筛选账号"""
        self.refresh_table()

    def _get_status_display(self, status: str) -> str:
        """获取状态显示文本"""
        status_map = {
            'pending': '待处理',
            'link_ready': '待验证',
            'verified': '待绑卡',
            'subscribed': '已订阅',
            'ineligible': '无资格',
            'error': '失败',
        }
        return status_map.get(status, status)

    def _get_status_color(self, status: str) -> QColor:
        """获取状态颜色"""
        color_map = {
            'pending': QColor('#666666'),
            'link_ready': QColor('#2196F3'),
            'verified': QColor('#FF9800'),
            'subscribed': QColor('#4CAF50'),
            'ineligible': QColor('#9E9E9E'),
            'error': QColor('#F44336'),
        }
        return color_map.get(status, QColor('#666666'))

    def toggle_select_all(self, state):
        """全选/取消全选"""
        is_checked = (state == Qt.CheckState.Checked.value)
        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox:
                    checkbox.setChecked(is_checked)

    def update_selected_count(self):
        """更新已选数量"""
        selected = self.get_selected_accounts()
        self.selected_count_label.setText(f"已选: {len(selected)}")

    def get_selected_accounts(self) -> list:
        """获取选中的账号"""
        selected = []
        filter_index = self.status_filter.currentIndex()
        filtered_accounts = self.get_filtered_accounts(filter_index)

        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if checkbox_widget:
                checkbox = checkbox_widget.findChild(QCheckBox)
                if checkbox and checkbox.isChecked():
                    if row < len(filtered_accounts):
                        selected.append(filtered_accounts[row])
        return selected

    def start_processing(self):
        """开始处理"""
        selected_accounts = self.get_selected_accounts()

        if not selected_accounts:
            QMessageBox.warning(self, "提示", "请先勾选要处理的账号")
            return

        if not self.cards:
            QMessageBox.warning(self, "提示", "没有可用的卡片，请在配置管理中添加卡片")
            return

        api_key = ConfigManager.get_api_key()
        if not api_key:
            QMessageBox.warning(self, "提示", "未配置 SheerID API Key，请在配置管理中设置")
            return

        # 收集设置
        cards_per_account = self.cards_per_account_spin.value()
        concurrent_count = self.concurrent_spin.value()

        # 检查卡片是否足够
        needed_cards = (len(selected_accounts) + cards_per_account - 1) // cards_per_account
        if needed_cards > len(self.cards):
            result = QMessageBox.question(
                self, "卡片不足",
                f"需要至少 {needed_cards} 张卡片，但只有 {len(self.cards)} 张。\n"
                f"部分账号将无法绑卡。是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if result != QMessageBox.StandardButton.Yes:
                return

        self.log(f"\n{'='*60}")
        self.log(f"开始一键全自动订阅")
        self.log(f"选中账号: {len(selected_accounts)}")
        self.log(f"卡片数量: {len(self.cards)}")
        self.log(f"一卡几绑: {cards_per_account}")
        self.log(f"并发数: {concurrent_count}")
        self.log(f"完成后关闭浏览器: {'是' if self.close_browser_check.isChecked() else '否'}")
        self.log(f"{'='*60}\n")

        # 创建并启动工作线程
        self.worker = AutoSubscribeWorker(
            selected_accounts,
            self.cards,
            cards_per_account,
            concurrent_count,
            api_key,
            self.close_browser_check.isChecked(),
        )
        self.worker.progress_signal.connect(self.on_progress)
        self.worker.log_signal.connect(self.log)
        self.worker.account_complete_signal.connect(self.on_account_complete)
        self.worker.finished_signal.connect(self.on_finished)
        self.worker.start()

        # 更新界面状态
        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.btn_refresh.setEnabled(False)
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(selected_accounts))
        self.progress_bar.setValue(0)

    def stop_processing(self):
        """停止处理"""
        if self.worker:
            self.worker.stop()
            self.log("⚠️ 正在停止...")

    def on_progress(self, email: str, step: str, message: str):
        """处理进度更新"""
        # 更新表格中对应行的状态
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 1)
            if item and item.text() == email:
                self.table.setItem(row, 5, QTableWidgetItem(step))
                self.table.setItem(row, 6, QTableWidgetItem(message))
                break

    def on_account_complete(self, email: str, success: bool, status: str, message: str):
        """单个账号处理完成"""
        # 更新表格
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 1)
            if item and item.text() == email:
                if success:
                    self.table.setItem(row, 5, QTableWidgetItem("✅ 完成"))
                else:
                    self.table.setItem(row, 5, QTableWidgetItem("❌ 失败"))

                self.table.setItem(row, 6, QTableWidgetItem(message))

                # 更新状态列
                status_item = QTableWidgetItem(self._get_status_display(status))
                status_item.setForeground(self._get_status_color(status))
                self.table.setItem(row, 3, status_item)
                break

        # 更新进度条
        current = self.progress_bar.value()
        self.progress_bar.setValue(current + 1)

    def on_finished(self):
        """处理完成"""
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_refresh.setEnabled(True)
        self.progress_bar.setVisible(False)

        self.log("\n" + "="*60)
        self.log("✅ 一键全自动订阅任务完成！")
        self.log("="*60)

        # 统计本次处理结果
        success_count = 0
        fail_count = 0
        pending_count = 0
        for row in range(self.table.rowCount()):
            status_item = self.table.item(row, 5)  # 处理状态列
            if status_item:
                status_text = status_item.text()
                if "✅" in status_text or "完成" in status_text:
                    success_count += 1
                elif "❌" in status_text or "失败" in status_text:
                    fail_count += 1
                elif status_text == "待处理":
                    pending_count += 1
                # 其他状态（如 "获取链接"、"验证SheerID" 等）表示任务被中途停止

        # 计算被中断的数量
        total_rows = self.table.rowCount()
        interrupted_count = total_rows - success_count - fail_count - pending_count

        # 显示结果统计，不自动刷新列表
        msg = f"一键全自动订阅任务已完成\n\n成功: {success_count} 个\n失败: {fail_count} 个"
        if interrupted_count > 0:
            msg += f"\n中断: {interrupted_count} 个"
        if fail_count > 0 or interrupted_count > 0:
            msg += "\n\n💡 提示: 结果已保留在列表中，可查看详情后手动刷新"

        QMessageBox.information(self, "完成", msg)
        # 注意：不再自动刷新数据，保留处理结果供用户查看
        # 用户可以手动点击「刷新列表」按钮更新

    def log(self, message: str):
        """添加日志"""
        self.log_text.append(message)
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())


def main():
    app = QApplication(sys.argv)
    window = AutoSubscribeWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
