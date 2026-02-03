"""
SMS-Bus 接码平台 API 客户端

API 文档: https://sms-bus.com/docs

支持功能:
- 查询余额
- 获取国家/项目列表
- 查询价格（按价格排序）
- 获取手机号
- 获取短信验证码
- 取消请求
"""

import aiohttp
import asyncio
from typing import Optional, Dict, Any, List, Tuple
from dataclasses import dataclass, field

from core.config_manager import ConfigManager


@dataclass
class SMSBusResponse:
    """SMS-Bus API 响应封装"""
    success: bool
    data: Optional[Any] = None
    error: Optional[str] = None
    code: int = 0

    @classmethod
    def from_error(cls, error: str, code: int = 0) -> "SMSBusResponse":
        return cls(success=False, error=error, code=code)

    @classmethod
    def from_data(cls, data: Any, code: int = 200) -> "SMSBusResponse":
        return cls(success=True, data=data, code=code)


@dataclass
class PhoneNumber:
    """获取到的手机号信息"""
    request_id: int
    number: str
    country_id: int
    project_id: int
    cost: float = 0.0
    country_name: str = ""  # 国家名称（如 "United States", "Canada"）

    @property
    def formatted_number(self) -> str:
        """格式化手机号（添加+号）"""
        if self.number.startswith("+"):
            return self.number
        return f"+{self.number}"


@dataclass
class PriceInfo:
    """价格信息"""
    country_id: int
    project_id: int
    cost: float
    total_count: int
    country_name: str = ""
    country_code: str = ""


class SMSBusClient:
    """
    SMS-Bus 接码平台 API 客户端

    使用异步上下文管理器:
        async with SMSBusClient(token="xxx") as client:
            balance = await client.get_balance()
    """

    BASE_URL = "https://sms-bus.com/api/control"

    # Google 服务的常见 project_id（需要通过 list_projects 确认）
    GOOGLE_PROJECT_CODES = ["go", "google", "gg", "gl"]

    def __init__(self, token: str = None, timeout: int = 30):
        """
        初始化 SMS-Bus 客户端

        Args:
            token: API Token，默认从配置读取
            timeout: 请求超时时间（秒）
        """
        self.token = token or ConfigManager.get_sms_bus_token()
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self._session: Optional[aiohttp.ClientSession] = None

        # 缓存
        self._countries_cache: Optional[Dict] = None
        self._projects_cache: Optional[Dict] = None
        self._google_project_id: Optional[int] = None

    async def __aenter__(self) -> "SMSBusClient":
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

    async def _request(self, endpoint: str, params: Dict = None) -> SMSBusResponse:
        """
        发送 API 请求

        Args:
            endpoint: API 端点路径
            params: 查询参数

        Returns:
            SMSBusResponse: 响应对象
        """
        await self._ensure_session()

        url = f"{self.BASE_URL}/{endpoint}"
        request_params = {"token": self.token}
        if params:
            request_params.update(params)

        try:
            async with self._session.get(url, params=request_params) as response:
                result = await response.json()

                code = result.get("code", 0)
                if code == 200:
                    return SMSBusResponse.from_data(result.get("data"), code)
                else:
                    error_msg = result.get("message", f"API Error (code={code})")
                    return SMSBusResponse.from_error(error_msg, code)

        except aiohttp.ClientError as e:
            return SMSBusResponse.from_error(f"网络请求失败: {str(e)}")
        except asyncio.TimeoutError:
            return SMSBusResponse.from_error("请求超时")
        except Exception as e:
            return SMSBusResponse.from_error(f"未知错误: {str(e)}")

    # ==================== 基础 API ====================

    async def get_balance(self) -> SMSBusResponse:
        """
        查询账户余额

        Returns:
            SMSBusResponse: data = {"balance": float, "frozen": float}
        """
        return await self._request("get/balance")

    async def list_countries(self) -> SMSBusResponse:
        """
        获取所有国家列表

        Returns:
            SMSBusResponse: data = {id: {"id": int, "title": str, "code": str}}
        """
        if self._countries_cache:
            return SMSBusResponse.from_data(self._countries_cache)

        response = await self._request("list/countries")
        if response.success:
            self._countries_cache = response.data
        return response

    async def list_projects(self) -> SMSBusResponse:
        """
        获取所有项目/服务列表

        Returns:
            SMSBusResponse: data = {id: {"id": int, "title": str, "code": str}}
        """
        if self._projects_cache:
            return SMSBusResponse.from_data(self._projects_cache)

        response = await self._request("list/projects")
        if response.success:
            self._projects_cache = response.data
        return response

    async def list_prices(self, country_id: int) -> SMSBusResponse:
        """
        查询指定国家的价格和可用号码数量

        Args:
            country_id: 国家 ID

        Returns:
            SMSBusResponse: data = {project_id: PriceInfo}
        """
        return await self._request("list/prices", {"country_id": country_id})

    # ==================== 核心功能 ====================

    async def find_google_project_id(self) -> Optional[int]:
        """
        查找 Google 服务的 project_id

        Returns:
            int: Google 的 project_id，未找到返回 None
        """
        if self._google_project_id:
            return self._google_project_id

        response = await self.list_projects()
        if not response.success:
            return None

        projects = response.data
        if isinstance(projects, dict):
            for project_id, info in projects.items():
                code = info.get("code", "").lower()
                title = info.get("title", "").lower()
                if code in self.GOOGLE_PROJECT_CODES or "google" in title:
                    self._google_project_id = int(project_id)
                    return self._google_project_id

        return None

    async def get_cheapest_prices(
        self,
        project_id: int = None,
        country_ids: List[int] = None,
        limit: int = 5,
    ) -> List[PriceInfo]:
        """
        获取最便宜的价格列表

        Args:
            project_id: 服务 ID（默认为 Google）
            country_ids: 要查询的国家 ID 列表（默认查询常用国家）
            limit: 返回数量限制

        Returns:
            List[PriceInfo]: 按价格排序的价格列表
        """
        if project_id is None:
            project_id = await self.find_google_project_id()
            if project_id is None:
                return []

        # 默认查询的国家（美国、英国、加拿大等常用国家）
        if country_ids is None:
            # 先获取国家列表，找到常用国家
            countries_response = await self.list_countries()
            if countries_response.success and isinstance(countries_response.data, dict):
                country_ids = [int(k) for k in list(countries_response.data.keys())[:20]]
            else:
                country_ids = [1, 2, 3, 4, 5]  # 默认前几个国家

        all_prices: List[PriceInfo] = []

        for country_id in country_ids:
            response = await self.list_prices(country_id)
            if response.success and isinstance(response.data, dict):
                for pid, info in response.data.items():
                    if int(pid) == project_id or info.get("project_id") == project_id:
                        price_info = PriceInfo(
                            country_id=info.get("country_id", country_id),
                            project_id=int(pid) if isinstance(pid, str) else info.get("project_id", project_id),
                            cost=info.get("cost", 0),
                            total_count=info.get("total_count", 0),
                            country_name=info.get("title", ""),
                            country_code=info.get("code", ""),
                        )
                        if price_info.total_count > 0:
                            all_prices.append(price_info)

        # 按价格排序
        all_prices.sort(key=lambda x: x.cost)

        return all_prices[:limit]

    async def get_number(
        self,
        country_id: int = None,
        project_id: int = None,
        prefer_cheapest: bool = True,
    ) -> Tuple[Optional[PhoneNumber], Optional[str]]:
        """
        获取手机号

        Args:
            country_id: 国家 ID（None 时自动选择最便宜的）
            project_id: 服务 ID（None 时自动选择 Google）
            prefer_cheapest: 是否优先选择最便宜的

        Returns:
            Tuple[PhoneNumber, error_msg]: 成功返回 (PhoneNumber, None)，失败返回 (None, error)
        """
        # 自动查找 Google project_id
        if project_id is None:
            project_id = await self.find_google_project_id()
            if project_id is None:
                return None, "未找到 Google 服务"

        # 自动选择最便宜的国家
        cost = 0.0
        country_name = ""
        if country_id is None and prefer_cheapest:
            prices = await self.get_cheapest_prices(project_id=project_id, limit=1)
            if prices:
                country_id = prices[0].country_id
                cost = prices[0].cost
                country_name = prices[0].country_name
            else:
                return None, "没有可用的号码"

        if country_id is None:
            country_id = 1  # 默认美国

        # 如果没有获取到国家名称，尝试从国家列表获取
        if not country_name:
            countries_response = await self.list_countries()
            if countries_response.success and isinstance(countries_response.data, dict):
                country_info = countries_response.data.get(str(country_id), {})
                country_name = country_info.get("title", "")

        # 获取号码
        response = await self._request("get/number", {
            "country_id": country_id,
            "project_id": project_id,
        })

        if response.success:
            data = response.data
            phone = PhoneNumber(
                request_id=data.get("request_id"),
                number=data.get("number"),
                country_id=country_id,
                project_id=project_id,
                cost=cost,
                country_name=country_name,
            )
            return phone, None
        else:
            return None, response.error

    async def get_sms(self, request_id: int) -> Tuple[Optional[str], Optional[str]]:
        """
        获取短信验证码

        Args:
            request_id: 请求 ID

        Returns:
            Tuple[code, error_msg]: 成功返回 (验证码, None)，失败返回 (None, error)
        """
        response = await self._request("get/sms", {"request_id": request_id})

        if response.success:
            return response.data, None
        elif response.code == 50101:
            # 还未收到短信
            return None, "waiting"
        else:
            return None, response.error

    async def wait_for_sms(
        self,
        request_id: int,
        timeout: int = 120,
        interval: int = 5,
        callback: callable = None,
    ) -> Tuple[Optional[str], Optional[str]]:
        """
        轮询等待短信验证码

        Args:
            request_id: 请求 ID
            timeout: 超时时间（秒）
            interval: 轮询间隔（秒）
            callback: 进度回调函数

        Returns:
            Tuple[code, error_msg]: 成功返回 (验证码, None)，失败返回 (None, error)
        """
        start_time = asyncio.get_event_loop().time()

        while asyncio.get_event_loop().time() - start_time < timeout:
            code, error = await self.get_sms(request_id)

            if code:
                return code, None

            if error != "waiting":
                return None, error

            if callback:
                elapsed = int(asyncio.get_event_loop().time() - start_time)
                callback(f"等待验证码... ({elapsed}s/{timeout}s)")

            await asyncio.sleep(interval)

        return None, f"等待验证码超时 ({timeout}s)"

    async def cancel_request(self, request_id: int) -> SMSBusResponse:
        """
        取消请求（释放号码）

        Args:
            request_id: 请求 ID

        Returns:
            SMSBusResponse
        """
        return await self._request("cancel", {"request_id": request_id})


# ==================== 便捷函数 ====================

async def create_sms_bus_client(token: str = None) -> SMSBusClient:
    """
    创建并初始化 SMS-Bus 客户端

    Args:
        token: API Token

    Returns:
        SMSBusClient: 已初始化的客户端
    """
    client = SMSBusClient(token=token)
    await client._ensure_session()
    return client


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("SMS-Bus Client 测试")
        print("=" * 50)

        async with SMSBusClient() as client:
            # 测试余额查询
            balance = await client.get_balance()
            print(f"余额: {balance.data if balance.success else balance.error}")

            # 查找 Google project_id
            google_id = await client.find_google_project_id()
            print(f"Google Project ID: {google_id}")

            # 获取最便宜的价格
            if google_id:
                prices = await client.get_cheapest_prices(project_id=google_id, limit=5)
                print("\n最便宜的 5 个选项:")
                for p in prices:
                    print(f"  - {p.country_name} ({p.country_code}): ${p.cost}, 可用: {p.total_count}")

    asyncio.run(main())
