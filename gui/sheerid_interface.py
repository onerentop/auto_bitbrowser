"""
SheerID 验证界面 - Fluent Design 版本
批量验证 Google One 学生资格
"""
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QWidget, QHeaderView,
    QAbstractItemView, QTableWidgetItem,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    CardWidget, PushButton, PrimaryPushButton, TransparentPushButton,
    LineEdit, SearchLineEdit, CheckBox, TableWidget,
    ProgressBar, TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
    InfoBar, InfoBarPosition, MessageBox,
    FluentIcon as FIF,
)

from gui.base_interface import BaseDialogInterface
from gui.fluent_utils import show_success, show_error, show_warning

from services.sheerid_verifier import SheerIDVerifier
from application.sheerid_service import SheerIDService


class VerifyWorkerFluent(QThread):
    """验证工作线程 - Fluent 版本"""

    progressSignal = pyqtSignal(dict)  # {email, vid, status, msg}
    finishedSignal = pyqtSignal()

    def __init__(self, api_key: str, accounts: list):
        super().__init__()
        self.api_key = api_key
        self.accounts = accounts
        self._shouldStop = False

    def stop(self):
        self._shouldStop = True

    def run(self):
        verifier = SheerIDVerifier(api_key=self.api_key)

        # 提取所有 VID
        tasks = [item["vid"] for item in self.accounts if item.get("vid")]

        if not tasks:
            self.finishedSignal.emit()
            return

        # 按批次处理（每批 5 个）
        batches = [tasks[i:i + 5] for i in range(0, len(tasks), 5)]

        def callback(vid, msg):
            if self._shouldStop:
                return
            email = self._getEmailByVid(vid)
            self.progressSignal.emit({
                "email": email, "vid": vid, "status": "Running", "msg": msg
            })

        for batch in batches:
            if self._shouldStop:
                break

            # 更新状态为处理中
            for vid in batch:
                email = self._getEmailByVid(vid)
                self.progressSignal.emit({
                    "email": email, "vid": vid, "status": "Processing", "msg": "提交中..."
                })

            # 调用验证 API
            results = verifier.verify_batch(batch, callback=callback)

            # 处理结果
            for vid, res in results.items():
                email = self._getEmailByVid(vid)
                status = res.get("currentStep") or res.get("status")
                msg = res.get("message", "")

                if status == "success":
                    self._handleSuccess(email, vid, msg)
                else:
                    self.progressSignal.emit({
                        "email": email, "vid": vid, "status": status, "msg": msg
                    })

        self.finishedSignal.emit()

    def _getEmailByVid(self, vid: str) -> str:
        for acc in self.accounts:
            if acc.get("vid") == vid:
                return acc.get("email", "")
        return ""

    def _handleSuccess(self, email: str, vid: str, msg: str):
        try:
            SheerIDService.mark_verified_success(email=email, verification_id=vid)
            msg = "验证成功，已更新状态"
        except Exception as e:
            msg += f" (数据库更新失败: {e})"

        self.progressSignal.emit({
            "email": email, "vid": vid, "status": "success", "msg": msg
        })


class SheerIDInterface(BaseDialogInterface):
    """SheerID 验证界面 - Fluent 版本"""

    def __init__(self, parent=None):
        super().__init__('sheeridInterface', parent)

        self.worker = None
        self._accounts = []

        self._initUI()

    def _initUI(self):
        """初始化界面"""
        # ===== 配置卡片 =====
        configCard = CardWidget(self)
        configLayout = QVBoxLayout(configCard)
        configLayout.setContentsMargins(20, 15, 20, 15)
        configLayout.setSpacing(10)

        # 标题
        configTitle = SubtitleLabel("SheerID 验证配置", configCard)
        configLayout.addWidget(configTitle)

        # API Key
        apiKeyLayout = QHBoxLayout()
        apiKeyLayout.addWidget(BodyLabel("API Key:", configCard))
        self.apiKeyInput = LineEdit(configCard)
        self.apiKeyInput.setPlaceholderText("请输入 SheerID API Key")
        self.apiKeyInput.setFixedWidth(350)
        # 加载保存的 API Key
        saved_key = SheerIDService.get_api_key()
        if saved_key:
            self.apiKeyInput.setText(saved_key)
        apiKeyLayout.addWidget(self.apiKeyInput)
        apiKeyLayout.addStretch()
        configLayout.addLayout(apiKeyLayout)

        # 状态筛选
        filterLayout = QHBoxLayout()
        filterLayout.addWidget(BodyLabel("筛选状态:", configCard))
        self.filterLinkReady = CheckBox("link_ready", configCard)
        self.filterLinkReady.setChecked(True)
        self.filterPending = CheckBox("pending", configCard)
        self.filterVerified = CheckBox("verified", configCard)
        filterLayout.addWidget(self.filterLinkReady)
        filterLayout.addWidget(self.filterPending)
        filterLayout.addWidget(self.filterVerified)
        filterLayout.addStretch()
        configLayout.addLayout(filterLayout)

        self.mainLayout.addWidget(configCard)

        # ===== 操作按钮 =====
        actionLayout = QHBoxLayout()
        actionLayout.setSpacing(10)

        self.loadBtn = PushButton(FIF.DOWNLOAD, "加载账号", self)
        self.loadBtn.setFixedHeight(36)
        self.loadBtn.clicked.connect(self._loadAccounts)
        actionLayout.addWidget(self.loadBtn)

        self.verifyBtn = PrimaryPushButton(FIF.ACCEPT, "开始验证", self)
        self.verifyBtn.setFixedHeight(36)
        self.verifyBtn.clicked.connect(self._onStartClicked)
        actionLayout.addWidget(self.verifyBtn)

        self.stopBtn = PushButton(FIF.PAUSE, "停止", self)
        self.stopBtn.setFixedHeight(36)
        self.stopBtn.setEnabled(False)
        self.stopBtn.clicked.connect(self._onStopClicked)
        actionLayout.addWidget(self.stopBtn)

        actionLayout.addStretch()

        # 统计标签
        self.statsLabel = CaptionLabel("", self)
        actionLayout.addWidget(self.statsLabel)

        self.mainLayout.addLayout(actionLayout)

        # ===== 账号表格 =====
        tableCard = CardWidget(self)
        tableLayout = QVBoxLayout(tableCard)
        tableLayout.setContentsMargins(10, 10, 10, 10)

        self.table = TableWidget(tableCard)
        self.table.setColumnCount(5)
        self.table.setHorizontalHeaderLabels(["选择", "邮箱", "VID", "状态", "消息"])
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 50)
        self.table.setColumnWidth(2, 200)
        self.table.setColumnWidth(3, 100)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)

        tableLayout.addWidget(self.table)
        self.mainLayout.addWidget(tableCard, 1)

        # ===== 进度条 =====
        self.addProgressBar()

        # ===== 日志区 =====
        self.addLogArea()

    def _loadAccounts(self):
        """从数据库加载账号"""
        self.table.setRowCount(0)
        self._accounts = []

        try:
            # 根据筛选条件获取账号
            statuses = []
            if self.filterLinkReady.isChecked():
                statuses.append("link_ready")
            if self.filterPending.isChecked():
                statuses.append("pending")
            if self.filterVerified.isChecked():
                statuses.append("verified")

            if not statuses:
                show_warning(self, "提示", "请至少选择一个状态筛选条件")
                return

            # 获取账号数据（通过应用服务层）
            all_accounts = SheerIDService.load_accounts_by_statuses(statuses)

            # 填充表格
            for acc in all_accounts:
                email = acc.email
                vid = acc.vid
                link = acc.link

                if not email:
                    continue

                self._accounts.append({
                    'email': email,
                    'vid': vid,
                    'link': link
                })

                row = self.table.rowCount()
                self.table.insertRow(row)

                # 复选框
                checkItem = QTableWidgetItem()
                checkItem.setFlags(checkItem.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                checkItem.setCheckState(Qt.CheckState.Checked)
                self.table.setItem(row, 0, checkItem)

                # 数据
                self.table.setItem(row, 1, QTableWidgetItem(email))
                self.table.setItem(row, 2, QTableWidgetItem(vid or "无"))
                self.table.setItem(row, 3, QTableWidgetItem("待验证"))
                self.table.setItem(row, 4, QTableWidgetItem(""))

            # 更新统计
            self.statsLabel.setText(f"共 {len(self._accounts)} 个账号")
            self.log(f"已加载 {len(self._accounts)} 个账号")

        except Exception as e:
            show_error(self, "错误", f"加载账号失败: {e}")
            self.log(f"❌ 加载账号失败: {e}")

    def _onStartClicked(self):
        """开始验证"""
        # 检查 API Key
        api_key = self.apiKeyInput.text().strip()
        if not api_key:
            show_warning(self, "提示", "请输入 SheerID API Key")
            return

        # 保存 API Key
        SheerIDService.set_api_key(api_key)

        # 获取选中的账号
        selected = []
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 0)
            if item and item.checkState() == Qt.CheckState.Checked:
                email = self.table.item(row, 1).text()
                for acc in self._accounts:
                    if acc['email'] == email:
                        selected.append(acc)
                        break

        if not selected:
            show_warning(self, "提示", "请先选择要验证的账号")
            return

        # 过滤没有 VID 的账号
        valid = [a for a in selected if a.get('vid')]
        if not valid:
            show_warning(self, "提示", "选中的账号都没有验证ID (VID)")
            return

        self.log(f"开始验证 {len(valid)} 个账号...")
        self.setProgress(0)
        self.setRunning(True)

        # 创建并启动工作线程
        self.worker = VerifyWorkerFluent(api_key, valid)
        self.worker.progressSignal.connect(self._onProgress)
        self.worker.finishedSignal.connect(self._onFinished)
        self.worker.start()

    def _onStopClicked(self):
        """停止验证"""
        if self.worker and self.worker.isRunning():
            self.worker.stop()
            self.log("正在停止验证任务...")
        super()._onStopClicked()

    def _onProgress(self, data: dict):
        """更新进度"""
        email = data.get('email', '')
        status = data.get('status', '')
        msg = data.get('msg', '')

        # 更新表格
        for row in range(self.table.rowCount()):
            if self.table.item(row, 1).text() == email:
                self.table.item(row, 3).setText(status)
                self.table.item(row, 4).setText(msg)

                # 设置行颜色
                if status == "success":
                    color = QColor(200, 255, 200)
                elif status in ("error", "ineligible"):
                    color = QColor(255, 200, 200)
                elif status in ("Processing", "Retrying"):
                    color = QColor(255, 255, 200)
                else:
                    color = QColor(255, 255, 255)

                for col in range(self.table.columnCount()):
                    item = self.table.item(row, col)
                    if item:
                        item.setBackground(color)
                break

        self.log(f"[{email}] {status}: {msg}")

    def _onFinished(self):
        """验证完成"""
        self.setRunning(False)
        self.setProgress(100)
        self.log("✅ 验证任务完成")
        show_success(self, "完成", "验证任务已完成")

    def setRunning(self, running: bool):
        """设置运行状态"""
        self._isRunning = running
        self.verifyBtn.setEnabled(not running)
        self.stopBtn.setEnabled(running)
        self.loadBtn.setEnabled(not running)
