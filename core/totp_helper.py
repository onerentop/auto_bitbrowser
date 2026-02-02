"""
TOTP 验证码生成工具

统一的 TOTP (Time-based One-Time Password) 生成工具，
避免在多个文件中重复实现相同逻辑。
"""

import time
from typing import Tuple, Optional

try:
    import pyotp
    PYOTP_AVAILABLE = True
except ImportError:
    pyotp = None
    PYOTP_AVAILABLE = False


def generate_totp(secret: str) -> Tuple[bool, str]:
    """
    生成 TOTP 验证码

    Args:
        secret: 2FA 密钥（可以包含空格和连字符）

    Returns:
        (success, code_or_error): 成功返回 (True, "123456")，失败返回 (False, "错误信息")

    Example:
        >>> success, code = generate_totp("JBSWY3DPEHPK3PXP")
        >>> if success:
        ...     print(f"验证码: {code}")
    """
    if not PYOTP_AVAILABLE:
        return False, "pyotp 库未安装"

    if not secret or secret == "未提供":
        return False, "未提供 2FA 密钥"

    try:
        # 清理 secret（移除空格和连字符）
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)
        code = totp.now()
        return True, code
    except Exception as e:
        return False, f"生成失败: {str(e)}"


def get_totp_remaining_seconds(secret: str) -> int:
    """
    获取当前验证码剩余有效秒数

    Args:
        secret: 2FA 密钥

    Returns:
        剩余秒数（0-30），失败返回 0
    """
    if not PYOTP_AVAILABLE:
        return 0

    try:
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)
        return totp.interval - (int(time.time()) % totp.interval)
    except Exception:
        return 0


def is_totp_about_to_expire(secret: str, threshold: int = 5) -> bool:
    """
    检查当前验证码是否即将过期

    Args:
        secret: 2FA 密钥
        threshold: 过期阈值（秒），默认 5 秒

    Returns:
        True 如果剩余时间小于阈值
    """
    remaining = get_totp_remaining_seconds(secret)
    return remaining > 0 and remaining < threshold


def generate_totp_with_wait(secret: str, min_validity: int = 5) -> Tuple[bool, str]:
    """
    生成 TOTP 验证码，如果即将过期则等待新码

    Args:
        secret: 2FA 密钥
        min_validity: 最小有效时间（秒），默认 5 秒

    Returns:
        (success, code_or_error)

    Note:
        如果当前验证码剩余时间少于 min_validity，会等待到下一个周期
    """
    if not PYOTP_AVAILABLE:
        return False, "pyotp 库未安装"

    if not secret or secret == "未提供":
        return False, "未提供 2FA 密钥"

    try:
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)

        # 检查剩余时间
        remaining = totp.interval - (int(time.time()) % totp.interval)
        if remaining < min_validity:
            # 等待到下一个周期
            wait_time = remaining + 1
            print(f"[TOTP] 验证码即将过期，等待 {wait_time} 秒...")
            time.sleep(wait_time)

        code = totp.now()
        return True, code
    except Exception as e:
        return False, f"生成失败: {str(e)}"


def verify_totp(secret: str, code: str, valid_window: int = 1) -> bool:
    """
    验证 TOTP 验证码

    Args:
        secret: 2FA 密钥
        code: 待验证的验证码
        valid_window: 有效窗口（允许前后几个周期的码），默认 1

    Returns:
        验证结果
    """
    if not PYOTP_AVAILABLE:
        return False

    try:
        clean_secret = secret.replace(" ", "").replace("-", "").upper()
        totp = pyotp.TOTP(clean_secret)
        return totp.verify(code, valid_window=valid_window)
    except Exception:
        return False


# 便捷函数别名
get_totp = generate_totp
