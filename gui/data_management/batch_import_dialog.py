"""
批量导入对话框 - Fluent Design 版本
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QVBoxLayout, QHBoxLayout, QWidget
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    MessageBoxBase, SubtitleLabel, BodyLabel, CaptionLabel,
    TextEdit, TableWidget, PrimaryPushButton, PushButton,
    InfoBar, InfoBarPosition, FluentIcon as FIF, CardWidget,
)
from qfluentwidgets import TableItemDelegate

from services.database import DBManager
from services.data_store import get_data_store, CardInfo, ProxyInfo


class BatchImportDialog(MessageBoxBase):
    """批量导入对话框基类"""

    def __init__(self, parent, title: str, format_hint: str, columns: list[str]):
        super().__init__(parent)

        self.columns = columns
        self.parsed_data = []

        # 设置对话框大小
        self.widget.setMinimumWidth(700)
        self.widget.setMinimumHeight(500)

        # 标题
        self.titleLabel = SubtitleLabel(title, self.widget)
        self.viewLayout.addWidget(self.titleLabel)

        # 格式提示卡片
        hintCard = CardWidget(self.widget)
        hintLayout = QHBoxLayout(hintCard)
        hintLayout.setContentsMargins(16, 12, 16, 12)
        hintLabel = CaptionLabel(f"格式: {format_hint}", hintCard)
        hintLabel.setWordWrap(True)
        hintLayout.addWidget(hintLabel)
        self.viewLayout.addWidget(hintCard)

        # 输入区域
        inputLabel = BodyLabel("请粘贴数据（每行一条记录）:", self.widget)
        self.viewLayout.addWidget(inputLabel)

        self.textInput = TextEdit(self.widget)
        self.textInput.setPlaceholderText("在此粘贴数据...")
        self.textInput.setMaximumHeight(120)
        self.textInput.textChanged.connect(self._onTextChanged)
        self.viewLayout.addWidget(self.textInput)

        # 预览表格
        previewLabel = BodyLabel("解析预览:", self.widget)
        self.viewLayout.addWidget(previewLabel)

        self.previewTable = TableWidget(self.widget)
        self.previewTable.setColumnCount(len(columns) + 2)
        self.previewTable.setHorizontalHeaderLabels(["#"] + columns + ["状态"])
        self.previewTable.horizontalHeader().setStretchLastSection(True)
        self.previewTable.setMinimumHeight(200)
        self.viewLayout.addWidget(self.previewTable)

        # 统计信息
        self.statsLabel = CaptionLabel("有效: 0 | 无效: 0", self.widget)
        self.viewLayout.addWidget(self.statsLabel)

        # 按钮
        self.yesButton.setText("导入")
        self.cancelButton.setText("取消")

    def parse_line(self, line: str) -> tuple[bool, dict, str]:
        """解析单行数据（子类实现）"""
        raise NotImplementedError("子类必须实现 parse_line 方法")

    def save_record(self, data: dict) -> bool:
        """保存单条记录（子类实现）"""
        raise NotImplementedError("子类必须实现 save_record 方法")

    def format_preview_row(self, data: dict) -> list[str]:
        """格式化预览行"""
        return [str(data.get(col, '')) for col in self.columns]

    def _onTextChanged(self):
        """文本变化时更新预览"""
        text = self.textInput.toPlainText()
        lines = [line.strip() for line in text.split('\n')
                 if line.strip() and not line.strip().startswith('#')]

        self.parsed_data = []
        self.previewTable.setRowCount(0)

        valid_count = 0
        invalid_count = 0

        for i, line in enumerate(lines):
            success, data, error = self.parse_line(line)

            row = self.previewTable.rowCount()
            self.previewTable.insertRow(row)

            # 序号
            from qfluentwidgets import TableWidget
            from PyQt6.QtWidgets import QTableWidgetItem
            self.previewTable.setItem(row, 0, QTableWidgetItem(str(i + 1)))

            if success:
                self.parsed_data.append(data)
                preview_values = self.format_preview_row(data)
                for col, value in enumerate(preview_values):
                    self.previewTable.setItem(row, col + 1, QTableWidgetItem(value))
                status_item = QTableWidgetItem("✓")
                status_item.setForeground(QColor("#4caf50"))
                self.previewTable.setItem(row, len(self.columns) + 1, status_item)
                valid_count += 1
            else:
                display_line = line[:50] + "..." if len(line) > 50 else line
                self.previewTable.setItem(row, 1, QTableWidgetItem(display_line))
                status_item = QTableWidgetItem(f"✗ {error}")
                status_item.setForeground(QColor("#f44336"))
                self.previewTable.setItem(row, len(self.columns) + 1, status_item)
                invalid_count += 1

        self.statsLabel.setText(f"有效: {valid_count} | 无效: {invalid_count}")

    def _validateInputs(self) -> bool:
        """验证输入"""
        if not self.parsed_data:
            InfoBar.warning(
                title="提示",
                content="没有可导入的有效数据",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self.parent()
            )
            return False

        # 执行导入
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

        InfoBar.success(
            title="导入完成",
            content=f"成功导入 {success_count} 条记录" + (f"，失败 {fail_count} 条" if fail_count > 0 else ""),
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=3000,
            parent=self.parent()
        )

        return True


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
            "******",
            data.get('recovery_email', ''),
            data.get('secret_key', '')[:8] + "..." if len(data.get('secret_key', '')) > 8 else data.get('secret_key', '')
        ]

    def save_record(self, data: dict) -> bool:
        existing = DBManager.get_account_by_email(data['email'])
        if existing:
            recovery = data.get('recovery_email')
            secret = data.get('secret_key')
            DBManager.upsert_account(
                email=data['email'],
                password=data.get('password'),
                recovery_email=recovery if recovery else None,
                secret_key=secret if secret else None,
            )
        else:
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
            format_hint="卡号----月份----年份----CVV----姓名----邮编 （后两项可选）",
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

        if not number.isdigit() or not (13 <= len(number) <= 19):
            return False, {}, "卡号格式无效"

        if not exp_month.isdigit() or not (1 <= int(exp_month) <= 12):
            return False, {}, "月份无效"

        if not exp_year.isdigit() or len(exp_year) not in (2, 4):
            return False, {}, "年份无效"

        if not cvv.isdigit() or len(cvv) not in (3, 4):
            return False, {}, "CVV无效"

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

        if not host:
            return False, {}, "主机不能为空"

        if not port.isdigit():
            return False, {}, "端口必须是数字"

        return True, {
            'proxy_type': 'socks5',
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
