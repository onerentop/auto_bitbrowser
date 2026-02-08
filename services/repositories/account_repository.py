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

    @staticmethod
    def bind_account_to_browser(
        email: str,
        browser_profile_id: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """绑定账号到浏览器窗口。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE accounts SET browser_profile_id = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                    (browser_profile_id, email),
                )
                conn.commit()
                affected = cursor.rowcount
                conn.close()
                if affected > 0:
                    print(f"[DB] 绑定账号到窗口: {email} -> {browser_profile_id}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] bind_account_to_browser 失败: {error}")
            return False

    @staticmethod
    def get_account_by_browser(
        browser_profile_id: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> dict | None:
        """按窗口 ID 查询账号。"""
        if not browser_profile_id:
            return None
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT * FROM accounts WHERE browser_profile_id = ?",
                    (browser_profile_id,),
                )
                row = cursor.fetchone()
                conn.close()
                return dict(row) if row else None
        except Exception as error:
            print(f"[DB ERROR] get_account_by_browser 失败: {error}")
            return None

    @staticmethod
    def get_unbound_accounts(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询未绑定窗口的账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts WHERE browser_profile_id IS NULL OR browser_profile_id = ''")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_unbound_accounts 失败: {error}")
            return []

    @staticmethod
    def update_sub2api_status(
        email: str,
        status: str,
        account_id: int | None,
        session_id: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新 Sub2API 关联状态。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                fields = ["sub2api_status = ?", "updated_at = CURRENT_TIMESTAMP"]
                values: list = [status]

                if account_id is not None:
                    fields.append("sub2api_account_id = ?")
                    values.append(account_id)

                if session_id is not None:
                    fields.append("sub2api_session_id = ?")
                    values.append(session_id)

                values.append(email)
                sql = f"UPDATE accounts SET {', '.join(fields)} WHERE email = ?"
                cursor.execute(sql, values)

                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    suffix = f" (account_id={account_id})" if account_id else ""
                    print(f"[DB] 更新 Sub2API 状态: {email} -> {status}{suffix}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_sub2api_status 失败: {error}")
            return False

    @staticmethod
    def get_accounts_by_sub2api_status(
        status: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> list[dict]:
        """按 Sub2API 状态查询账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts WHERE sub2api_status = ?", (status,))
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_accounts_by_sub2api_status 失败: {error}")
            return []

    @staticmethod
    def update_login_status(
        email: str,
        status: str,
        last_error: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新账号登录状态。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                if status == "logged_in":
                    cursor.execute(
                        "UPDATE accounts SET login_status = ?, last_login_at = CURRENT_TIMESTAMP, "
                        "last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                        (status, email),
                    )
                elif last_error is not None:
                    cursor.execute(
                        "UPDATE accounts SET login_status = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                        (status, last_error, email),
                    )
                else:
                    cursor.execute(
                        "UPDATE accounts SET login_status = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                        (status, email),
                    )

                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    print(f"[DB] 更新登录状态: {email} -> {status}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_login_status 失败: {error}")
            return False

    @staticmethod
    def update_pro_status(
        email: str,
        is_pro: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新 Pro 状态。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE accounts SET is_pro = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                    (is_pro, email),
                )
                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    print(f"[DB] 更新 Pro 状态: {email} -> {is_pro}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_pro_status 失败: {error}")
            return False

    @staticmethod
    def get_accounts_by_login_status(
        status: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> list[dict]:
        """按登录状态查询账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts WHERE login_status = ?", (status,))
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_accounts_by_login_status 失败: {error}")
            return []

    @staticmethod
    def get_accounts_for_sub2api(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询可用于 Sub2API 关联的账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT * FROM accounts
                    WHERE login_status = 'logged_in'
                    AND (sub2api_status IS NULL OR sub2api_status = 'not_linked' OR sub2api_status = 'oauth_failed')
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_accounts_for_sub2api 失败: {error}")
            return []

    @staticmethod
    def update_unlock_status(
        email: str,
        status: str,
        validation_url: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新 403 解锁状态。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                fields = ["unlock_status = ?", "updated_at = CURRENT_TIMESTAMP"]
                values: list = [status]

                if validation_url is not None:
                    fields.append("validation_url = ?")
                    values.append(validation_url)

                values.append(email)
                sql = f"UPDATE accounts SET {', '.join(fields)} WHERE email = ?"
                cursor.execute(sql, values)

                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    print(f"[DB] 更新解锁状态: {email} -> {status}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_unlock_status 失败: {error}")
            return False

    @staticmethod
    def get_accounts_by_unlock_status(
        status: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> list[dict]:
        """按解锁状态查询账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM accounts WHERE unlock_status = ?", (status,))
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_accounts_by_unlock_status 失败: {error}")
            return []

    @staticmethod
    def update_family_member_count(
        email: str,
        count: int,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新家庭成员数量。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE accounts SET family_member_count = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                    (count, email),
                )

                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    print(f"[DB] 更新家庭成员数量: {email} -> {count}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_family_member_count 失败: {error}")
            return False

    @staticmethod
    def update_family_sharing_enabled(
        email: str,
        status: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """更新家庭共享开启状态。"""
        if status not in ("unknown", "yes", "no"):
            print(f"[DB ERROR] 无效的 family_sharing_enabled 状态: {status}")
            return False

        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "UPDATE accounts SET family_sharing_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?",
                    (status, email),
                )
                conn.commit()
                affected = cursor.rowcount
                conn.close()

                if affected > 0:
                    print(f"[DB] 更新家庭共享状态: {email} -> {status}")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] update_family_sharing_enabled 失败: {error}")
            return False

    @staticmethod
    def get_pro_accounts_for_sharing(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询可开启共享的普通 Pro 账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT * FROM accounts
                    WHERE is_pro = 'yes'
                    AND login_status = 'logged_in'
                    AND browser_profile_id IS NOT NULL
                    AND browser_profile_id != ''
                    AND COALESCE(family_sharing_enabled, 'unknown') != 'yes'
                    ORDER BY updated_at DESC
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_pro_accounts_for_sharing 失败: {error}")
            return []

    @staticmethod
    def get_family_pro_accounts(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询家庭组 Pro 账号。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT * FROM accounts
                    WHERE is_pro = 'family_yes'
                    AND login_status = 'logged_in'
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_family_pro_accounts 失败: {error}")
            return []
