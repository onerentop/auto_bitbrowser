"""
数据存储服务层
统一管理 proxies 等内存数据，替代文件读取
"""
import threading
from typing import List, Dict
from dataclasses import dataclass, asdict


@dataclass
class ProxyInfo:
    """代理信息"""
    proxy_type: str = "socks5"
    username: str = ""
    password: str = ""
    host: str = ""
    port: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict) -> 'ProxyInfo':
        return cls(
            proxy_type=data.get('proxy_type', 'socks5'),
            username=data.get('username', ''),
            password=data.get('password', ''),
            host=data.get('host', ''),
            port=data.get('port', '')
        )

    def to_url(self) -> str:
        """转换为 URL 格式"""
        if self.username and self.password:
            return f"{self.proxy_type}://{self.username}:{self.password}@{self.host}:{self.port}"
        return f"{self.proxy_type}://{self.host}:{self.port}"


class DataStore:
    """
    数据存储单例
    统一管理 proxies 数据
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._proxies: List[ProxyInfo] = []
        self._data_lock = threading.Lock()

        # 尝试从数据库加载
        self._load_from_db(silent=False)

    def _load_from_db(self, silent: bool = False):
        """从数据库加载数据

        Args:
            silent: 是否静默模式（不打印日志）
        """
        try:
            from .database import DBManager

            # 加载代理
            proxies_data = DBManager.get_all_proxies()
            self._proxies = [ProxyInfo.from_dict(p) for p in proxies_data]

            if not silent:
                print(f"[DataStore] 从数据库加载 {len(self._proxies)} 个代理")
        except Exception as e:
            if not silent:
                print(f"[DataStore] 数据库加载失败（可能表不存在）: {e}")

    # ==================== Proxies ====================

    def get_proxies(self) -> List[ProxyInfo]:
        """获取所有代理"""
        with self._data_lock:
            return list(self._proxies)

    def get_proxies_as_dicts(self) -> List[Dict]:
        """获取所有代理（字典格式）"""
        with self._data_lock:
            return [p.to_dict() for p in self._proxies]

    def set_proxies(self, proxies: List[ProxyInfo]):
        """设置代理列表"""
        with self._data_lock:
            self._proxies = list(proxies)
        self._save_proxies_to_db()

    def add_proxy(self, proxy: ProxyInfo):
        """添加代理"""
        with self._data_lock:
            self._proxies.append(proxy)
        self._save_proxies_to_db()

    def remove_proxy(self, index: int):
        """删除代理"""
        with self._data_lock:
            if 0 <= index < len(self._proxies):
                self._proxies.pop(index)
        self._save_proxies_to_db()

    def update_proxy(self, index: int, proxy: ProxyInfo):
        """更新代理"""
        with self._data_lock:
            if 0 <= index < len(self._proxies):
                self._proxies[index] = proxy
        self._save_proxies_to_db()

    def clear_proxies(self):
        """清空代理"""
        with self._data_lock:
            self._proxies.clear()
        self._save_proxies_to_db()

    def _save_proxies_to_db(self):
        """保存代理到数据库"""
        try:
            from .database import DBManager
            DBManager.save_all_proxies([p.to_dict() for p in self._proxies])
        except Exception as e:
            print(f"[DataStore] 保存代理失败: {e}")

    # ==================== 刷新 ====================

    def reload(self, silent: bool = True):
        """重新从数据库加载

        Args:
            silent: 是否静默模式（不打印日志），默认 True
        """
        self._load_from_db(silent=silent)


# 全局实例
data_store = DataStore()


def get_data_store() -> DataStore:
    """获取 DataStore 单例"""
    return data_store
