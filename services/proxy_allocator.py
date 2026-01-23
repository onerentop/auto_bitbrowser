"""
代理分配器模块
提供代理池的自动分配、绑定、统计等功能
"""
from typing import Optional
from .database import DBManager
from core.config_manager import ConfigManager


class ProxyAllocator:
    """
    代理分配器
    采用顺序分配策略：一个IP分满N个窗口后，再使用下一个
    """

    @staticmethod
    def get_max_windows_per_ip() -> int:
        """获取每个IP最大窗口数配置"""
        return ConfigManager.get("proxy.max_windows_per_ip", 3)

    @staticmethod
    def set_max_windows_per_ip(value: int):
        """设置每个IP最大窗口数"""
        ConfigManager.set("proxy.max_windows_per_ip", max(1, value))

    @staticmethod
    def get_next_available_proxy() -> Optional[dict]:
        """
        获取下一个可用代理（顺序分配策略）
        返回第一个未达上限的代理，如果都满了或代理池为空返回 None
        """
        max_per_ip = ProxyAllocator.get_max_windows_per_ip()
        return DBManager.get_next_available_proxy(max_per_ip)

    @staticmethod
    def allocate_proxy(browser_id: str, email: str = None) -> Optional[dict]:
        """
        为窗口分配代理并记录绑定

        Args:
            browser_id: ixBrowser 窗口 ID
            email: 账号邮箱（可选，用于查询）

        Returns:
            分配的代理信息，如果无可用代理返回 None
        """
        proxy = ProxyAllocator.get_next_available_proxy()
        if proxy is None:
            return None

        # 记录绑定关系
        success = DBManager.bind_proxy_to_window(proxy['id'], browser_id, email)
        if success:
            return proxy
        return None

    @staticmethod
    def unbind_window(browser_id: str) -> bool:
        """
        解绑窗口的代理（释放配额）

        Args:
            browser_id: ixBrowser 窗口 ID

        Returns:
            是否成功解绑
        """
        return DBManager.unbind_proxy_from_window(browser_id)

    @staticmethod
    def get_all_usage_stats() -> list:
        """
        获取所有代理的使用统计

        Returns:
            [{proxy_id, proxy_type, host, port, used_count, max_count, is_full}]
        """
        max_per_ip = ProxyAllocator.get_max_windows_per_ip()
        return DBManager.get_all_proxy_usage_stats(max_per_ip)

    @staticmethod
    def get_proxy_bindings(proxy_id: int) -> list:
        """
        获取指定代理关联的窗口列表

        Args:
            proxy_id: 代理 ID

        Returns:
            [{id, proxy_id, browser_id, email, bound_at}]
        """
        return DBManager.get_proxy_bindings(proxy_id)

    @staticmethod
    def get_available_count() -> int:
        """
        获取可用代理配额数量（所有代理的剩余配额总和）

        Returns:
            可用配额数
        """
        stats = ProxyAllocator.get_all_usage_stats()
        return sum(s['max_count'] - s['used_count'] for s in stats if not s['is_full'])

    @staticmethod
    def has_available_proxy() -> bool:
        """
        检查是否有可用代理

        Returns:
            True 如果有可用代理
        """
        return ProxyAllocator.get_next_available_proxy() is not None

    @staticmethod
    def get_proxy_config_for_browser(proxy: dict) -> dict:
        """
        将代理信息转换为 ixBrowser 创建窗口所需的 proxy_config 格式

        Args:
            proxy: 代理信息字典

        Returns:
            proxy_config 字典
        """
        if not proxy:
            return None

        return {
            'type': proxy.get('proxy_type', 'socks5'),
            'host': proxy.get('host', ''),
            'port': proxy.get('port', ''),
            'username': proxy.get('username', ''),
            'password': proxy.get('password', '')
        }
