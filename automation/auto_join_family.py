"""
自动加入家庭组

使用 StagehandGoogleEngine 自动完成家庭组加入流程：
1. 在普通 Pro 账户窗口发送家庭邀请
2. 在被邀请账户窗口接受邀请（通过 Gmail）
3. 更新数据库状态

技术栈：StagehandGoogleEngine (统一的 AI 浏览器自动化引擎)
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from services.database import DBManager
from services.ix_api import closeBrowser
from services.invite_lock import invite_lock_manager

# 导入 StagehandGoogleEngine
try:
    from core.stagehand_engine import StagehandGoogleEngine
    from core.stagehand_engine.constants import GoogleURLs
    STAGEHAND_ENGINE_AVAILABLE = True
except ImportError:
    STAGEHAND_ENGINE_AVAILABLE = False
    StagehandGoogleEngine = None
    GoogleURLs = None


@dataclass
class JoinFamilyResult:
    """加入家庭组结果"""
    success: bool
    message: str
    inviter_email: str
    invitee_email: str
    error_type: Optional[str] = None
    total_steps: int = 0


# ==================== 家庭组已满检测关键词 ====================

FAMILY_FULL_KEYWORDS = [
    # 英文
    "family group is full", "family is full", "group is full",
    "can't add more", "cannot add more", "maximum number",
    "6 members", "six members", "limit reached", "no more members",
    # 中文
    "家庭组已满", "已达上限", "无法添加更多", "成员已满", "6位成员",
    "家庭群组已满", "无法添加成员",
    # Agent 报告格式
    "family_full",
]


def _is_family_full_error(error_msg: str) -> bool:
    """检测错误消息是否表示家庭组已满"""
    if not error_msg:
        return False
    error_lower = error_msg.lower()
    return any(keyword.lower() in error_lower for keyword in FAMILY_FULL_KEYWORDS)


async def auto_join_family(
    inviter_account: dict,
    invitee_account: dict,
    inviter_browser_id: str,
    invitee_browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,  # 已废弃，从 ConfigManager 读取
    model: str = None,  # 已废弃
    provider: str = None,  # 已废弃
    max_steps: int = None,  # 已废弃
    close_browser_on_success: bool = True,
) -> JoinFamilyResult:
    """
    执行家庭组加入流程

    使用 StagehandGoogleEngine 执行家庭组邀请和接受操作。

    流程：
    1. 邀请人发送家庭邀请
    2. 被邀请人通过 Gmail 接受邀请
    3. 更新数据库状态

    Args:
        inviter_account: 邀请人账号（普通 Pro）
        invitee_account: 被邀请人账号（待加入）
        inviter_browser_id: 邀请人的浏览器窗口 ID
        invitee_browser_id: 被邀请人的浏览器窗口 ID
        callback: 进度回调函数
        api_key: 已废弃
        model: 已废弃
        provider: 已废弃
        max_steps: 已废弃
        close_browser_on_success: 成功后是否关闭浏览器窗口

    Returns:
        JoinFamilyResult: 加入结果
    """
    inviter_email = inviter_account.get("email", "")
    invitee_email = invitee_account.get("email", "")

    def log(msg: str):
        """日志输出"""
        print(f"[JoinFamily] {msg}")
        if callback:
            callback(msg)

    log(f"开始家庭组加入流程: {invitee_email} -> {inviter_email} 的家庭组")

    # ========== 前置检查：被邀请人是否已在家庭组 ==========
    invitee_db = DBManager.get_account_by_email(invitee_email)
    if invitee_db:
        invitee_pro_status = invitee_db.get("pro_status", "")
        if invitee_pro_status == "family_yes":
            log(f"⚠️ 被邀请人 {invitee_email} 已在家庭组中（pro_status=family_yes），跳过邀请")
            return JoinFamilyResult(
                success=False,
                message="被邀请人已在家庭组中",
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="already_in_family",
            )

    # ========== 前置检查：尝试获取邀请锁（防止重复邀请）==========
    if not invite_lock_manager.try_lock(invitee_email):
        log(f"⚠️ {invitee_email} 正在被其他任务邀请，跳过")
        return JoinFamilyResult(
            success=False,
            message="该账户正在被其他任务处理",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="concurrent_operation",
        )

    # 检查 StagehandGoogleEngine 是否可用
    if not STAGEHAND_ENGINE_AVAILABLE:
        invite_lock_manager.unlock(invitee_email)
        log("❌ StagehandGoogleEngine 不可用")
        return JoinFamilyResult(
            success=False,
            message="StagehandGoogleEngine 不可用",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="stagehand_unavailable",
        )

    inviter_engine = None
    invitee_engine = None
    total_steps = 0

    try:
        # ==================== Step 1: 邀请人发送邀请 ====================
        log("=" * 50)
        log(f"Step 1: 在 {inviter_email} 窗口发送邀请...")
        log("=" * 50)

        # 连接到邀请人的浏览器
        inviter_engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=inviter_browser_id,
            use_config=True,
            close_browser_on_exit=False,
        )

        log(f"[{inviter_email}] 已连接到 ixBrowser")

        # 首先检查是否需要创建家庭组
        log(f"[{inviter_email}] 检查家庭组状态...")

        # 导航到家庭邀请页面
        await inviter_engine.navigate(GoogleURLs.FAMILY_INVITE_MEMBERS)
        await inviter_engine.wait(2000)

        # 使用 AI 检测页面状态
        page_content = await inviter_engine.get_page_content()
        page_lower = page_content.lower()

        # 检测是否需要先创建家庭组
        needs_create_family = any(kw in page_lower for kw in [
            "get started", "开始使用", "create a family", "创建家庭",
            "start a family", "开始使用家庭",
        ])

        if needs_create_family:
            log(f"[{inviter_email}] 需要先创建家庭组...")

            # 使用 enable_family_sharing 方法创建家庭组
            sharing_result = await inviter_engine.enable_family_sharing()

            if sharing_result.success:
                log(f"[{inviter_email}] ✅ 家庭组创建成功")
                if sharing_result.family_created:
                    DBManager.update_family_member_count(inviter_email, 1)
            else:
                error_msg = sharing_result.error or sharing_result.message or "创建家庭组失败"
                log(f"[{inviter_email}] ❌ {error_msg}")
                return JoinFamilyResult(
                    success=False,
                    message=f"创建家庭组失败: {error_msg}",
                    inviter_email=inviter_email,
                    invitee_email=invitee_email,
                    error_type="create_family_failed",
                    total_steps=total_steps,
                )

            # 重新导航到邀请页面
            await inviter_engine.navigate(GoogleURLs.FAMILY_INVITE_MEMBERS)
            await inviter_engine.wait(2000)

        # 检测家庭组是否已满
        page_content = await inviter_engine.get_page_content()
        if _is_family_full_error(page_content):
            log(f"[{inviter_email}] ⚠️ 家庭组已满")
            DBManager.update_family_member_count(inviter_email, 6)
            return JoinFamilyResult(
                success=False,
                message="家庭组已满",
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="family_full",
                total_steps=total_steps,
            )

        # 发送邀请（Stagehand Agent 模式）
        log(f"[{inviter_email}] 使用 Agent 模式发送家庭邀请...")
        agent_result = await inviter_engine.agent_execute(
            instruction=(
                f"在当前家庭邀请页面，将邮箱 {invitee_email} 添加到邀请输入框中，"
                "如果出现候选项请选择正确邮箱，然后点击 Send/发送 完成邀请。"
                "若页面显示家庭组已满、无法继续邀请，请停止并返回失败信息。"
            ),
            max_steps=20,
            mode="dom",
        )

        if not agent_result.success:
            # 兼容兜底：当 Agent 执行失败时回退到旧 act 模式，避免流程中断
            log(f"[{inviter_email}] Agent 发送失败，回退到 act 模式: {agent_result.error}")
            log(f"[{inviter_email}] 输入被邀请人邮箱: {invitee_email}")
            await inviter_engine.act(f"在邮箱输入框中输入 '{invitee_email}'")
            await inviter_engine.wait(1000)

            await inviter_engine.act("按下方向键选择邮箱建议，然后按回车确认")
            await inviter_engine.wait(1000)

            log(f"[{inviter_email}] 点击发送邀请按钮...")
            await inviter_engine.act("点击 'Send' 或 '发送' 按钮")

        await inviter_engine.wait(3000)
        total_steps += 1

        # 验证邀请是否发送成功
        page_content = await inviter_engine.get_page_content()
        page_lower = page_content.lower()

        if _is_family_full_error(page_content):
            log(f"[{inviter_email}] ⚠️ 邀请失败：家庭组已满")
            DBManager.update_family_member_count(inviter_email, 6)
            return JoinFamilyResult(
                success=False,
                message="家庭组已满",
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="family_full",
                total_steps=total_steps,
            )

        if any(kw in page_lower for kw in ["sent", "发送成功", "invitation sent", "邀请已发送"]):
            log(f"[{inviter_email}] ✅ 邀请发送成功")
        else:
            log(f"[{inviter_email}] ⚠️ 邀请状态不确定，继续尝试...")

        # 关闭邀请人引擎
        await inviter_engine.stop(close_browser=False)
        inviter_engine = None

        log("✅ 邀请发送成功，等待邮件送达...")
        await asyncio.sleep(5)

        # ==================== Step 2: 被邀请人接受邀请 ====================
        log("=" * 50)
        log(f"Step 2: 在 {invitee_email} 窗口接受邀请...")
        log("=" * 50)

        # 连接到被邀请人的浏览器
        invitee_engine = await StagehandGoogleEngine.connect_to_ixbrowser(
            browser_id=invitee_browser_id,
            use_config=True,
            close_browser_on_exit=False,
        )

        log(f"[{invitee_email}] 已连接到 ixBrowser")

        # 使用 join_family 方法接受邀请
        join_result = await invitee_engine.join_family(
            inviter_email=inviter_email,
        )

        total_steps += 1

        if not join_result.success:
            error_msg = join_result.error or join_result.message or "接受邀请失败"
            log(f"[{invitee_email}] ❌ {error_msg}")

            if _is_family_full_error(error_msg):
                DBManager.update_family_member_count(inviter_email, 6)

            if join_result.already_in_family:
                DBManager.update_pro_status(invitee_email, "family_yes")

            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="accept_failed",
                total_steps=total_steps,
            )

        log(f"[{invitee_email}] ✅ 成功接受邀请!")

        # ==================== Step 3: 更新数据库 ====================
        log("更新数据库状态...")

        DBManager.update_pro_status(invitee_email, "family_yes")

        inviter_db = DBManager.get_account_by_email(inviter_email)
        if inviter_db:
            raw_count = inviter_db.get("family_member_count", 0) or 0
            current_count = max(raw_count, 1)
            new_count = min(current_count + 1, 6)
            DBManager.update_family_member_count(inviter_email, new_count)
            log(f"邀请人 {inviter_email} 家庭成员数量: {current_count} -> {new_count}")

        # 关闭浏览器窗口
        if close_browser_on_success:
            try:
                closeBrowser(inviter_browser_id)
                log(f"已关闭邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭邀请人窗口失败: {e}")

            try:
                closeBrowser(invitee_browser_id)
                log(f"已关闭被邀请人浏览器窗口")
            except Exception as e:
                log(f"关闭被邀请人窗口失败: {e}")

        log(f"✅ 家庭组加入完成! {invitee_email} 已加入 {inviter_email} 的家庭组")

        return JoinFamilyResult(
            success=True,
            message="成功加入家庭组",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            total_steps=total_steps,
        )

    except Exception as e:
        error_msg = str(e)
        log(f"❌ 异常: {error_msg}")
        return JoinFamilyResult(
            success=False,
            message=f"加入家庭组异常: {error_msg}",
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            error_type="exception",
            total_steps=total_steps,
        )

    finally:
        # ========== 释放邀请锁 ==========
        invite_lock_manager.unlock(invitee_email)

        # 确保清理引擎资源
        if inviter_engine and inviter_engine.is_initialized:
            try:
                await inviter_engine.stop(close_browser=False)
            except Exception:
                pass

        if invitee_engine and invitee_engine.is_initialized:
            try:
                await invitee_engine.stop(close_browser=False)
            except Exception:
                pass


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("家庭组加入测试 (StagehandGoogleEngine)")
        print("=" * 50)

        # 测试账号（需要替换为真实账号）
        inviter_account = {
            "email": "pro_account@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        invitee_account = {
            "email": "family_pro@gmail.com",
            "password": "password",
            "secret_key": "",
        }

        # 测试浏览器 ID（需要替换为真实 ID）
        inviter_browser_id = "12345"
        invitee_browser_id = "67890"

        result = await auto_join_family(
            inviter_account=inviter_account,
            invitee_account=invitee_account,
            inviter_browser_id=inviter_browser_id,
            invitee_browser_id=invitee_browser_id,
            callback=print,
        )

        print(f"\n结果: {result}")

    asyncio.run(main())
