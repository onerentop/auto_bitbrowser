"""
ixBrowser API 连接测试脚本
用于验证 ixBrowser 本地 API 是否可用

测试内容：
1. API 服务连接
2. 获取 Profile 列表
3. 打开/关闭 Profile（如果存在）
"""
import sys
import time
import io

# 修复 Windows 控制台编码问题
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# 尝试导入 ixbrowser-local-api
try:
    from ixbrowser_local_api import IXBrowserClient
    print("[OK] ixbrowser-local-api 模块导入成功")
except ImportError:
    print("[FAIL] ixbrowser-local-api 未安装")
    print("  请运行: pip install ixbrowser-local-api")
    sys.exit(1)


def test_connection():
    """测试 API 连接"""
    print("\n" + "="*50)
    print("测试 1: API 连接")
    print("="*50)

    client = IXBrowserClient()
    client.show_request_log = True  # 显示请求日志

    # 测试获取 Profile 列表
    data = client.get_profile_list(page=1, limit=10)

    if data is None:
        print(f"[FAIL] API 连接失败")
        print(f"  错误码: {client.code}")
        print(f"  错误信息: {client.message}")
        return None, client

    print(f"[OK] API 连接成功")
    print(f"  总 Profile 数: {client.total}")
    print(f"  本页返回数: {len(data)}")

    return data, client


def test_profile_list(data):
    """显示 Profile 列表"""
    print("\n" + "="*50)
    print("测试 2: Profile 列表")
    print("="*50)

    if not data:
        print("  无 Profile")
        return None

    print(f"找到 {len(data)} 个 Profile:")
    for i, profile in enumerate(data[:5]):  # 只显示前5个
        profile_id = profile.get('profile_id')
        name = profile.get('name', 'N/A')
        group_name = profile.get('group_name', 'N/A')
        note = profile.get('note', '')[:30] if profile.get('note') else ''

        print(f"  [{i+1}] ID: {profile_id}")
        print(f"      名称: {name}")
        print(f"      分组: {group_name}")
        if note:
            print(f"      备注: {note}...")
        print()

    return data[0] if data else None


def test_open_close_profile(client, profile):
    """测试打开和关闭 Profile"""
    print("\n" + "="*50)
    print("测试 3: 打开/关闭 Profile")
    print("="*50)

    if not profile:
        print("  跳过：无可用 Profile")
        return False

    profile_id = profile.get('profile_id')
    name = profile.get('name', 'N/A')

    print(f"测试 Profile: {name} (ID: {profile_id})")

    # 打开 Profile
    print("\n正在打开 Profile...")
    result = client.open_profile(
        profile_id,
        cookies_backup=False,
        load_profile_info_page=False
    )

    if result is None:
        print(f"[FAIL] 打开失败")
        print(f"  错误码: {client.code}")
        print(f"  错误信息: {client.message}")
        return False

    print(f"[OK] 打开成功")
    print(f"  WebDriver 路径: {result.get('webdriver', 'N/A')}")
    print(f"  调试地址: {result.get('debugging_address', 'N/A')}")

    # 关键信息：这是 Playwright 需要的
    debugging_address = result.get('debugging_address')
    if debugging_address:
        print(f"\n  *** CDP 连接地址: http://{debugging_address} ***")
        print("  (Playwright 将使用此地址连接)")

    # 等待几秒
    print(f"\n等待 5 秒...")
    time.sleep(5)

    # 关闭 Profile
    print("正在关闭 Profile...")
    close_result = client.close_profile(profile_id)

    if close_result is None:
        print(f"[FAIL] 关闭失败")
        print(f"  错误码: {client.code}")
        print(f"  错误信息: {client.message}")
        return False

    print(f"[OK] 关闭成功")
    return True


def main():
    print("="*50)
    print("ixBrowser API 连接测试")
    print("="*50)
    print(f"目标地址: http://127.0.0.1:53200")
    print(f"请确保 ixBrowser 客户端正在运行")

    # 测试 1: 连接
    data, client = test_connection()
    if data is None:
        print("\n测试终止：API 连接失败")
        return

    # 测试 2: 列表
    first_profile = test_profile_list(data)

    # 测试 3: 自动打开/关闭第一个 Profile
    if first_profile:
        print("\n自动测试打开第一个 Profile...")
        test_open_close_profile(client, first_profile)

    print("\n" + "="*50)
    print("测试完成")
    print("="*50)


if __name__ == "__main__":
    main()
