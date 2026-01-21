"""
ixBrowser 窗口批量创建工具 - PyQt6 GUI版本
支持输入模板窗口ID，批量创建窗口
支持列表显示现有窗口，并支持批量删除
UI布局调整：左侧操作区，右侧日志区
账号和代理数据完全从数据库读取（配置管理界面管理）
"""
import sys
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QTextEdit, QPushButton, QMessageBox, QGroupBox,
    QCheckBox, QAbstractItemView, QSpinBox, QToolBox, QProgressBar,
    QDialog, QTreeWidget, QTreeWidgetItem, QComboBox
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal, QTimer
from PyQt6.QtGui import QFont, QColor, QIcon
from ix_window import (
    get_browser_list, get_browser_info,
    delete_browsers_by_name, delete_browser_by_id, open_browser_by_id, create_browser_window, get_next_window_name
)
from ix_api import get_group_list
from database import DBManager
from sheerid_verifier import SheerIDVerifier
from sheerid_gui_v2 import SheerIDWindowV2
from config_ui import ConfigManagerWidget
import re
from web_admin.server import run_server
from core.config_manager import ConfigManager

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.dirname(os.path.abspath(__file__))

    return os.path.join(base_path, relative_path)




DEFAULT_TEMPLATE_CONFIG = {
  "platform": "",
  "platformIcon": "",
  "url": "",
  "name": "默认模板",
  "userName": "",
  "password": "",
  "cookie": "",
  "otherCookie": "",
  "isGlobalProxyInfo": False,
  "isIpv6": False,
  "proxyMethod": 2,
  "proxyType": "noproxy",
  "ipCheckService": "ip2location",
  "host": "",
  "port": "",
  "proxyUserName": "",
  "proxyPassword": "",
  "enableSocks5Udp": False,
  "isIpNoChange": False,
  "isDynamicIpChangeIp": True,
  "status": 0,
  "isDelete": 0,
  "isMostCommon": 0,
  "isRemove": 0,
  "abortImage": False,
  "abortMedia": False,
  "stopWhileNetError": False,
  "stopWhileCountryChange": False,
  "syncTabs": False,
  "syncCookies": False,
  "syncIndexedDb": False,
  "syncBookmarks": False,
  "syncAuthorization": True,
  "syncHistory": False,
  "syncGoogleAccount": False,
  "allowedSignin": False,
  "syncSessions": False,
  "workbench": "localserver",
  "clearCacheFilesBeforeLaunch": True,
  "clearCookiesBeforeLaunch": False,
  "clearHistoriesBeforeLaunch": False,
  "randomFingerprint": True,
  "muteAudio": False,
  "disableGpu": False,
  "enableBackgroundMode": False,
  "syncExtensions": False,
  "syncUserExtensions": False,
  "syncLocalStorage": False,
  "credentialsEnableService": False,
  "disableTranslatePopup": False,
  "stopWhileIpChange": False,
  "disableClipboard": False,
  "disableNotifications": False,
  "memorySaver": False,
  "isRandomFinger": True,
  "isSynOpen": 1,
  "coreProduct": "chrome",
  "ostype": "PC",
  "os": "Win32",
  "coreVersion": "140"
}

class WorkerThread(QThread):
    """通用后台工作线程"""
    log_signal = pyqtSignal(str)
    finished_signal = pyqtSignal(dict)  # result data
    progress_signal = pyqtSignal(int, int, float, float)  # current, total, eta_seconds, speed

    def __init__(self, task_type, **kwargs):
        super().__init__()
        self.task_type = task_type
        self.kwargs = kwargs
        self.is_running = True
        self.start_time = None
        self.processed_count = 0

    def stop(self):
        self.is_running = False

    def log(self, message):
        self.log_signal.emit(message)

    def emit_progress(self, current, total):
        """发送进度信号"""
        if self.start_time is None:
            self.start_time = time.time()

        elapsed = time.time() - self.start_time
        speed = current / elapsed if elapsed > 0 else 0  # 每秒处理数
        remaining = total - current
        eta = remaining / speed if speed > 0 else 0

        self.progress_signal.emit(current, total, eta, speed * 60)  # speed 转换为每分钟

    def msleep(self, ms):
        """可中断的sleep"""
        t = ms
        while t > 0 and self.is_running:
            time.sleep(0.1)
            t -= 100

    def run(self):
        if self.task_type == 'create':
            self.run_create()
        elif self.task_type == 'delete':
            self.run_delete()
        elif self.task_type == 'open':
            self.run_open()
        elif self.task_type == 'verify_sheerid':
            self.run_verify_sheerid()

    def run_verify_sheerid(self):
        links = self.kwargs.get('links', [])
        thread_count = self.kwargs.get('thread_count', 1)
        
        self.log(f"\n[开始] 批量验证 {len(links)} 个链接 (并发: {thread_count})...")
        
        tasks = []
        vid_map = {} # ID -> Original Line
        
        for line in links:
            line = line.strip()
            if not line: continue
            
            vid = None
            # 优先提取参数中的 verificationId
            match_param = re.search(r'verificationId=([a-zA-Z0-9]+)', line)
            if match_param:
                vid = match_param.group(1)
            else:
                # 兜底：提取路径中的 ID
                match_path = re.search(r'verify/([a-zA-Z0-9]+)', line)
                if match_path:
                    vid = match_path.group(1)
            
            if vid:
                tasks.append(vid)
                vid_map[vid] = line
        
        if not tasks:
            self.log("[错误] 未找到有效的 verificationId")
            self.finished_signal.emit({'type': 'verify_sheerid', 'count': 0})
            return

        batches = [tasks[i:i + 5] for i in range(0, len(tasks), 5)]
        
        success_count = 0
        fail_count = 0
        
        base_path = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
        path_success = os.path.join(base_path, "sheerID_verified_success.txt")
        path_fail = os.path.join(base_path, "sheerID_verified_failed.txt")

        # Define Callback
        def status_callback(vid, msg):
             self.log(f"[检测] {vid[:6]}...: {msg}")

        with ThreadPoolExecutor(max_workers=thread_count) as executor:
             futures = []
             for batch in batches:
                 futures.append(executor.submit(self._verify_batch_wrapper, batch, status_callback))
             
             for future in as_completed(futures):
                 if not self.is_running:
                     self.log('[用户操作] 任务已停止')
                     executor.shutdown(wait=False, cancel_futures=True)
                     break
                 
                 try:
                     results = future.result()
                     for vid, res in results.items():
                         status = res.get("currentStep") or res.get("status")
                         msg = res.get("message", "")
                         
                         original_line = vid_map.get(vid, vid)
                         
                         if status == "success":
                             success_count += 1
                             self.log(f"[验证成功] {vid}")
                             with open(path_success, 'a', encoding='utf-8') as f:
                                 f.write(f"{original_line} | Success\n")
                         else:
                             fail_count += 1
                             self.log(f"[验证失败] {vid}: {msg}")
                             with open(path_fail, 'a', encoding='utf-8') as f:
                                 f.write(f"{original_line} | {msg}\n")
                 except Exception as e:
                     self.log(f"[异常] Batch error: {e}")

        self.log(f"[完成] 验证结束. 成功: {success_count}, 失败: {fail_count}")
        self.finished_signal.emit({'type': 'verify_sheerid', 'count': success_count})

    def _verify_batch_wrapper(self, batch_ids, callback=None):
        v = SheerIDVerifier() 
        return v.verify_batch(batch_ids, callback=callback)

    def run_open(self):
        """执行批量打开任务"""
        ids_to_open = self.kwargs.get('ids', [])
        if not ids_to_open:
            self.finished_signal.emit({'type': 'open', 'success_count': 0})
            return

        self.log(f"\n[开始] 准备打开 {len(ids_to_open)} 个窗口...")
        success_count = 0
        
        for i, browser_id in enumerate(ids_to_open, 1):
            if not self.is_running:
                self.log('[用户操作] 打开任务已停止')
                break
            
            self.log(f"正在打开 ({i}/{len(ids_to_open)}): {browser_id}")
            if open_browser_by_id(browser_id):
                self.log(f"[成功] 正在启动窗口 {browser_id}")
                success_count += 1
            else:
                self.log(f"[失败] 启动窗口 {browser_id} request失败")
            
            # 必需延迟防止API过载
            self.msleep(1000)
        
        self.log(f"[完成] 打开任务结束，成功请求 {success_count}/{len(ids_to_open)} 个")
        self.finished_signal.emit({'type': 'open', 'success_count': success_count})

    def run_delete(self):
        """执行批量删除任务"""
        ids_to_delete = self.kwargs.get('ids', [])
        if not ids_to_delete:
            self.finished_signal.emit({'success_count': 0, 'total': 0})
            return

        self.log(f"\n[开始] 准备删除 {len(ids_to_delete)} 个窗口...")
        success_count = 0
        
        for i, browser_id in enumerate(ids_to_delete, 1):
            if not self.is_running:
                self.log('[用户操作] 删除任务已停止')
                break
            
            self.log(f"正在删除 ({i}/{len(ids_to_delete)}): {browser_id}")
            if delete_browser_by_id(browser_id):
                self.log(f"[成功] 删除窗口 {browser_id}")
                success_count += 1
            else:
                self.log(f"[失败] 删除窗口 {browser_id} 失败")
        
        self.log(f"[完成] 删除任务结束，成功删除 {success_count}/{len(ids_to_delete)} 个")
        self.finished_signal.emit({'type': 'delete', 'success_count': success_count})

    def run_create(self):
        """执行创建任务"""
        template_id_str = self.kwargs.get('template_id')
        template_id = int(template_id_str) if template_id_str else None
        template_config = self.kwargs.get('template_config')

        name_prefix = self.kwargs.get('name_prefix')
        group_id = self.kwargs.get('group_id')  # 获取目标分组ID

        try:
            # 从数据库读取账户信息
            db_accounts = DBManager.get_all_accounts()
            # 过滤状态为 pending 的账号（未处理的）
            accounts = []
            for acc in db_accounts:
                if acc.get('status') == 'pending':
                    accounts.append({
                        'email': acc.get('email', ''),
                        'password': acc.get('password', ''),
                        'recovery_email': acc.get('recovery_email', ''),
                        '2fa_secret': acc.get('secret_key', ''),
                        'full_line': f"{acc.get('email', '')}----{acc.get('password', '')}----{acc.get('recovery_email', '')}----{acc.get('secret_key', '')}"
                    })

            if not accounts:
                self.log("[错误] 未找到有效的账户信息")
                self.log("请在配置管理 -> 账号管理中添加账号")
                self.log("或者确保有状态为 'pending' 的账号")
                self.finished_signal.emit({'type': 'create', 'success_count': 0})
                return

            self.log(f"[信息] 从数据库找到 {len(accounts)} 个待处理账户")

            # 从数据库读取代理信息
            db_proxies = DBManager.get_all_proxies()
            proxies = []
            for p in db_proxies:
                proxies.append({
                    'type': p.get('proxy_type', 'socks5'),
                    'host': p.get('host', ''),
                    'port': p.get('port', ''),
                    'username': p.get('username', ''),
                    'password': p.get('password', '')
                })
            self.log(f"[信息] 从数据库找到 {len(proxies)} 个代理")
            
            # 获取参考窗口信息
            if template_config:
                reference_config = template_config
                ref_name = reference_config.get('name', '默认模板')
                self.log(f"[信息] 使用内置默认模板")
            else:
                reference_config = get_browser_info(template_id)
                if not reference_config:
                    self.log(f"[错误] 无法获取模板窗口配置")
                    self.finished_signal.emit({'type': 'create', 'success_count': 0})
                    return
                ref_name = reference_config.get('name', '未知')
                self.log(f"[信息] 使用模板窗口: {ref_name} (ID: {template_id})")

            # 删除名称为"本地代理_2"的所有窗口（如果参考窗口是"本地代理_1"）
            if ref_name.startswith('本地代理_'):
                try:
                    next_name = get_next_window_name(ref_name)
                    # 如果下一个名称是"本地代理_2"，则尝试删除旧的"本地代理_2"
                    if next_name == "本地代理_2":
                        self.log(f"\n[步骤] 正在清理旧的'本地代理_2'窗口...")
                        deleted_count = delete_browsers_by_name("本地代理_2")
                        if deleted_count > 0:
                            self.log(f"[清理] 已删除 {deleted_count} 个旧窗口")
                except:
                    pass
            
            # 为每个账户创建窗口
            success_count = 0
            for i, account in enumerate(accounts, 1):
                if not self.is_running:
                    self.log("\n[用户操作] 创建任务已停止")
                    break
                
                self.log(f"\n{'='*40}")
                self.log(f"[进度] ({i}/{len(accounts)}) 创建: {account['email']}")
                
                # 获取对应的代理（如果有）
                proxy = proxies[i - 1] if i - 1 < len(proxies) else None
                
                browser_id, error_msg = create_browser_window(
                    account,
                    template_id if not template_config else None,
                    proxy,
                    template_config=template_config,
                    name_prefix=name_prefix,
                    group_id=group_id
                )
                
                if browser_id:
                    success_count += 1
                    self.log(f"[成功] 窗口创建成功！ID: {browser_id}")
                else:
                    self.log(f"[失败] 窗口创建失败: {error_msg}")
            
            self.log(f"\n{'='*40}")
            self.log(f"[完成] 总共创建 {success_count}/{len(accounts)} 个窗口")
            
            self.finished_signal.emit({'type': 'create', 'success_count': success_count})
            
        except Exception as e:
            self.log(f"[错误] 创建过程中发生异常: {e}")
            import traceback
            self.log(traceback.format_exc())
            self.finished_signal.emit({'type': 'create', 'success_count': 0})


class BrowserWindowCreatorGUI(QMainWindow):
    def __init__(self):
        super().__init__()

        # 加载配置
        self.config = ConfigManager.load()

        # 设置窗口图标
        try:
            icon_path = resource_path("beta-1.svg")
            if os.path.exists(icon_path):
                self.setWindowIcon(QIcon(icon_path))
        except Exception:
            pass

        self.ensure_data_files()
        self.worker_thread = None
        self.init_ui()

        # 加载保存的配置到UI
        self.load_config_to_ui()

    def ensure_data_files(self):
        """Ensure necessary data files exist"""
        base_path = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
        files = ["sheerIDlink.txt", "无资格号.txt", "已绑卡号.txt", "已验证未绑卡.txt", "超时或其他错误.txt"]
        for f in files:
            path = os.path.join(base_path, f)
            if not os.path.exists(path):
                try:
                    with open(path, 'w', encoding='utf-8') as file:
                        pass
                except Exception as e:
                    print(f"Failed to create {f}: {e}")
        
    def init_function_panel(self):
        """初始化左侧功能区"""
        self.function_panel = QWidget()
        self.function_panel.setFixedWidth(250)
        self.function_panel.setVisible(False) # 默认隐藏
        
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        self.function_panel.setLayout(layout)
        
        # 1. 标题
        title = QLabel("🔥 功能工具箱")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setStyleSheet("font-size: 16px; font-weight: bold; padding: 10px; background-color: #f0f0f0;")
        layout.addWidget(title)
        
        # 2. 分区工具箱
        self.toolbox = QToolBox()
        self.toolbox.setStyleSheet("""
            QToolBox::tab {
                background: #e1e1e1;
                border-radius: 5px;
                color: #555;
                font-weight: bold;
            }
            QToolBox::tab:selected {
                background: #d0d0d0;
                color: black;
            }
        """)
        layout.addWidget(self.toolbox)
        
        # --- 谷歌分区 ---
        google_page = QWidget()
        google_layout = QVBoxLayout()
        google_layout.setContentsMargins(5,10,5,10)
        
        # 一键获取 SheerLink (AI 版) 按钮
        self.btn_sheerlink_ai = QPushButton("🤖 一键获取 SheerLink (AI)")
        self.btn_sheerlink_ai.setFixedHeight(40)
        self.btn_sheerlink_ai.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_sheerlink_ai.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #8BC34A;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #7CB342; }
        """)
        self.btn_sheerlink_ai.clicked.connect(self.action_get_sheerlink_ai)
        google_layout.addWidget(self.btn_sheerlink_ai)

        # New Button: Verify SheerID
        self.btn_verify_sheerid = QPushButton("批量验证 SheerID Link")
        self.btn_verify_sheerid.setFixedHeight(40)
        self.btn_verify_sheerid.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_verify_sheerid.setStyleSheet("""
            QPushButton {
                text-align: left; 
                padding-left: 15px; 
                font-weight: bold; 
                color: white;
                background-color: #2196F3;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #1976D2; }
        """)
        self.btn_verify_sheerid.clicked.connect(self.action_verify_sheerid)
        google_layout.addWidget(self.btn_verify_sheerid)
        
        # 一键绑卡订阅 AI 版按钮
        self.btn_bind_card_ai = QPushButton("🤖 一键绑卡订阅 (AI)")
        self.btn_bind_card_ai.setFixedHeight(40)
        self.btn_bind_card_ai.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_bind_card_ai.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #E65100;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #BF360C; }
        """)
        self.btn_bind_card_ai.clicked.connect(self.action_bind_card_ai)
        google_layout.addWidget(self.btn_bind_card_ai)

        # 一键全自动订阅按钮
        self.btn_auto_all = QPushButton("🚀 一键全自动订阅")
        self.btn_auto_all.setFixedHeight(40)
        self.btn_auto_all.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_auto_all.setStyleSheet("""
            QPushButton {
                text-align: left; 
                padding-left: 15px; 
                font-weight: bold; 
                color: white;
                background-color: #9C27B0;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #7B1FA2; }
        """)
        self.btn_auto_all.clicked.connect(self.action_auto_all)
        google_layout.addWidget(self.btn_auto_all)

        # 一键替换手机号按钮
        self.btn_replace_phone = QPushButton("📱 一键替换手机号")
        self.btn_replace_phone.setFixedHeight(40)
        self.btn_replace_phone.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_replace_phone.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #00BCD4;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #0097A7; }
        """)
        self.btn_replace_phone.clicked.connect(self.action_replace_phone)
        google_layout.addWidget(self.btn_replace_phone)

        # 一键替换辅助邮箱按钮
        self.btn_replace_email = QPushButton("📧 一键替换辅助邮箱")
        self.btn_replace_email.setFixedHeight(40)
        self.btn_replace_email.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_replace_email.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #FF5722;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #E64A19; }
        """)
        self.btn_replace_email.clicked.connect(self.action_replace_email)
        google_layout.addWidget(self.btn_replace_email)

        # 一键修改2SV手机号按钮
        self.btn_modify_2sv_phone = QPushButton("📱 一键修改2SV手机号")
        self.btn_modify_2sv_phone.setFixedHeight(40)
        self.btn_modify_2sv_phone.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_modify_2sv_phone.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #9C27B0;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #7B1FA2; }
        """)
        self.btn_modify_2sv_phone.clicked.connect(self.action_modify_2sv_phone)
        google_layout.addWidget(self.btn_modify_2sv_phone)

        # 一键修改身份验证器按钮
        self.btn_modify_authenticator = QPushButton("🔐 一键修改身份验证器")
        self.btn_modify_authenticator.setFixedHeight(40)
        self.btn_modify_authenticator.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_modify_authenticator.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                background-color: #00796B;
                color: white;
                border: none;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #00695C; }
        """)
        self.btn_modify_authenticator.clicked.connect(self.action_modify_authenticator)
        google_layout.addWidget(self.btn_modify_authenticator)

        # 综合查询按钮
        self.btn_comprehensive_query = QPushButton("🔍 综合查询")
        self.btn_comprehensive_query.setFixedHeight(40)
        self.btn_comprehensive_query.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_comprehensive_query.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #2196F3;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #1976D2; }
        """)
        self.btn_comprehensive_query.clicked.connect(self.action_open_comprehensive_query)
        google_layout.addWidget(self.btn_comprehensive_query)

        google_layout.addStretch()
        google_page.setLayout(google_layout)
        self.toolbox.addItem(google_page, "Google 专区")
        
        # --- 微软分区 ---
        ms_page = QWidget()
        self.toolbox.addItem(ms_page, "Microsoft 专区")
        
        # --- 脸书分区 ---
        fb_page = QWidget()
        self.toolbox.addItem(fb_page, "Facebook 专区")
        
        # --- Telegram分区 ---
        tg_page = QWidget()
        tg_layout = QVBoxLayout()
        tg_layout.addWidget(QLabel("功能开发中..."))
        tg_layout.addStretch()
        tg_page.setLayout(tg_layout)
        self.toolbox.addItem(tg_page, "Telegram 专区")

        # --- 配置管理分区 ---
        config_page = QWidget()
        config_layout = QVBoxLayout()
        config_layout.setContentsMargins(5, 10, 5, 10)

        self.btn_config_manager = QPushButton("⚙️ 打开配置管理")
        self.btn_config_manager.setFixedHeight(40)
        self.btn_config_manager.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_config_manager.setStyleSheet("""
            QPushButton {
                text-align: left;
                padding-left: 15px;
                font-weight: bold;
                color: white;
                background-color: #607D8B;
                border-radius: 5px;
            }
            QPushButton:hover { background-color: #455A64; }
        """)
        self.btn_config_manager.clicked.connect(self.action_open_config_manager)
        config_layout.addWidget(self.btn_config_manager)

        config_layout.addStretch()
        config_page.setLayout(config_layout)
        self.toolbox.addItem(config_page, "配置管理")

        # 默认展开谷歌
        self.toolbox.setCurrentIndex(0)

    def init_ui(self):
        """初始化UI"""
        self.setWindowTitle("ixBrowser 窗口管理工具")
        self.setWindowIcon(QIcon(resource_path("beta-1.svg")))
        self.resize(1300, 800)
        
        # Init Side Panel
        self.init_function_panel()
        
        # 主窗口部件
        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        
        # 主布局 - 水平
        main_layout = QHBoxLayout()
        main_layout.setSpacing(5)
        main_widget.setLayout(main_layout)
        
        # 1. Add Function Panel (Leftmost)
        main_layout.addWidget(self.function_panel)
        
        # ================== 左侧区域 (控制 + 列表) ==================
        left_widget = QWidget()
        left_layout = QVBoxLayout()
        left_widget.setLayout(left_layout)
        
        # --- Top Bar: Toggle Logic + Title + Global Settings ---
        top_bar_layout = QHBoxLayout()
        
        # Toggle Button
        self.btn_toggle_tools = QPushButton("工具箱 📂")
        self.btn_toggle_tools.setCheckable(True)
        self.btn_toggle_tools.setChecked(False) 
        self.btn_toggle_tools.setFixedHeight(30)
        self.btn_toggle_tools.setStyleSheet("""
            QPushButton { background-color: #607D8B; color: white; border-radius: 4px; padding: 5px 10px; }
            QPushButton:checked { background-color: #455A64; }
        """)
        self.btn_toggle_tools.clicked.connect(lambda checked: self.function_panel.setVisible(checked))
        top_bar_layout.addWidget(self.btn_toggle_tools)
        
        # Title
        title_label = QLabel("控制面板")
        title_font = QFont()
        title_font.setPointSize(14)
        title_font.setBold(True)
        title_label.setFont(title_font)
        title_label.setContentsMargins(10,0,10,0)
        top_bar_layout.addWidget(title_label)
        
        top_bar_layout.addStretch()
        
        # Global Thread Spinbox
        top_bar_layout.addWidget(QLabel("🔥 全局并发数:"))
        self.thread_spinbox = QSpinBox()
        self.thread_spinbox.setRange(1, 50)
        self.thread_spinbox.setValue(1)
        self.thread_spinbox.setFixedSize(70, 30)
        self.thread_spinbox.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thread_spinbox.setStyleSheet("font-size: 14px; font-weight: bold; color: #E91E63;")
        self.thread_spinbox.setToolTip("所有多线程任务的并发数量 (1-50)")
        top_bar_layout.addWidget(self.thread_spinbox)


        left_layout.addLayout(top_bar_layout)
        
        # 2. 配置区域
        config_group = QGroupBox("创建参数配置")
        config_layout = QVBoxLayout()
        
        # 模板ID
        input_layout1 = QHBoxLayout()
        input_layout1.addWidget(QLabel("模板窗口ID:"))
        self.template_id_input = QLineEdit()
        self.template_id_input.setPlaceholderText("请输入模板窗口ID")
        input_layout1.addWidget(self.template_id_input)
        config_layout.addLayout(input_layout1)

        # 窗口名前缀
        input_layout_prefix = QHBoxLayout()
        input_layout_prefix.addWidget(QLabel("窗口前缀:"))
        self.name_prefix_input = QLineEdit()
        self.name_prefix_input.setPlaceholderText("可选，默认按模板名或'默认模板'命名")
        input_layout_prefix.addWidget(self.name_prefix_input)
        config_layout.addLayout(input_layout_prefix)

        # 目标分组选择
        input_layout_group = QHBoxLayout()
        input_layout_group.addWidget(QLabel("目标分组:"))
        self.group_combo = QComboBox()
        self.group_combo.setMinimumWidth(200)
        input_layout_group.addWidget(self.group_combo)
        self.refresh_group_btn = QPushButton("刷新")
        self.refresh_group_btn.clicked.connect(self.refresh_group_list)
        input_layout_group.addWidget(self.refresh_group_btn)
        input_layout_group.addStretch()
        config_layout.addLayout(input_layout_group)

        config_group.setLayout(config_layout)
        left_layout.addWidget(config_group)

        # 3. 创建控制按钮
        create_btn_layout = QHBoxLayout()
        self.start_btn = QPushButton("开始根据模板创建窗口")
        self.start_btn.setFixedHeight(40)
        self.start_btn.setStyleSheet("background-color: #4CAF50; color: white; font-weight: bold;")
        self.start_btn.clicked.connect(self.start_creation)
        
        self.stop_btn = QPushButton("停止任务")
        self.stop_btn.setFixedHeight(40)
        self.stop_btn.setStyleSheet("background-color: #f44336; color: white; font-weight: bold;")
        self.stop_btn.clicked.connect(self.stop_task)
        self.stop_btn.setEnabled(False)
        
        create_btn_layout.addWidget(self.start_btn)
        
        self.start_default_btn = QPushButton("使用默认模板创建")
        self.start_default_btn.setFixedHeight(40)
        self.start_default_btn.setStyleSheet("background-color: #2196F3; color: white; font-weight: bold;")
        self.start_default_btn.clicked.connect(self.start_creation_default)
        create_btn_layout.addWidget(self.start_default_btn)
        
        create_btn_layout.addWidget(self.stop_btn)
        left_layout.addLayout(create_btn_layout)
        
        # 4. 窗口列表部分
        list_group = QGroupBox("现存窗口列表")
        list_layout = QVBoxLayout()

        # 列表操作按钮
        list_action_layout = QHBoxLayout()
        self.refresh_btn = QPushButton("刷新列表")
        self.refresh_btn.clicked.connect(self.refresh_browser_list)

        self.select_all_checkbox = QCheckBox("全选")
        self.select_all_checkbox.stateChanged.connect(self.toggle_select_all)

        self.open_btn = QPushButton("打开选中窗口")
        self.open_btn.setStyleSheet("color: blue; font-weight: bold;")
        self.open_btn.clicked.connect(self.open_selected_browsers)

        self.delete_btn = QPushButton("删除选中窗口")
        self.delete_btn.setStyleSheet("color: red;")
        self.delete_btn.clicked.connect(self.delete_selected_browsers)

        list_action_layout.addWidget(self.refresh_btn)
        list_action_layout.addWidget(self.select_all_checkbox)
        list_action_layout.addStretch()

        list_action_layout.addWidget(self.open_btn)
        list_action_layout.addWidget(self.delete_btn)
        list_layout.addLayout(list_action_layout)

        # 树形控件（按分组显示）
        self.tree = QTreeWidget()
        self.tree.setHeaderLabels(["选择", "名称", "窗口ID", "2FA验证码", "备注"])
        self.tree.setColumnWidth(0, 80)    # 选择列（包含展开箭头+复选框）
        self.tree.setColumnWidth(1, 180)   # 名称
        self.tree.setColumnWidth(2, 100)   # ID
        self.tree.setColumnWidth(3, 100)   # 2FA
        self.tree.header().setStretchLastSection(True)  # 备注列自适应
        self.tree.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.tree.setRootIsDecorated(True)  # 显示展开/折叠箭头
        self.tree.setIndentation(15)  # 减小缩进宽度
        list_layout.addWidget(self.tree)
        
        list_group.setLayout(list_layout)
        left_layout.addWidget(list_group)
        
        # 添加左侧到主布局
        main_layout.addWidget(left_widget, 3)
        
        # ================== 右侧区域 (日志) ==================
        right_widget = QWidget()
        right_layout = QVBoxLayout()
        right_widget.setLayout(right_layout)
        
        log_label = QLabel("运行状态日志")
        log_label.setFont(title_font)
        right_layout.addWidget(log_label)

        # 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        self.progress_bar.setTextVisible(True)
        self.progress_bar.setFormat("%p%")
        self.progress_bar.setStyleSheet("""
            QProgressBar {
                border: 1px solid #ccc;
                border-radius: 5px;
                text-align: center;
                height: 20px;
            }
            QProgressBar::chunk {
                background-color: #4CAF50;
                border-radius: 4px;
            }
        """)
        right_layout.addWidget(self.progress_bar)

        # 进度信息标签
        self.progress_label = QLabel("就绪")
        self.progress_label.setStyleSheet("color: #666; font-size: 12px;")
        right_layout.addWidget(self.progress_label)

        self.status_text = QTextEdit()
        self.status_text.setReadOnly(True)
        self.status_text.setStyleSheet("background-color: #f5f5f5;")
        right_layout.addWidget(self.status_text)

        # 添加清除日志按钮
        clear_log_btn = QPushButton("清除日志")
        clear_log_btn.clicked.connect(self.status_text.clear)
        right_layout.addWidget(clear_log_btn)
        
        # 添加右侧到主布局
        main_layout.addWidget(right_widget, 2)

        # 初始加载
        QTimer.singleShot(100, self.refresh_browser_list)
        QTimer.singleShot(150, self.refresh_group_list)

    def refresh_group_list(self):
        """刷新分组下拉列表"""
        self.group_combo.clear()
        try:
            groups = get_group_list() or []
            # 添加默认选项（仅当 API 返回的分组中没有 id=1 时）
            has_default = any(g.get('id') == 1 for g in groups)
            if not has_default:
                self.group_combo.addItem("默认分组", 1)

            for g in groups:
                gid = g.get('id')
                title = g.get('title', '')
                # 清理乱码
                clean_title = ''.join(c for c in str(title) if c.isprintable())
                if not clean_title or '\ufffd' in clean_title:
                    clean_title = f"分组 {gid}"
                self.group_combo.addItem(f"{clean_title} (ID: {gid})", gid)
        except Exception as e:
            self.log(f"[警告] 获取分组列表失败: {e}")
            self.group_combo.addItem("默认分组", 1)

    def log(self, message):
        """添加日志"""
        self.status_text.append(message)
        cursor = self.status_text.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        self.status_text.setTextCursor(cursor)

    def refresh_browser_list(self):
        """刷新窗口列表到树形控件（按分组显示）"""
        self.tree.clear()
        self.select_all_checkbox.setChecked(False)
        self.log("正在刷新窗口列表...")
        QApplication.processEvents()

        def clean_text(text):
            """清理文本，移除不可显示字符"""
            if not text:
                return ""
            # 只保留可打印字符
            return ''.join(c for c in str(text) if c.isprintable())

        try:
            # 1. 获取所有分组（包括空分组）
            all_groups = get_group_list() or []
            # API 返回 {id, title}，转换为 {group_id: group_name}
            group_names = {}
            for g in all_groups:
                gid = g.get('id')
                title = clean_text(g.get('title', ''))
                # 如果标题是乱码（包含替换字符），使用 ID 作为名称
                if not title or '\ufffd' in title or any(ord(c) > 0xFFFF for c in title):
                    title = f"分组 {gid}"
                group_names[gid] = title
            group_names[0] = "未分组"  # 确保有未分组

            # 2. 获取所有窗口
            browsers = get_browser_list() or []

            # 3. 按 group_id 分组
            grouped = {gid: [] for gid in group_names.keys()}  # 初始化所有分组为空列表
            for b in browsers:
                gid = b.get('group_id', 0) or 0
                if gid not in grouped:
                    grouped[gid] = []
                    # 从浏览器数据获取分组名
                    gname = clean_text(b.get('group_name', ''))
                    if not gname or '\ufffd' in gname:
                        gname = f"分组 {gid}"
                    group_names[gid] = gname
                grouped[gid].append(b)

            # 4. 创建树形结构（所有分组，包括空的）
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

        except Exception as e:
            import traceback
            traceback.print_exc()
            self.log(f"[错误] 刷新列表失败: {e}")

    def action_get_sheerlink_ai(self):
        """打开一键获取 SheerLink AI 版窗口"""
        try:
            from get_sheerlink_ai_gui import GetSheerlinkAIDialog

            if not hasattr(self, 'get_sheerlink_ai_dialog') or self.get_sheerlink_ai_dialog is None:
                self.get_sheerlink_ai_dialog = GetSheerlinkAIDialog(self)

            self.get_sheerlink_ai_dialog.show()
            self.get_sheerlink_ai_dialog.raise_()
            self.get_sheerlink_ai_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开 AI SheerLink 窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_verify_sheerid(self):
        """打开 SheerID 批量验证窗口 (数据库版)"""
        try:
            if not hasattr(self, 'verify_window') or self.verify_window is None:
                self.verify_window = SheerIDWindowV2(self)
            
            self.verify_window.show()
            self.verify_window.raise_()
            self.verify_window.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开验证窗口: {e}")

    def action_bind_card_ai(self):
        """打开一键绑卡订阅 AI 版窗口"""
        try:
            from bind_card_ai_gui import BindCardAIDialog

            if not hasattr(self, 'bind_card_ai_dialog') or self.bind_card_ai_dialog is None:
                self.bind_card_ai_dialog = BindCardAIDialog(self)

            self.bind_card_ai_dialog.show()
            self.bind_card_ai_dialog.raise_()
            self.bind_card_ai_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开 AI 绑卡窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_auto_all(self):
        """打开一键全自动订阅窗口"""
        try:
            from auto_subscribe_gui import AutoSubscribeWindow

            if not hasattr(self, 'auto_all_window') or self.auto_all_window is None:
                self.auto_all_window = AutoSubscribeWindow()

            self.auto_all_window.show()
            self.auto_all_window.raise_()
            self.auto_all_window.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开全自动订阅窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_replace_phone(self):
        """打开一键替换手机号窗口"""
        try:
            from replace_phone_gui import ReplacePhoneWindow

            if not hasattr(self, 'replace_phone_window') or self.replace_phone_window is None:
                self.replace_phone_window = ReplacePhoneWindow()

            self.replace_phone_window.show()
            self.replace_phone_window.raise_()
            self.replace_phone_window.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开替换手机号窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_replace_email(self):
        """打开一键替换辅助邮箱窗口"""
        try:
            from replace_email_gui import ReplaceEmailWindow

            if not hasattr(self, 'replace_email_window') or self.replace_email_window is None:
                self.replace_email_window = ReplaceEmailWindow()

            self.replace_email_window.show()
            self.replace_email_window.raise_()
            self.replace_email_window.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开替换辅助邮箱窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_modify_2sv_phone(self):
        """打开一键修改2SV手机号窗口"""
        try:
            from modify_2sv_phone_gui import Modify2SVPhoneDialog

            if not hasattr(self, 'modify_2sv_phone_dialog') or self.modify_2sv_phone_dialog is None:
                self.modify_2sv_phone_dialog = Modify2SVPhoneDialog()

            self.modify_2sv_phone_dialog.show()
            self.modify_2sv_phone_dialog.raise_()
            self.modify_2sv_phone_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开修改2SV手机号窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_modify_authenticator(self):
        """打开一键修改身份验证器窗口"""
        try:
            from modify_authenticator_gui import ModifyAuthenticatorDialog

            if not hasattr(self, 'modify_authenticator_dialog') or self.modify_authenticator_dialog is None:
                self.modify_authenticator_dialog = ModifyAuthenticatorDialog()

            self.modify_authenticator_dialog.show()
            self.modify_authenticator_dialog.raise_()
            self.modify_authenticator_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开修改身份验证器窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_open_config_manager(self):
        """打开配置管理窗口"""
        try:
            if not hasattr(self, 'config_manager_dialog') or self.config_manager_dialog is None:
                self.config_manager_dialog = QDialog(self)
                self.config_manager_dialog.setWindowTitle("配置管理")
                self.config_manager_dialog.setMinimumSize(900, 600)

                layout = QVBoxLayout(self.config_manager_dialog)
                layout.setContentsMargins(0, 0, 0, 0)
                layout.addWidget(ConfigManagerWidget())

            self.config_manager_dialog.show()
            self.config_manager_dialog.raise_()
            self.config_manager_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开配置管理窗口: {e}")
            import traceback
            traceback.print_exc()

    def action_open_comprehensive_query(self):
        """打开综合查询窗口"""
        try:
            from comprehensive_query_gui import ComprehensiveQueryWindow

            if not hasattr(self, 'comprehensive_query_dialog') or self.comprehensive_query_dialog is None:
                self.comprehensive_query_dialog = ComprehensiveQueryWindow(self)

            self.comprehensive_query_dialog.show()
            self.comprehensive_query_dialog.raise_()
            self.comprehensive_query_dialog.activateWindow()
        except Exception as e:
            QMessageBox.warning(self, "错误", f"无法打开综合查询窗口: {e}")
            import traceback
            traceback.print_exc()

    def open_selected_browsers(self):
        """打开选中的窗口"""
        ids = self.get_selected_browser_ids()
        if not ids:
            QMessageBox.warning(self, "提示", "请先勾选要打开的窗口")
            return
        
        self.start_worker_thread('open', ids=ids)

    def toggle_select_all(self, state):
        """全选/取消全选（适配树形控件）"""
        check_state = Qt.CheckState.Checked if state == 2 else Qt.CheckState.Unchecked
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            group_item.setCheckState(0, check_state)

    def get_selected_browser_ids(self):
        """获取选中的窗口ID列表（适配树形控件）"""
        ids = []
        root = self.tree.invisibleRootItem()
        for i in range(root.childCount()):
            group_item = root.child(i)
            for j in range(group_item.childCount()):
                child = group_item.child(j)
                if child.checkState(0) == Qt.CheckState.Checked:
                    data = child.data(0, Qt.ItemDataRole.UserRole)
                    if data and data.get("type") == "browser":
                        ids.append(str(data.get("id")))
        return ids

    def delete_selected_browsers(self):
        """删除选中的窗口"""
        ids = self.get_selected_browser_ids()
        if not ids:
            QMessageBox.warning(self, "提示", "请先勾选要删除的窗口")
            return
        
        reply = QMessageBox.question(
            self, 
            "确认删除", 
            f"确定要删除选中的 {len(ids)} 个窗口吗？\n此操作不可恢复！",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No
        )
        
        if reply == QMessageBox.StandardButton.Yes:
            self.start_worker_thread('delete', ids=ids)

    def start_creation(self):
        """开始创建任务"""
        template_id = self.template_id_input.text().strip()
        if not template_id:
            QMessageBox.warning(self, "警告", "请输入模板窗口ID")
            return

        name_prefix = self.name_prefix_input.text().strip()
        group_id = self.group_combo.currentData()  # 获取选中分组ID

        self.update_ui_state(True)
        self.log(f"启动创建任务... 模板ID: {template_id}, 目标分组ID: {group_id}")

        self.worker_thread = WorkerThread(
            'create',
            template_id=template_id,
            name_prefix=name_prefix,
            group_id=group_id
        )
        self.worker_thread.log_signal.connect(self.log)
        self.worker_thread.finished_signal.connect(self.on_worker_finished)
        self.worker_thread.start()

    def start_worker_thread(self, task_type, **kwargs):
        """启动后台线程"""
        if self.worker_thread and self.worker_thread.isRunning():
            QMessageBox.warning(self, "提示", "当前有任务正在运行，请稍候...")
            return

        # 重置进度条
        self.progress_bar.setValue(0)
        self.progress_label.setText("正在处理...")

        self.worker_thread = WorkerThread(task_type, **kwargs)
        self.worker_thread.log_signal.connect(self.log)
        self.worker_thread.finished_signal.connect(self.on_worker_finished)
        self.worker_thread.progress_signal.connect(self.update_progress)
        self.worker_thread.start()

        self.update_ui_state(running=True)

    def update_progress(self, current, total, eta, speed):
        """更新进度条和进度信息"""
        if total > 0:
            pct = int(current / total * 100)
            self.progress_bar.setValue(pct)

            # 格式化 ETA
            if eta > 60:
                eta_str = f"{int(eta / 60)}分{int(eta % 60)}秒"
            else:
                eta_str = f"{int(eta)}秒"

            self.progress_label.setText(
                f"进度: {current}/{total} ({pct}%) | 速度: {speed:.1f}个/分钟 | 剩余: 约{eta_str}"
            )

    def start_creation_default(self):
        """使用默认模板开始创建任务"""
        name_prefix = self.name_prefix_input.text().strip()
        group_id = self.group_combo.currentData()  # 获取选中分组ID

        self.update_ui_state(True)
        self.log(f"启动创建任务... 使用默认配置模板, 目标分组ID: {group_id}")

        self.start_worker_thread(
            'create',
            template_config=DEFAULT_TEMPLATE_CONFIG,
            name_prefix=name_prefix,
            group_id=group_id
        )

    def stop_task(self):
        """停止当前任务"""
        if self.worker_thread and self.worker_thread.isRunning():
            self.worker_thread.stop()
            self.log("[用户操作] 正在停止任务...")
            self.stop_btn.setEnabled(False) #防止重复点击

    def on_worker_finished(self, result):
        """任务结束回调"""
        self.update_ui_state(running=False)

        # 完成进度条
        self.progress_bar.setValue(100)
        self.progress_label.setText("任务完成")

        self.log(f"任务已结束")

        # 如果是删除操作，完成后刷新列表
        if result.get('type') == 'delete':
            self.refresh_browser_list()
        # 如果是创建操作，也刷新列表可以看到新窗口
        elif result.get('type') == 'create':
            self.refresh_browser_list()
        # 打开操作
        elif result.get('type') == 'open':
            pass

        elif result.get('type') == 'verify_sheerid':
            count = result.get('count', 0)
            QMessageBox.information(self, "完成", f"SheerID 批量验证结束\n成功: {count} 个\n结果已保存至 sheerID_verified_success/failed.txt")

    def update_ui_state(self, running):
        """更新UI按钮状态"""
        self.start_btn.setEnabled(not running)
        self.start_default_btn.setEnabled(not running)
        self.delete_btn.setEnabled(not running)
        self.open_btn.setEnabled(not running)
        self.btn_sheerlink_ai.setEnabled(not running)
        self.btn_verify_sheerid.setEnabled(not running)
        self.stop_btn.setEnabled(running)
        self.refresh_btn.setEnabled(not running)
        self.template_id_input.setEnabled(not running)
        self.name_prefix_input.setEnabled(not running)

    def load_config_to_ui(self):
        """从配置加载到UI控件"""
        try:
            # 模板ID
            template_id = ConfigManager.get("last_used_template_id", "")
            if template_id:
                self.template_id_input.setText(str(template_id))

            # 窗口前缀
            prefix = ConfigManager.get("window_name_prefix", "")
            if prefix:
                self.name_prefix_input.setText(prefix)

            # 并发数
            thread_count = ConfigManager.get("default_thread_count", 3)
            self.thread_spinbox.setValue(thread_count)

        except Exception as e:
            print(f"[Config] 加载配置到UI失败: {e}")

    def save_config_from_ui(self):
        """从UI控件保存到配置"""
        try:
            ConfigManager.set("last_used_template_id", self.template_id_input.text().strip())
            ConfigManager.set("window_name_prefix", self.name_prefix_input.text().strip())
            ConfigManager.set("default_thread_count", self.thread_spinbox.value())
        except Exception as e:
            print(f"[Config] 保存配置失败: {e}")

    def closeEvent(self, event):
        """窗口关闭时保存配置"""
        self.save_config_from_ui()
        event.accept()


def main():
    try:
        t = threading.Thread(target=run_server, args=(8080,), daemon=True)
        t.start()
        print("Web Admin started on http://localhost:8080")
    except Exception as e:
        print(f"Error starting Web Admin: {e}")

    # 确保打包时包含 SVG 支持
    import PyQt6.QtSvg

    # Fix taskbar icon on Windows
    import ctypes
    try:
        myappid = 'leclee.ixbrowser.automanager.1.0'
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(myappid)
    except:
        pass

    app = QApplication(sys.argv)
    
    # 设置全局字体
    font = QFont("Microsoft YaHei", 9)
    app.setFont(font)
    
    # 设置全局图标
    icon_path = resource_path("beta-1.svg")
    if os.path.exists(icon_path):
        icon = QIcon(icon_path)
        app.setWindowIcon(icon)
    else:
        # 如果打包环境下找不到图标，提示
        if hasattr(sys, '_MEIPASS'):
             QMessageBox.warning(None, "Icon Missing", f"Icon not found at: {icon_path}")
    
    window = BrowserWindowCreatorGUI()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
