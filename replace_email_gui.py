"""
一键替换辅助邮箱 GUI 窗口
支持批量替换 Google 账号的辅助邮箱，自动读取验证码完成验证
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

from playwright.async_api import async_playwright

from ix_api import openBrowser, closeBrowser
from ix_window import get_browser_list
from database import DBManager
from auto_replace_email import auto_replace_email
from email_code_reader import GmailCodeReader
from core.config_manager import ConfigManager


class ReplaceEmailWorker(QThread):
    """后台工作线程"""
    progress_signal = pyqtSignal(str, str, str)  # browser_id, status, message
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)

    def __init__(
        self,
        accounts: list[dict],
        new_email: str,
        gmail_email: str,
        gmail_password: str,
        thread_count: int,
        close_after: bool,
    ):
        super().__init__()
        self.accounts = accounts
        self.new_email = new_email
        self.gmail_email = gmail_email
        self.gmail_password = gmail_password
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
        if not self.new_email:
            self._log("⚠️ 没有输入辅助邮箱")
            return
        if not self.gmail_email or not self.gmail_password:
            self._log("⚠️ Gmail IMAP 未配置")
            return

        semaphore = asyncio.Semaphore(self.thread_count)
        tasks = []

        for idx, account in enumerate(self.accounts, start=1):
            if not self.is_running:
                break
            tasks.append(self._process_one_with_semaphore(semaphore, idx, account))

        if not tasks:
            return

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _process_one_with_semaphore(self, semaphore: asyncio.Semaphore, idx: int, account: dict):
        async with semaphore:
            if not self.is_running:
                return
            await self._process_one(idx, account)

    async def _process_one(self, idx: int, account: dict):
        browser_id = (account.get("browser_id") or "").strip()
        email = (account.get("email") or "").strip()

        if not browser_id:
            return

        self.progress_signal.emit(browser_id, "处理中", f"替换辅助邮箱: {self.new_email}")
        self._log(f"[{idx}] 开始替换辅助邮箱: {email} ({browser_id})")

        opened = False
        code_reader = None
        try:
            res = openBrowser(browser_id)
            if not res or not res.get("success", False):
                raise RuntimeError(f"打开浏览器失败: {res}")
            opened = True

            ws_endpoint = res.get("data", {}).get("ws")
            if not ws_endpoint:
                raise RuntimeError("打开浏览器成功但未返回 ws 端点")

            # 创建验证码读取器
            code_reader = GmailCodeReader(self.gmail_email, self.gmail_password)

            async with async_playwright() as playwright:
                chromium = playwright.chromium
                cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
                browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
                default_context = browser.contexts[0]
                page = default_context.pages[0] if default_context.pages else await default_context.new_page()

                # 构建账号信息
                account_info = {
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', ''),
                }

                # 执行替换辅助邮箱
                success, message = await auto_replace_email(page, self.new_email, account_info, code_reader)

                if success:
                    self.progress_signal.emit(browser_id, "✅ 成功", message)
                    self._log(f"[{idx}] ✅ {email}: {message}")
                else:
                    self.progress_signal.emit(browser_id, "❌ 失败", message)
                    self._log(f"[{idx}] ❌ {email}: {message}")

        except Exception as e:
            err = f"异常: {e}"
            self.progress_signal.emit(browser_id, "❌ 异常", err)
            self._log(f"[{idx}] ❌ {email}: {err}")
            traceback.print_exc()
        finally:
            if code_reader:
                code_reader.disconnect()
            if opened and self.close_after:
                try:
                    closeBrowser(browser_id)
                except Exception:
                    pass


class ReplaceEmailWindow(QDialog):
    """一键替换辅助邮箱窗口"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.worker: ReplaceEmailWorker | None = None
        self.accounts: list[dict] = []

        self.setWindowTitle("一键替换辅助邮箱")
        self.resize(1000, 700)

        self._init_ui()
        self.refresh_accounts()

    def _init_ui(self):
        layout = QVBoxLayout()

        # Gmail 配置区域
        gmail_group = QGroupBox("Gmail 验证码邮箱（用于接收验证码）")
        gmail_layout = QFormLayout()

        # Gmail 邮箱（只读，来自配置）
        gmail_email_layout = QHBoxLayout()
        self.gmail_email_label = QLabel("")
        self.gmail_email_label.setStyleSheet("color: #333; font-weight: bold;")
        gmail_email_layout.addWidget(self.gmail_email_label)

        self.btn_goto_settings = QPushButton("前往设置")
        self.btn_goto_settings.clicked.connect(self._goto_settings)
        gmail_email_layout.addWidget(self.btn_goto_settings)
        gmail_email_layout.addStretch()
        gmail_layout.addRow("已配置邮箱:", gmail_email_layout)

        gmail_hint = QLabel("提示: 在「配置管理 → 全局设置」中设置 Gmail 应用专用密码")
        gmail_hint.setStyleSheet("color: #666; font-size: 11px;")
        gmail_layout.addRow("", gmail_hint)

        gmail_group.setLayout(gmail_layout)
        layout.addWidget(gmail_group)

        # 设置区域
        settings_group = QGroupBox("替换设置")
        settings_layout = QFormLayout()

        # 辅助邮箱输入
        email_layout = QHBoxLayout()
        self.email_input = QLineEdit()
        self.email_input.setPlaceholderText("输入新辅助邮箱")
        self.email_input.setMinimumWidth(300)
        email_layout.addWidget(self.email_input)

        email_hint = QLabel("（建议与 Gmail 验证码邮箱相同，以便接收验证码）")
        email_hint.setStyleSheet("color: #666; font-size: 12px;")
        email_layout.addWidget(email_hint)
        email_layout.addStretch()
        settings_layout.addRow("新辅助邮箱:", email_layout)

        # 一键使用 Gmail 邮箱按钮
        use_gmail_layout = QHBoxLayout()
        self.btn_use_gmail = QPushButton("使用已配置的 Gmail 邮箱")
        self.btn_use_gmail.clicked.connect(self._use_gmail_email)
        use_gmail_layout.addWidget(self.btn_use_gmail)
        use_gmail_layout.addStretch()
        settings_layout.addRow("", use_gmail_layout)

        # 并发数
        self.thread_count_spin = QSpinBox()
        self.thread_count_spin.setMinimum(1)
        self.thread_count_spin.setMaximum(5)
        self.thread_count_spin.setValue(1)
        settings_layout.addRow("并发数:", self.thread_count_spin)

        concurrency_hint = QLabel("（验证码读取需要时间，建议并发数设为 1）")
        concurrency_hint.setStyleSheet("color: #999; font-size: 11px;")
        settings_layout.addRow("", concurrency_hint)

        # 完成后关闭
        self.close_after_checkbox = QCheckBox("完成后关闭窗口（更省资源）")
        self.close_after_checkbox.setChecked(False)
        settings_layout.addRow("", self.close_after_checkbox)

        settings_group.setLayout(settings_layout)
        layout.addWidget(settings_group)

        # 账号信息
        info_layout = QHBoxLayout()
        self.account_count_label = QLabel("账号: 0")
        info_layout.addWidget(self.account_count_label)
        info_layout.addStretch()

        self.btn_refresh = QPushButton("刷新列表")
        self.btn_refresh.clicked.connect(self.refresh_accounts)
        info_layout.addWidget(self.btn_refresh)
        layout.addLayout(info_layout)

        # 全选
        select_layout = QHBoxLayout()
        self.select_all_checkbox = QCheckBox("全选/取消全选")
        self.select_all_checkbox.stateChanged.connect(self._toggle_select_all)
        select_layout.addWidget(self.select_all_checkbox)
        select_layout.addStretch()
        layout.addLayout(select_layout)

        # 账号列表表格
        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["选择", "邮箱", "浏览器ID", "状态", "消息"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table)

        # 日志
        log_label = QLabel("运行日志:")
        layout.addWidget(log_label)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(150)
        layout.addWidget(self.log_text)

        # 按钮
        button_layout = QHBoxLayout()
        self.btn_start = QPushButton("开始替换辅助邮箱")
        self.btn_start.clicked.connect(self.start_processing)
        button_layout.addWidget(self.btn_start)

        self.btn_stop = QPushButton("停止")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self.stop_processing)
        button_layout.addWidget(self.btn_stop)

        layout.addLayout(button_layout)
        self.setLayout(layout)

        # 加载 Gmail 配置
        self._load_gmail_config()

    def _load_gmail_config(self):
        """加载 Gmail 配置"""
        try:
            ConfigManager.load()
            gmail_email = ConfigManager.get("gmail_imap_email", "")
            if gmail_email:
                self.gmail_email_label.setText(gmail_email)
                self.gmail_email_label.setStyleSheet("color: #2e7d32; font-weight: bold;")
            else:
                self.gmail_email_label.setText("(未配置)")
                self.gmail_email_label.setStyleSheet("color: #d32f2f; font-weight: bold;")
        except Exception as e:
            self.gmail_email_label.setText(f"(加载失败: {e})")
            self.gmail_email_label.setStyleSheet("color: #d32f2f;")

    def _goto_settings(self):
        """提示用户前往设置"""
        QMessageBox.information(
            self,
            "设置提示",
            "请在主界面点击「配置管理」，然后切换到「全局设置」标签页，\n"
            "在「Gmail 验证码邮箱」区域填写 Gmail 地址和应用专用密码。\n\n"
            "注意：需要在 Google 账号中开启两步验证，并生成「应用专用密码」。"
        )

    def _use_gmail_email(self):
        """使用已配置的 Gmail 邮箱作为辅助邮箱"""
        gmail_email = ConfigManager.get("gmail_imap_email", "")
        if gmail_email:
            self.email_input.setText(gmail_email)
            self.log("✅ 已使用配置的 Gmail 邮箱")
        else:
            QMessageBox.warning(self, "提示", "Gmail 邮箱未配置，请先在配置管理中设置")

    def log(self, message: str):
        self.log_text.append(message)
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def refresh_accounts(self):
        """加载账号列表（所有账号）"""
        try:
            DBManager.init_db()
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            # 获取所有账号（不限状态）
            cursor.execute(
                """
                SELECT email, password, recovery_email, secret_key, status
                FROM accounts
                ORDER BY email
                """
            )
            rows = cursor.fetchall()
            conn.close()

            # 获取浏览器列表，建立邮箱到浏览器ID的映射
            browsers = get_browser_list(page=1, limit=1000)
            email_to_browser_id: dict[str, str] = {}
            for browser in browsers:
                remark = browser.get("note", "") or ""
                if "----" not in remark:
                    continue
                parts = remark.split("----")
                if not parts:
                    continue
                browser_email = (parts[0] or "").strip()
                if "@" not in browser_email:
                    continue
                email_to_browser_id[browser_email] = str(browser.get("profile_id", "")) or ""

            self.accounts = []
            self.table.setRowCount(0)
            self.select_all_checkbox.setChecked(False)

            for row in rows:
                email = (row[0] or "").strip()
                browser_id = (email_to_browser_id.get(email) or "").strip()
                if not browser_id:
                    continue  # 只显示有对应浏览器的账号

                account = {
                    "email": email,
                    "password": row[1] or "",
                    "backup": row[2] or "",
                    "secret": row[3] or "",
                    "status": row[4] or "",
                    "browser_id": browser_id,
                }
                self.accounts.append(account)

                row_idx = self.table.rowCount()
                self.table.insertRow(row_idx)

                # 勾选框
                checkbox = QCheckBox()
                checkbox.setChecked(True)
                checkbox_widget = QWidget()
                checkbox_layout = QHBoxLayout(checkbox_widget)
                checkbox_layout.addWidget(checkbox)
                checkbox_layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
                checkbox_layout.setContentsMargins(0, 0, 0, 0)
                self.table.setCellWidget(row_idx, 0, checkbox_widget)

                self.table.setItem(row_idx, 1, QTableWidgetItem(email))
                self.table.setItem(row_idx, 2, QTableWidgetItem(browser_id))
                self.table.setItem(row_idx, 3, QTableWidgetItem("Ready"))
                self.table.setItem(row_idx, 4, QTableWidgetItem(""))

            self.account_count_label.setText(f"账号: {len(self.accounts)}")
            self.log(f"✅ 加载账号: {len(self.accounts)} 个（仅显示有对应浏览器的账号）")

            # 刷新 Gmail 配置显示
            self._load_gmail_config()

        except Exception as e:
            self.account_count_label.setText("账号: 0")
            self.log(f"❌ 加载账号失败: {e}")
            traceback.print_exc()

    def _toggle_select_all(self, state: int):
        is_checked = state == Qt.CheckState.Checked.value
        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if not checkbox_widget:
                continue
            checkbox = checkbox_widget.findChild(QCheckBox)
            if checkbox:
                checkbox.setChecked(is_checked)

    def _get_selected_accounts(self) -> list[dict]:
        selected = []
        for row in range(self.table.rowCount()):
            checkbox_widget = self.table.cellWidget(row, 0)
            if not checkbox_widget:
                continue
            checkbox = checkbox_widget.findChild(QCheckBox)
            if checkbox and checkbox.isChecked():
                if row < len(self.accounts):
                    selected.append(self.accounts[row])
        return selected

    def start_processing(self):
        if self.worker and self.worker.isRunning():
            QMessageBox.warning(self, "提示", "任务正在运行中")
            return

        new_email = self.email_input.text().strip()
        if not new_email:
            QMessageBox.warning(self, "提示", "请输入新辅助邮箱")
            return

        if '@' not in new_email:
            QMessageBox.warning(self, "提示", "请输入有效的邮箱地址")
            return

        # 检查 Gmail 配置
        gmail_email = ConfigManager.get("gmail_imap_email", "")
        gmail_password = ConfigManager.get("gmail_imap_password", "")
        if not gmail_email or not gmail_password:
            QMessageBox.warning(
                self, "配置缺失",
                "Gmail 验证码邮箱未配置，请先在「配置管理 → 全局设置」中设置。"
            )
            return

        # 验证码邮箱警告
        if new_email.lower() != gmail_email.lower():
            reply = QMessageBox.question(
                self, "确认",
                f"新辅助邮箱 ({new_email}) 与 Gmail 验证码邮箱 ({gmail_email}) 不同，\n"
                f"这意味着验证码将发送到 {new_email}，但系统将从 {gmail_email} 读取验证码。\n\n"
                f"如果这两个邮箱不是同一个邮箱，验证码读取将会失败。\n\n"
                f"确定要继续吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

        selected_accounts = self._get_selected_accounts()
        if not selected_accounts:
            QMessageBox.warning(self, "提示", "请先勾选要处理的账号")
            return

        thread_count = self.thread_count_spin.value()
        close_after = self.close_after_checkbox.isChecked()

        self.log(f"\n{'=' * 50}")
        self.log("开始一键替换辅助邮箱")
        self.log(f"新辅助邮箱: {new_email}")
        self.log(f"验证码邮箱: {gmail_email}")
        self.log(f"选中账号: {len(selected_accounts)}")
        self.log(f"并发数: {thread_count}")
        self.log(f"完成后关闭窗口: {'是' if close_after else '否'}")
        self.log(f"{'=' * 50}\n")

        self.worker = ReplaceEmailWorker(
            selected_accounts,
            new_email,
            gmail_email,
            gmail_password,
            thread_count,
            close_after,
        )
        self.worker.progress_signal.connect(self._update_account_status)
        self.worker.log_signal.connect(self.log)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.start()

        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.btn_refresh.setEnabled(False)

    def stop_processing(self):
        if self.worker:
            self.worker.stop()
            self.log("⏹️ 正在停止（会在当前任务结束后退出）...")

    def _on_finished(self):
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.btn_refresh.setEnabled(True)
        self.log("\n✅ 替换辅助邮箱任务结束")
        QMessageBox.information(self, "完成", "替换辅助邮箱任务已结束")

    def _update_account_status(self, browser_id: str, status: str, message: str):
        for row in range(self.table.rowCount()):
            if self.table.item(row, 2) and self.table.item(row, 2).text() == browser_id:
                self.table.setItem(row, 3, QTableWidgetItem(status))
                self.table.setItem(row, 4, QTableWidgetItem(message))
                break


def main():
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    window = ReplaceEmailWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
