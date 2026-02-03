"""
Google Authenticator Migration Payload 解码器

解析 otpauth-migration://offline?data=... 格式的迁移 URI，
提取其中的 TOTP 密钥信息。

技术原理:
1. otpauth-migration URI 的 data 参数是 Base64 编码的 Protobuf 数据
2. Protobuf 结构定义参考 Google Authenticator 源码
3. 手动解析 Protobuf 避免依赖 .proto 编译

参考项目: https://github.com/scito/extract_otp_secrets
"""

import base64
from dataclasses import dataclass
from typing import List, Optional, Tuple
from urllib.parse import urlparse, parse_qs, unquote


@dataclass
class OTPAccount:
    """OTP 账号信息"""
    secret: str  # Base32 编码的密钥
    name: str  # 账号名称（通常是邮箱）
    issuer: str  # 发行方（如 Google）
    algorithm: str  # 算法（SHA1, SHA256, SHA512）
    digits: int  # 验证码位数（通常是 6）
    otp_type: str  # 类型（totp, hotp）
    counter: int  # HOTP 计数器（仅 HOTP 使用）

    def get_email(self) -> Optional[str]:
        """
        从账号名称中提取邮箱地址

        名称格式可能是:
        - "user@gmail.com"
        - "Google:user@gmail.com"
        - "user@gmail.com (Google)"
        """
        name = self.name

        # 处理 "Issuer:email" 格式
        if ":" in name:
            parts = name.split(":", 1)
            if len(parts) == 2:
                name = parts[1].strip()

        # 处理 "email (Issuer)" 格式
        if "(" in name:
            name = name.split("(")[0].strip()

        # 验证是否像邮箱
        if "@" in name and "." in name:
            return name.lower()

        return None


# Protobuf Wire Types
WIRE_TYPE_VARINT = 0
WIRE_TYPE_64BIT = 1
WIRE_TYPE_LENGTH_DELIMITED = 2
WIRE_TYPE_32BIT = 5


def _read_varint(data: bytes, offset: int) -> Tuple[int, int]:
    """
    读取 Protobuf varint

    Returns:
        (value, new_offset)
    """
    result = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            break
        shift += 7
    return result, offset


def _read_length_delimited(data: bytes, offset: int) -> Tuple[bytes, int]:
    """
    读取 Protobuf length-delimited 字段

    Returns:
        (content_bytes, new_offset)
    """
    length, offset = _read_varint(data, offset)
    content = data[offset:offset + length]
    return content, offset + length


def _parse_otp_parameters(data: bytes) -> OTPAccount:
    """
    解析单个 OTP 参数

    Protobuf 结构 (OtpParameters):
    - field 1: secret (bytes) - 原始密钥
    - field 2: name (string) - 账号名称
    - field 3: issuer (string) - 发行方
    - field 4: algorithm (enum) - 算法
    - field 5: digits (enum) - 位数
    - field 6: type (enum) - OTP 类型
    - field 7: counter (int64) - HOTP 计数器
    """
    secret_raw = b""
    name = ""
    issuer = ""
    algorithm = 1  # SHA1
    digits = 1  # 6 digits
    otp_type = 2  # TOTP
    counter = 0

    offset = 0
    while offset < len(data):
        # 读取字段标签
        tag, offset = _read_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == WIRE_TYPE_VARINT:
            value, offset = _read_varint(data, offset)
            if field_number == 4:
                algorithm = value
            elif field_number == 5:
                digits = value
            elif field_number == 6:
                otp_type = value
            elif field_number == 7:
                counter = value

        elif wire_type == WIRE_TYPE_LENGTH_DELIMITED:
            content, offset = _read_length_delimited(data, offset)
            if field_number == 1:
                secret_raw = content
            elif field_number == 2:
                name = content.decode("utf-8", errors="replace")
            elif field_number == 3:
                issuer = content.decode("utf-8", errors="replace")

        elif wire_type == WIRE_TYPE_64BIT:
            offset += 8
        elif wire_type == WIRE_TYPE_32BIT:
            offset += 4

    # 将原始密钥转换为 Base32
    secret_base32 = base64.b32encode(secret_raw).decode("ascii").rstrip("=")

    # 映射算法枚举
    algorithm_map = {
        0: "UNSPECIFIED",
        1: "SHA1",
        2: "SHA256",
        3: "SHA512",
        4: "MD5",
    }

    # 映射位数枚举
    digits_map = {
        0: 6,  # UNSPECIFIED defaults to 6
        1: 6,
        2: 8,
    }

    # 映射类型枚举
    type_map = {
        0: "unspecified",
        1: "hotp",
        2: "totp",
    }

    return OTPAccount(
        secret=secret_base32,
        name=name,
        issuer=issuer,
        algorithm=algorithm_map.get(algorithm, "SHA1"),
        digits=digits_map.get(digits, 6),
        otp_type=type_map.get(otp_type, "totp"),
        counter=counter,
    )


def decode_migration_payload(data_base64: str) -> List[OTPAccount]:
    """
    解码 Google Authenticator 迁移数据

    Args:
        data_base64: Base64 编码的 Protobuf 数据

    Returns:
        OTPAccount 列表

    Protobuf 结构 (MigrationPayload):
    - field 1: otp_parameters (repeated OtpParameters)
    - field 2: version (int32)
    - field 3: batch_size (int32)
    - field 4: batch_index (int32)
    - field 5: batch_id (int32)
    """
    # 处理 URL 编码
    data_base64 = unquote(data_base64)

    # 添加 Base64 padding
    padding = 4 - (len(data_base64) % 4)
    if padding != 4:
        data_base64 += "=" * padding

    # 解码 Base64
    try:
        data = base64.b64decode(data_base64)
    except Exception as e:
        raise ValueError(f"无效的 Base64 数据: {e}")

    accounts = []
    offset = 0

    while offset < len(data):
        # 读取字段标签
        tag, offset = _read_varint(data, offset)
        field_number = tag >> 3
        wire_type = tag & 0x07

        if wire_type == WIRE_TYPE_LENGTH_DELIMITED:
            content, offset = _read_length_delimited(data, offset)
            if field_number == 1:
                # OTP 参数
                try:
                    account = _parse_otp_parameters(content)
                    accounts.append(account)
                except Exception as e:
                    print(f"[Warning] 解析 OTP 参数失败: {e}")
        elif wire_type == WIRE_TYPE_VARINT:
            _, offset = _read_varint(data, offset)
        elif wire_type == WIRE_TYPE_64BIT:
            offset += 8
        elif wire_type == WIRE_TYPE_32BIT:
            offset += 4

    return accounts


def parse_otpauth_migration_uri(uri: str) -> List[OTPAccount]:
    """
    解析 otpauth-migration:// URI

    Args:
        uri: 完整的迁移 URI，格式为:
             otpauth-migration://offline?data=...

    Returns:
        OTPAccount 列表

    Raises:
        ValueError: URI 格式无效
    """
    # 解析 URI
    parsed = urlparse(uri)

    # 验证 scheme
    if parsed.scheme != "otpauth-migration":
        raise ValueError(f"无效的 URI scheme: {parsed.scheme}，期望 otpauth-migration")

    # 提取 data 参数
    params = parse_qs(parsed.query)
    if "data" not in params:
        raise ValueError("URI 中缺少 data 参数")

    data_base64 = params["data"][0]

    return decode_migration_payload(data_base64)


def parse_standard_otpauth_uri(uri: str) -> Optional[OTPAccount]:
    """
    解析标准的 otpauth:// URI (单个账号)

    Args:
        uri: 标准 OTP URI，格式为:
             otpauth://totp/Label?secret=...&issuer=...

    Returns:
        OTPAccount 或 None
    """
    parsed = urlparse(uri)

    if parsed.scheme != "otpauth":
        return None

    otp_type = parsed.netloc  # totp or hotp

    # 提取标签（可能包含 issuer:name）
    label = unquote(parsed.path.lstrip("/"))

    # 解析查询参数
    params = parse_qs(parsed.query)

    secret = params.get("secret", [""])[0]
    issuer = params.get("issuer", [""])[0]
    algorithm = params.get("algorithm", ["SHA1"])[0].upper()
    digits = int(params.get("digits", ["6"])[0])
    counter = int(params.get("counter", ["0"])[0])

    # 从标签中提取 issuer 和 name
    if ":" in label:
        parts = label.split(":", 1)
        if not issuer:
            issuer = parts[0]
        name = parts[1]
    else:
        name = label

    return OTPAccount(
        secret=secret.upper(),
        name=name,
        issuer=issuer,
        algorithm=algorithm,
        digits=digits,
        otp_type=otp_type,
        counter=counter,
    )


# ==================== 测试代码 ====================

if __name__ == "__main__":
    # 测试 URI (示例数据，非真实账号)
    test_uri = "otpauth-migration://offline?data=CjEKCkhlbGxvV29ybGQSEHRlc3RAZXhhbXBsZS5jb20aBkdvb2dsZSABKAEwAjgB"

    print("=" * 50)
    print("Google Authenticator Migration Decoder 测试")
    print("=" * 50)

    try:
        accounts = parse_otpauth_migration_uri(test_uri)
        print(f"\n解析到 {len(accounts)} 个账号:")
        for i, acc in enumerate(accounts, 1):
            print(f"\n账号 {i}:")
            print(f"  名称: {acc.name}")
            print(f"  发行方: {acc.issuer}")
            print(f"  密钥: {acc.secret}")
            print(f"  算法: {acc.algorithm}")
            print(f"  位数: {acc.digits}")
            print(f"  类型: {acc.otp_type}")
            print(f"  提取邮箱: {acc.get_email()}")
    except Exception as e:
        print(f"解析失败: {e}")
