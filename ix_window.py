"""
ixBrowser 窗口管理模块
替代 create_window.py，提供窗口创建、管理等高级功能
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


def get_client() -> IXBrowserClient:
    """获取或创建客户端实例"""
    global _client
    if _client is None:
        _client = IXBrowserClient()
    return _client


def read_proxies(file_path: str) -> list:
    """
    读取代理信息文件

    Args:
        file_path: 代理文件路径

    Returns:
        代理列表，每个代理为字典格式 {'type': 'socks5', 'host': '', 'port': '', 'username': '', 'password': ''}
    """
    proxies = []

    if not os.path.exists(file_path):
        return proxies

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                match = re.match(r'^socks5://([^:]+):([^@]+)@([^:]+):(\d+)$', line)
                if match:
                    proxies.append({
                        'type': 'socks5',
                        'host': match.group(3),
                        'port': match.group(4),
                        'username': match.group(1),
                        'password': match.group(2)
                    })
    except Exception:
        pass

    return proxies


def read_separator_config(file_path: str) -> str:
    """从文件顶部读取分隔符配置"""
    default_sep = "----"

    if not os.path.exists(file_path):
        return default_sep

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                if line.startswith('分隔符=') or line.startswith('separator='):
                    match = re.search(r'["\'](.+?)["\']', line)
                    if match:
                        return match.group(1)
                if not line.startswith('#') and '=' not in line:
                    break
    except Exception:
        pass

    return default_sep


def parse_account_line(line: str, separator: str) -> dict:
    """根据分隔符解析账号信息行"""
    if '#' in line:
        comment_pos = line.find('#')
        line = line[:comment_pos].strip()

    if not line:
        return None

    parts = line.split(separator)
    parts = [p.strip() for p in parts if p.strip()]

    if len(parts) < 2:
        return None

    result = {
        'email': '',
        'password': '',
        'backup_email': '',
        '2fa_secret': '',
        'full_line': line
    }

    if len(parts) >= 1:
        result['email'] = parts[0]
    if len(parts) >= 2:
        result['password'] = parts[1]
    if len(parts) >= 3:
        result['backup_email'] = parts[2]
    if len(parts) >= 4:
        result['2fa_secret'] = parts[3]

    return result if result['email'] else None


def read_accounts(file_path: str) -> list:
    """读取账户信息文件"""
    accounts = []

    if not os.path.exists(file_path):
        print(f"错误: 找不到文件 {file_path}")
        return accounts

    separator = read_separator_config(file_path)
    print(f"使用分隔符: '{separator}'")

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()

                if not line or line.startswith('#'):
                    continue

                if line.startswith('分隔符=') or line.startswith('separator='):
                    continue

                account = parse_account_line(line, separator)
                if account:
                    accounts.append(account)
                else:
                    print(f"警告: 第{line_num}行格式不正确: {line[:50]}")
    except Exception as e:
        print(f"读取文件出错: {e}")

    return accounts


def get_browser_list(page: int = 1, limit: int = 50, group_id: int = 0) -> list:
    """
    获取所有窗口列表

    Args:
        page: 页码 (从1开始)
        limit: 每页数量
        group_id: 分组ID (0=全部)

    Returns:
        窗口列表
    """
    client = get_client()
    data = client.get_profile_list(page=page, limit=limit, group_id=group_id)

    if data is None:
        print(f"获取列表失败: {client.message}")
        return []

    return data


def get_browser_info(profile_id: int) -> dict:
    """
    获取指定窗口的详细信息

    Args:
        profile_id: Profile ID

    Returns:
        窗口信息字典
    """
    client = get_client()
    data = client.get_profile_list(profile_id=profile_id)

    if data is None or len(data) == 0:
        return None

    return data[0]


def delete_browsers_by_name(name_pattern: str) -> int:
    """
    根据名称删除所有匹配的窗口

    Args:
        name_pattern: 窗口名称（精确匹配）

    Returns:
        删除的窗口数量
    """
    client = get_client()
    browsers = get_browser_list(limit=1000)
    deleted_count = 0

    for browser in browsers:
        if browser.get('name') == name_pattern:
            profile_id = browser.get('profile_id')
            result = client.delete_profile(profile_id)
            if result is not None:
                deleted_count += 1

    return deleted_count


def open_browser_by_id(profile_id: int) -> bool:
    """打开指定ID的窗口"""
    client = get_client()
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return False
    result = client.open_profile(profile_id, cookies_backup=False, load_profile_info_page=False)
    return result is not None


def delete_browser_by_id(profile_id: int) -> bool:
    """删除指定ID的窗口"""
    client = get_client()
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return False
    result = client.delete_profile(profile_id)
    return result is not None


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


def open_browser_url(profile_id: int, target_url: str):
    """打开浏览器窗口并导航到指定URL"""
    client = get_client()

    result = client.open_profile(profile_id, cookies_backup=False, load_profile_info_page=False)

    if result is None:
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


def create_browser_window(account: dict, reference_profile_id: int = None,
                          proxy: dict = None, platform: str = None,
                          extra_url: str = None, name_prefix: str = None,
                          template_config: dict = None, group_id: int = 1):
    """
    创建新的浏览器窗口

    Args:
        account: 账户信息
        reference_profile_id: 参考窗口ID (用于复制)
        proxy: 代理信息
        platform: 平台URL (ixBrowser 不直接支持，保留兼容性)
        extra_url: 额外URL (ixBrowser 不直接支持，保留兼容性)
        name_prefix: 窗口名称前缀
        template_config: 模板配置 (未使用，保留兼容性)
        group_id: 分组ID

    Returns:
        (profile_id, error_message)
    """
    # 确保 group_id 有效，None 时使用默认值 1
    if group_id is None:
        group_id = 1

    client = get_client()

    # 检查是否已存在该账号的窗口
    all_browsers = get_browser_list(limit=1000)
    for b in all_browsers:
        if b.get('name') == account['email'] or b.get('username') == account['email']:
            return None, f"该账号已有对应窗口: {b.get('name')} (ID: {b.get('profile_id')})"

    # 如果有参考窗口，使用复制功能
    if reference_profile_id:
        new_name = account['email'] if account.get('email') else get_next_window_name(name_prefix or "Profile")
        result = client.create_profile_by_copying(
            profile_id=reference_profile_id,
            name=new_name,
            group_id=group_id
        )

        if result is None:
            return None, f"复制窗口失败: {client.message}"

        # result 可能是 dict 或直接是 profile_id
        if isinstance(result, dict):
            new_profile_id = result.get('profile_id')
        else:
            new_profile_id = result

        # 更新账号信息
        profile = Profile()
        profile.profile_id = new_profile_id
        profile.note = account.get('full_line', '')
        profile.username = account.get('email', '')
        profile.password = account.get('password', '')
        if account.get('2fa_secret'):
            profile.tfa_secret = account['2fa_secret'].strip()

        client.update_profile(profile)

        # 更新代理
        if proxy:
            client.update_profile_to_custom_proxy_mode(
                profile_id=new_profile_id,
                proxy_type=proxy.get('type', 'socks5'),
                proxy_ip=proxy.get('host', ''),
                proxy_port=str(proxy.get('port', '')),
                proxy_user=proxy.get('username', ''),
                proxy_password=proxy.get('password', '')
            )

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

    result = client.create_profile(profile)

    if result is None:
        return None, f"创建窗口失败: {client.message}"

    # result 可能是 dict 或直接是 profile_id
    if isinstance(result, dict):
        return result.get('profile_id'), None
    else:
        return result, None


def print_browser_info(profile_id: int):
    """打印窗口的完整配置信息"""
    import json
    config = get_browser_info(profile_id)
    if config:
        print(json.dumps(config, indent=2, ensure_ascii=False))


def main():
    """测试入口"""
    accounts_file = os.path.join(os.path.dirname(__file__), 'accounts.txt')
    accounts = read_accounts(accounts_file)

    if not accounts:
        print("无账号数据")
        return

    proxies_file = os.path.join(os.path.dirname(__file__), 'proxies.txt')
    proxies = read_proxies(proxies_file)

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
