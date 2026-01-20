"""
一键修改 2-Step Verification 手机号 GUI 窗口
支持批量修改 Google 账号的 2SV 手机号
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
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QMessageBox,
    QWidget,
    QCheckBox,
    QSpinBox,
    QGroupBox,
    QFormLayout,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal

from ix_window import get_browser_list
from database import DBManager
from auto_modify_2sv_phone import auto_modify_2sv_phone


class Modify2SVPhoneWorker(QThread):
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
    ):
        super().__init__()
        self.accounts = accounts
        self.new_phone = new_phone
        self.thread_count = max(1, thread_count)
        self.close_after = close_after
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

                self._log(f"[{index + 1}] 开始修改 2SV 手机号: {email} ({browser_id})")
                self.progress_signal.emit(browser_id, "处理中", "正在修改...")

                try:
                    account_info = {
                        'email': account.get('email', ''),
                        'password': account.get('password', ''),
                        'secret': account.get('secret', ''),
                    }

                    success, msg = await auto_modify_2sv_phone(
                        browser_id,
                        account_info,
                        self.new_phone,
                        self.close_after,
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


class Modify2SVPhoneDialog(QDialog):
    """修改 2SV 手机号主对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键修改 2-Step Verification 手机号")
        self.setMinimumSize(900, 700)

        self.worker = None
        self.db_manager = DBManager()

        self._init_ui()
        self._load_accounts()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 设置区域
        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout(settings_group)

        # 新手机号输入
        self.phone_input = QLineEdit()
        self.phone_input.setPlaceholderText("输入新的 2SV 手机号（如 +1234567890）")
        settings_layout.addRow("新手机号:", self.phone_input)

        # 并发数
        self.thread_spin = QSpinBox()
        self.thread_spin.setRange(1, 10)
        self.thread_spin.setValue(1)
        settings_layout.addRow("并发数:", self.thread_spin)

        # 完成后关闭浏览器
        self.close_after_check = QCheckBox("完成后关闭浏览器")
        self.close_after_check.setChecked(True)
        settings_layout.addRow("", self.close_after_check)

        layout.addWidget(settings_group)

        # 账号列表
        list_group = QGroupBox("账号列表")
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
        self.refresh_btn.clicked.connect(self._load_accounts)
        toolbar.addWidget(self.refresh_btn)

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        list_layout.addLayout(toolbar)

        # 表格
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["选择", "窗口ID", "邮箱", "状态", "消息"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 50)
        self.table.itemChanged.connect(self._update_selection_count)
        list_layout.addWidget(self.table)

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

    def _load_accounts(self):
        """从数据库加载账号列表"""
        self.table.setRowCount(0)

        try:
            # 获取浏览器列表
            browsers = get_browser_list(page=0, limit=100)
            if not browsers:
                self._log("⚠️ 未获取到浏览器列表")
                return

            # 获取数据库账号
            accounts = self.db_manager.get_all_accounts()
            account_map = {acc['email']: acc for acc in accounts}

            for browser in browsers:
                browser_id = browser.get('id', '')
                browser_name = browser.get('name', '')

                # 从名称中提取邮箱
                email = browser_name
                if '----' in browser_name:
                    email = browser_name.split('----')[0]

                account = account_map.get(email, {})

                row = self.table.rowCount()
                self.table.insertRow(row)

                # 复选框
                checkbox = QTableWidgetItem()
                checkbox.setFlags(Qt.ItemFlag.ItemIsUserCheckable | Qt.ItemFlag.ItemIsEnabled)
                checkbox.setCheckState(Qt.CheckState.Unchecked)
                self.table.setItem(row, 0, checkbox)

                # 窗口ID
                self.table.setItem(row, 1, QTableWidgetItem(browser_id))

                # 邮箱
                self.table.setItem(row, 2, QTableWidgetItem(email))

                # 状态
                self.table.setItem(row, 3, QTableWidgetItem("待处理"))

                # 消息
                self.table.setItem(row, 4, QTableWidgetItem(""))

                # 存储账号信息
                self.table.item(row, 0).setData(Qt.ItemDataRole.UserRole, {
                    'browser_id': browser_id,
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', ''),
                })

            self._log(f"已加载 {self.table.rowCount()} 个账号")

        except Exception as e:
            self._log(f"❌ 加载账号失败: {e}")
            traceback.print_exc()

    def _select_all(self):
        for row in range(self.table.rowCount()):
            self.table.item(row, 0).setCheckState(Qt.CheckState.Checked)

    def _deselect_all(self):
        for row in range(self.table.rowCount()):
            self.table.item(row, 0).setCheckState(Qt.CheckState.Unchecked)

    def _update_selection_count(self):
        count = sum(
            1 for row in range(self.table.rowCount())
            if self.table.item(row, 0).checkState() == Qt.CheckState.Checked
        )
        self.selected_label.setText(f"已选择: {count} 个账号")

    def _get_selected_accounts(self) -> list[dict]:
        """获取选中的账号列表"""
        accounts = []
        for row in range(self.table.rowCount()):
            if self.table.item(row, 0).checkState() == Qt.CheckState.Checked:
                account = self.table.item(row, 0).data(Qt.ItemDataRole.UserRole)
                if account:
                    accounts.append(account)
        return accounts

    def _log(self, message: str):
        self.log_text.append(message)
        self.log_text.ensureCursorVisible()

    def _start_process(self):
        """开始执行"""
        new_phone = self.phone_input.text().strip()
        if not new_phone:
            QMessageBox.warning(self, "警告", "请输入新的 2SV 手机号")
            return

        accounts = self._get_selected_accounts()
        if not accounts:
            QMessageBox.warning(self, "警告", "请选择要处理的账号")
            return

        # 确认
        reply = QMessageBox.question(
            self,
            "确认",
            f"确定要修改 {len(accounts)} 个账号的 2SV 手机号为 {new_phone}？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 重置状态
        for row in range(self.table.rowCount()):
            if self.table.item(row, 0).checkState() == Qt.CheckState.Checked:
                self.table.item(row, 3).setText("等待中")
                self.table.item(row, 4).setText("")

        # 创建工作线程
        self.worker = Modify2SVPhoneWorker(
            accounts,
            new_phone,
            self.thread_spin.value(),
            self.close_after_check.isChecked(),
        )
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.log_signal.connect(self._log)

        # 更新 UI 状态
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.phone_input.setEnabled(False)

        self._log(f"开始处理 {len(accounts)} 个账号...")
        self.worker.start()

    def _stop_process(self):
        """停止执行"""
        if self.worker:
            self.worker.stop()
            self._log("⚠️ 正在停止...")

    def _on_progress(self, browser_id: str, status: str, message: str):
        """处理进度更新"""
        for row in range(self.table.rowCount()):
            if self.table.item(row, 1).text() == browser_id:
                self.table.item(row, 3).setText(status)
                self.table.item(row, 4).setText(message)

                # 根据状态设置颜色
                if status == "成功":
                    self.table.item(row, 3).setBackground(Qt.GlobalColor.green)
                elif status == "失败" or status == "错误":
                    self.table.item(row, 3).setBackground(Qt.GlobalColor.red)
                break

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.phone_input.setEnabled(True)

        self._log("✅ 处理完成")
        self.worker = None

    def closeEvent(self, event):
        """关闭窗口时停止工作线程"""
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(3000)
        event.accept()


# 测试入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    dialog = Modify2SVPhoneDialog()
    dialog.show()
    sys.exit(app.exec())
