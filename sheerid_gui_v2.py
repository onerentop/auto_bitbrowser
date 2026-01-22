"""
SheerID 批量验证工具 V2 (数据库版)

数据来源：从数据库读取 link_ready 状态的账号
支持状态筛选、Link 显示、统计面板
"""
import sys
import re
import asyncio
from PyQt6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QPushButton,
    QLabel,
    QLineEdit,
    QTableWidget,
    QTableWidgetItem,
    QHeaderView,
    QMessageBox,
    QAbstractItemView,
    QCheckBox,
    QGroupBox,
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QColor

from sheerid_verifier import SheerIDVerifier
from database import DBManager
from core.config_manager import ConfigManager
from ix_window import find_browser_by_email
from auto_get_sheerlink_ai import auto_get_sheerlink_ai


class VerifyWorkerV2(QThread):
    """验证工作线程 - 数据库版（支持失败重试）"""

    progress_signal = pyqtSignal(dict)  # {email, vid, status, msg}
    finished_signal = pyqtSignal()

    def __init__(self, api_key: str, accounts: list):
        """
        Args:
            api_key: SheerID API Key
            accounts: 账号列表 [{'email': str, 'vid': str, 'link': str, ...}, ...]
        """
        super().__init__()
        self.api_key = api_key
        self.accounts = accounts
        self.is_running = True
        # 从配置加载 AI 相关设置
        self._load_ai_config()

    def _load_ai_config(self):
        """加载 AI 配置"""
        try:
            ConfigManager.load()
            # 使用 ConfigManager 的专用方法获取 AI 配置
            self.gemini_api_key = ConfigManager.get_ai_api_key()
            self.gemini_base_url = ConfigManager.get_ai_base_url()
            self.gemini_model = ConfigManager.get_ai_model()
        except Exception as e:
            print(f"[VerifyWorkerV2] 加载 AI 配置失败: {e}")
            self.gemini_api_key = ""
            self.gemini_base_url = ""
            self.gemini_model = "gemini-2.5-flash"

    def run(self):
        verifier = SheerIDVerifier(api_key=self.api_key)

        # 提取所有 VID
        tasks = [item["vid"] for item in self.accounts]

        # 按批次处理（每批 5 个）
        batches = [tasks[i : i + 5] for i in range(0, len(tasks), 5)]

        def callback(vid, msg):
            if not self.is_running:
                return
            # 查找对应的邮箱
            email = self._get_email_by_vid(vid)
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": "Running", "msg": msg}
            )

        for batch in batches:
            if not self.is_running:
                break

            # 更新状态为处理中
            for vid in batch:
                email = self._get_email_by_vid(vid)
                self.progress_signal.emit(
                    {"email": email, "vid": vid, "status": "Processing", "msg": "提交中..."}
                )

            # 调用验证 API
            results = verifier.verify_batch(batch, callback=callback)

            # 处理结果
            for vid, res in results.items():
                email = self._get_email_by_vid(vid)
                status = res.get("currentStep") or res.get("status")
                msg = res.get("message", "")

                if status == "success":
                    # 验证成功 - 更新数据库状态为 verified
                    self._handle_success(email, vid, msg)
                else:
                    # 验证失败 - 尝试重新获取链接并重试
                    self._handle_failure_with_retry(email, vid, status, msg, verifier, callback)

        self.finished_signal.emit()

    def _handle_success(self, email: str, vid: str, msg: str):
        """处理验证成功"""
        try:
            DBManager.upsert_account(
                email=email,
                status="verified",
                message="SheerID 验证成功",
            )
            # 记录到 SheerID 验证历史表
            DBManager.add_sheerid_verification(
                email=email,
                verification_id=vid,
                verification_result="success",
                message="验证成功"
            )
            msg = "验证成功，已更新状态"
        except Exception as e:
            msg += f" (数据库更新失败: {e})"

        self.progress_signal.emit(
            {"email": email, "vid": vid, "status": "success", "msg": msg}
        )

    def _handle_failure_with_retry(self, email: str, vid: str, status: str, msg: str,
                                   verifier: SheerIDVerifier, callback):
        """处理验证失败，尝试重新获取链接并重试"""
        # 检查是否已停止
        if not self.is_running:
            return

        # 记录首次失败到历史表
        try:
            DBManager.add_sheerid_verification(
                email=email,
                verification_id=vid,
                verification_result=status or "error",
                message=f"首次验证失败: {msg}"
            )
        except Exception as e:
            print(f"[SheerID] 记录验证历史失败: {e}")

        # 通知正在重新获取链接
        self.progress_signal.emit(
            {"email": email, "vid": vid, "status": "Retrying", "msg": "验证失败，正在重新获取链接..."}
        )

        # 检查是否已停止
        if not self.is_running:
            return

        # 尝试重新获取链接
        account_info = self._get_account_info_by_email(email)
        if not account_info:
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": status, "msg": f"{msg} (无法获取账号信息，跳过重试)"}
            )
            return

        # 查找对应的浏览器窗口
        profile_id = find_browser_by_email(email)
        if not profile_id:
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": status, "msg": f"{msg} (未找到对应窗口，跳过重试)"}
            )
            return

        # 检查是否已停止
        if not self.is_running:
            return

        # 重新获取链接（异步调用）
        new_link, new_vid = self._run_async_get_new_link(profile_id, account_info)

        # 处理特殊状态返回
        if new_link == "VERIFIED":
            # 重新检测发现账号已验证
            self._handle_success(email, vid, "重新检测发现账号已验证")
            return
        elif new_link == "SUBSCRIBED":
            # 账号已订阅
            try:
                DBManager.upsert_account(email=email, status="subscribed", message="账号已订阅")
            except Exception as e:
                print(f"[SheerID] 更新订阅状态失败: {e}")
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": "success", "msg": "账号已订阅"}
            )
            return
        elif new_link == "INELIGIBLE":
            # 账号无资格
            try:
                DBManager.upsert_account(email=email, status="ineligible", message="账号无资格")
            except Exception as e:
                print(f"[SheerID] 更新无资格状态失败: {e}")
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": "ineligible", "msg": "账号无资格"}
            )
            return

        if not new_link or not new_vid:
            self.progress_signal.emit(
                {"email": email, "vid": vid, "status": status, "msg": f"{msg} (重新获取链接失败)"}
            )
            return

        # 检查是否已停止
        if not self.is_running:
            return

        # 更新内存中的账号数据
        self._update_account_link(email, new_link, new_vid)

        # 通知正在使用新链接重试
        self.progress_signal.emit(
            {"email": email, "vid": new_vid, "status": "Retrying", "msg": f"已获取新链接，正在重试验证..."}
        )

        # 使用新 VID 重新验证
        retry_results = verifier.verify_batch([new_vid], callback=callback)

        # 处理重试结果
        for retry_vid, retry_res in retry_results.items():
            retry_status = retry_res.get("currentStep") or retry_res.get("status")
            retry_msg = retry_res.get("message", "")

            if retry_status == "success":
                self._handle_success(email, retry_vid, retry_msg)
            else:
                # 重试也失败，记录最终结果
                try:
                    DBManager.add_sheerid_verification(
                        email=email,
                        verification_id=retry_vid,
                        verification_result=retry_status or "error",
                        message=f"重试验证失败: {retry_msg}"
                    )
                except Exception as e:
                    print(f"[SheerID] 记录验证历史失败: {e}")

                self.progress_signal.emit(
                    {"email": email, "vid": retry_vid, "status": retry_status, "msg": f"重试失败: {retry_msg}"}
                )

    def _run_async_get_new_link(self, profile_id: int, account_info: dict):
        """
        运行异步获取链接函数

        Returns:
            (link, vid) - 成功获取链接时返回链接和VID
            (None, None) - 获取失败
            ("VERIFIED", None) - 账号已验证
            ("SUBSCRIBED", None) - 账号已订阅
            ("INELIGIBLE", None) - 账号无资格
        """
        try:
            # 在新的事件循环中运行异步函数
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                success, msg, status, link = loop.run_until_complete(
                    auto_get_sheerlink_ai(
                        browser_id=str(profile_id),
                        account_info=account_info,
                        close_after=True,
                        max_steps=20,
                        api_key=self.gemini_api_key or None,
                        base_url=self.gemini_base_url or None,
                        model=self.gemini_model,
                        save_to_file=True,  # 更新数据库
                    )
                )
            finally:
                loop.close()

            if success:
                if link:
                    # 成功获取链接
                    new_vid = self._extract_vid(link)
                    return link, new_vid
                else:
                    # 没有链接但成功了，说明是特殊状态
                    if status == "verified":
                        return "VERIFIED", None
                    elif status == "subscribed":
                        return "SUBSCRIBED", None
                    elif status == "ineligible":
                        return "INELIGIBLE", None

            print(f"[SheerID] 重新获取链接失败: {msg}")
            return None, None

        except Exception as e:
            print(f"[SheerID] 重新获取链接异常: {e}")
            import traceback
            traceback.print_exc()
            return None, None

    def _extract_vid(self, link: str) -> str:
        """从链接中提取 Verification ID"""
        if not link:
            return None
        m = re.search(r"verificationId=([a-zA-Z0-9]+)", link)
        if m:
            return m.group(1)
        m = re.search(r"verify/([a-zA-Z0-9]+)", link)
        if m:
            return m.group(1)
        return None

    def _get_email_by_vid(self, vid: str) -> str:
        """根据 VID 查找邮箱"""
        for item in self.accounts:
            if item["vid"] == vid:
                return item["email"]
        return "Unknown"

    def _get_account_info_by_email(self, email: str) -> dict:
        """根据邮箱获取完整账号信息（用于重新获取链接）"""
        try:
            # 从数据库获取完整信息
            accounts = DBManager.get_all_accounts()
            for acc in accounts:
                if acc.get("email") == email:
                    return {
                        "email": acc.get("email", ""),
                        "password": acc.get("password", ""),
                        "secret": acc.get("secret_key", ""),
                    }
        except Exception as e:
            print(f"[SheerID] 获取账号信息失败: {e}")
        return None

    def _update_account_link(self, email: str, new_link: str, new_vid: str):
        """更新内存中的账号链接信息"""
        for item in self.accounts:
            if item["email"] == email:
                item["link"] = new_link
                item["vid"] = new_vid
                break

    def stop(self):
        self.is_running = False


class SheerIDWindowV2(QDialog):
    """SheerID 批量验证窗口 V2 - 数据库版"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("SheerID 批量验证工具 (数据库版)")
        self.setMinimumSize(1200, 700)

        self.verifier = SheerIDVerifier()
        self.worker = None
        self.accounts = []  # 当前加载的账号列表
        self.email_row_map = {}  # email -> row_index

        self._init_ui()
        self._load_api_key()
        self._load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 1. 说明区域
        info_group = QGroupBox("功能说明")
        info_layout = QVBoxLayout(info_group)
        info_label = QLabel(
            "🔍 此功能用于批量验证 SheerID 链接\n"
            "• 数据来源：从数据库读取 link_ready 状态的账号\n"
            "• 验证成功后自动更新状态为 verified\n"
            "• 验证失败保持原状态，可重试"
        )
        info_label.setStyleSheet("color: #333; padding: 5px;")
        info_layout.addWidget(info_label)
        layout.addWidget(info_group)

        # 2. API Key 区域
        api_layout = QHBoxLayout()
        api_layout.addWidget(QLabel("API Key:"))
        self.api_key_display = QLineEdit()
        self.api_key_display.setFixedWidth(300)
        self.api_key_display.setReadOnly(True)
        self.api_key_display.setStyleSheet("background-color: #f0f0f0; color: #666;")
        self.api_key_display.setPlaceholderText("请在配置管理中设置 SheerID API Key")
        api_layout.addWidget(self.api_key_display)
        api_layout.addStretch()
        layout.addLayout(api_layout)

        # 3. 状态过滤器
        filter_group = QGroupBox("状态过滤器")
        filter_layout = QHBoxLayout(filter_group)

        self.filter_link_ready = QCheckBox("link_ready (待验证)")
        self.filter_link_ready.setChecked(True)  # 默认选中
        self.filter_link_ready.stateChanged.connect(self._load_data)
        filter_layout.addWidget(self.filter_link_ready)

        self.filter_verified = QCheckBox("verified (已验证)")
        self.filter_verified.setChecked(False)
        self.filter_verified.stateChanged.connect(self._load_data)
        filter_layout.addWidget(self.filter_verified)

        self.filter_error = QCheckBox("error (错误)")
        self.filter_error.setChecked(False)
        self.filter_error.stateChanged.connect(self._load_data)
        filter_layout.addWidget(self.filter_error)

        filter_layout.addStretch()
        layout.addWidget(filter_group)

        # 4. 工具栏
        toolbar = QHBoxLayout()

        self.btn_refresh = QPushButton("刷新列表")
        self.btn_refresh.clicked.connect(self._load_data)
        toolbar.addWidget(self.btn_refresh)

        self.cb_select_all = QCheckBox("全选")
        self.cb_select_all.stateChanged.connect(self._toggle_select_all)
        toolbar.addWidget(self.cb_select_all)

        self.btn_start = QPushButton("验证选中项")
        self.btn_start.clicked.connect(self._start_verify)
        self.btn_start.setStyleSheet(
            "background-color: #4CAF50; color: white; font-weight: bold; padding: 8px 16px;"
        )
        toolbar.addWidget(self.btn_start)

        self.btn_cancel = QPushButton("取消选中项")
        self.btn_cancel.clicked.connect(self._cancel_selected)
        self.btn_cancel.setStyleSheet(
            "background-color: #f44336; color: white; padding: 8px 16px;"
        )
        toolbar.addWidget(self.btn_cancel)

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        layout.addLayout(toolbar)

        # 5. 表格
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(
            ["选择", "邮箱", "Verification ID", "Link", "状态", "详情", "AI步数"]
        )
        self.table.setColumnWidth(0, 50)
        self.table.setColumnWidth(1, 220)
        self.table.setColumnWidth(2, 180)
        self.table.setColumnWidth(4, 100)
        self.table.setColumnWidth(6, 60)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.itemChanged.connect(self._update_selection_count)
        layout.addWidget(self.table)

        # 6. 统计面板
        stats_group = QGroupBox("统计")
        stats_layout = QHBoxLayout(stats_group)
        self.stats_label = QLabel("加载中...")
        self.stats_label.setStyleSheet("font-size: 12px;")
        stats_layout.addWidget(self.stats_label)
        layout.addWidget(stats_group)

    def _load_api_key(self):
        """从配置管理加载 API Key"""
        try:
            ConfigManager.load()
            api_key = ConfigManager.get("sheerid_api_key", "")
            if api_key:
                # 显示脱敏的 API Key
                if len(api_key) > 8:
                    masked = api_key[:4] + "*" * (len(api_key) - 8) + api_key[-4:]
                else:
                    masked = "*" * len(api_key)
                self.api_key_display.setText(masked)
                self._api_key = api_key
            else:
                self.api_key_display.setText("")
                self._api_key = ""
        except Exception as e:
            print(f"加载 API Key 失败: {e}")
            self._api_key = ""

    def _get_selected_status_filters(self) -> set:
        """获取选中的状态过滤器"""
        filters = set()
        if self.filter_link_ready.isChecked():
            filters.add("link_ready")
        if self.filter_verified.isChecked():
            filters.add("verified")
        if self.filter_error.isChecked():
            filters.add("error")
        # 默认至少显示 link_ready
        if not filters:
            filters.add("link_ready")
        return filters

    def _load_data(self):
        """从数据库加载账号数据"""
        self.table.blockSignals(True)  # 暂停信号，避免触发 itemChanged
        self.table.setRowCount(0)
        self.accounts = []
        self.email_row_map = {}
        self.cb_select_all.setChecked(False)

        # 获取状态过滤器
        status_filters = self._get_selected_status_filters()

        # 统计计数（只统计有链接的账号）
        stats = {"link_ready": 0, "verified": 0, "error": 0, "other": 0, "total_with_link": 0}

        try:
            # 从数据库获取所有账号
            all_accounts = DBManager.get_all_accounts()

            row = 0
            for acc in all_accounts:
                email = acc.get("email", "")
                status = acc.get("status", "")
                link = acc.get("verification_link", "")
                sheerid_steps = acc.get("sheerid_steps", 0)

                # 只统计有链接的账号
                if not link:
                    continue

                # 统计
                stats["total_with_link"] += 1
                if status in ("link_ready", "verified", "error"):
                    stats[status] += 1
                else:
                    stats["other"] += 1

                # 根据状态过滤
                if status not in status_filters:
                    continue

                # 提取 VID
                vid = self._extract_vid(link)
                if not vid:
                    continue

                self.table.insertRow(row)

                # 选择框
                chk_item = QTableWidgetItem()
                chk_item.setFlags(Qt.ItemFlag.ItemIsUserCheckable | Qt.ItemFlag.ItemIsEnabled)
                chk_item.setCheckState(Qt.CheckState.Checked)  # 默认选中
                self.table.setItem(row, 0, chk_item)

                # 邮箱
                self.table.setItem(row, 1, QTableWidgetItem(email))

                # VID
                self.table.setItem(row, 2, QTableWidgetItem(vid))

                # Link（截断显示）
                link_display = link[:60] + "..." if len(link) > 60 else link
                link_item = QTableWidgetItem(link_display)
                link_item.setToolTip(link)  # 完整链接作为提示
                self.table.setItem(row, 3, link_item)

                # 状态
                status_display = {
                    "link_ready": "待验证",
                    "verified": "已验证",
                    "error": "错误",
                }.get(status, status)
                status_item = QTableWidgetItem(status_display)

                # 状态颜色
                if status == "verified":
                    status_item.setBackground(QColor("#4CAF50"))
                    status_item.setForeground(QColor("#ffffff"))
                elif status == "link_ready":
                    status_item.setBackground(QColor("#FF9800"))
                    status_item.setForeground(QColor("#ffffff"))
                elif status == "error":
                    status_item.setBackground(QColor("#f44336"))
                    status_item.setForeground(QColor("#ffffff"))

                self.table.setItem(row, 4, status_item)

                # 详情
                self.table.setItem(row, 5, QTableWidgetItem(acc.get("message", "")))

                # AI 步数
                self.table.setItem(row, 6, QTableWidgetItem(str(sheerid_steps or 0)))

                # 保存账号数据
                account_data = {
                    "email": email,
                    "vid": vid,
                    "link": link,
                    "status": status,
                }
                self.accounts.append(account_data)
                self.email_row_map[email] = row

                row += 1

            # 更新统计
            filter_str = ", ".join(status_filters)
            self.stats_label.setText(
                f"📊 有链接账号: {stats['total_with_link']} | "
                f"🔗 待验证: {stats['link_ready']} | "
                f"✅ 已验证: {stats['verified']} | "
                f"❌ 错误: {stats['error']} | "
                f"当前显示: {row} 条 (过滤器: {filter_str})"
            )

        except Exception as e:
            print(f"加载数据失败: {e}")
            import traceback
            traceback.print_exc()
            self.stats_label.setText(f"❌ 加载失败: {e}")

        finally:
            self.table.blockSignals(False)
            self._update_selection_count()

    def _extract_vid(self, link: str) -> str:
        """从链接中提取 Verification ID"""
        if not link:
            return None
        m = re.search(r"verificationId=([a-zA-Z0-9]+)", link)
        if m:
            return m.group(1)
        m = re.search(r"verify/([a-zA-Z0-9]+)", link)
        if m:
            return m.group(1)
        return None

    def _toggle_select_all(self, state):
        """全选/取消全选"""
        self.table.blockSignals(True)
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if state == Qt.CheckState.Checked.value:
                item.setCheckState(Qt.CheckState.Checked)
            else:
                item.setCheckState(Qt.CheckState.Unchecked)
        self.table.blockSignals(False)
        self._update_selection_count()

    def _update_selection_count(self):
        """更新选中数量"""
        count = 0
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item and item.checkState() == Qt.CheckState.Checked:
                count += 1
        self.selected_label.setText(f"已选择: {count} 个账号")

    def _get_selected_accounts(self) -> list:
        """获取选中的账号"""
        selected = []
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item and item.checkState() == Qt.CheckState.Checked:
                email = self.table.item(row, 1).text()
                # 从 accounts 列表中找到完整数据
                for acc in self.accounts:
                    if acc["email"] == email:
                        selected.append(acc)
                        break
        return selected

    def _start_verify(self):
        """开始验证"""
        if self.worker and self.worker.isRunning():
            QMessageBox.warning(self, "提示", "任务正在运行中")
            return

        # 检查 API Key
        api_key = getattr(self, "_api_key", "")
        if not api_key:
            QMessageBox.warning(
                self, "错误", "请先在「配置管理 → 全局设置」中设置 SheerID API Key"
            )
            return

        # 获取选中的账号
        selected = self._get_selected_accounts()
        if not selected:
            QMessageBox.information(self, "提示", "请先勾选需要验证的账号")
            return

        # 确认
        reply = QMessageBox.question(
            self,
            "确认执行",
            f"确定要验证 {len(selected)} 个账号吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 更新表格状态为待处理
        for acc in selected:
            row = self.email_row_map.get(acc["email"])
            if row is not None:
                pending_item = QTableWidgetItem("Pending")
                pending_item.setBackground(QColor("#607D8B"))
                pending_item.setForeground(QColor("#ffffff"))
                self.table.setItem(row, 4, pending_item)
                self.table.setItem(row, 5, QTableWidgetItem("等待中..."))

        # 启动工作线程
        self.worker = VerifyWorkerV2(api_key, selected)
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.start()

        self.btn_start.setEnabled(False)
        self.btn_start.setText("验证中...")

    def _on_progress(self, data: dict):
        """进度更新"""
        email = data.get("email", "")
        status = data.get("status", "")
        msg = data.get("msg", "")
        vid = data.get("vid", "")

        row = self.email_row_map.get(email)
        if row is None:
            return

        # 如果 VID 变化了（重试时获取了新链接），更新表格中的 VID 列
        current_vid_item = self.table.item(row, 2)
        if vid and current_vid_item and current_vid_item.text() != vid:
            self.table.setItem(row, 2, QTableWidgetItem(vid))

        # 更新状态
        status_display = {
            "success": "验证成功",
            "error": "失败",
            "Processing": "处理中",
            "Running": "运行中",
            "Retrying": "重试中",
            "ineligible": "无资格",
        }.get(status, status)

        status_item = QTableWidgetItem(status_display)

        # 状态颜色
        if status == "success":
            status_item.setBackground(QColor("#4CAF50"))
            status_item.setForeground(QColor("#ffffff"))
        elif status == "error" or "failed" in str(status).lower():
            status_item.setBackground(QColor("#f44336"))
            status_item.setForeground(QColor("#ffffff"))
        elif status in ("Processing", "Running"):
            status_item.setBackground(QColor("#FF9800"))
            status_item.setForeground(QColor("#ffffff"))
        elif status == "Retrying":
            status_item.setBackground(QColor("#2196F3"))  # 蓝色表示重试中
            status_item.setForeground(QColor("#ffffff"))
        elif status == "Pending":
            status_item.setBackground(QColor("#607D8B"))
            status_item.setForeground(QColor("#ffffff"))
        elif status == "ineligible":
            status_item.setBackground(QColor("#9C27B0"))  # 紫色表示无资格
            status_item.setForeground(QColor("#ffffff"))

        self.table.setItem(row, 4, status_item)
        self.table.setItem(row, 5, QTableWidgetItem(msg))

    def _on_finished(self):
        """验证完成"""
        self.btn_start.setEnabled(True)
        self.btn_start.setText("验证选中项")

        # 统计本次验证结果
        success_count = 0
        fail_count = 0
        pending_count = 0
        for row in range(self.table.rowCount()):
            status_item = self.table.item(row, 4)
            if status_item:
                status_text = status_item.text()
                if status_text == "验证成功":
                    success_count += 1
                elif status_text in ("失败", "无资格") or "失败" in status_text or "error" in status_text.lower():
                    fail_count += 1
                elif status_text in ("待验证", "已验证", "错误", "Pending"):
                    # 初始状态，未被处理
                    pending_count += 1
                # 其他状态（如 "处理中"、"运行中"、"重试中"）表示任务被中途停止

        # 计算被中断的数量
        total_rows = self.table.rowCount()
        interrupted_count = total_rows - success_count - fail_count - pending_count

        # 显示结果统计，不自动刷新列表
        msg = f"验证任务已结束\n\n成功: {success_count} 个\n失败: {fail_count} 个"
        if interrupted_count > 0:
            msg += f"\n中断: {interrupted_count} 个"
        if fail_count > 0 or interrupted_count > 0:
            msg += "\n\n💡 提示: 结果已保留在列表中，可查看详情后手动刷新"

        QMessageBox.information(self, "完成", msg)
        # 注意：不再自动刷新数据，保留验证结果供用户查看
        # 用户可以手动点击"刷新"按钮更新列表

    def _cancel_selected(self):
        """取消选中的验证"""
        selected = self._get_selected_accounts()
        if not selected:
            QMessageBox.warning(self, "提示", "请勾选要取消的账号")
            return

        reply = QMessageBox.question(
            self,
            "确认",
            f"确定取消 {len(selected)} 个任务吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )

        if reply == QMessageBox.StandardButton.Yes:
            for acc in selected:
                vid = acc.get("vid", "")
                email = acc.get("email", "")
                row = self.email_row_map.get(email)

                if row is not None:
                    self.table.setItem(row, 5, QTableWidgetItem("取消中..."))

                res = self.verifier.cancel_verification(vid)
                msg = res.get("message", "已取消")

                if row is not None:
                    cancelled_item = QTableWidgetItem("Cancelled")
                    cancelled_item.setBackground(QColor("#9E9E9E"))
                    cancelled_item.setForeground(QColor("#ffffff"))
                    self.table.setItem(row, 4, cancelled_item)
                    self.table.setItem(row, 5, QTableWidgetItem(msg))

    def closeEvent(self, event):
        """关闭窗口"""
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(3000)
        event.accept()


# 独立运行入口
if __name__ == "__main__":
    from PyQt6.QtWidgets import QApplication

    # 初始化数据库
    DBManager.init_db()

    app = QApplication(sys.argv)
    win = SheerIDWindowV2()
    win.show()
    sys.exit(app.exec())
