"""辅助邮箱池仓储。

Why:
- 将辅助邮箱池、每日用量、绑定关系 SQL 从 `services/database.py` 下沉。
- 保持 `DBManager` 兼容门面，避免改动扩散到上层调用。
"""

from __future__ import annotations

from datetime import datetime
from threading import Lock
from typing import Callable

import sqlite3


ConnectionFactory = Callable[[], sqlite3.Connection]


class RecoveryEmailRepository:
    """辅助邮箱池与绑定关系仓储。"""

    @staticmethod
    def init_recovery_email_pool_tables(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS recovery_email_pool (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT UNIQUE NOT NULL,
                    imap_password TEXT,
                    is_enabled INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    note TEXT
                )
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS recovery_email_daily_usage (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    recovery_email TEXT NOT NULL,
                    usage_date TEXT NOT NULL,
                    bind_count INTEGER DEFAULT 0,
                    UNIQUE(recovery_email, usage_date)
                )
                """
            )

            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS account_recovery_binding (
                    email TEXT PRIMARY KEY,
                    bound_recovery_email TEXT,
                    bound_at TIMESTAMP,
                    status TEXT DEFAULT 'unbound'
                )
                """
            )

            conn.commit()
            conn.close()

    @staticmethod
    def get_recovery_email_pool(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM recovery_email_pool ORDER BY created_at DESC")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB] get_recovery_email_pool 失败: {error}")
            return []

    @staticmethod
    def add_recovery_email_to_pool(
        email: str,
        imap_password: str,
        note: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO recovery_email_pool (email, imap_password, note)
                    VALUES (?, ?, ?)
                    ON CONFLICT(email) DO UPDATE SET
                        imap_password = excluded.imap_password,
                        note = excluded.note
                    """,
                    (email, imap_password, note),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 添加辅助邮箱到池: {email}")
                return True
        except Exception as error:
            print(f"[DB ERROR] add_recovery_email_to_pool 失败: {error}")
            return False

    @staticmethod
    def remove_recovery_email_from_pool(email: str, connection_factory: ConnectionFactory, db_lock: Lock) -> bool:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM recovery_email_pool WHERE email = ?", (email,))
                conn.commit()
                conn.close()
                print(f"[DB] 从池中移除辅助邮箱: {email}")
                return True
        except Exception as error:
            print(f"[DB ERROR] remove_recovery_email_from_pool 失败: {error}")
            return False

    @staticmethod
    def update_recovery_email_enabled(
        email: str,
        is_enabled: bool,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE recovery_email_pool SET is_enabled = ? WHERE email = ?",
                    (1 if is_enabled else 0, email),
                )
                conn.commit()
                conn.close()
                return True
        except Exception as error:
            print(f"[DB ERROR] update_recovery_email_enabled 失败: {error}")
            return False

    @staticmethod
    def get_recovery_email_daily_usage(
        date: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> dict:
        usage_date = date or datetime.now().strftime("%Y-%m-%d")
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT recovery_email, bind_count FROM recovery_email_daily_usage WHERE usage_date = ?",
                    (usage_date,),
                )
                rows = cursor.fetchall()
                conn.close()
                return {row["recovery_email"]: row["bind_count"] for row in rows}
        except Exception as error:
            print(f"[DB] get_recovery_email_daily_usage 失败: {error}")
            return {}

    @staticmethod
    def increment_recovery_email_usage(
        recovery_email: str,
        date: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        usage_date = date or datetime.now().strftime("%Y-%m-%d")
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO recovery_email_daily_usage (recovery_email, usage_date, bind_count)
                    VALUES (?, ?, 1)
                    ON CONFLICT(recovery_email, usage_date) DO UPDATE SET
                        bind_count = bind_count + 1
                    """,
                    (recovery_email, usage_date),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 增加辅助邮箱使用次数: {recovery_email} ({usage_date})")
                return True
        except Exception as error:
            print(f"[DB ERROR] increment_recovery_email_usage 失败: {error}")
            return False

    @staticmethod
    def reset_recovery_email_daily_usage(
        date: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> int:
        usage_date = date or datetime.now().strftime("%Y-%m-%d")
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM recovery_email_daily_usage WHERE usage_date = ?", (usage_date,))
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 重置 {usage_date} 的使用量，删除 {deleted} 条记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] reset_recovery_email_daily_usage 失败: {error}")
            return 0

    @staticmethod
    def set_recovery_email_usage_full(
        recovery_email: str,
        limit: int,
        date: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        usage_date = date or datetime.now().strftime("%Y-%m-%d")
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO recovery_email_daily_usage (recovery_email, usage_date, bind_count)
                    VALUES (?, ?, ?)
                    ON CONFLICT(recovery_email, usage_date) DO UPDATE SET
                        bind_count = ?
                    """,
                    (recovery_email, usage_date, limit, limit),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 标记辅助邮箱今日不可用: {recovery_email} ({usage_date}) = {limit}")
                return True
        except Exception as error:
            print(f"[DB ERROR] set_recovery_email_usage_full 失败: {error}")
            return False

    @staticmethod
    def get_account_recovery_binding(
        email: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> dict | None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM account_recovery_binding WHERE email = ?", (email,))
                row = cursor.fetchone()
                conn.close()
                return dict(row) if row else None
        except Exception as error:
            print(f"[DB] get_account_recovery_binding 失败: {error}")
            return None

    @staticmethod
    def set_account_recovery_binding(
        email: str,
        bound_recovery_email: str,
        status: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO account_recovery_binding (email, bound_recovery_email, bound_at, status)
                    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
                    ON CONFLICT(email) DO UPDATE SET
                        bound_recovery_email = excluded.bound_recovery_email,
                        bound_at = CURRENT_TIMESTAMP,
                        status = excluded.status
                    """,
                    (email, bound_recovery_email, status),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 设置绑定关系: {email} -> {bound_recovery_email} ({status})")
                return True
        except Exception as error:
            print(f"[DB ERROR] set_account_recovery_binding 失败: {error}")
            return False

    @staticmethod
    def get_all_account_recovery_bindings(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM account_recovery_binding")
                rows = cursor.fetchall()
                conn.close()
                return {row["email"]: dict(row) for row in rows}
        except Exception as error:
            print(f"[DB] get_all_account_recovery_bindings 失败: {error}")
            return {}

