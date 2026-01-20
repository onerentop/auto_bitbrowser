"""
统一数据解析模块
确保所有模块使用一致的解析逻辑，避免数据不一致问题
"""
import re
from typing import Tuple, Optional


def parse_account_line(line: str) -> Tuple[Optional[str], Optional[str], Optional[str], Optional[str], Optional[str]]:
    """
    统一解析账号信息行

    支持格式:
    1. 邮箱----密码----辅助邮箱----2FA密钥
    2. 链接----邮箱----密码----辅助邮箱----2FA密钥
    3. 其他分隔符（自动检测）: ---, |, ,, ;, \\t

    Args:
        line: 原始行文本

    Returns:
        (email, password, recovery_email, secret_key, verification_link)
        如果无法解析，相应字段返回 None
    """
    if not line:
        return None, None, None, None, None

    line = line.strip()

    # 移除注释
    if '#' in line:
        comment_idx = line.find('#')
        # 确保 # 不在 URL 中（URL 的 # 通常后面跟着 anchor）
        if comment_idx > 0 and line[comment_idx - 1] in ' \t':
            line = line[:comment_idx].strip()

    if not line:
        return None, None, None, None, None

    # Step 1: 提取 HTTP/HTTPS 链接（使用非贪婪匹配）
    link = None
    # 匹配 URL，但不匹配分隔符后面的内容
    url_pattern = r'(https?://[^\s\-\|,;]+?)(?=\s*[-]{2,}|\s*\||\s*,|\s*;|\s*$)'
    url_match = re.search(url_pattern, line)
    if url_match:
        link = url_match.group(1).strip()
        # 从原始行中移除链接
        line = line.replace(url_match.group(0), '', 1).strip()
        # 移除开头可能残留的分隔符
        line = re.sub(r'^[-]{2,}', '', line).strip()

    # Step 2: 检测并使用分隔符
    separator = '----'  # 默认分隔符
    separators_priority = ['----', '---', '|', ',', ';', '\t']

    for sep in separators_priority:
        if sep in line:
            separator = sep
            break

    # Step 3: 分割并清理
    parts = line.split(separator)
    parts = [p.strip() for p in parts if p.strip()]

    # Step 4: 识别邮箱并按位置分配字段
    email = None
    password = None
    recovery = None
    secret = None

    # 查找邮箱位置
    email_idx = -1
    for i, p in enumerate(parts):
        if '@' in p and '.' in p.split('@')[-1]:
            email_idx = i
            break

    if email_idx >= 0:
        email = parts[email_idx]
        # 邮箱后面的字段按顺序分配
        remaining = parts[email_idx + 1:]
        if len(remaining) >= 1:
            password = remaining[0]
        if len(remaining) >= 2:
            recovery = remaining[1]
        if len(remaining) >= 3:
            secret = remaining[2]
    elif len(parts) >= 1:
        # 没有找到邮箱，按位置顺序分配（兼容旧逻辑）
        email = parts[0] if len(parts) > 0 else None
        password = parts[1] if len(parts) > 1 else None
        recovery = parts[2] if len(parts) > 2 else None
        secret = parts[3] if len(parts) > 3 else None

    return email, password, recovery, secret, link


def build_account_line(email: str, password: str = None, recovery: str = None,
                       secret: str = None, link: str = None, separator: str = '----') -> str:
    """
    构建账号信息行

    Args:
        email: 邮箱
        password: 密码
        recovery: 辅助邮箱
        secret: 2FA密钥
        link: 验证链接
        separator: 分隔符，默认 ----

    Returns:
        格式化的账号行
    """
    parts = [email]
    if password:
        parts.append(password)
    if recovery:
        parts.append(recovery)
    if secret:
        parts.append(secret)

    line = separator.join(parts)

    if link:
        line = f"{link}{separator}{line}"

    return line


if __name__ == '__main__':
    # 测试用例
    test_cases = [
        "test@email.com----password----recovery@email.com----SECRETKEY",
        "https://sheerid.com/verify/abc123----test@email.com----pass----rec@mail.com----KEY",
        "test@email.com|password|recovery@email.com|SECRETKEY",
        "https://example.com/link----another@test.com----pwd",
        "simple@email.com",
    ]

    print("=" * 60)
    print("统一解析器测试")
    print("=" * 60)

    for case in test_cases:
        result = parse_account_line(case)
        print(f"\n输入: {case[:50]}...")
        print(f"解析: email={result[0]}, pwd={result[1]}, rec={result[2]}, sec={result[3]}, link={result[4][:30] if result[4] else None}...")
