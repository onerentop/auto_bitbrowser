"""
Fluent Design 主窗口
使用 PyQt-Fluent-Widgets 的 FluentWindow 作为主界面
"""
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import QApplication

from qfluentwidgets import (
    FluentWindow, NavigationItemPosition, NavigationAvatarWidget,
    FluentIcon as FIF, setTheme, Theme, setThemeColor,
    SplashScreen,
)

from gui.fluent_utils import get_app_icon, setup_fluent_theme, setup_theme_color
from gui.home_interface import HomeInterface
from gui.setting_interface import SettingInterface
from gui.sheerid_interface import SheerIDInterface
from gui.bindcard_interface import BindCardInterface
from gui.sheerlink_interface import GetSheerlinkInterface
from gui.replacephone_interface import ReplacePhoneInterface
from gui.replaceemail_interface import ReplaceEmailInterface
from gui.modify2sv_interface import Modify2SVInterface
from gui.modifyauth_interface import ModifyAuthInterface
from gui.kickdevices_interface import KickDevicesInterface
from gui.query_interface import QueryInterface
from gui.placeholder_interface import PlaceholderInterface
from gui.account_manager_interface import AccountManagerInterface
from gui.import_totp_interface import ImportTOTPInterface

from core.config_manager import ConfigManager


class MainFluentWindow(FluentWindow):
    """
    主窗口 - Fluent Design 风格

    使用左侧导航栏 + 右侧内容区的布局
    """

    def __init__(self):
        super().__init__()

        # 初始化窗口属性
        self._initWindow()

        # 创建子界面
        self._createSubInterfaces()

        # 初始化导航
        self._initNavigation()

        # 应用主题
        self._applyTheme()

    def _initWindow(self):
        """初始化窗口属性"""
        self.setWindowTitle("ixBrowser 窗口管理工具")
        self.setWindowIcon(get_app_icon())

        # 设置窗口大小
        self.resize(1300, 850)

        # 居中显示
        desktop = QApplication.primaryScreen().geometry()
        x = (desktop.width() - self.width()) // 2
        y = (desktop.height() - self.height()) // 2
        self.move(x, y)

    def _createSubInterfaces(self):
        """创建所有子界面"""
        # 首页
        self.homeInterface = HomeInterface(self)

        # Google 专区子界面 - 全部已实现
        self.sheeridInterface = SheerIDInterface(self)
        self.bindCardInterface = BindCardInterface(self)
        self.sheerlinkInterface = GetSheerlinkInterface(self)
        self.replacePhoneInterface = ReplacePhoneInterface(self)
        self.replaceEmailInterface = ReplaceEmailInterface(self)
        self.modify2svInterface = Modify2SVInterface(self)
        self.modifyAuthInterface = ModifyAuthInterface(self)
        self.kickDevicesInterface = KickDevicesInterface(self)
        self.queryInterface = QueryInterface(self)

        # 账号管理 - 使用完整的账号管理界面
        self.accountInterface = AccountManagerInterface(self)

        # TOTP 密钥导入
        self.importTOTPInterface = ImportTOTPInterface(self)

        # 全自动订阅 (占位界面)
        self.subscribeInterface = PlaceholderInterface(
            'subscribeInterface',
            "全自动订阅",
            "一键完成从验证到订阅的全流程",
            self
        )

        # 设置
        self.settingInterface = SettingInterface(self)

    def _initNavigation(self):
        """初始化导航栏"""
        # 首页
        self.addSubInterface(
            self.homeInterface,
            FIF.HOME,
            "首页"
        )

        # 分隔线
        self.navigationInterface.addSeparator()

        # Google 专区
        self.addSubInterface(
            self.sheeridInterface,
            FIF.CERTIFICATE,
            "SheerID 验证"
        )
        self.addSubInterface(
            self.bindCardInterface,
            FIF.SHOPPING_CART,
            "绑卡订阅"
        )
        self.addSubInterface(
            self.sheerlinkInterface,
            FIF.LINK,
            "获取 SheerLink"
        )
        self.addSubInterface(
            self.replacePhoneInterface,
            FIF.PHONE,
            "替换手机号"
        )
        self.addSubInterface(
            self.replaceEmailInterface,
            FIF.MAIL,
            "替换辅助邮箱"
        )
        self.addSubInterface(
            self.modify2svInterface,
            FIF.FINGERPRINT,
            "修改 2SV 手机"
        )
        self.addSubInterface(
            self.modifyAuthInterface,
            FIF.VPN,
            "修改验证器"
        )
        self.addSubInterface(
            self.kickDevicesInterface,
            FIF.REMOVE_FROM,
            "踢出设备"
        )
        self.addSubInterface(
            self.queryInterface,
            FIF.SEARCH,
            "综合查询"
        )

        # 分隔线
        self.navigationInterface.addSeparator()

        # 账号管理
        self.addSubInterface(
            self.accountInterface,
            FIF.PEOPLE,
            "账号管理"
        )

        # TOTP 密钥导入
        self.addSubInterface(
            self.importTOTPInterface,
            FIF.FINGERPRINT,
            "导入 TOTP"
        )

        # 全自动订阅
        self.addSubInterface(
            self.subscribeInterface,
            FIF.PLAY,
            "全自动订阅"
        )

        # 底部项目
        self.addSubInterface(
            self.settingInterface,
            FIF.SETTING,
            "设置",
            position=NavigationItemPosition.BOTTOM
        )

    def _applyTheme(self):
        """应用主题设置"""
        # 获取保存的主题设置
        theme_name = ConfigManager.get("theme", "auto")
        theme_map = {
            "auto": Theme.AUTO,
            "light": Theme.LIGHT,
            "dark": Theme.DARK
        }
        setTheme(theme_map.get(theme_name, Theme.AUTO))

        # 设置主题色
        setup_theme_color()

    def closeEvent(self, event):
        """关闭事件 - 保存配置"""
        try:
            # 保存首页配置
            if hasattr(self, 'homeInterface'):
                self.homeInterface.saveConfig()
        except Exception as e:
            print(f"[MainWindow] 关闭时保存配置失败: {e}")

        super().closeEvent(event)


def run_fluent_app():
    """运行 Fluent UI 应用"""
    import sys

    # 启用高DPI支持
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )

    app = QApplication(sys.argv)
    app.setAttribute(Qt.ApplicationAttribute.AA_DontCreateNativeWidgetSiblings)

    # 设置全局主题
    setup_fluent_theme()

    # 创建主窗口
    window = MainFluentWindow()
    window.show()

    sys.exit(app.exec())


if __name__ == "__main__":
    run_fluent_app()
