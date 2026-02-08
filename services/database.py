import sqlite3
import os
import sys
import threading

from core.data_parser import parse_account_line, build_account_line
from services.repositories import (
    AccountRepository,
    CardRepository,
    HistoryRepository,
    ProxyRepository,
    RecoveryEmailRepository,
)

# 数据库路径 - 使用项目根目录
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
DB_PATH = os.path.join(BASE_DIR, "accounts.db")

lock = threading.Lock()

class DBManager:
    @staticmethod
    def get_connection():
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # 启用外键约束支持（SQLite 默认禁用）
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @staticmethod
    def init_db():
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            # 创建账号表
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS accounts (
                    email TEXT PRIMARY KEY,
                    password TEXT,
                    recovery_email TEXT,
                    secret_key TEXT,
                    verification_link TEXT,
                    status TEXT DEFAULT 'pending',
                    message TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

            # 动态添加 sheerid_steps 列（如果不存在）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN sheerid_steps INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 last_failed_step 列（用于断点续传）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN last_failed_step TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 last_error 列（记录最后错误信息）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN last_error TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # ==================== Sub2API 集成字段 (V2.0) ====================

            # 动态添加 sub2api_account_id 列（Sub2API 返回的账号 ID）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN sub2api_account_id INTEGER")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 sub2api_status 列（关联状态）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN sub2api_status TEXT DEFAULT 'not_linked'")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 sub2api_session_id 列（OAuth 会话 ID）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN sub2api_session_id TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 login_status 列（登录状态）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN login_status TEXT DEFAULT 'not_logged'")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 last_login_at 列（最后登录时间）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN last_login_at TIMESTAMP")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 browser_profile_id 列（绑定的浏览器窗口 ID）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN browser_profile_id TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # ==================== 403 解锁状态字段 ====================

            # 动态添加 unlock_status 列（403 解锁状态）
            # 状态值: none / needs_unlock / unlocking / unlocked / unlock_failed
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN unlock_status TEXT DEFAULT 'none'")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 validation_url 列（403 验证链接）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN validation_url TEXT")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # ==================== Google One Pro 会员状态 ====================

            # 动态添加 is_pro 列（Pro 会员状态）
            # 状态值: unknown / yes / no / family_yes
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN is_pro TEXT DEFAULT 'unknown'")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 family_member_count 列（家庭组成员数量）
            # 0 = 未检测/无家庭组, 1-6 = 当前家庭成员数（包括管理员自己）
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN family_member_count INTEGER DEFAULT 0")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 动态添加 family_sharing_enabled 列（家庭共享是否已开启）
            # 状态值: unknown / yes / no
            try:
                cursor.execute("ALTER TABLE accounts ADD COLUMN family_sharing_enabled TEXT DEFAULT 'unknown'")
            except sqlite3.OperationalError:
                pass  # 列已存在

            # 创建卡片表
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    number TEXT NOT NULL,
                    exp_month TEXT,
                    exp_year TEXT,
                    cvv TEXT,
                    name TEXT DEFAULT 'John Smith',
                    zip_code TEXT DEFAULT '10001',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

            # 创建代理表
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS proxies (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    proxy_type TEXT DEFAULT 'socks5',
                    username TEXT,
                    password TEXT,
                    host TEXT NOT NULL,
                    port TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            ''')

            # 创建代理-窗口绑定表
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS proxy_window_bindings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    proxy_id INTEGER NOT NULL,
                    browser_id TEXT NOT NULL,
                    email TEXT,
                    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE CASCADE,
                    UNIQUE(browser_id)
                )
            ''')

            # Check for existing data
            cursor.execute("SELECT count(*) FROM accounts")
            count = cursor.fetchone()[0]

            conn.commit()
            conn.close()

        # 不再自动从文件导入，用户需要通过配置管理手动导入
        # if count == 0:
        #     DBManager.import_from_files()

    @staticmethod
    def _simple_parse(line):
        """
        解析账号信息行 - 委托给统一解析器
        保留此方法以兼容现有调用
        """
        return parse_account_line(line)

    @staticmethod
    def import_from_files():
        """从现有文本文件导入数据到数据库（初始化用）"""
        count_total = 0

        # 从状态文件导入
        files_map = {
            "link_ready": "sheerIDlink.txt",
            "verified": "已验证未绑卡.txt",
            "subscribed": "已绑卡号.txt",
            "ineligible": "无资格号.txt",
            "error": "超时或其他错误.txt"
        }
        
        count_status = 0
        for status, filename in files_map.items():
            path = os.path.join(BASE_DIR, filename)
            if not os.path.exists(path): 
                continue
            
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    lines = [l.strip() for l in f.readlines() if l.strip() and not l.startswith('#')]
                
                for line in lines:
                    email, pwd, rec, sec, link = DBManager._simple_parse(line)
                    if email:
                        DBManager.upsert_account(email, pwd, rec, sec, link, status=status)
                        count_status += 1
            except Exception as e:
                print(f"从 {filename} 导入时出错: {e}")
        
        if count_status > 0:
            print(f"从状态文件导入/更新了 {count_status} 个账号")
        
        total = count_total + count_status
        if total > 0:
            print(f"数据库初始化完成，共处理 {total} 条记录")

    @staticmethod
    def upsert_account(email, password=None, recovery_email=None, secret_key=None,
                       link=None, status=None, message=None, sheerid_steps=None,
                       last_failed_step=None, last_error=None, browser_profile_id=None):
        """插入或更新账号信息"""
        if not email:
            print(f"[DB] upsert_account: email 为空，跳过")
            return

        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()

                # 先检查是否存在
                cursor.execute("SELECT * FROM accounts WHERE email = ?", (email,))
                exists = cursor.fetchone()

                if exists:
                    # 构建更新语句 - 使用 is not None 而不是 truthiness 判断
                    # 特殊处理：空字符串 "" 表示要清除字段
                    fields = []
                    values = []
                    if password is not None: fields.append("password = ?"); values.append(password)
                    if recovery_email is not None: fields.append("recovery_email = ?"); values.append(recovery_email)
                    if secret_key is not None: fields.append("secret_key = ?"); values.append(secret_key)
                    if link is not None: fields.append("verification_link = ?"); values.append(link)
                    if status is not None: fields.append("status = ?"); values.append(status)
                    if message is not None: fields.append("message = ?"); values.append(message)
                    if sheerid_steps is not None: fields.append("sheerid_steps = ?"); values.append(sheerid_steps)
                    # last_failed_step 和 last_error 支持传 "" 来清除
                    if last_failed_step is not None: fields.append("last_failed_step = ?"); values.append(last_failed_step if last_failed_step else None)
                    if last_error is not None: fields.append("last_error = ?"); values.append(last_error if last_error else None)
                    if browser_profile_id is not None: fields.append("browser_profile_id = ?"); values.append(browser_profile_id)

                    if fields:
                        fields.append("updated_at = CURRENT_TIMESTAMP")
                        values.append(email)
                        sql = f"UPDATE accounts SET {', '.join(fields)} WHERE email = ?"
                        cursor.execute(sql, values)
                        print(f"[DB] 更新账号: {email}, 状态: {status}")
                else:
                    # 插入新记录
                    cursor.execute('''
                        INSERT INTO accounts (email, password, recovery_email, secret_key, verification_link, status, message, sheerid_steps, last_failed_step, last_error, browser_profile_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (email, password, recovery_email, secret_key, link, status or 'pending', message, sheerid_steps or 0, last_failed_step, last_error, browser_profile_id))
                    print(f"[DB] 插入新账号: {email}, 状态: {status or 'pending'}")

                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[DB ERROR] upsert_account 失败，email: {email}, 错误: {e}")
            import traceback
            traceback.print_exc()

    @staticmethod
    def update_status(email, status, message=None):
        DBManager.upsert_account(email, status=status, message=message)

    @staticmethod
    def update_account_recovery_email(email: str, recovery_email: str) -> bool:
        """
        更新账号的辅助邮箱

        Args:
            email: 账号邮箱
            recovery_email: 新的辅助邮箱

        Returns:
            bool: 是否成功
        """
        try:
            DBManager.upsert_account(email, recovery_email=recovery_email)
            print(f"[DB] 更新辅助邮箱: {email} → {recovery_email}")
            return True
        except Exception as e:
            print(f"[DB ERROR] update_account_recovery_email 失败: {e}")
            return False

    @staticmethod
    def get_accounts_by_status(status):
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM accounts WHERE status = ?", (status,))
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]
            
    @staticmethod
    def get_all_accounts():
        return AccountRepository.get_all_accounts(DBManager.get_connection, lock)

    @staticmethod
    def get_account_by_email(email: str) -> dict:
        """根据邮箱获取单个账号信息"""
        return AccountRepository.get_account_by_email(email, DBManager.get_connection, lock)

    @staticmethod
    def delete_account(email: str) -> bool:
        """从数据库删除账号"""
        return AccountRepository.delete_account(email, DBManager.get_connection, lock)

    @staticmethod
    def export_to_files():
        """将数据库导出为传统文本文件，方便查看 (覆盖写入)"""
        print("[DB] 开始导出数据库到文本文件...")

        files_map = {
            "link_ready": "sheerIDlink.txt",
            "verified": "已验证未绑卡.txt",
            "subscribed": "已绑卡号.txt",
            "ineligible": "无资格号.txt",
            "error": "超时或其他错误.txt"
        }

        # link_ready 状态的账号同时也写入"有资格待验证号.txt"作为备份
        pending_file = "有资格待验证号.txt"

        try:
            # 优化：仅在数据库读取时持有锁，文件写入在锁外执行
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts")
                rows = cursor.fetchall()
                conn.close()

            print(f"[DB] 从数据库读取了 {len(rows)} 条记录")

            # 数据处理在锁外进行
            data = {k: [] for k in files_map.keys()}
            pending_data = []

            for row in rows:
                st = row['status']
                if st == 'running' or st == 'processing': continue

                # 使用统一的行构建函数
                line_acc = build_account_line(
                    email=row['email'],
                    password=row['password'],
                    recovery=row['recovery_email'],
                    secret=row['secret_key']
                )

                if st == 'link_ready':
                    if row['verification_link']:
                        line_link = f"{row['verification_link']}----{line_acc}"
                        data['link_ready'].append(line_link)
                    pending_data.append(line_acc)

                elif st in data:
                     data[st].append(line_acc)

            # 文件写入在锁外执行，避免长时间持有锁
            for status, filename in files_map.items():
                target_path = os.path.join(BASE_DIR, filename)
                lines = data[status]
                with open(target_path, 'w', encoding='utf-8') as f:
                    for l in lines:
                        f.write(l + "\n")
                print(f"[DB] 导出 {len(lines)} 条记录到 {filename}")

            pending_path = os.path.join(BASE_DIR, pending_file)
            with open(pending_path, 'w', encoding='utf-8') as f:
                for l in pending_data:
                    f.write(l + "\n")
            print(f"[DB] 导出 {len(pending_data)} 条记录到 {pending_file}")

            print("[DB] 导出完成！")
        except Exception as e:
            print(f"[DB ERROR] export_to_files 失败: {e}")
            import traceback
            traceback.print_exc()

    # ==================== Cards CRUD ====================

    @staticmethod
    def get_all_cards():
        """获取所有卡片"""
        return CardRepository.get_all_cards(DBManager.get_connection, lock)

    @staticmethod
    def save_all_cards(cards: list):
        """保存所有卡片（先清空再插入）"""
        CardRepository.save_all_cards(cards, DBManager.get_connection, lock)

    @staticmethod
    def add_card(card: dict):
        """添加单张卡片"""
        CardRepository.add_card(card, DBManager.get_connection, lock)

    @staticmethod
    def delete_card(card_id: int):
        """删除卡片"""
        CardRepository.delete_card(card_id, DBManager.get_connection, lock)

    # ==================== Proxies CRUD ====================

    @staticmethod
    def get_all_proxies():
        """获取所有代理"""
        return ProxyRepository.get_all_proxies(DBManager.get_connection, lock)

    @staticmethod
    def save_all_proxies(proxies: list):
        """
        保存所有代理（增量更新策略，保留绑定关系）
        通过 host:port 唯一键匹配更新现有记录，删除多余记录，添加新记录
        """
        ProxyRepository.save_all_proxies(proxies, DBManager.get_connection, lock)

    @staticmethod
    def add_proxy(proxy: dict):
        """添加单个代理"""
        ProxyRepository.add_proxy(proxy, DBManager.get_connection, lock)

    @staticmethod
    def delete_proxy(proxy_id: int):
        """删除代理"""
        ProxyRepository.delete_proxy(proxy_id, DBManager.get_connection, lock)

    # ==================== Proxy Window Bindings ====================

    @staticmethod
    def get_proxy_binding_count(proxy_id: int) -> int:
        """获取代理已绑定的窗口数量"""
        return ProxyRepository.get_proxy_binding_count(proxy_id, DBManager.get_connection, lock)

    @staticmethod
    def get_proxy_bindings(proxy_id: int) -> list:
        """获取代理关联的所有窗口"""
        return ProxyRepository.get_proxy_bindings(proxy_id, DBManager.get_connection, lock)

    @staticmethod
    def get_all_proxy_usage_stats(max_per_ip: int) -> list:
        """
        获取所有代理的使用统计
        返回: [{proxy_id, proxy_type, host, port, used_count, max_count, is_full}]
        """
        return ProxyRepository.get_all_proxy_usage_stats(max_per_ip, DBManager.get_connection, lock)

    @staticmethod
    def bind_proxy_to_window(proxy_id: int, browser_id: str, email: str = None) -> bool:
        """绑定代理到窗口"""
        return ProxyRepository.bind_proxy_to_window(
            proxy_id,
            browser_id,
            email,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def unbind_proxy_from_window(browser_id: str) -> bool:
        """解绑窗口的代理"""
        return ProxyRepository.unbind_proxy_from_window(browser_id, DBManager.get_connection, lock)

    @staticmethod
    def get_next_available_proxy(max_per_ip: int) -> dict | None:
        """
        获取下一个可用代理（顺序分配策略）
        返回第一个未达上限的代理，如果都满了返回 None
        """
        return ProxyRepository.get_next_available_proxy(max_per_ip, DBManager.get_connection, lock)

    # ==================== Phone Modification History ====================

    @staticmethod
    def init_phone_modification_table():
        """初始化手机号修改历史表"""
        HistoryRepository.init_phone_modification_table(DBManager.get_connection, lock)

    @staticmethod
    def get_phone_modification_history() -> dict:
        """获取所有手机号修改历史记录，返回 {email: {new_phone, modified_at}}"""
        try:
            DBManager.init_phone_modification_table()
            return HistoryRepository.get_phone_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_phone_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_phone_modification(email: str, new_phone: str):
        """添加或更新手机号修改记录"""
        try:
            DBManager.init_phone_modification_table()
            HistoryRepository.add_phone_modification(
                email,
                new_phone,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_phone_modification 失败: {e}")

    @staticmethod
    def clear_phone_modification_history():
        """清除所有手机号修改历史记录"""
        try:
            DBManager.init_phone_modification_table()
            return HistoryRepository.clear_phone_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_phone_modification_history 失败: {e}")
            return 0

    # ==================== Email Modification History ====================

    @staticmethod
    def init_email_modification_table():
        """初始化邮箱修改历史表"""
        HistoryRepository.init_email_modification_table(DBManager.get_connection, lock)

    @staticmethod
    def get_email_modification_history() -> dict:
        """获取所有邮箱修改历史记录，返回 {email: {new_recovery_email, modified_at}}"""
        try:
            DBManager.init_email_modification_table()
            return HistoryRepository.get_email_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_email_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_email_modification(email: str, new_recovery_email: str):
        """添加或更新邮箱修改记录"""
        try:
            DBManager.init_email_modification_table()
            HistoryRepository.add_email_modification(
                email,
                new_recovery_email,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_email_modification 失败: {e}")

    @staticmethod
    def clear_email_modification_history():
        """清除所有邮箱修改历史记录"""
        try:
            DBManager.init_email_modification_table()
            return HistoryRepository.clear_email_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_email_modification_history 失败: {e}")
            return 0

    # ==================== 2SV Phone Modification History ====================

    @staticmethod
    def init_2sv_phone_modification_table():
        """初始化2SV手机号修改历史表"""
        HistoryRepository.init_2sv_phone_modification_table(DBManager.get_connection, lock)

    @staticmethod
    def get_2sv_phone_modification_history() -> dict:
        """获取所有2SV手机号修改历史记录，返回 {email: {new_phone, modified_at}}"""
        try:
            DBManager.init_2sv_phone_modification_table()
            return HistoryRepository.get_2sv_phone_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_2sv_phone_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_2sv_phone_modification(email: str, new_phone: str):
        """添加或更新2SV手机号修改记录"""
        try:
            DBManager.init_2sv_phone_modification_table()
            HistoryRepository.add_2sv_phone_modification(
                email,
                new_phone,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_2sv_phone_modification 失败: {e}")

    @staticmethod
    def clear_2sv_phone_modification_history():
        """清除所有2SV手机号修改历史记录"""
        try:
            DBManager.init_2sv_phone_modification_table()
            return HistoryRepository.clear_2sv_phone_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_2sv_phone_modification_history 失败: {e}")
            return 0

    # ==================== Authenticator Modification History ====================

    @staticmethod
    def init_authenticator_modification_table():
        """初始化身份验证器修改历史表"""
        HistoryRepository.init_authenticator_modification_table(DBManager.get_connection, lock)

    @staticmethod
    def get_authenticator_modification_history() -> dict:
        """获取所有身份验证器修改历史记录，返回 {email: {new_secret, modified_at}}"""
        try:
            DBManager.init_authenticator_modification_table()
            return HistoryRepository.get_authenticator_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_authenticator_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_authenticator_modification(email: str, new_secret: str):
        """添加或更新身份验证器修改记录"""
        try:
            DBManager.init_authenticator_modification_table()
            HistoryRepository.add_authenticator_modification(
                email,
                new_secret,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_authenticator_modification 失败: {e}")

    @staticmethod
    def clear_authenticator_modification_history():
        """清除所有身份验证器修改历史记录"""
        try:
            DBManager.init_authenticator_modification_table()
            return HistoryRepository.clear_authenticator_modification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_authenticator_modification_history 失败: {e}")
            return 0

    # ==================== SheerID Verification History ====================

    @staticmethod
    def init_sheerid_verification_table():
        """初始化SheerID验证历史表"""
        HistoryRepository.init_sheerid_verification_table(DBManager.get_connection, lock)

    @staticmethod
    def get_sheerid_verification_history() -> dict:
        """获取所有SheerID验证历史记录，返回 {email: {verification_id, verification_result, message, verified_at}}"""
        try:
            DBManager.init_sheerid_verification_table()
            return HistoryRepository.get_sheerid_verification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_sheerid_verification_history 失败: {e}")
            return {}

    @staticmethod
    def add_sheerid_verification(email: str, verification_id: str, verification_result: str, message: str = None):
        """添加或更新SheerID验证记录"""
        try:
            DBManager.init_sheerid_verification_table()
            HistoryRepository.add_sheerid_verification(
                email,
                verification_id,
                verification_result,
                message,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_sheerid_verification 失败: {e}")

    @staticmethod
    def clear_sheerid_verification_history():
        """清除所有SheerID验证历史记录"""
        try:
            DBManager.init_sheerid_verification_table()
            return HistoryRepository.clear_sheerid_verification_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_sheerid_verification_history 失败: {e}")
            return 0

    # ==================== 综合查询方法 ====================

    @staticmethod
    def get_comprehensive_account_data() -> list:
        """
        获取综合账户数据，合并所有修改历史
        返回包含所有状态信息的账户列表
        """
        try:
            # 确保所有表都存在
            DBManager.init_phone_modification_table()
            DBManager.init_email_modification_table()
            DBManager.init_2sv_phone_modification_table()
            DBManager.init_authenticator_modification_table()
            DBManager.init_sheerid_verification_table()
            DBManager.init_bind_card_history_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()

                # 使用 LEFT JOIN 合并所有表
                cursor.execute('''
                    SELECT
                        a.email,
                        a.password,
                        a.recovery_email,
                        a.secret_key,
                        a.verification_link,
                        a.status,
                        a.message,
                        a.updated_at,
                        p.new_phone as phone_new,
                        p.modified_at as phone_modified_at,
                        e.new_recovery_email as email_new,
                        e.modified_at as email_modified_at,
                        sv.new_phone as sv2_phone_new,
                        sv.modified_at as sv2_phone_modified_at,
                        auth.new_secret as auth_new_secret,
                        auth.modified_at as auth_modified_at,
                        sh.verification_id as sheerid_id,
                        sh.verification_result as sheerid_result,
                        sh.message as sheerid_message,
                        sh.verified_at as sheerid_verified_at,
                        bc.card_number as bind_card_number,
                        bc.bound_at as bind_card_at
                    FROM accounts a
                    LEFT JOIN phone_modification_history p ON a.email = p.email
                    LEFT JOIN email_modification_history e ON a.email = e.email
                    LEFT JOIN sv2_phone_modification_history sv ON a.email = sv.email
                    LEFT JOIN authenticator_modification_history auth ON a.email = auth.email
                    LEFT JOIN sheerid_verification_history sh ON a.email = sh.email
                    LEFT JOIN bind_card_history bc ON a.email = bc.email
                    ORDER BY a.updated_at DESC
                ''')
                rows = cursor.fetchall()
                conn.close()

                result = []
                for row in rows:
                    result.append({
                        'email': row['email'],
                        'password': row['password'],
                        'recovery_email': row['recovery_email'],
                        'secret_key': row['secret_key'],
                        'verification_link': row['verification_link'],
                        'status': row['status'],
                        'message': row['message'],
                        'updated_at': row['updated_at'],
                        # 辅助手机号修改
                        'phone_modified': row['phone_new'] is not None,
                        'phone_new': row['phone_new'],
                        'phone_modified_at': row['phone_modified_at'],
                        # 辅助邮箱修改
                        'email_modified': row['email_new'] is not None,
                        'email_new': row['email_new'],
                        'email_modified_at': row['email_modified_at'],
                        # 2SV手机号修改
                        'sv2_phone_modified': row['sv2_phone_new'] is not None,
                        'sv2_phone_new': row['sv2_phone_new'],
                        'sv2_phone_modified_at': row['sv2_phone_modified_at'],
                        # 身份验证器修改
                        'auth_modified': row['auth_new_secret'] is not None,
                        'auth_new_secret': row['auth_new_secret'],
                        'auth_modified_at': row['auth_modified_at'],
                        # SheerID验证
                        'sheerid_verified': row['sheerid_result'] is not None,
                        'sheerid_id': row['sheerid_id'],
                        'sheerid_result': row['sheerid_result'],
                        'sheerid_message': row['sheerid_message'],
                        'sheerid_verified_at': row['sheerid_verified_at'],
                        # 绑卡记录
                        'bind_card': row['bind_card_number'] is not None,
                        'bind_card_number': row['bind_card_number'],
                        'bind_card_at': row['bind_card_at'],
                    })
                return result
        except Exception as e:
            print(f"[DB ERROR] get_comprehensive_account_data 失败: {e}")
            import traceback
            traceback.print_exc()
            return []

    # ==================== Bind Card History ====================

    @staticmethod
    def init_bind_card_history_table():
        """初始化绑卡历史表"""
        HistoryRepository.init_bind_card_history_table(DBManager.get_connection, lock)

    @staticmethod
    def get_bind_card_history() -> dict:
        """获取所有绑卡历史记录，返回 {email: {card_number, bound_at}}"""
        try:
            DBManager.init_bind_card_history_table()
            return HistoryRepository.get_bind_card_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_bind_card_history 失败: {e}")
            return {}

    @staticmethod
    def add_bind_card_history(email: str, card_number: str):
        """添加或更新绑卡记录"""
        try:
            DBManager.init_bind_card_history_table()
            HistoryRepository.add_bind_card_history(
                email,
                card_number,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_bind_card_history 失败: {e}")

    @staticmethod
    def clear_bind_card_history() -> int:
        """清除所有绑卡历史记录"""
        try:
            DBManager.init_bind_card_history_table()
            return HistoryRepository.clear_bind_card_history(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB ERROR] clear_bind_card_history 失败: {e}")
            return 0

    @staticmethod
    def get_card_usage_counts() -> dict:
        """
        获取每张卡的使用次数统计

        Returns:
            dict: {card_number后4位: 使用次数}
        """
        try:
            DBManager.init_bind_card_history_table()
            return CardRepository.get_card_usage_counts(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_card_usage_counts 失败: {e}")
            return {}

    @staticmethod
    def get_next_available_card(cards: list, cards_per_account: int) -> tuple:
        """
        获取下一张可用的卡片

        基于数据库中的绑卡历史，找到第一张未达到使用上限的卡片。

        Args:
            cards: 卡片列表，每个卡片是 dict，包含 'number' 字段
            cards_per_account: 每张卡可绑定的账号数上限

        Returns:
            tuple: (card_dict, card_index) 或 (None, -1) 如果所有卡都已满
        """
        return CardRepository.get_next_available_card(
            cards,
            cards_per_account,
            DBManager.get_card_usage_counts,
        )

    # ==================== Recovery Email Pool (辅助邮箱池) ====================

    @staticmethod
    def init_recovery_email_pool_tables():
        """初始化辅助邮箱池相关表"""
        RecoveryEmailRepository.init_recovery_email_pool_tables(DBManager.get_connection, lock)

    @staticmethod
    def get_recovery_email_pool() -> list:
        """获取所有辅助邮箱池"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.get_recovery_email_pool(DBManager.get_connection, lock)
        except Exception as e:
            print(f"[DB] get_recovery_email_pool 失败: {e}")
            return []

    @staticmethod
    def add_recovery_email_to_pool(email: str, imap_password: str = "", note: str = "") -> bool:
        """添加辅助邮箱到池"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.add_recovery_email_to_pool(
                email,
                imap_password,
                note,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] add_recovery_email_to_pool 失败: {e}")
            return False

    @staticmethod
    def remove_recovery_email_from_pool(email: str) -> bool:
        """从池中移除辅助邮箱"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.remove_recovery_email_from_pool(
                email,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] remove_recovery_email_from_pool 失败: {e}")
            return False

    @staticmethod
    def update_recovery_email_enabled(email: str, is_enabled: bool) -> bool:
        """更新辅助邮箱启用状态"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.update_recovery_email_enabled(
                email,
                is_enabled,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] update_recovery_email_enabled 失败: {e}")
            return False

    @staticmethod
    def get_recovery_email_daily_usage(date: str = None) -> dict:
        """
        获取指定日期的邮箱使用量
        返回 {email: bind_count}
        """
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.get_recovery_email_daily_usage(
                date,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB] get_recovery_email_daily_usage 失败: {e}")
            return {}

    @staticmethod
    def increment_recovery_email_usage(recovery_email: str, date: str = None) -> bool:
        """增加辅助邮箱今日使用次数"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.increment_recovery_email_usage(
                recovery_email,
                date,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] increment_recovery_email_usage 失败: {e}")
            return False

    @staticmethod
    def reset_recovery_email_daily_usage(date: str = None) -> int:
        """重置指定日期的使用量（默认今天）"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.reset_recovery_email_daily_usage(
                date,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] reset_recovery_email_daily_usage 失败: {e}")
            return 0

    @staticmethod
    def set_recovery_email_usage_full(recovery_email: str, limit: int, date: str = None) -> bool:
        """
        将指定邮箱的当日使用量直接设为上限值（标记为不可用）

        Args:
            recovery_email: 辅助邮箱地址
            limit: 每日限制数（DAILY_BIND_LIMIT）
            date: 日期，默认今天

        Returns:
            bool: 操作是否成功
        """
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.set_recovery_email_usage_full(
                recovery_email,
                limit,
                date,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] set_recovery_email_usage_full 失败: {e}")
            return False

    @staticmethod
    def get_account_recovery_binding(email: str) -> dict:
        """获取账号的辅助邮箱绑定信息"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.get_account_recovery_binding(
                email,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB] get_account_recovery_binding 失败: {e}")
            return None

    @staticmethod
    def set_account_recovery_binding(email: str, bound_recovery_email: str, status: str = 'bound') -> bool:
        """设置账号的辅助邮箱绑定关系"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.set_account_recovery_binding(
                email,
                bound_recovery_email,
                status,
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB ERROR] set_account_recovery_binding 失败: {e}")
            return False

    @staticmethod
    def get_all_account_recovery_bindings() -> dict:
        """获取所有账号的辅助邮箱绑定关系"""
        try:
            DBManager.init_recovery_email_pool_tables()
            return RecoveryEmailRepository.get_all_account_recovery_bindings(
                DBManager.get_connection,
                lock,
            )
        except Exception as e:
            print(f"[DB] get_all_account_recovery_bindings 失败: {e}")
            return {}

    # ==================== Sub2API 集成方法 (V2.0) ====================

    @staticmethod
    def bind_account_to_browser(email: str, browser_profile_id: str) -> bool:
        """
        绑定账号到浏览器窗口

        Args:
            email: 账号邮箱
            browser_profile_id: ixBrowser 窗口 ID

        Returns:
            bool: 是否成功
        """
        return AccountRepository.bind_account_to_browser(
            email,
            browser_profile_id,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_account_by_browser(browser_profile_id: str) -> dict:
        """
        根据窗口 ID 获取绑定的账号

        Args:
            browser_profile_id: ixBrowser 窗口 ID

        Returns:
            dict: 账号信息，未找到返回 None
        """
        return AccountRepository.get_account_by_browser(
            browser_profile_id,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_unbound_accounts() -> list:
        """
        获取未绑定窗口的账号列表

        Returns:
            list: 未绑定窗口的账号列表
        """
        return AccountRepository.get_unbound_accounts(DBManager.get_connection, lock)

    @staticmethod
    def update_sub2api_status(email: str, status: str, account_id: int = None, session_id: str = None) -> bool:
        """
        更新账号的 Sub2API 关联状态

        Args:
            email: 账号邮箱
            status: 关联状态 (not_linked/linking/linked/oauth_failed)
            account_id: Sub2API 返回的账号 ID（可选）
            session_id: OAuth 会话 ID（可选）

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_sub2api_status(
            email,
            status,
            account_id,
            session_id,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_accounts_by_sub2api_status(status: str) -> list:
        """
        根据 Sub2API 状态查询账号

        Args:
            status: 关联状态 (not_linked/linking/linked/oauth_failed)

        Returns:
            list: 符合条件的账号列表
        """
        return AccountRepository.get_accounts_by_sub2api_status(
            status,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def update_login_status(email: str, status: str, last_error: str = None) -> bool:
        """
        更新账号登录状态

        Args:
            email: 账号邮箱
            status: 登录状态 (not_logged/logging_in/logged_in/login_failed)
            last_error: 登录失败时的错误信息（可选）

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_login_status(
            email,
            status,
            last_error,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def update_pro_status(email: str, is_pro: str) -> bool:
        """
        更新账号 Pro 会员状态

        Args:
            email: 账号邮箱
            is_pro: Pro 状态 (unknown/yes/no/family_yes)

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_pro_status(
            email,
            is_pro,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_accounts_by_login_status(status: str) -> list:
        """
        根据登录状态查询账号

        Args:
            status: 登录状态 (not_logged/logging_in/logged_in/login_failed)

        Returns:
            list: 符合条件的账号列表
        """
        return AccountRepository.get_accounts_by_login_status(
            status,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_accounts_for_sub2api() -> list:
        """
        获取可以添加到 Sub2API 的账号列表

        条件：
        - 已登录 (login_status = 'logged_in')
        - 未关联 Sub2API (sub2api_status = 'not_linked' 或为空)

        Returns:
            list: 符合条件的账号列表
        """
        return AccountRepository.get_accounts_for_sub2api(DBManager.get_connection, lock)

    # ==================== 403 解锁状态管理 ====================

    @staticmethod
    def update_unlock_status(email: str, status: str, validation_url: str = None) -> bool:
        """
        更新账号的 403 解锁状态

        Args:
            email: 账号邮箱
            status: 解锁状态 (none/needs_unlock/unlocking/unlocked/unlock_failed)
            validation_url: 验证链接（可选）

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_unlock_status(
            email,
            status,
            validation_url,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_accounts_by_unlock_status(status: str) -> list:
        """
        根据解锁状态查询账号

        Args:
            status: 解锁状态 (none/needs_unlock/unlocking/unlocked/unlock_failed)

        Returns:
            list: 符合条件的账号列表
        """
        return AccountRepository.get_accounts_by_unlock_status(
            status,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_accounts_needing_unlock() -> list:
        """
        获取需要解锁的账号列表

        返回 unlock_status 为 'needs_unlock' 或 'unlock_failed' 的账号

        Returns:
            list: 需要解锁的账号列表
        """
        return AccountRepository.get_accounts_needing_unlock(DBManager.get_connection, lock)

    # ==================== 家庭组功能 ====================

    @staticmethod
    def update_family_member_count(email: str, count: int) -> bool:
        """
        更新账号的家庭组成员数量

        Args:
            email: 账号邮箱
            count: 家庭成员数量 (0-6)

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_family_member_count(
            email,
            count,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def update_family_sharing_enabled(email: str, status: str) -> bool:
        """
        更新账号的家庭共享开启状态

        Args:
            email: 账号邮箱
            status: 家庭共享状态 ('unknown' / 'yes' / 'no')

        Returns:
            bool: 是否成功
        """
        return AccountRepository.update_family_sharing_enabled(
            email,
            status,
            DBManager.get_connection,
            lock,
        )

    @staticmethod
    def get_pro_accounts_for_sharing() -> list:
        """
        获取可以开启家庭共享的普通 Pro 账户

        条件：
        - is_pro = 'yes' (普通 Pro，非家庭组 Pro)
        - login_status = 'logged_in' (已登录)
        - browser_profile_id 已绑定 (有浏览器窗口)
        - family_sharing_enabled != 'yes' (尚未开启或未知)

        Returns:
            list: 可开启共享的 Pro 账户列表
        """
        return AccountRepository.get_pro_accounts_for_sharing(DBManager.get_connection, lock)

    @staticmethod
    def get_available_pro_accounts() -> list:
        """
        获取可以邀请家庭成员的普通 Pro 账户

        条件：
        - is_pro = 'yes' (普通 Pro，非家庭组 Pro)
        - family_member_count < 6 (家庭组未满)
        - login_status = 'logged_in' (已登录)
        - browser_profile_id 已绑定 (有浏览器窗口)

        Returns:
            list: 可用的 Pro 账户列表，包含 available_slots 字段
        """
        return AccountRepository.get_available_pro_accounts(DBManager.get_connection, lock)

    @staticmethod
    def get_family_pro_accounts() -> list:
        """
        获取家庭组 Pro 账户（可以加入其他家庭组的账户）

        条件：
        - is_pro = 'family_yes' (家庭组 Pro)
        - login_status = 'logged_in' (已登录)

        Returns:
            list: 家庭组 Pro 账户列表
        """
        return AccountRepository.get_family_pro_accounts(DBManager.get_connection, lock)

