"""
账号管理标签页 - Fluent Design 版本
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QTableWidgetItem, QFileDialog,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    TableWidget, PrimaryPushButton, PushButton, TransparentPushButton,
    SearchLineEdit, BodyLabel, CaptionLabel, CardWidget,
    MessageBox, InfoBar, InfoBarPosition, FluentIcon as FIF,
    CheckBox, LineEdit,
)

from services.database import DBManager
from services.ix_api import closeBrowser, deleteBrowser
from services.ix_window import find_browser_by_email


class AccountEditDialog(MessageBox):
    """账号编辑对话框"""

    def __init__(self, parent, data=None):
        title = "编辑账号" if data else "添加账号"
        super().__init__(title, "", parent)

        self.data = data

        # 移除默认内容标签
        self.textLayout.removeWidget(self.contentLabel)
        self.contentLabel.hide()

        # 创建表单
        formWidget = QWidget()
        formLayout = QFormLayout(formWidget)
        formLayout.setContentsMargins(0, 0, 0, 0)
        formLayout.setSpacing(12)

        self.emailInput = LineEdit()
        self.emailInput.setPlaceholderText("example@gmail.com")
        if data:
            self.emailInput.setText(data.get('email', ''))
            self.emailInput.setReadOnly(True)
        formLayout.addRow("邮箱:", self.emailInput)

        self.passwordInput = LineEdit()
        self.passwordInput.setPlaceholderText("密码")
        if data:
            self.passwordInput.setText(data.get('password', ''))
        formLayout.addRow("密码:", self.passwordInput)

        self.recoveryInput = LineEdit()
        self.recoveryInput.setPlaceholderText("辅助邮箱（可选）")
        if data:
            self.recoveryInput.setText(data.get('recovery_email', ''))
        formLayout.addRow("辅助邮箱:", self.recoveryInput)

        self.secretInput = LineEdit()
        self.secretInput.setPlaceholderText("2FA密钥（可选）")
        if data:
            self.secretInput.setText(data.get('secret_key', ''))
        formLayout.addRow("2FA密钥:", self.secretInput)

        self.textLayout.addWidget(formWidget)
        self.widget.setMinimumWidth(400)

    def get_data(self):
        return {
            'email': self.emailInput.text().strip(),
            'password': self.passwordInput.text(),
            'recovery_email': self.recoveryInput.text().strip(),
            'secret_key': self.secretInput.text().strip()
        }


class AccountsTab(QWidget):
    """账号管理标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._allAccounts = []
        self._initUI()
        self.loadData()

    def _initUI(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(12)

        # 工具栏卡片
        toolbarCard = CardWidget(self)
        toolbarLayout = QHBoxLayout(toolbarCard)
        toolbarLayout.setContentsMargins(16, 12, 16, 12)

        # 全选复选框
        self.headerCheckbox = CheckBox()
        self.headerCheckbox.setToolTip("全选/取消全选可见账号")
        self.headerCheckbox.stateChanged.connect(self._toggleAllCheckboxes)
        toolbarLayout.addWidget(self.headerCheckbox)

        self.btnAdd = PrimaryPushButton(FIF.ADD, "添加账号", self)
        self.btnAdd.clicked.connect(self.addAccount)
        toolbarLayout.addWidget(self.btnAdd)

        self.btnBatchImport = PushButton(FIF.DOWNLOAD, "批量导入", self)
        self.btnBatchImport.clicked.connect(self.batchImport)
        toolbarLayout.addWidget(self.btnBatchImport)

        self.btnDelete = PushButton(FIF.DELETE, "删除选中", self)
        self.btnDelete.clicked.connect(self.deleteSelected)
        toolbarLayout.addWidget(self.btnDelete)

        self.btnExport = PushButton(FIF.UP, "导出选中", self)
        self.btnExport.clicked.connect(self.exportSelected)
        toolbarLayout.addWidget(self.btnExport)

        self.btnRefresh = TransparentPushButton(FIF.SYNC, "刷新", self)
        self.btnRefresh.clicked.connect(self.loadData)
        toolbarLayout.addWidget(self.btnRefresh)

        toolbarLayout.addStretch()

        # 搜索框
        self.searchInput = SearchLineEdit()
        self.searchInput.setPlaceholderText("搜索邮箱...")
        self.searchInput.setFixedWidth(200)
        self.searchInput.textChanged.connect(self._filterTable)
        toolbarLayout.addWidget(self.searchInput)

        self.countLabel = CaptionLabel("共 0 个账号", self)
        toolbarLayout.addWidget(self.countLabel)

        layout.addWidget(toolbarCard)

        # 表格
        self.table = TableWidget(self)
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["", "邮箱", "密码", "辅助邮箱", "2FA密钥", "状态", "操作"])

        # 设置列宽和自适应模式 - 与旧版一致
        header = self.table.horizontalHeader()
        header.setStretchLastSection(False)

        # 列0: 复选框 - 固定40px
        header.setSectionResizeMode(0, header.ResizeMode.Fixed)
        self.table.setColumnWidth(0, 40)

        # 列1: 邮箱 - 自适应拉伸（主列）
        header.setSectionResizeMode(1, header.ResizeMode.Stretch)

        # 列2-5: 密码、辅助邮箱、2FA密钥、状态 - 根据内容自适应
        header.setSectionResizeMode(2, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(4, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(5, header.ResizeMode.ResizeToContents)

        # 列6: 操作 - 根据内容自适应（确保按钮完整显示）
        header.setSectionResizeMode(6, header.ResizeMode.ResizeToContents)

        self.table.setSelectionBehavior(TableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def _createCheckboxWidget(self) -> QWidget:
        """创建居中的复选框组件"""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        checkbox = CheckBox()
        layout.addWidget(checkbox)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.setContentsMargins(0, 0, 0, 0)
        return widget

    def _getCheckbox(self, row: int) -> CheckBox:
        """获取指定行的复选框"""
        widget = self.table.cellWidget(row, 0)
        if widget:
            return widget.findChild(CheckBox)
        return None

    def _toggleAllCheckboxes(self, state: int):
        """全选/取消全选"""
        checked = state == Qt.CheckState.Checked.value
        for row in range(self.table.rowCount()):
            if not self.table.isRowHidden(row):
                checkbox = self._getCheckbox(row)
                if checkbox:
                    checkbox.setChecked(checked)

    def _getSelectedRows(self) -> list:
        """获取所有勾选的可见行号"""
        selected = []
        for row in range(self.table.rowCount()):
            if not self.table.isRowHidden(row):
                checkbox = self._getCheckbox(row)
                if checkbox and checkbox.isChecked():
                    selected.append(row)
        return selected

    def _filterTable(self, searchText: str):
        """实时过滤表格"""
        searchText = searchText.lower().strip()
        visibleCount = 0

        for row in range(self.table.rowCount()):
            emailItem = self.table.item(row, 1)
            if emailItem:
                email = emailItem.text().lower()
                match = searchText in email if searchText else True
                self.table.setRowHidden(row, not match)
                if match:
                    visibleCount += 1
                else:
                    checkbox = self._getCheckbox(row)
                    if checkbox:
                        checkbox.setChecked(False)

        self.headerCheckbox.blockSignals(True)
        self.headerCheckbox.setChecked(False)
        self.headerCheckbox.blockSignals(False)

        total = self.table.rowCount()
        if searchText:
            self.countLabel.setText(f"显示 {visibleCount}/{total} 个账号")
        else:
            self.countLabel.setText(f"共 {total} 个账号")

    def loadData(self):
        """加载账号数据"""
        try:
            DBManager.init_db()
            accounts = DBManager.get_all_accounts()
            self._allAccounts = accounts

            self.table.setRowCount(0)
            for acc in accounts:
                row = self.table.rowCount()
                self.table.insertRow(row)

                # 复选框
                self.table.setCellWidget(row, 0, self._createCheckboxWidget())

                self.table.setItem(row, 1, QTableWidgetItem(acc.get('email', '')))
                self.table.setItem(row, 2, QTableWidgetItem(acc.get('password', '')))
                self.table.setItem(row, 3, QTableWidgetItem(acc.get('recovery_email', '')))
                self.table.setItem(row, 4, QTableWidgetItem(acc.get('secret_key', '')))

                statusItem = QTableWidgetItem(acc.get('status', ''))
                status = acc.get('status', '')
                if status == 'subscribed':
                    statusItem.setForeground(QColor("#4caf50"))
                elif status == 'verified':
                    statusItem.setForeground(QColor("#2196f3"))
                elif status == 'error':
                    statusItem.setForeground(QColor("#f44336"))
                self.table.setItem(row, 5, statusItem)

                # 编辑按钮
                btnEdit = TransparentPushButton(FIF.EDIT, "编辑", self)
                btnEdit.setFixedWidth(85)
                btnEdit.clicked.connect(lambda checked, r=row: self.editAccount(r))
                self.table.setCellWidget(row, 6, btnEdit)

            self.countLabel.setText(f"共 {len(accounts)} 个账号")

            self.headerCheckbox.blockSignals(True)
            self.headerCheckbox.setChecked(False)
            self.headerCheckbox.blockSignals(False)

            if self.searchInput.text():
                self._filterTable(self.searchInput.text())

        except Exception as e:
            InfoBar.error(
                title="错误",
                content=f"加载账号失败: {e}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def addAccount(self):
        """添加新账号"""
        dialog = AccountEditDialog(self)
        if dialog.exec():
            data = dialog.get_data()
            if not data['email'] or '@' not in data['email']:
                InfoBar.warning(
                    title="验证失败",
                    content="请输入有效的邮箱地址",
                    orient=Qt.Orientation.Horizontal,
                    isClosable=True,
                    position=InfoBarPosition.TOP,
                    duration=2000,
                    parent=self
                )
                return
            DBManager.upsert_account(
                email=data['email'],
                password=data['password'],
                recovery_email=data['recovery_email'],
                secret_key=data['secret_key'],
                status='pending'
            )
            self.loadData()
            InfoBar.success(
                title="成功",
                content="账号已添加",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def editAccount(self, row: int):
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
        if dialog.exec():
            data = dialog.get_data()
            DBManager.upsert_account(
                email=data['email'],
                password=data['password'],
                recovery_email=data['recovery_email'],
                secret_key=data['secret_key']
            )
            self.loadData()

    def deleteSelected(self):
        """删除选中账号"""
        rows = self._getSelectedRows()
        if not rows:
            InfoBar.info(
                title="提示",
                content="请先勾选要删除的账号",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return

        w = MessageBox(
            "确认删除",
            f"确定要删除选中的 {len(rows)} 个账号吗？\n将同时删除对应的 ixBrowser 窗口。",
            self
        )
        if w.exec():
            deletedAccounts = 0
            deletedWindows = 0

            for row in sorted(rows, reverse=True):
                email = self.table.item(row, 1).text()

                try:
                    profile_id = find_browser_by_email(email)
                    if profile_id:
                        try:
                            closeBrowser(profile_id)
                        except Exception:
                            pass
                        try:
                            result = deleteBrowser(profile_id)
                            if result.get('success'):
                                deletedWindows += 1
                        except Exception:
                            pass
                except Exception:
                    pass

                DBManager.delete_account(email)
                deletedAccounts += 1

            self.loadData()
            InfoBar.success(
                title="删除完成",
                content=f"已删除 {deletedAccounts} 个账号" + (f"，{deletedWindows} 个窗口" if deletedWindows > 0 else ""),
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def exportSelected(self):
        """导出选中账号"""
        rows = self._getSelectedRows()
        if not rows:
            InfoBar.info(
                title="提示",
                content="请先勾选要导出的账号",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return

        filePath, _ = QFileDialog.getSaveFileName(
            self, "导出账号", "accounts_export.txt", "文本文件 (*.txt)"
        )
        if not filePath:
            return

        try:
            with open(filePath, 'w', encoding='utf-8') as f:
                f.write('分隔符="----"\n')
                for row in rows:
                    email = self.table.item(row, 1).text()
                    password = self.table.item(row, 2).text()
                    recovery = self.table.item(row, 3).text()
                    secret = self.table.item(row, 4).text()
                    line = f"{email}----{password}----{recovery}----{secret}\n"
                    f.write(line)

            InfoBar.success(
                title="导出成功",
                content=f"已导出 {len(rows)} 个账号到: {filePath}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )
        except Exception as e:
            InfoBar.error(
                title="导出失败",
                content=str(e),
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def batchImport(self):
        """批量导入账号"""
        from gui.data_management.batch_import_dialog import AccountBatchImportDialog
        dialog = AccountBatchImportDialog(self)
        if dialog.exec():
            self.loadData()
