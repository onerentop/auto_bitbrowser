"""
首页界面 - 窗口列表管理
包含窗口创建、删除、打开等核心功能
"""
import time
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QWidget, QTreeWidgetItem,
    QHeaderView, QAbstractItemView,
)
from PyQt6.QtGui import QColor

from qfluentwidgets import (
    CardWidget, PushButton, PrimaryPushButton, TransparentPushButton,
    LineEdit, SearchLineEdit, SpinBox, ComboBox, CheckBox,
    TreeWidget, ProgressBar, ProgressRing, IndeterminateProgressRing,
    TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
    InfoBar, InfoBarPosition, MessageBox,
    FluentIcon as FIF, setFont,
)

from gui.base_interface import BaseInterface
from gui.fluent_utils import show_success, show_error, show_warning, confirm_dialog

from services.ix_window import (
    get_browser_list, delete_browser_by_id, open_browser_by_id,
    create_browser_window, get_next_window_name, delete_browsers_by_name
)
from services.ix_api import get_group_list
from services.database import DBManager
from core.config_manager import ConfigManager


class BrowserLoadWorker(QThread):
    """异步加载窗口列表的后台线程"""
    progressSignal = pyqtSignal(int, int, str)  # current, total, message
    finishedSignal = pyqtSignal(dict)  # result data
    logSignal = pyqtSignal(str)

    def __init__(self):
        super().__init__()
        self._shouldStop = False

    def stop(self):
        self._shouldStop = True

    def run(self):
        try:
            self.progressSignal.emit(1, 3, "正在获取分组列表...")
            if self._shouldStop:
                return

            all_groups = get_group_list() or []

            self.progressSignal.emit(2, 3, "正在获取窗口列表...")
            if self._shouldStop:
                return

            browsers = get_browser_list() or []

            self.progressSignal.emit(3, 3, "加载完成")

            self.finishedSignal.emit({
                'groups': all_groups,
                'browsers': browsers
            })

        except Exception as e:
            self.logSignal.emit(f"[错误] 加载窗口列表失败: {e}")
            self.finishedSignal.emit({
                'groups': [],
                'browsers': [],
                'error': str(e)
            })


class HomeInterface(BaseInterface):
    """首页界面 - 窗口管理"""

    def __init__(self, parent=None):
        super().__init__('homeInterface', parent)

        self.loadWorker = None
        self._cachedGroups = []
        self._cachedBrowsers = []

        self._initUI()

        # 延迟加载数据
        QTimer.singleShot(100, self.refreshBrowserList)
        QTimer.singleShot(150, self.refreshGroupList)

    def _initUI(self):
        """初始化 UI"""
        # ===== 创建参数配置卡片 =====
        configCard = CardWidget(self)
        configLayout = QVBoxLayout(configCard)
        configLayout.setContentsMargins(20, 15, 20, 15)
        configLayout.setSpacing(10)

        # 标题
        configTitle = SubtitleLabel("创建参数配置", configCard)
        configLayout.addWidget(configTitle)

        # 模板ID
        templateLayout = QHBoxLayout()
        templateLayout.addWidget(BodyLabel("模板窗口ID:", configCard))
        self.templateIdInput = LineEdit(configCard)
        self.templateIdInput.setPlaceholderText("请输入模板窗口ID（可选）")
        self.templateIdInput.setFixedWidth(200)
        templateLayout.addWidget(self.templateIdInput)
        templateLayout.addStretch()
        configLayout.addLayout(templateLayout)

        # 窗口名前缀
        prefixLayout = QHBoxLayout()
        prefixLayout.addWidget(BodyLabel("窗口前缀:", configCard))
        self.namePrefixInput = LineEdit(configCard)
        self.namePrefixInput.setPlaceholderText("可选，默认按模板名命名")
        self.namePrefixInput.setFixedWidth(200)
        prefixLayout.addWidget(self.namePrefixInput)
        prefixLayout.addStretch()
        configLayout.addLayout(prefixLayout)

        # 目标分组
        groupLayout = QHBoxLayout()
        groupLayout.addWidget(BodyLabel("目标分组:", configCard))
        self.groupCombo = ComboBox(configCard)
        self.groupCombo.setFixedWidth(200)
        groupLayout.addWidget(self.groupCombo)
        self.refreshGroupBtn = TransparentPushButton(FIF.SYNC, "刷新", configCard)
        self.refreshGroupBtn.clicked.connect(self.refreshGroupList)
        groupLayout.addWidget(self.refreshGroupBtn)
        groupLayout.addStretch()
        configLayout.addLayout(groupLayout)

        self.mainLayout.addWidget(configCard)

        # ===== 创建操作按钮 =====
        actionLayout = QHBoxLayout()
        actionLayout.setSpacing(10)

        self.createBtn = PrimaryPushButton(FIF.ADD, "根据模板创建窗口", self)
        self.createBtn.setFixedHeight(36)
        self.createBtn.clicked.connect(self._onCreateClicked)

        self.createDefaultBtn = PushButton(FIF.ADD_TO, "使用默认模板创建", self)
        self.createDefaultBtn.setFixedHeight(36)
        self.createDefaultBtn.clicked.connect(self._onCreateDefaultClicked)

        self.stopBtn = PushButton(FIF.PAUSE, "停止任务", self)
        self.stopBtn.setFixedHeight(36)
        self.stopBtn.setEnabled(False)
        self.stopBtn.clicked.connect(self._onStopClicked)

        actionLayout.addWidget(self.createBtn)
        actionLayout.addWidget(self.createDefaultBtn)
        actionLayout.addWidget(self.stopBtn)
        actionLayout.addStretch()

        self.mainLayout.addLayout(actionLayout)

        # ===== 窗口列表卡片 =====
        listCard = CardWidget(self)
        listLayout = QVBoxLayout(listCard)
        listLayout.setContentsMargins(15, 15, 15, 15)
        listLayout.setSpacing(10)

        # 列表工具栏
        toolbarLayout = QHBoxLayout()

        self.refreshBtn = PushButton(FIF.SYNC, "刷新列表", listCard)
        self.refreshBtn.clicked.connect(self.refreshBrowserList)
        toolbarLayout.addWidget(self.refreshBtn)

        self.selectAllCheck = CheckBox("全选", listCard)
        self.selectAllCheck.stateChanged.connect(self._toggleSelectAll)
        toolbarLayout.addWidget(self.selectAllCheck)

        self.searchInput = SearchLineEdit(listCard)
        self.searchInput.setPlaceholderText("搜索邮箱/名称...")
        self.searchInput.setFixedWidth(180)
        self.searchInput.textChanged.connect(self._filterBrowserTree)
        toolbarLayout.addWidget(self.searchInput)

        toolbarLayout.addStretch()

        self.openBtn = PushButton(FIF.VIEW, "打开选中", listCard)
        self.openBtn.clicked.connect(self._onOpenClicked)
        toolbarLayout.addWidget(self.openBtn)

        self.deleteBtn = PushButton(FIF.DELETE, "删除选中", listCard)
        self.deleteBtn.clicked.connect(self._onDeleteClicked)
        toolbarLayout.addWidget(self.deleteBtn)

        listLayout.addLayout(toolbarLayout)

        # 树形控件
        self.tree = TreeWidget(listCard)
        self.tree.setHeaderLabels(["选择", "名称", "窗口ID", "2FA验证码", "备注"])
        self.tree.setColumnWidth(0, 80)
        self.tree.setColumnWidth(1, 180)
        self.tree.setColumnWidth(2, 100)
        self.tree.setColumnWidth(3, 100)
        self.tree.header().setStretchLastSection(True)
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setRootIsDecorated(True)
        self.tree.setIndentation(15)

        listLayout.addWidget(self.tree)

        # 加载进度
        self.loadingProgress = ProgressBar(listCard)
        self.loadingProgress.setRange(0, 100)
        self.loadingProgress.setValue(0)
        self.loadingProgress.hide()
        listLayout.addWidget(self.loadingProgress)

        self.mainLayout.addWidget(listCard, 1)  # stretch=1 让列表占据剩余空间

        # ===== 日志区域 =====
        self.addLogArea()

        # 加载配置
        self._loadConfigToUI()

    def refreshGroupList(self):
        """刷新分组下拉列表"""
        self.groupCombo.clear()
        try:
            groups = get_group_list() or []
            has_default = any(g.get('id') == 1 for g in groups)
            if not has_default:
                self.groupCombo.addItem("默认分组", userData=1)

            for g in groups:
                gid = g.get('id')
                title = g.get('title', '')
                clean_title = ''.join(c for c in str(title) if c.isprintable())
                if not clean_title or '\ufffd' in clean_title:
                    clean_title = f"分组 {gid}"
                self.groupCombo.addItem(f"{clean_title} (ID: {gid})", userData=gid)
        except Exception as e:
            self.log(f"[警告] 获取分组列表失败: {e}")
            self.groupCombo.addItem("默认分组", userData=1)

    def refreshBrowserList(self):
        """异步刷新窗口列表"""
        self.tree.clear()
        self.selectAllCheck.setChecked(False)
        self.loadingProgress.setValue(0)
        self.loadingProgress.show()

        # 清理旧线程
        if self.loadWorker is not None:
            if self.loadWorker.isRunning():
                self.loadWorker.stop()
                try:
                    self.loadWorker.progressSignal.disconnect()
                    self.loadWorker.finishedSignal.disconnect()
                    self.loadWorker.logSignal.disconnect()
                except (TypeError, RuntimeError):
                    pass
                self.loadWorker.wait(1000)
            self.loadWorker = None

        self.loadWorker = BrowserLoadWorker()
        self.loadWorker.progressSignal.connect(self._onLoadProgress)
        self.loadWorker.finishedSignal.connect(self._onLoadFinished)
        self.loadWorker.logSignal.connect(self.log)
        self.loadWorker.start()

    def _onLoadProgress(self, current: int, total: int, message: str):
        """加载进度更新"""
        if total > 0:
            pct = int(current / total * 100)
            self.loadingProgress.setValue(pct)

    def _onLoadFinished(self, result: dict):
        """加载完成回调"""
        try:
            self._cachedGroups = result.get('groups', [])
            self._cachedBrowsers = result.get('browsers', [])

            if result.get('error'):
                self.log(f"⚠️ 加载数据时发生错误: {result.get('error')}")

            self._populateBrowserTree()

        except Exception as e:
            self.log(f"❌ 处理加载结果失败: {e}")
        finally:
            self.loadingProgress.hide()

    def _populateBrowserTree(self):
        """填充窗口树形控件"""
        def clean_text(text):
            if not text:
                return ""
            return ''.join(c for c in str(text) if c.isprintable())

        # 处理分组
        group_names = {}
        for g in self._cachedGroups:
            gid = g.get('id')
            title = clean_text(g.get('title', ''))
            if not title or '\ufffd' in title:
                title = f"分组 {gid}"
            group_names[gid] = title
        group_names[0] = "未分组"

        # 按 group_id 分组
        grouped = {gid: [] for gid in group_names.keys()}
        for b in self._cachedBrowsers:
            gid = b.get('group_id', 0) or 0
            if gid not in grouped:
                grouped[gid] = []
                gname = clean_text(b.get('group_name', ''))
                if not gname or '\ufffd' in gname:
                    gname = f"分组 {gid}"
                group_names[gid] = gname
            grouped[gid].append(b)

        # 创建树形结构
        total_count = 0
        for gid in sorted(grouped.keys()):
            browser_list = grouped[gid]
            group_name = group_names.get(gid, f"分组 {gid}")

            # 分组节点
            group_item = QTreeWidgetItem(self.tree)
            group_item.setText(0, "")
            group_item.setText(1, f"📁 {group_name} ({len(browser_list)})")
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

            # 窗口子节点
            for browser in browser_list:
                child = QTreeWidgetItem(group_item)
                child.setFlags(child.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                child.setCheckState(0, Qt.CheckState.Unchecked)
                child.setText(1, clean_text(browser.get('name', '')))
                child.setText(2, str(browser.get('profile_id', '')))
                child.setText(3, "")  # 2FA 初始为空
                child.setText(4, clean_text(browser.get('note', '')))
                child.setData(0, Qt.ItemDataRole.UserRole, {
                    "type": "browser",
                    "id": browser.get('profile_id')
                })
                total_count += 1

        self.log(f"列表刷新完成，共 {len(grouped)} 个分组，{total_count} 个窗口")

        # 如果搜索框有内容，重新应用过滤
        if self.searchInput.text():
            self._filterBrowserTree(self.searchInput.text())

    def _filterBrowserTree(self, search_text: str):
        """根据搜索文本过滤窗口树"""
        search_text = search_text.lower().strip()
        root = self.tree.invisibleRootItem()

        for i in range(root.childCount()):
            group_item = root.child(i)
            group_visible_count = 0

            for j in range(group_item.childCount()):
                child = group_item.child(j)

                if not search_text:
                    child.setHidden(False)
                    group_visible_count += 1
                else:
                    name = (child.text(1) or "").lower()
                    note = (child.text(4) or "").lower()

                    if search_text in name or search_text in note:
                        child.setHidden(False)
                        group_visible_count += 1
                    else:
                        child.setHidden(True)
                        child.setCheckState(0, Qt.CheckState.Unchecked)

            group_item.setHidden(group_visible_count == 0 and bool(search_text))

        self.selectAllCheck.blockSignals(True)
        self.selectAllCheck.setChecked(False)
        self.selectAllCheck.blockSignals(False)

    def _toggleSelectAll(self, state):
        """全选/取消全选"""
        check_state = Qt.CheckState.Checked if state == 2 else Qt.CheckState.Unchecked
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            if not group_item.isHidden():
                for j in range(group_item.childCount()):
                    child = group_item.child(j)
                    if not child.isHidden():
                        child.setCheckState(0, check_state)

    def _getSelectedBrowserIds(self) -> list:
        """获取选中的窗口ID列表"""
        ids = []
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if not child.isHidden() and child.checkState(0) == Qt.CheckState.Checked:
                    data = child.data(0, Qt.ItemDataRole.UserRole)
                    if data and data.get("type") == "browser":
                        ids.append(str(data.get("id")))
        return ids

    def _onCreateClicked(self):
        """根据模板创建窗口"""
        template_id = self.templateIdInput.text().strip()
        if not template_id:
            show_warning(self, "提示", "请输入模板窗口ID")
            return
        # TODO: 实现创建逻辑
        self.log(f"开始根据模板 {template_id} 创建窗口...")

    def _onCreateDefaultClicked(self):
        """使用默认模板创建窗口"""
        # TODO: 实现创建逻辑
        self.log("开始使用默认模板创建窗口...")

    def _onStopClicked(self):
        """停止任务"""
        self.log("[用户操作] 正在停止任务...")
        self.stopBtn.setEnabled(False)

    def _onOpenClicked(self):
        """打开选中的窗口"""
        ids = self._getSelectedBrowserIds()
        if not ids:
            show_warning(self, "提示", "请先勾选要打开的窗口")
            return

        self.log(f"准备打开 {len(ids)} 个窗口...")
        # TODO: 实现批量打开逻辑

    def _onDeleteClicked(self):
        """删除选中的窗口"""
        ids = self._getSelectedBrowserIds()
        if not ids:
            show_warning(self, "提示", "请先勾选要删除的窗口")
            return

        if confirm_dialog(self, "确认删除",
                         f"确定要删除选中的 {len(ids)} 个窗口吗？\n此操作不可恢复！"):
            self.log(f"准备删除 {len(ids)} 个窗口...")
            # TODO: 实现批量删除逻辑

    def _loadConfigToUI(self):
        """从配置加载到UI控件"""
        try:
            template_id = ConfigManager.get("last_used_template_id", "")
            if template_id:
                self.templateIdInput.setText(str(template_id))

            prefix = ConfigManager.get("window_name_prefix", "")
            if prefix:
                self.namePrefixInput.setText(prefix)
        except Exception as e:
            print(f"[Config] 加载配置到UI失败: {e}")

    def saveConfig(self):
        """保存配置"""
        try:
            ConfigManager.set("last_used_template_id", self.templateIdInput.text().strip())
            ConfigManager.set("window_name_prefix", self.namePrefixInput.text().strip())
        except Exception as e:
            print(f"[Config] 保存配置失败: {e}")
