"""
Fluent UI 子界面基类
提供所有功能子界面的通用基础结构
"""
from PyQt6.QtCore import Qt, pyqtSignal
from PyQt6.QtWidgets import QFrame, QVBoxLayout, QHBoxLayout, QWidget

from qfluentwidgets import (
    CardWidget, TextEdit, ProgressBar, ProgressRing,
    TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
    PushButton, PrimaryPushButton, TransparentPushButton,
    setFont, IndeterminateProgressRing,
)

from gui.fluent_utils import LOG_AREA_STYLE, LOG_AREA_MAX_HEIGHT, CONTENT_MARGINS


class BaseInterface(QFrame):
    """
    子界面基类

    提供通用的布局结构：
    - 标题区
    - 内容区（子类实现）
    - 日志区（可选）
    - 进度显示（可选）
    """

    def __init__(self, object_name: str, parent=None):
        super().__init__(parent)
        self.setObjectName(object_name)

        # 主布局
        self.mainLayout = QVBoxLayout(self)
        self.mainLayout.setContentsMargins(*CONTENT_MARGINS)
        self.mainLayout.setSpacing(15)

    def addTitleCard(self, title: str, description: str = None) -> CardWidget:
        """添加标题卡片"""
        card = CardWidget(self)
        layout = QVBoxLayout(card)
        layout.setContentsMargins(20, 15, 20, 15)

        titleLabel = TitleLabel(title, card)
        layout.addWidget(titleLabel)

        if description:
            descLabel = BodyLabel(description, card)
            descLabel.setWordWrap(True)
            layout.addWidget(descLabel)

        self.mainLayout.addWidget(card)
        return card

    def addLogArea(self, max_height: int = LOG_AREA_MAX_HEIGHT) -> TextEdit:
        """添加日志输出区域"""
        self.logText = TextEdit(self)
        self.logText.setReadOnly(True)
        self.logText.setMaximumHeight(max_height)
        self.logText.setStyleSheet(LOG_AREA_STYLE)
        self.logText.setPlaceholderText("日志输出...")
        self.mainLayout.addWidget(self.logText)
        return self.logText

    def log(self, message: str):
        """添加日志消息"""
        if hasattr(self, 'logText'):
            self.logText.append(message)
            # 滚动到底部
            cursor = self.logText.textCursor()
            cursor.movePosition(cursor.MoveOperation.End)
            self.logText.setTextCursor(cursor)

    def clearLog(self):
        """清除日志"""
        if hasattr(self, 'logText'):
            self.logText.clear()


class BaseDialogInterface(BaseInterface):
    """
    对话框式子界面基类

    适用于需要执行任务的功能界面，提供：
    - 开始/停止按钮
    - 进度显示
    - 日志输出
    """

    # 信号
    taskStarted = pyqtSignal()
    taskStopped = pyqtSignal()
    taskFinished = pyqtSignal()

    def __init__(self, object_name: str, parent=None):
        super().__init__(object_name, parent)

        self._isRunning = False

    def addActionButtons(self) -> QHBoxLayout:
        """添加操作按钮区域"""
        buttonLayout = QHBoxLayout()
        buttonLayout.setSpacing(10)

        self.startBtn = PrimaryPushButton("开始执行", self)
        self.startBtn.setFixedHeight(36)
        self.startBtn.clicked.connect(self._onStartClicked)

        self.stopBtn = PushButton("停止", self)
        self.stopBtn.setFixedHeight(36)
        self.stopBtn.setEnabled(False)
        self.stopBtn.clicked.connect(self._onStopClicked)

        buttonLayout.addWidget(self.startBtn)
        buttonLayout.addWidget(self.stopBtn)
        buttonLayout.addStretch()

        self.mainLayout.addLayout(buttonLayout)
        return buttonLayout

    def addProgressBar(self) -> ProgressBar:
        """添加进度条"""
        self.progressBar = ProgressBar(self)
        self.progressBar.setRange(0, 100)
        self.progressBar.setValue(0)
        self.mainLayout.addWidget(self.progressBar)
        return self.progressBar

    def addIndeterminateProgress(self) -> IndeterminateProgressRing:
        """添加不确定进度环"""
        self.progressRing = IndeterminateProgressRing(self)
        self.progressRing.setFixedSize(40, 40)
        self.progressRing.hide()
        return self.progressRing

    def setProgress(self, value: int):
        """设置进度值 (0-100)"""
        if hasattr(self, 'progressBar'):
            self.progressBar.setValue(value)

    def setRunning(self, running: bool):
        """设置运行状态"""
        self._isRunning = running
        if hasattr(self, 'startBtn'):
            self.startBtn.setEnabled(not running)
        if hasattr(self, 'stopBtn'):
            self.stopBtn.setEnabled(running)
        if hasattr(self, 'progressRing'):
            self.progressRing.setVisible(running)

    def isRunning(self) -> bool:
        """获取运行状态"""
        return self._isRunning

    def _onStartClicked(self):
        """开始按钮点击处理（子类重写）"""
        self.setRunning(True)
        self.taskStarted.emit()

    def _onStopClicked(self):
        """停止按钮点击处理（子类重写）"""
        self.setRunning(False)
        self.taskStopped.emit()

    def onTaskFinished(self):
        """任务完成处理"""
        self.setRunning(False)
        self.setProgress(100)
        self.taskFinished.emit()
