"""
Gmail IMAP 验证码读取模块
用于读取 Google 发送的验证码邮件
"""
import re
import time
import datetime
import ssl
import imaplib
from typing import Optional, Tuple

from imap_tools import MailBox, AND

# 尝试导入 SOCKS 支持
try:
    import socks
    SOCKS_AVAILABLE = True
except ImportError:
    SOCKS_AVAILABLE = False


class SocksMailBox(MailBox):
    """支持 SOCKS5 代理的 MailBox"""

    def __init__(self, host: str, proxy_host: str = None, proxy_port: int = None):
        self._proxy_host = proxy_host
        self._proxy_port = proxy_port
        super().__init__(host)

    def _get_mailbox_client(self):
        """重写以支持 SOCKS5 代理"""
        if self._proxy_host and self._proxy_port and SOCKS_AVAILABLE:
            # 使用 SOCKS5 代理
            socks.setdefaultproxy(socks.SOCKS5, self._proxy_host, self._proxy_port)
            socks.wrapmodule(imaplib)

        # 创建 SSL 上下文
        ssl_context = ssl.create_default_context()
        return imaplib.IMAP4_SSL(self._host, 993, ssl_context=ssl_context)


class GmailCodeReader:
    """
    Gmail IMAP 验证码读取器

    使用方法:
        reader = GmailCodeReader("your@gmail.com", "your-app-password")
        success, code = reader.fetch_verification_code(timeout_seconds=60)
        if success:
            print(f"验证码: {code}")
    """

    GMAIL_IMAP_SERVER = "imap.gmail.com"
    GMAIL_IMAP_PORT = 993

    # Google 发送验证码的邮箱地址（可能来自多个地址）
    GOOGLE_SENDER_PATTERNS = [
        "noreply@google.com",
        "no-reply@accounts.google.com",
        "noreply@accounts.google.com",
        "google.com",
    ]

    def __init__(self, email: str, password: str, proxy_host: str = None, proxy_port: int = None):
        """
        初始化 Gmail IMAP 读取器

        Args:
            email: Gmail 邮箱地址
            password: Gmail 应用专用密码（非登录密码）
            proxy_host: SOCKS5 代理主机（可选）
            proxy_port: SOCKS5 代理端口（可选）
        """
        self.email = email
        self.password = password
        self.proxy_host = proxy_host
        self.proxy_port = proxy_port
        self._mailbox: Optional[MailBox] = None

    def connect(self) -> Tuple[bool, str]:
        """
        连接到 Gmail IMAP 服务器

        Returns:
            (success: bool, message: str)
        """
        try:
            # 如果配置了代理，使用 SOCKS5 代理连接
            if self.proxy_host and self.proxy_port and SOCKS_AVAILABLE:
                print(f"使用 SOCKS5 代理: {self.proxy_host}:{self.proxy_port}")
                # 在 socket 层面设置代理
                import socket
                original_socket = socket.socket
                socks.set_default_proxy(socks.SOCKS5, self.proxy_host, self.proxy_port)
                socket.socket = socks.socksocket

            self._mailbox = MailBox(self.GMAIL_IMAP_SERVER)
            self._mailbox.login(self.email, self.password)
            print(f"✅ Gmail IMAP 连接成功: {self.email}")
            return True, "连接成功"
        except Exception as e:
            error_msg = str(e)
            if "Invalid credentials" in error_msg or "AUTHENTICATIONFAILED" in error_msg:
                return False, "认证失败: 请检查邮箱和应用专用密码是否正确"
            elif "Connection refused" in error_msg:
                return False, "连接被拒绝: 请检查网络连接或代理设置"
            elif "SOCKS" in error_msg or "proxy" in error_msg.lower():
                return False, f"代理连接失败: {error_msg}"
            else:
                return False, f"连接失败: {error_msg}"

    def disconnect(self):
        """断开 IMAP 连接"""
        if self._mailbox:
            try:
                self._mailbox.logout()
            except Exception:
                pass
            self._mailbox = None

    def fetch_verification_code(
        self,
        timeout_seconds: int = 60,
        poll_interval: int = 5,
        lookback_minutes: int = 5
    ) -> Tuple[bool, str]:
        """
        轮询获取验证码

        Args:
            timeout_seconds: 超时时间（秒）
            poll_interval: 轮询间隔（秒）
            lookback_minutes: 搜索最近多少分钟的邮件

        Returns:
            (success: bool, code_or_error: str)
            - 成功时返回 (True, "123456")
            - 失败时返回 (False, "错误信息")
        """
        # 确保已连接
        if not self._mailbox:
            success, msg = self.connect()
            if not success:
                return False, msg

        start_time = time.time()
        checked_uids = set()  # 避免重复检查同一邮件

        print(f"开始轮询验证码邮件（超时: {timeout_seconds}s, 间隔: {poll_interval}s）...")

        while time.time() - start_time < timeout_seconds:
            try:
                # 计算搜索时间范围
                since_date = datetime.date.today() - datetime.timedelta(days=1)

                # 搜索来自 Google 的邮件
                for msg in self._mailbox.fetch(
                    AND(date_gte=since_date),
                    reverse=True,  # 最新的优先
                    limit=20
                ):
                    # 跳过已检查的邮件
                    if msg.uid in checked_uids:
                        continue
                    checked_uids.add(msg.uid)

                    # 检查发件人
                    sender = msg.from_.lower() if msg.from_ else ""
                    is_from_google = any(
                        pattern.lower() in sender
                        for pattern in self.GOOGLE_SENDER_PATTERNS
                    )

                    if not is_from_google:
                        continue

                    # 检查邮件时间（只处理最近 lookback_minutes 分钟的）
                    if msg.date:
                        email_time = msg.date
                        now = datetime.datetime.now(email_time.tzinfo) if email_time.tzinfo else datetime.datetime.now()
                        age_minutes = (now - email_time).total_seconds() / 60

                        if age_minutes > lookback_minutes:
                            continue

                    # 提取验证码
                    code = self._extract_code_from_email(msg.text or msg.html or "")

                    if code:
                        print(f"✅ 找到验证码: {code} (来自: {sender}, 主题: {msg.subject})")
                        return True, code

                # 等待后重试
                elapsed = int(time.time() - start_time)
                print(f"  未找到验证码，{poll_interval}s 后重试... (已等待 {elapsed}s/{timeout_seconds}s)")
                time.sleep(poll_interval)

            except Exception as e:
                print(f"⚠️ 读取邮件出错: {e}")
                # 尝试重新连接
                self.disconnect()
                success, msg = self.connect()
                if not success:
                    return False, f"重连失败: {msg}"

        return False, f"超时: {timeout_seconds}s 内未收到验证码"

    def _extract_code_from_email(self, email_body: str) -> Optional[str]:
        """
        从邮件正文中提取 6 位验证码

        Args:
            email_body: 邮件正文（纯文本或 HTML）

        Returns:
            验证码字符串，或 None
        """
        if not email_body:
            return None

        # 移除 HTML 标签（简单处理）
        text = re.sub(r'<[^>]+>', ' ', email_body)

        # 查找 6 位数字验证码
        # 优先匹配独立的 6 位数字（前后有空格或边界）
        patterns = [
            r'(?:code|verification code|验证码|確認碼)[:\s]*(\d{6})',  # "code: 123456"
            r'(\d{6})(?:\s+is your|是您的)',  # "123456 is your code"
            r'\b(\d{6})\b',  # 独立的 6 位数字
        ]

        for pattern in patterns:
            match = re.search(pattern, text, re.IGNORECASE)
            if match:
                return match.group(1)

        return None

    def __enter__(self):
        """支持 with 语句"""
        self.connect()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出时断开连接"""
        self.disconnect()


def test_gmail_connection(email: str, password: str, proxy_host: str = None, proxy_port: int = None) -> Tuple[bool, str]:
    """
    测试 Gmail IMAP 连接

    Args:
        email: Gmail 邮箱
        password: 应用专用密码
        proxy_host: SOCKS5 代理主机（可选）
        proxy_port: SOCKS5 代理端口（可选）

    Returns:
        (success: bool, message: str)
    """
    reader = GmailCodeReader(email, password, proxy_host, proxy_port)
    success, msg = reader.connect()
    if success:
        reader.disconnect()
    return success, msg


if __name__ == "__main__":
    # 测试用
    import sys

    if len(sys.argv) >= 3:
        test_email = sys.argv[1]
        test_password = sys.argv[2]

        print(f"测试 Gmail IMAP 连接: {test_email}")
        success, msg = test_gmail_connection(test_email, test_password)
        print(f"结果: {msg}")

        if success:
            print("\n尝试读取验证码...")
            with GmailCodeReader(test_email, test_password) as reader:
                success, code = reader.fetch_verification_code(timeout_seconds=30)
                if success:
                    print(f"验证码: {code}")
                else:
                    print(f"获取失败: {code}")
    else:
        print("用法: python email_code_reader.py <gmail地址> <应用密码>")
