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
        # 代理设置
        "proxy": {
            "max_windows_per_ip": 3  # 每个IP最大窗口数
        },
        # AI Agent 配置 (多提供商支持)
        "ai_agent": {
            # 默认提供商
            "default_provider": "gemini",
            # 提供商配置
            "providers": {
                "gemini": {
                    "enabled": True,
                    "api_key": "",
                    "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
                    "model": "gemini-2.5-flash",
                    "timeout": 60,
                },
                "anthropic": {
                    "enabled": True,
                    "api_key": "",
                    "base_url": "",  # 留空使用官方 API，或填第三方兼容服务 URL
                    "model": "claude-sonnet-4-20250514",
                    "timeout": 60,
                },
            },
            # 通用配置
            "max_steps": 25,
            "max_tokens": 8192,
            # SoM (Set-of-Mark) 配置
            "use_som": True,              # 启用 SoM 元素标记
            "compress_screenshot": False,  # 压缩截图以减少 API 成本
            "max_elements": 30,            # 元素摘要最大元素数
            # 超时配置（毫秒）
            "timeouts": {
                "operation": 10000,       # 单次操作超时
                "navigation": 60000,      # 页面导航超时
                "network_idle": 5000,     # 网络空闲等待
                "api_call": 30000,        # API 调用超时
            },
            # 延迟配置（秒）
            "delays": {
                "screenshot": 2.0,        # 截图前等待
                "after_click": 1.5,       # 点击后等待
                "after_navigate": 3.0,    # 导航后等待
                "min_page_stable": 0.3,   # 最小页面稳定等待
            },
            # 重试配置
            "retry": {
                "max_retries": 3,         # 最大重试次数
                "base_delay": 1.0,        # 基础重试延迟
                "backoff_factor": 1.5,    # 退避系数
            },
            # 验证码等待（秒）
            "verification_timeout": 90,
            # 兼容性字段 (向后兼容)
            "api_key": "",
            "base_url": "",
            "model": "",
        }
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

    # ============ AI Agent 配置方法 ============

    @classmethod
    def get_ai_default_provider(cls) -> str:
        """获取默认 AI 提供商"""
        return cls.get("ai_agent.default_provider", "gemini")

    @classmethod
    def set_ai_default_provider(cls, provider: str):
        """设置默认 AI 提供商"""
        cls.set("ai_agent.default_provider", provider)

    @classmethod
    def get_ai_provider_config(cls, provider: str = None) -> dict:
        """
        获取指定提供商的配置

        Args:
            provider: 提供商名称 (gemini, anthropic)，为空则使用默认

        Returns:
            dict: 提供商配置
        """
        if not provider:
            provider = cls.get_ai_default_provider()

        config = cls.get(f"ai_agent.providers.{provider}", {})

        # 解密 API Key
        if config.get("api_key"):
            config = config.copy()
            config["api_key"] = cls.decrypt_sensitive(config["api_key"])

        return config

    @classmethod
    def set_ai_provider_config(cls, provider: str, config: dict):
        """
        设置指定提供商的配置

        Args:
            provider: 提供商名称
            config: 配置字典
        """
        # 加密 API Key
        if config.get("api_key"):
            config = config.copy()
            config["api_key"] = cls.encrypt_sensitive(config["api_key"])

        cls.set(f"ai_agent.providers.{provider}", config)

    @classmethod
    def get_ai_provider_api_key(cls, provider: str = None) -> str:
        """获取指定提供商的解密后 API Key"""
        if not provider:
            provider = cls.get_ai_default_provider()

        encrypted = cls.get(f"ai_agent.providers.{provider}.api_key", "")
        return cls.decrypt_sensitive(encrypted)

    @classmethod
    def set_ai_provider_api_key(cls, provider: str, api_key: str):
        """设置指定提供商的 API Key（加密存储）"""
        encrypted = cls.encrypt_sensitive(api_key)
        cls.set(f"ai_agent.providers.{provider}.api_key", encrypted)

    @classmethod
    def get_ai_provider_base_url(cls, provider: str = None) -> str:
        """获取指定提供商的 Base URL"""
        if not provider:
            provider = cls.get_ai_default_provider()

        return cls.get(f"ai_agent.providers.{provider}.base_url", "")

    @classmethod
    def set_ai_provider_base_url(cls, provider: str, base_url: str):
        """设置指定提供商的 Base URL"""
        cls.set(f"ai_agent.providers.{provider}.base_url", base_url)

    @classmethod
    def get_ai_provider_model(cls, provider: str = None) -> str:
        """获取指定提供商的模型名称"""
        if not provider:
            provider = cls.get_ai_default_provider()

        return cls.get(f"ai_agent.providers.{provider}.model", "")

    @classmethod
    def set_ai_provider_model(cls, provider: str, model: str):
        """设置指定提供商的模型名称"""
        cls.set(f"ai_agent.providers.{provider}.model", model)

    @classmethod
    def is_ai_provider_enabled(cls, provider: str) -> bool:
        """检查提供商是否启用"""
        return cls.get(f"ai_agent.providers.{provider}.enabled", False)

    @classmethod
    def set_ai_provider_enabled(cls, provider: str, enabled: bool):
        """设置提供商启用状态"""
        cls.set(f"ai_agent.providers.{provider}.enabled", enabled)

    @classmethod
    def get_enabled_ai_providers(cls) -> list:
        """获取所有启用的提供商列表"""
        providers = cls.get("ai_agent.providers", {})
        return [name for name, config in providers.items() if config.get("enabled", False)]

    @classmethod
    def get_ai_api_key(cls) -> str:
        """
        获取解密后的 AI Agent API Key（向后兼容）

        优先使用默认提供商的 API Key，兼容旧的单一配置
        """
        # 先尝试新的多提供商配置
        provider = cls.get_ai_default_provider()
        key = cls.get_ai_provider_api_key(provider)
        if key:
            return key

        # 兼容旧配置
        encrypted = cls.get("ai_agent.api_key", "")
        return cls.decrypt_sensitive(encrypted)

    @classmethod
    def set_ai_api_key(cls, api_key: str):
        """
        加密保存 AI Agent API Key（向后兼容）

        同时更新默认提供商和兼容字段
        """
        encrypted = cls.encrypt_sensitive(api_key)
        # 更新默认提供商
        provider = cls.get_ai_default_provider()
        cls.set(f"ai_agent.providers.{provider}.api_key", encrypted)
        # 兼容字段
        cls.set("ai_agent.api_key", encrypted)

    @classmethod
    def get_ai_base_url(cls) -> str:
        """获取 AI Agent Base URL（向后兼容）"""
        # 先尝试新的多提供商配置
        provider = cls.get_ai_default_provider()
        url = cls.get_ai_provider_base_url(provider)
        if url:
            return url

        # 兼容旧配置
        return cls.get("ai_agent.base_url", "")

    @classmethod
    def set_ai_base_url(cls, base_url: str):
        """设置 AI Agent Base URL（向后兼容）"""
        # 更新默认提供商
        provider = cls.get_ai_default_provider()
        cls.set(f"ai_agent.providers.{provider}.base_url", base_url)
        # 兼容字段
        cls.set("ai_agent.base_url", base_url)

    @classmethod
    def get_ai_model(cls) -> str:
        """获取 AI Agent 模型名称（向后兼容）"""
        # 先尝试新的多提供商配置
        provider = cls.get_ai_default_provider()
        model = cls.get_ai_provider_model(provider)
        if model:
            return model

        # 兼容旧配置
        return cls.get("ai_agent.model", "gemini-2.5-flash")

    @classmethod
    def set_ai_model(cls, model: str):
        """设置 AI Agent 模型名称（向后兼容）"""
        # 更新默认提供商
        provider = cls.get_ai_default_provider()
        cls.set(f"ai_agent.providers.{provider}.model", model)
        # 兼容字段
        cls.set("ai_agent.model", model)

    @classmethod
    def get_ai_max_steps(cls) -> int:
        """获取 AI Agent 最大步骤数"""
        return cls.get("ai_agent.max_steps", 25)

    @classmethod
    def set_ai_max_steps(cls, max_steps: int):
        """设置 AI Agent 最大步骤数"""
        cls.set("ai_agent.max_steps", max_steps)

    @classmethod
    def get_ai_max_tokens(cls) -> int:
        """获取 AI Agent 最大 Token 数"""
        return cls.get("ai_agent.max_tokens", 8192)

    @classmethod
    def set_ai_max_tokens(cls, max_tokens: int):
        """设置 AI Agent 最大 Token 数"""
        cls.set("ai_agent.max_tokens", max_tokens)

    @classmethod
    def get_llm_config(cls, provider: str = None) -> dict:
        """
        获取用于创建 LLM 实例的配置

        Args:
            provider: 提供商名称，为空则使用默认

        Returns:
            dict: 可直接传给 create_llm() 的配置
        """
        if not provider:
            provider = cls.get_ai_default_provider()

        provider_config = cls.get_ai_provider_config(provider)

        return {
            "provider": provider,
            "api_key": provider_config.get("api_key", ""),
            "base_url": provider_config.get("base_url", ""),
            "model": provider_config.get("model", ""),
            "max_tokens": cls.get_ai_max_tokens(),
            "timeout": provider_config.get("timeout", 60),
        }

    # ============ Gmail IMAP 配置方法 ============

    @classmethod
    def get_gmail_imap_email(cls) -> str:
        """获取 Gmail IMAP 邮箱（用于接收验证码）"""
        return cls.get("gmail_imap_email", "")

    @classmethod
    def set_gmail_imap_email(cls, email: str):
        """设置 Gmail IMAP 邮箱"""
        cls.set("gmail_imap_email", email)

    @classmethod
    def get_gmail_imap_password(cls) -> str:
        """获取 Gmail IMAP 应用密码"""
        return cls.get("gmail_imap_password", "")

    @classmethod
    def set_gmail_imap_password(cls, password: str):
        """设置 Gmail IMAP 应用密码"""
        cls.set("gmail_imap_password", password)

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
