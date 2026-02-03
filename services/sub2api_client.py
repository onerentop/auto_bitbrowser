"""
Sub2API HTTP 客户端

使用 aiohttp 实现异步 HTTP 请求，支持：
- Public Endpoints (无需认证)
- Admin Endpoints (需要 admin token)

API 文档参考: Sub2API Antigravity OAuth 流程
"""

import aiohttp
import asyncio
import re
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

from core.config_manager import ConfigManager


@dataclass
class Sub2APIResponse:
    """Sub2API 响应封装"""
    success: bool
    data: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    status_code: int = 0

    @classmethod
    def from_error(cls, error: str, status_code: int = 0) -> "Sub2APIResponse":
        return cls(success=False, error=error, status_code=status_code)

    @classmethod
    def from_data(cls, data: Dict[str, Any], status_code: int = 200) -> "Sub2APIResponse":
        return cls(success=True, data=data, status_code=status_code)


class Sub2APIClient:
    """
    Sub2API HTTP 客户端

    使用异步上下文管理器:
        async with Sub2APIClient() as client:
            result = await client.start_antigravity_oauth()
    """

    def __init__(
        self,
        base_url: str = None,
        admin_token: str = None,
        timeout: int = 30,
    ):
        """
        初始化 Sub2API 客户端

        Args:
            base_url: API 服务地址，默认从配置读取
            admin_token: 管理员 Token，默认从配置读取
            timeout: 请求超时时间（秒）
        """
        self.base_url = (base_url or ConfigManager.get_sub2api_base_url()).rstrip('/')
        self.admin_token = admin_token or ConfigManager.get_sub2api_token()
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self) -> "Sub2APIClient":
        """异步上下文管理器入口"""
        self._session = aiohttp.ClientSession(timeout=self.timeout)
        return self

    async def __aexit__(self, *args):
        """异步上下文管理器退出"""
        if self._session:
            await self._session.close()
            self._session = None

    async def _ensure_session(self):
        """确保 session 存在"""
        if self._session is None:
            self._session = aiohttp.ClientSession(timeout=self.timeout)

    async def close(self):
        """手动关闭 session"""
        if self._session:
            await self._session.close()
            self._session = None

    def _get_admin_headers(self) -> Dict[str, str]:
        """获取管理员请求头（使用 API Key）"""
        return {
            "Content-Type": "application/json",
            "x-api-key": self.admin_token,  # 使用 x-api-key 头
        }

    def _get_public_headers(self) -> Dict[str, str]:
        """获取公共请求头"""
        return {
            "Content-Type": "application/json",
        }

    async def _request(
        self,
        method: str,
        endpoint: str,
        data: Dict = None,
        params: Dict = None,
        use_admin: bool = False,
    ) -> Sub2APIResponse:
        """
        发送 HTTP 请求

        Args:
            method: HTTP 方法 (GET, POST, PUT, DELETE)
            endpoint: API 端点路径
            data: 请求体数据
            params: 查询参数
            use_admin: 是否使用管理员认证

        Returns:
            Sub2APIResponse: 响应对象
        """
        await self._ensure_session()

        url = f"{self.base_url}{endpoint}"
        headers = self._get_admin_headers() if use_admin else self._get_public_headers()

        try:
            async with self._session.request(
                method=method,
                url=url,
                json=data,
                params=params,
                headers=headers,
            ) as response:
                status_code = response.status

                # 尝试解析 JSON 响应
                try:
                    result = await response.json()
                except Exception:
                    text = await response.text()
                    result = {"raw_response": text}

                if status_code >= 400:
                    error_msg = result.get("error") or result.get("message") or f"HTTP {status_code}"
                    return Sub2APIResponse.from_error(error_msg, status_code)

                # 处理 Sub2API 的响应封装格式: {code, message, data}
                if isinstance(result, dict) and "code" in result:
                    api_code = result.get("code", 0)
                    if api_code != 0:
                        # API 层面的错误
                        error_msg = result.get("message") or f"API Error (code={api_code})"
                        return Sub2APIResponse.from_error(error_msg, status_code)
                    # 成功时，提取内部的 data 字段
                    inner_data = result.get("data", {})
                    if inner_data is None:
                        inner_data = {}
                    return Sub2APIResponse.from_data(inner_data, status_code)

                return Sub2APIResponse.from_data(result, status_code)

        except aiohttp.ClientError as e:
            return Sub2APIResponse.from_error(f"网络请求失败: {str(e)}")
        except asyncio.TimeoutError:
            return Sub2APIResponse.from_error("请求超时")
        except Exception as e:
            return Sub2APIResponse.from_error(f"未知错误: {str(e)}")

    # ==================== Public Endpoints ====================

    async def start_antigravity_oauth(self) -> Sub2APIResponse:
        """
        启动 Antigravity OAuth 流程

        POST /public/antigravity/oauth/start

        Returns:
            Sub2APIResponse 包含:
            {
                "success": true,
                "auth_url": "https://accounts.google.com/o/oauth2/v2/auth?...",
                "session_id": "uuid-session-id",
                "state": "random-state-string"
            }
        """
        return await self._request(
            method="POST",
            endpoint="/public/antigravity/oauth/start",
            use_admin=False,
        )

    async def complete_antigravity_oauth(
        self,
        session_id: str,
        state: str,
        code: str,
    ) -> Sub2APIResponse:
        """
        完成 Antigravity OAuth 流程

        POST /public/antigravity/oauth/complete

        Args:
            session_id: 从 start_antigravity_oauth 获取的会话 ID
            state: 从 start_antigravity_oauth 获取的状态字符串
            code: OAuth 回调中的授权码

        Returns:
            Sub2APIResponse 包含:
            {
                "success": true,
                "account_id": 123,
                "email": "user@gmail.com"
            }
        """
        return await self._request(
            method="POST",
            endpoint="/public/antigravity/oauth/complete",
            data={
                "session_id": session_id,
                "state": state,
                "code": code,
            },
            use_admin=False,
        )

    async def wake_antigravity_account(self, account_id: int) -> Sub2APIResponse:
        """
        唤醒 Antigravity 账号

        POST /public/antigravity/wake

        Args:
            account_id: Sub2API 账号 ID

        Returns:
            Sub2APIResponse
        """
        return await self._request(
            method="POST",
            endpoint="/public/antigravity/wake",
            data={"account_id": account_id},
            use_admin=False,
        )

    # ==================== Admin Endpoints ====================

    async def list_accounts(
        self,
        platform: str = "antigravity",
        page: int = 1,
        limit: int = 100,
    ) -> Sub2APIResponse:
        """
        列出指定平台的所有账号（需要 admin token）

        GET /api/v1/admin/accounts

        Args:
            platform: 平台名称
            page: 页码
            limit: 每页数量

        Returns:
            Sub2APIResponse 包含账号列表
        """
        return await self._request(
            method="GET",
            endpoint="/api/v1/admin/accounts",
            params={
                "platform": platform,
                "page": page,
                "limit": limit,
            },
            use_admin=True,
        )

    async def get_account(self, account_id: int) -> Sub2APIResponse:
        """
        获取账号详情（需要 admin token）

        GET /api/v1/admin/accounts/{account_id}

        Args:
            account_id: 账号 ID

        Returns:
            Sub2APIResponse 包含账号详情
        """
        return await self._request(
            method="GET",
            endpoint=f"/api/v1/admin/accounts/{account_id}",
            use_admin=True,
        )

    async def check_account_exists(self, email: str) -> Optional[int]:
        """
        检查账号是否已存在（去重检查）

        通过列出所有账号并查找匹配的邮箱

        Args:
            email: 账号邮箱

        Returns:
            account_id 如果存在, None 如果不存在
        """
        # 尝试获取账号列表
        response = await self.list_accounts(platform="antigravity", limit=1000)

        if not response.success:
            print(f"[Sub2API] 检查账号存在失败: {response.error}")
            return None

        # API 返回 data.items 而非 data.accounts
        data = response.data or {}  # 防止 data 为 None
        items = data.get("items", [])
        if isinstance(items, list):
            for item in items:
                # 邮箱可能在 name 字段或 credentials.email
                item_email = item.get("name", "") or item.get("credentials", {}).get("email", "")
                if item_email.lower() == email.lower():
                    return item.get("id")

        return None

    async def test_connection(self) -> Sub2APIResponse:
        """
        测试 API 连接

        Returns:
            Sub2APIResponse: 包含连接状态
        """
        try:
            # 尝试调用一个简单的端点来测试连接
            response = await self._request(
                method="GET",
                endpoint="/health",
                use_admin=False,
            )

            if response.success:
                return response

            # 如果没有 /health 端点，尝试列出账号（需要 admin token）
            if self.admin_token:
                response = await self.list_accounts(limit=1)
                if response.success:
                    return Sub2APIResponse.from_data({"status": "connected", "admin": True})

            return Sub2APIResponse.from_error("无法连接到 Sub2API 服务")

        except Exception as e:
            return Sub2APIResponse.from_error(f"连接测试失败: {str(e)}")

    async def test_account_connection(
        self,
        account_id: int,
        model_id: str = "",
    ) -> Sub2APIResponse:
        """
        测试账号连接 (SSE 流式接口)

        POST /api/v1/admin/accounts/{account_id}/test

        这是一个 SSE 流式接口，用于测试账号是否能正常发送请求。
        当账号需要 403 验证时，会在响应中返回错误信息。

        Args:
            account_id: Sub2API 账号 ID
            model_id: 可选的模型 ID

        Returns:
            Sub2APIResponse:
                success=True: 账号正常
                success=False: 账号异常，可能包含 403 验证信息
        """
        await self._ensure_session()

        url = f"{self.base_url}/api/v1/admin/accounts/{account_id}/test"
        headers = self._get_admin_headers()

        try:
            data = {}
            if model_id:
                data["model_id"] = model_id

            async with self._session.post(
                url,
                json=data if data else None,
                headers=headers,
            ) as response:
                status_code = response.status

                # 读取 SSE 流式响应
                content = await response.text()

                # 解析 SSE 事件
                events = self._parse_sse_events(content)

                # 检查是否有错误事件
                for event in events:
                    if event.get("type") == "error":
                        error_msg = event.get("error", "Unknown error")

                        # 检测 403 VALIDATION_REQUIRED 错误
                        if "403" in error_msg or "VALIDATION_REQUIRED" in error_msg:
                            validation_url = self._extract_validation_url_from_error(error_msg)
                            return Sub2APIResponse(
                                success=False,
                                data={
                                    "needs_unlock": True,
                                    "validation_url": validation_url,
                                    "account_id": account_id,
                                    "raw_error": error_msg,
                                },
                                error="VALIDATION_REQUIRED",
                                status_code=403,
                            )

                        return Sub2APIResponse.from_error(error_msg, status_code)

                    if event.get("type") == "test_complete" and event.get("success"):
                        return Sub2APIResponse.from_data(
                            {"account_id": account_id, "status": "ok"},
                            status_code
                        )

                # 没有明确结果，检查 HTTP 状态码
                if status_code >= 400:
                    return Sub2APIResponse.from_error(f"HTTP {status_code}: {content[:200]}", status_code)

                return Sub2APIResponse.from_data({"account_id": account_id, "status": "ok"}, status_code)

        except aiohttp.ClientError as e:
            return Sub2APIResponse.from_error(f"网络请求失败: {str(e)}")
        except asyncio.TimeoutError:
            return Sub2APIResponse.from_error("请求超时")
        except Exception as e:
            return Sub2APIResponse.from_error(f"未知错误: {str(e)}")

    def _parse_sse_events(self, content: str) -> list:
        """解析 SSE 事件流"""
        import json
        events = []
        for line in content.split("\n"):
            line = line.strip()
            if line.startswith("data:"):
                json_str = line[5:].strip()
                if json_str:
                    try:
                        event = json.loads(json_str)
                        events.append(event)
                    except json.JSONDecodeError:
                        pass
        return events

    def _extract_validation_url_from_error(self, error_msg: str) -> str:
        """从错误消息中提取验证 URL"""
        import re
        import json

        # 方法1: 尝试从 JSON 结构中提取 (更精确)
        # 错误消息格式: "API 返回 403: {JSON}"
        json_match = re.search(r'\{[\s\S]*\}', error_msg)
        if json_match:
            try:
                error_json = json.loads(json_match.group(0))
                # 从 error.details[0].metadata.validation_url 提取
                details = error_json.get("error", {}).get("details", [])
                if details and len(details) > 0:
                    metadata = details[0].get("metadata", {})
                    url = metadata.get("validation_url")
                    if url:
                        return url
            except (json.JSONDecodeError, KeyError, IndexError):
                pass

        # 方法2: 用正则提取 URL (后备方案)
        url_pattern = r'https?://accounts\.google\.com/signin/continue[^\s"\'<>\\]+'
        match = re.search(url_pattern, error_msg)
        if match:
            return match.group(0)
        return ""

    # ==================== Proxy Management Endpoints ====================

    async def get_all_proxies_with_count(self) -> Sub2APIResponse:
        """
        获取所有代理及其关联账号数

        GET /api/v1/admin/proxies/all?with_count=true

        Returns:
            Sub2APIResponse 包含代理列表:
            [
                {
                    "id": 1,
                    "name": "US Proxy 1",
                    "protocol": "http",
                    "host": "proxy.example.com",
                    "port": 8080,
                    "username": "user",
                    "password": "pass",
                    "account_count": 5,
                    "status": "active"
                }
            ]
        """
        return await self._request(
            method="GET",
            endpoint="/api/v1/admin/proxies/all",
            params={"with_count": "true"},
            use_admin=True,
        )

    async def update_account(
        self,
        account_id: int,
        proxy_id: int = None,
        notes: str = None,
    ) -> Sub2APIResponse:
        """
        更新账号信息（代理绑定、备注）

        PUT /api/v1/admin/accounts/:id

        Args:
            account_id: Sub2API 账号 ID
            proxy_id: 要绑定的代理 ID（可选）
            notes: 账号备注（可选）

        Returns:
            Sub2APIResponse: 更新结果
        """
        payload = {}
        if proxy_id is not None:
            payload["proxy_id"] = proxy_id
        if notes is not None:
            payload["notes"] = notes

        if not payload:
            return Sub2APIResponse.from_error("没有要更新的字段")

        return await self._request(
            method="PUT",
            endpoint=f"/api/v1/admin/accounts/{account_id}",
            data=payload,
            use_admin=True,
        )

    @staticmethod
    def extract_validation_url(error_response: dict) -> str:
        """从 403 响应提取验证链接"""
        try:
            error = error_response.get("error", {})
            if isinstance(error, dict):
                details = error.get("details", [])
                if isinstance(details, list) and len(details) > 0:
                    metadata = details[0].get("metadata", {})
                    url = metadata.get("validation_url")
                    if url:
                        return url
            url = error_response.get("validation_url")
            if url:
                return url
            data = error_response.get("data", {})
            if isinstance(data, dict):
                url = data.get("validation_url")
                if url:
                    return url
            return None
        except Exception as e:
            print(f"[Sub2API] 提取验证 URL 失败: {e}")
            return None


# ==================== 便捷函数 ====================

async def create_sub2api_client(base_url: str = None, admin_token: str = None) -> Sub2APIClient:
    """创建并初始化 Sub2API 客户端"""
    client = Sub2APIClient(base_url=base_url, admin_token=admin_token)
    await client._ensure_session()
    return client


async def test_sub2api_connection(base_url: str = None, admin_token: str = None) -> tuple:
    """测试 Sub2API 连接"""
    async with Sub2APIClient(base_url=base_url, admin_token=admin_token) as client:
        response = await client.test_connection()
        if response.success:
            return True, "连接成功"
        else:
            return False, response.error or "连接失败"


# ==================== 测试代码 ====================

if __name__ == "__main__":
    import asyncio

    async def main():
        print("Sub2API Client 测试")
        print("=" * 50)
        async with Sub2APIClient() as client:
            print(f"Base URL: {client.base_url}")
            print(f"Has API Key: {bool(client.admin_token)}")
            result = await client.test_connection()
            print(f"连接测试: {result.success}, {result.error or result.data}")

    asyncio.run(main())
