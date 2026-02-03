"""
代理智能分配器

功能:
1. 从 Sub2API 获取代理列表
2. 选择账号数最少的代理（平均分配策略）
3. 绑定账号到代理
4. 同步更新 ixBrowser 窗口代理和备注

使用并发锁确保批量操作时的线程安全。
"""

import asyncio
import time
from typing import Callable, List, Optional
from dataclasses import dataclass

from services.sub2api_client import Sub2APIClient
from services import ix_api


@dataclass
class ProxyInfo:
    """Sub2API 代理信息"""
    id: int
    name: str
    protocol: str  # http/https/socks5
    host: str
    port: int
    username: str
    password: str
    account_count: int
    status: str

    @classmethod
    def from_dict(cls, data: dict) -> "ProxyInfo":
        """从字典创建 ProxyInfo"""
        return cls(
            id=data.get("id", 0) or 0,
            name=data.get("name", "") or "",
            protocol=data.get("protocol", "http") or "http",
            host=data.get("host", "") or "",
            port=int(data.get("port") or 0),
            username=data.get("username", "") or "",
            password=data.get("password", "") or "",
            account_count=int(data.get("account_count") or 0),
            status=data.get("status", "active") or "active",
        )


class ProxySmartAllocator:
    """
    代理智能分配器（带并发锁）

    使用示例:
        async with Sub2APIClient() as client:
            allocator = ProxySmartAllocator(client)
            success = await allocator.allocate_and_bind(
                sub2api_account_id=123,
                browser_profile_id="456",
            )
    """

    def __init__(
        self,
        sub2api_client: Sub2APIClient,
        cache_ttl: float = 5.0,
    ):
        """
        初始化代理智能分配器

        Args:
            sub2api_client: Sub2API 客户端实例
            cache_ttl: 代理列表缓存有效期（秒）
        """
        self._client = sub2api_client
        self._lock = asyncio.Lock()
        self._proxy_cache: List[ProxyInfo] = []
        self._cache_time: float = 0
        self._cache_ttl = cache_ttl

    def _log(self, msg: str, callback: Callable[[str], None] = None):
        """日志输出"""
        print(f"[ProxyAllocator] {msg}")
        if callback:
            callback(f"[ProxyBind] {msg}")

    async def _refresh_proxy_cache(self) -> bool:
        """刷新代理缓存"""
        response = await self._client.get_all_proxies_with_count()

        if not response.success:
            self._log(f"获取代理列表失败: {response.error}")
            return False

        data = response.data
        proxies = []

        # 处理响应格式
        if isinstance(data, list):
            # 直接是代理列表
            proxies = data
        elif isinstance(data, dict):
            # 可能是 {items: [...]} 或 {proxies: [...]}
            proxies = data.get("items", []) or data.get("proxies", []) or []

        self._proxy_cache = [
            ProxyInfo.from_dict(p) for p in proxies
            if p.get("status", "active") == "active"
        ]
        self._cache_time = time.time()

        return True

    async def get_least_used_proxy(
        self,
        callback: Callable[[str], None] = None,
    ) -> Optional[ProxyInfo]:
        """
        获取关联账号数最少的代理

        Returns:
            ProxyInfo 或 None（无可用代理）
        """
        # 检查缓存是否过期
        if time.time() - self._cache_time > self._cache_ttl or not self._proxy_cache:
            if not await self._refresh_proxy_cache():
                return None

        if not self._proxy_cache:
            self._log("无可用代理", callback)
            return None

        # 按账号数升序排序，取第一个
        sorted_proxies = sorted(self._proxy_cache, key=lambda p: p.account_count)
        least_used = sorted_proxies[0]

        self._log(
            f"选择代理: {least_used.name} (账号数: {least_used.account_count})",
            callback
        )

        return least_used

    async def allocate_and_bind(
        self,
        sub2api_account_id: int,
        browser_profile_id: str,
        callback: Callable[[str], None] = None,
    ) -> bool:
        """
        分配代理并绑定（原子操作，带锁）

        操作流程:
        1. 获取锁
        2. 获取最少使用的代理
        3. 调用 Sub2API 更新账号 proxy_id
        4. 调用 Sub2API 更新账号 notes 为代理名称
        5. 调用 ixBrowser 更新窗口代理配置
        6. 调用 ixBrowser 更新窗口备注
        7. 更新本地缓存（使该代理 account_count +1）
        8. 释放锁

        Args:
            sub2api_account_id: Sub2API 账号 ID
            browser_profile_id: ixBrowser 窗口 ID
            callback: 进度回调函数

        Returns:
            bool: 是否成功
        """
        async with self._lock:
            try:
                # 1. 获取最少使用的代理
                proxy = await self.get_least_used_proxy(callback)
                if not proxy:
                    self._log("无可用代理，跳过绑定", callback)
                    return False

                # 2. 更新 Sub2API 账号（绑定代理 + 更新备注）
                self._log(f"更新 Sub2API 账号 {sub2api_account_id} -> 代理 {proxy.name}", callback)
                update_response = await self._client.update_account(
                    account_id=sub2api_account_id,
                    proxy_id=proxy.id,
                    notes=proxy.name,
                )

                if not update_response.success:
                    self._log(f"Sub2API 更新失败: {update_response.error}", callback)
                    return False

                self._log("Sub2API 账号代理绑定成功", callback)

                # 3. 并行更新 ixBrowser 窗口代理和备注
                ix_proxy_task = self._update_ix_browser_proxy(
                    browser_profile_id=browser_profile_id,
                    proxy=proxy,
                    callback=callback,
                )
                ix_note_task = self._update_ix_browser_note(
                    browser_profile_id=browser_profile_id,
                    note=proxy.name,
                    callback=callback,
                )

                ix_proxy_success, ix_note_success = await asyncio.gather(
                    ix_proxy_task, ix_note_task
                )

                if not ix_proxy_success:
                    self._log("⚠️ ixBrowser 代理更新失败（Sub2API 绑定仍生效）", callback)

                if not ix_note_success:
                    self._log("⚠️ ixBrowser 备注更新失败", callback)

                # 5. 更新本地缓存（该代理账号数 +1）
                for p in self._proxy_cache:
                    if p.id == proxy.id:
                        p.account_count += 1
                        break

                self._log(f"✅ 代理绑定完成: {proxy.name}", callback)
                return True

            except Exception as e:
                self._log(f"代理绑定异常: {e}", callback)
                return False

    async def _update_ix_browser_proxy(
        self,
        browser_profile_id: str,
        proxy: ProxyInfo,
        callback: Callable[[str], None] = None,
    ) -> bool:
        """
        更新 ixBrowser 窗口代理配置

        Args:
            browser_profile_id: 窗口 ID
            proxy: 代理信息

        Returns:
            bool: 是否成功
        """
        try:
            # ix_api.update_profile_proxy 是同步函数，需要在线程池中执行
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: ix_api.update_profile_proxy(
                    profile_id=int(browser_profile_id),
                    proxy_type=proxy.protocol,
                    proxy_ip=proxy.host,
                    proxy_port=str(proxy.port),
                    proxy_user=proxy.username,
                    proxy_password=proxy.password,
                )
            )

            if result:
                self._log("ixBrowser 代理更新成功", callback)
                return True
            else:
                self._log("ixBrowser 代理更新返回失败", callback)
                return False

        except Exception as e:
            self._log(f"ixBrowser 代理更新异常: {e}", callback)
            return False

    async def _update_ix_browser_note(
        self,
        browser_profile_id: str,
        note: str,
        callback: Callable[[str], None] = None,
    ) -> bool:
        """
        更新 ixBrowser 窗口备注

        Args:
            browser_profile_id: 窗口 ID
            note: 备注内容

        Returns:
            bool: 是否成功
        """
        try:
            # ix_api.update_profile 是同步函数，需要在线程池中执行
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                lambda: ix_api.update_profile(
                    profile_id=int(browser_profile_id),
                    note=note,
                )
            )

            if result:
                self._log("ixBrowser 备注更新成功", callback)
                return True
            else:
                self._log("ixBrowser 备注更新返回失败", callback)
                return False

        except Exception as e:
            self._log(f"ixBrowser 备注更新异常: {e}", callback)
            return False

    async def get_proxy_stats(self) -> List[dict]:
        """
        获取代理统计信息

        Returns:
            代理列表及其账号数
        """
        await self._refresh_proxy_cache()
        return [
            {
                "id": p.id,
                "name": p.name,
                "account_count": p.account_count,
                "host": p.host,
                "port": p.port,
            }
            for p in sorted(self._proxy_cache, key=lambda x: x.account_count)
        ]


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("ProxySmartAllocator 测试")
        print("=" * 50)

        async with Sub2APIClient() as client:
            allocator = ProxySmartAllocator(client)

            # 获取代理统计
            stats = await allocator.get_proxy_stats()
            print(f"代理数量: {len(stats)}")
            for p in stats[:5]:
                print(f"  - {p['name']}: {p['account_count']} 个账号")

            # 获取最少使用的代理
            proxy = await allocator.get_least_used_proxy()
            if proxy:
                print(f"\n最少使用的代理: {proxy.name} ({proxy.account_count} 个账号)")

    asyncio.run(main())
