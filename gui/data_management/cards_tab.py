"""
卡片管理标签页 - Fluent Design 版本
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QTableWidgetItem,
)

from qfluentwidgets import (
    TableWidget, PrimaryPushButton, PushButton, TransparentPushButton,
    BodyLabel, CaptionLabel, CardWidget,
    MessageBox, InfoBar, InfoBarPosition, FluentIcon as FIF,
    LineEdit,
)

from services.data_store import get_data_store, CardInfo


class CardEditDialog(MessageBox):
    """卡片编辑对话框"""

    def __init__(self, parent, data=None):
        title = "编辑卡片" if data else "添加卡片"
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

        self.numberInput = LineEdit()
        self.numberInput.setPlaceholderText("4111111111111111")
        if data:
            self.numberInput.setText(data.get('number', ''))
        formLayout.addRow("卡号:", self.numberInput)

        # 有效期
        expWidget = QWidget()
        expLayout = QHBoxLayout(expWidget)
        expLayout.setContentsMargins(0, 0, 0, 0)
        self.monthInput = LineEdit()
        self.monthInput.setPlaceholderText("MM")
        self.monthInput.setFixedWidth(60)
        if data:
            self.monthInput.setText(data.get('exp_month', ''))
        expLayout.addWidget(self.monthInput)
        expLayout.addWidget(BodyLabel("/"))
        self.yearInput = LineEdit()
        self.yearInput.setPlaceholderText("YY")
        self.yearInput.setFixedWidth(60)
        if data:
            self.yearInput.setText(data.get('exp_year', ''))
        expLayout.addWidget(self.yearInput)
        expLayout.addStretch()
        formLayout.addRow("有效期:", expWidget)

        self.cvvInput = LineEdit()
        self.cvvInput.setPlaceholderText("123")
        self.cvvInput.setFixedWidth(80)
        if data:
            self.cvvInput.setText(data.get('cvv', ''))
        formLayout.addRow("CVV:", self.cvvInput)

        self.nameInput = LineEdit()
        self.nameInput.setPlaceholderText("John Smith")
        if data:
            self.nameInput.setText(data.get('name', 'John Smith'))
        else:
            self.nameInput.setText("John Smith")
        formLayout.addRow("持卡人姓名:", self.nameInput)

        self.zipInput = LineEdit()
        self.zipInput.setPlaceholderText("10001")
        if data:
            self.zipInput.setText(data.get('zip_code', '10001'))
        else:
            self.zipInput.setText("10001")
        formLayout.addRow("邮编:", self.zipInput)

        self.textLayout.addWidget(formWidget)
        self.widget.setMinimumWidth(400)

    def get_data(self):
        month = self.monthInput.text().strip()
        year = self.yearInput.text().strip()

        if len(month) == 1:
            month = f"0{month}"
        if len(year) == 4:
            year = year[-2:]

        return {
            'number': self.numberInput.text().strip(),
            'exp_month': month,
            'exp_year': year,
            'cvv': self.cvvInput.text().strip(),
            'name': self.nameInput.text().strip() or "John Smith",
            'zip_code': self.zipInput.text().strip() or "10001"
        }


class CardsTab(QWidget):
    """卡片管理标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.dataStore = get_data_store()
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

        self.btnAdd = PrimaryPushButton(FIF.ADD, "添加卡片", self)
        self.btnAdd.clicked.connect(self.addCard)
        toolbarLayout.addWidget(self.btnAdd)

        self.btnBatchImport = PushButton(FIF.DOWNLOAD, "批量导入", self)
        self.btnBatchImport.clicked.connect(self.batchImport)
        toolbarLayout.addWidget(self.btnBatchImport)

        self.btnDelete = PushButton(FIF.DELETE, "删除选中", self)
        self.btnDelete.clicked.connect(self.deleteSelected)
        toolbarLayout.addWidget(self.btnDelete)

        self.btnRefresh = TransparentPushButton(FIF.SYNC, "刷新", self)
        self.btnRefresh.clicked.connect(self.loadData)
        toolbarLayout.addWidget(self.btnRefresh)

        toolbarLayout.addStretch()

        self.countLabel = CaptionLabel("共 0 张卡片", self)
        toolbarLayout.addWidget(self.countLabel)

        layout.addWidget(toolbarCard)

        # 表格
        self.table = TableWidget(self)
        self.table.setColumnCount(6)
        self.table.setHorizontalHeaderLabels(["卡号", "有效期", "CVV", "姓名", "邮编", "操作"])

        # 设置列宽和自适应模式
        header = self.table.horizontalHeader()
        header.setStretchLastSection(False)

        # 列0: 卡号 - 自适应拉伸（主列）
        header.setSectionResizeMode(0, header.ResizeMode.Stretch)

        # 列1-4: 有效期、CVV、姓名、邮编 - 根据内容自适应
        header.setSectionResizeMode(1, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(4, header.ResizeMode.ResizeToContents)

        # 列5: 操作 - 根据内容自适应（确保按钮完整显示）
        header.setSectionResizeMode(5, header.ResizeMode.ResizeToContents)

        self.table.setSelectionBehavior(TableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def loadData(self):
        """加载卡片数据"""
        try:
            self.dataStore.reload()
            cards = self.dataStore.get_cards()

            self.table.setRowCount(0)
            for card in cards:
                row = self.table.rowCount()
                self.table.insertRow(row)

                self.table.setItem(row, 0, QTableWidgetItem(card.get_masked_number()))
                self.table.setItem(row, 1, QTableWidgetItem(f"{card.exp_month}/{card.exp_year}"))
                self.table.setItem(row, 2, QTableWidgetItem("***"))
                self.table.setItem(row, 3, QTableWidgetItem(card.name))
                self.table.setItem(row, 4, QTableWidgetItem(card.zip_code))

                btnEdit = TransparentPushButton(FIF.EDIT, "编辑", self)
                btnEdit.setFixedWidth(85)
                btnEdit.clicked.connect(lambda checked, r=row: self.editCard(r))
                self.table.setCellWidget(row, 5, btnEdit)

            self.countLabel.setText(f"共 {len(cards)} 张卡片")

        except Exception as e:
            InfoBar.error(
                title="错误",
                content=f"加载卡片失败: {e}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def addCard(self):
        """添加新卡片"""
        dialog = CardEditDialog(self)
        if dialog.exec():
            data = dialog.get_data()
            # 验证卡号
            if not data['number'] or len(data['number']) < 13:
                InfoBar.warning(
                    title="验证失败",
                    content="请输入有效的卡号",
                    orient=Qt.Orientation.Horizontal,
                    isClosable=True,
                    position=InfoBarPosition.TOP,
                    duration=2000,
                    parent=self
                )
                return
            self.dataStore.add_card(CardInfo(**data))
            self.loadData()
            InfoBar.success(
                title="成功",
                content="卡片已添加",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def editCard(self, row: int):
        """编辑卡片"""
        cards = self.dataStore.get_cards()
        if row >= len(cards):
            return

        card = cards[row]
        dialog = CardEditDialog(self, card.to_dict())
        if dialog.exec():
            data = dialog.get_data()
            self.dataStore.update_card(row, CardInfo(**data))
            self.loadData()

    def deleteSelected(self):
        """删除选中卡片"""
        rows = set(item.row() for item in self.table.selectedItems())
        if not rows:
            InfoBar.info(
                title="提示",
                content="请先选择要删除的卡片",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return

        w = MessageBox(
            "确认删除",
            f"确定要删除选中的 {len(rows)} 张卡片吗？",
            self
        )
        if w.exec():
            for row in sorted(rows, reverse=True):
                self.dataStore.remove_card(row)
            self.loadData()
            InfoBar.success(
                title="删除完成",
                content=f"已删除 {len(rows)} 张卡片",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def batchImport(self):
        """批量导入卡片"""
        from gui.data_management.batch_import_dialog import CardBatchImportDialog
        dialog = CardBatchImportDialog(self)
        if dialog.exec():
            self.loadData()
