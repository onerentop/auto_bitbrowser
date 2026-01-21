"""
一键绑卡订阅 (AI Agent 版) GUI 窗口
支持批量为 Google 账号完成 Google One AI Student 绑卡订阅

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
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QColor, QBrush

from ix_api import get_group_list
from ix_window import get_browser_list
from database import DBManager
from core.config_manager import ConfigManager
from auto_bind_card_ai import auto_bind_card_ai


class BindCardAIWorker(QThread):
    """后台工作线程"""
    progress_signal = pyqtSignal(str, str, str, str)  # browser_id, status, message, card_number
    finished_signal = pyqtSignal()
    log_signal = pyqtSignal(str)

    def __init__(
        self,
        accounts: list[dict],
        cards: list[dict],
        cards_per_account: int,
        thread_count: int,
        close_after: bool,
        ai_config: dict = None,
    ):
        super().__init__()
        self.accounts = accounts
        self.cards = cards
        self.cards_per_account = max(1, cards_per_account)
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
        if not self.cards:
            self._log("⚠️ 没有可用卡片")
            return

        self._log(f"开始处理 {len(self.accounts)} 个账号，并发数: {self.thread_count}，一卡几绑: {self.cards_per_account}")

        # 使用信号量控制并发
        semaphore = asyncio.Semaphore(self.thread_count)

        # 一卡几绑逻辑：为每个账号预先分配卡片
        card_index = 0
        card_usage_count = 0
        accounts_with_cards = []

        for account in self.accounts:
            if not self.is_running:
                break

            # 检查是否需要切换到下一张卡片
            if card_usage_count >= self.cards_per_account:
                card_index += 1
                card_usage_count = 0

            # 检查卡片是否用完
            if card_index >= len(self.cards):
                self._log("⚠️ 卡片已用完，停止分配")
                break

            card = self.cards[card_index]
            card_usage_count += 1

            # 将卡片信息附加到账号
            account_with_card = account.copy()
            account_with_card['card_info'] = card
            accounts_with_cards.append(account_with_card)

        if not accounts_with_cards:
            self._log("⚠️ 没有可处理的账号（卡片不足或无账号）")
            return

        self._log(f"实际处理 {len(accounts_with_cards)} 个账号（使用 {card_index + 1} 张卡片）")

        async def process_one(index: int, account: dict):
            async with semaphore:
                if not self.is_running:
                    return

                browser_id = account.get('browser_id', '')
                email = account.get('email', 'Unknown')
                card_info = account.get('card_info', {})
                card_number = card_info.get('number', '')
                card_masked = f"****{card_number[-4:]}" if len(card_number) >= 4 else "****"

                self._log(f"[{index + 1}] 开始绑卡: {email} ({browser_id}) 卡片: {card_masked}")
                self.progress_signal.emit(browser_id, "处理中", "正在绑卡...", card_masked)

                try:
                    account_info = {
                        'email': account.get('email', ''),
                        'password': account.get('password', ''),
                        'secret': account.get('secret', ''),
                    }

                    success, msg = await auto_bind_card_ai(
                        browser_id,
                        account_info,
                        card_info,
                        self.close_after,
                        api_key=self.ai_config.get('api_key'),
                        base_url=self.ai_config.get('base_url'),
                        model=self.ai_config.get('model', 'gemini-2.5-flash'),
                        max_steps=self.ai_config.get('max_steps', 40),
                    )

                    if success:
                        self._log(f"[{index + 1}] ✅ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "成功", msg, card_masked)
                    else:
                        self._log(f"[{index + 1}] ❌ {email}: {msg}")
                        self.progress_signal.emit(browser_id, "失败", msg, card_masked)

                except Exception as e:
                    self._log(f"[{index + 1}] ❌ {email}: {e}")
                    self.progress_signal.emit(browser_id, "错误", str(e), card_masked)

        # 并发执行
        tasks = [process_one(i, acc) for i, acc in enumerate(accounts_with_cards)]
        await asyncio.gather(*tasks)

        self._log("✅ 所有账号处理完成")


class BindCardAIDialog(QDialog):
    """绑卡订阅 AI 版主对话框"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("一键绑卡订阅 (AI Agent 版)")
        self.setMinimumSize(1000, 750)

        self.worker = None
        self.db_manager = DBManager()
        self.accounts = []
        self.cards = []

        self._init_ui()
        self._load_cards()
        self._load_accounts()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 说明区域
        info_group = QGroupBox("功能说明")
        info_layout = QVBoxLayout(info_group)
        info_label = QLabel(
            "💳 此功能用于批量完成 Google One AI Student 绑卡订阅\n"
            "• 使用 AI Agent 自动完成绑卡流程，无需维护选择器\n"
            "• 自动填写卡片信息并完成订阅\n"
            "• 支持多并发处理提高效率"
        )
        info_label.setStyleSheet("color: #333; padding: 5px;")
        info_layout.addWidget(info_label)
        layout.addWidget(info_group)

        # 设置区域
        settings_group = QGroupBox("设置")
        settings_layout = QFormLayout(settings_group)

        # 一卡几绑
        self.cards_per_account_spin = QSpinBox()
        self.cards_per_account_spin.setRange(1, 100)
        self.cards_per_account_spin.setValue(1)
        self.cards_per_account_spin.setToolTip("每张卡片可绑定的账号数量")
        settings_layout.addRow("一卡几绑:", self.cards_per_account_spin)

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

        # 卡片信息
        card_group = QGroupBox("卡片信息")
        card_layout = QVBoxLayout(card_group)
        self.card_info_label = QLabel("正在加载卡片...")
        self.card_info_label.setStyleSheet("color: #333;")
        card_layout.addWidget(self.card_info_label)
        layout.addWidget(card_group)

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

        toolbar.addStretch()

        self.selected_label = QLabel("已选择: 0 个账号")
        toolbar.addWidget(self.selected_label)

        list_layout.addLayout(toolbar)

        # 树形控件（按分组显示）
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "邮箱", "窗口ID", "状态", "卡片"])
        self.tree.setColumnWidth(0, 60)
        self.tree.setColumnWidth(1, 280)
        self.tree.setColumnWidth(2, 120)
        self.tree.setColumnWidth(3, 80)
        self.tree.header().setStretchLastSection(True)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setRootIsDecorated(True)
        self.tree.setIndentation(15)
        self.tree.itemChanged.connect(lambda: self._update_selection_count())
        list_layout.addWidget(self.tree)

        layout.addWidget(list_group)

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

    def _load_cards(self):
        """加载卡片数据"""
        self.cards = self.db_manager.get_all_cards()
        if self.cards:
            card_count = len(self.cards)
            first_card = self.cards[0]
            card_preview = f"****{first_card.get('number', '')[-4:]}" if first_card.get('number') else "****"
            self.card_info_label.setText(f"已加载 {card_count} 张卡片，首张: {card_preview}")
            self.card_info_label.setStyleSheet("color: #4CAF50;")
        else:
            self.card_info_label.setText("⚠️ 未找到卡片数据，请在「配置管理 → 卡片管理」中添加")
            self.card_info_label.setStyleSheet("color: #f44336;")

    def _load_accounts(self):
        """从浏览器列表加载账号（按分组显示）"""
        self.tree.clear()
        self.accounts = []

        try:
            # 获取数据库账号（用于获取密码等信息）
            db_accounts = self.db_manager.get_all_accounts()
            account_map = {acc['email']: acc for acc in db_accounts}

            # 获取分组列表
            all_groups = get_group_list() or []
            group_names = {}
            for g in all_groups:
                gid = g.get('id')
                title = g.get('title', '')
                # 清理不可显示字符
                clean_title = ''.join(c for c in str(title) if c.isprintable())
                if not clean_title or '\ufffd' in clean_title:
                    clean_title = f"分组 {gid}"
                group_names[gid] = clean_title
            group_names[0] = "未分组"
            group_names[1] = "默认分组"

            # 获取浏览器列表
            browsers = get_browser_list(page=1, limit=1000) or []

            # 按分组组织浏览器
            grouped = {gid: [] for gid in group_names.keys()}
            for browser in browsers:
                gid = browser.get('group_id', 0) or 0
                if gid not in grouped:
                    grouped[gid] = []
                    gname = browser.get('group_name', '') or ''
                    clean_gname = ''.join(c for c in str(gname) if c.isprintable())
                    if not clean_gname or '\ufffd' in clean_gname:
                        clean_gname = f"分组 {gid}"
                    group_names[gid] = clean_gname

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
                account = account_map.get(email, {})

                # 只处理 verified 状态的账号（已验证未绑卡）
                status = account.get('status', '')
                if status != 'verified':
                    continue

                account_data = {
                    'browser_id': str(browser_id),
                    'email': email,
                    'password': account.get('password', ''),
                    'secret': account.get('secret', '') or account.get('secret_key', ''),
                }
                grouped[gid].append(account_data)

            # 创建树形结构
            total_count = 0

            for gid in sorted(grouped.keys()):
                account_list = grouped[gid]
                if not account_list:
                    continue  # 跳过空分组

                group_name = group_names.get(gid, f"分组 {gid}")

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
                    child.setCheckState(0, Qt.CheckState.Checked)
                    child.setText(1, email)
                    child.setText(2, browser_id)
                    child.setText(3, "待处理")
                    child.setText(4, "-")  # 卡片将在执行时动态分配
                    child.setData(0, Qt.ItemDataRole.UserRole, {
                        "type": "browser",
                        "data": account_data
                    })

                    self.accounts.append(account_data)
                    total_count += 1

            self._log(f"加载完成：{total_count} 个 verified 账号，{len(self.cards)} 张卡片")
            self._update_selection_count()

        except Exception as e:
            self._log(f"❌ 加载账号失败: {e}")
            traceback.print_exc()

    def _refresh_all(self):
        """刷新所有数据"""
        self._load_cards()
        self._load_accounts()

    def _select_all(self):
        """全选"""
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                child.setCheckState(0, Qt.CheckState.Checked)
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
            'max_steps': ConfigManager.get_ai_max_steps(),
        }

    def _start_process(self):
        """开始处理"""
        selected = self._get_selected_accounts()
        if not selected:
            QMessageBox.warning(self, "提示", "请先选择要处理的账号")
            return

        if not self.cards:
            QMessageBox.warning(self, "提示", "未找到卡片数据，请先在「配置管理 → 卡片管理」中添加卡片")
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

        # 检查卡片是否足够
        cards_per_account = self.cards_per_account_spin.value()
        needed_cards = (len(selected) + cards_per_account - 1) // cards_per_account
        if needed_cards > len(self.cards):
            reply = QMessageBox.question(
                self,
                "卡片不足",
                f"需要至少 {needed_cards} 张卡片，但只有 {len(self.cards)} 张。\n"
                f"部分账号将无法绑卡。是否继续？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
            )
            if reply != QMessageBox.StandardButton.Yes:
                return

        reply = QMessageBox.question(
            self,
            "确认执行",
            f"确定要对 {len(selected)} 个账号执行 AI 绑卡订阅吗？\n\n"
            f"一卡几绑: {cards_per_account}\n"
            f"并发数: {self.thread_spin.value()}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        # 禁用控件
        self.start_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.refresh_btn.setEnabled(False)

        # 创建工作线程
        self.worker = BindCardAIWorker(
            accounts=selected,
            cards=self.cards,
            cards_per_account=cards_per_account,
            thread_count=self.thread_spin.value(),
            close_after=self.close_after_check.isChecked(),
            ai_config=ai_config,
        )
        self.worker.log_signal.connect(self._log)
        self.worker.progress_signal.connect(self._on_progress)
        self.worker.finished_signal.connect(self._on_finished)
        self.worker.start()

    def _stop_process(self):
        """停止处理"""
        if self.worker:
            self.worker.stop()
            self._log("正在停止任务...")
            self.stop_btn.setEnabled(False)

    def _on_progress(self, browser_id: str, status: str, message: str, card_number: str):
        """进度更新"""
        # 更新列表项状态
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.text(2) == browser_id:
                    child.setText(3, status)
                    # 更新卡片列显示分配的卡号
                    if card_number:
                        child.setText(4, card_number)

                    if status == "成功":
                        child.setBackground(3, QColor("#4CAF50"))
                        child.setForeground(3, QColor("#ffffff"))
                        # 更新账号状态为 subscribed
                        email = child.text(1)
                        DBManager.update_status(email, "subscribed", "绑卡成功")
                        # 记录绑卡历史（供综合查询使用）
                        if card_number:
                            DBManager.add_bind_card_history(email, card_number[-4:] if len(card_number) >= 4 else card_number)
                        # 设置置灰样式（跳过状态列，保留绿色背景的可读性）
                        gray_color = QColor(150, 150, 150)
                        gray_brush = QBrush(gray_color)
                        for col in [0, 1, 2, 4]:  # 跳过状态列(3)
                            child.setForeground(col, gray_brush)

                    elif status == "失败" or status == "错误":
                        child.setBackground(3, QColor("#f44336"))
                        child.setForeground(3, QColor("#ffffff"))

                    elif status == "处理中":
                        child.setText(3, "处理中...")
                        child.setBackground(3, QColor("#FF9800"))
                        child.setForeground(3, QColor("#ffffff"))
                    return

    def _on_finished(self):
        """处理完成"""
        self.start_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.refresh_btn.setEnabled(True)

        self._log("=" * 50)
        self._log("任务执行完成！")

        QMessageBox.information(self, "完成", "AI 绑卡订阅任务已完成")
        self.worker = None

    def closeEvent(self, event):
        """关闭窗口时停止工作线程"""
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
    dialog = BindCardAIDialog()
    dialog.show()
    sys.exit(app.exec())
