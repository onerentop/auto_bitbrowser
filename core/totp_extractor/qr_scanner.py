"""
QR 码扫描器

从图片中扫描 QR 码并提取 Google Authenticator 迁移数据。

支持的输入格式:
- 图片文件路径
- PIL Image 对象
- Base64 编码的图片数据

依赖:
- pyzbar: QR 码解码
- Pillow: 图片处理
"""

import base64
import io
from typing import List, Optional, Tuple, Union
from pathlib import Path

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    Image = None
    PIL_AVAILABLE = False

try:
    from pyzbar import pyzbar
    from pyzbar.pyzbar import ZBarSymbol
    PYZBAR_AVAILABLE = True
except ImportError:
    pyzbar = None
    PYZBAR_AVAILABLE = False

from .migration_decoder import (
    OTPAccount,
    parse_otpauth_migration_uri,
    parse_standard_otpauth_uri,
)


def check_dependencies() -> Tuple[bool, str]:
    """
    检查依赖是否已安装

    Returns:
        (is_available, error_message)
    """
    missing = []

    if not PIL_AVAILABLE:
        missing.append("Pillow")

    if not PYZBAR_AVAILABLE:
        missing.append("pyzbar")

    if missing:
        return False, f"缺少依赖: {', '.join(missing)}。请运行: pip install {' '.join(missing)}"

    return True, ""


def scan_qr_from_image(image: "Image.Image") -> List[str]:
    """
    从 PIL Image 对象中扫描 QR 码

    Args:
        image: PIL Image 对象

    Returns:
        QR 码内容列表（可能有多个 QR 码）

    Raises:
        ImportError: 依赖未安装
    """
    available, error = check_dependencies()
    if not available:
        raise ImportError(error)

    # 转换为灰度图提高识别率
    if image.mode != "L":
        image = image.convert("L")

    # 解码 QR 码
    decoded_objects = pyzbar.decode(image, symbols=[ZBarSymbol.QRCODE])

    results = []
    for obj in decoded_objects:
        try:
            content = obj.data.decode("utf-8")
            results.append(content)
        except Exception:
            continue

    return results


def scan_qr_from_file(file_path: Union[str, Path]) -> List[str]:
    """
    从图片文件中扫描 QR 码

    Args:
        file_path: 图片文件路径

    Returns:
        QR 码内容列表

    Raises:
        FileNotFoundError: 文件不存在
        ImportError: 依赖未安装
    """
    available, error = check_dependencies()
    if not available:
        raise ImportError(error)

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    # 加载图片
    image = Image.open(path)

    return scan_qr_from_image(image)


def scan_qr_from_base64(base64_data: str) -> List[str]:
    """
    从 Base64 编码的图片数据中扫描 QR 码

    Args:
        base64_data: Base64 编码的图片数据（可包含 data:image/... 前缀）

    Returns:
        QR 码内容列表

    Raises:
        ValueError: Base64 数据无效
        ImportError: 依赖未安装
    """
    available, error = check_dependencies()
    if not available:
        raise ImportError(error)

    # 移除 data URI 前缀
    if "," in base64_data:
        base64_data = base64_data.split(",", 1)[1]

    # 解码 Base64
    try:
        image_data = base64.b64decode(base64_data)
    except Exception as e:
        raise ValueError(f"无效的 Base64 数据: {e}")

    # 加载图片
    image = Image.open(io.BytesIO(image_data))

    return scan_qr_from_image(image)


def extract_totp_secrets_from_image(
    image_source: Union[str, Path, "Image.Image", bytes]
) -> Tuple[List[OTPAccount], List[str]]:
    """
    从图片中提取 TOTP 密钥

    支持两种 QR 码格式:
    1. otpauth-migration://offline?data=... (Google Authenticator 导出)
    2. otpauth://totp/... (标准 OTP URI)

    Args:
        image_source: 图片来源，可以是:
            - 文件路径 (str 或 Path)
            - PIL Image 对象
            - Base64 编码的字符串

    Returns:
        (accounts, errors): 成功提取的账号列表和错误信息列表

    Example:
        accounts, errors = extract_totp_secrets_from_image("screenshot.png")
        for acc in accounts:
            print(f"{acc.name}: {acc.secret}")
    """
    available, error = check_dependencies()
    if not available:
        raise ImportError(error)

    # 获取 QR 码内容
    qr_contents = []

    if isinstance(image_source, (str, Path)):
        path = Path(image_source)
        if path.exists():
            # 文件路径
            qr_contents = scan_qr_from_file(path)
        elif isinstance(image_source, str) and len(image_source) > 200:
            # 可能是 Base64
            qr_contents = scan_qr_from_base64(image_source)
        else:
            raise FileNotFoundError(f"文件不存在: {image_source}")
    elif PIL_AVAILABLE and isinstance(image_source, Image.Image):
        qr_contents = scan_qr_from_image(image_source)
    elif isinstance(image_source, bytes):
        if not PIL_AVAILABLE:
            raise ImportError("需要 Pillow 库来处理 bytes 类型的图片数据")
        image = Image.open(io.BytesIO(image_source))
        qr_contents = scan_qr_from_image(image)
    else:
        raise TypeError(f"不支持的图片来源类型: {type(image_source)}")

    if not qr_contents:
        return [], ["未在图片中找到 QR 码"]

    # 解析 QR 码内容
    accounts = []
    errors = []

    for content in qr_contents:
        try:
            if content.startswith("otpauth-migration://"):
                # Google Authenticator 迁移格式
                parsed_accounts = parse_otpauth_migration_uri(content)
                accounts.extend(parsed_accounts)
            elif content.startswith("otpauth://"):
                # 标准 OTP URI
                account = parse_standard_otpauth_uri(content)
                if account:
                    accounts.append(account)
            else:
                errors.append(f"未知的 QR 码格式: {content[:50]}...")
        except Exception as e:
            errors.append(f"解析 QR 码失败: {e}")

    return accounts, errors


def extract_totp_secrets_from_multiple_images(
    image_paths: List[Union[str, Path]]
) -> Tuple[List[OTPAccount], List[str]]:
    """
    从多个图片中提取 TOTP 密钥

    Args:
        image_paths: 图片路径列表

    Returns:
        (accounts, errors): 合并后的账号列表和错误信息列表
    """
    all_accounts = []
    all_errors = []

    for path in image_paths:
        try:
            accounts, errors = extract_totp_secrets_from_image(path)
            all_accounts.extend(accounts)
            all_errors.extend(errors)
        except Exception as e:
            all_errors.append(f"处理 {path} 失败: {e}")

    return all_accounts, all_errors


# ==================== 测试代码 ====================

if __name__ == "__main__":
    print("=" * 50)
    print("QR Scanner 测试")
    print("=" * 50)

    # 检查依赖
    available, error = check_dependencies()
    if not available:
        print(f"\n❌ {error}")
        print("\n安装说明:")
        print("  Windows: pip install pyzbar Pillow")
        print("  macOS:   brew install zbar && pip install pyzbar Pillow")
        print("  Linux:   sudo apt-get install libzbar0 && pip install pyzbar Pillow")
    else:
        print("\n✅ 所有依赖已安装")

        # 测试扫描
        import sys
        if len(sys.argv) > 1:
            image_path = sys.argv[1]
            print(f"\n扫描图片: {image_path}")
            try:
                accounts, errors = extract_totp_secrets_from_image(image_path)

                if errors:
                    print(f"\n警告: {len(errors)} 个错误")
                    for err in errors:
                        print(f"  - {err}")

                if accounts:
                    print(f"\n找到 {len(accounts)} 个账号:")
                    for i, acc in enumerate(accounts, 1):
                        print(f"\n账号 {i}:")
                        print(f"  名称: {acc.name}")
                        print(f"  发行方: {acc.issuer}")
                        print(f"  密钥: {acc.secret}")
                        print(f"  邮箱: {acc.get_email()}")
                else:
                    print("\n未找到账号")

            except Exception as e:
                print(f"\n❌ 扫描失败: {e}")
        else:
            print("\n用法: python qr_scanner.py <图片路径>")
