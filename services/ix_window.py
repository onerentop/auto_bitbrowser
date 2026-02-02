"""
ixBrowser 窗口管理模块
替代 create_window.py，提供窗口创建、管理等高级功能

特性:
- 继承 ix_api 的自动重试机制
- 自动分页获取全部数据
"""
import os
import re
import time
from ixbrowser_local_api import IXBrowserClient
from ixbrowser_local_api.entities import Profile, Proxy
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

# 全局客户端
_client = None

# 重试配置（与 ix_api.py 保持一致）
MAX_RETRIES = 3
BASE_DELAY = 1.0
BACKOFF_FACTOR = 2.0

RETRYABLE_ERRORS = [
    'socket disconnected',
    'tls connection',
    'connection refused',
    'connection reset',
    'network',
    'timeout',
    'process not found',
    'econnrefused',
    'econnreset',
    'etimedout',
]


def _is_retryable_error(error_msg: str) -> bool:
    """判断是否为可重试的错误"""
    if not error_msg:
        return False
    error_lower = error_msg.lower()
    return any(keyword in error_lower for keyword in RETRYABLE_ERRORS)


def _reset_client():
    """重置客户端连接"""
    global _client
    _client = None


def get_client() -> IXBrowserClient:
    """获取或创建客户端实例"""
    global _client
    if _client is None:
        _client = IXBrowserClient()
    return _client


def get_browser_list(page: int = 1, limit: int = 100, group_id: int = 0, fetch_all: bool = True, max_retries: int = MAX_RETRIES) -> list:
    """
    获取所有窗口列表（支持自动重试）

    Args:
        page: 页码 (从1开始)
        limit: 每页数量
        group_id: 分组ID (0=全部)
        fetch_all: 是否自动获取全部数据 (分页遍历)
        max_retries: 最大重试次数

    Returns:
        窗口列表
    """
    def _fetch_page(p: int) -> list:
        """获取单页数据（带重试）"""
        last_error = None

        for attempt in range(max_retries + 1):
            try:
                client = get_client()
                data = client.get_profile_list(page=p, limit=limit, group_id=group_id)

                if data is None:
                    error_msg = client.message or "Unknown error"
                    last_error = error_msg

                    if attempt < max_retries and _is_retryable_error(error_msg):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"获取列表失败: {error_msg}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue

                    print(f"获取列表失败: {error_msg}")
                    return None  # 返回 None 表示失败

                return data

            except Exception as e:
                last_error = str(e)

                if attempt < max_retries and _is_retryable_error(last_error):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"获取列表异常: {last_error}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"获取列表异常: {last_error}")
                return None

        return None

    if not fetch_all:
        # 只获取指定页
        result = _fetch_page(page)
        return result if result is not None else []

    # 自动分页获取全部数据
    all_browsers = []
    current_page = 1

    while True:
        data = _fetch_page(current_page)

        if data is None:
            # 获取失败，返回已获取的数据
            break

        if not data:
            # 没有更多数据
            break

        all_browsers.extend(data)

        if len(data) < limit:
            # 当前页数据不足，说明已是最后一页
            break

        current_page += 1

    return all_browsers


def get_browser_info(profile_id: int, max_retries: int = MAX_RETRIES) -> dict:
    """
    获取指定窗口的详细信息（支持自动重试）

    Args:
        profile_id: Profile ID
        max_retries: 最大重试次数

    Returns:
        窗口信息字典
    """
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            data = client.get_profile_list(profile_id=profile_id)

            if data is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"获取窗口信息失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return None

            if len(data) == 0:
                return None

            return data[0]

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"获取窗口信息异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"获取窗口信息异常: {last_error}")
            return None

    return None


def find_browser_by_email(email: str) -> int:
    """
    通过邮箱查找对应的浏览器窗口

    Args:
        email: 账号邮箱

    Returns:
        profile_id: 匹配的窗口 ID，未找到返回 None
    """
    if not email:
        return None

    browsers = get_browser_list(limit=1000)
    for browser in browsers:
        # 匹配 name 或 username 字段
        if browser.get('name') == email or browser.get('username') == email:
            return browser.get('profile_id')

    return None


def delete_browsers_by_name(name_pattern: str, max_retries: int = MAX_RETRIES) -> int:
    """
    根据名称删除所有匹配的窗口（支持自动重试）

    Args:
        name_pattern: 窗口名称（精确匹配）
        max_retries: 最大重试次数

    Returns:
        删除的窗口数量
    """
    browsers = get_browser_list(limit=1000)
    deleted_count = 0

    for browser in browsers:
        if browser.get('name') == name_pattern:
            profile_id = browser.get('profile_id')

            # 删除操作带重试
            for attempt in range(max_retries + 1):
                try:
                    client = get_client()
                    result = client.delete_profile(profile_id)

                    if result is not None:
                        deleted_count += 1
                        break

                    error_msg = client.message or "Unknown error"
                    if attempt < max_retries and _is_retryable_error(error_msg):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"删除窗口 {profile_id} 失败: {error_msg}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue
                    break

                except Exception as e:
                    if attempt < max_retries and _is_retryable_error(str(e)):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"删除窗口 {profile_id} 异常: {e}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue
                    break

    return deleted_count


def open_browser_by_id(profile_id: int, max_retries: int = MAX_RETRIES) -> bool:
    """打开指定ID的窗口（支持自动重试）"""
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return False

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            result = client.open_profile(profile_id, cookies_backup=False, load_profile_info_page=False)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"窗口打开失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return False

            return True

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口打开异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口打开异常: {last_error}")
            return False

    return False


def delete_browser_by_id(profile_id: int, max_retries: int = MAX_RETRIES) -> bool:
    """删除指定ID的窗口（支持自动重试）"""
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return False

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            result = client.delete_profile(profile_id)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"窗口删除失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return False

            return True

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口删除异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口删除异常: {last_error}")
            return False

    return False


def get_next_window_name(prefix: str) -> str:
    """
    根据前缀生成下一个窗口名称

    Args:
        prefix: 窗口名称前缀

    Returns:
        下一个窗口名称，如 "美国_1"
    """
    browsers = get_browser_list(limit=1000)
    max_num = 0

    prefix_pattern = f"{prefix}_"
    for browser in browsers:
        name = browser.get('name', '')
        if name.startswith(prefix_pattern):
            try:
                suffix = name[len(prefix_pattern):]
                num = int(suffix)
                if num > max_num:
                    max_num = num
            except:
                pass

    return f"{prefix}_{max_num + 1}"


def open_browser_url(profile_id: int, target_url: str, max_retries: int = MAX_RETRIES):
    """打开浏览器窗口并导航到指定URL（支持自动重试）"""
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            result = client.open_profile(profile_id, cookies_backup=False, load_profile_info_page=False)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"打开窗口失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"打开窗口失败: {error_msg}")
                return

            driver_path = result.get('webdriver')
            debugger_address = result.get('debugging_address')

            if driver_path and debugger_address:
                try:
                    chrome_options = Options()
                    chrome_options.add_experimental_option("debuggerAddress", debugger_address)
                    chrome_service = Service(driver_path)
                    driver = webdriver.Chrome(service=chrome_service, options=chrome_options)
                    driver.get(target_url)
                    time.sleep(2)
                    driver.quit()
                except Exception as e:
                    print(f"导航失败: {e}")
            return

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"打开窗口异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"打开窗口异常: {last_error}")
            return


def create_browser_window(account: dict, reference_profile_id: int = None,
                          proxy: dict = None, name_prefix: str = None,
                          template_config: dict = None, group_id: int = 1,
                          max_retries: int = MAX_RETRIES):
    """
    创建新的浏览器窗口（支持自动重试）

    Args:
        account: 账户信息
        reference_profile_id: 参考窗口ID (用于复制)
        proxy: 代理信息
        name_prefix: 窗口名称前缀
        template_config: 模板配置 (未使用，保留兼容性)
        group_id: 分组ID
        max_retries: 最大重试次数

    Returns:
        (profile_id, error_message)
    """
    # 确保 group_id 有效，None 时使用默认值 1
    if group_id is None:
        group_id = 1

    # 检查是否已存在该账号的窗口
    all_browsers = get_browser_list(limit=1000)
    for b in all_browsers:
        if b.get('name') == account['email'] or b.get('username') == account['email']:
            return None, f"该账号已有对应窗口: {b.get('name')} (ID: {b.get('profile_id')})"

    # 如果有参考窗口，使用复制功能
    if reference_profile_id:
        new_name = account['email'] if account.get('email') else get_next_window_name(name_prefix or "Profile")

        # 复制窗口（带重试）
        last_error = None
        result = None
        for attempt in range(max_retries + 1):
            try:
                client = get_client()
                result = client.create_profile_by_copying(
                    profile_id=reference_profile_id,
                    name=new_name,
                    group_id=group_id
                )

                if result is None:
                    error_msg = client.message or "Unknown error"
                    last_error = error_msg

                    if attempt < max_retries and _is_retryable_error(error_msg):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"复制窗口失败: {error_msg}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue

                    return None, f"复制窗口失败: {error_msg}"

                break  # 成功

            except Exception as e:
                last_error = str(e)

                if attempt < max_retries and _is_retryable_error(last_error):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"复制窗口异常: {last_error}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return None, f"复制窗口异常: {last_error}"

        if result is None:
            return None, f"复制窗口重试 {max_retries} 次后仍然失败: {last_error}"

        # result 可能是 dict 或直接是 profile_id
        if isinstance(result, dict):
            new_profile_id = result.get('profile_id')
        else:
            new_profile_id = result

        # 更新账号信息（带重试）
        profile = Profile()
        profile.profile_id = new_profile_id
        profile.note = account.get('full_line', '')
        profile.username = account.get('email', '')
        profile.password = account.get('password', '')
        if account.get('2fa_secret'):
            profile.tfa_secret = account['2fa_secret'].strip()

        for attempt in range(max_retries + 1):
            try:
                client = get_client()
                update_result = client.update_profile(profile)
                if update_result is not None:
                    break
                error_msg = client.message or "Unknown error"
                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"更新窗口信息失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue
                break  # 更新失败但不重试
            except Exception as e:
                if attempt < max_retries and _is_retryable_error(str(e)):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"更新窗口信息异常: {e}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue
                break

        # 更新代理（带重试）
        if proxy:
            for attempt in range(max_retries + 1):
                try:
                    client = get_client()
                    proxy_result = client.update_profile_to_custom_proxy_mode(
                        profile_id=new_profile_id,
                        proxy_type=proxy.get('type', 'socks5'),
                        proxy_ip=proxy.get('host', ''),
                        proxy_port=str(proxy.get('port', '')),
                        proxy_user=proxy.get('username', ''),
                        proxy_password=proxy.get('password', '')
                    )
                    if proxy_result is not None:
                        break
                    error_msg = client.message or "Unknown error"
                    if attempt < max_retries and _is_retryable_error(error_msg):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"更新代理失败: {error_msg}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue
                    break
                except Exception as e:
                    if attempt < max_retries and _is_retryable_error(str(e)):
                        delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                        print(f"更新代理异常: {e}，{delay:.1f}秒后重试...")
                        _reset_client()
                        time.sleep(delay)
                        continue
                    break

        return new_profile_id, None

    # 创建新窗口
    profile = Profile()
    profile.name = account['email'] if account.get('email') else get_next_window_name(name_prefix or "Profile")
    profile.note = account.get('full_line', '')
    profile.username = account.get('email', '')
    profile.password = account.get('password', '')
    profile.group_id = group_id

    if account.get('2fa_secret'):
        profile.tfa_secret = account['2fa_secret'].strip()

    # 设置代理
    if proxy:
        proxy_obj = Proxy()
        proxy_obj.proxy_type = proxy.get('type', 'socks5')
        proxy_obj.proxy_ip = proxy.get('host', '')
        proxy_obj.proxy_port = str(proxy.get('port', ''))
        proxy_obj.proxy_user = proxy.get('username', '')
        proxy_obj.proxy_password = proxy.get('password', '')
        profile.proxy_config = proxy_obj

    # 创建窗口（带重试）
    last_error = None
    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            result = client.create_profile(profile)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"创建窗口失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return None, f"创建窗口失败: {error_msg}"

            # result 可能是 dict 或直接是 profile_id
            if isinstance(result, dict):
                return result.get('profile_id'), None
            else:
                return result, None

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"创建窗口异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            return None, f"创建窗口异常: {last_error}"

    return None, f"创建窗口重试 {max_retries} 次后仍然失败: {last_error}"


def print_browser_info(profile_id: int):
    """打印窗口的完整配置信息"""
    import json
    config = get_browser_info(profile_id)
    if config:
        print(json.dumps(config, indent=2, ensure_ascii=False))


def main():
    """测试入口 - 从数据库读取数据"""
    from .database import DBManager

    # 从数据库获取账号
    DBManager.init_db()
    db_accounts = DBManager.get_all_accounts()
    accounts = []
    for acc in db_accounts:
        if acc.get('status') == 'pending':
            accounts.append({
                'email': acc.get('email', ''),
                'password': acc.get('password', ''),
                'backup_email': acc.get('recovery_email', ''),
                '2fa_secret': acc.get('secret_key', ''),
            })

    if not accounts:
        print("无待处理账号数据")
        return

    # 从数据库获取代理
    db_proxies = DBManager.get_all_proxies()
    proxies = []
    for p in db_proxies:
        proxies.append({
            'type': p.get('proxy_type', 'socks5'),
            'host': p.get('host', ''),
            'port': p.get('port', ''),
            'username': p.get('username', ''),
            'password': p.get('password', '')
        })

    browsers = get_browser_list()
    print(f"当前有 {len(browsers)} 个窗口")

    if browsers:
        reference_profile_id = browsers[0].get('profile_id')
        print(f"使用第一个窗口作为模板: ID={reference_profile_id}")

        success_count = 0
        for i, account in enumerate(accounts[:3], 1):  # 只测试前3个
            proxy = proxies[i - 1] if i - 1 < len(proxies) else None
            profile_id, error = create_browser_window(
                account,
                reference_profile_id=reference_profile_id,
                proxy=proxy
            )
            if profile_id:
                success_count += 1
                print(f"创建成功: {account['email']} -> ID={profile_id}")
            else:
                print(f"创建失败: {error}")

            if i < len(accounts):
                time.sleep(1)

        print(f"完成: {success_count}/{min(3, len(accounts))}")


if __name__ == "__main__":
    main()
