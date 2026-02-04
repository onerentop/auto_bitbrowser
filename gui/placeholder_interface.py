"""
占位界面 - 用于尚未完全改造的功能
提供基本的界面框架，后续逐步替换为完整实现
"""
from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QVBoxLayout, QHBoxLayout

from qfluentwidgets import (
    CardWidget, PrimaryPushButton, PushButton,
    TitleLabel, SubtitleLabel, BodyLabel, CaptionLabel,
    InfoBar, InfoBarPosition,
    FluentIcon as FIF,
)

from gui.base_interface import BaseDialogInterface


class PlaceholderInterface(BaseDialogInterface):
    """
    占位界面

    用于尚未完全改造的功能模块，显示功能说明并提供基本的操作按钮
    """

    def __init__(self, object_name: str, title: str, description: str, parent=None):
        super().__init__(object_name, parent)

        self._title = title
        self._description = description

        self._initUI()

    def _initUI(self):
        """初始化界面"""
        # 标题卡片
        titleCard = CardWidget(self)
        titleLayout = QVBoxLayout(titleCard)
        titleLayout.setContentsMargins(30, 25, 30, 25)
        titleLayout.setSpacing(10)

        # 标题
        titleLabel = TitleLabel(self._title, titleCard)
        titleLayout.addWidget(titleLabel)

        # 描述
        descLabel = BodyLabel(self._description, titleCard)
        descLabel.setWordWrap(True)
        titleLayout.addWidget(descLabel)

        # 开发中提示
        devLabel = CaptionLabel("🚧 此功能正在升级中，敬请期待...", titleCard)
        devLabel.setTextColor("#E65100", "#FF9800")
        titleLayout.addWidget(devLabel)

        self.mainLayout.addWidget(titleCard)

        # 操作按钮区
        self.addActionButtons()

        # 日志区
        self.addLogArea()

        # 进度条
        self.addProgressBar()

    def _onStartClicked(self):
        """开始按钮点击"""
        InfoBar.warning(
            title="功能开发中",
            content=f"{self._title} 功能正在升级为 Fluent 版本，敬请期待",
            orient=Qt.Orientation.Horizontal,
            isClosable=True,
            position=InfoBarPosition.TOP,
            duration=3000,
            parent=self
        )
        self.log(f"[提示] {self._title} 功能正在开发中...")

    def _onStopClicked(self):
        """停止按钮点击"""
        self.log("[提示] 任务已停止")
        super()._onStopClicked()
