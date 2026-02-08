"""历史记录仓储。

Why:
- 将历史记录相关建表与 CRUD 从 `services/database.py` 下沉。
- 通过 `DBManager` 兼容门面维持现有调用不变。
"""

from __future__ import annotations

from threading import Lock
from typing import Callable

import sqlite3


ConnectionFactory = Callable[[], sqlite3.Connection]


class HistoryRepository:
    """手机号/邮箱/2SV/验证器/SheerID/绑卡历史仓储。"""

    @staticmethod
    def init_phone_modification_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS phone_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_phone TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_phone_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_phone, modified_at FROM phone_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {"new_phone": row["new_phone"], "modified_at": row["modified_at"]}
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_phone_modification_history 失败: {error}")
            return {}

    @staticmethod
    def add_phone_modification(email: str, new_phone: str, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO phone_modification_history (email, new_phone, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_phone = excluded.new_phone,
                        modified_at = CURRENT_TIMESTAMP
                    """,
                    (email, new_phone),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录手机号修改: {email} -> {new_phone}")
        except Exception as error:
            print(f"[DB ERROR] add_phone_modification 失败: {error}")

    @staticmethod
    def clear_phone_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM phone_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条手机号修改记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_phone_modification_history 失败: {error}")
            return 0

    @staticmethod
    def init_email_modification_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS email_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_recovery_email TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_email_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_recovery_email, modified_at FROM email_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {
                        "new_recovery_email": row["new_recovery_email"],
                        "modified_at": row["modified_at"],
                    }
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_email_modification_history 失败: {error}")
            return {}

    @staticmethod
    def add_email_modification(
        email: str,
        new_recovery_email: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO email_modification_history (email, new_recovery_email, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_recovery_email = excluded.new_recovery_email,
                        modified_at = CURRENT_TIMESTAMP
                    """,
                    (email, new_recovery_email),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录邮箱修改: {email} -> {new_recovery_email}")
        except Exception as error:
            print(f"[DB ERROR] add_email_modification 失败: {error}")

    @staticmethod
    def clear_email_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM email_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条邮箱修改记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_email_modification_history 失败: {error}")
            return 0

    @staticmethod
    def init_2sv_phone_modification_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS sv2_phone_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_phone TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_2sv_phone_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_phone, modified_at FROM sv2_phone_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {"new_phone": row["new_phone"], "modified_at": row["modified_at"]}
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_2sv_phone_modification_history 失败: {error}")
            return {}

    @staticmethod
    def add_2sv_phone_modification(email: str, new_phone: str, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO sv2_phone_modification_history (email, new_phone, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_phone = excluded.new_phone,
                        modified_at = CURRENT_TIMESTAMP
                    """,
                    (email, new_phone),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录2SV手机号修改: {email} -> {new_phone}")
        except Exception as error:
            print(f"[DB ERROR] add_2sv_phone_modification 失败: {error}")

    @staticmethod
    def clear_2sv_phone_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM sv2_phone_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条2SV手机号修改记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_2sv_phone_modification_history 失败: {error}")
            return 0

    @staticmethod
    def init_authenticator_modification_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS authenticator_modification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    new_secret TEXT NOT NULL,
                    modified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_authenticator_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT email, new_secret, modified_at FROM authenticator_modification_history")
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {"new_secret": row["new_secret"], "modified_at": row["modified_at"]}
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_authenticator_modification_history 失败: {error}")
            return {}

    @staticmethod
    def add_authenticator_modification(
        email: str,
        new_secret: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO authenticator_modification_history (email, new_secret, modified_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        new_secret = excluded.new_secret,
                        modified_at = CURRENT_TIMESTAMP
                    """,
                    (email, new_secret),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录身份验证器修改: {email} -> {new_secret[:16]}...")
        except Exception as error:
            print(f"[DB ERROR] add_authenticator_modification 失败: {error}")

    @staticmethod
    def clear_authenticator_modification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM authenticator_modification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条身份验证器修改记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_authenticator_modification_history 失败: {error}")
            return 0

    @staticmethod
    def init_sheerid_verification_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS sheerid_verification_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    verification_id TEXT,
                    verification_result TEXT,
                    message TEXT,
                    verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_sheerid_verification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT email, verification_id, verification_result, message, verified_at "
                    "FROM sheerid_verification_history"
                )
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {
                        "verification_id": row["verification_id"],
                        "verification_result": row["verification_result"],
                        "message": row["message"],
                        "verified_at": row["verified_at"],
                    }
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_sheerid_verification_history 失败: {error}")
            return {}

    @staticmethod
    def add_sheerid_verification(
        email: str,
        verification_id: str,
        verification_result: str,
        message: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO sheerid_verification_history (
                        email, verification_id, verification_result, message, verified_at
                    )
                    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        verification_id = excluded.verification_id,
                        verification_result = excluded.verification_result,
                        message = excluded.message,
                        verified_at = CURRENT_TIMESTAMP
                    """,
                    (email, verification_id, verification_result, message),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录SheerID验证: {email} -> {verification_result}")
        except Exception as error:
            print(f"[DB ERROR] add_sheerid_verification 失败: {error}")

    @staticmethod
    def clear_sheerid_verification_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM sheerid_verification_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条SheerID验证记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_sheerid_verification_history 失败: {error}")
            return 0

    @staticmethod
    def init_bind_card_history_table(connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                CREATE TABLE IF NOT EXISTS bind_card_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    email TEXT NOT NULL,
                    card_number TEXT NOT NULL,
                    bound_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(email)
                )
                """
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_bind_card_history(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT email, card_number, bound_at FROM bind_card_history")
                rows = cursor.fetchall()
                conn.close()
                return {
                    row["email"]: {"card_number": row["card_number"], "bound_at": row["bound_at"]}
                    for row in rows
                }
        except Exception as error:
            print(f"[DB] get_bind_card_history 失败: {error}")
            return {}

    @staticmethod
    def add_bind_card_history(email: str, card_number: str, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO bind_card_history (email, card_number, bound_at)
                    VALUES (?, ?, CURRENT_TIMESTAMP)
                    ON CONFLICT(email) DO UPDATE SET
                        card_number = excluded.card_number,
                        bound_at = CURRENT_TIMESTAMP
                    """,
                    (email, card_number),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 记录绑卡: {email} -> {card_number}")
        except Exception as error:
            print(f"[DB ERROR] add_bind_card_history 失败: {error}")

    @staticmethod
    def clear_bind_card_history(connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM bind_card_history")
                conn.commit()
                deleted = cursor.rowcount
                conn.close()
                print(f"[DB] 已清除 {deleted} 条绑卡记录")
                return deleted
        except Exception as error:
            print(f"[DB ERROR] clear_bind_card_history 失败: {error}")
            return 0

