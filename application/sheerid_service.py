"""SheerID 业务应用服务

Why:
- 将 SheerID 相关的业务逻辑从 GUI 层剥离，降低界面层复杂度。
- 为后续批量任务编排和仓储拆分提供稳定边界。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Sequence

from core.config_manager import ConfigManager
from services.database import DBManager


@dataclass
class SheerIDAccountItem:
    """SheerID 待处理账号项"""

    email: str
    vid: str
    link: str


class SheerIDService:
    """SheerID 应用服务"""

    @staticmethod
    def get_api_key() -> str:
        """获取已保存的 SheerID API Key。"""
        return ConfigManager.get_api_key() or ""

    @staticmethod
    def set_api_key(api_key: str) -> None:
        """保存 SheerID API Key。"""
        ConfigManager.set_api_key(api_key)

    @staticmethod
    def load_accounts_by_statuses(statuses: Sequence[str]) -> List[SheerIDAccountItem]:
        """按状态加载账号列表并转换为界面所需结构"""
        if not statuses:
            return []

        result: List[SheerIDAccountItem] = []
        for status in statuses:
            accounts = DBManager.get_accounts_by_status(status) or []
            for account in accounts:
                email = account.get("email", "")
                if not email:
                    continue

                vid = account.get("verification_id") or account.get("vid", "")
                link = account.get("sheer_link") or account.get("link", "")

                result.append(
                    SheerIDAccountItem(
                        email=email,
                        vid=vid,
                        link=link,
                    )
                )

        return result

    @staticmethod
    def mark_verified_success(email: str, verification_id: str) -> None:
        """标记账号验证成功并记录历史"""
        if not email:
            raise ValueError("email 不能为空")

        DBManager.upsert_account(
            email=email,
            status="verified",
            message="SheerID 验证成功",
        )

        if verification_id:
            DBManager.add_sheerid_verification(
                email=email,
                verification_id=verification_id,
                verification_result="success",
                message="验证成功",
            )
