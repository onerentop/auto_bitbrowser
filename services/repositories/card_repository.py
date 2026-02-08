"""卡片仓储。

Why:
- 将卡片与绑卡统计相关 SQL 从 `services/database.py` 中下沉。
- 保持旧 `DBManager` 门面兼容，调用方无感迁移。
"""

from __future__ import annotations

from threading import Lock
from typing import Callable

import sqlite3


ConnectionFactory = Callable[[], sqlite3.Connection]


class CardRepository:
    """卡片数据仓储。"""

    @staticmethod
    def get_all_cards(connection_factory: ConnectionFactory, db_lock: Lock) -> list[dict]:
        """查询全部卡片。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM cards ORDER BY id")
                rows = cursor.fetchall()
                conn.close()
                return [dict(row) for row in rows]
        except Exception as error:
            print(f"[DB] get_all_cards 失败: {error}")
            return []

    @staticmethod
    def save_all_cards(cards: list, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """全量保存卡片（先清空后插入）。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()

                cursor.execute("DELETE FROM cards")

                for card in cards:
                    cursor.execute(
                        """
                        INSERT INTO cards (number, exp_month, exp_year, cvv, name, zip_code)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            card.get("number", ""),
                            card.get("exp_month", ""),
                            card.get("exp_year", ""),
                            card.get("cvv", ""),
                            card.get("name", "John Smith"),
                            card.get("zip_code", "10001"),
                        ),
                    )

                conn.commit()
                conn.close()
                print(f"[DB] 保存了 {len(cards)} 张卡片")
        except Exception as error:
            print(f"[DB ERROR] save_all_cards 失败: {error}")
            import traceback

            traceback.print_exc()

    @staticmethod
    def add_card(card: dict, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """新增单张卡片。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO cards (number, exp_month, exp_year, cvv, name, zip_code)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        card.get("number", ""),
                        card.get("exp_month", ""),
                        card.get("exp_year", ""),
                        card.get("cvv", ""),
                        card.get("name", "John Smith"),
                        card.get("zip_code", "10001"),
                    ),
                )
                conn.commit()
                conn.close()
        except Exception as error:
            print(f"[DB ERROR] add_card 失败: {error}")

    @staticmethod
    def delete_card(card_id: int, connection_factory: ConnectionFactory, db_lock: Lock) -> None:
        """删除单张卡片。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute("DELETE FROM cards WHERE id = ?", (card_id,))
                conn.commit()
                conn.close()
        except Exception as error:
            print(f"[DB ERROR] delete_card 失败: {error}")

    @staticmethod
    def get_card_usage_counts(connection_factory: ConnectionFactory, db_lock: Lock) -> dict:
        """统计每张卡（后缀）的使用次数。"""
        try:
            with db_lock:
                conn = connection_factory()
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT card_number, COUNT(*) as usage_count
                    FROM bind_card_history
                    GROUP BY card_number
                    """
                )
                rows = cursor.fetchall()
                conn.close()
                return {row["card_number"]: row["usage_count"] for row in rows}
        except Exception as error:
            print(f"[DB] get_card_usage_counts 失败: {error}")
            return {}

    @staticmethod
    def get_next_available_card(
        cards: list,
        cards_per_account: int,
        usage_count_getter: Callable[[], dict],
    ) -> tuple:
        """按使用次数限制返回下一张可用卡。"""
        try:
            usage_counts = usage_count_getter()

            for index, card in enumerate(cards):
                card_number = card.get("number", "")
                card_suffix = card_number[-4:] if len(card_number) >= 4 else card_number
                current_usage = usage_counts.get(card_suffix, 0)

                if current_usage < cards_per_account:
                    print(f"[DB] 选择卡片: ****{card_suffix} (已使用 {current_usage}/{cards_per_account})")
                    return card, index

            print(f"[DB] 所有卡片都已达到使用上限 ({cards_per_account})")
            return None, -1

        except Exception as error:
            print(f"[DB ERROR] get_next_available_card 失败: {error}")
            if cards:
                return cards[0], 0
            return None, -1

