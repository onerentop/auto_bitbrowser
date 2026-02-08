"""代理仓储。

Why:
- 将代理与绑定关系相关 SQL 从 `services/database.py` 下沉。
- 保持旧 `DBManager` 的兼容门面，逐步降低超大文件复杂度。
"""

from __future__ import annotations

from threading import Lock
from typing import Callable

import sqlite3


ConnectionFactory = Callable[[], sqlite3.Connection]


class ProxyRepository:
    """代理与代理绑定仓储。"""

    @staticmethod
    def get_all_proxies(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询所有代理。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM proxies ORDER BY id")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB] get_all_proxies 失败: {error}")
            return []

    @staticmethod
    def save_all_proxies(proxies: list, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """增量保存代理列表，并同步清理冗余代理与绑定。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                cursor.execute("SELECT id, host, port FROM proxies")
                existing = {f"{row['host']}:{row['port']}": row["id"] for row in cursor.fetchall()}

                new_keys = set()
                for proxy in proxies:
                    key = f"{proxy.get('host', '')}:{proxy.get('port', '')}"
                    new_keys.add(key)

                    if key in existing:
                        cursor.execute(
                            """
                            UPDATE proxies SET proxy_type=?, username=?, password=?
                            WHERE id=?
                            """,
                            (
                                proxy.get("proxy_type", "socks5"),
                                proxy.get("username", ""),
                                proxy.get("password", ""),
                                existing[key],
                            ),
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO proxies (proxy_type, username, password, host, port)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (
                                proxy.get("proxy_type", "socks5"),
                                proxy.get("username", ""),
                                proxy.get("password", ""),
                                proxy.get("host", ""),
                                proxy.get("port", ""),
                            ),
                        )

                keys_to_delete = set(existing.keys()) - new_keys
                for key in keys_to_delete:
                    proxy_id = existing[key]
                    cursor.execute("DELETE FROM proxy_window_bindings WHERE proxy_id = ?", (proxy_id,))
                    cursor.execute("DELETE FROM proxies WHERE id = ?", (proxy_id,))

                conn.commit()
                conn.close()
                print(f"[DB] 保存了 {len(proxies)} 个代理")
        except Exception as error:
            print(f"[DB ERROR] save_all_proxies 失败: {error}")
            import traceback

            traceback.print_exc()

    @staticmethod
    def add_proxy(proxy: dict, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """新增单个代理。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO proxies (proxy_type, username, password, host, port)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        proxy.get("proxy_type", "socks5"),
                        proxy.get("username", ""),
                        proxy.get("password", ""),
                        proxy.get("host", ""),
                        proxy.get("port", ""),
                    ),
                )
                conn.commit()
                conn.close()
        except Exception as error:
            print(f"[DB ERROR] add_proxy 失败: {error}")

    @staticmethod
    def delete_proxy(proxy_id: int, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """删除单个代理与绑定。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM proxy_window_bindings WHERE proxy_id = ?", (proxy_id,))
                cursor.execute("DELETE FROM proxies WHERE id = ?", (proxy_id,))
                conn.commit()
                conn.close()
        except Exception as error:
            print(f"[DB ERROR] delete_proxy 失败: {error}")

    @staticmethod
    def get_proxy_binding_count(proxy_id: int, connection_factory: ConnectionFactory, db_lock: Lock) -> int:
        """统计代理已绑定窗口数量。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT COUNT(*) FROM proxy_window_bindings WHERE proxy_id = ?", (proxy_id,))
                count = cursor.fetchone()[0]
                conn.close()
                return count
        except Exception as error:
            print(f"[DB ERROR] get_proxy_binding_count 失败: {error}")
            return 0

    @staticmethod
    def get_proxy_bindings(proxy_id: int, connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询代理绑定详情。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT * FROM proxy_window_bindings WHERE proxy_id = ? ORDER BY bound_at DESC",
                    (proxy_id,),
                )
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB ERROR] get_proxy_bindings 失败: {error}")
            return []

    @staticmethod
    def get_all_proxy_usage_stats(
        max_per_ip: int,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> list[dict]:
        """查询所有代理使用统计。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT p.id, p.proxy_type, p.host, p.port, p.username, p.password,
                           COUNT(b.id) as used_count
                    FROM proxies p
                    LEFT JOIN proxy_window_bindings b ON p.id = b.proxy_id
                    GROUP BY p.id
                    ORDER BY p.id
                    """
                )
                rows = cursor.fetchall()
                conn.close()

                result = []
                for row in rows:
                    used = row["used_count"]
                    result.append(
                        {
                            "proxy_id": row["id"],
                            "proxy_type": row["proxy_type"],
                            "host": row["host"],
                            "port": row["port"],
                            "username": row["username"],
                            "password": row["password"],
                            "used_count": used,
                            "max_count": max_per_ip,
                            "is_full": used >= max_per_ip,
                        }
                    )
                return result
        except Exception as error:
            print(f"[DB ERROR] get_all_proxy_usage_stats 失败: {error}")
            return []

    @staticmethod
    def bind_proxy_to_window(
        proxy_id: int,
        browser_id: str,
        email: str | None,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """绑定代理到窗口（窗口唯一）。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO proxy_window_bindings (proxy_id, browser_id, email)
                    VALUES (?, ?, ?)
                    ON CONFLICT(browser_id) DO UPDATE SET
                        proxy_id = excluded.proxy_id,
                        email = excluded.email,
                        bound_at = CURRENT_TIMESTAMP
                    """,
                    (proxy_id, browser_id, email),
                )
                conn.commit()
                conn.close()
                print(f"[DB] 绑定代理 {proxy_id} -> 窗口 {browser_id}")
                return True
        except Exception as error:
            print(f"[DB ERROR] bind_proxy_to_window 失败: {error}")
            return False

    @staticmethod
    def unbind_proxy_from_window(
        browser_id: str,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> bool:
        """解绑窗口上的代理。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM proxy_window_bindings WHERE browser_id = ?", (browser_id,))
                affected = cursor.rowcount
                conn.commit()
                conn.close()
                if affected > 0:
                    print(f"[DB] 解绑窗口 {browser_id} 的代理")
                return affected > 0
        except Exception as error:
            print(f"[DB ERROR] unbind_proxy_from_window 失败: {error}")
            return False

    @staticmethod
    def get_next_available_proxy(
        max_per_ip: int,
        connection_factory: ConnectionFactory,
        db_lock: Lock,
    ) -> dict | None:
        """按顺序获取第一个未满额代理。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT p.*, COUNT(b.id) as used_count
                    FROM proxies p
                    LEFT JOIN proxy_window_bindings b ON p.id = b.proxy_id
                    GROUP BY p.id
                    HAVING used_count < ?
                    ORDER BY p.id
                    LIMIT 1
                    """,
                    (max_per_ip,),
                )
                row = cursor.fetchone()
                conn.close()
                return dict(row) if row else None
        except Exception as error:
            print(f"[DB ERROR] get_next_available_proxy 失败: {error}")
            return None

