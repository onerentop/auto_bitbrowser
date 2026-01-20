"""
配置管理器模块
提供配置的持久化存储、加密敏感信息、嵌套配置读写等功能
"""
import json
import os
import sys
import base64
import threading

# 获取基础路径
def get_base_path():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE_PATH = get_base_path()

class ConfigManager:
    """配置管理器 - 单例模式"""

    CONFIG_FILE = os.path.join(BASE_PATH, "config.json")
    _config = None
    _lock = threading.Lock()

    # 默认配置模板
    DEFAULT_CONFIG = {
        "sheerid_api_key": "",
        "default_thread_count": 3,
        "timeouts": {
            "page_load": 30,
            "status_check": 20,
            "iframe_wait": 15
        },
        "delays": {
            "after_login": 3,
            "after_offer": 8,
            "after_add_card": 10,
            "after_save": 18
        },
        "card_rotation_index": 0,
        "last_used_template_id": "",
        "window_name_prefix": "",
        "platform_url": "",
        "extra_url": ""
    }

    # 混淆密钥 (简单混淆，非高安全性加密)
    _OBFUSCATION_KEY = "ixBrowser_AutoManager_2024"

    @classmethod
    def load(cls) -> dict:
        """加载配置，不存在则创建默认配置"""
        with cls._lock:
            if cls._config is not None:
                return cls._config.copy()

            if os.path.exists(cls.CONFIG_FILE):
                try:
                    with open(cls.CONFIG_FILE, 'r', encoding='utf-8') as f:
                        cls._config = json.load(f)
                    # 合并默认配置（处理新增字段）
                    cls._config = cls._merge_config(cls.DEFAULT_CONFIG, cls._config)
                except Exception as e:
                    print(f"[ConfigManager] 加载配置失败: {e}，使用默认配置")
                    cls._config = cls.DEFAULT_CONFIG.copy()
            else:
                cls._config = cls.DEFAULT_CONFIG.copy()
                cls._save_internal()

            return cls._config.copy()

    @classmethod
    def _merge_config(cls, default: dict, current: dict) -> dict:
        """递归合并配置，保留现有值，添加新字段"""
        result = default.copy()
        for key, value in current.items():
            if key in result:
                if isinstance(result[key], dict) and isinstance(value, dict):
                    result[key] = cls._merge_config(result[key], value)
                else:
                    result[key] = value
            else:
                result[key] = value
        return result

    @classmethod
    def save(cls, config: dict = None):
        """保存配置到文件"""
        with cls._lock:
            if config is not None:
                cls._config = config
            cls._save_internal()

    @classmethod
    def _save_internal(cls):
        """内部保存方法（需在锁内调用）"""
        try:
            with open(cls.CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(cls._config, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[ConfigManager] 保存配置失败: {e}")

    @classmethod
    def get(cls, key: str, default=None):
        """
        获取配置项，支持嵌套 key
        例如: ConfigManager.get("timeouts.page_load", 30)
        """
        config = cls.load()
        keys = key.split('.')
        value = config

        try:
            for k in keys:
                value = value[k]
            return value
        except (KeyError, TypeError):
            return default

    @classmethod
    def set(cls, key: str, value):
        """
        设置配置项，支持嵌套 key
        例如: ConfigManager.set("timeouts.page_load", 30)
        """
        with cls._lock:
            if cls._config is None:
                cls.load()

            keys = key.split('.')
            config = cls._config

            # 遍历到倒数第二层
            for k in keys[:-1]:
                if k not in config:
                    config[k] = {}
                config = config[k]

            # 设置最后一层的值
            config[keys[-1]] = value
            cls._save_internal()

    @classmethod
    def encrypt_sensitive(cls, value: str) -> str:
        """简单加密敏感信息（base64 + 混淆）"""
        if not value:
            return ""
        try:
            # 混淆
            obfuscated = ''.join(
                chr(ord(c) ^ ord(cls._OBFUSCATION_KEY[i % len(cls._OBFUSCATION_KEY)]))
                for i, c in enumerate(value)
            )
            # Base64 编码
            encoded = base64.b64encode(obfuscated.encode('utf-8')).decode('utf-8')
            return f"ENC:{encoded}"
        except Exception:
            return value

    @classmethod
    def decrypt_sensitive(cls, value: str) -> str:
        """解密敏感信息"""
        if not value or not value.startswith("ENC:"):
            return value
        try:
            # 去掉前缀
            encoded = value[4:]
            # Base64 解码
            obfuscated = base64.b64decode(encoded.encode('utf-8')).decode('utf-8')
            # 反混淆
            original = ''.join(
                chr(ord(c) ^ ord(cls._OBFUSCATION_KEY[i % len(cls._OBFUSCATION_KEY)]))
                for i, c in enumerate(obfuscated)
            )
            return original
        except Exception:
            return value

    @classmethod
    def get_api_key(cls) -> str:
        """获取解密后的 API Key"""
        encrypted = cls.get("sheerid_api_key", "")
        return cls.decrypt_sensitive(encrypted)

    @classmethod
    def set_api_key(cls, api_key: str):
        """加密保存 API Key"""
        encrypted = cls.encrypt_sensitive(api_key)
        cls.set("sheerid_api_key", encrypted)

    @classmethod
    def reload(cls):
        """强制重新加载配置"""
        with cls._lock:
            cls._config = None
        return cls.load()


# 便捷函数
def get_config(key: str, default=None):
    """获取配置的便捷函数"""
    return ConfigManager.get(key, default)

def set_config(key: str, value):
    """设置配置的便捷函数"""
    ConfigManager.set(key, value)


if __name__ == '__main__':
    # 测试
    print("配置文件路径:", ConfigManager.CONFIG_FILE)

    # 加载配置
    config = ConfigManager.load()
    print("当前配置:", json.dumps(config, indent=2, ensure_ascii=False))

    # 测试嵌套获取
    print("page_load 超时:", ConfigManager.get("timeouts.page_load", 30))

    # 测试设置
    ConfigManager.set("default_thread_count", 5)
    print("更新后线程数:", ConfigManager.get("default_thread_count"))

    # 测试加密
    test_key = "sk-test-12345"
    encrypted = ConfigManager.encrypt_sensitive(test_key)
    decrypted = ConfigManager.decrypt_sensitive(encrypted)
    print(f"加密测试: {test_key} -> {encrypted} -> {decrypted}")
    print("加密解密一致:", test_key == decrypted)
