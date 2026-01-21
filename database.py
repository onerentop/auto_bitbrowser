import sqlite3
import os
import sys
import threading

from core.data_parser import parse_account_line, build_account_line

# 数据库路径
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
DB_PATH = os.path.join(BASE_DIR, "accounts.db")

lock = threading.Lock()

class DBManager:
    @staticmethod
    def get_connection():
        conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        conn.row_factory = sqlite3.Row
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
                       last_failed_step=None, last_error=None):
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

                    if fields:
                        fields.append("updated_at = CURRENT_TIMESTAMP")
                        values.append(email)
                        sql = f"UPDATE accounts SET {', '.join(fields)} WHERE email = ?"
                        cursor.execute(sql, values)
                        print(f"[DB] 更新账号: {email}, 状态: {status}")
                else:
                    # 插入新记录
                    cursor.execute('''
                        INSERT INTO accounts (email, password, recovery_email, secret_key, verification_link, status, message, sheerid_steps, last_failed_step, last_error)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (email, password, recovery_email, secret_key, link, status or 'pending', message, sheerid_steps or 0, last_failed_step, last_error))
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
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM accounts")
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]

    @staticmethod
    def delete_account(email: str) -> bool:
        """从数据库删除账号"""
        with lock:
            try:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM accounts WHERE email = ?", (email,))
                conn.commit()
                deleted = cursor.rowcount > 0
                conn.close()
                return deleted
            except Exception as e:
                print(f"[DB] 删除账号失败: {e}")
                return False

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
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM cards ORDER BY id")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as e:
            print(f"[DB] get_all_cards 失败: {e}")
            return []

    @staticmethod
    def save_all_cards(cards: list):
        """保存所有卡片（先清空再插入）"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()

                # 清空现有数据
                cursor.execute("DELETE FROM cards")

                # 插入新数据
                for card in cards:
                    cursor.execute('''
                        INSERT INTO cards (number, exp_month, exp_year, cvv, name, zip_code)
                        VALUES (?, ?, ?, ?, ?, ?)
                    ''', (
                        card.get('number', ''),
                        card.get('exp_month', ''),
                        card.get('exp_year', ''),
                        card.get('cvv', ''),
                        card.get('name', 'John Smith'),
                        card.get('zip_code', '10001')
                    ))

                conn.commit()
                conn.close()
                print(f"[DB] 保存了 {len(cards)} 张卡片")
        except Exception as e:
            print(f"[DB ERROR] save_all_cards 失败: {e}")
            import traceback
            traceback.print_exc()

    @staticmethod
    def add_card(card: dict):
        """添加单张卡片"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO cards (number, exp_month, exp_year, cvv, name, zip_code)
                    VALUES (?, ?, ?, ?, ?, ?)
                ''', (
                    card.get('number', ''),
                    card.get('exp_month', ''),
                    card.get('exp_year', ''),
                    card.get('cvv', ''),
                    card.get('name', 'John Smith'),
                    card.get('zip_code', '10001')
                ))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[DB ERROR] add_card 失败: {e}")

    @staticmethod
    def delete_card(card_id: int):
        """删除卡片"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM cards WHERE id = ?", (card_id,))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[DB ERROR] delete_card 失败: {e}")

    # ==================== Proxies CRUD ====================

    @staticmethod
    def get_all_proxies():
        """获取所有代理"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM proxies ORDER BY id")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as e:
            print(f"[DB] get_all_proxies 失败: {e}")
            return []

    @staticmethod
    def save_all_proxies(proxies: list):
        """保存所有代理（先清空再插入）"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()

                # 清空现有数据
                cursor.execute("DELETE FROM proxies")

                # 插入新数据
                for proxy in proxies:
                    cursor.execute('''
                        INSERT INTO proxies (proxy_type, username, password, host, port)
                        VALUES (?, ?, ?, ?, ?)
                    ''', (
                        proxy.get('proxy_type', 'socks5'),
                        proxy.get('username', ''),
                        proxy.get('password', ''),
                        proxy.get('host', ''),
                        proxy.get('port', '')
                    ))

                conn.commit()
                conn.close()
                print(f"[DB] 保存了 {len(proxies)} 个代理")
        except Exception as e:
            print(f"[DB ERROR] save_all_proxies 失败: {e}")
            import traceback
            traceback.print_exc()

    @staticmethod
    def add_proxy(proxy: dict):
        """添加单个代理"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO proxies (proxy_type, username, password, host, port)
                    VALUES (?, ?, ?, ?, ?)
                ''', (
                    proxy.get('proxy_type', 'socks5'),
                    proxy.get('username', ''),
                    proxy.get('password', ''),
                    proxy.get('host', ''),
                    proxy.get('port', '')
                ))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[DB ERROR] add_proxy 失败: {e}")

    @staticmethod
    def delete_proxy(proxy_id: int):
        """删除代理"""
        try:
            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM proxies WHERE id = ?", (proxy_id,))
                conn.commit()
                conn.close()
        except Exception as e:
            print(f"[DB ERROR] delete_proxy 失败: {e}")

    # ==================== Phone Modification History ====================

    @staticmethod
    def init_phone_modification_table():
        """初始化手机号修改历史表"""
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS phone_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_phone TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_phone_modification_history() -> dict:
        """获取所有手机号修改历史记录，返回 {email: {new_phone, modified_at}}"""
        try:
            # 确保表存在
            DBManager.init_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_phone, modified_at FROM phone_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {'new_phone': row['new_phone'], 'modified_at': row['modified_at']} for row in rows}
        except Exception as e:
            print(f"[DB] get_phone_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_phone_modification(email: str, new_phone: str):
        """添加或更新手机号修改记录"""
        try:
            # 确保表存在
            DBManager.init_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO phone_modification_history (email, new_phone, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_phone = excluded.new_phone,
                        modified_at = CURRENT_TIMESTAMP
                ''', (email, new_phone))
                conn.commit()
                conn.close()
                print(f"[DB] 记录手机号修改: {email} -> {new_phone}")
        except Exception as e:
            print(f"[DB ERROR] add_phone_modification 失败: {e}")

    @staticmethod
    def clear_phone_modification_history():
        """清除所有手机号修改历史记录"""
        try:
            # 确保表存在
            DBManager.init_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM phone_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条手机号修改记录")
                return deleted
        except Exception as e:
            print(f"[DB ERROR] clear_phone_modification_history 失败: {e}")
            return 0

    # ==================== Email Modification History ====================

    @staticmethod
    def init_email_modification_table():
        """初始化邮箱修改历史表"""
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS email_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_recovery_email TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_email_modification_history() -> dict:
        """获取所有邮箱修改历史记录，返回 {email: {new_recovery_email, modified_at}}"""
        try:
            # 确保表存在
            DBManager.init_email_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_recovery_email, modified_at FROM email_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {'new_recovery_email': row['new_recovery_email'], 'modified_at': row['modified_at']} for row in rows}
        except Exception as e:
            print(f"[DB] get_email_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_email_modification(email: str, new_recovery_email: str):
        """添加或更新邮箱修改记录"""
        try:
            # 确保表存在
            DBManager.init_email_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO email_modification_history (email, new_recovery_email, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_recovery_email = excluded.new_recovery_email,
                        modified_at = CURRENT_TIMESTAMP
                ''', (email, new_recovery_email))
                conn.commit()
                conn.close()
                print(f"[DB] 记录邮箱修改: {email} -> {new_recovery_email}")
        except Exception as e:
            print(f"[DB ERROR] add_email_modification 失败: {e}")

    @staticmethod
    def clear_email_modification_history():
        """清除所有邮箱修改历史记录"""
        try:
            # 确保表存在
            DBManager.init_email_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM email_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条邮箱修改记录")
                return deleted
        except Exception as e:
            print(f"[DB ERROR] clear_email_modification_history 失败: {e}")
            return 0

    # ==================== 2SV Phone Modification History ====================

    @staticmethod
    def init_2sv_phone_modification_table():
        """初始化2SV手机号修改历史表"""
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS sv2_phone_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_phone TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_2sv_phone_modification_history() -> dict:
        """获取所有2SV手机号修改历史记录，返回 {email: {new_phone, modified_at}}"""
        try:
            # 确保表存在
            DBManager.init_2sv_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_phone, modified_at FROM sv2_phone_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {'new_phone': row['new_phone'], 'modified_at': row['modified_at']} for row in rows}
        except Exception as e:
            print(f"[DB] get_2sv_phone_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_2sv_phone_modification(email: str, new_phone: str):
        """添加或更新2SV手机号修改记录"""
        try:
            # 确保表存在
            DBManager.init_2sv_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO sv2_phone_modification_history (email, new_phone, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_phone = excluded.new_phone,
                        modified_at = CURRENT_TIMESTAMP
                ''', (email, new_phone))
                conn.commit()
                conn.close()
                print(f"[DB] 记录2SV手机号修改: {email} -> {new_phone}")
        except Exception as e:
            print(f"[DB ERROR] add_2sv_phone_modification 失败: {e}")

    @staticmethod
    def clear_2sv_phone_modification_history():
        """清除所有2SV手机号修改历史记录"""
        try:
            # 确保表存在
            DBManager.init_2sv_phone_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM sv2_phone_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条2SV手机号修改记录")
                return deleted
        except Exception as e:
            print(f"[DB ERROR] clear_2sv_phone_modification_history 失败: {e}")
            return 0

    # ==================== Authenticator Modification History ====================

    @staticmethod
    def init_authenticator_modification_table():
        """初始化身份验证器修改历史表"""
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS authenticator_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_secret TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_authenticator_modification_history() -> dict:
        """获取所有身份验证器修改历史记录，返回 {email: {new_secret, modified_at}}"""
        try:
            # 确保表存在
            DBManager.init_authenticator_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_secret, modified_at FROM authenticator_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {'new_secret': row['new_secret'], 'modified_at': row['modified_at']} for row in rows}
        except Exception as e:
            print(f"[DB] get_authenticator_modification_history 失败: {e}")
            return {}

    @staticmethod
    def add_authenticator_modification(email: str, new_secret: str):
        """添加或更新身份验证器修改记录"""
        try:
            # 确保表存在
            DBManager.init_authenticator_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO authenticator_modification_history (email, new_secret, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_secret = excluded.new_secret,
                        modified_at = CURRENT_TIMESTAMP
                ''', (email, new_secret))
                conn.commit()
                conn.close()
                print(f"[DB] 记录身份验证器修改: {email} -> {new_secret[:16]}...")
        except Exception as e:
            print(f"[DB ERROR] add_authenticator_modification 失败: {e}")

    @staticmethod
    def clear_authenticator_modification_history():
        """清除所有身份验证器修改历史记录"""
        try:
            # 确保表存在
            DBManager.init_authenticator_modification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM authenticator_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条身份验证器修改记录")
                return deleted
        except Exception as e:
            print(f"[DB ERROR] clear_authenticator_modification_history 失败: {e}")
            return 0

    # ==================== SheerID Verification History ====================

    @staticmethod
    def init_sheerid_verification_table():
        """初始化SheerID验证历史表"""
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS sheerid_verification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    verification_id TEXT,
                    verification_result TEXT,
                    message TEXT,
                    verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_sheerid_verification_history() -> dict:
        """获取所有SheerID验证历史记录，返回 {email: {verification_id, verification_result, message, verified_at}}"""
        try:
            # 确保表存在
            DBManager.init_sheerid_verification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, verification_id, verification_result, message, verified_at FROM sheerid_verification_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {
                    'verification_id': row['verification_id'],
                    'verification_result': row['verification_result'],
                    'message': row['message'],
                    'verified_at': row['verified_at']
                } for row in rows}
        except Exception as e:
            print(f"[DB] get_sheerid_verification_history 失败: {e}")
            return {}

    @staticmethod
    def add_sheerid_verification(email: str, verification_id: str, verification_result: str, message: str = None):
        """添加或更新SheerID验证记录"""
        try:
            # 确保表存在
            DBManager.init_sheerid_verification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO sheerid_verification_history (email, verification_id, verification_result, message, verified_at)
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        verification_id = excluded.verification_id,
                        verification_result = excluded.verification_result,
                        message = excluded.message,
                        verified_at = CURRENT_TIMESTAMP
                ''', (email, verification_id, verification_result, message))
                conn.commit()
                conn.close()
                print(f"[DB] 记录SheerID验证: {email} -> {verification_result}")
        except Exception as e:
            print(f"[DB ERROR] add_sheerid_verification 失败: {e}")

    @staticmethod
    def clear_sheerid_verification_history():
        """清除所有SheerID验证历史记录"""
        try:
            # 确保表存在
            DBManager.init_sheerid_verification_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM sheerid_verification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条SheerID验证记录")
                return deleted
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
                        sh.verified_at as sheerid_verified_at
                    FROM accounts a
                    LEFT JOIN phone_modification_history p ON a.email = p.email
                    LEFT JOIN email_modification_history e ON a.email = e.email
                    LEFT JOIN sv2_phone_modification_history sv ON a.email = sv.email
                    LEFT JOIN authenticator_modification_history auth ON a.email = auth.email
                    LEFT JOIN sheerid_verification_history sh ON a.email = sh.email
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
        with lock:
            conn = DBManager.get_connection()
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS bind_card_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    card_number TEXT NOT NULL,
                    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
            ''')
            conn.commit()
            conn.close()

    @staticmethod
    def get_bind_card_history() -> dict:
        """获取所有绑卡历史记录，返回 {email: {card_number, bound_at}}"""
        try:
            # 确保表存在
            DBManager.init_bind_card_history_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("SELECT email, card_number, bound_at FROM bind_card_history")
                rows = cursor.fetchall()
                conn.close()
                return {row['email']: {'card_number': row['card_number'], 'bound_at': row['bound_at']} for row in rows}
        except Exception as e:
            print(f"[DB] get_bind_card_history 失败: {e}")
            return {}

    @staticmethod
    def add_bind_card_history(email: str, card_number: str):
        """添加或更新绑卡记录"""
        try:
            # 确保表存在
            DBManager.init_bind_card_history_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO bind_card_history (email, card_number, bound_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        card_number = excluded.card_number,
                        bound_at = CURRENT_TIMESTAMP
                ''', (email, card_number))
                conn.commit()
                conn.close()
                print(f"[DB] 记录绑卡: {email} -> {card_number}")
        except Exception as e:
            print(f"[DB ERROR] add_bind_card_history 失败: {e}")

    @staticmethod
    def clear_bind_card_history() -> int:
        """清除所有绑卡历史记录"""
        try:
            # 确保表存在
            DBManager.init_bind_card_history_table()

            with lock:
                conn = DBManager.get_connection()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM bind_card_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条绑卡记录")
                return deleted
        except Exception as e:
            print(f"[DB ERROR] clear_bind_card_history 失败: {e}")
            return 0
