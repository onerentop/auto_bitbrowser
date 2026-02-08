"""账号管理应用服务

Why:
- 将账号选择后的数据查询与批量参数准备从 GUI 层下沉。
- 降低 `account_manager_interface` 中的重复逻辑，便于后续继续迁移。
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

from services.database import DBManager


class AccountManagerService:
    """账号管理应用服务"""

    @staticmethod
    def check_task_conflicts(
        *,
        worker_running: bool = False,
        batch_join_running: bool = False,
        enable_sharing_running: bool = False,
        batch_bind_running: bool = False,
        detect_403_running: bool = False,
        batch_delete_running: bool = False,
        wait_action: str = "",
    ) -> tuple[bool, str]:
        """统一检测任务冲突，避免界面层重复判断分支"""
        checks = [
            (batch_bind_running, "批量绑定任务正在执行中"),
            (batch_delete_running, "批量删除任务正在执行中"),
            (detect_403_running, "检测任务正在执行中"),
            (worker_running, "已有任务在执行中"),
            (batch_join_running, "批量加入家庭组任务正在执行中"),
            (enable_sharing_running, "开启共享任务正在执行中"),
        ]

        for running, message in checks:
            if not running:
                continue

            if wait_action:
                return False, f"{message}，请等待完成后再{wait_action}"
            return False, message

        return True, ""

    @staticmethod
    def resolve_selected_accounts(
        selected_rows: Sequence[Tuple[str, str]],
    ) -> tuple[List[dict], List[str]]:
        """根据选中行的邮箱与窗口ID，解析账号对象和浏览器ID列表"""
        accounts: List[dict] = []
        browser_ids: List[str] = []

        for email, browser_id in selected_rows:
            if not email:
                continue

            account = DBManager.get_account_by_email(email)
            if not account:
                continue

            accounts.append(account)
            browser_ids.append(browser_id if browser_id and browser_id != "-" else "")

        return accounts, browser_ids

    @staticmethod
    def collect_unbound_emails(selected_rows: Sequence[Tuple[str, str]]) -> List[str]:
        """收集未绑定窗口的选中账号邮箱"""
        unbound_emails: List[str] = []
        for email, browser_id in selected_rows:
            if not email:
                continue
            if not browser_id or browser_id == "-":
                unbound_emails.append(email)
        return unbound_emails

    @staticmethod
    def match_accounts_to_windows(
        target_emails: Sequence[str],
        windows: Sequence[dict],
    ) -> tuple[List[Tuple[str, str]], List[str], List[Tuple[str, str]]]:
        """
        按窗口名称匹配账号邮箱

        Returns:
            matched: 可绑定的 (email, browser_id)
            not_matched: 未找到匹配窗口的邮箱列表
            already_bound: 匹配到但窗口已被其他账号绑定的 (email, browser_id)
        """
        all_accounts = DBManager.get_all_accounts()
        bound_browser_ids = {
            account.get("browser_profile_id", "")
            for account in all_accounts
            if account.get("browser_profile_id")
        }

        window_map = {}
        for window in windows:
            name = window.get("name", "").strip().lower()
            profile_id = str(window.get("profile_id", ""))
            if name and profile_id:
                window_map[name] = profile_id

        matched: List[Tuple[str, str]] = []
        not_matched: List[str] = []
        already_bound: List[Tuple[str, str]] = []

        for email in target_emails:
            email_lower = email.strip().lower()
            if email_lower not in window_map:
                not_matched.append(email)
                continue

            browser_id = window_map[email_lower]
            if browser_id in bound_browser_ids:
                already_bound.append((email, browser_id))
            else:
                matched.append((email, browser_id))

        return matched, not_matched, already_bound

    @staticmethod
    def get_account_and_browser(email: str) -> tuple[dict | None, str]:
        """根据邮箱获取账号与绑定窗口ID"""
        account = DBManager.get_account_by_email(email)
        if not account:
            return None, ""

        browser_id = account.get("browser_profile_id", "") or ""
        return account, browser_id

    @staticmethod
    def collect_missing_browser_emails(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
    ) -> List[str]:
        """收集未绑定窗口的账号邮箱"""
        return [
            account.get("email", "")
            for account, browser_id in zip(accounts, browser_ids)
            if not browser_id
        ]

    @staticmethod
    def build_batch_delete_confirm_message(total: int, with_windows: bool) -> str:
        """构建批量删除确认文案"""
        if with_windows:
            return f"确定要删除选中的 {total} 个账号及其对应的浏览器窗口吗？\n\n⚠️ 此操作不可恢复！"
        return (
            f"确定要删除选中的 {total} 个账号吗？\n\n"
            "注意：仅删除账号记录，不会删除对应的浏览器窗口。"
        )

    @staticmethod
    def prepare_family_join_candidates(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
    ) -> tuple[List[dict], List[str], List[str], List[str], List[str]]:
        """筛选可加入家庭组的普通账号及跳过原因"""
        normal_accounts: List[dict] = []
        normal_browser_ids: List[str] = []
        skipped_already_pro: List[str] = []
        skipped_not_logged: List[str] = []
        skipped_no_browser: List[str] = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            is_pro = account.get("is_pro", "unknown")
            login_status = account.get("login_status", "")

            if is_pro in ("yes", "family_yes"):
                skipped_already_pro.append(email)
                continue

            if login_status != "logged_in":
                skipped_not_logged.append(email)
                continue

            if not browser_id:
                skipped_no_browser.append(email)
                continue

            normal_accounts.append(account)
            normal_browser_ids.append(browser_id)

        return (
            normal_accounts,
            normal_browser_ids,
            skipped_already_pro,
            skipped_not_logged,
            skipped_no_browser,
        )

    @staticmethod
    def build_no_family_candidates_message(
        skipped_already_pro: Sequence[str],
        skipped_not_logged: Sequence[str],
        skipped_no_browser: Sequence[str],
    ) -> str:
        """构建无可用普通账号时的提示文案"""
        message = "没有可加入家庭组的普通账户\n\n"
        if skipped_already_pro:
            message += f"⚠️ {len(skipped_already_pro)} 个已是 Pro 会员\n"
        if skipped_not_logged:
            message += f"⚠️ {len(skipped_not_logged)} 个未登录\n"
        if skipped_no_browser:
            message += f"⚠️ {len(skipped_no_browser)} 个未绑定窗口"
        return message

    @staticmethod
    def prepare_detect_pro_candidates(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
    ) -> tuple[List[dict], List[str], List[str], List[str]]:
        """筛选可进行 Pro 检测的账号"""
        valid_accounts: List[dict] = []
        valid_browser_ids: List[str] = []
        skipped_not_logged: List[str] = []
        skipped_no_browser: List[str] = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            login_status = account.get("login_status", "")

            if login_status != "logged_in":
                skipped_not_logged.append(email)
                continue

            if not browser_id:
                skipped_no_browser.append(email)
                continue

            valid_accounts.append(account)
            valid_browser_ids.append(browser_id)

        return valid_accounts, valid_browser_ids, skipped_not_logged, skipped_no_browser

    @staticmethod
    def build_no_detect_pro_candidates_message(
        skipped_not_logged: Sequence[str],
        skipped_no_browser: Sequence[str],
    ) -> str:
        """构建无可检测 Pro 账号时的提示文案"""
        message = "没有可检测的账号\n\n"
        if skipped_not_logged:
            message += f"❌ {len(skipped_not_logged)} 个未登录\n"
        if skipped_no_browser:
            message += f"❌ {len(skipped_no_browser)} 个未绑定窗口"
        return message

    @staticmethod
    def build_detect_pro_confirm_message(
        valid_count: int,
        skipped_not_logged_count: int,
        skipped_no_browser_count: int,
    ) -> str:
        """构建 Pro 检测确认文案"""
        message = f"将检测 {valid_count} 个已登录账号的 Pro 状态"
        if skipped_not_logged_count:
            message += f"\n\n⚠️ 跳过 {skipped_not_logged_count} 个未登录账号"
        if skipped_no_browser_count:
            message += f"\n⚠️ 跳过 {skipped_no_browser_count} 个未绑定窗口账号"
        return message

    @staticmethod
    def filter_linked_accounts_for_detect403(accounts: Sequence[dict]) -> List[dict]:
        """筛选可进行 403 检测的已关联账号"""
        return [account for account in accounts if account.get("sub2api_status") == "linked"]

    @staticmethod
    def build_no_linked_accounts_for_detect403_message(selected_total: int) -> str:
        """构建无已关联账号时的提示文案"""
        return (
            f"选中的 {selected_total} 个账号中没有已关联的账号\n\n"
            "只有 Sub2API 状态为「已关联」的账号才能检测 403"
        )

    @staticmethod
    def collect_unlock_targets_from_selected(
        selected_accounts: Sequence[dict],
        selected_browser_ids: Sequence[str],
    ) -> tuple[List[dict], List[str]]:
        """从选中账号中筛选需要解锁的目标"""
        accounts_to_unlock: List[dict] = []
        browser_ids: List[str] = []

        for account, browser_id in zip(selected_accounts, selected_browser_ids):
            unlock_status = account.get("unlock_status", "")
            if unlock_status in ("needs_unlock", "unlock_failed"):
                accounts_to_unlock.append(account)
                browser_ids.append(browser_id)

        return accounts_to_unlock, browser_ids

    @staticmethod
    def build_no_selected_unlock_targets_message() -> str:
        """构建选中账号中无解锁目标时的提示文案"""
        return (
            "选中的账号中没有需要解锁的\n\n"
            "请选择 unlock_status 为 needs_unlock 或 unlock_failed 的账号"
        )

    @staticmethod
    def build_unlock_all_confirm_message(total: int) -> str:
        """构建解锁全部账号的确认文案"""
        return (
            f"未选择账号，是否解锁全部 {total} 个需要解锁的账号？\n\n"
            "提示: 可以先勾选要解锁的账号再点击此按钮"
        )

    @staticmethod
    def collect_unlock_targets_from_all(accounts: Sequence[dict]) -> tuple[List[dict], List[str]]:
        """从全量需要解锁账号中提取目标及窗口ID"""
        accounts_to_unlock: List[dict] = []
        browser_ids: List[str] = []

        for account in accounts:
            browser_id = account.get("browser_profile_id", "")
            if browser_id:
                accounts_to_unlock.append(account)
                browser_ids.append(browser_id)

        return accounts_to_unlock, browser_ids

    @staticmethod
    def split_accounts_with_browser(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
    ) -> tuple[List[dict], List[str], List[str]]:
        """过滤出已绑定窗口的账号，同时返回未绑定邮箱列表"""
        accounts_with_browser: List[dict] = []
        valid_browser_ids: List[str] = []
        no_browser_emails: List[str] = []

        for account, browser_id in zip(accounts, browser_ids):
            if browser_id and browser_id != "-":
                accounts_with_browser.append(account)
                valid_browser_ids.append(browser_id)
                continue

            no_browser_emails.append(account.get("email", ""))

        return accounts_with_browser, valid_browser_ids, no_browser_emails

    @staticmethod
    def build_unlock_confirm_message(
        unlockable_count: int,
        no_browser_count: int,
        country_id: int | None,
        project_id: int | None,
    ) -> str:
        """构建批量解锁确认文案"""
        message = f"将解锁 {unlockable_count} 个账号"
        if no_browser_count:
            message += f"\n\n⚠️ {no_browser_count} 个账号未绑定窗口（已跳过）"
        message += f"\n\n国家ID: {country_id or '自动'} | 服务ID: {project_id or '自动'}"
        return message

    @staticmethod
    def get_available_pro_accounts() -> List[dict]:
        """获取可邀请的 Pro 账号"""
        return DBManager.get_available_pro_accounts()

    @staticmethod
    def prepare_enable_family_sharing_candidates(
        accounts: Sequence[dict],
        browser_ids: Sequence[str],
    ) -> tuple[List[dict], List[str], List[str], List[str], List[str]]:
        """筛选可开启家庭共享的普通 Pro 账户"""
        valid_accounts: List[dict] = []
        valid_browser_ids: List[str] = []
        skipped_not_pro: List[str] = []
        skipped_not_logged: List[str] = []
        skipped_no_browser: List[str] = []

        for account, browser_id in zip(accounts, browser_ids):
            email = account.get("email", "")
            is_pro = account.get("is_pro", "unknown")
            login_status = account.get("login_status", "")

            if is_pro != "yes":
                skipped_not_pro.append(email)
                continue

            if login_status != "logged_in":
                skipped_not_logged.append(email)
                continue

            if not browser_id:
                skipped_no_browser.append(email)
                continue

            valid_accounts.append(account)
            valid_browser_ids.append(browser_id)

        return (
            valid_accounts,
            valid_browser_ids,
            skipped_not_pro,
            skipped_not_logged,
            skipped_no_browser,
        )

    @staticmethod
    def build_no_enable_family_sharing_candidates_message(
        skipped_not_pro: Sequence[str],
        skipped_not_logged: Sequence[str],
        skipped_no_browser: Sequence[str],
    ) -> str:
        """构建无可开启共享账号时的提示文案"""
        message = "没有可开启共享的普通 Pro 账户\n\n"
        if skipped_not_pro:
            message += f"⚠️ {len(skipped_not_pro)} 个不是普通 Pro 账户\n"
        if skipped_not_logged:
            message += f"⚠️ {len(skipped_not_logged)} 个未登录\n"
        if skipped_no_browser:
            message += f"⚠️ {len(skipped_no_browser)} 个未绑定窗口"
        return message

    @staticmethod
    def build_enable_family_sharing_confirm_message(
        valid_count: int,
        skipped_not_pro_count: int,
        skipped_not_logged_count: int,
        skipped_no_browser_count: int,
    ) -> str:
        """构建开启家庭共享确认文案"""
        message = f"将为 {valid_count} 个普通 Pro 账户开启家庭共享"
        if skipped_not_pro_count:
            message += f"\n\n⚠️ 跳过 {skipped_not_pro_count} 个非普通 Pro 账户"
        if skipped_not_logged_count:
            message += f"\n⚠️ 跳过 {skipped_not_logged_count} 个未登录账户"
        if skipped_no_browser_count:
            message += f"\n⚠️ 跳过 {skipped_no_browser_count} 个未绑定窗口账户"
        return message

    @staticmethod
    def allocate_to_pro_accounts(invitees: Sequence[dict], pro_accounts: Sequence[dict]) -> tuple[list, int]:
        """将普通账户分配到 Pro 账户家庭组，返回分配结果和被锁跳过数"""
        from services.invite_lock import invite_lock_manager

        assignments = []
        pro_index = 0
        skipped_locked = []

        pro_slots = {
            account["email"]: 6 - max((account.get("family_member_count") or 0), 1)
            for account in pro_accounts
        }

        for invitee in invitees:
            invitee_email = invitee.get("email", "")

            if invite_lock_manager.is_locked(invitee_email):
                skipped_locked.append(invitee_email)
                continue

            while pro_index < len(pro_accounts):
                pro_email = pro_accounts[pro_index]["email"]
                if pro_slots[pro_email] > 0:
                    assignments.append((invitee, pro_accounts[pro_index]))
                    pro_slots[pro_email] -= 1
                    break

                pro_index += 1
            else:
                break

        return assignments, len(skipped_locked)

    @staticmethod
    def build_family_assignments_preview_message(
        assignments: Sequence[tuple],
        normal_accounts_count: int,
        skipped_locked_count: int,
        preview_limit: int = 10,
    ) -> str:
        """构建家庭组批量分配预览文案"""
        unassigned_count = normal_accounts_count - len(assignments) - skipped_locked_count
        if unassigned_count < 0:
            unassigned_count = 0

        message = f"即将分配 {len(assignments)} 个普通账户到家庭组\n\n"
        message += "分配预览:\n"

        for invitee, pro in list(assignments)[:preview_limit]:
            message += f"  • {invitee.get('email', '')} -> {pro.get('email', '')}\n"

        if len(assignments) > preview_limit:
            message += f"  ... 等 {len(assignments)} 个\n"

        if unassigned_count > 0:
            message += f"\n⚠️ {unassigned_count} 个账户因 Pro 名额不足未能分配\n"

        if skipped_locked_count > 0:
            message += f"⚠️ {skipped_locked_count} 个账户正在被其他任务处理，已跳过\n"

        return message
