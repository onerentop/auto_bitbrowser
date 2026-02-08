"""账号仓储。

Why:
- 将账号相关 SQL 从 `services/database.py` 中逐步下沉。
- 通过依赖注入连接工厂与锁，保持对旧 Facade 的兼容性。
"""

from __future__ import annotations

from threading import Lock
from typing import Callable

import sqlite3


ConnectionFactory = Callable[[], sqlite3.Connection]


class AccountRepository:
    """账号数据仓储（纯数据访问，不包含 GUI/业务编排）。"""

    @staticmethod
    def get_all_accounts(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询全部账号。"""
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM accounts")
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]

    @staticmethod
    def get_account_by_email(
        email: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> dict | None:
        """按邮箱查询账号。"""
        if not email:
            return None

        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM accounts WHERE email = ?", (email,))
            row = cursor.fetchone()
            conn.close()
            return dict(row) if row else None

    @staticmethod
    def delete_account(email: str, connection_factory: ConnectionFactory, db_lock: Lock) -> bool:
        """按邮箱删除账号。"""
        with db_lock:
            try:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM accounts WHERE email = ?", (email,))
                conn.commit()
                deleted = cursor.rowcount > 0
                conn.close()
                return deleted
            except Exception as error:
                print(f"[DB] 删除账号失败: {error}")
                return False

    @staticmethod
    def get_accounts_needing_unlock(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询需要解锁 403 的账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT * FROM accounts
                    WHERE unlock_status IN ('needs_unlock', 'unlock_failed')
                    AND validation_url IS NOT NULL
                    AND validation_url != ''
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_accounts_needing_unlock 失败: {error}")
            return []

    @staticmethod
    def get_available_pro_accounts(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询可用于邀请家庭成员的普通 Pro 账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT *, (6 - COALESCE(family_member_count, 0)) as available_slots
                    FROM accounts
                    WHERE is_pro = 'yes'
                    AND COALESCE(family_member_count, 0) < 6
                    AND login_status = 'logged_in'
                    AND browser_profile_id IS NOT NULL
                    AND browser_profile_id != ''
                    ORDER BY family_member_count ASC
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_available_pro_accounts 失败: {error}")
            return []

