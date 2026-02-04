"""
TOTP 密钥导入界面 - Fluent Design 版本

支持两种导入方式：
1. QR 码导入：从 Google Authenticator 导出的 QR 码截图中提取
2. 文本导入：直接粘贴 邮箱----密码----密钥 格式的文本

使用流程:
- QR 码导入：选择截图 → 自动解析 → 匹配账号 → 导入
- 文本导入：粘贴文本 → 解析 → 匹配账号 → 导入
"""

import os
import re
from typing import List, Optional
from datetime import datetime
from dataclasses import dataclass

from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTableWidgetItem,
    QHeaderView, QAbstractItemView, QSplitter, QFileDialog,
    QStackedWidget, QApplication,
)
from PyQt6.QtGui import QColor, QDragEnterEvent, QDropEvent

from qfluentwidgets import (
    TableWidget, PrimaryPushButton, PushButton, TransparentPushButton,
    BodyLabel, CaptionLabel, CardWidget, SubtitleLabel, MessageBox,
    InfoBar, InfoBarPosition, FluentIcon as FIF, CheckBox, TextEdit,
    ProgressBar, SegmentedWidget, PlainTextEdit,
)

from gui.base_interface import BaseInterface
from services.database import DBManager


@dataclass
class TextOTPAccount:
    """文本导入的 OTP 账号数据类，模拟 QR 解析的接口"""
    email: str
    password: str
    secret: str
    issuer: str = "文本导入"
    name: str = ""

    def get_email(self) -> str:
        """获取邮箱地址"""
        return self.email

    def __post_init__(self):
        if not self.name:
            self.name = self.email


class ImportWorker(QThread):
    """导入工作线程"""
    progress = pyqtSignal(int, int)  # current, total
    log_message = pyqtSignal(str)  # 日志消息
    item_result = pyqtSignal(str, bool, str)  # email, success, error_message
    finished_import = pyqtSignal(int, int, int, int, int, list, list)  # success, total, password, bind, ix_update, failed_list, warning_list

    def __init__(self, selected_results: List, parent=None):
        super().__init__(parent)
        self.selected_results = selected_results
        self._ix_api_available = False
        self._ix_profile_map = {}
        self._failed_list = []  # 记录失败的账号和原因
        self._warning_list = []  # 记录警告（密钥成功但窗口更新失败）

    def run(self):
        """执行导入"""
        # 导入 ixBrowser API
        try:
            from services.ix_api import update_profile, get_profile_list
            self._ix_api_available = True
        except ImportError:
            self._ix_api_available = False
            update_profile = None
            get_profile_list = None

        # 获取所有 ixBrowser 窗口
        if self._ix_api_available:
            try:
                self.log_message.emit("正在获取 ixBrowser 窗口列表...")
                page = 1
                while True:
                    profiles = get_profile_list(page=page, limit=100)
                    if not profiles:
                        break
                    for p in profiles:
                        if isinstance(p, dict):
                            name = p.get("name", "")
                            pid = p.get("profile_id") or p.get("id")
                        else:
                            name = getattr(p, "name", "")
                            pid = getattr(p, "profile_id", None) or getattr(p, "id", None)
                        if name and pid:
                            self._ix_profile_map[name.lower()] = pid
                    if len(profiles) < 100:
                        break
                    page += 1
                if self._ix_profile_map:
                    self.log_message.emit(f"  获取到 {len(self._ix_profile_map)} 个窗口")
            except Exception as e:
                self.log_message.emit(f"  ⚠ 获取窗口列表失败: {e}")

        # 执行导入
        success_count = 0
        ix_update_count = 0
        bind_count = 0
        password_count = 0
        total_count = len(self.selected_results)
        self._failed_list = []
        self._warning_list = []

        for i, result in enumerate(self.selected_results):
            db_account = result["db_account"]
            otp_acc = result["otp_account"]
            email = db_account["email"]
            secret = otp_acc.secret
            has_warning = False
            warning_msg = ""

            try:
                # 准备更新参数
                update_kwargs = {"secret_key": secret}

                # 如果是文本导入且有密码，同时更新密码
                if isinstance(otp_acc, TextOTPAccount) and otp_acc.password:
                    update_kwargs["password"] = otp_acc.password
                    password_count += 1

                # 更新数据库
                DBManager.upsert_account(email, **update_kwargs)
                self.log_message.emit(f"  [数据库] 密钥已写入: {email}")
                success_count += 1

                # 获取或查找 profile_id
                profile_id = db_account.get("browser_profile_id")

                # 如果没有绑定窗口，尝试通过邮箱名称匹配
                if not profile_id and self._ix_api_available:
                    matched_pid = self._ix_profile_map.get(email.lower())
                    if matched_pid:
                        profile_id = matched_pid
                        try:
                            DBManager.upsert_account(email, browser_profile_id=str(profile_id))
                            self.log_message.emit(f"  [绑定] 已自动绑定窗口: {profile_id}")
                            bind_count += 1
                        except Exception as e:
                            has_warning = True
                            warning_msg = f"绑定窗口失败: {e}"

                # 更新 ixBrowser 窗口备注
                if profile_id and self._ix_api_available:
                    try:
                        from services.ix_api import update_profile
                        # 获取最新的密码
                        password = update_kwargs.get("password") or db_account.get("password") or ""
                        recovery = db_account.get("recovery_email") or ""
                        note = f"{email}----{password}----{recovery}----{secret}"

                        self.log_message.emit(f"  [窗口] 正在更新备注...")
                        if update_profile(int(profile_id), note=note):
                            self.log_message.emit(f"  [窗口] 备注更新成功")
                            ix_update_count += 1
                        else:
                            has_warning = True
                            warning_msg = "更新窗口备注返回失败"
                            self.log_message.emit(f"  [窗口] ⚠ 备注更新失败")
                    except Exception as e:
                        has_warning = True
                        warning_msg = f"更新窗口备注失败: {e}"
                        self.log_message.emit(f"  [窗口] ⚠ {warning_msg}")

                # 记录最终结果
                if has_warning:
                    self.log_message.emit(f"⚠ 完成: {email} (有警告)")
                    self.item_result.emit(email, True, warning_msg)
                    self._warning_list.append({"email": email, "warning": warning_msg})
                else:
                    self.log_message.emit(f"✓ 完成: {email}")
                    self.item_result.emit(email, True, "")

            except Exception as e:
                error_msg = str(e)
                self.log_message.emit(f"✗ 导入失败 {email}: {error_msg}")
                self.item_result.emit(email, False, error_msg)
                self._failed_list.append({"email": email, "error": error_msg})

            # 发送进度
            self.progress.emit(i + 1, total_count)

        # 发送完成信号（包含失败列表和警告列表）
        self.finished_import.emit(success_count, total_count, password_count, bind_count, ix_update_count, self._failed_list, self._warning_list)


class ImportTOTPInterface(BaseInterface):
    """TOTP 密钥导入界面 - Fluent Design 版本"""

    # 状态显示文本（类常量）
    STATUS_TEXT = {
        "can_import": "可导入",
        "has_secret": "已有",
        "no_match": "未匹配",
    }
    # 状态颜色（类常量）
    STATUS_COLORS = {
        "can_import": "#4CAF50",
        "has_secret": "#FF9800",
        "no_match": "#888888",
    }

    def __init__(self, parent=None):
        super().__init__('importTOTPInterface', parent)
        self.setAcceptDrops(True)  # 支持拖放

        self._extracted_accounts = []  # 提取的账号列表
        self._match_results = []  # 匹配结果
        self._current_mode = "qr"  # 当前导入模式: "qr" 或 "text"

        self._initUI()
        self._check_dependencies()

    def _initUI(self):
        """初始化界面"""
        # 标题
        titleLabel = SubtitleLabel("导入 TOTP 密钥", self)
        self.mainLayout.addWidget(titleLabel)

        # 导入方式切换
        self._createModeSwitch()

        # 使用说明卡片（根据模式显示不同内容）
        self._createHelpCards()

        # 导入内容区域（使用 StackedWidget 切换）
        self._createImportAreas()

        # 全选栏
        selectBarLayout = QHBoxLayout()
        selectBarLayout.setContentsMargins(0, 4, 0, 4)
        selectBarLayout.setSpacing(12)

        self.chkSelectAll = CheckBox("全选", self)
        self.chkSelectAll.setToolTip("全选/取消全选可导入的账号")
        self.chkSelectAll.stateChanged.connect(self._onSelectAllChanged)
        selectBarLayout.addWidget(self.chkSelectAll)

        self.selectedCountLabel = CaptionLabel("已选: 0", self)
        selectBarLayout.addWidget(self.selectedCountLabel)

        selectBarLayout.addStretch()

        self.chkOnlyMatched = CheckBox("仅显示可匹配账号", self)
        self.chkOnlyMatched.setChecked(True)
        self.chkOnlyMatched.stateChanged.connect(self._applyFilter)
        selectBarLayout.addWidget(self.chkOnlyMatched)

        self.mainLayout.addLayout(selectBarLayout)

        # 主内容区（使用分割器）
        splitter = QSplitter(Qt.Orientation.Vertical)

        # 表格区域
        self.table = self._createTable()
        splitter.addWidget(self.table)

        # 日志区域
        logCard = CardWidget(self)
        logLayout = QVBoxLayout(logCard)
        logLayout.setContentsMargins(16, 12, 16, 12)

        logTitleLabel = CaptionLabel("日志输出", logCard)
        logLayout.addWidget(logTitleLabel)

        self.logText = TextEdit(logCard)
        self.logText.setReadOnly(True)
        self.logText.setMaximumHeight(120)
        logLayout.addWidget(self.logText)

        splitter.addWidget(logCard)
        splitter.setSizes([400, 120])

        self.mainLayout.addWidget(splitter)

        # 底部状态和导入按钮
        bottomLayout = QHBoxLayout()
        bottomLayout.setSpacing(12)

        self.statusLabel = CaptionLabel("就绪 - 请选择导入方式", self)
        bottomLayout.addWidget(self.statusLabel)

        # 进度条 - 放在状态标签和按钮之间
        self.progressBar = ProgressBar(self)
        self.progressBar.setFixedHeight(6)
        self.progressBar.setMinimumWidth(200)
        self.progressBar.setVisible(False)
        bottomLayout.addWidget(self.progressBar)

        bottomLayout.addStretch()

        self.btnImport = PrimaryPushButton(FIF.ACCEPT, "导入选中账号", self)
        self.btnImport.setEnabled(False)
        self.btnImport.setFixedWidth(150)
        self.btnImport.clicked.connect(self._onImport)
        bottomLayout.addWidget(self.btnImport)

        self.mainLayout.addLayout(bottomLayout)

    def _createModeSwitch(self):
        """创建导入方式切换"""
        switchCard = CardWidget(self)
        switchLayout = QHBoxLayout(switchCard)
        switchLayout.setContentsMargins(16, 12, 16, 12)

        switchLabel = CaptionLabel("导入方式：", switchCard)
        switchLayout.addWidget(switchLabel)

        self.modeSwitch = SegmentedWidget(switchCard)
        self.modeSwitch.addItem(routeKey="qr", text="📷 QR码导入")
        self.modeSwitch.addItem(routeKey="text", text="📝 文本导入")
        self.modeSwitch.setCurrentItem("qr")
        self.modeSwitch.currentItemChanged.connect(self._onModeChanged)
        switchLayout.addWidget(self.modeSwitch)

        switchLayout.addStretch()

        # 状态标识（依赖检查）
        self.dependencyLabel = CaptionLabel("", switchCard)
        switchLayout.addWidget(self.dependencyLabel)

        self.mainLayout.addWidget(switchCard)

    def _createHelpCards(self):
        """创建帮助说明卡片"""
        # QR 码导入说明
        self.qrHelpCard = CardWidget(self)
        qrHelpLayout = QVBoxLayout(self.qrHelpCard)
        qrHelpLayout.setContentsMargins(16, 12, 16, 12)

        qrHelpTitle = CaptionLabel("QR 码导入说明", self.qrHelpCard)
        qrHelpLayout.addWidget(qrHelpTitle)

        qrHelpText = BodyLabel(
            "1. 打开手机 Google Authenticator → 右上角菜单 → 导出账号\n"
            "2. 对生成的 QR 码截图并保存到电脑\n"
            "3. 点击「选择图片」或直接拖放截图到此窗口",
            self.qrHelpCard
        )
        qrHelpText.setWordWrap(True)
        qrHelpLayout.addWidget(qrHelpText)
        self.mainLayout.addWidget(self.qrHelpCard)

        # 文本导入说明
        self.textHelpCard = CardWidget(self)
        textHelpLayout = QVBoxLayout(self.textHelpCard)
        textHelpLayout.setContentsMargins(16, 12, 16, 12)

        textHelpTitle = CaptionLabel("文本导入说明", self.textHelpCard)
        textHelpLayout.addWidget(textHelpTitle)

        textHelpText = BodyLabel(
            "每行一条记录，格式：邮箱----密码----密钥\n"
            "示例：example@gmail.com----password123----ABCDEFGHIJKLMNOP\n"
            "注意：使用四个短横线 ---- 作为分隔符",
            self.textHelpCard
        )
        textHelpText.setWordWrap(True)
        textHelpLayout.addWidget(textHelpText)
        self.textHelpCard.setVisible(False)  # 默认隐藏
        self.mainLayout.addWidget(self.textHelpCard)

    def _createImportAreas(self):
        """创建导入内容区域"""
        # 使用 StackedWidget 切换不同导入模式的内容
        self.importStack = QStackedWidget(self)

        # QR 码导入区域
        self.qrImportWidget = self._createQRImportWidget()
        self.importStack.addWidget(self.qrImportWidget)

        # 文本导入区域
        self.textImportWidget = self._createTextImportWidget()
        self.importStack.addWidget(self.textImportWidget)

        self.importStack.setCurrentIndex(0)  # 默认 QR 码导入
        self.mainLayout.addWidget(self.importStack)

    def _createQRImportWidget(self) -> QWidget:
        """创建 QR 码导入区域"""
        widget = QWidget()
        layout = QHBoxLayout(widget)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        # 选择图片
        self.btnSelect = PrimaryPushButton(FIF.FOLDER, "选择图片", widget)
        self.btnSelect.setToolTip("选择单个 QR 码截图")
        self.btnSelect.clicked.connect(self._onSelectImage)
        layout.addWidget(self.btnSelect)

        # 批量选择
        self.btnSelectMultiple = PushButton(FIF.FOLDER_ADD, "批量选择", widget)
        self.btnSelectMultiple.setToolTip("选择多个 QR 码截图")
        self.btnSelectMultiple.clicked.connect(self._onSelectMultipleImages)
        layout.addWidget(self.btnSelectMultiple)

        layout.addSpacing(16)

        # 刷新匹配
        self.btnRefreshQR = TransparentPushButton(FIF.SYNC, "刷新匹配", widget)
        self.btnRefreshQR.clicked.connect(self._refreshMatch)
        layout.addWidget(self.btnRefreshQR)

        layout.addStretch()

        return widget

    def _createTextImportWidget(self) -> QWidget:
        """创建文本导入区域"""
        widget = CardWidget()
        layout = QVBoxLayout(widget)
        layout.setContentsMargins(16, 12, 16, 12)
        layout.setSpacing(8)

        # 文本输入区
        self.textInput = PlainTextEdit(widget)
        self.textInput.setPlaceholderText(
            "在此粘贴账号信息，每行一条，格式：\n"
            "邮箱----密码----密钥\n\n"
            "示例：\n"
            "example1@gmail.com----pass123----ABCDEFGHIJKLMNOP\n"
            "example2@gmail.com----pass456----QRSTUVWXYZ123456"
        )
        self.textInput.setMinimumHeight(120)
        self.textInput.setMaximumHeight(150)
        layout.addWidget(self.textInput)

        # 按钮行
        btnLayout = QHBoxLayout()
        btnLayout.setSpacing(8)

        self.btnParseText = PrimaryPushButton(FIF.SEARCH, "解析文本", widget)
        self.btnParseText.setToolTip("解析输入的文本并匹配数据库账号")
        self.btnParseText.clicked.connect(self._parseTextInput)
        btnLayout.addWidget(self.btnParseText)

        self.btnClearText = TransparentPushButton(FIF.DELETE, "清空", widget)
        self.btnClearText.clicked.connect(self._clearTextInput)
        btnLayout.addWidget(self.btnClearText)

        btnLayout.addSpacing(16)

        self.btnRefreshText = TransparentPushButton(FIF.SYNC, "刷新匹配", widget)
        self.btnRefreshText.clicked.connect(self._refreshMatch)
        btnLayout.addWidget(self.btnRefreshText)

        btnLayout.addStretch()

        # 格式提示
        formatHint = CaptionLabel("格式：邮箱----密码----密钥（四个短横线分隔）", widget)
        formatHint.setStyleSheet("color: #888888;")
        btnLayout.addWidget(formatHint)

        layout.addLayout(btnLayout)

        return widget

    def _onModeChanged(self, routeKey: str):
        """导入模式切换"""
        self._current_mode = routeKey

        if routeKey == "qr":
            self.importStack.setCurrentIndex(0)
            self.qrHelpCard.setVisible(True)
            self.textHelpCard.setVisible(False)
            self.statusLabel.setText("就绪 - 请选择 QR 码截图")
        else:
            self.importStack.setCurrentIndex(1)
            self.qrHelpCard.setVisible(False)
            self.textHelpCard.setVisible(True)
            self.statusLabel.setText("就绪 - 请粘贴账号文本")

    def _createTable(self) -> TableWidget:
        """创建结果表格"""
        table = TableWidget(self)
        table.setColumnCount(7)
        table.setHorizontalHeaderLabels([
            "选择", "提取邮箱", "来源", "密钥", "匹配账号", "当前密钥", "状态"
        ])

        # 设置列宽
        header = table.horizontalHeader()
        header.setStretchLastSection(False)

        # 列0: 选择 - 固定
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(0, 50)

        # 列1: 提取邮箱 - 拉伸
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)

        # 列2: 来源 - 固定
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(2, 80)

        # 列3: 密钥 - 固定
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(3, 160)

        # 列4: 匹配账号 - 拉伸
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.Stretch)

        # 列5: 当前密钥 - 固定
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Fixed)
        table.setColumnWidth(5, 100)

        # 列6: 状态 - 自适应
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.ResizeToContents)

        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)

        return table

    def _check_dependencies(self):
        """检查 QR 扫描依赖"""
        try:
            from core.totp_extractor.qr_scanner import check_dependencies
            available, error = check_dependencies()

            if not available:
                self.log(f"QR 扫描依赖缺失: {error}")
                self.btnSelect.setEnabled(False)
                self.btnSelectMultiple.setEnabled(False)
                self.dependencyLabel.setText("QR依赖缺失")
                self.dependencyLabel.setStyleSheet("color: #FF9800;")
            else:
                self.log("QR 扫描依赖已就绪")
                self.dependencyLabel.setText("就绪")
                self.dependencyLabel.setStyleSheet("color: #4CAF50;")
        except ImportError as e:
            self.log(f"无法加载 totp_extractor 模块: {e}")
            self.btnSelect.setEnabled(False)
            self.btnSelectMultiple.setEnabled(False)
            self.dependencyLabel.setText("模块缺失")
            self.dependencyLabel.setStyleSheet("color: #FF9800;")

    # ==================== 文本导入功能 ====================

    def _parseTextInput(self):
        """解析文本输入"""
        text = self.textInput.toPlainText().strip()

        if not text:
            self._showWarning("提示", "请先粘贴账号信息")
            return

        lines = text.split('\n')
        parsed_accounts = []
        error_lines = []

        self.log(f"\n开始解析文本，共 {len(lines)} 行...")

        for i, line in enumerate(lines, 1):
            line = line.strip()
            if not line:
                continue

            # 解析格式：邮箱----密码----密钥
            parts = line.split('----')

            if len(parts) < 3:
                error_lines.append((i, line, "格式错误：字段不足"))
                continue

            email = parts[0].strip()
            password = parts[1].strip()
            secret = parts[2].strip()

            # 验证邮箱格式
            if not email or '@' not in email:
                error_lines.append((i, line, f"邮箱格式无效: {email}"))
                continue

            # 验证密钥（允许为空则跳过，这里要求有密钥）
            if not secret:
                error_lines.append((i, line, "密钥为空"))
                continue

            # 创建账号对象
            account = TextOTPAccount(
                email=email,
                password=password,
                secret=secret.upper(),  # 密钥通常大写
                issuer="文本导入"
            )
            parsed_accounts.append(account)
            self.log(f"  解析成功: {email}")

        # 报告错误
        if error_lines:
            self.log(f"\n解析错误 {len(error_lines)} 行:")
            for line_num, content, reason in error_lines[:5]:
                short_content = content[:30] + "..." if len(content) > 30 else content
                self.log(f"  第 {line_num} 行: {reason}")
            if len(error_lines) > 5:
                self.log(f"  ... 等 {len(error_lines)} 行错误")

        if not parsed_accounts:
            self._showWarning("解析失败", f"未能解析任何有效账号\n\n共 {len(error_lines)} 行格式错误")
            return

        self._extracted_accounts = parsed_accounts
        self.log(f"\n共解析 {len(parsed_accounts)} 个有效账号")

        # 匹配数据库
        self._matchWithDatabase()

    def _clearTextInput(self):
        """清空文本输入"""
        self.textInput.clear()
        self.log("已清空文本输入")

    # ==================== QR 码导入功能 ====================

    def _onSelectImage(self):
        """选择单个图片"""
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            "选择 QR 码截图",
            "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.gif);;所有文件 (*.*)"
        )

        if file_path:
            self._processImages([file_path])

    def _onSelectMultipleImages(self):
        """选择多个图片"""
        file_paths, _ = QFileDialog.getOpenFileNames(
            self,
            "选择 QR 码截图",
            "",
            "图片文件 (*.png *.jpg *.jpeg *.bmp *.gif);;所有文件 (*.*)"
        )

        if file_paths:
            self._processImages(file_paths)

    def _processImages(self, file_paths: List[str]):
        """处理图片文件"""
        try:
            from core.totp_extractor import extract_totp_secrets_from_image

            self.progressBar.setVisible(True)
            self.progressBar.setRange(0, len(file_paths))

            all_accounts = []
            all_errors = []

            for i, path in enumerate(file_paths):
                self.progressBar.setValue(i)
                self.log(f"扫描: {os.path.basename(path)}")

                try:
                    accounts, errors = extract_totp_secrets_from_image(path)
                    all_accounts.extend(accounts)
                    all_errors.extend(errors)

                    if accounts:
                        self.log(f"  找到 {len(accounts)} 个账号")
                    if errors:
                        for err in errors:
                            self.log(f"  警告: {err}")

                except Exception as e:
                    self.log(f"  处理失败: {e}")

            self.progressBar.setValue(len(file_paths))
            self.progressBar.setVisible(False)

            if not all_accounts:
                self.log("未能从图片中提取任何账号")
                self._showWarning(
                    "未找到账号",
                    "未能从选择的图片中提取 TOTP 账号。\n\n"
                    "请确保图片包含有效的 Google Authenticator 导出 QR 码。"
                )
                return

            self._extracted_accounts = all_accounts
            self.log(f"\n共提取 {len(all_accounts)} 个账号")

            # 匹配数据库账号
            self._matchWithDatabase()

        except ImportError as e:
            self.log(f"模块导入失败: {e}")
            self._showError("错误", f"无法加载 QR 扫描模块:\n{e}")
        except Exception as e:
            self.log(f"处理失败: {e}")
            self._showError("错误", f"处理图片失败:\n{e}")

    # ==================== 匹配和表格 ====================

    def _matchWithDatabase(self):
        """与数据库账号匹配"""
        self.log("\n开始匹配数据库账号...")

        # 获取所有账号
        db_accounts = DBManager.get_all_accounts()
        db_email_map = {acc["email"].lower(): acc for acc in db_accounts}

        self._match_results = []

        for otp_acc in self._extracted_accounts:
            email = otp_acc.get_email()
            match_result = {
                "otp_account": otp_acc,
                "extracted_email": email,
                "db_account": None,
                "status": "no_match",
            }

            if email and email.lower() in db_email_map:
                db_acc = db_email_map[email.lower()]
                match_result["db_account"] = db_acc

                current_secret = db_acc.get("secret_key", "")
                if current_secret:
                    match_result["status"] = "has_secret"
                else:
                    match_result["status"] = "can_import"

            self._match_results.append(match_result)

        # 统计
        can_import = sum(1 for r in self._match_results if r["status"] == "can_import")
        has_secret = sum(1 for r in self._match_results if r["status"] == "has_secret")
        no_match = sum(1 for r in self._match_results if r["status"] == "no_match")

        self.log(f"  可导入: {can_import}")
        self.log(f"  已有密钥: {has_secret}")
        self.log(f"  未匹配: {no_match}")

        self.statusLabel.setText(f"可导入: {can_import} | 已有密钥: {has_secret} | 未匹配: {no_match}")

        # 更新表格
        self._updateTable()

    def _updateTable(self):
        """更新表格"""
        self.table.setRowCount(0)

        only_matched = self.chkOnlyMatched.isChecked()

        for result in self._match_results:
            # 过滤
            if only_matched and result["status"] == "no_match":
                continue

            row = self.table.rowCount()
            self.table.insertRow(row)

            otp_acc = result["otp_account"]
            db_acc = result["db_account"]
            status = result["status"]

            # 选择框
            checkbox = CheckBox()
            checkbox.setChecked(status == "can_import")
            checkbox.setEnabled(status in ("can_import", "has_secret"))
            checkbox.stateChanged.connect(self._updateSelectedCount)
            checkboxWidget = QWidget()
            checkboxLayout = QHBoxLayout(checkboxWidget)
            checkboxLayout.addWidget(checkbox)
            checkboxLayout.setAlignment(Qt.AlignmentFlag.AlignCenter)
            checkboxLayout.setContentsMargins(0, 0, 0, 0)
            self.table.setCellWidget(row, 0, checkboxWidget)

            # 提取邮箱
            email = result["extracted_email"] or otp_acc.name
            self.table.setItem(row, 1, QTableWidgetItem(email))

            # 来源（发行方）
            issuer = getattr(otp_acc, 'issuer', None) or "-"
            self.table.setItem(row, 2, QTableWidgetItem(issuer))

            # 密钥（显示前 16 位）
            secret = otp_acc.secret
            secret_display = secret[:16] + "..." if len(secret) > 16 else secret
            secret_item = QTableWidgetItem(secret_display)
            secret_item.setToolTip(secret)
            self.table.setItem(row, 3, secret_item)

            # 匹配账号
            if db_acc:
                self.table.setItem(row, 4, QTableWidgetItem(db_acc["email"]))
            else:
                item = QTableWidgetItem("未匹配")
                item.setForeground(QColor("#888888"))
                self.table.setItem(row, 4, item)

            # 当前密钥
            if db_acc:
                current = db_acc.get("secret_key", "")
                if current:
                    display = current[:8] + "..." if len(current) > 8 else current
                    self.table.setItem(row, 5, QTableWidgetItem(display))
                else:
                    item = QTableWidgetItem("无")
                    item.setForeground(QColor("#888888"))
                    self.table.setItem(row, 5, item)
            else:
                self.table.setItem(row, 5, QTableWidgetItem("-"))

            # 状态
            status_item = QTableWidgetItem(self.STATUS_TEXT.get(status, status))
            status_item.setForeground(QColor(self.STATUS_COLORS.get(status, "#888888")))
            self.table.setItem(row, 6, status_item)

        # 更新按钮状态
        self.btnImport.setEnabled(self.table.rowCount() > 0)
        self._updateSelectedCount()

    def _applyFilter(self):
        """应用过滤"""
        self._updateTable()

    def _refreshMatch(self):
        """刷新匹配"""
        if self._extracted_accounts:
            self._matchWithDatabase()

    # ==================== 全选功能 ====================

    def _getRowCheckbox(self, row: int) -> Optional[CheckBox]:
        """获取指定行的复选框"""
        checkbox_widget = self.table.cellWidget(row, 0)
        if checkbox_widget:
            return checkbox_widget.findChild(CheckBox)
        return None

    def _onSelectAllChanged(self, state):
        """全选复选框状态变化"""
        is_checked = state == Qt.CheckState.Checked.value

        for row in range(self.table.rowCount()):
            checkbox = self._getRowCheckbox(row)
            if checkbox and checkbox.isEnabled():
                checkbox.setChecked(is_checked)

        self._updateSelectedCount()

    def _updateSelectedCount(self):
        """更新选中计数"""
        count = sum(
            1 for row in range(self.table.rowCount())
            if (checkbox := self._getRowCheckbox(row)) and checkbox.isChecked()
        )
        self.selectedCountLabel.setText(f"已选: {count}")

    # ==================== 导入功能 ====================

    def _onImport(self):
        """导入选中的账号"""
        selected_results = []

        # 获取当前显示的匹配结果
        only_matched = self.chkOnlyMatched.isChecked()
        visible_results = [
            r for r in self._match_results
            if not only_matched or r["status"] != "no_match"
        ]

        for row in range(self.table.rowCount()):
            checkbox = self._getRowCheckbox(row)
            if checkbox and checkbox.isChecked() and row < len(visible_results):
                result = visible_results[row]
                if result["db_account"]:
                    selected_results.append(result)

        if not selected_results:
            self._showInfo("提示", "请选择要导入的账号")
            return

        # 确认导入
        overwrite_count = sum(1 for r in selected_results if r["status"] == "has_secret")
        new_count = len(selected_results) - overwrite_count

        # 检查是否有密码需要更新
        password_update_count = sum(
            1 for r in selected_results
            if isinstance(r["otp_account"], TextOTPAccount) and r["otp_account"].password
        )

        msg = f"即将导入 {len(selected_results)} 个账号的 TOTP 密钥:\n\n"
        msg += f"  新增密钥: {new_count} 个\n"
        if overwrite_count > 0:
            msg += f"  覆盖已有: {overwrite_count} 个\n"
        if password_update_count > 0:
            msg += f"  同时更新密码: {password_update_count} 个\n"
        msg += "\n确定要继续吗？"

        w = MessageBox("确认导入", msg, self)
        if not w.exec():
            return

        # 显示进度条并禁用按钮
        self.progressBar.setVisible(True)
        self.progressBar.setRange(0, len(selected_results))
        self.progressBar.setValue(0)
        self.btnImport.setEnabled(False)

        # 创建并启动工作线程
        self._import_worker = ImportWorker(selected_results, self)
        self._import_worker.progress.connect(self._onImportProgress)
        self._import_worker.log_message.connect(self.log)
        self._import_worker.finished_import.connect(self._onImportFinished)
        self._import_worker.start()

    def _onImportProgress(self, current: int, total: int):
        """导入进度更新"""
        self.progressBar.setValue(current)

    def _onImportFinished(self, success: int, total: int, password: int, bind: int, ix_update: int, failed_list: list, warning_list: list):
        """导入完成"""
        # 进度条保持显示，显示完成状态
        self.progressBar.setValue(total)  # 确保显示100%
        self.btnImport.setEnabled(True)

        failed_count = len(failed_list)
        warning_count = len(warning_list)

        # 记录日志
        self.log(f"\n{'='*40}")
        self.log(f"导入完成: 成功 {success}/{total}")
        if failed_count > 0:
            self.log(f"失败 {failed_count} 个:")
            for item in failed_list:
                self.log(f"  ✗ {item['email']}: {item['error']}")
        if warning_count > 0:
            self.log(f"警告 {warning_count} 个 (密钥已导入，但窗口更新失败):")
            for item in warning_list:
                self.log(f"  ⚠ {item['email']}: {item['warning']}")
        if password > 0:
            self.log(f"已更新 {password} 个密码")
        if bind > 0:
            self.log(f"已自动绑定 {bind} 个窗口")
        if ix_update > 0:
            self.log(f"已更新 {ix_update} 个窗口备注")
        self.log(f"{'='*40}")

        # 显示结果
        result_msg = f"成功导入 {success}/{total} 个账号的 TOTP 密钥"
        if failed_count > 0:
            result_msg += f"\n✗ 失败 {failed_count} 个"
        if warning_count > 0:
            result_msg += f"\n⚠ 警告 {warning_count} 个（窗口更新失败）"
        if password > 0:
            result_msg += f"\n已更新 {password} 个密码"
        if bind > 0:
            result_msg += f"\n已自动绑定 {bind} 个窗口"
        if ix_update > 0:
            result_msg += f"\n已更新 {ix_update} 个窗口备注"

        if failed_count > 0:
            self._showError("导入完成（有失败）", result_msg)
        elif warning_count > 0:
            self._showWarning("导入完成（有警告）", result_msg)
        else:
            self._showInfo("导入完成", result_msg)

        # 刷新匹配
        self._refreshMatch()

    # ==================== 日志和消息 ====================

    def log(self, msg: str):
        """添加日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.logText.append(f"[{timestamp}] {msg}")
        scrollbar = self.logText.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())

    def _showInfo(self, title: str, content: str):
        """显示信息提示"""
        InfoBar.info(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=3000,
            parent=self
        )

    def _showWarning(self, title: str, content: str):
        """显示警告提示"""
        InfoBar.warning(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=4000,
            parent=self
        )

    def _showError(self, title: str, content: str):
        """显示错误提示"""
        InfoBar.error(
            title=title,
            content=content,
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=5000,
            parent=self
        )

    # ==================== 拖放支持 ====================

    def dragEnterEvent(self, event: QDragEnterEvent):
        """拖入事件"""
        # 仅在 QR 码模式下接受拖放
        if self._current_mode != "qr":
            event.ignore()
            return

        if event.mimeData().hasUrls():
            for url in event.mimeData().urls():
                if url.isLocalFile():
                    path = url.toLocalFile().lower()
                    if any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".bmp", ".gif")):
                        event.acceptProposedAction()
                        return
        event.ignore()

    def dropEvent(self, event: QDropEvent):
        """放下事件"""
        if self._current_mode != "qr":
            return

        file_paths = []
        for url in event.mimeData().urls():
            if url.isLocalFile():
                path = url.toLocalFile()
                if any(path.lower().endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".bmp", ".gif")):
                    file_paths.append(path)

        if file_paths:
            self._processImages(file_paths)

    def refresh(self):
        """刷新数据（供外部调用）"""
        if self._extracted_accounts:
            self._matchWithDatabase()
