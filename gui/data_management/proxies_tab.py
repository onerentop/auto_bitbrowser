"""
代理管理标签页 - Fluent Design 版本
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QTableWidgetItem,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    TableWidget, PrimaryPushButton, PushButton, TransparentPushButton, TransparentToolButton,
    BodyLabel, CaptionLabel, CardWidget, SubtitleLabel,
    MessageBox, InfoBar, InfoBarPosition, FluentIcon as FIF,
    LineEdit, ComboBox,
)

from services.data_store import get_data_store, ProxyInfo


class ProxyEditDialog(MessageBox):
    """代理编辑对话框"""

    def __init__(self, parent, data=None):
        title = "编辑代理" if data else "添加代理"
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

        self.typeInput = ComboBox()
        self.typeInput.addItems(["socks5", "http", "https"])
        if data:
            index = ["socks5", "http", "https"].index(data.get('proxy_type', 'socks5'))
            self.typeInput.setCurrentIndex(index)
        formLayout.addRow("类型:", self.typeInput)

        self.hostInput = LineEdit()
        self.hostInput.setPlaceholderText("127.0.0.1")
        if data:
            self.hostInput.setText(data.get('host', ''))
        formLayout.addRow("主机:", self.hostInput)

        self.portInput = LineEdit()
        self.portInput.setPlaceholderText("1080")
        if data:
            self.portInput.setText(data.get('port', ''))
        formLayout.addRow("端口:", self.portInput)

        self.usernameInput = LineEdit()
        self.usernameInput.setPlaceholderText("用户名（可选）")
        if data:
            self.usernameInput.setText(data.get('username', ''))
        formLayout.addRow("用户名:", self.usernameInput)

        self.passwordInput = LineEdit()
        self.passwordInput.setPlaceholderText("密码（可选）")
        if data:
            self.passwordInput.setText(data.get('password', ''))
        formLayout.addRow("密码:", self.passwordInput)

        self.textLayout.addWidget(formWidget)
        self.widget.setMinimumWidth(400)

    def get_data(self):
        return {
            'proxy_type': self.typeInput.currentText(),
            'host': self.hostInput.text().strip(),
            'port': self.portInput.text().strip(),
            'username': self.usernameInput.text().strip(),
            'password': self.passwordInput.text().strip()
        }


class ProxyDetailDialog(MessageBox):
    """代理详情对话框"""

    def __init__(self, parent, proxy_id: int):
        super().__init__("代理详情", "", parent)
        self.proxy_id = proxy_id

        # 移除默认内容标签
        self.textLayout.removeWidget(self.contentLabel)
        self.contentLabel.hide()

        # 加载关联窗口列表
        self._loadBindings()

        self.cancelButton.hide()
        self.yesButton.setText("关闭")

    def _loadBindings(self):
        """加载关联窗口"""
        try:
            from services.proxy_allocator import ProxyAllocator
            bindings = ProxyAllocator.get_proxy_bindings(self.proxy_id)

            if not bindings:
                label = CaptionLabel("暂无关联窗口", self.widget)
                self.textLayout.addWidget(label)
                return

            infoLabel = CaptionLabel(f"已关联 {len(bindings)} 个窗口:", self.widget)
            self.textLayout.addWidget(infoLabel)

            # 显示关联窗口列表
            for binding in bindings:
                windowCard = CardWidget(self.widget)
                cardLayout = QHBoxLayout(windowCard)
                cardLayout.setContentsMargins(12, 8, 12, 8)

                nameLabel = BodyLabel(binding.get('window_name', '未知窗口'), windowCard)
                cardLayout.addWidget(nameLabel)
                cardLayout.addStretch()

                # 解绑按钮
                unbindBtn = TransparentPushButton(FIF.DELETE, "解绑", windowCard)
                unbindBtn.clicked.connect(
                    lambda checked, pid=binding.get('profile_id'): self._unbindWindow(pid)
                )
                cardLayout.addWidget(unbindBtn)

                self.textLayout.addWidget(windowCard)

        except Exception as e:
            label = CaptionLabel(f"加载失败: {e}", self.widget)
            self.textLayout.addWidget(label)

    def _unbindWindow(self, profile_id: str):
        """解绑窗口"""
        try:
            from services.proxy_allocator import ProxyAllocator
            ProxyAllocator.release_proxy(profile_id)
            InfoBar.success(
                title="成功",
                content="已解绑窗口",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self.parent()
            )
            self.accept()
        except Exception as e:
            InfoBar.error(
                title="解绑失败",
                content=str(e),
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self.parent()
            )


class ProxiesTab(QWidget):
    """代理管理标签页"""

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

        self.btnAdd = PrimaryPushButton(FIF.ADD, "添加代理", self)
        self.btnAdd.clicked.connect(self.addProxy)
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

        self.countLabel = CaptionLabel("共 0 个代理", self)
        toolbarLayout.addWidget(self.countLabel)

        layout.addWidget(toolbarCard)

        # 表格
        self.table = TableWidget(self)
        self.table.setColumnCount(7)
        self.table.setHorizontalHeaderLabels(["类型", "主机", "端口", "用户名", "密码", "使用情况", "操作"])

        # 设置列宽和自适应模式
        header = self.table.horizontalHeader()
        header.setStretchLastSection(False)

        # 列0: 类型 - 固定宽度
        header.setSectionResizeMode(0, header.ResizeMode.Fixed)
        self.table.setColumnWidth(0, 70)

        # 列1: 主机 - 自适应拉伸（主列）
        header.setSectionResizeMode(1, header.ResizeMode.Stretch)

        # 列2: 端口 - 固定宽度
        header.setSectionResizeMode(2, header.ResizeMode.Fixed)
        self.table.setColumnWidth(2, 70)

        # 列3-4: 用户名、密码 - 根据内容自适应
        header.setSectionResizeMode(3, header.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(4, header.ResizeMode.ResizeToContents)

        # 列5: 使用情况 - 固定宽度
        header.setSectionResizeMode(5, header.ResizeMode.Fixed)
        self.table.setColumnWidth(5, 80)

        # 列6: 操作 - 根据内容自适应（确保按钮完整显示）
        header.setSectionResizeMode(6, header.ResizeMode.ResizeToContents)

        self.table.setSelectionBehavior(TableWidget.SelectionBehavior.SelectRows)
        layout.addWidget(self.table)

    def loadData(self):
        """加载代理数据"""
        try:
            from services.proxy_allocator import ProxyAllocator

            self.dataStore.reload()
            proxies = self.dataStore.get_proxies()
            usageStats = ProxyAllocator.get_all_usage_stats()

            # 创建使用情况映射
            usageMap = {}
            for stat in usageStats:
                key = f"{stat['host']}:{stat['port']}"
                usageMap[key] = stat

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
                stat = usageMap.get(key, {})
                used = stat.get('used_count', 0)
                maxCount = stat.get('max_count', 3)
                isFull = stat.get('is_full', False)

                usageText = f"{used}/{maxCount}"
                usageItem = QTableWidgetItem(usageText)
                if isFull:
                    usageItem.setForeground(QColor("#f44336"))
                elif used > 0:
                    usageItem.setForeground(QColor("#ff9800"))
                else:
                    usageItem.setForeground(QColor("#4caf50"))
                self.table.setItem(row, 5, usageItem)

                # 操作按钮
                btnContainer = QWidget()
                btnContainer.setFixedWidth(100)
                btnLayout = QHBoxLayout(btnContainer)
                btnLayout.setContentsMargins(0, 0, 0, 0)
                btnLayout.setSpacing(4)

                btnEdit = TransparentToolButton(FIF.EDIT, self)
                btnEdit.setFixedSize(36, 36)
                btnEdit.setToolTip("编辑")
                btnEdit.clicked.connect(lambda checked, r=row: self.editProxy(r))
                btnLayout.addWidget(btnEdit)

                proxyId = stat.get('proxy_id')
                if proxyId and used > 0:
                    btnDetail = TransparentToolButton(FIF.INFO, self)
                    btnDetail.setFixedSize(36, 36)
                    btnDetail.setToolTip("详情")
                    btnDetail.clicked.connect(
                        lambda checked, pid=proxyId: self.showProxyDetail(pid)
                    )
                    btnLayout.addWidget(btnDetail)

                btnLayout.addStretch()
                self.table.setCellWidget(row, 6, btnContainer)

            self.countLabel.setText(f"共 {len(proxies)} 个代理")

        except Exception as e:
            InfoBar.error(
                title="错误",
                content=f"加载代理失败: {e}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def showProxyDetail(self, proxyId: int):
        """显示代理详情"""
        dialog = ProxyDetailDialog(self, proxyId)
        dialog.exec()
        self.loadData()

    def addProxy(self):
        """添加新代理"""
        dialog = ProxyEditDialog(self)
        if dialog.exec():
            data = dialog.get_data()
            if not data['host'] or not data['port']:
                InfoBar.warning(
                    title="验证失败",
                    content="主机和端口不能为空",
                    orient=Qt.Orientation.Horizontal,
                    isClosable=True,
                    position=InfoBarPosition.TOP,
                    duration=2000,
                    parent=self
                )
                return
            self.dataStore.add_proxy(ProxyInfo(**data))
            self.loadData()
            InfoBar.success(
                title="成功",
                content="代理已添加",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def editProxy(self, row: int):
        """编辑代理"""
        proxies = self.dataStore.get_proxies()
        if row >= len(proxies):
            return

        proxy = proxies[row]
        dialog = ProxyEditDialog(self, proxy.to_dict())
        if dialog.exec():
            data = dialog.get_data()
            self.dataStore.update_proxy(row, ProxyInfo(**data))
            self.loadData()

    def deleteSelected(self):
        """删除选中代理"""
        rows = set(item.row() for item in self.table.selectedItems())
        if not rows:
            InfoBar.info(
                title="提示",
                content="请先选择要删除的代理",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
            return

        w = MessageBox(
            "确认删除",
            f"确定要删除选中的 {len(rows)} 个代理吗？",
            self
        )
        if w.exec():
            for row in sorted(rows, reverse=True):
                self.dataStore.remove_proxy(row)
            self.loadData()
            InfoBar.success(
                title="删除完成",
                content=f"已删除 {len(rows)} 个代理",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def batchImport(self):
        """批量导入代理"""
        from gui.data_management.batch_import_dialog import ProxyBatchImportDialog
        dialog = ProxyBatchImportDialog(self)
        if dialog.exec():
            self.loadData()
