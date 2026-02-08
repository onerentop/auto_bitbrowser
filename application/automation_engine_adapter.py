"""自动化引擎统一适配层。

Why:
- 统一 application 层对 automation/services 外部模块的调用入口。
- 降低 orchestrator 对底层模块路径与实现细节的直接依赖。
"""

from __future__ import annotations

from typing import Callable, Sequence


class AutomationEngineAdapter:
    """自动化任务适配器。"""

    _bind_card_cursor: int = 0

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

    @staticmethod
    async def run_bind_card(
        profile_id: str,
        account_info: dict,
        cards: Sequence[dict],
        config: dict | None = None,
    ) -> dict:
        """执行 AI 绑卡自动化。"""
        from automation.auto_bind_card_ai import auto_bind_card_ai

        config = config or {}
        cards_list = list(cards)
        if not cards_list:
            return {"success": False, "message": "无可用卡片"}

        rotate_card = bool(config.get("rotate_card", True))
        if rotate_card:
            index = AutomationEngineAdapter._bind_card_cursor % len(cards_list)
            AutomationEngineAdapter._bind_card_cursor += 1
            card_info = cards_list[index]
        else:
            card_info = cards_list[0]

        success, message = await auto_bind_card_ai(
            browser_id=str(profile_id),
            account_info=account_info,
            card_info=card_info,
            close_after=bool(config.get("close_after", False)),
            max_steps=int(config.get("max_steps", 40)),
            api_key=config.get("api_key"),
            base_url=config.get("base_url"),
            model=config.get("model"),
            provider=config.get("provider"),
        )

        return {
            "success": bool(success),
            "message": message,
        }

    @staticmethod
    async def run_kick_devices(profile_id: str, account_info: dict) -> dict:
        """执行踢出设备自动化。"""
        from automation.auto_kick_devices import auto_kick_devices

        success, message, kicked_count = await auto_kick_devices(
            browser_id=str(profile_id),
            account_info=account_info,
        )

        return {
            "success": bool(success),
            "message": message,
            "kicked_count": int(kicked_count),
        }

    @staticmethod
    async def run_modify_2sv_phone(
        profile_id: str,
        account_info: dict,
        new_phone: str,
    ) -> dict:
        """执行修改 2SV 手机自动化。"""
        from automation.auto_modify_2sv_phone import auto_modify_2sv_phone

        success, message = await auto_modify_2sv_phone(
            browser_id=str(profile_id),
            account_info=account_info,
            new_phone=new_phone,
        )

        return {
            "success": bool(success),
            "message": message,
        }

    @staticmethod
    async def run_modify_authenticator(profile_id: str, account_info: dict) -> dict:
        """执行修改身份验证器自动化。"""
        from automation.auto_modify_authenticator import auto_modify_authenticator

        success, message, new_secret = await auto_modify_authenticator(
            browser_id=str(profile_id),
            account_info=account_info,
        )

        return {
            "success": bool(success),
            "message": message,
            "totp_secret": new_secret,
        }

    @staticmethod
    async def run_replace_email(
        profile_id: str,
        account_info: dict,
        new_email: str,
    ) -> dict:
        """执行替换辅助邮箱自动化。"""
        from automation.auto_replace_recovery_email import auto_replace_recovery_email

        success, message, error_type = await auto_replace_recovery_email(
            browser_id=str(profile_id),
            account_info=account_info,
            new_email=new_email,
        )

        return {
            "success": bool(success),
            "message": message,
            "error_type": error_type,
        }

    @staticmethod
    async def run_replace_recovery_phone(
        browser_id: str,
        account_info: dict,
        new_phone: str,
        close_after: bool,
    ) -> tuple[bool, str]:
        """执行替换辅助手机号自动化。"""
        from automation.auto_replace_recovery_phone import auto_replace_recovery_phone

        return await auto_replace_recovery_phone(
            browser_id=browser_id,
            account_info=account_info,
            new_phone=new_phone,
            close_after=close_after,
        )

    @staticmethod
    async def run_get_sheerlink(
        browser_id: str,
        account_info: dict,
        close_after: bool,
        api_key: str,
        base_url: str | None,
        model: str | None,
        provider: str,
        max_steps: int = 20,
        save_to_file: bool = True,
    ) -> tuple[bool, str, str, str]:
        """执行获取 SheerLink 自动化。"""
        from automation.auto_get_sheerlink_ai import auto_get_sheerlink_ai

        return await auto_get_sheerlink_ai(
            browser_id=browser_id,
            account_info=account_info,
            close_after=close_after,
            max_steps=max_steps,
            api_key=api_key,
            base_url=base_url,
            model=model,
            provider=provider,
            save_to_file=save_to_file,
        )
