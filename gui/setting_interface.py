"""
设置界面 - Fluent Design 版本
包含账号管理、卡片管理、代理管理、AI配置、外观设置等
"""
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtWidgets import (
    QVBoxLayout, QHBoxLayout, QWidget, QFileDialog,
    QStackedWidget, QFormLayout, QTabWidget, QApplication,
    QLabel,
)

from qfluentwidgets import (
    ScrollArea, LineEdit, SpinBox, ComboBox, EditableComboBox,
    CardWidget, TitleLabel, SubtitleLabel,
    PrimaryPushButton, PushButton, TransparentPushButton,
    FluentIcon as FIF, Pivot,
    setTheme, Theme, InfoBar, InfoBarPosition, MessageBox,
)
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
    """测试 AI 连接的后台线程"""
    finished_signal = pyqtSignal(bool, str, dict)

    def __init__(self, api_key: str, base_url: str, model: str, provider: str = "gemini"):
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
                except Exception:
                    pass

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


class ConfigTab(ScrollArea):
    """配置设置标签页 - 使用 QFormLayout 简化布局"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName('configTab')

        self.scrollWidget = QWidget()
        self.vBoxLayout = QVBoxLayout(self.scrollWidget)

        self.setWidget(self.scrollWidget)
        self.setWidgetResizable(True)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setViewportMargins(0, 0, 0, 0)

        self._testWorker = None
        self._currentTestBtn = None
        self._currentTestBtnText = ""
        self._currentTestProvider = ""

        self._initUI()
        self._loadConfig()

    def _createLabel(self, text: str) -> QLabel:
        """创建标准标签"""
        label = QLabel(text)
        label.setMinimumWidth(120)
        return label

    def _initUI(self):
        """初始化界面"""
        self.vBoxLayout.setContentsMargins(20, 20, 20, 20)
        self.vBoxLayout.setSpacing(16)

        from PyQt6.QtWidgets import QLineEdit as QLE

        # ===== SheerID API 配置 =====
        apiGroup = self._createGroupBox("API 设置")
        apiLayout = QFormLayout()
        apiLayout.setSpacing(12)
        apiLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.sheeridApiKeyInput = LineEdit()
        self.sheeridApiKeyInput.setPlaceholderText("SheerID API Key")
        self.sheeridApiKeyInput.setEchoMode(QLE.EchoMode.Password)
        apiLayout.addRow(self._createLabel("SheerID API Key:"), self.sheeridApiKeyInput)

        apiGroup.layout().addLayout(apiLayout)
        self.vBoxLayout.addWidget(apiGroup)

        # ===== AI Agent 配置 (多提供商) =====
        aiGroup = self._createGroupBox("🤖 AI Agent 配置 (多提供商)")
        aiMainLayout = QVBoxLayout()
        aiMainLayout.setSpacing(12)

        # 默认提供商选择
        providerLayout = QHBoxLayout()
        providerLayout.addWidget(self._createLabel("默认提供商:"))
        self.aiProviderCombo = ComboBox()
        self.aiProviderCombo.addItems(["gemini", "anthropic"])
        self.aiProviderCombo.currentTextChanged.connect(self._onProviderChanged)
        providerLayout.addWidget(self.aiProviderCombo)
        providerLayout.addStretch()
        aiMainLayout.addLayout(providerLayout)

        # 提供商配置选项卡
        self.aiProviderTabs = QTabWidget()

        # Gemini 配置标签页
        geminiTab = QWidget()
        geminiLayout = QFormLayout(geminiTab)
        geminiLayout.setContentsMargins(10, 10, 10, 10)
        geminiLayout.setSpacing(10)
        geminiLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.geminiApiKeyInput = LineEdit()
        self.geminiApiKeyInput.setPlaceholderText("Gemini API Key（或从环境变量 GEMINI_API_KEY 读取）")
        self.geminiApiKeyInput.setEchoMode(QLE.EchoMode.Password)
        geminiLayout.addRow(self._createLabel("API Key:"), self.geminiApiKeyInput)

        self.geminiBaseUrlInput = LineEdit()
        self.geminiBaseUrlInput.setPlaceholderText("留空使用 Gemini 官方 API")
        geminiLayout.addRow(self._createLabel("Base URL:"), self.geminiBaseUrlInput)

        self.geminiModelCombo = EditableComboBox()
        self.geminiModelCombo.addItems([
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.5-flash-lite",
        ])
        geminiLayout.addRow(self._createLabel("模型:"), self.geminiModelCombo)

        # Gemini 测试按钮
        geminiBtnLayout = QHBoxLayout()
        self.geminiTestBtn = PushButton(FIF.SEND, "测试 Gemini 连接")
        self.geminiTestBtn.clicked.connect(lambda: self._testProviderConnection("gemini"))
        geminiBtnLayout.addWidget(self.geminiTestBtn)
        geminiBtnLayout.addStretch()
        geminiLayout.addRow(self._createLabel(""), geminiBtnLayout)

        self.aiProviderTabs.addTab(geminiTab, "🔷 Gemini")

        # Anthropic 配置标签页
        anthropicTab = QWidget()
        anthropicLayout = QFormLayout(anthropicTab)
        anthropicLayout.setContentsMargins(10, 10, 10, 10)
        anthropicLayout.setSpacing(10)
        anthropicLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.anthropicApiKeyInput = LineEdit()
        self.anthropicApiKeyInput.setPlaceholderText("Anthropic API Key（或从环境变量 ANTHROPIC_API_KEY 读取）")
        self.anthropicApiKeyInput.setEchoMode(QLE.EchoMode.Password)
        anthropicLayout.addRow(self._createLabel("API Key:"), self.anthropicApiKeyInput)

        self.anthropicBaseUrlInput = LineEdit()
        self.anthropicBaseUrlInput.setPlaceholderText("留空使用官方 API，或填写第三方兼容服务 URL")
        anthropicLayout.addRow(self._createLabel("Base URL:"), self.anthropicBaseUrlInput)

        self.anthropicModelCombo = EditableComboBox()
        self.anthropicModelCombo.addItems([
            "claude-sonnet-4-20250514",
            "claude-3-5-sonnet-20241022",
            "claude-3-opus-20240229",
            "claude-3-haiku-20240307",
        ])
        anthropicLayout.addRow(self._createLabel("模型:"), self.anthropicModelCombo)

        # 第三方服务提示
        anthropicHint = QLabel("💡 支持第三方 Claude API 服务，如 OpenRouter、Together 等")
        anthropicHint.setStyleSheet("color: #666666; font-size: 11px;")
        anthropicHint.setWordWrap(True)
        anthropicLayout.addRow(self._createLabel(""), anthropicHint)

        # Anthropic 测试按钮
        anthropicBtnLayout = QHBoxLayout()
        self.anthropicTestBtn = PushButton(FIF.SEND, "测试 Anthropic 连接")
        self.anthropicTestBtn.clicked.connect(lambda: self._testProviderConnection("anthropic"))
        anthropicBtnLayout.addWidget(self.anthropicTestBtn)
        anthropicBtnLayout.addStretch()
        anthropicLayout.addRow(self._createLabel(""), anthropicBtnLayout)

        self.aiProviderTabs.addTab(anthropicTab, "🟠 Anthropic/Claude")

        aiMainLayout.addWidget(self.aiProviderTabs)

        # 通用配置
        commonLayout = QFormLayout()
        commonLayout.setSpacing(10)
        commonLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.maxStepsSpin = SpinBox()
        self.maxStepsSpin.setRange(5, 50)
        self.maxStepsSpin.setValue(25)
        commonLayout.addRow(self._createLabel("最大步骤:"), self.maxStepsSpin)

        aiHint = QLabel("💡 AI Agent 用于智能浏览器自动化任务（修改2SV手机、替换辅助邮箱等）")
        aiHint.setStyleSheet("color: #666666; font-size: 11px;")
        aiHint.setWordWrap(True)
        commonLayout.addRow(self._createLabel(""), aiHint)

        aiMainLayout.addLayout(commonLayout)
        aiGroup.layout().addLayout(aiMainLayout)
        self.vBoxLayout.addWidget(aiGroup)

        # ===== Gmail IMAP 配置 =====
        gmailGroup = self._createGroupBox("Gmail 验证码邮箱（替换辅助邮箱功能）")
        gmailLayout = QFormLayout()
        gmailLayout.setSpacing(10)
        gmailLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.gmailEmailInput = LineEdit()
        self.gmailEmailInput.setPlaceholderText("example@gmail.com")
        gmailLayout.addRow(self._createLabel("Gmail 邮箱:"), self.gmailEmailInput)

        self.gmailPasswordInput = LineEdit()
        self.gmailPasswordInput.setPlaceholderText("应用专用密码（非登录密码）")
        self.gmailPasswordInput.setEchoMode(QLE.EchoMode.Password)
        gmailLayout.addRow(self._createLabel("应用密码:"), self.gmailPasswordInput)

        # 提示
        gmailHint = QLabel("提示: 需在 Google 账号设置中生成「应用专用密码」")
        gmailHint.setStyleSheet("color: #666666; font-size: 11px;")
        gmailLayout.addRow(self._createLabel(""), gmailHint)

        # 应用密码获取链接
        gmailLinkLayout = QHBoxLayout()
        gmailLinkLabel = QLabel("获取应用密码: https://myaccount.google.com/apppasswords")
        gmailLinkLabel.setStyleSheet("color: #1976D2; font-size: 11px;")
        gmailLinkLayout.addWidget(gmailLinkLabel)

        self.copyLinkBtn = TransparentPushButton(FIF.COPY, "复制链接")
        self.copyLinkBtn.setFixedWidth(90)
        self.copyLinkBtn.clicked.connect(lambda: self._copyToClipboard("https://myaccount.google.com/apppasswords"))
        gmailLinkLayout.addWidget(self.copyLinkBtn)
        gmailLinkLayout.addStretch()
        gmailLayout.addRow(self._createLabel(""), gmailLinkLayout)

        gmailGroup.layout().addLayout(gmailLayout)
        self.vBoxLayout.addWidget(gmailGroup)

        # ===== 超时设置 =====
        timeoutGroup = self._createGroupBox("超时设置 (秒)")
        timeoutLayout = QFormLayout()
        timeoutLayout.setSpacing(10)
        timeoutLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.pageLoadSpin = SpinBox()
        self.pageLoadSpin.setRange(10, 120)
        self.pageLoadSpin.setValue(30)
        timeoutLayout.addRow(self._createLabel("页面加载:"), self.pageLoadSpin)

        self.statusCheckSpin = SpinBox()
        self.statusCheckSpin.setRange(5, 60)
        self.statusCheckSpin.setValue(20)
        timeoutLayout.addRow(self._createLabel("状态检测:"), self.statusCheckSpin)

        self.iframeWaitSpin = SpinBox()
        self.iframeWaitSpin.setRange(5, 60)
        self.iframeWaitSpin.setValue(15)
        timeoutLayout.addRow(self._createLabel("Iframe 等待:"), self.iframeWaitSpin)

        timeoutGroup.layout().addLayout(timeoutLayout)
        self.vBoxLayout.addWidget(timeoutGroup)

        # ===== 操作延迟设置 =====
        delayGroup = self._createGroupBox("操作延迟 (秒)")
        delayLayout = QFormLayout()
        delayLayout.setSpacing(10)
        delayLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.delayLoginSpin = SpinBox()
        self.delayLoginSpin.setRange(1, 30)
        self.delayLoginSpin.setValue(3)
        delayLayout.addRow(self._createLabel("登录后:"), self.delayLoginSpin)

        self.delayOfferSpin = SpinBox()
        self.delayOfferSpin.setRange(1, 30)
        self.delayOfferSpin.setValue(8)
        delayLayout.addRow(self._createLabel("Offer 后:"), self.delayOfferSpin)

        self.delayAddCardSpin = SpinBox()
        self.delayAddCardSpin.setRange(1, 30)
        self.delayAddCardSpin.setValue(10)
        delayLayout.addRow(self._createLabel("添加卡后:"), self.delayAddCardSpin)

        self.delaySaveSpin = SpinBox()
        self.delaySaveSpin.setRange(1, 60)
        self.delaySaveSpin.setValue(18)
        delayLayout.addRow(self._createLabel("保存后:"), self.delaySaveSpin)

        delayGroup.layout().addLayout(delayLayout)
        self.vBoxLayout.addWidget(delayGroup)

        # ===== 代理设置 =====
        proxyGroup = self._createGroupBox("🌐 代理设置")
        proxyLayout = QFormLayout()
        proxyLayout.setSpacing(10)
        proxyLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.proxyMaxWindowsSpin = SpinBox()
        self.proxyMaxWindowsSpin.setRange(1, 100)
        self.proxyMaxWindowsSpin.setValue(3)
        proxyLayout.addRow(self._createLabel("每IP最大窗口数:"), self.proxyMaxWindowsSpin)

        proxyHint = QLabel("提示: 批量创建窗口时，每个代理IP最多分配给指定数量的窗口")
        proxyHint.setStyleSheet("color: #666666; font-size: 11px;")
        proxyHint.setWordWrap(True)
        proxyLayout.addRow(self._createLabel(""), proxyHint)

        proxyGroup.layout().addLayout(proxyLayout)
        self.vBoxLayout.addWidget(proxyGroup)

        # ===== 其他设置 =====
        otherGroup = self._createGroupBox("其他设置")
        otherLayout = QFormLayout()
        otherLayout.setSpacing(10)
        otherLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.threadCountSpin = SpinBox()
        self.threadCountSpin.setRange(1, 20)
        self.threadCountSpin.setValue(3)
        otherLayout.addRow(self._createLabel("默认并发数:"), self.threadCountSpin)

        otherGroup.layout().addLayout(otherLayout)
        self.vBoxLayout.addWidget(otherGroup)

        # ===== 外观配置 =====
        appearanceGroup = self._createGroupBox("外观")
        appearanceLayout = QFormLayout()
        appearanceLayout.setSpacing(10)
        appearanceLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.themeCombo = ComboBox()
        self.themeCombo.addItems(["跟随系统", "浅色", "深色"])
        self.themeCombo.currentIndexChanged.connect(self._onThemeChanged)
        appearanceLayout.addRow(self._createLabel("应用主题:"), self.themeCombo)

        appearanceGroup.layout().addLayout(appearanceLayout)
        self.vBoxLayout.addWidget(appearanceGroup)

        # ===== 数据配置 =====
        dataGroup = self._createGroupBox("数据")
        dataLayout = QFormLayout()
        dataLayout.setSpacing(10)
        dataLayout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        # 数据目录
        dataDirLayout = QHBoxLayout()
        self.dataDirLabel = QLabel("未设置")
        self.dataDirLabel.setStyleSheet("color: #666666;")
        dataDirLayout.addWidget(self.dataDirLabel, 1)
        self.selectDirBtn = PushButton(FIF.FOLDER, "选择目录")
        self.selectDirBtn.clicked.connect(self._onSelectDataDir)
        dataDirLayout.addWidget(self.selectDirBtn)
        dataLayout.addRow(self._createLabel("数据目录:"), dataDirLayout)

        self.separatorInput = LineEdit()
        self.separatorInput.setText("----")
        self.separatorInput.setPlaceholderText("账号文件字段分隔符")
        dataLayout.addRow(self._createLabel("数据分隔符:"), self.separatorInput)

        dataGroup.layout().addLayout(dataLayout)
        self.vBoxLayout.addWidget(dataGroup)

        # ===== 保存和重置按钮 =====
        btnLayout = QHBoxLayout()
        btnLayout.addStretch()

        self.saveBtn = PrimaryPushButton(FIF.SAVE, "保存配置")
        self.saveBtn.setFixedWidth(150)
        self.saveBtn.clicked.connect(self._saveConfig)
        btnLayout.addWidget(self.saveBtn)

        self.resetBtn = PushButton(FIF.SYNC, "恢复默认")
        self.resetBtn.setFixedWidth(150)
        self.resetBtn.clicked.connect(self._resetToDefault)
        btnLayout.addWidget(self.resetBtn)

        self.vBoxLayout.addLayout(btnLayout)
        self.vBoxLayout.addStretch(1)

    def _createGroupBox(self, title: str) -> CardWidget:
        """创建分组卡片"""
        card = CardWidget(self.scrollWidget)
        cardLayout = QVBoxLayout(card)
        cardLayout.setContentsMargins(16, 16, 16, 16)
        cardLayout.setSpacing(12)

        # 标题
        titleLabel = SubtitleLabel(title, card)
        cardLayout.addWidget(titleLabel)

        return card

    def _onProviderChanged(self, provider: str):
        """切换默认提供商时切换标签页"""
        if provider == "gemini":
            self.aiProviderTabs.setCurrentIndex(0)
        elif provider == "anthropic":
            self.aiProviderTabs.setCurrentIndex(1)

    def _testProviderConnection(self, provider: str):
        """测试指定提供商的连接"""
        if provider == "gemini":
            api_key = self.geminiApiKeyInput.text().strip() or ConfigManager.get_ai_provider_api_key("gemini")
            base_url = self.geminiBaseUrlInput.text().strip() or ConfigManager.get_ai_provider_base_url("gemini")
            model = self.geminiModelCombo.currentText().strip() or ConfigManager.get_ai_provider_model("gemini")
            btn = self.geminiTestBtn
        else:
            api_key = self.anthropicApiKeyInput.text().strip() or ConfigManager.get_ai_provider_api_key("anthropic")
            base_url = self.anthropicBaseUrlInput.text().strip() or ConfigManager.get_ai_provider_base_url("anthropic")
            model = self.anthropicModelCombo.currentText().strip() or ConfigManager.get_ai_provider_model("anthropic")
            btn = self.anthropicTestBtn

        if not api_key:
            InfoBar.warning(
                title="警告",
                content=f"请先输入 {provider.upper()} API Key",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )
            return

        # 禁用按钮，显示进度
        btn.setEnabled(False)
        self._currentTestBtn = btn
        self._currentTestBtnText = btn.text()
        self._currentTestProvider = provider
        btn.setText("测试中...")

        # 创建测试线程
        self._testWorker = TestAIConnectionWorker(api_key, base_url, model, provider)
        self._testWorker.finished_signal.connect(self._onTestFinished)
        self._testWorker.start()

    def _onTestFinished(self, success: bool, message: str, details: dict):
        """测试完成回调"""
        # 恢复按钮状态
        if self._currentTestBtn:
            self._currentTestBtn.setEnabled(True)
            self._currentTestBtn.setText(self._currentTestBtnText)

        provider = self._currentTestProvider or 'AI'

        if success:
            # 构建详细信息
            detail_msg = f"提供商: {details.get('provider', provider).upper()}\n"
            detail_msg += f"模型: {details.get('model', 'N/A')}\n"
            detail_msg += f"响应时间: {details.get('response_time_ms', 0)}ms"

            InfoBar.success(
                title="连接成功",
                content=detail_msg,
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=5000,
                parent=self
            )
        else:
            InfoBar.error(
                title="连接失败",
                content=message,
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=5000,
                parent=self
            )

    def _copyToClipboard(self, text: str):
        """复制文本到剪贴板"""
        clipboard = QApplication.clipboard()
        clipboard.setText(text)
        self.copyLinkBtn.setText("已复制!")
        QTimer.singleShot(1500, lambda: self.copyLinkBtn.setText("复制链接"))

    def _loadConfig(self):
        """从配置加载到 UI"""
        try:
            ConfigManager.load()

            # SheerID API Key
            self.sheeridApiKeyInput.setText(
                ConfigManager.get_api_key())

            # AI Agent 配置 - 默认提供商
            default_provider = ConfigManager.get_ai_default_provider()
            idx = self.aiProviderCombo.findText(default_provider)
            if idx >= 0:
                self.aiProviderCombo.setCurrentIndex(idx)

            # Gemini 配置
            self.geminiApiKeyInput.setText(ConfigManager.get_ai_provider_api_key("gemini"))
            self.geminiBaseUrlInput.setText(ConfigManager.get_ai_provider_base_url("gemini"))
            gemini_model = ConfigManager.get_ai_provider_model("gemini")
            if gemini_model:
                self.geminiModelCombo.setCurrentText(gemini_model)

            # Anthropic 配置
            self.anthropicApiKeyInput.setText(ConfigManager.get_ai_provider_api_key("anthropic"))
            self.anthropicBaseUrlInput.setText(ConfigManager.get_ai_provider_base_url("anthropic"))
            anthropic_model = ConfigManager.get_ai_provider_model("anthropic")
            if anthropic_model:
                self.anthropicModelCombo.setCurrentText(anthropic_model)

            # 通用配置
            self.maxStepsSpin.setValue(ConfigManager.get_ai_max_steps())

            # Gmail IMAP
            self.gmailEmailInput.setText(ConfigManager.get("gmail_imap_email", ""))
            self.gmailPasswordInput.setText(ConfigManager.get_gmail_imap_password())

            # 超时设置
            self.pageLoadSpin.setValue(ConfigManager.get("timeouts.page_load", 30))
            self.statusCheckSpin.setValue(ConfigManager.get("timeouts.status_check", 20))
            self.iframeWaitSpin.setValue(ConfigManager.get("timeouts.iframe_wait", 15))

            # 延迟设置
            self.delayLoginSpin.setValue(ConfigManager.get("delays.after_login", 3))
            self.delayOfferSpin.setValue(ConfigManager.get("delays.after_offer", 8))
            self.delayAddCardSpin.setValue(ConfigManager.get("delays.after_add_card", 10))
            self.delaySaveSpin.setValue(ConfigManager.get("delays.after_save", 18))

            # 代理设置
            self.proxyMaxWindowsSpin.setValue(ConfigManager.get("proxy.max_windows_per_ip", 3))

            # 其他设置
            self.threadCountSpin.setValue(ConfigManager.get("default_thread_count", 3))

            # 主题
            theme_map = {"auto": 0, "light": 1, "dark": 2}
            current_theme = ConfigManager.get("theme", "auto")
            self.themeCombo.setCurrentIndex(theme_map.get(current_theme, 0))

            # 数据目录
            data_dir = ConfigManager.get("data_dir", "")
            if data_dir:
                self.dataDirLabel.setText(data_dir)

            # 分隔符
            self.separatorInput.setText(
                ConfigManager.get("data_separator", "----"))

        except Exception as e:
            print(f"[Config] 加载配置失败: {e}")

    def _saveConfig(self):
        """保存配置"""
        try:
            # SheerID API Key
            ConfigManager.set_api_key(self.sheeridApiKeyInput.text().strip())

            # AI Agent 配置 - 默认提供商
            ConfigManager.set_ai_default_provider(self.aiProviderCombo.currentText())

            # Gemini 配置
            gemini_api_key = self.geminiApiKeyInput.text().strip()
            if gemini_api_key:
                ConfigManager.set_ai_provider_api_key("gemini", gemini_api_key)
            ConfigManager.set_ai_provider_base_url("gemini", self.geminiBaseUrlInput.text().strip())
            ConfigManager.set_ai_provider_model("gemini", self.geminiModelCombo.currentText().strip())

            # Anthropic 配置
            anthropic_api_key = self.anthropicApiKeyInput.text().strip()
            if anthropic_api_key:
                ConfigManager.set_ai_provider_api_key("anthropic", anthropic_api_key)
            ConfigManager.set_ai_provider_base_url("anthropic", self.anthropicBaseUrlInput.text().strip())
            ConfigManager.set_ai_provider_model("anthropic", self.anthropicModelCombo.currentText().strip())

            # 通用配置
            ConfigManager.set_ai_max_steps(self.maxStepsSpin.value())

            # Gmail IMAP
            ConfigManager.set("gmail_imap_email", self.gmailEmailInput.text().strip())
            ConfigManager.set_gmail_imap_password(self.gmailPasswordInput.text())

            # 超时设置
            ConfigManager.set("timeouts.page_load", self.pageLoadSpin.value())
            ConfigManager.set("timeouts.status_check", self.statusCheckSpin.value())
            ConfigManager.set("timeouts.iframe_wait", self.iframeWaitSpin.value())

            # 延迟设置
            ConfigManager.set("delays.after_login", self.delayLoginSpin.value())
            ConfigManager.set("delays.after_offer", self.delayOfferSpin.value())
            ConfigManager.set("delays.after_add_card", self.delayAddCardSpin.value())
            ConfigManager.set("delays.after_save", self.delaySaveSpin.value())

            # 代理设置
            ConfigManager.set("proxy.max_windows_per_ip", self.proxyMaxWindowsSpin.value())

            # 其他设置
            ConfigManager.set("default_thread_count", self.threadCountSpin.value())

            # 主题
            theme_values = ["auto", "light", "dark"]
            ConfigManager.set("theme", theme_values[self.themeCombo.currentIndex()])

            # 分隔符
            ConfigManager.set("data_separator", self.separatorInput.text().strip())

            ConfigManager.save()

            InfoBar.success(
                title="保存成功",
                content="配置已保存",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )
        except Exception as e:
            InfoBar.error(
                title="保存失败",
                content=str(e),
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=3000,
                parent=self
            )

    def _resetToDefault(self):
        """恢复默认设置"""
        w = MessageBox(
            "确认恢复",
            "确定要恢复默认设置吗？",
            self
        )
        if w.exec():
            # SheerID
            self.sheeridApiKeyInput.setText("")

            # AI Agent - 默认提供商
            self.aiProviderCombo.setCurrentText("gemini")

            # Gemini
            self.geminiApiKeyInput.setText("")
            self.geminiBaseUrlInput.setText("")
            self.geminiModelCombo.setCurrentText("gemini-2.5-flash")

            # Anthropic
            self.anthropicApiKeyInput.setText("")
            self.anthropicBaseUrlInput.setText("")
            self.anthropicModelCombo.setCurrentText("claude-sonnet-4-20250514")

            # 通用
            self.maxStepsSpin.setValue(25)

            # Gmail
            self.gmailEmailInput.setText("")
            self.gmailPasswordInput.setText("")

            # 超时
            self.pageLoadSpin.setValue(30)
            self.statusCheckSpin.setValue(20)
            self.iframeWaitSpin.setValue(15)

            # 延迟
            self.delayLoginSpin.setValue(3)
            self.delayOfferSpin.setValue(8)
            self.delayAddCardSpin.setValue(10)
            self.delaySaveSpin.setValue(18)

            # 代理
            self.proxyMaxWindowsSpin.setValue(3)

            # 其他
            self.threadCountSpin.setValue(3)

            # 主题
            self.themeCombo.setCurrentIndex(0)

            # 分隔符
            self.separatorInput.setText("----")

            InfoBar.success(
                title="已恢复",
                content="设置已恢复为默认值",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )

    def _onThemeChanged(self, index: int):
        """主题切换"""
        themes = [Theme.AUTO, Theme.LIGHT, Theme.DARK]
        setTheme(themes[index])

    def _onSelectDataDir(self):
        """选择数据目录"""
        folder = QFileDialog.getExistingDirectory(self, "选择数据目录")
        if folder:
            self.dataDirLabel.setText(folder)
            ConfigManager.set("data_dir", folder)
            InfoBar.success(
                title="已设置",
                content=f"数据目录: {folder}",
                orient=Qt.Orientation.Horizontal,
                isClosable=True,
                position=InfoBarPosition.TOP,
                duration=2000,
                parent=self
            )


class SettingInterface(QWidget):
    """设置界面 - 包含多个标签页"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName('settingInterface')
        self._initUI()

    def _initUI(self):
        """初始化界面"""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(36, 20, 36, 20)
        layout.setSpacing(16)

        # 标题
        titleLabel = TitleLabel("设置", self)
        layout.addWidget(titleLabel)

        # Pivot 标签页导航
        self.pivot = Pivot(self)
        layout.addWidget(self.pivot)

        # 堆叠页面
        self.stackedWidget = QStackedWidget(self)
        layout.addWidget(self.stackedWidget, 1)

        # 创建各个标签页
        self._createTabs()

    def _onPivotChanged(self, routeKey: str):
        """Pivot 标签页切换处理"""
        tabMap = {
            'accounts': self.accountsTab,
            'cards': self.cardsTab,
            'proxies': self.proxiesTab,
            'config': self.configTab,
        }
        widget = tabMap.get(routeKey)
        if widget:
            self.stackedWidget.setCurrentWidget(widget)

    def _createTabs(self):
        """创建标签页"""
        # 账号管理
        from gui.data_management.accounts_tab import AccountsTab
        self.accountsTab = AccountsTab(self)
        self.stackedWidget.addWidget(self.accountsTab)
        self.pivot.addItem(
            routeKey='accounts',
            text='账号管理',
            onClick=lambda: self._onPivotChanged('accounts')
        )

        # 卡片管理
        from gui.data_management.cards_tab import CardsTab
        self.cardsTab = CardsTab(self)
        self.stackedWidget.addWidget(self.cardsTab)
        self.pivot.addItem(
            routeKey='cards',
            text='卡片管理',
            onClick=lambda: self._onPivotChanged('cards')
        )

        # 代理管理
        from gui.data_management.proxies_tab import ProxiesTab
        self.proxiesTab = ProxiesTab(self)
        self.stackedWidget.addWidget(self.proxiesTab)
        self.pivot.addItem(
            routeKey='proxies',
            text='代理管理',
            onClick=lambda: self._onPivotChanged('proxies')
        )

        # 配置设置
        self.configTab = ConfigTab(self)
        self.stackedWidget.addWidget(self.configTab)
        self.pivot.addItem(
            routeKey='config',
            text='配置设置',
            onClick=lambda: self._onPivotChanged('config')
        )

        # 默认选中第一个
        self.pivot.setCurrentItem('accounts')
        self.stackedWidget.setCurrentWidget(self.accountsTab)
