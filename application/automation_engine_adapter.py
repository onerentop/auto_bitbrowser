"""自动化引擎统一适配层。

Why:
- 统一 application 层对 automation/services 外部模块的调用入口。
- 降低 orchestrator 对底层模块路径与实现细节的直接依赖。
"""

from __future__ import annotations

from typing import Callable, Sequence


class AutomationEngineAdapter:
    """自动化任务适配器。"""

    @staticmethod
    def create_sub2api_client():
        """创建 Sub2API 客户端。"""
        from services.sub2api_client import Sub2APIClient

        return Sub2APIClient()

    @staticmethod
    def create_batch_processor(concurrency: int, callback: Callable[[str], None] | None = None):
        """创建批处理器实例。"""
        from automation.batch_account_processor import BatchAccountProcessor

        return BatchAccountProcessor(concurrency=concurrency, callback=callback)

    @staticmethod
    async def run_account_worker_task(
        task_type: str,
        processor,
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
        auto_bind_proxy: bool,
        sms_token: str | None,
        country_id: int | None,
        project_id: int | None,
        max_retries: int | None,
    ) -> dict:
        """执行账号批处理任务。"""
        if task_type == "login":
            result = await processor.batch_login(
                accounts=list(accounts),
                browser_ids=list(browser_ids),
            )
            return {"type": "login", "result": result.to_dict()}

        if task_type == "oauth":
            async with AutomationEngineAdapter.create_sub2api_client() as client:
                result = await processor.batch_oauth(
                    accounts=list(accounts),
                    browser_ids=list(browser_ids),
                    sub2api_client=client,
                    auto_bind_proxy=auto_bind_proxy,
                )
            return {"type": "oauth", "result": result.to_dict()}

        if task_type == "login_and_oauth":
            async with AutomationEngineAdapter.create_sub2api_client() as client:
                results = await processor.batch_login_and_oauth(
                    accounts=list(accounts),
                    browser_ids=list(browser_ids),
                    sub2api_client=client,
                    auto_bind_proxy=auto_bind_proxy,
                )
            return {
                "type": "login_and_oauth",
                "login_result": results["login"].to_dict(),
                "oauth_result": results["oauth"].to_dict(),
            }

        if task_type == "unlock_403":
            result = await processor.batch_unlock_403(
                accounts=list(accounts),
                browser_ids=list(browser_ids),
                sms_token=sms_token,
                country_id=country_id,
                project_id=project_id,
                max_retries=max_retries,
            )
            return {"type": "unlock_403", "result": result.to_dict()}

        if task_type == "detect_pro":
            result = await processor.batch_detect_pro(
                accounts=list(accounts),
                browser_ids=list(browser_ids),
            )
            return {"type": "detect_pro", "result": result.to_dict()}

        return {"type": "unknown"}

    @staticmethod
    async def run_join_family(
        inviter_account: dict,
        invitee_account: dict,
        inviter_browser_id: str,
        invitee_browser_id: str,
        callback: Callable[[str], None],
        close_browser_on_success: bool = False,
    ):
        """执行加入家庭组自动化。"""
        from automation.auto_join_family import auto_join_family

        return await auto_join_family(
            inviter_account=inviter_account,
            invitee_account=invitee_account,
            inviter_browser_id=inviter_browser_id,
            invitee_browser_id=invitee_browser_id,
            callback=callback,
            close_browser_on_success=close_browser_on_success,
        )

    @staticmethod
    def is_family_full_error(message: str) -> bool:
        """判断是否为家庭组已满错误。"""
        from automation.auto_join_family import _is_family_full_error

        return _is_family_full_error(message)

    @staticmethod
    async def run_enable_family_sharing(
        account: dict,
        browser_id: str,
        callback: Callable[[str], None],
        close_browser_on_success: bool = False,
    ):
        """执行开启家庭共享自动化。"""
        from automation.auto_enable_family_sharing import auto_enable_family_sharing

        return await auto_enable_family_sharing(
            account=account,
            browser_id=browser_id,
            callback=callback,
            close_browser_on_success=close_browser_on_success,
        )

