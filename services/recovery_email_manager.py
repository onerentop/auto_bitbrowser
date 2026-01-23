"""
辅助邮箱池管理器

提供辅助邮箱的智能分配、每日限制管理、绑定状态追踪等功能
"""
from datetime import datetime
from typing import Optional, Tuple, List
from .database import DBManager


# 每日绑定限制（每个邮箱每天最多被绑定的次数）
DAILY_BIND_LIMIT = 10


class RecoveryEmailManager:
    """辅助邮箱池管理器"""

    @staticmethod
    def get_pool_emails() -> List[str]:
        """获取邮箱池中所有邮箱地址"""
        pool = DBManager.get_recovery_email_pool()
        return [item['email'] for item in pool if item.get('is_enabled', 1)]

    @staticmethod
    def get_pool_with_usage() -> List[dict]:
        """
        获取邮箱池及今日使用情况
        返回列表，每项包含：email, imap_password, is_enabled, today_usage, remaining
        """
        pool = DBManager.get_recovery_email_pool()
        today_usage = DBManager.get_recovery_email_daily_usage()

        result = []
        for item in pool:
            email = item['email']
            usage = today_usage.get(email, 0)
            result.append({
                'email': email,
                'imap_password': item.get('imap_password', ''),
                'is_enabled': item.get('is_enabled', 1),
                'note': item.get('note', ''),
                'today_usage': usage,
                'remaining': max(0, DAILY_BIND_LIMIT - usage),
                'is_full': usage >= DAILY_BIND_LIMIT,
            })
        return result

    @staticmethod
    def get_total_remaining() -> Tuple[int, int]:
        """
        获取今日总剩余额度
        返回 (剩余数, 总数)
        """
        pool_with_usage = RecoveryEmailManager.get_pool_with_usage()
        total = sum(DAILY_BIND_LIMIT for item in pool_with_usage if item['is_enabled'])
        used = sum(item['today_usage'] for item in pool_with_usage if item['is_enabled'])
        return max(0, total - used), total

    @staticmethod
    def select_available_email() -> Optional[dict]:
        """
        选择一个可用的辅助邮箱（使用次数最少且未超限）

        返回:
            dict: {'email': str, 'imap_password': str} 或 None（无可用邮箱）
        """
        pool_with_usage = RecoveryEmailManager.get_pool_with_usage()

        # 过滤出启用且未超限的邮箱
        available = [
            item for item in pool_with_usage
            if item['is_enabled'] and not item['is_full']
        ]

        if not available:
            return None

        # 按使用次数升序排序，选择使用最少的
        available.sort(key=lambda x: x['today_usage'])
        selected = available[0]

        return {
            'email': selected['email'],
            'imap_password': selected['imap_password'],
        }

    @staticmethod
    def is_email_in_pool(email: str) -> bool:
        """检查邮箱是否在邮箱池中"""
        pool_emails = RecoveryEmailManager.get_pool_emails()
        return email in pool_emails

    @staticmethod
    def check_account_binding(account_email: str, current_recovery_email: str) -> Tuple[str, Optional[str]]:
        """
        检查账号的辅助邮箱绑定状态

        Args:
            account_email: 主账号邮箱
            current_recovery_email: 当前绑定的辅助邮箱（从 Google 页面检测到的）

        Returns:
            (status, recovery_email)
            - ('already_bound', email): 已绑定池中邮箱，无需操作
            - ('need_bind', email): 需要绑定，返回建议使用的邮箱
            - ('no_available', None): 今日额度已用完
        """
        # 检查当前绑定的邮箱是否在池中
        if current_recovery_email and RecoveryEmailManager.is_email_in_pool(current_recovery_email):
            # 记录绑定关系（已经绑定了池中的邮箱）
            DBManager.set_account_recovery_binding(
                account_email,
                current_recovery_email,
                status='bound'
            )
            return ('already_bound', current_recovery_email)

        # 需要绑定新邮箱，选择一个可用的
        available = RecoveryEmailManager.select_available_email()
        if not available:
            return ('no_available', None)

        return ('need_bind', available['email'])

    @staticmethod
    def record_bind_success(account_email: str, recovery_email: str):
        """
        记录绑定成功

        Args:
            account_email: 主账号邮箱
            recovery_email: 绑定的辅助邮箱
        """
        # 增加使用次数
        DBManager.increment_recovery_email_usage(recovery_email)
        # 记录绑定关系
        DBManager.set_account_recovery_binding(account_email, recovery_email, status='bound')
        # 同时更新邮箱修改历史（兼容旧版）
        DBManager.add_email_modification(account_email, recovery_email)

    @staticmethod
    def record_bind_failure(account_email: str, recovery_email: str):
        """
        记录绑定失败

        Args:
            account_email: 主账号邮箱
            recovery_email: 尝试绑定的辅助邮箱
        """
        DBManager.set_account_recovery_binding(account_email, recovery_email, status='failed')

    @staticmethod
    def add_email_to_pool(email: str, imap_password: str = "", note: str = "") -> bool:
        """添加邮箱到池"""
        return DBManager.add_recovery_email_to_pool(email, imap_password, note)

    @staticmethod
    def remove_email_from_pool(email: str) -> bool:
        """从池中移除邮箱"""
        return DBManager.remove_recovery_email_from_pool(email)

    @staticmethod
    def set_email_enabled(email: str, enabled: bool) -> bool:
        """设置邮箱启用状态"""
        return DBManager.update_recovery_email_enabled(email, enabled)

    @staticmethod
    def reset_today_usage() -> int:
        """重置今日使用量"""
        return DBManager.reset_recovery_email_daily_usage()

    @staticmethod
    def mark_email_full_today(email: str) -> bool:
        """
        将指定邮箱标记为今日已满（不可再用于绑定）

        当 Google 提示该邮箱不能绑定时调用此方法，
        将该邮箱的当日使用量直接设为 DAILY_BIND_LIMIT

        Args:
            email: 要标记的辅助邮箱地址

        Returns:
            bool: 操作是否成功
        """
        return DBManager.set_recovery_email_usage_full(email, DAILY_BIND_LIMIT)

    @staticmethod
    def select_next_available_email(exclude_emails: List[str] = None) -> Optional[dict]:
        """
        选择下一个可用的辅助邮箱，排除指定的邮箱列表

        用于轮换场景：当某个邮箱绑定失败后，选择池中其他可用邮箱

        Args:
            exclude_emails: 要排除的邮箱列表（已尝试失败的）

        Returns:
            dict: {'email': str, 'imap_password': str} 或 None
        """
        exclude_set = set(exclude_emails or [])
        pool_with_usage = RecoveryEmailManager.get_pool_with_usage()

        # 过滤出启用、未超限、且不在排除列表中的邮箱
        available = [
            item for item in pool_with_usage
            if item['is_enabled']
            and not item['is_full']
            and item['email'] not in exclude_set
        ]

        if not available:
            return None

        # 按使用次数升序排序，选择使用最少的
        available.sort(key=lambda x: x['today_usage'])
        selected = available[0]

        return {
            'email': selected['email'],
            'imap_password': selected['imap_password'],
        }

    @staticmethod
    def get_imap_config(recovery_email: str) -> Optional[dict]:
        """
        获取辅助邮箱的 IMAP 配置

        Returns:
            {'email': str, 'password': str} 或 None
        """
        pool = DBManager.get_recovery_email_pool()
        for item in pool:
            if item['email'] == recovery_email:
                if item.get('imap_password'):
                    return {
                        'email': recovery_email,
                        'password': item['imap_password']
                    }
        return None


# 便捷函数
def select_recovery_email() -> Optional[dict]:
    """选择可用的辅助邮箱（快捷方式）"""
    return RecoveryEmailManager.select_available_email()


def check_and_get_recovery_email(account_email: str, current_recovery: str) -> Tuple[str, Optional[str]]:
    """检查并获取辅助邮箱（快捷方式）"""
    return RecoveryEmailManager.check_account_binding(account_email, current_recovery)


if __name__ == '__main__':
    # 测试代码
    print("=" * 50)
    print("辅助邮箱池管理器测试")
    print("=" * 50)

    # 初始化
    DBManager.init_recovery_email_pool_tables()

    # 添加测试邮箱
    print("\n1. 添加测试邮箱...")
    RecoveryEmailManager.add_email_to_pool("backup1@gmail.com", "password1", "测试邮箱1")
    RecoveryEmailManager.add_email_to_pool("backup2@gmail.com", "password2", "测试邮箱2")

    # 查看池状态
    print("\n2. 查看邮箱池状态...")
    pool = RecoveryEmailManager.get_pool_with_usage()
    for item in pool:
        print(f"  {item['email']}: {item['today_usage']}/{DAILY_BIND_LIMIT}, 剩余: {item['remaining']}")

    # 获取剩余额度
    remaining, total = RecoveryEmailManager.get_total_remaining()
    print(f"\n3. 今日剩余额度: {remaining}/{total}")

    # 选择可用邮箱
    print("\n4. 选择可用邮箱...")
    selected = RecoveryEmailManager.select_available_email()
    if selected:
        print(f"  选中: {selected['email']}")
    else:
        print("  无可用邮箱")

    # 模拟绑定
    print("\n5. 模拟绑定成功...")
    if selected:
        RecoveryEmailManager.record_bind_success("test@gmail.com", selected['email'])

    # 再次查看状态
    print("\n6. 再次查看邮箱池状态...")
    pool = RecoveryEmailManager.get_pool_with_usage()
    for item in pool:
        print(f"  {item['email']}: {item['today_usage']}/{DAILY_BIND_LIMIT}, 剩余: {item['remaining']}")

    print("\n测试完成!")
