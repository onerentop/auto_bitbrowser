"""
自动加入家庭组 (Stagehand observe+act 模式)

自动完成家庭组加入流程：
1. 在普通 Pro 账户窗口发送家庭邀请
2. 在被邀请账户窗口接受邀请（通过 Gmail）
3. 更新数据库状态

技术栈：Stagehand observe+act 模式（结构化操作，可调试）
"""

import asyncio
from typing import Callable, Optional
from dataclasses import dataclass

from services.database import DBManager
from services.ix_api import openBrowser, closeBrowser
from services.invite_lock import invite_lock_manager

# 导入共享的 Stagehand AI 配置函数
from automation.pro_status_detector import get_stagehand_config

# 尝试导入 Stagehand SDK
try:
    from stagehand import AsyncStagehand
    STAGEHAND_AVAILABLE = True
except ImportError:
    STAGEHAND_AVAILABLE = False
    AsyncStagehand = None


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


def _parse_agent_result(result_message: str, result_success: bool) -> dict:
    """
    解析 Agent 执行结果

    Agent 被要求在回复中包含特定关键词：
    - INVITE_SENT / JOIN_SUCCESS: 成功
    - FAMILY_FULL: 家庭组已满
    - NEEDS_CREATE_FAMILY: 需要先创建家庭组
    - ALREADY_IN_FAMILY: 被邀请人已在其他家庭组
    - ERROR: 其他错误
    """
    message_upper = (result_message or "").upper()

    # 成功状态
    if "INVITE_SENT" in message_upper:
        return {"success": True, "message": "邀请发送成功"}
    if "JOIN_SUCCESS" in message_upper:
        return {"success": True, "message": "成功加入家庭组"}

    # 错误状态
    if "FAMILY_FULL" in message_upper:
        return {"success": False, "message": "家庭组已满", "family_full": True}
    if "NEEDS_CREATE_FAMILY" in message_upper:
        return {"success": False, "message": "需要先创建家庭组", "needs_create_family": True}
    if "ALREADY_IN_FAMILY" in message_upper:
        return {"success": False, "message": "被邀请人已在其他家庭组", "already_in_family": True}

    # 兜底：使用 result.success（确保返回布尔值）
    return {
        "success": bool(result_success),
        "message": result_message or ("操作成功" if result_success else "操作失败"),
    }


async def auto_join_family(
    inviter_account: dict,
    invitee_account: dict,
    inviter_browser_id: str,
    invitee_browser_id: str,
    callback: Callable[[str], None] = None,
    api_key: str = None,  # 已废弃，从 get_stagehand_config() 获取
    model: str = None,  # 已废弃
    provider: str = None,  # 已废弃
    max_steps: int = None,  # 已废弃
    close_browser_on_success: bool = True,
) -> JoinFamilyResult:
    """
    执行家庭组加入流程 (Stagehand observe+act 模式)

    Args:
        inviter_account: 邀请人账号（普通 Pro）
        invitee_account: 被邀请人账号（待加入）
        inviter_browser_id: 邀请人的浏览器窗口 ID
        invitee_browser_id: 被邀请人的浏览器窗口 ID
        callback: 进度回调函数
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

    # 注意：后续所有代码都需要在 try-finally 中确保释放锁
    try:
        # 检查 Stagehand SDK 是否可用
        if not STAGEHAND_AVAILABLE:
            log("❌ Stagehand SDK 不可用")
            return JoinFamilyResult(
                success=False,
                message="Stagehand SDK 不可用，请安装 stagehand 包",
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="sdk_unavailable",
            )

        total_steps = 0

        # ==================== Step 1: 发送邀请 ====================
        log("=" * 50)
        log(f"Step 1: 在 {inviter_email} 窗口发送邀请...")
        log("=" * 50)

        invite_result = await _send_family_invite(
            browser_id=inviter_browser_id,
            inviter_email=inviter_email,
            invitee_email=invitee_email,
            log_func=log,
        )

        total_steps += invite_result.get("steps", 0)

        if not invite_result.get("success"):
            error_msg = invite_result.get("message", "发送邀请失败")
            log(f"❌ {error_msg}")

            # 检测是否需要先创建家庭组
            if invite_result.get("needs_create_family"):
                log(f"⚠️ 邀请人 {inviter_email} 尚未创建家庭组，开始创建...")

                # 导入并调用创建家庭组函数
                from automation.auto_enable_family_sharing import _create_family_via_stagehand

                # 获取 WebSocket 端点
                browser_result = openBrowser(inviter_browser_id)
                if browser_result.get("success"):
                    ws_endpoint = browser_result.get("data", {}).get("ws", "")
                    if ws_endpoint:
                        create_result = await _create_family_via_stagehand(
                            ws_endpoint=ws_endpoint,
                            email=inviter_email,
                            log=log,
                        )

                        if create_result.get("success"):
                            log(f"✅ 家庭组创建成功，重新尝试发送邀请...")
                            DBManager.update_family_member_count(inviter_email, 1)

                            # 重新发送邀请
                            invite_result = await _send_family_invite(
                                browser_id=inviter_browser_id,
                                inviter_email=inviter_email,
                                invitee_email=invitee_email,
                                log_func=log,
                            )
                            total_steps += invite_result.get("steps", 0)

                            if not invite_result.get("success"):
                                error_msg = invite_result.get("message", "重新发送邀请失败")
                                log(f"❌ 重新发送邀请失败: {error_msg}")

                                if _is_family_full_error(error_msg) or invite_result.get("family_full"):
                                    DBManager.update_family_member_count(inviter_email, 6)

                                return JoinFamilyResult(
                                    success=False,
                                    message=error_msg,
                                    inviter_email=inviter_email,
                                    invitee_email=invitee_email,
                                    error_type="invite_failed",
                                    total_steps=total_steps,
                                )
                        else:
                            create_error = create_result.get("message", "创建家庭组失败")
                            log(f"❌ 创建家庭组失败: {create_error}")
                            return JoinFamilyResult(
                                success=False,
                                message=f"创建家庭组失败: {create_error}",
                                inviter_email=inviter_email,
                                invitee_email=invitee_email,
                                error_type="create_family_failed",
                                total_steps=total_steps,
                            )
                    else:
                        return JoinFamilyResult(
                            success=False,
                            message="无法获取浏览器连接",
                            inviter_email=inviter_email,
                            invitee_email=invitee_email,
                            error_type="browser_error",
                            total_steps=total_steps,
                        )
                else:
                    return JoinFamilyResult(
                        success=False,
                        message="无法打开浏览器窗口",
                        inviter_email=inviter_email,
                        invitee_email=invitee_email,
                        error_type="browser_error",
                        total_steps=total_steps,
                    )

            # 检测家庭组已满
            elif _is_family_full_error(error_msg) or invite_result.get("family_full"):
                log(f"⚠️ 检测到家庭组已满，更新 {inviter_email} 的成员数量为 6")
                DBManager.update_family_member_count(inviter_email, 6)
                return JoinFamilyResult(
                    success=False,
                    message=error_msg,
                    inviter_email=inviter_email,
                    invitee_email=invitee_email,
                    error_type="family_full",
                    total_steps=total_steps,
                )
            else:
                return JoinFamilyResult(
                    success=False,
                    message=error_msg,
                    inviter_email=inviter_email,
                    invitee_email=invitee_email,
                    error_type="invite_failed",
                    total_steps=total_steps,
                )

        log("✅ 邀请发送成功，等待邮件送达...")
        await asyncio.sleep(5)

        # ==================== Step 2: 接受邀请 ====================
        log("=" * 50)
        log(f"Step 2: 在 {invitee_email} 窗口接受邀请...")
        log("=" * 50)

        accept_result = await _accept_family_invite(
            browser_id=invitee_browser_id,
            invitee_email=invitee_email,
            inviter_email=inviter_email,
            log_func=log,
        )

        total_steps += accept_result.get("steps", 0)

        if not accept_result.get("success"):
            error_msg = accept_result.get("message", "接受邀请失败")
            log(f"❌ {error_msg}")

            if _is_family_full_error(error_msg):
                log(f"⚠️ 检测到家庭组已满，更新 {inviter_email} 的成员数量为 6")
                DBManager.update_family_member_count(inviter_email, 6)

            if accept_result.get("already_in_family"):
                log(f"⚠️ 被邀请人已在其他家庭组，更新 {invitee_email} 的状态为 family_yes")
                DBManager.update_pro_status(invitee_email, "family_yes")
                return JoinFamilyResult(
                    success=False,
                    message=error_msg,
                    inviter_email=inviter_email,
                    invitee_email=invitee_email,
                    error_type="already_in_family",
                    total_steps=total_steps,
                )

            return JoinFamilyResult(
                success=False,
                message=error_msg,
                inviter_email=inviter_email,
                invitee_email=invitee_email,
                error_type="accept_failed",
                total_steps=total_steps,
            )

        log("✅ 成功接受邀请!")

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


# ==================== observe 指令模板 ====================

# 账号选择器检测
OBSERVE_ACCOUNT_SELECTOR = """
检查当前页面状态，查找以下任意元素：
1. "Choose an account" 或 "选择账号" 标题
2. 账号列表中包含 "@gmail.com" 或 "@google.com" 的邮箱条目
3. "Sign in" 或 "登录" 按钮（表示需要登录）
4. "Use another account" 或 "使用其他账号" 链接

如果看到账号选择器，请在描述中注明 "account selector"。
如果看到登录页面，请在描述中注明 "login required"。
"""

# 发送邀请 - 查找邀请按钮或创建家庭组入口
OBSERVE_INVITE_BUTTON = """
在当前 Google 家庭组管理页面，查找以下任意元素：

**邀请按钮（表示已有家庭组）:**
1. "Send invitations" 按钮/链接
2. "Invite family member" 按钮
3. "邀请家庭成员" 按钮
4. 显示 "X of 6" 的成员数量指示器

**创建家庭组入口（表示尚未创建家庭组）:**
5. "Get started" 链接/按钮
6. "开始使用" 按钮
7. "Create a family group" 按钮
8. "创建家庭群组" 按钮

**家庭组已满指示:**
9. "6 of 6" 或 "family is full" 文本
10. "家庭组已满" 文本

如果看到创建入口，请在描述中注明 "needs create family"。
如果看到家庭组已满，请在描述中注明 "family full"。
"""

# 发送邀请 - 查找邮箱输入框
OBSERVE_EMAIL_INPUT = """
查找邮箱输入框：
1. placeholder 包含 "Type a name or email" 或 "输入姓名或邮箱"
2. placeholder 包含 "Enter email" 或 "输入邮箱"
3. 标签包含 "Email" 或 "邮箱" 或 "name"
4. type="email" 或 type="text" 的输入框
5. 在 "Invite your family" 或 "邀请家庭成员" 页面的输入框
"""

# 发送邀请 - 查找发送按钮
OBSERVE_SEND_BUTTON = """
查找发送邀请按钮：
1. "Send" 蓝色按钮
2. "发送" 按钮
3. "Invite" 按钮
4. "邀请" 按钮
5. "Send invitation" 按钮
"""

# 发送邀请 - 验证成功
OBSERVE_INVITE_SUCCESS = """
查找邀请发送成功的标志：
1. "Invitation sent" 或 "邀请已发送" 文本
2. "Success" 或 "成功" 提示
3. 成功图标（绿色勾选）
4. 返回到家庭管理页面

也检测可能的错误：
5. "family is full" 或 "家庭组已满" 错误
6. "error" 或 "错误" 提示
"""

# Gmail 弹窗处理
OBSERVE_GMAIL_POPUP = """
检查当前页面是否有以下任意弹窗：
1. "Turn on smart features" → 查找 "Next" 按钮
2. "Smart features in Google Workspace" → 查找 "Next" 按钮
3. "Smart features in other Google products" → 查找 "Save" 按钮
4. "Reload" 提示 → 查找 "Reload" 按钮
5. "Get started with Gmail" → 查找关闭按钮（X）或 "Got it" 按钮
6. "Enable desktop notifications" → 查找 "No thanks" 按钮

也检测是否已显示收件箱：
7. "Inbox" 或 "收件箱" 标签
8. 邮件列表

如果看到收件箱，请在描述中注明 "inbox visible"。
"""

# 接受邀请 - 查找邀请邮件
OBSERVE_INVITE_EMAIL = """
在 Gmail 收件箱中查找家庭邀请邮件：
1. 来自 "Google" 或 "no-reply@google.com" 的邮件
2. 主题包含 "family" 或 "家庭" 或 "invitation" 或 "邀请"
3. 主题包含 "join" 或 "加入" 或 "Google One"
4. 邮件内容预览包含 "family group" 或 "家庭群组"
"""

# 接受邀请 - 查找接受链接
OBSERVE_ACCEPT_LINK = """
在邮件内容中查找接受邀请的链接或按钮：
1. "Accept invitation" 按钮/链接
2. "接受邀请" 按钮/链接
3. "Join family" 链接
4. "加入家庭" 链接
5. "Join now" 按钮
6. "立即加入" 按钮
"""

# 接受邀请 - 查找确认按钮
OBSERVE_JOIN_BUTTON = """
在确认页面查找加入按钮：
1. "Join Family Group" 蓝色按钮
2. "加入家庭群组" 按钮
3. "Join" 按钮
4. "加入" 按钮
5. "Accept" 按钮
6. "接受" 按钮
7. "Confirm" 按钮
8. "确认" 按钮

也检测可能的错误：
9. "You're already in a family group" 错误弹窗
10. "已在家庭组中" 或 "只能加入一个家庭" 错误

如果看到错误信息，请在描述中注明 "already in family" 或 "error"。
"""

# 接受邀请 - 验证成功
OBSERVE_JOIN_SUCCESS = """
查找成功加入家庭组的标志：
1. "Welcome to the family" 文本
2. "You joined" 或 "已加入" 文本
3. "Success" 或 "成功" 提示
4. 家庭成员页面（显示其他成员头像）

也检测可能的错误：
5. "already in a family" 或 "已在家庭组" 错误
6. 任何错误提示

如果成功，请在描述中注明 "join success"。
如果已在其他家庭组，请在描述中注明 "already in family"。
"""


async def _send_family_invite(
    browser_id: str,
    inviter_email: str,
    invitee_email: str,
    log_func: Callable,
) -> dict:
    """
    使用 Stagehand observe+act 模式发送家庭邀请

    Args:
        browser_id: 浏览器窗口 ID
        inviter_email: 邀请人邮箱
        invitee_email: 被邀请人邮箱
        log_func: 日志函数

    Returns:
        dict: {success, message, steps, family_full, needs_create_family}
    """
    log = log_func
    steps = 0

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0, "family_full": False}

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return {"success": False, "message": "无法获取浏览器 WebSocket 连接", "steps": 0, "family_full": False}

        # 获取 Stagehand 配置
        model_api_key, model_base_url, stagehand_model = get_stagehand_config(
            log=lambda msg: log(f"[{inviter_email}] {msg}")
        )

        if not model_api_key or not stagehand_model:
            return {"success": False, "message": "AI 配置不完整", "steps": 0, "family_full": False}

        log(f"[{inviter_email}] 使用 Stagehand observe+act 模式发送邀请...")
        log(f"[{inviter_email}] 连接到 ixBrowser: {ws_endpoint[:50]}...")

        # 构建 model 配置
        model_config = {
            "modelName": stagehand_model,
            "apiKey": model_api_key,
        }
        if model_base_url:
            model_config["baseURL"] = model_base_url

        # 使用 AsyncStagehand + sessions API
        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            # 启动 session，连接到 ixBrowser 窗口
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # ===== Step 1: 导航到家庭管理页面 =====
                log(f"[{inviter_email}] Step 1: 导航到家庭管理页面...")
                await client.sessions.navigate(id=session.id, url="https://myaccount.google.com/family")
                await asyncio.sleep(3.0)
                steps += 1

                # ===== Step 2: 检查账号选择器 =====
                log(f"[{inviter_email}] Step 2: 检查页面状态...")
                account_check = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_ACCOUNT_SELECTOR,
                    options={"model": model_config},
                )
                account_results = account_check.data.result if account_check.data else []

                # 处理账号选择器
                for elem in (account_results or []):
                    desc = (getattr(elem, "description", "") or "").lower()
                    if "account selector" in desc or ("@" in desc and "gmail" in desc):
                        log(f"[{inviter_email}] 检测到账号选择器，选择账号...")
                        # 查找并点击当前邮箱
                        account_observe = await client.sessions.observe(
                            id=session.id,
                            instruction=f"找到包含 \"{inviter_email}\" 的账号条目并点击",
                            options={"model": model_config},
                        )
                        if account_observe.data and account_observe.data.result:
                            await client.sessions.act(
                                id=session.id,
                                input=account_observe.data.result[0].to_dict(exclude_none=True),
                            )
                            await asyncio.sleep(3.0)
                            steps += 1
                        break
                    if "login required" in desc:
                        return {"success": False, "message": "需要登录", "steps": steps, "family_full": False}

                # ===== Step 3: 导航到邀请页面 =====
                log(f"[{inviter_email}] Step 3: 导航到邀请成员页面...")
                await client.sessions.navigate(id=session.id, url="https://myaccount.google.com/family/invitemembers")
                await asyncio.sleep(3.0)
                steps += 1

                # ===== Step 4: 检查页面状态（邀请按钮/创建入口/已满） =====
                log(f"[{inviter_email}] Step 4: 检查邀请页面状态...")
                page_check = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_INVITE_BUTTON,
                    options={"model": model_config},
                )
                page_results = page_check.data.result if page_check.data else []

                # 分析页面状态
                needs_create_family = False
                family_full = False

                for elem in (page_results or []):
                    desc = (getattr(elem, "description", "") or "").lower()
                    if "needs create family" in desc or "get started" in desc:
                        needs_create_family = True
                        log(f"[{inviter_email}] ⚠️ 检测到需要创建家庭组")
                        break
                    if "family full" in desc or "6 of 6" in desc:
                        family_full = True
                        log(f"[{inviter_email}] ⚠️ 检测到家庭组已满")
                        break

                if needs_create_family:
                    return {"success": False, "message": "需要先创建家庭组", "steps": steps, "needs_create_family": True}

                if family_full:
                    return {"success": False, "message": "家庭组已满", "steps": steps, "family_full": True}

                # ===== Step 5: 查找并操作邮箱输入框 =====
                log(f"[{inviter_email}] Step 5: 查找邮箱输入框...")
                email_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_EMAIL_INPUT,
                    options={"model": model_config},
                )
                email_results = email_observe.data.result if email_observe.data else []

                if not email_results:
                    # 重试一次
                    log(f"[{inviter_email}] 首次未找到输入框，等待后重试...")
                    await asyncio.sleep(2.0)
                    email_observe = await client.sessions.observe(
                        id=session.id,
                        instruction=OBSERVE_EMAIL_INPUT,
                        options={"model": model_config},
                    )
                    email_results = email_observe.data.result if email_observe.data else []

                if not email_results:
                    return {"success": False, "message": "未找到邮箱输入框", "steps": steps, "family_full": False}

                email_input = email_results[0]
                log(f"[{inviter_email}] 找到输入框: {(getattr(email_input, 'description', '') or '')[:50]}...")

                # 填写邮箱 - 构造 fill action
                log(f"[{inviter_email}] Step 6: 输入被邀请人邮箱: {invitee_email}")
                fill_action = {
                    "selector": getattr(email_input, "selector", ""),
                    "method": "fill",
                    "arguments": [invitee_email],
                    "description": f"Fill email input with {invitee_email}",
                }
                await client.sessions.act(id=session.id, input=fill_action)
                await asyncio.sleep(1.5)
                steps += 1

                # ===== Step 7: 处理邮箱建议列表（按 ArrowDown + Enter） =====
                log(f"[{inviter_email}] Step 7: 选择邮箱建议...")
                # 使用键盘操作选择建议
                press_down = {
                    "selector": getattr(email_input, "selector", ""),
                    "method": "press",
                    "arguments": ["ArrowDown"],
                    "description": "Press ArrowDown to select suggestion",
                }
                await client.sessions.act(id=session.id, input=press_down)
                await asyncio.sleep(0.5)

                press_enter = {
                    "selector": getattr(email_input, "selector", ""),
                    "method": "press",
                    "arguments": ["Enter"],
                    "description": "Press Enter to confirm selection",
                }
                await client.sessions.act(id=session.id, input=press_enter)
                await asyncio.sleep(1.0)
                steps += 1

                # ===== Step 8: 查找并点击发送按钮 =====
                log(f"[{inviter_email}] Step 8: 查找发送按钮...")
                send_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_SEND_BUTTON,
                    options={"model": model_config},
                )
                send_results = send_observe.data.result if send_observe.data else []

                if not send_results:
                    return {"success": False, "message": "未找到发送按钮", "steps": steps, "family_full": False}

                send_btn = send_results[0]
                log(f"[{inviter_email}] 点击发送按钮: {(getattr(send_btn, 'description', '') or '')[:50]}...")
                await client.sessions.act(
                    id=session.id,
                    input=send_btn.to_dict(exclude_none=True),
                )
                await asyncio.sleep(3.0)
                steps += 1

                # ===== Step 9: 验证发送成功 =====
                log(f"[{inviter_email}] Step 9: 验证发送结果...")
                success_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_INVITE_SUCCESS,
                    options={"model": model_config},
                )
                success_results = success_observe.data.result if success_observe.data else []

                for elem in (success_results or []):
                    desc = (getattr(elem, "description", "") or "").lower()
                    if "sent" in desc or "success" in desc or "成功" in desc:
                        log(f"[{inviter_email}] ✅ 邀请发送成功")
                        return {"success": True, "message": "邀请发送成功", "steps": steps, "family_full": False}
                    if "family full" in desc or "已满" in desc:
                        log(f"[{inviter_email}] ⚠️ 家庭组已满")
                        return {"success": False, "message": "家庭组已满", "steps": steps, "family_full": True}

                # 如果没有明确的成功/失败标志，假定成功（因为没有报错）
                log(f"[{inviter_email}] ✅ 邀请操作完成（未检测到错误）")
                return {"success": True, "message": "邀请操作完成", "steps": steps, "family_full": False}

            finally:
                try:
                    await client.sessions.end(id=session.id)
                except Exception:
                    pass

    except Exception as e:
        log(f"[{inviter_email}] Stagehand 异常: {e}")
        return {"success": False, "message": str(e), "steps": steps, "family_full": False}


async def _accept_family_invite(
    browser_id: str,
    invitee_email: str,
    inviter_email: str,
    log_func: Callable,
) -> dict:
    """
    使用 Stagehand observe+act 模式接受家庭邀请

    Args:
        browser_id: 浏览器窗口 ID
        invitee_email: 被邀请人邮箱
        inviter_email: 邀请人邮箱（用于日志）
        log_func: 日志函数

    Returns:
        dict: {success, message, steps, already_in_family}
    """
    log = log_func
    steps = 0

    try:
        # 打开浏览器
        result = openBrowser(browser_id)
        if not result.get("success"):
            return {"success": False, "message": result.get("msg", "打开浏览器失败"), "steps": 0, "already_in_family": False}

        ws_endpoint = result.get("data", {}).get("ws", "")
        if not ws_endpoint:
            return {"success": False, "message": "无法获取浏览器 WebSocket 连接", "steps": 0, "already_in_family": False}

        # 获取 Stagehand 配置
        model_api_key, model_base_url, stagehand_model = get_stagehand_config(
            log=lambda msg: log(f"[{invitee_email}] {msg}")
        )

        if not model_api_key or not stagehand_model:
            return {"success": False, "message": "AI 配置不完整", "steps": 0, "already_in_family": False}

        log(f"[{invitee_email}] 使用 Stagehand observe+act 模式接受邀请...")
        log(f"[{invitee_email}] 连接到 ixBrowser: {ws_endpoint[:50]}...")

        # 构建 model 配置
        model_config = {
            "modelName": stagehand_model,
            "apiKey": model_api_key,
        }
        if model_base_url:
            model_config["baseURL"] = model_base_url

        # 使用 AsyncStagehand + sessions API
        async with AsyncStagehand(
            server="local",
            model_api_key=model_api_key,
            local_ready_timeout_s=30.0,
        ) as client:
            # 启动 session，连接到 ixBrowser 窗口
            session = await client.sessions.start(
                model_name=stagehand_model,
                browser={
                    "type": "local",
                    "cdp_url": ws_endpoint,
                },
            )

            try:
                # ===== Step 1: 导航到 Gmail =====
                log(f"[{invitee_email}] Step 1: 导航到 Gmail...")
                await client.sessions.navigate(id=session.id, url="https://mail.google.com")
                await asyncio.sleep(3.0)
                steps += 1

                # ===== Step 2: 检查账号选择器 =====
                log(f"[{invitee_email}] Step 2: 检查页面状态...")
                account_check = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_ACCOUNT_SELECTOR,
                    options={"model": model_config},
                )
                account_results = account_check.data.result if account_check.data else []

                # 处理账号选择器
                for elem in (account_results or []):
                    desc = (getattr(elem, "description", "") or "").lower()
                    if "account selector" in desc or ("@" in desc and "gmail" in desc):
                        log(f"[{invitee_email}] 检测到账号选择器，选择账号...")
                        account_observe = await client.sessions.observe(
                            id=session.id,
                            instruction=f"找到包含 \"{invitee_email}\" 的账号条目并点击",
                            options={"model": model_config},
                        )
                        if account_observe.data and account_observe.data.result:
                            await client.sessions.act(
                                id=session.id,
                                input=account_observe.data.result[0].to_dict(exclude_none=True),
                            )
                            await asyncio.sleep(3.0)
                            steps += 1
                        break
                    if "login required" in desc:
                        return {"success": False, "message": "需要登录", "steps": steps, "already_in_family": False}

                # ===== Step 3: 处理 Gmail 首次访问弹窗 =====
                log(f"[{invitee_email}] Step 3: 处理 Gmail 弹窗...")
                max_popup_attempts = 8
                popup_handled = 0

                for _ in range(max_popup_attempts):
                    popup_observe = await client.sessions.observe(
                        id=session.id,
                        instruction=OBSERVE_GMAIL_POPUP,
                        options={"model": model_config},
                    )
                    popup_results = popup_observe.data.result if popup_observe.data else []

                    if not popup_results:
                        break

                    inbox_visible = False
                    action_btn = None

                    for elem in popup_results:
                        desc = (getattr(elem, "description", "") or "").lower()
                        if "inbox visible" in desc or "收件箱" in desc:
                            inbox_visible = True
                            break
                        # 找到可点击的按钮
                        if any(kw in desc for kw in ["next", "save", "reload", "got it", "no thanks", "close", "x"]):
                            action_btn = elem
                            break

                    if inbox_visible:
                        log(f"[{invitee_email}] 收件箱已显示")
                        break

                    if action_btn:
                        btn_desc = (getattr(action_btn, "description", "") or "")[:50]
                        log(f"[{invitee_email}] 点击弹窗按钮: {btn_desc}...")
                        await client.sessions.act(
                            id=session.id,
                            input=action_btn.to_dict(exclude_none=True),
                        )
                        await asyncio.sleep(2.0)
                        popup_handled += 1
                        steps += 1
                    else:
                        break

                log(f"[{invitee_email}] 已处理 {popup_handled} 个弹窗")

                # ===== Step 4: 查找邀请邮件 =====
                log(f"[{invitee_email}] Step 4: 查找家庭邀请邮件...")
                await asyncio.sleep(2.0)

                email_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_INVITE_EMAIL,
                    options={"model": model_config},
                )
                email_results = email_observe.data.result if email_observe.data else []

                if not email_results:
                    # 尝试刷新页面后重试
                    log(f"[{invitee_email}] 首次未找到邀请邮件，刷新后重试...")
                    await client.sessions.navigate(id=session.id, url="https://mail.google.com")
                    await asyncio.sleep(3.0)

                    email_observe = await client.sessions.observe(
                        id=session.id,
                        instruction=OBSERVE_INVITE_EMAIL,
                        options={"model": model_config},
                    )
                    email_results = email_observe.data.result if email_observe.data else []

                if not email_results:
                    return {"success": False, "message": "未找到家庭邀请邮件", "steps": steps, "already_in_family": False}

                invite_email = email_results[0]
                log(f"[{invitee_email}] 找到邀请邮件: {(getattr(invite_email, 'description', '') or '')[:50]}...")

                # 点击打开邮件
                await client.sessions.act(
                    id=session.id,
                    input=invite_email.to_dict(exclude_none=True),
                )
                await asyncio.sleep(3.0)
                steps += 1

                # ===== Step 5: 查找接受邀请链接 =====
                log(f"[{invitee_email}] Step 5: 查找接受邀请链接...")
                accept_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_ACCEPT_LINK,
                    options={"model": model_config},
                )
                accept_results = accept_observe.data.result if accept_observe.data else []

                if not accept_results:
                    return {"success": False, "message": "邮件中未找到接受邀请链接", "steps": steps, "already_in_family": False}

                accept_link = accept_results[0]
                log(f"[{invitee_email}] 点击接受链接: {(getattr(accept_link, 'description', '') or '')[:50]}...")
                await client.sessions.act(
                    id=session.id,
                    input=accept_link.to_dict(exclude_none=True),
                )
                await asyncio.sleep(5.0)  # 等待新页面加载
                steps += 1

                # ===== Step 6: 查找并点击加入按钮 =====
                log(f"[{invitee_email}] Step 6: 查找加入按钮...")

                # 多次尝试（可能有多步确认流程）
                for attempt in range(3):
                    join_observe = await client.sessions.observe(
                        id=session.id,
                        instruction=OBSERVE_JOIN_BUTTON,
                        options={"model": model_config},
                    )
                    join_results = join_observe.data.result if join_observe.data else []

                    if not join_results:
                        if attempt == 0:
                            await asyncio.sleep(2.0)
                            continue
                        break

                    # 检查是否有错误
                    for elem in join_results:
                        desc = (getattr(elem, "description", "") or "").lower()
                        if "already in family" in desc or "已在家庭组" in desc:
                            log(f"[{invitee_email}] ⚠️ 被邀请人已在其他家庭组中")
                            return {"success": False, "message": "被邀请人已在其他家庭组中", "steps": steps, "already_in_family": True}

                    # 找到加入按钮
                    join_btn = None
                    for elem in join_results:
                        desc = (getattr(elem, "description", "") or "").lower()
                        if any(kw in desc for kw in ["join", "加入", "accept", "接受", "confirm", "确认"]):
                            join_btn = elem
                            break

                    if join_btn:
                        btn_desc = (getattr(join_btn, "description", "") or "")[:50]
                        log(f"[{invitee_email}] 点击: {btn_desc}...")
                        await client.sessions.act(
                            id=session.id,
                            input=join_btn.to_dict(exclude_none=True),
                        )
                        await asyncio.sleep(3.0)
                        steps += 1
                    else:
                        break

                # ===== Step 7: 验证加入成功 =====
                log(f"[{invitee_email}] Step 7: 验证加入结果...")
                success_observe = await client.sessions.observe(
                    id=session.id,
                    instruction=OBSERVE_JOIN_SUCCESS,
                    options={"model": model_config},
                )
                success_results = success_observe.data.result if success_observe.data else []

                for elem in (success_results or []):
                    desc = (getattr(elem, "description", "") or "").lower()
                    if "join success" in desc or "welcome" in desc or "you joined" in desc or "已加入" in desc:
                        log(f"[{invitee_email}] ✅ 成功加入家庭组")
                        return {"success": True, "message": "成功加入家庭组", "steps": steps}
                    if "already in family" in desc or "已在家庭组" in desc:
                        log(f"[{invitee_email}] ⚠️ 被邀请人已在其他家庭组中")
                        return {"success": False, "message": "被邀请人已在其他家庭组中", "steps": steps, "already_in_family": True}

                # 如果没有明确的成功/失败标志，返回不确定
                log(f"[{invitee_email}] ⚠️ 无法确认加入结果")
                return {"success": False, "message": "无法确认加入结果", "steps": steps, "already_in_family": False}

            finally:
                try:
                    await client.sessions.end(id=session.id)
                except Exception:
                    pass

    except Exception as e:
        log(f"[{invitee_email}] Stagehand 异常: {e}")
        return {"success": False, "message": str(e), "steps": steps, "already_in_family": False}


# ==================== 测试代码 ====================

if __name__ == "__main__":
    async def main():
        print("家庭组加入测试 (Stagehand observe+act 模式)")
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
