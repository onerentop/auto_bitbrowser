"""
ixBrowser API 封装模块

API 文档: https://www.ixbrowser.com/doc/v2/local-api/en
"""
import time
from ixbrowser_local_api import IXBrowserClient
from ixbrowser_local_api.entities import Profile, Proxy

# 全局客户端实例
_client = None


def get_client() -> IXBrowserClient:
    """获取或创建 ixBrowser 客户端实例"""
    global _client
    if _client is None:
        _client = IXBrowserClient()
    return _client


def openBrowser(profile_id):
    """
    打开浏览器窗口

    Args:
        profile_id: Profile ID (整数)

    Returns:
        标准格式响应:
        {
            'success': True/False,
            'data': {
                'ws': 'ws://...',  # WebSocket endpoint
                'http': '127.0.0.1:port',  # 调试地址
                'driver': 'path/to/chromedriver'
            }
        }
    """
    client = get_client()

    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id', 'code': -1}

    print(f"正在打开窗口 {profile_id}...")
    result = client.open_profile(
        profile_id,
        cookies_backup=False,
        load_profile_info_page=False
    )

    if result is None:
        print(f"窗口打开失败: {client.message}")
        return {
            'success': False,
            'msg': client.message,
            'code': client.code
        }

    # 构建标准响应格式
    response = {
        'success': True,
        'data': {
            'ws': result.get('ws', ''),
            'http': result.get('debugging_address', ''),
            'driver': result.get('webdriver', ''),
            'pid': result.get('pid', 0),
            'profile_id': result.get('profile_id', profile_id)
        }
    }

    print(f"窗口打开响应: {response}")
    return response


def closeBrowser(profile_id):
    """
    关闭浏览器窗口

    Args:
        profile_id: Profile ID (整数)
    """
    client = get_client()

    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id'}

    print(f"正在关闭窗口 {profile_id}...")
    result = client.close_profile(profile_id)

    if result is None:
        print(f"窗口关闭失败: {client.message}")
        return {
            'success': False,
            'msg': client.message
        }

    print(f"窗口关闭成功")
    return {'success': True}


def deleteBrowser(profile_id):
    """
    删除浏览器窗口

    Args:
        profile_id: Profile ID (整数)
    """
    client = get_client()

    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id'}

    print(f"正在删除窗口 {profile_id}...")
    result = client.delete_profile(profile_id)

    if result is None:
        print(f"窗口删除失败: {client.message}")
        return {
            'success': False,
            'msg': client.message
        }

    print(f"窗口删除成功")
    return {'success': True}


def createBrowser(name: str = None, proxy_config: dict = None, **kwargs):
    """
    创建新的浏览器窗口

    Args:
        name: 窗口名称
        proxy_config: 代理配置 {'type': 'socks5', 'host': '', 'port': '', 'username': '', 'password': ''}
        **kwargs: 其他配置参数

    Returns:
        新创建的 profile_id 或 None
    """
    client = get_client()

    profile = Profile()
    profile.name = name or f"Profile_{int(time.time())}"

    # 设置代理
    if proxy_config:
        proxy = Proxy()
        proxy.proxy_type = proxy_config.get('type', 'direct')
        proxy.proxy_ip = proxy_config.get('host', '')
        proxy.proxy_port = str(proxy_config.get('port', ''))
        proxy.proxy_user = proxy_config.get('username', '')
        proxy.proxy_password = proxy_config.get('password', '')
        profile.proxy_config = proxy

    # 设置其他参数
    if kwargs.get('note'):
        profile.note = kwargs['note']
    if kwargs.get('username'):
        profile.username = kwargs['username']
    if kwargs.get('password'):
        profile.password = kwargs['password']
    if kwargs.get('tfa_secret'):
        profile.tfa_secret = kwargs['tfa_secret']
    if kwargs.get('group_id'):
        profile.group_id = kwargs['group_id']

    print(f"正在创建窗口: {profile.name}...")
    result = client.create_profile(profile)

    if result is None:
        print(f"窗口创建失败: {client.message}")
        return None

    profile_id = result.get('profile_id')
    print(f"窗口创建成功，ID: {profile_id}")
    return profile_id


def get_profile_list(page: int = 1, limit: int = 50, group_id: int = 0, keyword: str = None):
    """
    获取 Profile 列表

    Args:
        page: 页码 (从1开始)
        limit: 每页数量
        group_id: 分组ID (0=全部)
        keyword: 搜索关键词

    Returns:
        Profile 列表
    """
    client = get_client()

    data = client.get_profile_list(
        page=page,
        limit=limit,
        group_id=group_id,
        keyword=keyword
    )

    if data is None:
        print(f"获取列表失败: {client.message}")
        return []

    return data


def get_profile_info(profile_id: int):
    """
    获取单个 Profile 的详细信息

    Args:
        profile_id: Profile ID

    Returns:
        Profile 信息字典或 None
    """
    client = get_client()

    data = client.get_profile_list(profile_id=profile_id)

    if data is None or len(data) == 0:
        return None

    return data[0]


def update_profile(profile_id: int, **kwargs):
    """
    更新 Profile 信息

    Args:
        profile_id: Profile ID
        **kwargs: 要更新的字段
    """
    client = get_client()

    profile = Profile()
    profile.profile_id = profile_id

    if 'name' in kwargs:
        profile.name = kwargs['name']
    if 'note' in kwargs:
        profile.note = kwargs['note']
    if 'username' in kwargs:
        profile.username = kwargs['username']
    if 'password' in kwargs:
        profile.password = kwargs['password']
    if 'tfa_secret' in kwargs:
        profile.tfa_secret = kwargs['tfa_secret']

    result = client.update_profile(profile)

    if result is None:
        print(f"更新失败: {client.message}")
        return False

    return True


def update_profile_proxy(profile_id: int, proxy_type: str = 'direct',
                         proxy_ip: str = None, proxy_port: str = None,
                         proxy_user: str = None, proxy_password: str = None):
    """
    更新 Profile 的代理设置

    Args:
        profile_id: Profile ID
        proxy_type: 代理类型 (direct/http/https/socks5)
        proxy_ip: 代理IP
        proxy_port: 代理端口
        proxy_user: 代理用户名
        proxy_password: 代理密码
    """
    client = get_client()

    result = client.update_profile_to_custom_proxy_mode(
        profile_id=profile_id,
        proxy_type=proxy_type,
        proxy_ip=proxy_ip,
        proxy_port=proxy_port,
        proxy_user=proxy_user,
        proxy_password=proxy_password
    )

    if result is None:
        print(f"代理更新失败: {client.message}")
        return False

    return True


def copy_profile(profile_id: int, name: str = None, group_id: int = None):
    """
    复制 Profile

    Args:
        profile_id: 源 Profile ID
        name: 新名称
        group_id: 目标分组ID

    Returns:
        新 Profile ID 或 None
    """
    client = get_client()

    result = client.create_profile_by_copying(
        profile_id=profile_id,
        name=name,
        group_id=group_id
    )

    if result is None:
        print(f"复制失败: {client.message}")
        return None

    return result.get('profile_id')


def get_group_list(page: int = 1, limit: int = 100):
    """获取分组列表"""
    client = get_client()
    return client.get_group_list(page=page, limit=limit)


def create_group(name: str, sort: int = 0):
    """创建分组"""
    client = get_client()
    return client.create_group(name=name, sort=sort)


# ============ 函数别名 ============

def createBrowserWindow(*args, **kwargs):
    """别名: createBrowser"""
    return createBrowser(*args, **kwargs)


if __name__ == '__main__':
    # 测试代码
    try:
        profiles = get_profile_list(limit=5)
        print(f"获取到 {len(profiles)} 个 Profile")

        if profiles:
            first = profiles[0]
            profile_id = first.get('profile_id')
            print(f"\n测试打开 Profile {profile_id}...")

            res = openBrowser(profile_id)
            if res.get('success'):
                print(f"WebSocket: {res['data']['ws']}")
                print("等待 3 秒...")
                time.sleep(3)
                closeBrowser(profile_id)

    except Exception as e:
        print(f"测试失败: {e}")
        import traceback
        traceback.print_exc()
