"""
ixBrowser API 封装模块

API 文档: https://www.ixbrowser.com/doc/v2/local-api/en

特性:
- 自动重试机制 (TLS 连接错误、网络断开等)
- 指数退避策略
- 客户端自动重置
"""
import time
from ixbrowser_local_api import IXBrowserClient
from ixbrowser_local_api.entities import Profile, Proxy

# 全局客户端实例
_client = None

# 重试配置
MAX_RETRIES = 3
BASE_DELAY = 1.0  # 基础延迟秒数
BACKOFF_FACTOR = 2.0  # 指数退避因子

# 可重试的错误关键词
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
    'self signed certificate',  # 自签名证书错误
    'certificate',  # 其他证书相关错误
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
    """获取或创建 ixBrowser 客户端实例"""
    global _client
    if _client is None:
        _client = IXBrowserClient()
    return _client


def openBrowser(profile_id, max_retries: int = MAX_RETRIES):
    """
    打开浏览器窗口（支持自动重试）

    Args:
        profile_id: Profile ID (整数)
        max_retries: 最大重试次数

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
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id', 'code': -1}

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            print(f"正在打开窗口 {profile_id}..." + (f" (重试 {attempt}/{max_retries})" if attempt > 0 else ""))
            result = client.open_profile(
                profile_id,
                cookies_backup=False,
                load_profile_info_page=False
            )

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                # 检查是否可重试
                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"窗口打开失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()  # 重置客户端
                    time.sleep(delay)
                    continue

                # 针对证书错误提供更多提示
                if 'certificate' in error_msg.lower():
                    print(f"窗口打开失败: {error_msg}")
                    print("  💡 提示: 这可能是窗口的代理配置问题，请检查:")
                    print("     1. 窗口的代理是否正常工作")
                    print("     2. 尝试在 ixBrowser 中将窗口代理设置为「直连」")
                    print("     3. 重启 ixBrowser 后再试")
                else:
                    print(f"窗口打开失败: {error_msg}")
                return {
                    'success': False,
                    'msg': error_msg,
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

            print(f"窗口打开成功: profile_id={profile_id}")
            return response

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口打开异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口打开异常: {last_error}")
            return {
                'success': False,
                'msg': last_error,
                'code': -1
            }

    # 所有重试都失败
    return {
        'success': False,
        'msg': f"重试 {max_retries} 次后仍然失败: {last_error}",
        'code': -1
    }


def closeBrowser(profile_id, max_retries: int = MAX_RETRIES):
    """
    关闭浏览器窗口（支持自动重试）

    Args:
        profile_id: Profile ID (整数)
        max_retries: 最大重试次数
    """
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id'}

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            print(f"正在关闭窗口 {profile_id}..." + (f" (重试 {attempt}/{max_retries})" if attempt > 0 else ""))
            result = client.close_profile(profile_id)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                # 检查是否可重试
                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"窗口关闭失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                # "Process not found" 视为成功（窗口已经关闭）
                if 'process not found' in error_msg.lower():
                    print(f"窗口 {profile_id} 已经关闭")
                    return {'success': True, 'msg': '窗口已关闭'}

                print(f"窗口关闭失败: {error_msg}")
                return {
                    'success': False,
                    'msg': error_msg
                }

            print(f"窗口关闭成功: profile_id={profile_id}")
            return {'success': True}

        except Exception as e:
            last_error = str(e)

            # "Process not found" 视为成功
            if 'process not found' in last_error.lower():
                print(f"窗口 {profile_id} 已经关闭")
                return {'success': True, 'msg': '窗口已关闭'}

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口关闭异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口关闭异常: {last_error}")
            return {
                'success': False,
                'msg': last_error
            }

    return {
        'success': False,
        'msg': f"重试 {max_retries} 次后仍然失败: {last_error}"
    }


def deleteBrowser(profile_id, max_retries: int = MAX_RETRIES):
    """
    删除浏览器窗口（支持自动重试）

    Args:
        profile_id: Profile ID (整数)
        max_retries: 最大重试次数
    """
    # 确保 profile_id 是整数类型
    profile_id = int(profile_id) if profile_id else None
    if not profile_id:
        return {'success': False, 'msg': 'Invalid profile_id'}

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            print(f"正在删除窗口 {profile_id}..." + (f" (重试 {attempt}/{max_retries})" if attempt > 0 else ""))
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

                print(f"窗口删除失败: {error_msg}")
                return {
                    'success': False,
                    'msg': error_msg
                }

            print(f"窗口删除成功")
            return {'success': True}

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口删除异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口删除异常: {last_error}")
            return {
                'success': False,
                'msg': last_error
            }

    return {
        'success': False,
        'msg': f"重试 {max_retries} 次后仍然失败: {last_error}"
    }


def createBrowser(name: str = None, proxy_config: dict = None, max_retries: int = MAX_RETRIES, **kwargs):
    """
    创建新的浏览器窗口（支持自动重试）

    Args:
        name: 窗口名称
        proxy_config: 代理配置 {'type': 'socks5', 'host': '', 'port': '', 'username': '', 'password': ''}
        max_retries: 最大重试次数
        **kwargs: 其他配置参数

    Returns:
        新创建的 profile_id 或 None
    """
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

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            print(f"正在创建窗口: {profile.name}..." + (f" (重试 {attempt}/{max_retries})" if attempt > 0 else ""))
            result = client.create_profile(profile)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"窗口创建失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"窗口创建失败: {error_msg}")
                return None

            profile_id = result.get('profile_id')
            print(f"窗口创建成功，ID: {profile_id}")
            return profile_id

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"窗口创建异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"窗口创建异常: {last_error}")
            return None

    print(f"窗口创建重试 {max_retries} 次后仍然失败: {last_error}")
    return None


def get_profile_list(page: int = 1, limit: int = 50, group_id: int = 0, keyword: str = None, max_retries: int = MAX_RETRIES):
    """
    获取 Profile 列表（支持自动重试）

    Args:
        page: 页码 (从1开始)
        limit: 每页数量
        group_id: 分组ID (0=全部)
        keyword: 搜索关键词
        max_retries: 最大重试次数

    Returns:
        Profile 列表
    """
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            data = client.get_profile_list(
                page=page,
                limit=limit,
                group_id=group_id,
                keyword=keyword
            )

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
                return []

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
            return []

    print(f"获取列表重试 {max_retries} 次后仍然失败")
    return []


def get_profile_info(profile_id: int, max_retries: int = MAX_RETRIES):
    """
    获取单个 Profile 的详细信息（支持自动重试）

    Args:
        profile_id: Profile ID
        max_retries: 最大重试次数

    Returns:
        Profile 信息字典或 None
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


def update_profile(profile_id: int, max_retries: int = MAX_RETRIES, **kwargs):
    """
    更新 Profile 信息（支持自动重试）

    Args:
        profile_id: Profile ID
        max_retries: 最大重试次数
        **kwargs: 要更新的字段
    """
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

    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            result = client.update_profile(profile)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"更新失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"更新失败: {error_msg}")
                return False

            return True

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"更新异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"更新异常: {last_error}")
            return False

    print(f"更新重试 {max_retries} 次后仍然失败")
    return False


def update_profile_proxy(profile_id: int, proxy_type: str = 'direct',
                         proxy_ip: str = None, proxy_port: str = None,
                         proxy_user: str = None, proxy_password: str = None,
                         max_retries: int = MAX_RETRIES):
    """
    更新 Profile 的代理设置（支持自动重试）

    Args:
        profile_id: Profile ID
        proxy_type: 代理类型 (direct/http/https/socks5)
        proxy_ip: 代理IP
        proxy_port: 代理端口
        proxy_user: 代理用户名
        proxy_password: 代理密码
        max_retries: 最大重试次数
    """
    last_error = None

    for attempt in range(max_retries + 1):
        try:
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
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"代理更新失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"代理更新失败: {error_msg}")
                return False

            return True

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"代理更新异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"代理更新异常: {last_error}")
            return False

    print(f"代理更新重试 {max_retries} 次后仍然失败")
    return False


def copy_profile(profile_id: int, name: str = None, group_id: int = None, max_retries: int = MAX_RETRIES):
    """
    复制 Profile（支持自动重试）

    Args:
        profile_id: 源 Profile ID
        name: 新名称
        group_id: 目标分组ID
        max_retries: 最大重试次数

    Returns:
        新 Profile ID 或 None
    """
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()

            result = client.create_profile_by_copying(
                profile_id=profile_id,
                name=name,
                group_id=group_id
            )

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"复制失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"复制失败: {error_msg}")
                return None

            return result.get('profile_id')

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"复制异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"复制异常: {last_error}")
            return None

    print(f"复制重试 {max_retries} 次后仍然失败")
    return None


def get_group_list(page: int = 1, limit: int = 100, max_retries: int = MAX_RETRIES):
    """获取分组列表（支持自动重试）"""
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            result = client.get_group_list(page=page, limit=limit)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"获取分组列表失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                return []

            return result

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"获取分组列表异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"获取分组列表异常: {last_error}")
            return []

    return []


def create_group(name: str, sort: int = 0, max_retries: int = MAX_RETRIES):
    """创建分组（支持自动重试）"""
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            client = get_client()
            result = client.create_group(name=name, sort=sort)

            if result is None:
                error_msg = client.message or "Unknown error"
                last_error = error_msg

                if attempt < max_retries and _is_retryable_error(error_msg):
                    delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                    print(f"创建分组失败: {error_msg}，{delay:.1f}秒后重试...")
                    _reset_client()
                    time.sleep(delay)
                    continue

                print(f"创建分组失败: {error_msg}")
                return None

            return result

        except Exception as e:
            last_error = str(e)

            if attempt < max_retries and _is_retryable_error(last_error):
                delay = BASE_DELAY * (BACKOFF_FACTOR ** attempt)
                print(f"创建分组异常: {last_error}，{delay:.1f}秒后重试...")
                _reset_client()
                time.sleep(delay)
                continue

            print(f"创建分组异常: {last_error}")
            return None

    print(f"创建分组重试 {max_retries} 次后仍然失败")
    return None


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
