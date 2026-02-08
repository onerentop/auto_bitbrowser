"""账号导入导出与综合查询仓储。

Why:
- 将 `services/database.py` 中的导入/导出与综合查询聚合 SQL 下沉，
  让 DBManager 进一步收敛为兼容 Facade。
"""

from __future__ import annotations

from pathlib import Path
from threading import Lock
from typing import Callable

import sqlite3

from core.data_parser import parse_account_line, build_account_line


ConnectionFactory = Callable[[], sqlite3.Connection]


class AccountIoRepository:
    """账号 I/O 与综合查询仓储。"""

    @staticmethod
    def import_from_status_files(
        base_dir: str,
        upsert_callback: Callable[..., None],
    ) -> int:
        """从状态文本导入账号到数据库。"""
        files_map = {
            "link_ready": "sheerIDlink.txt",
            "verified": "已验证未绑卡.txt",
            "subscribed": "已绑卡号.txt",
            "ineligible": "无资格号.txt",
            "error": "超时或其他错误.txt",
        }

        count_status = 0
        base_path = Path(base_dir)

        for status, filename in files_map.items():
            file_path = base_path / filename
            if not file_path.exists():
                continue

            try:
                with file_path.open("r", encoding="utf-8") as file:
                    lines = [
                        line.strip()
                        for line in file.readlines()
                        if line.strip() and not line.startswith("#")
                    ]

                for line in lines:
                    email, password, recovery_email, secret_key, link = parse_account_line(line)
                    if not email:
                        continue
                    upsert_callback(
                        email,
                        password,
                        recovery_email,
                        secret_key,
                        link,
                        status=status,
                    )
                    count_status += 1
            except Exception as error:
                print(f"从 {filename} 导入时出错: {error}")

        if count_status > 0:
            print(f"从状态文件导入/更新了 {count_status} 个账号")

        if count_status > 0:
            print(f"数据库初始化完成，共处理 {count_status} 条记录")

        return count_status

    @staticmethod
    def export_accounts_to_status_files(
        base_dir: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """将账号按状态导出为文本文件。"""
        print("[DB] 开始导出数据库到文本文件...")

        files_map = {
            "link_ready": "sheerIDlink.txt",
            "verified": "已验证未绑卡.txt",
            "subscribed": "已绑卡号.txt",
            "ineligible": "无资格号.txt",
            "error": "超时或其他错误.txt",
        }
        pending_file = "有资格待验证号.txt"

        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts")
                rows = cursor.fetchall()
                conn.close()

            print(f"[DB] 从数据库读取了 {len(rows)} 条记录")

            data = {status: [] for status in files_map.keys()}
            pending_data: list[str] = []

            for row in rows:
                account_status = row["status"]
                if account_status in ("running", "processing"):
                    continue

                account_line = build_account_line(
                    email=row["email"],
                    password=row["password"],
                    recovery=row["recovery_email"],
                    secret=row["secret_key"],
                )

                if account_status == "link_ready":
                    if row["verification_link"]:
                        link_line = f"{row['verification_link']}----{account_line}"
                        data["link_ready"].append(link_line)
                    pending_data.append(account_line)
                elif account_status in data:
                    data[account_status].append(account_line)

            base_path = Path(base_dir)
            for status, filename in files_map.items():
                target_path = base_path / filename
                lines = data[status]
                with target_path.open("w", encoding="utf-8") as file:
                    for line in lines:
                        file.write(line + "\n")
                print(f"[DB] 导出 {len(lines)} 条记录到 {filename}")

            pending_path = base_path / pending_file
            with pending_path.open("w", encoding="utf-8") as file:
                for line in pending_data:
                    file.write(line + "\n")
            print(f"[DB] 导出 {len(pending_data)} 条记录到 {pending_file}")

            print("[DB] 导出完成！")
            return True
        except Exception as error:
            print(f"[DB ERROR] export_to_files 失败: {error}")
            return False

    @staticmethod
    def get_comprehensive_account_data(
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> list[dict]:
        """获取综合账号视图（账号 + 历史记录）。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                cursor.execute(
                    """
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
                    """
                )
                rows = cursor.fetchall()
                conn.close()

            result = []
            for row in rows:
                result.append(
                    {
                        "email": row["email"],
                        "password": row["password"],
                        "recovery_email": row["recovery_email"],
                        "secret_key": row["secret_key"],
                        "verification_link": row["verification_link"],
                        "status": row["status"],
                        "message": row["message"],
                        "updated_at": row["updated_at"],
                        "phone_modified": row["phone_new"] is not None,
                        "phone_new": row["phone_new"],
                        "phone_modified_at": row["phone_modified_at"],
                        "email_modified": row["email_new"] is not None,
                        "email_new": row["email_new"],
                        "email_modified_at": row["email_modified_at"],
                        "sv2_phone_modified": row["sv2_phone_new"] is not None,
                        "sv2_phone_new": row["sv2_phone_new"],
                        "sv2_phone_modified_at": row["sv2_phone_modified_at"],
                        "auth_modified": row["auth_new_secret"] is not None,
                        "auth_new_secret": row["auth_new_secret"],
                        "auth_modified_at": row["auth_modified_at"],
                        "sheerid_verified": row["sheerid_result"] is not None,
                        "sheerid_id": row["sheerid_id"],
                        "sheerid_result": row["sheerid_result"],
                        "sheerid_message": row["sheerid_message"],
                        "sheerid_verified_at": row["sheerid_verified_at"],
                        "bind_card": row["bind_card_number"] is not None,
                        "bind_card_number": row["bind_card_number"],
                        "bind_card_at": row["bind_card_at"],
                    }
                )

            return result
        except Exception as error:
            print(f"[DB ERROR] get_comprehensive_account_data 失败: {error}")
            return []

