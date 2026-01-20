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
        
        # 1. 优先从 accounts.txt 导入（使用新的解析方式）
        accounts_path = os.path.join(BASE_DIR, "accounts.txt")
        if os.path.exists(accounts_path):
            try:
                # 使用ix_window中的read_accounts函数
                from ix_window import read_accounts
                accounts = read_accounts(accounts_path)
                
                print(f"从 accounts.txt 读取到 {len(accounts)} 个账号")
                
                for account in accounts:
                    email = account.get('email', '')
                    pwd = account.get('password', '')
                    rec = account.get('backup_email', '')
                    sec = account.get('2fa_secret', '')
                    
                    if email:
                        # 新账号默认状态为pending（待处理）
                        DBManager.upsert_account(email, pwd, rec, sec, None, status='pending')
                        count_total += 1
                
                print(f"成功导入 {count_total} 个账号（状态: pending）")
            except Exception as e:
                print(f"从 accounts.txt 导入时出错: {e}")
        
        # 2. 从状态文件导入（覆盖accounts.txt中的状态）
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
                       link=None, status=None, message=None):
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
                    fields = []
                    values = []
                    if password is not None: fields.append("password = ?"); values.append(password)
                    if recovery_email is not None: fields.append("recovery_email = ?"); values.append(recovery_email)
                    if secret_key is not None: fields.append("secret_key = ?"); values.append(secret_key)
                    if link is not None: fields.append("verification_link = ?"); values.append(link)
                    if status is not None: fields.append("status = ?"); values.append(status)
                    if message is not None: fields.append("message = ?"); values.append(message)
                    
                    if fields:
                        fields.append("updated_at = CURRENT_TIMESTAMP")
                        values.append(email)
                        sql = f"UPDATE accounts SET {', '.join(fields)} WHERE email = ?"
                        cursor.execute(sql, values)
                        print(f"[DB] 更新账号: {email}, 状态: {status}")
                else:
                    # 插入新记录
                    cursor.execute('''
                        INSERT INTO accounts (email, password, recovery_email, secret_key, verification_link, status, message)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                    ''', (email, password, recovery_email, secret_key, link, status or 'pending', message))
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
