"""
配置管理 UI 模块
提供账号、卡片、代理、全局设置的可视化管理界面
"""
import sys
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget,
    QPushButton, QLabel, QLineEdit, QTableWidget, QTableWidgetItem,
    QHeaderView, QMessageBox, QFormLayout, QGroupBox, QSpinBox,
    QComboBox, QTextEdit, QDialog, QDialogButtonBox, QScrollArea,
    QCheckBox, QFileDialog
)
from PyQt6.QtCore import Qt, pyqtSignal, QThread
from PyQt6.QtGui import QFont, QBrush, QColor

from services.ix_api import closeBrowser, deleteBrowser
from services.ix_window import find_browser_by_email

from services.database import DBManager
from services.data_store import DataStore, CardInfo, ProxyInfo, get_data_store
from core.config_manager import ConfigManager

# 尝试导入 AI Agent 模块
try:
    from core.ai_browser_agent import VisionAnalyzer, create_llm, get_available_providers, LLM_ABSTRACTION_AVAILABLE
    AI_AGENT_AVAILABLE = True
except ImportError:
    AI_AGENT_AVAILABLE = False
    VisionAnalyzer = None
    create_llm = None
    get_available_providers = None
    LLM_ABSTRACTION_AVAILABLE = False


class TestAIConnectionWorker(QThread):
    """测试 AI 连接的后台线程（支持多提供商）"""
    finished_signal = pyqtSignal(bool, str, dict)  # success, message, details

    def __init__(
        self,
        api_key: str,
        base_url: str,
        model: str,
        provider: str = "gemini",
    ):
        super().__init__()
        self.api_key = api_key
        self.base_url = base_url
        self.model = model
        self.provider = provider

    def run(self):
        try:
            if not AI_AGENT_AVAILABLE:
                self.finished_signal.emit(False, "AI Agent 模块不可用", {})
                return

            if not self.api_key:
                self.finished_signal.emit(False, "请输入 API Key", {})
                return

            # 优先使用 LLM 抽象层
            if LLM_ABSTRACTION_AVAILABLE and create_llm:
                try:
                    llm = create_llm(
                        provider=self.provider,
                        api_key=self.api_key,
                        base_url=self.base_url or None,
                        model=self.model or None,
                    )
                    success, message, details = llm.test_connection()
                    self.finished_signal.emit(success, message, details)
                    return
                except Exception as e:
                    # 回退到 VisionAnalyzer
                    pass

            # 回退: 使用 VisionAnalyzer
            if VisionAnalyzer:
                analyzer = VisionAnalyzer(
                    api_key=self.api_key,
                    base_url=self.base_url or None,
                    model=self.model,
                    provider=self.provider,
                )
                success, message, details = analyzer.test_connection()
                self.finished_signal.emit(success, message, details)
            else:
                self.finished_signal.emit(False, "VisionAnalyzer 不可用", {})

        except Exception as e:
            self.finished_signal.emit(False, f"测试失败: {str(e)}", {"error": str(e)})


# ============================================================
# 批量导入对话框
# ============================================================

class BatchImportDialog(QDialog):
    """批量导入对话框基类"""

    def __init__(self, parent, title: str, format_hint: str, columns: list[str]):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumSize(700, 500)

        self.columns = columns
        self.parsed_data = []  # 解析后的数据列表

        layout = QVBoxLayout(self)

        # 格式提示
        hint_label = QLabel(f"<b>格式:</b> {format_hint}")
        hint_label.setWordWrap(True)
        hint_label.setStyleSheet("color: #666; padding: 5px; background: #f5f5f5; border-radius: 3px;")
        layout.addWidget(hint_label)

        # 输入区域
        input_label = QLabel("请粘贴数据（每行一条记录）:")
        layout.addWidget(input_label)

        self.text_input = QTextEdit()
        self.text_input.setPlaceholderText("在此粘贴数据...")
        self.text_input.setMaximumHeight(150)
        self.text_input.textChanged.connect(self._on_text_changed)
        layout.addWidget(self.text_input)

        # 预览表格
        preview_label = QLabel("解析预览:")
        layout.addWidget(preview_label)

        self.preview_table = QTableWidget()
        self.preview_table.setColumnCount(len(columns) + 2)  # +2: "#" 列 + "状态" 列
        self.preview_table.setHorizontalHeaderLabels(["#"] + columns + ["状态"])
        self.preview_table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.preview_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.preview_table)

        # 统计信息
        self.stats_label = QLabel("有效: 0 | 无效: 0")
        layout.addWidget(self.stats_label)

        # 按钮
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("导入")
        buttons.accepted.connect(self._do_import)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def parse_line(self, line: str) -> tuple[bool, dict, str]:
        """
        解析单行数据（子类实现）

        Args:
            line: 原始行文本

        Returns:
            (是否成功, 解析后的字典, 错误信息)
        """
        raise NotImplementedError("子类必须实现 parse_line 方法")

    def save_record(self, data: dict) -> bool:
        """
        保存单条记录（子类实现）

        Args:
            data: 解析后的数据字典

        Returns:
            是否保存成功
        """
        raise NotImplementedError("子类必须实现 save_record 方法")

    def format_preview_row(self, data: dict) -> list[str]:
        """
        格式化预览行（子类可覆写以自定义显示）

        Args:
            data: 解析后的数据字典

        Returns:
            列值列表
        """
        return [str(data.get(col, '')) for col in self.columns]

    def _on_text_changed(self):
        """文本变化时更新预览"""
        text = self.text_input.toPlainText()
        lines = [line.strip() for line in text.split('\n') if line.strip() and not line.strip().startswith('#')]

        self.parsed_data = []
        self.preview_table.setRowCount(0)

        valid_count = 0
        invalid_count = 0

        for i, line in enumerate(lines):
            success, data, error = self.parse_line(line)

            row = self.preview_table.rowCount()
            self.preview_table.insertRow(row)

            # 序号
            self.preview_table.setItem(row, 0, QTableWidgetItem(str(i + 1)))

            if success:
                self.parsed_data.append(data)
                preview_values = self.format_preview_row(data)
                for col, value in enumerate(preview_values):
                    self.preview_table.setItem(row, col + 1, QTableWidgetItem(value))
                status_item = QTableWidgetItem("✓")
                status_item.setForeground(Qt.GlobalColor.darkGreen)
                self.preview_table.setItem(row, len(self.columns) + 1, status_item)
                valid_count += 1
            else:
                # 显示原始行（截断）
                display_line = line[:50] + "..." if len(line) > 50 else line
                self.preview_table.setItem(row, 1, QTableWidgetItem(display_line))
                status_item = QTableWidgetItem(f"✗ {error}")
                status_item.setForeground(Qt.GlobalColor.red)
                self.preview_table.setItem(row, len(self.columns) + 1, status_item)
                invalid_count += 1

        self.stats_label.setText(f"有效: {valid_count} | 无效: {invalid_count}")

    def _do_import(self):
        """执行导入"""
        if not self.parsed_data:
            QMessageBox.warning(self, "提示", "没有可导入的有效数据")
            return

        success_count = 0
        fail_count = 0

        for data in self.parsed_data:
            try:
                if self.save_record(data):
                    success_count += 1
                else:
                    fail_count += 1
            except Exception as e:
                print(f"保存记录失败: {e}")
                fail_count += 1

        QMessageBox.information(
            self, "导入完成",
            f"成功导入 {success_count} 条记录" +
            (f"\n失败 {fail_count} 条" if fail_count > 0 else "")
        )
        self.accept()


class AccountBatchImportDialog(BatchImportDialog):
    """账号批量导入对话框"""

    def __init__(self, parent=None):
        super().__init__(
            parent,
            title="批量导入账号",
            format_hint="邮箱----密码----辅助邮箱----2FA密钥 （后两项可选）",
            columns=["邮箱", "密码", "辅助邮箱", "2FA密钥"]
        )

    def parse_line(self, line: str) -> tuple[bool, dict, str]:
        parts = line.split('----')
        if len(parts) < 2:
            return False, {}, "格式错误：至少需要 邮箱----密码"

        email = parts[0].strip()
        password = parts[1].strip() if len(parts) > 1 else ""
        recovery = parts[2].strip() if len(parts) > 2 else ""
        secret = parts[3].strip() if len(parts) > 3 else ""

        # 邮箱格式校验
        if '@' not in email or '.' not in email:
            return False, {}, "邮箱格式无效"

        if not password:
            return False, {}, "密码不能为空"

        return True, {
            'email': email,
            'password': password,
            'recovery_email': recovery,
            'secret_key': secret
        }, ""

    def format_preview_row(self, data: dict) -> list[str]:
        return [
            data.get('email', ''),
            "******",  # 密码脱敏
            data.get('recovery_email', ''),
            data.get('secret_key', '')[:8] + "..." if len(data.get('secret_key', '')) > 8 else data.get('secret_key', '')
        ]

    def save_record(self, data: dict) -> bool:
        # 检查账号是否已存在，已存在则不覆盖状态
        existing = DBManager.get_account_by_email(data['email'])
        if existing:
            # 账号已存在，只更新基本信息，不覆盖状态
            # 密码必须更新，辅助邮箱和2FA只有非空时才更新
            recovery = data.get('recovery_email')
            secret = data.get('secret_key')
            DBManager.upsert_account(
                email=data['email'],
                password=data.get('password'),  # 密码总是更新
                recovery_email=recovery if recovery else None,  # 只有非空才更新
                secret_key=secret if secret else None,  # 只有非空才更新
                # 不传 status，保留原状态
            )
        else:
            # 新账号，设为 pending
            DBManager.upsert_account(
                email=data['email'],
                password=data.get('password'),
                recovery_email=data.get('recovery_email'),
                secret_key=data.get('secret_key'),
                status='pending'
            )
        return True


class CardBatchImportDialog(BatchImportDialog):
    """卡片批量导入对话框"""

    def __init__(self, parent=None):
        self.data_store = get_data_store()
        super().__init__(
            parent,
            title="批量导入卡片",
            format_hint="卡号----月份----年份----CVV----姓名----邮编 （后两项可选，默认 John Smith / 10001）",
            columns=["卡号", "有效期", "CVV", "姓名", "邮编"]
        )

    def parse_line(self, line: str) -> tuple[bool, dict, str]:
        parts = line.split('----')
        if len(parts) < 4:
            return False, {}, "格式错误：至少需要 卡号----月份----年份----CVV"

        number = parts[0].strip()
        exp_month = parts[1].strip()
        exp_year = parts[2].strip()
        cvv = parts[3].strip()
        name = parts[4].strip() if len(parts) > 4 else "John Smith"
        zip_code = parts[5].strip() if len(parts) > 5 else "10001"

        # 卡号校验
        if not number.isdigit() or not (13 <= len(number) <= 19):
            return False, {}, "卡号格式无效"

        # 月份校验
        if not exp_month.isdigit() or not (1 <= int(exp_month) <= 12):
            return False, {}, "月份无效"

        # 年份校验
        if not exp_year.isdigit() or len(exp_year) not in (2, 4):
            return False, {}, "年份无效"

        # CVV 校验
        if not cvv.isdigit() or len(cvv) not in (3, 4):
            return False, {}, "CVV无效"

        # 格式化
        if len(exp_month) == 1:
            exp_month = f"0{exp_month}"
        if len(exp_year) == 4:
            exp_year = exp_year[-2:]

        return True, {
            'number': number,
            'exp_month': exp_month,
            'exp_year': exp_year,
            'cvv': cvv,
            'name': name,
            'zip_code': zip_code
        }, ""

    def format_preview_row(self, data: dict) -> list[str]:
        # 卡号脱敏
        number = data.get('number', '')
        masked = f"**** **** **** {number[-4:]}" if len(number) >= 4 else "****"
        return [
            masked,
            f"{data.get('exp_month', '')}/{data.get('exp_year', '')}",
            "***",
            data.get('name', ''),
            data.get('zip_code', '')
        ]

    def save_record(self, data: dict) -> bool:
        self.data_store.add_card(CardInfo(**data))
        return True


class ProxyBatchImportDialog(BatchImportDialog):
    """代理批量导入对话框"""

    def __init__(self, parent=None):
        self.data_store = get_data_store()
        super().__init__(
            parent,
            title="批量导入代理",
            format_hint="host:port:user:pass 或 host:port （无认证）",
            columns=["类型", "主机", "端口", "用户名"]
        )

    def parse_line(self, line: str) -> tuple[bool, dict, str]:
        parts = line.split(':')
        if len(parts) < 2:
            return False, {}, "格式错误：至少需要 host:port"

        host = parts[0].strip()
        port = parts[1].strip()
        username = parts[2].strip() if len(parts) > 2 else ""
        password = parts[3].strip() if len(parts) > 3 else ""

        # 主机校验
        if not host:
            return False, {}, "主机不能为空"

        # 端口校验
        if not port.isdigit():
            return False, {}, "端口必须是数字"

        return True, {
            'proxy_type': 'socks5',  # 默认类型
            'host': host,
            'port': port,
            'username': username,
            'password': password
        }, ""

    def format_preview_row(self, data: dict) -> list[str]:
        return [
            data.get('proxy_type', 'socks5'),
            data.get('host', ''),
            data.get('port', ''),
            data.get('username', '') or "(无)"
        ]

    def save_record(self, data: dict) -> bool:
        self.data_store.add_proxy(ProxyInfo(**data))
        return True


class AccountsTab(QWidget):
    """账号管理标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._all_accounts = []  # 存储所有账号数据，用于搜索过滤
        self._init_ui()
        self.load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 工具栏
        toolbar = QHBoxLayout()

        # 全选复选框
        self.header_checkbox = QCheckBox()
        self.header_checkbox.setToolTip("全选/取消全选可见账号")
        self.header_checkbox.stateChanged.connect(self._toggle_all_checkboxes)
        toolbar.addWidget(self.header_checkbox)

        self.btn_add = QPushButton("添加账号")
        self.btn_add.clicked.connect(self.add_account)
        toolbar.addWidget(self.btn_add)

        self.btn_batch_import = QPushButton("📥 批量导入")
        self.btn_batch_import.clicked.connect(self.batch_import)
        toolbar.addWidget(self.btn_batch_import)

        self.btn_delete = QPushButton("删除选中")
        self.btn_delete.clicked.connect(self.delete_selected)
        toolbar.addWidget(self.btn_delete)

        self.btn_export = QPushButton("📤 导出选中")
        self.btn_export.clicked.connect(self.export_selected)
        toolbar.addWidget(self.btn_export)

        self.btn_refresh = QPushButton("刷新")
        self.btn_refresh.clicked.connect(self.load_data)
        toolbar.addWidget(self.btn_refresh)

        toolbar.addStretch()

        # 搜索框
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("🔍 搜索邮箱...")
        self.search_input.setMaximumWidth(200)
        self.search_input.setClearButtonEnabled(True)
        self.search_input.textChanged.connect(self._filter_table)
        toolbar.addWidget(self.search_input)

        self.count_label = QLabel("共 0 个账号")
        toolbar.addWidget(self.count_label)

        layout.addLayout(toolbar)

        # 表格（新增复选框列）
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["", "邮箱", "密码", "辅助邮箱", "2FA密钥", "状态", "操作"])

        # 设置列宽
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(0, 40)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(3, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        self.table.horizontalHeader().setSectionResizeMode(6, QHeaderView.ResizeMode.ResizeToContents)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def _create_checkbox_widget(self) -> QWidget:
        """创建居中的复选框组件"""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        checkbox = QCheckBox()
        layout.addWidget(checkbox)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.setContentsMargins(0, 0, 0, 0)
        return widget

    def _get_checkbox(self, row: int) -> QCheckBox:
        """获取指定行的复选框"""
        widget = self.table.cellWidget(row, 0)
        if widget:
            return widget.findChild(QCheckBox)
        return None

    def _toggle_all_checkboxes(self, state: int):
        """全选/取消全选（仅可见行）"""
        checked = state == Qt.CheckState.Checked.value
        for row in range(self.table.rowCount()):
            # 只操作可见行
            if not self.table.isRowHidden(row):
                checkbox = self._get_checkbox(row)
                if checkbox:
                    checkbox.setChecked(checked)

    def _get_selected_rows(self) -> list:
        """获取所有勾选的可见行号"""
        selected = []
        for row in range(self.table.rowCount()):
            # 只返回可见且勾选的行
            if not self.table.isRowHidden(row):
                checkbox = self._get_checkbox(row)
                if checkbox and checkbox.isChecked():
                    selected.append(row)
        return selected

    def _filter_table(self, search_text: str):
        """实时过滤表格"""
        search_text = search_text.lower().strip()
        visible_count = 0

        for row in range(self.table.rowCount()):
            email_item = self.table.item(row, 1)
            if email_item:
                email = email_item.text().lower()
                match = search_text in email if search_text else True
                self.table.setRowHidden(row, not match)
                if match:
                    visible_count += 1
                else:
                    # 隐藏行时取消勾选，避免误操作
                    checkbox = self._get_checkbox(row)
                    if checkbox:
                        checkbox.setChecked(False)

        # 重置全选复选框状态
        self.header_checkbox.blockSignals(True)
        self.header_checkbox.setChecked(False)
        self.header_checkbox.blockSignals(False)

        # 更新计数标签
        total = self.table.rowCount()
        if search_text:
            self.count_label.setText(f"显示 {visible_count}/{total} 个账号")
        else:
            self.count_label.setText(f"共 {total} 个账号")

    def load_data(self):
        """加载账号数据"""
        try:
            DBManager.init_db()
            accounts = DBManager.get_all_accounts()
            self._all_accounts = accounts

            self.table.setRowCount(0)
            for acc in accounts:
                row = self.table.rowCount()
                self.table.insertRow(row)

                # 复选框列
                self.table.setCellWidget(row, 0, self._create_checkbox_widget())

                self.table.setItem(row, 1, QTableWidgetItem(acc.get('email', '')))
                self.table.setItem(row, 2, QTableWidgetItem(acc.get('password', '')))
                self.table.setItem(row, 3, QTableWidgetItem(acc.get('recovery_email', '')))
                self.table.setItem(row, 4, QTableWidgetItem(acc.get('secret_key', '')))
                self.table.setItem(row, 5, QTableWidgetItem(acc.get('status', '')))

                # 编辑按钮
                btn_edit = QPushButton("编辑")
                btn_edit.clicked.connect(lambda checked, r=row: self.edit_account(r))
                self.table.setCellWidget(row, 6, btn_edit)

            self.count_label.setText(f"共 {len(accounts)} 个账号")

            # 重置全选复选框（不触发信号）
            self.header_checkbox.blockSignals(True)
            self.header_checkbox.setChecked(False)
            self.header_checkbox.blockSignals(False)

            # 如果搜索框有内容，重新应用过滤
            if self.search_input.text():
                self._filter_table(self.search_input.text())
        except Exception as e:
            QMessageBox.warning(self, "错误", f"加载账号失败: {e}")

    def add_account(self):
        """添加新账号"""
        dialog = AccountEditDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            DBManager.upsert_account(
                email=data['email'],
                password=data['password'],
                recovery_email=data['recovery_email'],
                secret_key=data['secret_key'],
                status='pending'
            )
            self.load_data()

    def edit_account(self, row: int):
        """编辑账号"""
        email = self.table.item(row, 1).text()
        password = self.table.item(row, 2).text()
        recovery = self.table.item(row, 3).text()
        secret = self.table.item(row, 4).text()

        dialog = AccountEditDialog(self, {
            'email': email,
            'password': password,
            'recovery_email': recovery,
            'secret_key': secret
        })
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            DBManager.upsert_account(
                email=data['email'],
                password=data['password'],
                recovery_email=data['recovery_email'],
                secret_key=data['secret_key']
            )
            self.load_data()

    def delete_selected(self):
        """删除选中账号（同时删除对应的 ixBrowser 窗口）"""
        rows = self._get_selected_rows()
        if not rows:
            QMessageBox.information(self, "提示", "请先勾选要删除的账号")
            return

        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除选中的 {len(rows)} 个账号吗？\n将同时删除对应的 ixBrowser 窗口。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            deleted_accounts = 0
            deleted_windows = 0

            for row in sorted(rows, reverse=True):
                email = self.table.item(row, 1).text()

                # 查找并删除对应的 ixBrowser 窗口
                try:
                    profile_id = find_browser_by_email(email)
                    if profile_id:
                        # 先关闭窗口（如果正在运行）
                        try:
                            closeBrowser(profile_id)
                        except Exception:
                            pass  # 忽略关闭错误
                        # 删除窗口
                        try:
                            result = deleteBrowser(profile_id)
                            if result.get('success'):
                                deleted_windows += 1
                        except Exception:
                            pass  # 忽略删除错误
                except Exception:
                    pass  # 忽略查找错误

                # 删除数据库中的账号
                DBManager.delete_account(email)
                deleted_accounts += 1

            self.load_data()

            # 显示删除结果
            if deleted_windows > 0:
                QMessageBox.information(
                    self, "删除完成",
                    f"已删除 {deleted_accounts} 个账号，同时删除了 {deleted_windows} 个对应窗口。"
                )

    def export_selected(self):
        """导出选中账号到 TXT 文件"""
        rows = self._get_selected_rows()
        if not rows:
            QMessageBox.information(self, "提示", "请先勾选要导出的账号")
            return

        # 选择保存路径
        file_path, _ = QFileDialog.getSaveFileName(
            self, "导出账号", "accounts_export.txt", "文本文件 (*.txt)"
        )
        if not file_path:
            return

        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write('分隔符="----"\n')
                for row in rows:
                    email = self.table.item(row, 1).text()
                    password = self.table.item(row, 2).text()
                    recovery = self.table.item(row, 3).text()
                    secret = self.table.item(row, 4).text()
                    line = f"{email}----{password}----{recovery}----{secret}\n"
                    f.write(line)

            QMessageBox.information(
                self, "导出成功",
                f"已导出 {len(rows)} 个账号到:\n{file_path}"
            )
        except Exception as e:
            QMessageBox.warning(self, "导出失败", f"导出时发生错误: {e}")

    def batch_import(self):
        """批量导入账号"""
        dialog = AccountBatchImportDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.load_data()


class AccountEditDialog(QDialog):
    """账号编辑对话框"""

    def __init__(self, parent=None, data=None):
        super().__init__(parent)
        self.setWindowTitle("编辑账号" if data else "添加账号")
        self.setMinimumWidth(400)

        layout = QFormLayout(self)

        self.email_input = QLineEdit()
        self.email_input.setPlaceholderText("example@gmail.com")
        if data:
            self.email_input.setText(data.get('email', ''))
            self.email_input.setReadOnly(True)
        layout.addRow("邮箱:", self.email_input)

        self.password_input = QLineEdit()
        if data:
            self.password_input.setText(data.get('password', ''))
        layout.addRow("密码:", self.password_input)

        self.recovery_input = QLineEdit()
        if data:
            self.recovery_input.setText(data.get('recovery_email', ''))
        layout.addRow("辅助邮箱:", self.recovery_input)

        self.secret_input = QLineEdit()
        if data:
            self.secret_input.setText(data.get('secret_key', ''))
        layout.addRow("2FA密钥:", self.secret_input)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def get_data(self):
        return {
            'email': self.email_input.text().strip(),
            'password': self.password_input.text(),
            'recovery_email': self.recovery_input.text().strip(),
            'secret_key': self.secret_input.text().strip()
        }


class CardsTab(QWidget):
    """卡片管理标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.data_store = get_data_store()
        self._init_ui()
        self.load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 工具栏
        toolbar = QHBoxLayout()

        self.btn_add = QPushButton("添加卡片")
        self.btn_add.clicked.connect(self.add_card)
        toolbar.addWidget(self.btn_add)

        self.btn_batch_import = QPushButton("📥 批量导入")
        self.btn_batch_import.clicked.connect(self.batch_import)
        toolbar.addWidget(self.btn_batch_import)

        self.btn_delete = QPushButton("删除选中")
        self.btn_delete.clicked.connect(self.delete_selected)
        toolbar.addWidget(self.btn_delete)

        self.btn_refresh = QPushButton("刷新")
        self.btn_refresh.clicked.connect(self.load_data)
        toolbar.addWidget(self.btn_refresh)

        toolbar.addStretch()

        self.count_label = QLabel("共 0 张卡片")
        toolbar.addWidget(self.count_label)

        layout.addLayout(toolbar)

        # 表格
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["卡号", "有效期", "CVV", "姓名", "邮编", "操作", ""])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def load_data(self):
        """加载卡片数据"""
        try:
            self.data_store.reload()
            cards = self.data_store.get_cards()

            self.table.setRowCount(0)
            for card in cards:
                row = self.table.rowCount()
                self.table.insertRow(row)

                # 显示脱敏卡号
                self.table.setItem(row, 0, QTableWidgetItem(card.get_masked_number()))
                self.table.setItem(row, 1, QTableWidgetItem(f"{card.exp_month}/{card.exp_year}"))
                self.table.setItem(row, 2, QTableWidgetItem("***"))
                self.table.setItem(row, 3, QTableWidgetItem(card.name))
                self.table.setItem(row, 4, QTableWidgetItem(card.zip_code))

                # 编辑按钮
                btn_edit = QPushButton("编辑")
                btn_edit.clicked.connect(lambda checked, r=row: self.edit_card(r))
                self.table.setCellWidget(row, 5, btn_edit)

            self.count_label.setText(f"共 {len(cards)} 张卡片")
        except Exception as e:
            QMessageBox.warning(self, "错误", f"加载卡片失败: {e}")

    def add_card(self):
        """添加新卡片"""
        dialog = CardEditDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            self.data_store.add_card(CardInfo(**data))
            self.load_data()

    def edit_card(self, row: int):
        """编辑卡片"""
        cards = self.data_store.get_cards()
        if row >= len(cards):
            return

        card = cards[row]
        dialog = CardEditDialog(self, card.to_dict())
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            self.data_store.update_card(row, CardInfo(**data))
            self.load_data()

    def delete_selected(self):
        """删除选中卡片"""
        rows = set(item.row() for item in self.table.selectedItems())
        if not rows:
            QMessageBox.information(self, "提示", "请先选择要删除的卡片")
            return

        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除选中的 {len(rows)} 张卡片吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            for row in sorted(rows, reverse=True):
                self.data_store.remove_card(row)
            self.load_data()

    def batch_import(self):
        """批量导入卡片"""
        dialog = CardBatchImportDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.load_data()


class CardEditDialog(QDialog):
    """卡片编辑对话框"""

    def __init__(self, parent=None, data=None):
        super().__init__(parent)
        self.setWindowTitle("编辑卡片" if data else "添加卡片")
        self.setMinimumWidth(400)

        layout = QFormLayout(self)

        self.number_input = QLineEdit()
        self.number_input.setPlaceholderText("4111111111111111")
        if data:
            self.number_input.setText(data.get('number', ''))
        layout.addRow("卡号:", self.number_input)

        exp_layout = QHBoxLayout()
        self.month_input = QLineEdit()
        self.month_input.setPlaceholderText("MM")
        self.month_input.setMaximumWidth(60)
        if data:
            self.month_input.setText(data.get('exp_month', ''))
        exp_layout.addWidget(self.month_input)
        exp_layout.addWidget(QLabel("/"))
        self.year_input = QLineEdit()
        self.year_input.setPlaceholderText("YY")
        self.year_input.setMaximumWidth(60)
        if data:
            self.year_input.setText(data.get('exp_year', ''))
        exp_layout.addWidget(self.year_input)
        exp_layout.addStretch()
        layout.addRow("有效期:", exp_layout)

        self.cvv_input = QLineEdit()
        self.cvv_input.setPlaceholderText("123")
        self.cvv_input.setMaximumWidth(80)
        if data:
            self.cvv_input.setText(data.get('cvv', ''))
        layout.addRow("CVV:", self.cvv_input)

        self.name_input = QLineEdit()
        self.name_input.setPlaceholderText("John Smith")
        if data:
            self.name_input.setText(data.get('name', 'John Smith'))
        else:
            self.name_input.setText("John Smith")
        layout.addRow("持卡人姓名:", self.name_input)

        self.zip_input = QLineEdit()
        self.zip_input.setPlaceholderText("10001")
        if data:
            self.zip_input.setText(data.get('zip_code', '10001'))
        else:
            self.zip_input.setText("10001")
        layout.addRow("邮编:", self.zip_input)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.validate_and_accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def validate_and_accept(self):
        """验证并接受"""
        number = self.number_input.text().strip()
        if not number or len(number) < 13:
            QMessageBox.warning(self, "验证失败", "请输入有效的卡号")
            return

        month = self.month_input.text().strip()
        if not month.isdigit() or not (1 <= int(month) <= 12):
            QMessageBox.warning(self, "验证失败", "请输入有效的月份 (01-12)")
            return

        year = self.year_input.text().strip()
        if not year.isdigit() or len(year) not in (2, 4):
            QMessageBox.warning(self, "验证失败", "请输入有效的年份 (YY 或 YYYY)")
            return

        cvv = self.cvv_input.text().strip()
        if not cvv.isdigit() or len(cvv) not in (3, 4):
            QMessageBox.warning(self, "验证失败", "请输入有效的 CVV (3-4位)")
            return

        self.accept()

    def get_data(self):
        month = self.month_input.text().strip()
        year = self.year_input.text().strip()

        if len(month) == 1:
            month = f"0{month}"
        if len(year) == 4:
            year = year[-2:]

        return {
            'number': self.number_input.text().strip(),
            'exp_month': month,
            'exp_year': year,
            'cvv': self.cvv_input.text().strip(),
            'name': self.name_input.text().strip() or "John Smith",
            'zip_code': self.zip_input.text().strip() or "10001"
        }


class ProxiesTab(QWidget):
    """代理管理标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.data_store = get_data_store()
        self._init_ui()
        self.load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 工具栏
        toolbar = QHBoxLayout()

        self.btn_add = QPushButton("添加代理")
        self.btn_add.clicked.connect(self.add_proxy)
        toolbar.addWidget(self.btn_add)

        self.btn_batch_import = QPushButton("📥 批量导入")
        self.btn_batch_import.clicked.connect(self.batch_import)
        toolbar.addWidget(self.btn_batch_import)

        self.btn_delete = QPushButton("删除选中")
        self.btn_delete.clicked.connect(self.delete_selected)
        toolbar.addWidget(self.btn_delete)

        self.btn_refresh = QPushButton("刷新")
        self.btn_refresh.clicked.connect(self.load_data)
        toolbar.addWidget(self.btn_refresh)

        toolbar.addStretch()

        self.count_label = QLabel("共 0 个代理")
        toolbar.addWidget(self.count_label)

        layout.addLayout(toolbar)

        # 表格 - 增加使用情况列
        self.table = QTableWidget()
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["类型", "主机", "端口", "用户名", "密码", "使用情况", "操作"])
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def load_data(self):
        """加载代理数据"""
        try:
            from services.proxy_allocator import ProxyAllocator

            self.data_store.reload()
            proxies = self.data_store.get_proxies()
            usage_stats = ProxyAllocator.get_all_usage_stats()

            # 创建使用情况映射 (host:port -> stats)
            usage_map = {}
            for stat in usage_stats:
                key = f"{stat['host']}:{stat['port']}"
                usage_map[key] = stat

            self.table.setRowCount(0)
            for proxy in proxies:
                row = self.table.rowCount()
                self.table.insertRow(row)

                self.table.setItem(row, 0, QTableWidgetItem(proxy.proxy_type))
                self.table.setItem(row, 1, QTableWidgetItem(proxy.host))
                self.table.setItem(row, 2, QTableWidgetItem(proxy.port))
                self.table.setItem(row, 3, QTableWidgetItem(proxy.username))
                self.table.setItem(row, 4, QTableWidgetItem("***" if proxy.password else ""))

                # 使用情况
                key = f"{proxy.host}:{proxy.port}"
                stat = usage_map.get(key, {})
                used = stat.get('used_count', 0)
                max_count = stat.get('max_count', 3)
                is_full = stat.get('is_full', False)

                usage_text = f"{used}/{max_count}"
                usage_item = QTableWidgetItem(usage_text)
                if is_full:
                    usage_item.setForeground(QBrush(QColor("#f44336")))  # 红色
                elif used > 0:
                    usage_item.setForeground(QBrush(QColor("#ff9800")))  # 橙色
                else:
                    usage_item.setForeground(QBrush(QColor("#4caf50")))  # 绿色
                self.table.setItem(row, 5, usage_item)

                # 操作按钮
                btn_container = QWidget()
                btn_layout = QHBoxLayout(btn_container)
                btn_layout.setContentsMargins(2, 2, 2, 2)
                btn_layout.setSpacing(4)

                btn_edit = QPushButton("编辑")
                btn_edit.setFixedWidth(45)
                btn_edit.clicked.connect(lambda checked, r=row: self.edit_proxy(r))
                btn_layout.addWidget(btn_edit)

                proxy_id = stat.get('proxy_id')
                if proxy_id and used > 0:
                    btn_detail = QPushButton("详情")
                    btn_detail.setFixedWidth(45)
                    btn_detail.clicked.connect(lambda checked, pid=proxy_id: self.show_proxy_detail(pid))
                    btn_layout.addWidget(btn_detail)

                self.table.setCellWidget(row, 6, btn_container)

            self.count_label.setText(f"共 {len(proxies)} 个代理")
        except Exception as e:
            QMessageBox.warning(self, "错误", f"加载代理失败: {e}")

    def show_proxy_detail(self, proxy_id: int):
        """显示代理详情对话框"""
        dialog = ProxyDetailDialog(self, proxy_id)
        dialog.exec()
        self.load_data()  # 刷新数据（解绑后需更新）

    def add_proxy(self):
        """添加新代理"""
        dialog = ProxyEditDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            self.data_store.add_proxy(ProxyInfo(**data))
            self.load_data()

    def edit_proxy(self, row: int):
        """编辑代理"""
        proxies = self.data_store.get_proxies()
        if row >= len(proxies):
            return

        proxy = proxies[row]
        dialog = ProxyEditDialog(self, proxy.to_dict())
        if dialog.exec() == QDialog.DialogCode.Accepted:
            data = dialog.get_data()
            self.data_store.update_proxy(row, ProxyInfo(**data))
            self.load_data()

    def delete_selected(self):
        """删除选中代理"""
        rows = set(item.row() for item in self.table.selectedItems())
        if not rows:
            QMessageBox.information(self, "提示", "请先选择要删除的代理")
            return

        reply = QMessageBox.question(
            self, "确认删除",
            f"确定要删除选中的 {len(rows)} 个代理吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            for row in sorted(rows, reverse=True):
                self.data_store.remove_proxy(row)
            self.load_data()

    def batch_import(self):
        """批量导入代理"""
        dialog = ProxyBatchImportDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.load_data()


class ProxyDetailDialog(QDialog):
    """代理详情对话框 - 显示关联窗口列表"""

    def __init__(self, parent=None, proxy_id: int = None):
        super().__init__(parent)
        self.proxy_id = proxy_id
        self.setWindowTitle("代理详情")
        self.setMinimumSize(600, 400)
        self._init_ui()
        self.load_data()

    def _init_ui(self):
        layout = QVBoxLayout(self)

        # 代理信息
        self.info_label = QLabel()
        self.info_label.setStyleSheet("font-size: 14px; font-weight: bold; padding: 10px;")
        layout.addWidget(self.info_label)

        # 关联窗口表格
        self.table = QTableWidget()
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["窗口 ID", "邮箱", "绑定时间", "操作"])
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

        # 按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.btn_unbind_all = QPushButton("解绑全部")
        self.btn_unbind_all.clicked.connect(self.unbind_all)
        btn_layout.addWidget(self.btn_unbind_all)

        self.btn_close = QPushButton("关闭")
        self.btn_close.clicked.connect(self.accept)
        btn_layout.addWidget(self.btn_close)

        layout.addLayout(btn_layout)

    def load_data(self):
        """加载关联窗口数据"""
        try:
            from services.proxy_allocator import ProxyAllocator
            from services.database import DBManager

            # 获取代理信息
            stats = ProxyAllocator.get_all_usage_stats()
            proxy_info = None
            for stat in stats:
                if stat['proxy_id'] == self.proxy_id:
                    proxy_info = stat
                    break

            if proxy_info:
                self.info_label.setText(
                    f"🌐 {proxy_info['proxy_type']}://{proxy_info['host']}:{proxy_info['port']}  "
                    f"使用情况: {proxy_info['used_count']}/{proxy_info['max_count']}"
                )
            else:
                self.info_label.setText(f"代理 ID: {self.proxy_id}")

            # 获取绑定列表
            bindings = DBManager.get_proxy_bindings(self.proxy_id)

            self.table.setRowCount(0)
            for binding in bindings:
                row = self.table.rowCount()
                self.table.insertRow(row)

                self.table.setItem(row, 0, QTableWidgetItem(str(binding.get('browser_id', ''))))
                self.table.setItem(row, 1, QTableWidgetItem(binding.get('email', '') or '-'))
                self.table.setItem(row, 2, QTableWidgetItem(str(binding.get('bound_at', ''))))

                btn_unbind = QPushButton("解绑")
                browser_id = binding.get('browser_id')
                btn_unbind.clicked.connect(lambda checked, bid=browser_id: self.unbind_single(bid))
                self.table.setCellWidget(row, 3, btn_unbind)

            self.btn_unbind_all.setEnabled(len(bindings) > 0)
        except Exception as e:
            QMessageBox.warning(self, "错误", f"加载数据失败: {e}")

    def unbind_single(self, browser_id: str):
        """解绑单个窗口"""
        from services.proxy_allocator import ProxyAllocator

        reply = QMessageBox.question(
            self, "确认解绑",
            f"确定要解绑窗口 {browser_id} 吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            ProxyAllocator.unbind_window(browser_id)
            self.load_data()

    def unbind_all(self):
        """解绑全部窗口"""
        from services.database import DBManager

        bindings = DBManager.get_proxy_bindings(self.proxy_id)
        if not bindings:
            return

        reply = QMessageBox.question(
            self, "确认解绑",
            f"确定要解绑全部 {len(bindings)} 个窗口吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            from services.proxy_allocator import ProxyAllocator
            for binding in bindings:
                ProxyAllocator.unbind_window(binding.get('browser_id'))
            self.load_data()


class ProxyEditDialog(QDialog):
    """代理编辑对话框"""

    def __init__(self, parent=None, data=None):
        super().__init__(parent)
        self.setWindowTitle("编辑代理" if data else "添加代理")
        self.setMinimumWidth(400)

        layout = QFormLayout(self)

        self.type_combo = QComboBox()
        self.type_combo.addItems(["socks5", "http", "https"])
        if data:
            idx = self.type_combo.findText(data.get('proxy_type', 'socks5'))
            if idx >= 0:
                self.type_combo.setCurrentIndex(idx)
        layout.addRow("类型:", self.type_combo)

        self.host_input = QLineEdit()
        self.host_input.setPlaceholderText("127.0.0.1")
        if data:
            self.host_input.setText(data.get('host', ''))
        layout.addRow("主机:", self.host_input)

        self.port_input = QLineEdit()
        self.port_input.setPlaceholderText("1080")
        if data:
            self.port_input.setText(data.get('port', ''))
        layout.addRow("端口:", self.port_input)

        self.username_input = QLineEdit()
        if data:
            self.username_input.setText(data.get('username', ''))
        layout.addRow("用户名:", self.username_input)

        self.password_input = QLineEdit()
        if data:
            self.password_input.setText(data.get('password', ''))
        layout.addRow("密码:", self.password_input)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.validate_and_accept)
        buttons.rejected.connect(self.reject)
        layout.addRow(buttons)

    def validate_and_accept(self):
        """验证并接受"""
        host = self.host_input.text().strip()
        if not host:
            QMessageBox.warning(self, "验证失败", "请输入主机地址")
            return

        port = self.port_input.text().strip()
        if not port.isdigit():
            QMessageBox.warning(self, "验证失败", "请输入有效的端口号")
            return

        self.accept()

    def get_data(self):
        return {
            'proxy_type': self.type_combo.currentText(),
            'host': self.host_input.text().strip(),
            'port': self.port_input.text().strip(),
            'username': self.username_input.text().strip(),
            'password': self.password_input.text()
        }


class SettingsTab(QWidget):
    """全局设置标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.test_worker = None  # AI 连接测试线程
        self._init_ui()
        self.load_settings()

    def _init_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # 创建滚动区域
        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_area.setFrameShape(QScrollArea.Shape.NoFrame)

        # 滚动区域内容容器
        scroll_content = QWidget()
        layout = QVBoxLayout(scroll_content)

        # API 设置
        api_group = QGroupBox("API 设置")
        api_layout = QFormLayout()

        self.api_key_input = QLineEdit()
        self.api_key_input.setPlaceholderText("SheerID API Key")
        self.api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        api_layout.addRow("SheerID API Key:", self.api_key_input)

        api_group.setLayout(api_layout)
        layout.addWidget(api_group)

        # AI Agent 配置区域 (多提供商)
        ai_group = QGroupBox("🤖 AI Agent 配置 (多提供商)")
        ai_main_layout = QVBoxLayout()

        # 默认提供商选择
        provider_layout = QHBoxLayout()
        provider_layout.addWidget(QLabel("默认提供商:"))
        self.ai_provider_combo = QComboBox()
        self.ai_provider_combo.addItems(["gemini", "anthropic"])
        self.ai_provider_combo.currentTextChanged.connect(self._on_provider_changed)
        provider_layout.addWidget(self.ai_provider_combo)
        provider_layout.addStretch()
        ai_main_layout.addLayout(provider_layout)

        # 提供商配置选项卡
        self.ai_provider_tabs = QTabWidget()

        # Gemini 配置标签页
        gemini_tab = QWidget()
        gemini_layout = QFormLayout(gemini_tab)

        self.gemini_api_key_input = QLineEdit()
        self.gemini_api_key_input.setPlaceholderText("Gemini API Key（或从环境变量 GEMINI_API_KEY 读取）")
        self.gemini_api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        gemini_layout.addRow("API Key:", self.gemini_api_key_input)

        self.gemini_base_url_input = QLineEdit()
        self.gemini_base_url_input.setPlaceholderText("留空使用 Gemini 官方 API")
        gemini_layout.addRow("Base URL:", self.gemini_base_url_input)

        self.gemini_model_combo = QComboBox()
        self.gemini_model_combo.setEditable(True)
        self.gemini_model_combo.addItems([
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.5-flash-lite",
        ])
        gemini_layout.addRow("模型:", self.gemini_model_combo)

        # Gemini 测试按钮
        gemini_btn_layout = QHBoxLayout()
        self.gemini_test_btn = QPushButton("🔗 测试 Gemini 连接")
        self.gemini_test_btn.clicked.connect(lambda: self._test_provider_connection("gemini"))
        self.gemini_test_btn.setStyleSheet("background-color: #4285F4; color: white; padding: 5px 15px;")
        gemini_btn_layout.addWidget(self.gemini_test_btn)
        gemini_btn_layout.addStretch()
        gemini_layout.addRow("", gemini_btn_layout)

        self.ai_provider_tabs.addTab(gemini_tab, "🔷 Gemini")

        # Anthropic/Claude 配置标签页
        anthropic_tab = QWidget()
        anthropic_layout = QFormLayout(anthropic_tab)

        self.anthropic_api_key_input = QLineEdit()
        self.anthropic_api_key_input.setPlaceholderText("Anthropic API Key（或从环境变量 ANTHROPIC_API_KEY 读取）")
        self.anthropic_api_key_input.setEchoMode(QLineEdit.EchoMode.Password)
        anthropic_layout.addRow("API Key:", self.anthropic_api_key_input)

        self.anthropic_base_url_input = QLineEdit()
        self.anthropic_base_url_input.setPlaceholderText("留空使用官方 API，或填写第三方兼容服务 URL")
        anthropic_layout.addRow("Base URL:", self.anthropic_base_url_input)

        self.anthropic_model_combo = QComboBox()
        self.anthropic_model_combo.setEditable(True)
        self.anthropic_model_combo.addItems([
            "claude-sonnet-4-20250514",
            "claude-3-5-sonnet-20241022",
            "claude-3-opus-20240229",
            "claude-3-haiku-20240307",
        ])
        anthropic_layout.addRow("模型:", self.anthropic_model_combo)

        # 第三方服务提示
        anthropic_hint = QLabel("💡 支持第三方 Claude API 服务，如 OpenRouter、Together 等")
        anthropic_hint.setStyleSheet("color: #666; font-size: 11px;")
        anthropic_hint.setWordWrap(True)
        anthropic_layout.addRow("", anthropic_hint)

        # Anthropic 测试按钮
        anthropic_btn_layout = QHBoxLayout()
        self.anthropic_test_btn = QPushButton("🔗 测试 Anthropic 连接")
        self.anthropic_test_btn.clicked.connect(lambda: self._test_provider_connection("anthropic"))
        self.anthropic_test_btn.setStyleSheet("background-color: #D97706; color: white; padding: 5px 15px;")
        anthropic_btn_layout.addWidget(self.anthropic_test_btn)
        anthropic_btn_layout.addStretch()
        anthropic_layout.addRow("", anthropic_btn_layout)

        self.ai_provider_tabs.addTab(anthropic_tab, "🟠 Anthropic/Claude")

        ai_main_layout.addWidget(self.ai_provider_tabs)

        # 通用配置
        common_layout = QFormLayout()

        self.ai_max_steps_spin = QSpinBox()
        self.ai_max_steps_spin.setRange(5, 50)
        self.ai_max_steps_spin.setValue(25)
        common_layout.addRow("最大步骤:", self.ai_max_steps_spin)

        # 提示信息
        ai_hint = QLabel("提示: AI Agent 用于智能浏览器自动化任务（修改2SV手机、替换辅助邮箱等）")
        ai_hint.setStyleSheet("color: #666; font-size: 11px;")
        ai_hint.setWordWrap(True)
        common_layout.addRow("", ai_hint)

        ai_main_layout.addLayout(common_layout)

        ai_group.setLayout(ai_main_layout)
        layout.addWidget(ai_group)

        # Gmail IMAP 设置（用于接收验证码）
        gmail_group = QGroupBox("Gmail 验证码邮箱（替换辅助邮箱功能）")
        gmail_layout = QFormLayout()

        self.gmail_email_input = QLineEdit()
        self.gmail_email_input.setPlaceholderText("example@gmail.com")
        gmail_layout.addRow("Gmail 邮箱:", self.gmail_email_input)

        self.gmail_password_input = QLineEdit()
        self.gmail_password_input.setPlaceholderText("应用专用密码（非登录密码）")
        self.gmail_password_input.setEchoMode(QLineEdit.EchoMode.Password)
        gmail_layout.addRow("应用密码:", self.gmail_password_input)

        # 提示和链接
        gmail_hint = QLabel("提示: 需在 Google 账号设置中生成「应用专用密码」")
        gmail_hint.setStyleSheet("color: #666; font-size: 11px;")
        gmail_layout.addRow("", gmail_hint)

        # 应用密码获取链接
        app_password_url = "https://myaccount.google.com/apppasswords"
        gmail_link_layout = QHBoxLayout()
        gmail_link_label = QLabel(f'获取应用密码: <a href="{app_password_url}">{app_password_url}</a>')
        gmail_link_label.setOpenExternalLinks(True)
        gmail_link_label.setStyleSheet("color: #1976D2; font-size: 11px;")
        gmail_link_layout.addWidget(gmail_link_label)

        self.gmail_copy_link_btn = QPushButton("复制链接")
        self.gmail_copy_link_btn.setFixedWidth(70)
        self.gmail_copy_link_btn.setStyleSheet("font-size: 11px; padding: 2px 5px;")
        self.gmail_copy_link_btn.clicked.connect(lambda: self._copy_to_clipboard(app_password_url))
        gmail_link_layout.addWidget(self.gmail_copy_link_btn)
        gmail_link_layout.addStretch()

        gmail_layout.addRow("", gmail_link_layout)

        gmail_group.setLayout(gmail_layout)
        layout.addWidget(gmail_group)

        # 超时设置
        timeout_group = QGroupBox("超时设置 (秒)")
        timeout_layout = QFormLayout()

        self.page_load_spin = QSpinBox()
        self.page_load_spin.setRange(10, 120)
        self.page_load_spin.setValue(30)
        timeout_layout.addRow("页面加载:", self.page_load_spin)

        self.status_check_spin = QSpinBox()
        self.status_check_spin.setRange(5, 60)
        self.status_check_spin.setValue(20)
        timeout_layout.addRow("状态检测:", self.status_check_spin)

        self.iframe_wait_spin = QSpinBox()
        self.iframe_wait_spin.setRange(5, 60)
        self.iframe_wait_spin.setValue(15)
        timeout_layout.addRow("Iframe 等待:", self.iframe_wait_spin)

        timeout_group.setLayout(timeout_layout)
        layout.addWidget(timeout_group)

        # 延迟设置
        delay_group = QGroupBox("操作延迟 (秒)")
        delay_layout = QFormLayout()

        self.delay_login_spin = QSpinBox()
        self.delay_login_spin.setRange(1, 30)
        self.delay_login_spin.setValue(3)
        delay_layout.addRow("登录后:", self.delay_login_spin)

        self.delay_offer_spin = QSpinBox()
        self.delay_offer_spin.setRange(1, 30)
        self.delay_offer_spin.setValue(8)
        delay_layout.addRow("Offer 后:", self.delay_offer_spin)

        self.delay_add_card_spin = QSpinBox()
        self.delay_add_card_spin.setRange(1, 30)
        self.delay_add_card_spin.setValue(10)
        delay_layout.addRow("添加卡后:", self.delay_add_card_spin)

        self.delay_save_spin = QSpinBox()
        self.delay_save_spin.setRange(1, 60)
        self.delay_save_spin.setValue(18)
        delay_layout.addRow("保存后:", self.delay_save_spin)

        delay_group.setLayout(delay_layout)
        layout.addWidget(delay_group)

        # 其他设置
        other_group = QGroupBox("其他设置")
        other_layout = QFormLayout()

        self.thread_count_spin = QSpinBox()
        self.thread_count_spin.setRange(1, 20)
        self.thread_count_spin.setValue(3)
        other_layout.addRow("默认并发数:", self.thread_count_spin)

        other_group.setLayout(other_layout)
        layout.addWidget(other_group)

        # 代理设置
        proxy_group = QGroupBox("🌐 代理设置")
        proxy_layout = QFormLayout()

        self.proxy_max_windows_spin = QSpinBox()
        self.proxy_max_windows_spin.setRange(1, 100)
        self.proxy_max_windows_spin.setValue(3)
        proxy_layout.addRow("每IP最大窗口数:", self.proxy_max_windows_spin)

        proxy_hint = QLabel("提示: 批量创建窗口时，每个代理IP最多分配给指定数量的窗口")
        proxy_hint.setStyleSheet("color: #666; font-size: 11px;")
        proxy_hint.setWordWrap(True)
        proxy_layout.addRow("", proxy_hint)

        proxy_group.setLayout(proxy_layout)
        layout.addWidget(proxy_group)

        layout.addStretch()

        # 保存按钮
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.btn_save = QPushButton("保存设置")
        self.btn_save.clicked.connect(self.save_settings)
        btn_layout.addWidget(self.btn_save)

        self.btn_reset = QPushButton("恢复默认")
        self.btn_reset.clicked.connect(self.reset_to_default)
        btn_layout.addWidget(self.btn_reset)

        layout.addLayout(btn_layout)

        # 设置滚动区域
        scroll_area.setWidget(scroll_content)
        main_layout.addWidget(scroll_area)

    def _on_provider_changed(self, provider: str):
        """切换默认提供商时切换标签页"""
        if provider == "gemini":
            self.ai_provider_tabs.setCurrentIndex(0)
        elif provider == "anthropic":
            self.ai_provider_tabs.setCurrentIndex(1)

    def _test_provider_connection(self, provider: str):
        """测试指定提供商的连接"""
        if provider == "gemini":
            api_key = self.gemini_api_key_input.text().strip() or ConfigManager.get_ai_provider_api_key("gemini")
            base_url = self.gemini_base_url_input.text().strip() or ConfigManager.get_ai_provider_base_url("gemini")
            model = self.gemini_model_combo.currentText().strip() or ConfigManager.get_ai_provider_model("gemini")
            btn = self.gemini_test_btn
        else:
            api_key = self.anthropic_api_key_input.text().strip() or ConfigManager.get_ai_provider_api_key("anthropic")
            base_url = self.anthropic_base_url_input.text().strip() or ConfigManager.get_ai_provider_base_url("anthropic")
            model = self.anthropic_model_combo.currentText().strip() or ConfigManager.get_ai_provider_model("anthropic")
            btn = self.anthropic_test_btn

        if not api_key:
            QMessageBox.warning(self, "警告", f"请先输入 {provider.upper()} API Key")
            return

        # 禁用按钮，显示进度
        btn.setEnabled(False)
        original_text = btn.text()
        btn.setText("测试中...")

        # 保存当前测试的按钮引用
        self._current_test_btn = btn
        self._current_test_btn_text = original_text
        self._current_test_provider = provider

        # 创建测试线程
        self.test_worker = TestAIConnectionWorker(api_key, base_url, model, provider)
        self.test_worker.finished_signal.connect(self._on_test_connection_finished)
        self.test_worker.start()

    def _on_test_connection_finished(self, success: bool, message: str, details: dict):
        """测试连接完成回调"""
        # 恢复按钮状态
        if hasattr(self, '_current_test_btn') and self._current_test_btn:
            self._current_test_btn.setEnabled(True)
            self._current_test_btn.setText(self._current_test_btn_text)

        provider = getattr(self, '_current_test_provider', 'AI')

        if success:
            # 显示详细信息
            detail_msg = f"连接测试成功!\n\n"
            detail_msg += f"提供商: {details.get('provider', provider).upper()}\n"
            detail_msg += f"模型: {details.get('model', 'N/A')}\n"
            detail_msg += f"响应时间: {details.get('response_time_ms', 0)}ms\n"
            if details.get('response_preview'):
                detail_msg += f"AI 回复: {details.get('response_preview')}\n"
            if details.get('usage'):
                usage = details['usage']
                detail_msg += f"Token 使用: 输入 {usage.get('input_tokens', 0)}, 输出 {usage.get('output_tokens', 0)}\n"
            QMessageBox.information(self, "测试成功", detail_msg)
        else:
            error_msg = f"连接测试失败\n\n{message}"
            if details.get('error_detail'):
                error_msg += f"\n\n详情: {details['error_detail'][:200]}"
            QMessageBox.critical(self, "测试失败", error_msg)

    def load_settings(self):
        """加载设置"""
        try:
            ConfigManager.load()

            # API
            api_key = ConfigManager.get_api_key()
            self.api_key_input.setText(api_key)

            # AI Agent 配置 - 默认提供商
            default_provider = ConfigManager.get_ai_default_provider()
            idx = self.ai_provider_combo.findText(default_provider)
            if idx >= 0:
                self.ai_provider_combo.setCurrentIndex(idx)

            # Gemini 配置
            self.gemini_api_key_input.setText(ConfigManager.get_ai_provider_api_key("gemini"))
            self.gemini_base_url_input.setText(ConfigManager.get_ai_provider_base_url("gemini"))
            gemini_model = ConfigManager.get_ai_provider_model("gemini")
            if gemini_model:
                self.gemini_model_combo.setCurrentText(gemini_model)

            # Anthropic 配置
            self.anthropic_api_key_input.setText(ConfigManager.get_ai_provider_api_key("anthropic"))
            self.anthropic_base_url_input.setText(ConfigManager.get_ai_provider_base_url("anthropic"))
            anthropic_model = ConfigManager.get_ai_provider_model("anthropic")
            if anthropic_model:
                self.anthropic_model_combo.setCurrentText(anthropic_model)

            # 通用配置
            self.ai_max_steps_spin.setValue(ConfigManager.get_ai_max_steps())

            # Gmail IMAP
            gmail_email = ConfigManager.get("gmail_imap_email", "")
            gmail_password = ConfigManager.get_gmail_imap_password()
            self.gmail_email_input.setText(gmail_email)
            self.gmail_password_input.setText(gmail_password)

            # Timeouts
            self.page_load_spin.setValue(ConfigManager.get("timeouts.page_load", 30))
            self.status_check_spin.setValue(ConfigManager.get("timeouts.status_check", 20))
            self.iframe_wait_spin.setValue(ConfigManager.get("timeouts.iframe_wait", 15))

            # Delays
            self.delay_login_spin.setValue(ConfigManager.get("delays.after_login", 3))
            self.delay_offer_spin.setValue(ConfigManager.get("delays.after_offer", 8))
            self.delay_add_card_spin.setValue(ConfigManager.get("delays.after_add_card", 10))
            self.delay_save_spin.setValue(ConfigManager.get("delays.after_save", 18))

            # Other
            self.thread_count_spin.setValue(ConfigManager.get("default_thread_count", 3))

            # Proxy
            self.proxy_max_windows_spin.setValue(ConfigManager.get("proxy.max_windows_per_ip", 3))
        except Exception as e:
            print(f"加载设置失败: {e}")

    def save_settings(self):
        """保存设置"""
        try:
            # API
            ConfigManager.set_api_key(self.api_key_input.text())

            # AI Agent 配置 - 默认提供商
            ConfigManager.set_ai_default_provider(self.ai_provider_combo.currentText())

            # Gemini 配置
            gemini_api_key = self.gemini_api_key_input.text().strip()
            if gemini_api_key:
                ConfigManager.set_ai_provider_api_key("gemini", gemini_api_key)
            ConfigManager.set_ai_provider_base_url("gemini", self.gemini_base_url_input.text().strip())
            ConfigManager.set_ai_provider_model("gemini", self.gemini_model_combo.currentText().strip())

            # Anthropic 配置
            anthropic_api_key = self.anthropic_api_key_input.text().strip()
            if anthropic_api_key:
                ConfigManager.set_ai_provider_api_key("anthropic", anthropic_api_key)
            ConfigManager.set_ai_provider_base_url("anthropic", self.anthropic_base_url_input.text().strip())
            ConfigManager.set_ai_provider_model("anthropic", self.anthropic_model_combo.currentText().strip())

            # 通用配置
            ConfigManager.set_ai_max_steps(self.ai_max_steps_spin.value())

            # Gmail IMAP
            ConfigManager.set("gmail_imap_email", self.gmail_email_input.text().strip())
            ConfigManager.set_gmail_imap_password(self.gmail_password_input.text())

            # Timeouts
            ConfigManager.set("timeouts.page_load", self.page_load_spin.value())
            ConfigManager.set("timeouts.status_check", self.status_check_spin.value())
            ConfigManager.set("timeouts.iframe_wait", self.iframe_wait_spin.value())

            # Delays
            ConfigManager.set("delays.after_login", self.delay_login_spin.value())
            ConfigManager.set("delays.after_offer", self.delay_offer_spin.value())
            ConfigManager.set("delays.after_add_card", self.delay_add_card_spin.value())
            ConfigManager.set("delays.after_save", self.delay_save_spin.value())

            # Other
            ConfigManager.set("default_thread_count", self.thread_count_spin.value())

            # Proxy
            ConfigManager.set("proxy.max_windows_per_ip", self.proxy_max_windows_spin.value())

            ConfigManager.save()
            QMessageBox.information(self, "成功", "设置已保存")
        except Exception as e:
            QMessageBox.warning(self, "错误", f"保存设置失败: {e}")

    def reset_to_default(self):
        """恢复默认设置"""
        reply = QMessageBox.question(
            self, "确认",
            "确定要恢复默认设置吗？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply == QMessageBox.StandardButton.Yes:
            self.api_key_input.setText("")
            # AI Agent - 默认提供商
            self.ai_provider_combo.setCurrentText("gemini")
            # Gemini
            self.gemini_api_key_input.setText("")
            self.gemini_base_url_input.setText("")
            self.gemini_model_combo.setCurrentText("gemini-2.5-flash")
            # Anthropic
            self.anthropic_api_key_input.setText("")
            self.anthropic_base_url_input.setText("")
            self.anthropic_model_combo.setCurrentText("claude-sonnet-4-20250514")
            # 通用
            self.ai_max_steps_spin.setValue(25)
            # Gmail
            self.gmail_email_input.setText("")
            self.gmail_password_input.setText("")
            # Timeouts
            self.page_load_spin.setValue(30)
            self.status_check_spin.setValue(20)
            self.iframe_wait_spin.setValue(15)
            # Delays
            self.delay_login_spin.setValue(3)
            self.delay_offer_spin.setValue(8)
            self.delay_add_card_spin.setValue(10)
            self.delay_save_spin.setValue(18)
            # Other
            self.thread_count_spin.setValue(3)
            # Proxy
            self.proxy_max_windows_spin.setValue(3)

    def _copy_to_clipboard(self, text: str):
        """复制文本到剪贴板"""
        from PyQt6.QtWidgets import QApplication
        clipboard = QApplication.clipboard()
        clipboard.setText(text)
        # 短暂显示复制成功提示
        self.gmail_copy_link_btn.setText("已复制!")
        from PyQt6.QtCore import QTimer
        QTimer.singleShot(1500, lambda: self.gmail_copy_link_btn.setText("复制链接"))


class Sub2APISettingsTab(QWidget):
    """Sub2API 设置标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.login_worker = None
        self.test_worker = None
        self._init_ui()
        self._load_settings()

    def _init_ui(self):
        """初始化界面"""
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(0, 0, 0, 0)

        # 添加滚动区域
        scroll_area = QScrollArea()
        scroll_area.setWidgetResizable(True)
        scroll_area.setFrameShape(QScrollArea.Shape.NoFrame)

        scroll_content = QWidget()
        layout = QVBoxLayout(scroll_content)
        layout.setContentsMargins(10, 10, 10, 10)

        # Sub2API 服务设置
        service_group = QGroupBox("Sub2API 服务设置")
        service_layout = QFormLayout(service_group)

        # 启用开关
        self.enabled_checkbox = QCheckBox("启用 Sub2API 集成")
        service_layout.addRow("", self.enabled_checkbox)

        # 服务地址
        self.base_url_edit = QLineEdit()
        self.base_url_edit.setPlaceholderText("https://sub2api.topren.top")
        service_layout.addRow("服务地址:", self.base_url_edit)

        # API Key
        api_key_layout = QHBoxLayout()
        self.api_key_edit = QLineEdit()
        self.api_key_edit.setPlaceholderText("输入 Admin API Key...")
        self.api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        api_key_layout.addWidget(self.api_key_edit)

        self.show_api_key_btn = QPushButton("👁")
        self.show_api_key_btn.setFixedWidth(30)
        self.show_api_key_btn.setCheckable(True)
        self.show_api_key_btn.clicked.connect(self._toggle_api_key_visibility)
        api_key_layout.addWidget(self.show_api_key_btn)

        service_layout.addRow("API Key:", api_key_layout)

        # 保存 API Key 按钮
        save_key_layout = QHBoxLayout()
        self.save_api_key_btn = QPushButton("💾 保存 API Key")
        self.save_api_key_btn.setStyleSheet("background-color: #4CAF50; color: white; padding: 5px 15px;")
        self.save_api_key_btn.clicked.connect(self._save_api_key)
        save_key_layout.addWidget(self.save_api_key_btn)

        self.api_key_result_label = QLabel("")
        save_key_layout.addWidget(self.api_key_result_label)
        save_key_layout.addStretch()

        service_layout.addRow("", save_key_layout)

        # API Key 状态显示
        key_status_layout = QHBoxLayout()
        self.key_status_label = QLabel("未配置")
        self.key_status_label.setStyleSheet("color: #999;")
        key_status_layout.addWidget(self.key_status_label)

        self.clear_key_btn = QPushButton("清除")
        self.clear_key_btn.setFixedWidth(50)
        self.clear_key_btn.clicked.connect(self._clear_api_key)
        key_status_layout.addWidget(self.clear_key_btn)
        key_status_layout.addStretch()

        service_layout.addRow("Key 状态:", key_status_layout)

        # 默认分组
        self.default_group_edit = QLineEdit()
        self.default_group_edit.setPlaceholderText("claude_share")
        service_layout.addRow("默认分组:", self.default_group_edit)

        # 测试连接按钮
        test_layout = QHBoxLayout()
        self.test_btn = QPushButton("测试连接")
        self.test_btn.clicked.connect(self._test_connection)
        test_layout.addWidget(self.test_btn)

        self.test_result_label = QLabel("")
        test_layout.addWidget(self.test_result_label)
        test_layout.addStretch()

        service_layout.addRow("", test_layout)

        layout.addWidget(service_group)

        # 账号管理设置
        account_group = QGroupBox("账号管理设置")
        account_layout = QFormLayout(account_group)

        # 登录并发数
        self.login_concurrency_spin = QSpinBox()
        self.login_concurrency_spin.setRange(1, 10)
        self.login_concurrency_spin.setValue(3)
        account_layout.addRow("登录并发数:", self.login_concurrency_spin)

        # 登录超时
        self.login_timeout_spin = QSpinBox()
        self.login_timeout_spin.setRange(30, 300)
        self.login_timeout_spin.setSuffix(" 秒")
        self.login_timeout_spin.setValue(120)
        account_layout.addRow("登录超时:", self.login_timeout_spin)

        # OAuth 超时
        self.oauth_timeout_spin = QSpinBox()
        self.oauth_timeout_spin.setRange(60, 600)
        self.oauth_timeout_spin.setSuffix(" 秒")
        self.oauth_timeout_spin.setValue(180)
        account_layout.addRow("OAuth 超时:", self.oauth_timeout_spin)

        layout.addWidget(account_group)

        # ==================== SMS-Bus 接码平台设置 ====================
        sms_group = QGroupBox("SMS-Bus 接码平台设置 (403 解锁用)")
        sms_layout = QFormLayout(sms_group)

        # SMS-Bus API Token
        sms_token_layout = QHBoxLayout()
        self.sms_token_edit = QLineEdit()
        self.sms_token_edit.setPlaceholderText("输入 SMS-Bus API Token...")
        self.sms_token_edit.setEchoMode(QLineEdit.EchoMode.Password)
        sms_token_layout.addWidget(self.sms_token_edit)

        self.show_sms_token_btn = QPushButton("👁")
        self.show_sms_token_btn.setFixedWidth(30)
        self.show_sms_token_btn.setCheckable(True)
        self.show_sms_token_btn.clicked.connect(self._toggle_sms_token_visibility)
        sms_token_layout.addWidget(self.show_sms_token_btn)

        sms_layout.addRow("API Token:", sms_token_layout)

        # 保存 SMS Token 按钮
        save_sms_layout = QHBoxLayout()
        self.save_sms_token_btn = QPushButton("💾 保存 Token")
        self.save_sms_token_btn.setStyleSheet("background-color: #4CAF50; color: white; padding: 5px 15px;")
        self.save_sms_token_btn.clicked.connect(self._save_sms_token)
        save_sms_layout.addWidget(self.save_sms_token_btn)

        self.sms_token_result_label = QLabel("")
        save_sms_layout.addWidget(self.sms_token_result_label)
        save_sms_layout.addStretch()

        sms_layout.addRow("", save_sms_layout)

        # Token 状态显示
        sms_status_layout = QHBoxLayout()
        self.sms_status_label = QLabel("未配置")
        self.sms_status_label.setStyleSheet("color: #999;")
        sms_status_layout.addWidget(self.sms_status_label)

        self.clear_sms_token_btn = QPushButton("清除")
        self.clear_sms_token_btn.setFixedWidth(50)
        self.clear_sms_token_btn.clicked.connect(self._clear_sms_token)
        sms_status_layout.addWidget(self.clear_sms_token_btn)
        sms_status_layout.addStretch()

        sms_layout.addRow("Token 状态:", sms_status_layout)

        # 默认国家 ID
        self.sms_country_spin = QSpinBox()
        self.sms_country_spin.setRange(0, 999)
        self.sms_country_spin.setValue(0)
        self.sms_country_spin.setSpecialValueText("未设置")
        sms_layout.addRow("默认国家 ID:", self.sms_country_spin)

        # 默认服务 ID
        self.sms_project_spin = QSpinBox()
        self.sms_project_spin.setRange(0, 9999)
        self.sms_project_spin.setValue(0)
        self.sms_project_spin.setSpecialValueText("未设置")
        sms_layout.addRow("默认服务 ID:", self.sms_project_spin)

        # 验证码等待超时
        self.sms_timeout_spin = QSpinBox()
        self.sms_timeout_spin.setRange(30, 600)
        self.sms_timeout_spin.setSuffix(" 秒")
        self.sms_timeout_spin.setValue(120)
        sms_layout.addRow("验证码等待超时:", self.sms_timeout_spin)

        # 轮询间隔
        self.sms_poll_spin = QSpinBox()
        self.sms_poll_spin.setRange(1, 30)
        self.sms_poll_spin.setSuffix(" 秒")
        self.sms_poll_spin.setValue(5)
        sms_layout.addRow("轮询间隔:", self.sms_poll_spin)

        # 总尝试次数
        self.sms_retries_spin = QSpinBox()
        self.sms_retries_spin.setRange(1, 10)
        self.sms_retries_spin.setValue(2)
        sms_layout.addRow("总尝试次数:", self.sms_retries_spin)

        layout.addWidget(sms_group)

        # 按钮区
        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        self.save_btn = QPushButton("保存设置")
        self.save_btn.clicked.connect(self._save_settings)
        btn_layout.addWidget(self.save_btn)

        self.reset_btn = QPushButton("恢复默认")
        self.reset_btn.clicked.connect(self._reset_to_default)
        btn_layout.addWidget(self.reset_btn)

        layout.addLayout(btn_layout)

        layout.addStretch()

        # 完成滚动区域设置
        scroll_area.setWidget(scroll_content)
        main_layout.addWidget(scroll_area)

    def _toggle_api_key_visibility(self):
        """切换 API Key 可见性"""
        if self.show_api_key_btn.isChecked():
            self.api_key_edit.setEchoMode(QLineEdit.EchoMode.Normal)
        else:
            self.api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)

    def _update_api_key_status(self):
        """更新 API Key 状态显示"""
        ConfigManager.reload()
        api_key = ConfigManager.get_sub2api_token()
        if api_key:
            masked = api_key[:8] + "..." + api_key[-4:] if len(api_key) > 12 else "***"
            self.key_status_label.setText(f"已配置 ({masked})")
            self.key_status_label.setStyleSheet("color: green; font-weight: bold;")
        else:
            self.key_status_label.setText("未配置")
            self.key_status_label.setStyleSheet("color: #999;")

    def _save_api_key(self):
        """保存 API Key"""
        api_key = self.api_key_edit.text().strip()
        if not api_key:
            QMessageBox.warning(self, "警告", "请输入 API Key")
            return

        ConfigManager.set_sub2api_token(api_key)
        ConfigManager.reload()

        saved_key = ConfigManager.get_sub2api_token()
        if saved_key:
            self._update_api_key_status()
            self.api_key_edit.clear()
            self.api_key_result_label.setText("✅ 已保存")
            self.api_key_result_label.setStyleSheet("color: green;")
        else:
            self.api_key_result_label.setText("❌ 保存失败")
            self.api_key_result_label.setStyleSheet("color: red;")

    def _clear_api_key(self):
        """清除 API Key"""
        ConfigManager.set_sub2api_token("")
        self._update_api_key_status()
        self.api_key_result_label.setText("已清除")
        self.api_key_result_label.setStyleSheet("color: #666;")

    # ==================== SMS-Bus Token 方法 ====================

    def _toggle_sms_token_visibility(self):
        """切换 SMS Token 可见性"""
        if self.show_sms_token_btn.isChecked():
            self.sms_token_edit.setEchoMode(QLineEdit.EchoMode.Normal)
        else:
            self.sms_token_edit.setEchoMode(QLineEdit.EchoMode.Password)

    def _update_sms_token_status(self):
        """更新 SMS Token 状态显示"""
        ConfigManager.reload()
        token = ConfigManager.get_sms_bus_token()
        if token:
            masked = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
            self.sms_status_label.setText(f"已配置 ({masked})")
            self.sms_status_label.setStyleSheet("color: green; font-weight: bold;")
        else:
            self.sms_status_label.setText("未配置")
            self.sms_status_label.setStyleSheet("color: #999;")

    def _save_sms_token(self):
        """保存 SMS Token"""
        token = self.sms_token_edit.text().strip()
        if not token:
            QMessageBox.warning(self, "警告", "请输入 SMS-Bus API Token")
            return

        ConfigManager.set_sms_bus_token(token)
        ConfigManager.reload()

        saved_token = ConfigManager.get_sms_bus_token()
        if saved_token:
            self._update_sms_token_status()
            self.sms_token_edit.clear()
            self.sms_token_result_label.setText("✅ 已保存")
            self.sms_token_result_label.setStyleSheet("color: green;")
        else:
            self.sms_token_result_label.setText("❌ 保存失败")
            self.sms_token_result_label.setStyleSheet("color: red;")

    def _clear_sms_token(self):
        """清除 SMS Token"""
        ConfigManager.set_sms_bus_token("")
        self._update_sms_token_status()
        self.sms_token_result_label.setText("已清除")
        self.sms_token_result_label.setStyleSheet("color: #666;")

    def _load_settings(self):
        """加载设置"""
        self.enabled_checkbox.setChecked(ConfigManager.get_sub2api_enabled())
        self.base_url_edit.setText(ConfigManager.get_sub2api_base_url())
        self.default_group_edit.setText(ConfigManager.get_sub2api_default_group())

        self.login_concurrency_spin.setValue(ConfigManager.get_login_concurrency())
        self.login_timeout_spin.setValue(ConfigManager.get_login_timeout())
        self.oauth_timeout_spin.setValue(ConfigManager.get_oauth_timeout())

        self._update_api_key_status()

        # 加载 SMS-Bus 设置
        self._update_sms_token_status()
        country_id = ConfigManager.get_sms_bus_default_country_id()
        self.sms_country_spin.setValue(country_id if country_id else 0)
        project_id = ConfigManager.get_sms_bus_default_project_id()
        self.sms_project_spin.setValue(project_id if project_id else 0)
        self.sms_timeout_spin.setValue(ConfigManager.get_sms_bus_timeout())
        self.sms_poll_spin.setValue(ConfigManager.get_sms_bus_poll_interval())
        self.sms_retries_spin.setValue(ConfigManager.get_sms_bus_max_retries())

    def _save_settings(self):
        """保存设置"""
        try:
            ConfigManager.set_sub2api_enabled(self.enabled_checkbox.isChecked())
            ConfigManager.set_sub2api_base_url(self.base_url_edit.text().strip())
            ConfigManager.set_sub2api_default_group(self.default_group_edit.text().strip())

            ConfigManager.set_login_concurrency(self.login_concurrency_spin.value())
            ConfigManager.set_login_timeout(self.login_timeout_spin.value())
            ConfigManager.set_oauth_timeout(self.oauth_timeout_spin.value())

            # 保存 SMS-Bus 设置
            country_val = self.sms_country_spin.value()
            # 0 表示"未设置"，存储为 None
            ConfigManager.set_sms_bus_default_country_id(country_val if country_val > 0 else None)
            project_val = self.sms_project_spin.value()
            ConfigManager.set_sms_bus_default_project_id(project_val if project_val > 0 else None)
            ConfigManager.set_sms_bus_timeout(self.sms_timeout_spin.value())
            ConfigManager.set_sms_bus_poll_interval(self.sms_poll_spin.value())
            ConfigManager.set_sms_bus_max_retries(self.sms_retries_spin.value())

            QMessageBox.information(self, "成功", "设置已保存")
        except Exception as e:
            QMessageBox.critical(self, "错误", f"保存失败: {str(e)}")

    def _reset_to_default(self):
        """恢复默认设置"""
        reply = QMessageBox.question(
            self, "确认",
            "确定要恢复默认设置吗？这不会清除已保存的 Token。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No
        )
        if reply != QMessageBox.StandardButton.Yes:
            return

        self.enabled_checkbox.setChecked(True)
        self.base_url_edit.setText("https://sub2api.topren.top")
        self.default_group_edit.setText("claude_share")

        self.login_concurrency_spin.setValue(3)
        self.login_timeout_spin.setValue(120)
        self.oauth_timeout_spin.setValue(180)

        self.api_key_result_label.setText("")

        # 重置 SMS-Bus 设置
        self.sms_country_spin.setValue(0)
        self.sms_project_spin.setValue(0)
        self.sms_timeout_spin.setValue(120)
        self.sms_poll_spin.setValue(5)
        self.sms_retries_spin.setValue(2)
        self.sms_token_result_label.setText("")

    def _test_connection(self):
        """测试 Sub2API 连接"""
        import asyncio

        self.test_btn.setEnabled(False)
        self.test_result_label.setText("测试中...")

        base_url = self.base_url_edit.text().strip()
        # 如果 base_url 为空，使用默认值
        if not base_url:
            base_url = "https://sub2api.topren.top"
            self.base_url_edit.setText(base_url)

        # 强制重新加载配置，确保读取最新的 API Key
        ConfigManager.reload()
        api_key = ConfigManager.get_sub2api_token()

        # 如果没有 API Key，给出警告
        if not api_key:
            self.test_result_label.setText("⚠️ 请先配置 API Key")
            self.test_result_label.setStyleSheet("color: orange;")
            self.test_btn.setEnabled(True)
            return

        from PyQt6.QtCore import QThread

        class TestWorker(QThread):
            finished = pyqtSignal(bool, str)

            def __init__(self, base_url, api_key):
                super().__init__()
                self.base_url = base_url
                self.api_key = api_key

            def run(self):
                try:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)

                    try:
                        from services.sub2api_client import test_sub2api_connection
                        success, message = loop.run_until_complete(
                            test_sub2api_connection(self.base_url, self.api_key)
                        )
                        self.finished.emit(success, message)
                    finally:
                        loop.close()

                except Exception as e:
                    self.finished.emit(False, str(e))

        def on_test_finished(success, message):
            self.test_btn.setEnabled(True)
            if success:
                self.test_result_label.setText("✅ " + message)
                self.test_result_label.setStyleSheet("color: green;")
            else:
                self.test_result_label.setText("❌ " + message)
                self.test_result_label.setStyleSheet("color: red;")

        self.test_worker = TestWorker(base_url, api_key)
        self.test_worker.finished.connect(on_test_finished)
        self.test_worker.start()


class ConfigManagerWidget(QWidget):
    """配置管理主容器"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._init_ui()

    def _init_ui(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        # 标题
        title = QLabel("配置管理")
        title.setFont(QFont("", 14, QFont.Weight.Bold))
        layout.addWidget(title)

        # 子标签页
        self.tabs = QTabWidget()
        self.tabs.addTab(AccountsTab(), "账号管理")
        self.tabs.addTab(CardsTab(), "卡片管理")
        self.tabs.addTab(ProxiesTab(), "代理管理")
        self.tabs.addTab(SettingsTab(), "全局设置")
        self.tabs.addTab(Sub2APISettingsTab(), "Sub2API 设置")

        layout.addWidget(self.tabs)
