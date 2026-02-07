"""
邀请锁管理器 - 防止同一账户被重复邀请

功能:
1. 线程安全的邮箱锁定/解锁
2. 自动超时清理（默认30分钟）
3. 单例模式确保全局唯一
"""

import threading
from datetime import datetime, timedelta
from typing import Dict, Optional


class InviteLockManager:
    """
    邀请锁管理器 - 单例模式

    用于防止同一账户在批量加入家庭组时被多次邀请。
    通过 try_lock() 获取锁，任务完成后通过 unlock() 释放。

    Usage:
        from services.invite_lock import invite_lock_manager

        if invite_lock_manager.try_lock(email):
            try:
                # 执行邀请操作
                ...
            finally:
                invite_lock_manager.unlock(email)
        else:
            print(f"{email} 正在被其他任务处理")
    """

    _instance: Optional["InviteLockManager"] = None
    _singleton_lock = threading.Lock()

    def __new__(cls) -> "InviteLockManager":
        if cls._instance is None:
            with cls._singleton_lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._init_instance()
        return cls._instance

    def _init_instance(self) -> None:
        """初始化实例变量"""
        # 存储锁定的邮箱及其锁定时间
        self._locked_emails: Dict[str, datetime] = {}
        # 操作锁，保护 _locked_emails 的并发访问
        self._email_lock = threading.Lock()
        # 锁超时时间（防止死锁）
        self._timeout = timedelta(minutes=30)

    def try_lock(self, email: str) -> bool:
        """
        尝试锁定邮箱

        Args:
            email: 要锁定的邮箱地址

        Returns:
            bool: 锁定成功返回 True，已被锁定返回 False
        """
        if not email:
            return True  # 空邮箱不需要锁定

        email_lower = email.lower().strip()

        with self._email_lock:
            # 先清理过期的锁
            self._cleanup_expired_unsafe()

            if email_lower in self._locked_emails:
                return False

            self._locked_emails[email_lower] = datetime.now()
            return True

    def unlock(self, email: str) -> None:
        """
        解锁邮箱

        Args:
            email: 要解锁的邮箱地址
        """
        if not email:
            return

        email_lower = email.lower().strip()

        with self._email_lock:
            self._locked_emails.pop(email_lower, None)

    def is_locked(self, email: str) -> bool:
        """
        检查邮箱是否被锁定

        Args:
            email: 要检查的邮箱地址

        Returns:
            bool: 已锁定返回 True
        """
        if not email:
            return False

        email_lower = email.lower().strip()

        with self._email_lock:
            self._cleanup_expired_unsafe()
            return email_lower in self._locked_emails

    def get_lock_info(self, email: str) -> Optional[datetime]:
        """
        获取邮箱的锁定时间

        Args:
            email: 邮箱地址

        Returns:
            Optional[datetime]: 锁定时间，未锁定返回 None
        """
        if not email:
            return None

        email_lower = email.lower().strip()

        with self._email_lock:
            self._cleanup_expired_unsafe()
            return self._locked_emails.get(email_lower)

    def _cleanup_expired_unsafe(self) -> None:
        """
        清理过期的锁（非线程安全版本，需在持有锁时调用）
        """
        now = datetime.now()
        expired = [
            email
            for email, lock_time in self._locked_emails.items()
            if now - lock_time > self._timeout
        ]
        for email in expired:
            del self._locked_emails[email]

    def cleanup_expired(self) -> int:
        """
        清理过期的锁（线程安全版本）

        Returns:
            int: 清理的锁数量
        """
        with self._email_lock:
            before_count = len(self._locked_emails)
            self._cleanup_expired_unsafe()
            after_count = len(self._locked_emails)
            return before_count - after_count

    def get_locked_count(self) -> int:
        """
        获取当前锁定的邮箱数量

        Returns:
            int: 锁定的邮箱数量
        """
        with self._email_lock:
            self._cleanup_expired_unsafe()
            return len(self._locked_emails)

    def get_locked_emails(self) -> list:
        """
        获取所有锁定的邮箱列表

        Returns:
            list: 锁定的邮箱列表
        """
        with self._email_lock:
            self._cleanup_expired_unsafe()
            return list(self._locked_emails.keys())

    def clear_all(self) -> int:
        """
        清除所有锁（用于紧急情况或程序退出时）

        Returns:
            int: 清除的锁数量
        """
        with self._email_lock:
            count = len(self._locked_emails)
            self._locked_emails.clear()
            return count

    def set_timeout(self, minutes: int) -> None:
        """
        设置锁超时时间

        Args:
            minutes: 超时分钟数
        """
        if minutes > 0:
            with self._email_lock:
                self._timeout = timedelta(minutes=minutes)


# 全局单例实例
invite_lock_manager = InviteLockManager()
