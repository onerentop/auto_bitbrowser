"""
TOTP 密钥提取模块

从 Google Authenticator 导出的 QR 码中提取 TOTP 密钥。

主要功能:
1. 扫描 QR 码图片
2. 解析 otpauth-migration:// URI
3. 提取 Base32 编码的密钥
4. 匹配数据库中的账号并更新

使用流程:
1. 用户从手机 Google Authenticator 导出 QR 码
2. 截图保存到电脑
3. 通过 GUI 上传图片
4. 自动解析并匹配账号
5. 更新数据库中的 secret_key
"""

from .migration_decoder import (
    decode_migration_payload,
    parse_otpauth_migration_uri,
    OTPAccount,
)
from .qr_scanner import (
    scan_qr_from_image,
    scan_qr_from_file,
    extract_totp_secrets_from_image,
)

__all__ = [
    # Migration decoder
    "decode_migration_payload",
    "parse_otpauth_migration_uri",
    "OTPAccount",
    # QR scanner
    "scan_qr_from_image",
    "scan_qr_from_file",
    "extract_totp_secrets_from_image",
]
