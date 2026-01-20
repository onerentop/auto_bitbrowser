import sys
import os
import asyncio
import traceback

import pyotp
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
from account_manager import AccountManager
from auto_bind_card import auto_bind_card
from data_store import get_data_store


def _mask_card_number(card_number: str) -> str:
    # Why: 卡号属于敏感信息，日志/界面只展示末4位
    digits = "".join([c for c in str(card_number) if c.isdigit()])
    if len(digits) <= 4:
        return "****"
    return f"**** **** **** {digits[-4:]}"


def _safe_int(value: str, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return default


class BindCardWorker(QThread):
    progress_signal = pyqtSignal(str, str, str)  # browser_id, status, message
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)

    def __init__(
        self,
        accounts: list[dict],
        cards: list[dict],
        cards_per_account: int,
        thread_count: int,
        close_after: bool,
    ):
        super().__init__()
        self.accounts = accounts
        self.cards = cards
        self.cards_per_account = max(1, cards_per_account)
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
        if not self.cards:
            self._log("⚠️ 没有可用卡片")
            return

        semaphore = asyncio.Semaphore(self.thread_count)
        tasks = []

        card_index = 0
        card_usage_count = 0

        for idx, account in enumerate(self.accounts, start=1):
            if not self.is_running:
                break

            if card_usage_count >= self.cards_per_account:
                card_index += 1
                card_usage_count = 0

            if card_index >= len(self.cards):
                self._log("⚠️ 卡片已用完，停止处理")
                break

            card = self.cards[card_index]
            card_usage_count += 1

            tasks.append(self._process_one_with_semaphore(semaphore, idx, account, card))

        if not tasks:
            return

        await asyncio.gather(*tasks, return_exceptions=True)

    async def _process_one_with_semaphore(self, semaphore: asyncio.Semaphore, idx: int, account: dict, card: dict):
        async with semaphore:
            if not self.is_running:
                return
            await self._process_one(idx, account, card)

    async def _login_if_needed(self, page, account: dict):
        """
        尝试登录 Google（如果检测到登录页输入框）。

        Why: 绑卡前必须处于已登录状态；但部分窗口可能已登录，需兼容跳过。
        """
        try:
            await page.goto("https://accounts.google.com", timeout=60000)
        except Exception as e:
            self._log(f"⚠️ 打开 accounts.google.com 失败（可能网络较慢/已打开其他页）: {e}")

        email = (account.get("email") or "").strip()
        password = (account.get("password") or "").strip()
        secret = (account.get("secret") or "").strip()

        try:
            email_input = await page.wait_for_selector('input[type="email"]', timeout=5000)
            if not email_input:
                return

            if not email or not password:
                raise RuntimeError("检测到需要登录，但账号缺少邮箱/密码（请检查 accounts.txt/备注）")

            self._log(f"🔐 检测到登录页，开始登录: {email}")
            await email_input.fill(email)
            await page.click("#identifierNext >> button")

            await page.wait_for_selector('input[type="password"]', state="visible", timeout=15000)
            await page.fill('input[type="password"]', password)
            await page.click("#passwordNext >> button")

            # TOTP 可能会出现，也可能不会出现
            try:
                totp_input = await page.wait_for_selector(
                    'input[name="totpPin"], input[id="totpPin"], input[type="tel"]',
                    timeout=10000,
                )
                if totp_input:
                    if not secret:
                        self._log("⚠️ 需要 2FA，但账号缺少密钥（secret）")
                    else:
                        totp = pyotp.TOTP(secret.replace(" ", ""))
                        code = totp.now()
                        await totp_input.fill(code)
                        await page.click("#totpNext >> button")
            except Exception:
                # Why: 有的账号没有 2FA，或者挑战页面不同
                pass

            await asyncio.sleep(3)
        except Exception as e:
            # Why: 不把登录失败当成致命错误，可能窗口已登录或挑战页面不同
            self._log(f"⚠️ 登录流程未完成/已跳过: {e}")

    async def _process_one(self, idx: int, account: dict, card: dict):
        browser_id = (account.get("browser_id") or "").strip()
        email = (account.get("email") or "").strip()

        if not browser_id:
            return

        card_masked = _mask_card_number(card.get("number", ""))
        self.progress_signal.emit(browser_id, "处理中", f"使用卡: {card_masked}")
        self._log(f"[{idx}] 开始绑卡: {email} ({browser_id}) / {card_masked}")

        opened = False
        try:
            res = openBrowser(browser_id)
            if not res or not res.get("success", False):
                raise RuntimeError(f"打开浏览器失败: {res}")
            opened = True

            ws_endpoint = res.get("data", {}).get("ws")
            if not ws_endpoint:
                raise RuntimeError("打开浏览器成功但未返回 ws 端点")

            async with async_playwright() as playwright:
                chromium = playwright.chromium
                # 使用配置化的超时时间连接 CDP
                from core.config_manager import ConfigManager
                cdp_timeout = ConfigManager.get("timeouts.page_load", 30) * 1000
                browser = await chromium.connect_over_cdp(ws_endpoint, timeout=cdp_timeout)
                default_context = browser.contexts[0]
                page = default_context.pages[0] if default_context.pages else await default_context.new_page()

                # 登录（必要时）
                await self._login_if_needed(page, account)

                # 进入 AI Student 页面（绑卡逻辑依赖此页面结构）
                target_url = "https://one.google.com/ai-student?g1_landing_page=75&utm_source=antigravity&utm_campaign=argon_limit_reached"
                try:
                    target_page = await default_context.new_page()
                except Exception:
                    target_page = page

                try:
                    await target_page.goto(target_url, timeout=60000)
                except Exception as e:
                    self._log(f"⚠️ 打开目标页失败，继续尝试在当前页执行: {e}")

                success, message = await auto_bind_card(target_page, card_info=card)

                if success:
                    # Why: 绑卡成功后将状态推进到 subscribed，统一交由 DB + 导出文件维护
                    acc_line = email
                    if account.get("password"):
                        acc_line += f"----{account.get('password')}"
                    if account.get("backup"):
                        acc_line += f"----{account.get('backup')}"
                    if account.get("secret"):
                        acc_line += f"----{account.get('secret')}"

                    try:
                        AccountManager.move_to_subscribed(acc_line)
                    except Exception as e:
                        self._log(f"⚠️ 更新 subscribed 状态失败（不影响绑卡结果）: {e}")

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
            if opened and self.close_after:
                try:
                    closeBrowser(browser_id)
                except Exception:
                    pass


class BindCardWindow(QDialog):
    """一键绑卡订阅窗口（修复 create_window_gui 中的 bind_card_gui 缺失引用）"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.worker: BindCardWorker | None = None
        self.accounts: list[dict] = []
        self.cards: list[dict] = []

        self.setWindowTitle("一键绑卡订阅")
        self.resize(1100, 700)

        self._init_ui()
        self.refresh_all()

    def _init_ui(self):
        layout = QVBoxLayout()

        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout()

        self.thread_count_spin = QSpinBox()
        self.thread_count_spin.setMinimum(1)
        self.thread_count_spin.setMaximum(20)
        self.thread_count_spin.setValue(2)
        settings_layout.addRow("并发数:", self.thread_count_spin)

        self.cards_per_account_spin = QSpinBox()
        self.cards_per_account_spin.setMinimum(1)
        self.cards_per_account_spin.setMaximum(100)
        self.cards_per_account_spin.setValue(1)
        settings_layout.addRow("一卡几绑:", self.cards_per_account_spin)

        self.close_after_checkbox = QCheckBox("完成后关闭窗口（更省资源）")
        self.close_after_checkbox.setChecked(False)
        settings_layout.addRow("", self.close_after_checkbox)

        settings_group.setLayout(settings_layout)
        layout.addWidget(settings_group)

        # 卡片信息显示区域（只读，来自配置管理）
        card_info_layout = QHBoxLayout()
        card_info_layout.addWidget(QLabel("卡片来源:"))
        self.card_source_label = QLabel("配置管理 → 卡片管理")
        self.card_source_label.setStyleSheet("color: #666; font-style: italic;")
        card_info_layout.addWidget(self.card_source_label)
        card_info_layout.addStretch()
        layout.addLayout(card_info_layout)

        info_layout = QHBoxLayout()
        self.card_count_label = QLabel("卡片: 0")
        self.account_count_label = QLabel("账号: 0")
        info_layout.addWidget(self.card_count_label)
        info_layout.addWidget(self.account_count_label)
        info_layout.addStretch()

        self.btn_refresh = QPushButton("刷新列表")
        self.btn_refresh.clicked.connect(self.refresh_all)
        info_layout.addWidget(self.btn_refresh)
        layout.addLayout(info_layout)

        select_layout = QHBoxLayout()
        self.select_all_checkbox = QCheckBox("全选/取消全选")
        self.select_all_checkbox.stateChanged.connect(self._toggle_select_all)
        select_layout.addWidget(self.select_all_checkbox)
        select_layout.addStretch()
        layout.addLayout(select_layout)

        self.table = QTableWidget()
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["选择", "邮箱", "浏览器ID", "状态", "消息"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.table)

        log_label = QLabel("运行日志:")
        layout.addWidget(log_label)

        self.log_text = QTextEdit()
        self.log_text.setReadOnly(True)
        self.log_text.setMaximumHeight(160)
        layout.addWidget(self.log_text)

        button_layout = QHBoxLayout()
        self.btn_start = QPushButton("开始绑卡订阅")
        self.btn_start.clicked.connect(self.start_processing)
        button_layout.addWidget(self.btn_start)

        self.btn_stop = QPushButton("停止")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self.stop_processing)
        button_layout.addWidget(self.btn_stop)

        layout.addLayout(button_layout)
        self.setLayout(layout)

    def log(self, message: str):
        self.log_text.append(message)
        scrollbar = self.log_text.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def refresh_all(self):
        self.load_cards()
        self.load_accounts()

    def load_cards(self):
        """从 DataStore 加载卡片"""
        self.cards = []

        try:
            data_store = get_data_store()
            data_store.reload()  # 刷新数据
            cards = data_store.get_cards_as_dicts()

            if not cards:
                self.card_count_label.setText("卡片: 0")
                self.log("⚠️ 未找到卡片数据，请在配置管理中添加卡片")
                return

            for card in cards:
                # 清理卡号：移除空格、连字符等非数字字符
                raw_number = card.get("number", "").strip()
                number = "".join(c for c in raw_number if c.isdigit())
                exp_month = card.get("exp_month", "").strip()
                exp_year = card.get("exp_year", "").strip()
                cvv = card.get("cvv", "").strip()
                name = card.get("name", "John Smith").strip()
                zip_code = card.get("zip_code", "10001").strip()

                # 基础校验（number 已清理为纯数字）
                if not number or not (13 <= len(number) <= 19):
                    self.log(f"⚠️ 跳过无效卡号: {_mask_card_number(raw_number)}")
                    continue
                if not exp_month.isdigit() or not (1 <= _safe_int(exp_month, 0) <= 12):
                    self.log(f"⚠️ 跳过无效月份: {exp_month} / {_mask_card_number(number)}")
                    continue
                if not exp_year.isdigit() or len(exp_year) not in (2, 4):
                    self.log(f"⚠️ 跳过无效年份: {exp_year} / {_mask_card_number(number)}")
                    continue
                if not cvv.isdigit() or len(cvv) not in (3, 4):
                    self.log(f"⚠️ 跳过无效CVV: *** / {_mask_card_number(number)}")
                    continue

                if len(exp_month) == 1:
                    exp_month = f"0{exp_month}"
                if len(exp_year) == 4:
                    exp_year = exp_year[-2:]

                self.cards.append({
                    "number": number,
                    "exp_month": exp_month,
                    "exp_year": exp_year,
                    "cvv": cvv,
                    "name": name,
                    "zip_code": zip_code,
                })

            self.card_count_label.setText(f"卡片: {len(self.cards)}")
            self.log(f"✅ 加载卡片: {len(self.cards)} 张（日志已脱敏）")
        except Exception as e:
            self.card_count_label.setText("卡片: 0")
            self.log(f"❌ 加载卡片失败: {e}")
            traceback.print_exc()

    def load_accounts(self):
        """加载已验证未绑卡（verified）账号，并映射到浏览器ID"""
        try:
            DBManager.init_db()
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT email, password, recovery_email, secret_key
                FROM accounts
                WHERE status = 'verified'
                ORDER BY email
                """
            )
            rows = cursor.fetchall()
            conn.close()

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
                    continue

                account = {
                    "email": email,
                    "password": row[1] or "",
                    "backup": row[2] or "",
                    "secret": row[3] or "",
                    "browser_id": browser_id,
                }
                self.accounts.append(account)

                row_idx = self.table.rowCount()
                self.table.insertRow(row_idx)

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
            self.log(f"✅ 加载 verified 账号: {len(self.accounts)} 个（仅显示有对应浏览器ID的账号）")
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

        selected_accounts = self._get_selected_accounts()
        if not selected_accounts:
            QMessageBox.warning(self, "提示", "请先勾选要处理的账号")
            return

        if not self.cards:
            QMessageBox.warning(self, "提示", "没有可用卡片，请在「配置管理 → 卡片管理」中添加")
            return

        thread_count = self.thread_count_spin.value()
        cards_per_account = self.cards_per_account_spin.value()
        close_after = self.close_after_checkbox.isChecked()

        self.log(f"\n{'=' * 50}")
        self.log("开始一键绑卡订阅")
        self.log(f"选中账号: {len(selected_accounts)}")
        self.log(f"卡片数量: {len(self.cards)}")
        self.log(f"一卡几绑: {cards_per_account}")
        self.log(f"并发数: {thread_count}")
        self.log(f"完成后关闭窗口: {'是' if close_after else '否'}")
        self.log(f"{'=' * 50}\n")

        self.worker = BindCardWorker(
            selected_accounts,
            self.cards,
            cards_per_account,
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
        self.log("\n✅ 绑卡任务结束")
        QMessageBox.information(self, "完成", "绑卡任务已结束（请在主界面或 Web Admin 查看最新状态）")

    def _update_account_status(self, browser_id: str, status: str, message: str):
        for row in range(self.table.rowCount()):
            if self.table.item(row, 2) and self.table.item(row, 2).text() == browser_id:
                self.table.setItem(row, 3, QTableWidgetItem(status))
                self.table.setItem(row, 4, QTableWidgetItem(message))
                break


def main():
    from PyQt6.QtWidgets import QApplication

    app = QApplication(sys.argv)
    window = BindCardWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
