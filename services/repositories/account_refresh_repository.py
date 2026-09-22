"""账号刷新任务仓库。

提供账号会员信息刷新任务的持久化操作。
"""

from __future__ import annotations

import threading
from datetime import datetime
from typing import Callable, List, Optional


class AccountRefreshRepository:
    """账号刷新任务数据访问层"""

    @staticmethod
    def create_refresh_task(
        task_mode: str,
        total_count: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ) -> int:
        """
        创建刷新任务，返回任务ID

        Args:
            task_mode: 任务模式 ('pro_only' | 'full')
            total_count: 总账号数
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁

        Returns:
            int: 新建任务的 ID
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO account_refresh_tasks
                (task_type, task_mode, status, total_count, started_at)
                VALUES (?, ?, 'running', ?, ?)
                """,
                ("family_info_refresh", task_mode, total_count, datetime.now()),
            )
            task_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return task_id

    @staticmethod
    def create_task_items(
        task_id: int,
        emails: List[str],
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """
        批量创建任务明细

        Args:
            task_id: 任务 ID
            emails: 邮箱列表
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            for email in emails:
                cursor.execute(
                    """
                    INSERT INTO account_refresh_task_items (task_id, email, status)
                    VALUES (?, ?, 'pending')
                    """,
                    (task_id, email),
                )
            conn.commit()
            conn.close()

    @staticmethod
    def update_task_item_started(
        task_id: int,
        email: str,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """
        标记任务明细开始执行

        Args:
            task_id: 任务 ID
            email: 账号邮箱
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE account_refresh_task_items SET
                    status = 'running',
                    started_at = ?
                WHERE task_id = ? AND email = ?
                """,
                (datetime.now(), task_id, email),
            )
            conn.commit()
            conn.close()

    @staticmethod
    def update_task_item(
        task_id: int,
        email: str,
        status: str,
        result: dict,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """
        更新单条任务明细

        Args:
            task_id: 任务 ID
            email: 账号邮箱
            status: 状态 ('success' | 'failed' | 'skipped')
            result: 刷新结果字典
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE account_refresh_task_items SET
                    status = ?,
                    error_message = ?,
                    is_pro = ?,
                    pro_plan_name = ?,
                    family_role = ?,
                    family_manager_email = ?,
                    has_family_group = ?,
                    family_member_count = ?,
                    family_slots_left = ?,
                    account_country = ?,
                    finished_at = ?
                WHERE task_id = ? AND email = ?
                """,
                (
                    status,
                    result.get("error_message"),
                    result.get("is_pro"),
                    result.get("pro_plan_name"),
                    result.get("family_role"),
                    result.get("family_manager_email"),
                    result.get("has_family_group"),
                    result.get("family_member_count"),
                    result.get("family_slots_left"),
                    result.get("account_country"),
                    datetime.now(),
                    task_id,
                    email,
                ),
            )
            conn.commit()
            conn.close()

    @staticmethod
    def update_task_progress(
        task_id: int,
        progress_current: int,
        success_count: int,
        failed_count: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """
        更新任务进度

        Args:
            task_id: 任务 ID
            progress_current: 当前进度
            success_count: 成功数
            failed_count: 失败数
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()

            # 先获取 total_count 计算百分比
            cursor.execute(
                "SELECT total_count FROM account_refresh_tasks WHERE id = ?",
                (task_id,),
            )
            row = cursor.fetchone()
            total_count = row[0] if row else 1
            progress_percent = (progress_current / total_count * 100) if total_count > 0 else 0

            cursor.execute(
                """
                UPDATE account_refresh_tasks SET
                    progress_current = ?,
                    progress_percent = ?,
                    success_count = ?,
                    failed_count = ?
                WHERE id = ?
                """,
                (progress_current, progress_percent, success_count, failed_count, task_id),
            )
            conn.commit()
            conn.close()

    @staticmethod
    def finish_task(
        task_id: int,
        status: str,
        success_count: int,
        failed_count: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ):
        """
        完成任务

        Args:
            task_id: 任务 ID
            status: 最终状态 ('completed' | 'failed' | 'stopped')
            success_count: 成功数
            failed_count: 失败数
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                UPDATE account_refresh_tasks SET
                    status = ?,
                    success_count = ?,
                    failed_count = ?,
                    progress_current = total_count,
                    progress_percent = 100.0,
                    finished_at = ?
                WHERE id = ?
                """,
                (status, success_count, failed_count, datetime.now(), task_id),
            )
            conn.commit()
            conn.close()

    @staticmethod
    def get_task_by_id(
        task_id: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ) -> Optional[dict]:
        """
        获取任务详情

        Args:
            task_id: 任务 ID
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁

        Returns:
            dict | None: 任务信息字典
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM account_refresh_tasks WHERE id = ?",
                (task_id,),
            )
            row = cursor.fetchone()
            conn.close()
            if row:
                return dict(row)
            return None

    @staticmethod
    def get_task_items(
        task_id: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ) -> List[dict]:
        """
        获取任务明细列表

        Args:
            task_id: 任务 ID
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁

        Returns:
            List[dict]: 任务明细列表
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM account_refresh_task_items WHERE task_id = ? ORDER BY id",
                (task_id,),
            )
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]

    @staticmethod
    def get_recent_tasks(
        limit: int,
        connection_factory: Callable,
        db_lock: threading.Lock,
    ) -> List[dict]:
        """
        获取最近的任务列表

        Args:
            limit: 返回数量限制
            connection_factory: 数据库连接工厂
            db_lock: 数据库锁

        Returns:
            List[dict]: 任务列表
        """
        with db_lock:
            conn = connection_factory()
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM account_refresh_tasks
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cursor.fetchall()
            conn.close()
            return [dict(row) for row in rows]
