"""账号任务编排执行器。

Why:
- 将账号管理界面中的异步循环编排从 GUI 层下沉到 application 层。
- GUI 仅保留线程启动、进度展示与结果渲染。
"""

from __future__ import annotations

import asyncio
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
