"""账号任务编排执行器。

Why:
- 将账号管理界面中的异步循环编排从 GUI 层下沉到 application 层。
- GUI 仅保留线程启动、进度展示与结果渲染。
"""

from __future__ import annotations

import asyncio
import re
from typing import Callable, Sequence


class AccountTaskOrchestrator:
    """账号任务编排执行器。"""

    @staticmethod
    def create_batch_bind_results(total: int) -> dict:
        """创建批量绑定任务结果骨架。"""
        return {
            "total": total,
            "success_count": 0,
            "failed_count": 0,
            "failed_list": [],
        }

    @staticmethod
    def create_batch_delete_results(total: int) -> dict:
        """创建批量删除任务结果骨架。"""
        return {
            "total": total,
            "deleted_accounts": 0,
            "deleted_windows": 0,
            "failed_count": 0,
            "failed_list": [],
        }

    @staticmethod
    def create_batch_join_results(total: int) -> dict:
        """创建批量加入家庭组任务结果骨架。"""
        return {
            "total": total,
            "success_count": 0,
            "failed_count": 0,
            "failed_list": [],
            "pro_usage": {},
        }

    @staticmethod
    def create_enable_family_sharing_results(total: int) -> dict:
        """创建开启家庭共享任务结果骨架。"""
        return {
            "total": total,
            "success_count": 0,
            "already_enabled_count": 0,
            "family_created_count": 0,
            "failed_count": 0,
            "failed_list": [],
        }

    @staticmethod
    def create_detect_403_results(total: int) -> dict:
        """创建批量 403 检测任务结果骨架。"""
        return {
            "total": total,
            "needs_unlock": 0,
            "accounts": [],
        }

    @staticmethod
    def create_stopped_result(task_type: str) -> dict:
        """创建统一的停止任务结果。"""
        return {
            "type": "stopped",
            "task_type": task_type,
            "message": "用户停止任务",
        }

    @staticmethod
    def execute_batch_join_family(
        assignments: Sequence[tuple[dict, dict]],
        should_stop: Callable[[], bool],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int], None],
    ) -> dict:
        """执行批量加入家庭组任务。"""
        from automation.auto_join_family import auto_join_family, _is_family_full_error

        results = AccountTaskOrchestrator.create_batch_join_results(len(assignments))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            full_pro_accounts: set[str] = set()

            for index, (invitee, pro_account) in enumerate(assignments):
                if should_stop():
                    log_callback("用户停止任务")
                    break

                invitee_email = invitee.get("email", "")
                pro_email = pro_account.get("email", "")
                invitee_browser_id = invitee.get("browser_profile_id", "")
                pro_browser_id = pro_account.get("browser_profile_id", "")

                if pro_email in full_pro_accounts:
                    log_callback(
                        f"[{index+1}/{len(assignments)}] ⏭️ 跳过 {invitee_email}，{pro_email} 家庭组已满"
                    )
                    results["failed_count"] += 1
                    results["failed_list"].append(
                        {
                            "email": invitee_email,
                            "error": f"Pro账户 {pro_email} 家庭组已满",
                        }
                    )
                    progress_callback(index + 1)
                    continue

                log_callback(f"[{index+1}/{len(assignments)}] {invitee_email} -> {pro_email}")

                try:
                    task_result = loop.run_until_complete(
                        auto_join_family(
                            inviter_account=pro_account,
                            invitee_account=invitee,
                            inviter_browser_id=pro_browser_id,
                            invitee_browser_id=invitee_browser_id,
                            callback=log_callback,
                            close_browser_on_success=False,
                        )
                    )

                    if task_result.success:
                        results["success_count"] += 1
                        results["pro_usage"][pro_email] = results["pro_usage"].get(pro_email, 0) + 1
                        log_callback(f"{invitee_email} 成功加入 {pro_email} 的家庭组")
                    else:
                        results["failed_count"] += 1
                        results["failed_list"].append(
                            {
                                "email": invitee_email,
                                "error": task_result.message or "未知错误",
                            }
                        )
                        log_callback(f"{invitee_email} 加入失败: {task_result.message}")

                        if _is_family_full_error(task_result.message or ""):
                            full_pro_accounts.add(pro_email)
                            log_callback(f"⚠️ {pro_email} 家庭组已满，后续分配将跳过")

                except Exception as error:
                    results["failed_count"] += 1
                    results["failed_list"].append({"email": invitee_email, "error": str(error)})
                    log_callback(f"{invitee_email} 异常: {error}")

                    if _is_family_full_error(str(error)):
                        full_pro_accounts.add(pro_email)
                        log_callback(f"⚠️ {pro_email} 家庭组已满，后续分配将跳过")

                progress_callback(index + 1)

        finally:
            loop.close()

        return results

    @staticmethod
    def execute_enable_family_sharing(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
        should_stop: Callable[[], bool],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int], None],
    ) -> dict:
        """执行批量开启家庭共享任务。"""
        from automation.auto_enable_family_sharing import auto_enable_family_sharing

        results = AccountTaskOrchestrator.create_enable_family_sharing_results(len(accounts))
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            total = len(accounts)
            for index, (account, browser_id) in enumerate(zip(accounts, browser_ids)):
                if should_stop():
                    log_callback("用户停止任务")
                    break

                email = account.get("email", "")
                log_callback(f"[{index+1}/{total}] 开启共享: {email}")

                try:
                    task_result = loop.run_until_complete(
                        auto_enable_family_sharing(
                            account=account,
                            browser_id=browser_id,
                            callback=log_callback,
                            close_browser_on_success=False,
                        )
                    )

                    if task_result.success:
                        if task_result.was_already_enabled:
                            results["already_enabled_count"] += 1
                            log_callback(f"✅ {email} 已开启共享（跳过）")
                        else:
                            results["success_count"] += 1
                            if task_result.family_created:
                                results["family_created_count"] += 1
                                log_callback(f"✅ {email} 成功创建家庭组并开启共享")
                            else:
                                log_callback(f"✅ {email} 成功开启家庭共享")
                    else:
                        results["failed_count"] += 1
                        results["failed_list"].append(
                            {"email": email, "error": task_result.message or "未知错误"}
                        )
                        log_callback(f"❌ {email} 开启失败: {task_result.message}")

                except Exception as error:
                    results["failed_count"] += 1
                    results["failed_list"].append({"email": email, "error": str(error)})
                    log_callback(f"❌ {email} 异常: {error}")

                progress_callback(index + 1)

        finally:
            loop.close()

        return results

    @staticmethod
    def execute_batch_bind(
        matched_pairs: Sequence[tuple[str, str]],
        should_stop: Callable[[], bool],
        bind_account_callback: Callable[[str, str], None],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int], None],
    ) -> dict:
        """执行批量绑定窗口任务。"""
        results = AccountTaskOrchestrator.create_batch_bind_results(len(matched_pairs))

        for index, (email, browser_id) in enumerate(matched_pairs):
            if should_stop():
                log_callback("用户停止任务")
                break

            try:
                bind_account_callback(email, browser_id)
                results["success_count"] += 1
                log_callback(f"绑定: {email} -> {browser_id}")
            except Exception as error:
                results["failed_count"] += 1
                results["failed_list"].append({"email": email, "error": str(error)})
                log_callback(f"绑定失败: {email} - {error}")

            progress_callback(index + 1)

        return results

    @staticmethod
    def execute_batch_delete(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
        with_windows: bool,
        should_stop: Callable[[], bool],
        delete_account_callback: Callable[[str], None],
        close_browser_callback: Callable[[str], None],
        delete_browser_callback: Callable[[str], dict],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int], None],
    ) -> dict:
        """执行批量删除账号任务。"""
        total = len(accounts)
        results = AccountTaskOrchestrator.create_batch_delete_results(total)

        for index, account in enumerate(accounts):
            if should_stop():
                log_callback("用户停止任务")
                break

            email = account.get("email", "")
            browser_id = browser_ids[index] if index < len(browser_ids) else ""

            try:
                if with_windows and browser_id:
                    try:
                        close_browser_callback(browser_id)
                    except Exception:
                        pass

                    try:
                        delete_result = delete_browser_callback(browser_id)
                        if isinstance(delete_result, dict) and delete_result.get("success"):
                            results["deleted_windows"] += 1
                    except Exception:
                        pass

                delete_account_callback(email)
                results["deleted_accounts"] += 1
                log_callback(f"已删除: {email}")
            except Exception as error:
                results["failed_count"] += 1
                results["failed_list"].append({"email": email, "error": str(error)})
                log_callback(f"删除 {email} 失败: {error}")

            progress_callback(index + 1)

        return results

    @staticmethod
    def execute_detect_403(
        accounts: Sequence[dict],
        should_stop: Callable[[], bool],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int], None],
    ) -> dict:
        """执行批量 403 检测任务。"""
        from services.database import DBManager
        from services.sub2api_client import Sub2APIClient

        async def _run_async() -> dict:
            async with Sub2APIClient() as client:
                accounts_to_check = [
                    account for account in accounts
                    if account.get("sub2api_status") == "linked"
                ]

                if not accounts_to_check:
                    return AccountTaskOrchestrator.create_detect_403_results(0)

                total = len(accounts_to_check)
                needs_unlock_accounts: list[str] = []

                for index, account in enumerate(accounts_to_check):
                    if should_stop():
                        log_callback("用户停止任务")
                        break

                    email = account.get("email", "")
                    account_id = account.get("sub2api_account_id")

                    if not account_id:
                        log_callback(f"[{email}] 缺少 account_id，正在查询...")
                        account_id = await client.check_account_exists(email)
                        if account_id:
                            DBManager.update_sub2api_status(email, "linked", account_id=account_id)
                            log_callback(f"[{email}] 已获取 account_id: {account_id}")
                        else:
                            log_callback(f"[{email}] 在 Sub2API 中未找到，修正状态为未关联")
                            DBManager.update_sub2api_status(email, "not_linked")
                            progress_callback(index + 1)
                            continue

                    log_callback(f"[{email}] 检测中...")
                    response = await client.test_account_connection(account_id)

                    if not response.success:
                        response_data = response.data or {}
                        if response_data.get("needs_unlock"):
                            validation_url = response_data.get("validation_url", "")
                            DBManager.update_unlock_status(email, "needs_unlock", validation_url)
                            needs_unlock_accounts.append(email)
                            log_callback(f"[{email}] 需要解锁")
                        else:
                            log_callback(f"[{email}] 检测失败: {response.error}")
                    else:
                        log_callback(f"[{email}] 正常")

                    progress_callback(index + 1)

                return {
                    "total": total,
                    "needs_unlock": len(needs_unlock_accounts),
                    "accounts": needs_unlock_accounts,
                }

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            return loop.run_until_complete(_run_async())
        finally:
            loop.close()

    @staticmethod
    def execute_account_worker_task(
        task_type: str,
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
        concurrency: int,
        sms_token: str | None,
        country_id: int | None,
        project_id: int | None,
        max_retries: int | None,
        auto_bind_proxy: bool,
        should_stop: Callable[[], bool],
        log_callback: Callable[[str], None],
        progress_callback: Callable[[int, int], None],
    ) -> dict:
        """执行账号批处理线程任务（登录/OAuth/解锁/Pro检测）。"""
        from automation.batch_account_processor import BatchAccountProcessor
        from services.sub2api_client import Sub2APIClient

        total = len(accounts)
        completed_count = 0
        processor = BatchAccountProcessor(concurrency=concurrency)
        stop_logged = False

        def processor_progress(message: str):
            nonlocal completed_count, stop_logged

            log_callback(message)

            if should_stop():
                processor.stop()
                if not stop_logged:
                    stop_logged = True
                    log_callback("用户停止任务")

            if any(keyword in message for keyword in ["✓", "✗", "成功", "失败", "跳过", "完成:"]):
                match = re.search(r"\[(\d+)/(\d+)\]", message)
                if match:
                    current = int(match.group(1))
                    progress_callback(current, total)
                else:
                    completed_count += 1
                    progress_callback(min(completed_count, total), total)

        processor.callback = processor_progress

        async def _run_async() -> dict:
            if should_stop():
                return AccountTaskOrchestrator.create_stopped_result(task_type)

            if task_type == "login":
                result = await processor.batch_login(
                    accounts=list(accounts),
                    browser_ids=list(browser_ids),
                )
                if should_stop():
                    return AccountTaskOrchestrator.create_stopped_result(task_type)
                return {"type": "login", "result": result.to_dict()}

            if task_type == "oauth":
                async with Sub2APIClient() as client:
                    result = await processor.batch_oauth(
                        accounts=list(accounts),
                        browser_ids=list(browser_ids),
                        sub2api_client=client,
                        auto_bind_proxy=auto_bind_proxy,
                    )
                if should_stop():
                    return AccountTaskOrchestrator.create_stopped_result(task_type)
                return {"type": "oauth", "result": result.to_dict()}

            if task_type == "login_and_oauth":
                async with Sub2APIClient() as client:
                    results = await processor.batch_login_and_oauth(
                        accounts=list(accounts),
                        browser_ids=list(browser_ids),
                        sub2api_client=client,
                        auto_bind_proxy=auto_bind_proxy,
                    )
                if should_stop():
                    return AccountTaskOrchestrator.create_stopped_result(task_type)
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
                if should_stop():
                    return AccountTaskOrchestrator.create_stopped_result(task_type)
                return {"type": "unlock_403", "result": result.to_dict()}

            if task_type == "detect_pro":
                result = await processor.batch_detect_pro(
                    accounts=list(accounts),
                    browser_ids=list(browser_ids),
                )
                if should_stop():
                    return AccountTaskOrchestrator.create_stopped_result(task_type)
                return {"type": "detect_pro", "result": result.to_dict()}

            return {"type": "unknown"}

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            return loop.run_until_complete(_run_async())
        finally:
            loop.close()

    @staticmethod
    def execute_single_join_family(
        inviter_account: dict,
        invitee_account: dict,
        inviter_browser_id: str,
        invitee_browser_id: str,
        log_callback: Callable[[str], None],
    ) -> dict:
        """执行单个加入家庭组任务。"""
        from automation.auto_join_family import auto_join_family

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        try:
            try:
                result = loop.run_until_complete(
                    auto_join_family(
                        inviter_account=inviter_account,
                        invitee_account=invitee_account,
                        inviter_browser_id=inviter_browser_id,
                        invitee_browser_id=invitee_browser_id,
                        callback=log_callback,
                    )
                )
            except Exception as error:
                return {
                    "success": False,
                    "message": str(error),
                }

            return {
                "success": bool(getattr(result, "success", False)),
                "message": getattr(result, "message", ""),
            }
        finally:
            loop.close()
