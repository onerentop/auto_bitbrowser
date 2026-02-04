"""
综合查询界面 - Fluent Design 版本
查询账号的完整状态信息
"""
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QHeaderView, QAbstractItemView,
    QTableWidgetItem,
)

from qfluentwidgets import (
    CardWidget, PushButton, PrimaryPushButton,
    LineEdit, SearchLineEdit, TableWidget,
    SubtitleLabel, BodyLabel, CaptionLabel,
    FluentIcon as FIF,
)

from gui.base_interface import BaseDialogInterface
from gui.fluent_utils import show_success, show_error, show_warning

from services.database import DBManager


class QueryWorker(QThread):
    """查询工作线程"""
    finishedSignal = pyqtSignal(list)
    logSignal = pyqtSignal(str)

    def __init__(self):
        super().__init__()

    def run(self):
        try:
            # 获取所有账号的综合数据
            data = DBManager.get_comprehensive_account_data() or []
            self.finishedSignal.emit(data)
        except Exception as e:
            self.logSignal.emit(f"[错误] 查询失败: {e}")
            self.finishedSignal.emit([])


class QueryInterface(BaseDialogInterface):
    """综合查询界面"""

    def __init__(self, parent=None):
        super().__init__('queryInterface', parent)

        self.worker = None
        self._data = []

        self._initUI()

    def _initUI(self):
        """初始化界面"""
        # ===== 工具栏 =====
        toolbarLayout = QHBoxLayout()

        self.refreshBtn = PrimaryPushButton(FIF.SYNC, "刷新数据", self)
        self.refreshBtn.setFixedHeight(36)
        self.refreshBtn.clicked.connect(self._loadData)
        toolbarLayout.addWidget(self.refreshBtn)

        self.searchInput = SearchLineEdit(self)
        self.searchInput.setPlaceholderText("搜索邮箱...")
        self.searchInput.setFixedWidth(250)
        self.searchInput.textChanged.connect(self._filterTable)
        toolbarLayout.addWidget(self.searchInput)

        toolbarLayout.addStretch()

        self.statsLabel = CaptionLabel("", self)
        toolbarLayout.addWidget(self.statsLabel)

        self.mainLayout.addLayout(toolbarLayout)

        # ===== 数据表格 =====
        tableCard = CardWidget(self)
        tableLayout = QVBoxLayout(tableCard)
        tableLayout.setContentsMargins(10, 10, 10, 10)

        self.table = TableWidget(tableCard)
        self.table.setColumnCount(8)
        self.table.setHorizontalHeaderLabels([
            "邮箱", "状态", "SheerID", "订阅状态",
            "辅助手机", "辅助邮箱", "2FA", "更新时间"
        ])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(1, 80)
        self.table.setColumnWidth(2, 80)
        self.table.setColumnWidth(3, 80)
        self.table.setColumnWidth(4, 120)
        self.table.setColumnWidth(5, 150)
        self.table.setColumnWidth(6, 60)
        self.table.setColumnWidth(7, 140)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)

        tableLayout.addWidget(self.table)
        self.mainLayout.addWidget(tableCard, 1)

        # ===== 日志区 =====
        self.addLogArea()

    def _loadData(self):
        """加载数据"""
        self.table.setRowCount(0)
        self.log("正在查询数据...")

        self.worker = QueryWorker()
        self.worker.finishedSignal.connect(self._onQueryFinished)
        self.worker.logSignal.connect(self.log)
        self.worker.start()

    def _onQueryFinished(self, data: list):
        """查询完成"""
        self._data = data

        for acc in data:
            row = self.table.rowCount()
            self.table.insertRow(row)

            email = acc.get('email', '')
            status = acc.get('status', '')
            sheerid = '✓' if acc.get('sheerid_verified') else ''
            subscribed = '✓' if status == 'subscribed' else ''
            phone = acc.get('recovery_phone', '') or ''
            backup_email = acc.get('backup_email', '') or ''
            has_2fa = '✓' if acc.get('totp_secret') else ''
            updated = acc.get('updated_at', '') or ''

            self.table.setItem(row, 0, QTableWidgetItem(email))
            self.table.setItem(row, 1, QTableWidgetItem(status))
            self.table.setItem(row, 2, QTableWidgetItem(sheerid))
            self.table.setItem(row, 3, QTableWidgetItem(subscribed))
            self.table.setItem(row, 4, QTableWidgetItem(phone))
            self.table.setItem(row, 5, QTableWidgetItem(backup_email))
            self.table.setItem(row, 6, QTableWidgetItem(has_2fa))
            self.table.setItem(row, 7, QTableWidgetItem(updated))

        self.statsLabel.setText(f"共 {len(data)} 条记录")
        self.log(f"查询完成，共 {len(data)} 条记录")

    def _filterTable(self, text: str):
        """筛选表格"""
        text = text.lower().strip()
        visible_count = 0

        for row in range(self.table.rowCount()):
            email_item = self.table.item(row, 0)
            if email_item:
                email = email_item.text().lower()
                if not text or text in email:
                    self.table.setRowHidden(row, False)
                    visible_count += 1
                else:
                    self.table.setRowHidden(row, True)

        if text:
            self.statsLabel.setText(f"显示 {visible_count} / {len(self._data)} 条记录")
        else:
            self.statsLabel.setText(f"共 {len(self._data)} 条记录")
