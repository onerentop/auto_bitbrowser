from .database import DBManager
from core.data_parser import parse_account_line

DBManager.init_db()

class AccountManager:
    @staticmethod
    def _parse(line):
        """使用统一解析器解析账号行"""
        email, pwd, rec, sec, link = parse_account_line(line)
        return email, pwd, rec, sec, link

    @staticmethod
    def save_link(line):
        """保存到 link_ready 状态（有资格待验证已提取链接）"""
        print(f"[AM] save_link 调用, line: {line[:100] if line else 'None'}...")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            DBManager.upsert_account(email, pwd, rec, sec, link, status='link_ready')
            DBManager.export_to_files()
        else:
            print(f"[AM] save_link: 无法解析邮箱，跳过")

    @staticmethod
    def move_to_pending(line):
        """移动到 pending 状态（待处理）"""
        print(f"[AM] move_to_pending 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            DBManager.upsert_account(email, pwd, rec, sec, link, status='pending')
            DBManager.export_to_files()
        else:
            print(f"[AM] move_to_pending: 无法解析邮箱，跳过")

    @staticmethod
    def move_to_running(line):
        """移动到 running 状态（处理中）"""
        print(f"[AM] move_to_running 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            # running 状态不导出到文件，仅更新数据库
            DBManager.upsert_account(email, pwd, rec, sec, link, status='running')
        else:
            print(f"[AM] move_to_running: 无法解析邮箱，跳过")

    @staticmethod
    def move_to_verified(line):
        """移动到 verified 状态（已验证未绑卡）- 保存完整字段"""
        print(f"[AM] move_to_verified 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            # 使用 upsert 而不是 update_status，确保保存所有字段
            DBManager.upsert_account(email, pwd, rec, sec, link, status='verified')
            DBManager.export_to_files()

    @staticmethod
    def move_to_ineligible(line):
        """移动到 ineligible 状态（无资格）"""
        print(f"[AM] move_to_ineligible 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            DBManager.upsert_account(email, pwd, rec, sec, link, status='ineligible')
            DBManager.export_to_files()
        else:
            print(f"[AM] move_to_ineligible: 无法解析邮箱，跳过")

    @staticmethod
    def move_to_error(line):
        """移动到 error 状态（超时或其他错误）"""
        print(f"[AM] move_to_error 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            DBManager.upsert_account(email, pwd, rec, sec, link, status='error')
            DBManager.export_to_files()
        else:
            print(f"[AM] move_to_error: 无法解析邮箱，跳过")

    @staticmethod
    def move_to_subscribed(line):
        """移动到 subscribed 状态（已绑卡订阅）"""
        print(f"[AM] move_to_subscribed 调用")
        email, pwd, rec, sec, link = AccountManager._parse(line)
        if email:
            DBManager.upsert_account(email, pwd, rec, sec, link, status='subscribed')
            DBManager.export_to_files()
            
    @staticmethod
    def remove_from_file_unsafe(file_key, line_or_email):
        # No-op with DB approach, handled by status update
        pass
